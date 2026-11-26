package native

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

// AntigravityHookTimeout bounds one managed Antigravity hook invocation in
// hooks.json and in the forwarding subcommand.
const AntigravityHookTimeout = 15 * time.Second

const (
	maxAntigravityHookBytes     = 1 << 20
	antigravityHookDenyToolsArg = "--deny-tools"
)

// AntigravityHookToolCall holds the tool call details Antigravity passes to
// PreToolUse hooks.
type AntigravityHookToolCall struct {
	ID   string         `json:"id,omitempty"`
	Name string         `json:"name,omitempty"`
	Args map[string]any `json:"args,omitempty"`
}

// AntigravityHookRequest holds the fields Antigravity passes on stdin to
// PreInvocation, PreToolUse, and Stop hooks that the Daemon consumes.
type AntigravityHookRequest struct {
	HookEventName      string                   `json:"hookEventName"`
	ConversationID     string                   `json:"conversationId"`
	InvocationNum      int                      `json:"invocationNum"`
	ExecutionNum       int                      `json:"executionNum"`
	FullyIdle          *bool                    `json:"fullyIdle,omitempty"`
	TranscriptPath     string                   `json:"transcriptPath,omitempty"`
	InitialNumSteps    *int                     `json:"initialNumSteps,omitempty"`
	TerminationReason  string                   `json:"terminationReason,omitempty"`
	Error              string                   `json:"error,omitempty"`
	ContinuationActive bool                     `json:"continuationActive,omitempty"`
	ToolCall           *AntigravityHookToolCall `json:"toolCall,omitempty"`
}

// AntigravityInjectStep injects one step before Antigravity's next model
// invocation.
type AntigravityInjectStep struct {
	UserMessage string `json:"userMessage,omitempty"`
}

// AntigravityHookResponse is the JSON payload returned to Antigravity on stdout.
type AntigravityHookResponse struct {
	Decision    string                  `json:"decision,omitempty"`
	Reason      string                  `json:"reason,omitempty"`
	InjectSteps []AntigravityInjectStep `json:"injectSteps,omitempty"`
}

// AntigravityHookHandler handles one hook callback for a registered ACP session.
type AntigravityHookHandler func(context.Context, AntigravityHookRequest) AntigravityHookResponse

// AntigravityHookEndpoint hosts the Daemon-wide loopback callback server and
// managed .agents/hooks.json directory passed to `agy acp --add-dir`.
type AntigravityHookEndpoint struct {
	dir        string
	removeRoot func() error
	url        string
	listener   net.Listener
	server     *http.Server
	mu         sync.Mutex
	handlers   map[string]*antigravityHookRegistration
}

type antigravityHookRegistration struct {
	handler AntigravityHookHandler
}

var (
	antigravitySharedHookMu       sync.Mutex
	antigravitySharedHookInit     bool
	antigravitySharedHookEndpoint *AntigravityHookEndpoint
	antigravitySharedHookErr      error
	antigravityHookTempBase       string
)

// ConfigureAntigravityHookTempBase sets the private Daemon operation-tmp base
// directory used when creating the shared Antigravity hook endpoint directory.
func ConfigureAntigravityHookTempBase(baseDir string) {
	antigravitySharedHookMu.Lock()
	antigravityHookTempBase = baseDir
	antigravitySharedHookMu.Unlock()
}

// AntigravitySharedHookEndpoint starts the Daemon-wide Antigravity hook
// endpoint on first use: loopback only, on a random port under a secret path,
// paired with one stable managed hooks directory for resident `agy` reuse.
func AntigravitySharedHookEndpoint() (*AntigravityHookEndpoint, error) {
	antigravitySharedHookMu.Lock()
	defer antigravitySharedHookMu.Unlock()
	if !antigravitySharedHookInit {
		exe, err := os.Executable()
		if err != nil {
			antigravitySharedHookErr = fmt.Errorf("locate Daemon executable for Antigravity hooks: %w", err)
		} else {
			antigravitySharedHookEndpoint, antigravitySharedHookErr = newAntigravityHookEndpoint(exe, antigravityHookTempBase)
		}
		antigravitySharedHookInit = true
	}
	return antigravitySharedHookEndpoint, antigravitySharedHookErr
}

