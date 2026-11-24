package localtools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/computerconfig"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

// FeishuMailScopes are the user scopes Feishu Mail needs: the mailbox
// profile, folders and messages read, sending, drafts and moving mail. A
// login requests exactly these; lark-cli adds them to the scopes the owner
// already granted.
var FeishuMailScopes = []string{
	"mail:user_mailbox:readonly",
	"mail:user_mailbox.folder:read",
	"mail:user_mailbox.message:readonly",
	"mail:user_mailbox.message.subject:read",
	"mail:user_mailbox.message.address:read",
	"mail:user_mailbox.message.body:read",
	"mail:user_mailbox.message:send",
	"mail:user_mailbox.message:modify",
}

// feishuMailboxPath is the only API path a request may reach: the owner's
// own mailbox. lark-cli may hold other Feishu scopes on this Computer, and
// TeamHub's calls must not reach them.
const feishuMailboxPath = "/open-apis/mail/v1/user_mailboxes/me"

const (
	larkCLIName = "lark-cli"
	// larkOutputLimit bounds what one lark-cli call may print; a batch of
	// full messages stays far below it.
	larkOutputLimit = 32 << 20
	// loginWaitMargin is kept back from the caller's deadline so a wait that
	// is still polling can answer pending in time.
	loginWaitMargin = 5 * time.Second
)

var (
	errLarkCLINotInstalled = errors.New("lark-cli is not installed")
	// loginIDPattern is the shape of a Runner Gateway ID, which names a login.
	loginIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
)

// FeishuMail runs the Feishu Mail calls TeamHub sends this Computer through
// its owner's own lark-cli login. The executable, its subcommands and the
// scopes a login asks for are fixed here: a request names only a mail API
// path under the owner's mailbox and its JSON. A started login's device code
// stays in this process, so it never crosses the wire.
type FeishuMail struct {
	resolve func() (string, error)
	env     []string
	now     func() time.Time
	mu      sync.Mutex
	logins  map[string]feishuLogin
}

type feishuLogin struct {
	deviceCode string
	expiresAt  time.Time
}

// NewFeishuMail returns a FeishuMail that looks for lark-cli on every call,
// so installing it later needs no restart.
func NewFeishuMail() *FeishuMail {
	environment := computerconfig.ProcessEnvironment()
	return &FeishuMail{resolve: findLarkCLI, env: childEnvironment(environment), now: time.Now, logins: map[string]feishuLogin{}}
}

// Call runs one Feishu Mail tool. Status "ok" carries its result; any other
// status names why nothing usable came back.
func (m *FeishuMail) Call(ctx context.Context, name string, arguments json.RawMessage) map[string]any {
	binary, err := m.resolve()
	if err != nil {
		return map[string]any{"status": "not_installed"}
	}
	switch name {
	case "api":
		return m.api(ctx, binary, arguments)
	case "status":
		return m.status(ctx, binary)
	case "login_start":
		return m.loginStart(ctx, binary, arguments)
	case "login_wait":
		return m.loginWait(ctx, binary, arguments)
	}
	return map[string]any{"status": "unavailable"}
}

type feishuAPIRequest struct {
	Method string          `json:"method"`
	Path   string          `json:"path"`
	Params map[string]any  `json:"params"`
	Data   json.RawMessage `json:"data"`
}

func (m *FeishuMail) api(ctx context.Context, binary string, arguments json.RawMessage) map[string]any {
	var request feishuAPIRequest
	if json.Unmarshal(arguments, &request) != nil || !feishuMailMethod(request.Method) || !feishuMailboxRequestPath(request.Path) {
		return map[string]any{"status": "invalid_request"}
	}
	args := []string{"api", request.Method, request.Path, "--as", "user", "--format", "json"}
	if len(request.Params) > 0 {
		encoded, err := json.Marshal(request.Params)
		if err != nil {
			return map[string]any{"status": "invalid_request"}
		}
		args = append(args, "--params", string(encoded))
	}
	var stdin []byte
	if data := bytes.TrimSpace(request.Data); len(data) > 0 && string(data) != "null" {
		args = append(args, "--data", "-")
		stdin = data
	}
	stdout, failure := m.run(ctx, binary, args, stdin)
	if failure != nil {
		return failure
	}
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal(stdout, &envelope) != nil {
		return map[string]any{"status": "failed"}
	}
	if len(envelope.Data) == 0 {
		envelope.Data = json.RawMessage("{}")
	}
	return map[string]any{"status": "ok", "data": envelope.Data}
}

