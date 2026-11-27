package localtools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"os/exec"
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

const (
	// larkCLIName is the executable TeamHub's Feishu tools run.
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

// feishuLogin is a started login the owner has not finished yet.
type feishuLogin struct {
	deviceCode string
	expiresAt  time.Time
}

// larkClient runs the owner's own lark-cli and keeps a started login's device
// code in memory, so it never crosses the wire. The executable, its subcommands
// and the scopes a login asks for are fixed by the caller.
type larkClient struct {
	resolve func() (string, error)
	env     []string
	now     func() time.Time
	mu      sync.Mutex
	logins  map[string]feishuLogin
}

// newLarkClient returns a client that looks for lark-cli on every call, so
// installing it later needs no restart.
func newLarkClient() *larkClient {
	environment := computerconfig.ProcessEnvironment()
	return &larkClient{resolve: findLarkCLI, env: childEnvironment(environment), now: time.Now, logins: map[string]feishuLogin{}}
}

// larkAPIRequest is one lark-cli API call a Feishu tool makes.
type larkAPIRequest struct {
	Method string          `json:"method"`
	Path   string          `json:"path"`
	Params map[string]any  `json:"params"`
	Data   json.RawMessage `json:"data"`
}

// api runs one API call the owner's login serves. methodOK and pathOK bound
// what a caller may reach, so a tool never leaves its own Feishu app.
func (c *larkClient) api(ctx context.Context, binary string, arguments json.RawMessage, methodOK func(string) bool, pathOK func(string) bool) map[string]any {
	var request larkAPIRequest
	if json.Unmarshal(arguments, &request) != nil || !methodOK(request.Method) || !pathOK(request.Path) {
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
	stdout, failure := c.run(ctx, binary, args, stdin)
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

// status reports whether the owner's lark-cli holds every scope in scopes. A
// scope the app does not enable is separated out with the app's ID and brand
// so the owner can find it in the console. When profilePath is not empty, the
// owner's profile is read too and its address (or name) is returned, which is
// how a connection learns which account it is bound to.
func (c *larkClient) status(ctx context.Context, binary string, scopes []string, profilePath string) map[string]any {
	check, failure := c.authCheck(ctx, binary, scopes)
	if failure != nil {
		return failure
	}
	if check.OK == nil {
		return map[string]any{"status": "failed"}
	}
	if len(check.Missing) > 0 {
		result := map[string]any{"status": "missing_scope", "missing_scopes": check.Missing}
		if appID, brand, userScopes, ok := c.appScopes(ctx, binary); ok {
			var notEnabled []string
			for _, scope := range check.Missing {
				if !slices.Contains(userScopes, scope) {
					notEnabled = append(notEnabled, scope)
				}
			}
			result["app_missing_scopes"] = notEnabled
			result["app_id"] = appID
			result["brand"] = brand
		}
		return result
	}
	if profilePath == "" {
		return map[string]any{"status": "ok"}
	}
	stdout, failure := c.run(ctx, binary, []string{"api", "GET", profilePath, "--as", "user", "--format", "json"}, nil)
	if failure != nil {
		return failure
	}
	var profile struct {
		Data struct {
			PrimaryEmailAddress string `json:"primary_email_address"`
			Name                string `json:"name"`
		} `json:"data"`
	}
	if json.Unmarshal(stdout, &profile) != nil {
		return map[string]any{"status": "failed"}
	}
	address := strings.ToLower(strings.TrimSpace(profile.Data.PrimaryEmailAddress))
	if address == "" {
		return map[string]any{"status": "failed", "detail": "The Feishu profile has no primary address."}
	}
	return map[string]any{"status": "ok", "address": address}
}

// larkScopeCheck is lark-cli's report of the scopes a login holds.
type larkScopeCheck struct {
	OK      *bool           `json:"ok"`
	Missing []string        `json:"missing"`
	Error   json.RawMessage `json:"error"`
}

// authCheck asks lark-cli whether the owner's login holds every scope. A report
// it printed is returned whatever its exit code, because a check that exits 1
// still names the missing scopes. A check that could not run reports why on
// stdout, which becomes the failure.
func (c *larkClient) authCheck(ctx context.Context, binary string, scopes []string) (larkScopeCheck, map[string]any) {
	stdout, failure := c.run(ctx, binary, []string{"auth", "check", "--scope", strings.Join(scopes, " "), "--json"}, nil)
	var check larkScopeCheck
	if json.Unmarshal(stdout, &check) != nil || check.OK == nil {
		return check, failure
	}
	if len(check.Missing) == 0 && len(check.Error) > 0 {
		// A check that could not run, such as before lark-cli is set up,
		// reports why on stdout.
		return check, larkFailure(stdout)
	}
	return check, nil
}

// appScopes is the app behind the owner's lark-cli: its ID, brand and the user
// scopes it enables. A scope the app does not enable cannot be granted by
// logging in again.
func (c *larkClient) appScopes(ctx context.Context, binary string) (appID, brand string, userScopes []string, ok bool) {
	stdout, failure := c.run(ctx, binary, []string{"auth", "scopes"}, nil)
	if failure != nil {
		return "", "", nil, false
	}
	var enabled struct {
		AppID      string   `json:"appId"`
		Brand      string   `json:"brand"`
		UserScopes []string `json:"userScopes"`
	}
	if json.Unmarshal(stdout, &enabled) != nil {
		return "", "", nil, false
	}
	return enabled.AppID, enabled.Brand, enabled.UserScopes, true
}

// loginStart starts a login for scopes under the caller's name, so the caller
// needs to keep nothing but that name.
func (c *larkClient) loginStart(ctx context.Context, binary string, scopes []string, arguments json.RawMessage) map[string]any {
	var request struct {
		LoginID string `json:"login_id"`
	}
	if json.Unmarshal(arguments, &request) != nil || !loginIDPattern.MatchString(request.LoginID) {
		return map[string]any{"status": "invalid_request"}
	}
	stdout, failure := c.run(ctx, binary, []string{"auth", "login", "--scope", strings.Join(scopes, " "), "--no-wait", "--json"}, nil)
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
	now := c.now()
	c.mu.Lock()
	for key, login := range c.logins {
		if !now.Before(login.expiresAt) {
			delete(c.logins, key)
		}
	}
	c.logins[request.LoginID] = feishuLogin{deviceCode: started.DeviceCode, expiresAt: now.Add(time.Duration(started.ExpiresIn) * time.Second)}
	c.mu.Unlock()
	return map[string]any{"status": "ok", "verification_url": started.VerificationURL, "expires_in": started.ExpiresIn}
}

// loginWait polls a started login until the owner authorizes it or the caller's
// deadline nears. A wait cut short answers pending and keeps the device code for
// the next wait.
func (c *larkClient) loginWait(ctx context.Context, binary string, arguments json.RawMessage) map[string]any {
	var request struct {
		LoginID string `json:"login_id"`
	}
	if json.Unmarshal(arguments, &request) != nil || request.LoginID == "" {
		return map[string]any{"status": "invalid_request"}
	}
	c.mu.Lock()
	login, ok := c.logins[request.LoginID]
	if ok && !c.now().Before(login.expiresAt) {
		delete(c.logins, request.LoginID)
		ok = false
	}
	c.mu.Unlock()
	if !ok {
		return map[string]any{"status": "expired"}
	}
	waitCtx := ctx
	if deadline, has := ctx.Deadline(); has {
		var cancel context.CancelFunc
		waitCtx, cancel = context.WithDeadline(ctx, deadline.Add(-loginWaitMargin))
		defer cancel()
	}
	_, failure := c.run(waitCtx, binary, []string{"auth", "login", "--device-code", login.deviceCode, "--json"}, nil)
	if failure != nil && waitCtx.Err() != nil && ctx.Err() == nil {
		return map[string]any{"status": "pending"}
	}
	c.mu.Lock()
	delete(c.logins, request.LoginID)
	c.mu.Unlock()
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
func (c *larkClient) run(ctx context.Context, binary string, args []string, stdin []byte) ([]byte, map[string]any) {
	command := exec.CommandContext(ctx, binary, args...)
	command.Env = append(append([]string(nil), c.env...), "LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1", "LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1")
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

// larkMethod admits the HTTP methods a Feishu tool may call.
func larkMethod(method string, allowed ...string) bool {
	for _, candidate := range allowed {
		if method == candidate {
			return true
		}
	}
	return false
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