// CloseAntigravitySharedHookEndpoint closes the Daemon-wide Antigravity hook
// server and removes its managed hooks directory so shutdown leaves no
// orphaned temp directory.
func CloseAntigravitySharedHookEndpoint() error {
	antigravitySharedHookMu.Lock()
	ep := antigravitySharedHookEndpoint
	antigravitySharedHookEndpoint = nil
	antigravitySharedHookErr = nil
	antigravitySharedHookInit = false
	antigravitySharedHookMu.Unlock()
	if ep == nil {
		return nil
	}
	return ep.Close()
}

func newAntigravityHookEndpoint(daemonExecutable, baseDir string) (*AntigravityHookEndpoint, error) {
	if strings.TrimSpace(daemonExecutable) == "" {
		return nil, errors.New("Daemon executable path is required for Antigravity hooks")
	}
	var secret [24]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return nil, err
	}
	root, removeRoot, err := localworkspace.PrivateTempRoot(baseDir, "linger-agy-hooks-")
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(root, "hooks")
	cleanupDir := func() {
		unlockAntigravityHookDir(dir)
		_ = removeRoot()
	}
	if err := privatefs.EnsureDir(dir); err != nil {
		cleanupDir()
		return nil, err
	}
	if resolved, err := filepath.EvalSymlinks(dir); err == nil && resolved != "" {
		dir = resolved
	}
	agentsDir := filepath.Join(dir, ".agents")
	if err := privatefs.EnsureDir(agentsDir); err != nil {
		cleanupDir()
		return nil, err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		cleanupDir()
		return nil, err
	}
	token := hex.EncodeToString(secret[:])
	path := "/antigravity-hook/" + token
	url := "http://" + listener.Addr().String() + path
	endpoint := &AntigravityHookEndpoint{
		dir:        dir,
		removeRoot: removeRoot,
		url:        url,
		listener:   listener,
		handlers:   map[string]*antigravityHookRegistration{},
	}
	hooksFile := filepath.Join(agentsDir, "hooks.json")
	if err := writeAntigravityHooksFile(hooksFile, daemonExecutable, url); err != nil {
		_ = listener.Close()
		cleanupDir()
		return nil, err
	}
	if err := sealAntigravityHookDir(dir, agentsDir, hooksFile); err != nil {
		_ = listener.Close()
		cleanupDir()
		return nil, err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+path, endpoint.serve)
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	endpoint.server = server
	go func() { _ = server.Serve(listener) }()
	return endpoint, nil
}

func sealAntigravityHookDir(dir, agentsDir, hooksFile string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	if err := os.Chmod(hooksFile, 0o400); err != nil {
		return err
	}
	if err := os.Chmod(agentsDir, 0o500); err != nil { //nolint:gosec // owner-only read-only directory mode; gosec expects a file mode for Chmod
		return err
	}
	return os.Chmod(dir, 0o500) //nolint:gosec // owner-only read-only directory mode; gosec expects a file mode for Chmod
}

func unlockAntigravityHookDir(dir string) {
	if runtime.GOOS == "windows" || dir == "" {
		return
	}
	_ = os.Chmod(dir, 0o700) //nolint:gosec // owner-only directory mode before removal; gosec expects a file mode for Chmod
	agentsDir := filepath.Join(dir, ".agents")
	_ = os.Chmod(agentsDir, 0o700) //nolint:gosec // owner-only directory mode before removal; gosec expects a file mode for Chmod
	_ = os.Chmod(filepath.Join(agentsDir, "hooks.json"), 0o600)
}

// Dir returns the managed directory containing `.agents/hooks.json`.
func (e *AntigravityHookEndpoint) Dir() string {
	return e.dir
}

// URL returns the loopback HTTP callback URL for hook tests and config.
func (e *AntigravityHookEndpoint) URL() string {
	return e.url
}