// status reports whether the owner's lark-cli can serve Feishu Mail: logged
// in, holding every mail scope, with a mailbox whose address names the
// connection.
func (m *FeishuMail) status(ctx context.Context, binary string) map[string]any {
	// auth check exits 1 when scopes are missing and still prints its report
	// on stdout, so a report it printed is read whatever the exit code.
	stdout, failure := m.run(ctx, binary, []string{"auth", "check", "--scope", strings.Join(FeishuMailScopes, " "), "--json"}, nil)
	var check struct {
		OK      *bool           `json:"ok"`
		Missing []string        `json:"missing"`
		Error   json.RawMessage `json:"error"`
	}
	if json.Unmarshal(stdout, &check) != nil || check.OK == nil {
		if failure != nil {
			return failure
		}
		return map[string]any{"status": "failed"}
	}
	if len(check.Missing) == 0 && len(check.Error) > 0 {
		// A check that could not run, such as before lark-cli is set up,
		// reports why on stdout.
		return larkFailure(stdout)
	}
	if len(check.Missing) > 0 {
		result := map[string]any{"status": "missing_scope", "missing_scopes": check.Missing}
		// A scope the app does not enable cannot be granted by logging in; the
		// app's ID and brand let the owner find it in the developer console.
		if appScopes, failure := m.run(ctx, binary, []string{"auth", "scopes"}, nil); failure == nil {
			var enabled struct {
				AppID      string   `json:"appId"`
				Brand      string   `json:"brand"`
				UserScopes []string `json:"userScopes"`
			}
			if json.Unmarshal(appScopes, &enabled) == nil {
				var notEnabled []string
				for _, scope := range check.Missing {
					if !slices.Contains(enabled.UserScopes, scope) {
						notEnabled = append(notEnabled, scope)
					}
				}
				result["app_missing_scopes"] = notEnabled
				result["app_id"] = enabled.AppID
				result["brand"] = enabled.Brand
			}
		}
		return result
	}
	stdout, failure = m.run(ctx, binary, []string{"api", "GET", feishuMailboxPath + "/profile", "--as", "user", "--format", "json"}, nil)
	if failure != nil {
		return failure
	}
	var profile struct {
		Data struct {
			PrimaryEmailAddress string `json:"primary_email_address"`
		} `json:"data"`
	}
	if json.Unmarshal(stdout, &profile) != nil {
		return map[string]any{"status": "failed"}
	}
	address := strings.ToLower(strings.TrimSpace(profile.Data.PrimaryEmailAddress))
	if address == "" {
		return map[string]any{"status": "failed", "detail": "The Feishu mailbox has no primary address."}
	}
	return map[string]any{"status": "ok", "address": address}
}

// loginStart starts a login under the caller's name for it, so the caller
// needs to keep nothing but that name.
func (m *FeishuMail) loginStart(ctx context.Context, binary string, arguments json.RawMessage) map[string]any {
	var request struct {
		LoginID string `json:"login_id"`
	}
	if json.Unmarshal(arguments, &request) != nil || !loginIDPattern.MatchString(request.LoginID) {
		return map[string]any{"status": "invalid_request"}
	}
	stdout, failure := m.run(ctx, binary, []string{"auth", "login", "--scope", strings.Join(FeishuMailScopes, " "), "--no-wait", "--json"}, nil)
	if failure != nil {
		return failure
	}
	var started struct {
		DeviceCode      string          `json:"device_code"`
		VerificationURL string          `json:"verification_url"`
		ExpiresIn       int             `json:"expires_in"`
		Error           json.RawMessage `json:"error"`
	}
	if json.Unmarshal(stdout, &started) != nil {
		return map[string]any{"status": "failed"}
	}
	if len(started.Error) > 0 {
		// A login lark-cli refused, such as before it is set up.
		return larkFailure(stdout)
	}
	if started.DeviceCode == "" || started.ExpiresIn <= 0 {
		return map[string]any{"status": "failed"}
	}
	if link, err := url.Parse(started.VerificationURL); err != nil || link.Scheme != "https" || link.Host == "" {
		return map[string]any{"status": "failed"}
	}
	now := m.now()
	m.mu.Lock()
	for key, login := range m.logins {
		if !now.Before(login.expiresAt) {
			delete(m.logins, key)
		}
	}
	m.logins[request.LoginID] = feishuLogin{deviceCode: started.DeviceCode, expiresAt: now.Add(time.Duration(started.ExpiresIn) * time.Second)}
	m.mu.Unlock()
	return map[string]any{"status": "ok", "verification_url": started.VerificationURL, "expires_in": started.ExpiresIn}
}

// loginWait polls a started login until the owner authorizes it or the
// caller's deadline nears. A wait cut short answers pending and keeps the
// device code for the next wait.
func (m *FeishuMail) loginWait(ctx context.Context, binary string, arguments json.RawMessage) map[string]any {
	var request struct {
		LoginID string `json:"login_id"`
	}
	if json.Unmarshal(arguments, &request) != nil || request.LoginID == "" {
		return map[string]any{"status": "invalid_request"}
	}
	m.mu.Lock()
	login, ok := m.logins[request.LoginID]
	if ok && !m.now().Before(login.expiresAt) {
		delete(m.logins, request.LoginID)
		ok = false
	}
	m.mu.Unlock()
	if !ok {
		return map[string]any{"status": "expired"}
	}
	waitCtx := ctx
	if deadline, has := ctx.Deadline(); has {
		var cancel context.CancelFunc
		waitCtx, cancel = context.WithDeadline(ctx, deadline.Add(-loginWaitMargin))
		defer cancel()
	}
	_, failure := m.run(waitCtx, binary, []string{"auth", "login", "--device-code", login.deviceCode, "--json"}, nil)
	if failure != nil && waitCtx.Err() != nil && ctx.Err() == nil {
		return map[string]any{"status": "pending"}
	}
	m.mu.Lock()
	delete(m.logins, request.LoginID)
	m.mu.Unlock()
	if failure != nil {
		failure["status"] = "login_failed"
		return failure
	}
	return map[string]any{"status": "ok"}
}

// run executes lark-cli and returns what it printed on stdout, and, when it
// failed, the result the failure reports. lark-cli writes its error envelope
// to stderr; its type, subtype and upstream code carry the decision, never
// its message.
func (m *FeishuMail) run(ctx context.Context, binary string, args []string, stdin []byte) ([]byte, map[string]any) {
	command := exec.CommandContext(ctx, binary, args...)
	command.Env = append(append([]string(nil), m.env...), "LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1", "LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1")
	if stdin != nil {
		command.Stdin = bytes.NewReader(stdin)
	}
	stdout := &limitedBuffer{limit: larkOutputLimit}
	stderr := &limitedBuffer{limit: larkOutputLimit}
	command.Stdout, command.Stderr = stdout, stderr
	err := command.Run()
	switch {
	case stdout.overflow || stderr.overflow:
		return nil, map[string]any{"status": "failed", "detail": "lark-cli printed more than the Computer accepts."}
	case err == nil:
		return stdout.Bytes(), nil
	case ctx.Err() != nil:
		return stdout.Bytes(), map[string]any{"status": "timeout"}
	}
	return stdout.Bytes(), larkFailure(stderr.Bytes())
}