// Close shuts down the HTTP server and removes the managed hooks directory.
func (e *AntigravityHookEndpoint) Close() error {
	var err error
	if e.server != nil {
		err = e.server.Close()
	}
	if e.dir != "" {
		unlockAntigravityHookDir(e.dir)
		if e.removeRoot != nil {
			err = errors.Join(err, e.removeRoot())
		} else {
			err = errors.Join(err, os.RemoveAll(e.dir))
		}
	}
	return err
}

// Register routes hooks carrying sessionID to handler until the returned
// unregister function runs.
func (e *AntigravityHookEndpoint) Register(sessionID string, handler AntigravityHookHandler) func() {
	if e == nil || sessionID == "" || handler == nil {
		return func() {}
	}
	entry := &antigravityHookRegistration{handler: handler}
	e.mu.Lock()
	e.handlers[sessionID] = entry
	e.mu.Unlock()
	return func() {
		e.mu.Lock()
		if e.handlers[sessionID] == entry {
			delete(e.handlers, sessionID)
		}
		e.mu.Unlock()
	}
}

func writeAntigravityHookFailOpen(w io.Writer, hookEventName string) {
	// PreToolUse treats an empty `{}` object as a denial in agy, so failing
	// open requires an explicit allow decision.
	if hookEventName == "PreToolUse" {
		_, _ = io.WriteString(w, `{"decision":"allow"}`)
		return
	}
	_, _ = io.WriteString(w, "{}")
}

func (e *AntigravityHookEndpoint) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	raw, readErr := io.ReadAll(io.LimitReader(r.Body, maxAntigravityHookBytes+1))
	var req AntigravityHookRequest
	var decodeErr error
	if readErr != nil || len(raw) > maxAntigravityHookBytes {
		decodeErr = errors.New("hook request body exceeds limit")
	} else {
		decodeErr = json.Unmarshal(raw, &req)
		if decodeErr != nil {
			var meta struct {
				HookEventName string `json:"hookEventName"`
			}
			_ = json.Unmarshal(raw, &meta)
			req.HookEventName = meta.HookEventName
		}
	}
	if req.HookEventName == "" {
		req.HookEventName = r.URL.Query().Get("event")
	}
	if decodeErr != nil || req.ConversationID == "" {
		slog.Warn("antigravity.hook.invalid", "error", decodeErr, "has_conversation_id", req.ConversationID != "")
		writeAntigravityHookFailOpen(w, req.HookEventName)
		return
	}
	e.mu.Lock()
	entry := e.handlers[req.ConversationID]
	e.mu.Unlock()
	if entry == nil {
		slog.Warn("antigravity.hook.unmatched", "hook_event_name", req.HookEventName, "conversation_id", req.ConversationID)
		writeAntigravityHookFailOpen(w, req.HookEventName)
		return
	}
	resp := entry.handler(r.Context(), req)
	if req.HookEventName == "PreToolUse" && resp.Decision == "" {
		resp.Decision = "allow"
	}
	encoded, err := json.Marshal(resp)
	if err != nil || len(encoded) == 0 {
		writeAntigravityHookFailOpen(w, req.HookEventName)
		return
	}
	_, _ = w.Write(encoded)
}

func writeAntigravityHooksFile(path, daemonExecutable, endpointURL string) error {
	doc := antigravityHooksDocument(runtime.GOOS, daemonExecutable, endpointURL)
	encoded, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return privatefs.WriteFile(path, append(encoded, '\n'), true)
}

func antigravityHooksDocument(goos, daemonExecutable, endpointURL string) map[string]any {
	cmd := antigravityHookCommandForOS(goos, daemonExecutable, endpointURL)
	timeoutSeconds := int(AntigravityHookTimeout / time.Second)
	handler := []any{map[string]any{
		"type":    "command",
		"command": cmd,
		"timeout": timeoutSeconds,
	}}
	group := map[string]any{
		"PreInvocation": handler,
		"Stop":          handler,
	}
	// Windows runs PowerShell where ShellTextHook is inactive; omitting
	// resident PreToolUse avoids spawning a hook subprocess on every command,
	// while compaction still denies tools via ACP session/request_permission.
	if goos != "windows" {
		preToolUseCmd := antigravityHookCommandForOS(goos, daemonExecutable, endpointURL+"?event=PreToolUse")
		group["PreToolUse"] = []any{
			map[string]any{
				"matcher": "run_command",
				"hooks": []any{map[string]any{
					"type":    "command",
					"command": preToolUseCmd,
					"timeout": timeoutSeconds,
				}},
			},
		}
	}
	return map[string]any{
		"linger-steer": group,
	}
}