func larkFailure(stderr []byte) map[string]any {
	var envelope struct {
		Error struct {
			Type          string   `json:"type"`
			Subtype       string   `json:"subtype"`
			Code          int64    `json:"code"`
			Message       string   `json:"message"`
			MissingScopes []string `json:"missing_scopes"`
		} `json:"error"`
	}
	if json.Unmarshal(stderr, &envelope) != nil || envelope.Error.Type == "" {
		return map[string]any{"status": "failed"}
	}
	failure := envelope.Error
	status := "failed"
	switch {
	case failure.Subtype == "missing_scope":
		status = "missing_scope"
	case failure.Type == "authorization" || failure.Type == "authentication":
		status = "auth_required"
	case failure.Type == "config":
		// Installed but never set up with a Feishu app: no login can help yet.
		status = "not_configured"
	}
	result := map[string]any{"status": status, "error_type": failure.Type, "error_subtype": failure.Subtype, "detail": failure.Message}
	if failure.Code != 0 {
		result["code"] = failure.Code
	}
	if len(failure.MissingScopes) > 0 {
		result["missing_scopes"] = failure.MissingScopes
	}
	return result
}

func feishuMailMethod(method string) bool {
	switch method {
	case "GET", "POST", "PUT", "PATCH", "DELETE":
		return true
	}
	return false
}

// feishuMailboxRequestPath admits a clean path at or under the owner's
// mailbox. A query belongs in params, so a path holding one is refused.
func feishuMailboxRequestPath(requestPath string) bool {
	if strings.ContainsAny(requestPath, "?#%\\") || path.Clean(requestPath) != requestPath {
		return false
	}
	return requestPath == feishuMailboxPath || strings.HasPrefix(requestPath, feishuMailboxPath+"/")
}

// findLarkCLI finds lark-cli on PATH, then where its installers put it. A
// Computer started from the desktop or a clean environment has a short PATH.
func findLarkCLI() (string, error) {
	environment := computerconfig.ProcessEnvironment()
	// Runtime discovery's folders cover npm's global folder on Windows, which
	// a Daemon started before Node was installed has no PATH entry for.
	candidates := provider.ExecutableCandidates(larkCLIName, environment)
	if runtime.GOOS != "windows" {
		candidates = append(candidates, "/opt/homebrew/bin/"+larkCLIName, "/usr/local/bin/"+larkCLIName)
	}
	for _, candidate := range candidates {
		if binary, ok := larkNativeBinary(candidate); ok {
			return binary, nil
		}
	}
	return "", errLarkCLINotInstalled
}

// larkNativeBinary resolves an installed lark-cli to the executable to run.
// The npm package's launcher is a Node script that only starts the native
// binary beside it, so that binary is run directly and Node need not be on
// this Computer's PATH.
func larkNativeBinary(candidate string) (string, bool) {
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", false
	}
	native := resolved
	switch {
	case filepath.Base(resolved) == "run.js":
		native = filepath.Join(filepath.Dir(resolved), "..", "bin", larkCLIName)
	case strings.EqualFold(filepath.Ext(resolved), ".cmd"):
		native = filepath.Join(filepath.Dir(resolved), "node_modules", "@larksuite", "cli", "bin", larkCLIName)
	}
	if runtime.GOOS == "windows" && !strings.EqualFold(filepath.Ext(native), ".exe") {
		native += ".exe"
	}
	info, err := os.Stat(native)
	if err != nil || info.IsDir() || runtime.GOOS != "windows" && info.Mode()&0o111 == 0 {
		return "", false
	}
	return filepath.Clean(native), true
}

// limitedBuffer keeps at most limit bytes and remembers that more arrived.
type limitedBuffer struct {
	bytes.Buffer
	limit    int
	overflow bool
}

func (b *limitedBuffer) Write(data []byte) (int, error) {
	if remaining := b.limit - b.Len(); len(data) > remaining {
		b.overflow = true
		if remaining > 0 {
			b.Buffer.Write(data[:remaining])
		}
		return len(data), nil
	}
	return b.Buffer.Write(data)
}