func antigravityHookURLIsPreToolUse(rawURL string) bool {
	parsed, err := url.Parse(rawURL)
	return err == nil && parsed.Query().Get("event") == "PreToolUse"
}

func antigravityHookCommand(daemonExecutable, endpointURL string) string {
	return antigravityHookCommandForOS(runtime.GOOS, daemonExecutable, endpointURL)
}

func antigravityHookCommandForOS(goos, daemonExecutable, endpointURL string) string {
	if goos == "windows" {
		quotedExe := quoteAntigravityHookArgForOS(goos, daemonExecutable)
		if !strings.ContainsAny(daemonExecutable, "&<>()@^|") {
			// The loopback endpoint URL contains only safe characters, so leaving it
			// unquoted keeps a 2-quote command that both `cmd /c` and `cmd /d /s /c`
			// execute without stripping quotes around spaces in daemonExecutable.
			return quotedExe + " antigravity-hook " + endpointURL
		}
		// cmd /c strips the leading and trailing quotes when quoted text contains
		// special characters (&<>()@^|), so wrap the whole command in outer quotes.
		return `"` + quotedExe + " antigravity-hook " + quoteAntigravityHookArgForOS(goos, endpointURL) + `"`
	}
	return quoteAntigravityHookArgForOS(goos, daemonExecutable) + " antigravity-hook " + quoteAntigravityHookArgForOS(goos, endpointURL)
}

func quoteAntigravityHookArgForOS(goos, value string) string {
	if goos == "windows" {
		return `"` + strings.ReplaceAll(value, `"`, `\"`) + `"`
	}
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// AntigravityRunHook is the `antigravity-hook` subcommand invoked by `agy`: it
// forwards hook stdin to endpointURL and writes the JSON response to stdout, or
// denies every tool call when invoked with `--deny-tools`. Any forwarding
// failure fails open with `{"decision":"allow"}\n` for PreToolUse and `{}\n`
// otherwise, with exit status 0 so Antigravity turns are never wedged.
func AntigravityRunHook(stdin io.Reader, stdout, _ io.Writer, endpointURL string) int {
	if endpointURL == antigravityHookDenyToolsArg {
		_, _ = io.Copy(io.Discard, io.LimitReader(stdin, maxAntigravityHookBytes))
		_, _ = io.WriteString(stdout, `{"decision":"deny","reason":"Tools are disabled for this model invocation."}`+"\n")
		return 0
	}
	input, readErr := io.ReadAll(io.LimitReader(stdin, maxAntigravityHookBytes+1))
	failOpen := func() int {
		if antigravityHookURLIsPreToolUse(endpointURL) {
			_, _ = io.WriteString(stdout, `{"decision":"allow"}`+"\n")
			return 0
		}
		if readErr == nil && len(input) <= maxAntigravityHookBytes {
			var meta struct {
				HookEventName string `json:"hookEventName"`
			}
			if json.Unmarshal(input, &meta) == nil && meta.HookEventName == "PreToolUse" {
				_, _ = io.WriteString(stdout, `{"decision":"allow"}`+"\n")
				return 0
			}
		}
		_, _ = io.WriteString(stdout, "{}\n")
		return 0
	}
	if readErr != nil || len(input) > maxAntigravityHookBytes {
		return failOpen()
	}
	if !strings.HasPrefix(endpointURL, "http://127.0.0.1:") {
		return failOpen()
	}
	ctx, cancel := context.WithTimeout(context.Background(), AntigravityHookTimeout-2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpointURL, bytes.NewReader(input))
	if err != nil {
		return failOpen()
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return failOpen()
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxAntigravityHookBytes))
	if err != nil || resp.StatusCode != http.StatusOK || !json.Valid(bytes.TrimSpace(body)) {
		return failOpen()
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return failOpen()
	}
	_, _ = stdout.Write(append(trimmed, '\n'))
	return 0
}
