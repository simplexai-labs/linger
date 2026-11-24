package provider

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

// Model invocation bounds. A reply travels back in one Runner Gateway frame
// of at most 4 MiB, so the reply text and the base64 workspace tree together
// stay below it.
const (
	ModelInvokeMaxTextBytes       = 1 << 20
	ModelInvokeMaxWorkspaceBytes  = 2 << 20
	ModelInvokeMaxWorkspaceFiles  = 256
	ModelInvokeMaxTimeout         = 4 * time.Hour
	modelInvokeMaxJSONOutputBytes = 3 << 20
	modelInvokeMaxDiagnosticBytes = 64 << 10
	modelInvokeMaxEventLineBytes  = 64 << 10
)

// Model invocation modes.
const (
	ModelInvokeStructured = "structured"
	ModelInvokeText       = "text"
	ModelInvokeWorkspace  = "workspace"
)

// Model invocation outcomes reported in executed model_invoke.
const (
	ModelInvokeCompleted           = "completed"
	ModelInvokeTimedOut            = "timed_out"
	ModelInvokeOutputLimited       = "output_limited"
	ModelInvokeCanceled            = "canceled"
	ModelInvokeUnavailable         = "unavailable"
	ModelInvokeRuntimeUnavailable  = "runtime_unavailable"
	ModelInvokeAuthRequired        = "auth_required"
	ModelInvokeRuntimeIncompatible = "runtime_incompatible"
	ModelInvokeContextTooLong      = "context_too_long"
	ModelInvokeUnsupported         = "unsupported"
	ModelInvokeFailed              = "failed"
)

// codexInvokeDisabledFeatures turns off every Codex tool family a one-shot
// call must not reach: shell and code execution, goals, browsers, computer
// use, connected apps, plugins, hooks, image tools, tool discovery, Skills and
// sleeping. Each name is passed as a features.<name>=false config override
// rather than --disable so older Codex releases ignore features they do not
// define instead of refusing to start. native.CodexSubAgentConfig turns off
// sub-agents.
var codexInvokeDisabledFeatures = []string{
	"shell_tool", "unified_exec", "code_mode_host", "goals",
	"browser_use", "browser_use_external", "browser_use_full_cdp_access",
	"computer_use", "in_app_browser", "apps", "plugins", "hooks",
	"image_generation", "view_image", "tool_suggest", "skill_search", "sleep_tool",
}

// codexWorkspaceKeptFeatures stay on in workspace mode. In Codex 0.166
// apply_patch is reached only through the code-mode host, whose JavaScript has
// no filesystem, process or network access. Shell and unified exec stay off:
// workspace-write bounds writes but not reads, so a shell could read any file
// the user can. Codex therefore cannot read files at all in workspace mode,
// and the Daemon inlines the input files into the prompt instead.
var codexWorkspaceKeptFeatures = map[string]bool{"code_mode_host": true}

// codexWorkspaceSandboxConfig removes /tmp and $TMPDIR from the writable roots
// workspace-write adds by default, so apply_patch writes only the working
// directory.
var codexWorkspaceSandboxConfig = []string{
	"sandbox_workspace_write.exclude_slash_tmp=true",
	"sandbox_workspace_write.exclude_tmpdir_env_var=true",
}

// codexInvokeSandboxConfig keeps Codex's Windows sandbox unelevated. The
// elevated default installs itself through codex-windows-sandbox-setup.exe,
// which raises a UAC prompt in front of the owner on a model call they never
// started. Model calls have no shell, so the unelevated sandbox loses nothing.
func codexInvokeSandboxConfig(goos string) []string {
	if goos != "windows" {
		return nil
	}
	return []string{"--config", `windows.sandbox="unelevated"`}
}

// claudeWorkspaceTools are the only Claude tools in workspace mode; --restricted
// confines them to the working directory.
const claudeWorkspaceTools = "Read,Write,Edit,Glob,Grep"

// ModelInvokeRuntime is an installed Runtime a model call runs.
type ModelInvokeRuntime struct {
	ExecutablePath string
	Environment    map[string]string
	Version        string
	// DefaultModel is the model the Runtime's own catalog marks as its
	// default for the signed-in account; empty when it marks none.
	DefaultModel string
}

// ModelInvokeFile is one workspace file, relative to the working directory.
type ModelInvokeFile struct {
	Path    string `json:"path"`
	Content []byte `json:"content_base64"`
}

// ModelInvokeRequest is one decoded execute model_invoke command.
type ModelInvokeRequest struct {
	RuntimeType     string
	Model           string
	Mode            string
	ReasoningEffort string
	Instructions    string
	Input           string
	OutputSchema    json.RawMessage
	WorkspaceFiles  []ModelInvokeFile
	Timeout         time.Duration
	// SessionKey names the session a structured call belongs to; calls of one
	// session share a resident Codex thread.
	SessionKey string
	// MaxOutputChars caps the reply a session call may stream; zero is no cap.
	MaxOutputChars int
}

// ModelInvokeUsage is the token usage the CLI reported.
type ModelInvokeUsage struct {
	InputTokens       int64 `json:"input_tokens"`
	CachedInputTokens int64 `json:"cached_input_tokens"`
	OutputTokens      int64 `json:"output_tokens"`
}

// ModelInvokeResult is what executed model_invoke carries back.
type ModelInvokeResult struct {
	Outcome        string
	Text           string
	WorkspaceFiles []ModelInvokeFile
	Model          string
	RuntimeVersion string
	Usage          *ModelInvokeUsage
	Reason         string
}

// ModelInvoker runs one-shot model calls on the installed Runtime
// in a fresh temporary directory. It never injects the Linger CLI credential
// and never loads the user's instructions, MCP servers, hooks or Skills.
type ModelInvoker struct {
	// TempBase holds the per-call temporary directories; empty uses the OS
	// temporary directory.
	TempBase string
	// ClaudeConfigRoot is the Claude configuration root model calls share. It
	// outlives each call so a refreshed OAuth login is kept; empty uses a
	// temporary root per call.
	ClaudeConfigRoot string
	// Lookup resolves an installed Runtime by type.
	Lookup func(ctx context.Context, runtimeType string) (ModelInvokeRuntime, bool, error)
	// Run executes the prepared command; nil runs it as an owned process group.
	Run func(ctx context.Context, command *exec.Cmd) error
	// CodexSessions answers structured Codex calls that name a session; nil
	// runs every call on its own.
	CodexSessions *CodexSessions
	// RuntimeHomeRoot holds the Context homes whose models cache a call's
	// Codex home reuses; empty reuses only the source and session homes.
	RuntimeHomeRoot string
}

// CodexSessions is the resident Codex process of session calls, with its own
// Codex home and working directory under Root.
type CodexSessions struct {
	Root string
	native.CodexModelSessions
	// prepare serializes rewriting the shared Codex home.
	prepare sync.Mutex
}

// Home is the session calls' Codex home.
func (s *CodexSessions) Home() string { return filepath.Join(s.Root, "codex-home") }

// codexModelsCache is the peers a call's Codex home seeds its models cache
// from, besides the source home.
func (m ModelInvoker) codexModelsCache() localworkspace.CodexModelsCachePeers {
	var peers localworkspace.CodexModelsCachePeers
	if m.RuntimeHomeRoot != "" {
		peers.Roots = []string{localworkspace.CodexRuntimeHomesDir(m.RuntimeHomeRoot)}
	}
	if m.CodexSessions != nil && m.CodexSessions.Root != "" {
		peers.Homes = []string{m.CodexSessions.Home()}
	}
	return peers
}

// Close stops the resident Codex process of session calls.
func (m ModelInvoker) Close() {
	if m.CodexSessions != nil {
		m.CodexSessions.Close()
	}
}

// modelInvocation is one prepared CLI command.
type modelInvocation struct {
	args        []string
	environment map[string]string
	stdout      io.Writer
	model       string
	release     func()
	// reply reads the final reply after a clean exit.
	reply func() (ModelInvokeResult, error)
	// failure names the last error the CLI reported in its own output.
	failure func() string
	// diagnostics returns structured failure metadata the CLI emitted.
	diagnostics func() (string, native.RuntimeFailureDiagnostics)
}

// Invoke runs one model call and always returns a result; failures are
// classified into outcomes instead of returned as errors.
func (m ModelInvoker) Invoke(ctx context.Context, request ModelInvokeRequest) ModelInvokeResult {
	if !native.Supports(request.RuntimeType) {
		return ModelInvokeResult{Outcome: ModelInvokeRuntimeUnavailable, Reason: "Runtime does not support model invocation"}
	}
	if m.Lookup == nil {
		return ModelInvokeResult{Outcome: ModelInvokeRuntimeUnavailable, Reason: "Runtime is not installed"}
	}
	installed, ok, err := m.Lookup(ctx, request.RuntimeType)
	if err != nil || !ok || installed.ExecutablePath == "" {
		return ModelInvokeResult{Outcome: ModelInvokeRuntimeUnavailable, Reason: "Runtime is not installed"}
	}
	result := m.invoke(ctx, request, installed)
	result.RuntimeVersion = installed.Version
	return result
}

func (m ModelInvoker) invoke(ctx context.Context, request ModelInvokeRequest, installed ModelInvokeRuntime) ModelInvokeResult {
	if result, ok := m.sessionInvoke(ctx, request, installed); ok {
		return result
	}
	root, cleanup, err := m.prepareTemp()
	if err != nil {
		return ModelInvokeResult{Outcome: ModelInvokeFailed, Reason: "Prepare model invocation directory: " + err.Error()}
	}
	defer cleanup()
	work := filepath.Join(root, "work")
	scratch := filepath.Join(root, "tmp")
	for _, directory := range []string{work, scratch} {
		if err := os.Mkdir(directory, 0o700); err != nil {
			return ModelInvokeResult{Outcome: ModelInvokeFailed, Reason: "Prepare model invocation directory: " + err.Error()}
		}
	}
	if request.RuntimeType == "pi" {
		return invokePiModel(ctx, request, installed, work, scratch)
	}
	if request.Mode == ModelInvokeWorkspace {
		if err := writeModelInvokeFiles(work, request.WorkspaceFiles); err != nil {
			return ModelInvokeResult{Outcome: ModelInvokeFailed, Reason: err.Error()}
		}
	}
	environment := modelInvokeEnvironment(installed.Environment, scratch)
	var invocation modelInvocation
	if request.RuntimeType == "codex" {
		invocation, err = codexModelInvocation(request, environment, root, work, installed, m.codexModelsCache())
	} else {
		invocation, err = claudeModelInvocation(request, environment, m.ClaudeConfigRoot)
	}
	if err != nil {
		var unavailable modelInvokeUnavailableError
		if errors.As(err, &unavailable) {
			return ModelInvokeResult{Outcome: unavailable.outcome, Reason: unavailable.reason}
		}
		return ModelInvokeResult{Outcome: ModelInvokeFailed, Reason: err.Error()}
	}
	if invocation.release != nil {
		defer invocation.release()
	}
	invokeCtx, cancel := context.WithTimeout(ctx, modelInvokeTimeout(request.Timeout))
	defer cancel()
	command := exec.CommandContext(invokeCtx, installed.ExecutablePath, invocation.args...)
	command.Dir = work
	command.Env = environmentList(invocation.environment)
	prompt := modelInvokePrompt(request.Instructions, request.Input)
	if request.RuntimeType == "codex" && request.Mode == ModelInvokeWorkspace {
		prompt += codexWorkspaceFilesPrompt(request.WorkspaceFiles)
	}
	command.Stdin = strings.NewReader(prompt)
	command.Stdout = invocation.stdout
	stderr := &boundedProbeBuffer{limit: modelInvokeMaxDiagnosticBytes}
	command.Stderr = stderr
	run := m.Run
	if run == nil {
		run = func(ctx context.Context, command *exec.Cmd) error { return process.Run(ctx, command, time.Second) }
	}
	runErr := run(invokeCtx, command)
	if runErr != nil || invokeCtx.Err() != nil {
		failureCode, diag := invocationDiagnostics(invocation)
		return classifyModelInvokeFailureWithDiagnostics(ctx, invokeCtx, request.RuntimeType, runErr, stderr.String(), invocation.failure(), failureCode, diag)
	}
	result, err := invocation.reply()
	if err != nil {
		reported := invocation.failure()
		if reported == "" {
			reported = err.Error()
		}
		failureCode, diag := invocationDiagnostics(invocation)
		return classifyModelInvokeFailureWithDiagnostics(ctx, invokeCtx, request.RuntimeType, err, stderr.String(), reported, failureCode, diag)
	}
	if request.Mode == ModelInvokeWorkspace {
		files, err := readModelInvokeFiles(work)
		if err != nil {
			return ModelInvokeResult{Outcome: ModelInvokeFailed, Reason: err.Error()}
		}
		result.WorkspaceFiles = files
	}
	if result.Model == "" {
		result.Model = invocation.model
	}
	result.Outcome = ModelInvokeCompleted
	return result
}

func modelInvokeTimeout(timeout time.Duration) time.Duration {
	if timeout <= 0 {
		return 10 * time.Minute
	}
	if timeout > ModelInvokeMaxTimeout {
		return ModelInvokeMaxTimeout
	}
	return timeout
}

// sessionInvoke answers a structured Codex call that names a session in that
// session's resident thread. It reports false when the call runs on its own
// instead: it names no session, uses another Runtime or mode, or its thread is
// answering another call.
func (m ModelInvoker) sessionInvoke(ctx context.Context, request ModelInvokeRequest, installed ModelInvokeRuntime) (ModelInvokeResult, bool) {
	sessions := m.CodexSessions
	if sessions == nil || sessions.Root == "" || request.SessionKey == "" || request.RuntimeType != "codex" ||
		request.Mode != ModelInvokeStructured || request.Instructions == "" {
		return ModelInvokeResult{}, false
	}
	home, work, scratch := sessions.Home(), filepath.Join(sessions.Root, "work"), filepath.Join(sessions.Root, "tmp")
	for _, directory := range []string{work, scratch} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return ModelInvokeResult{Outcome: ModelInvokeFailed, Reason: "Prepare model session directory: " + err.Error()}, true
		}
	}
	environment := modelInvokeEnvironment(installed.Environment, scratch)
	sourceHome, err := localworkspace.CodexSourceHome(environment)
	if err != nil {
		return ModelInvokeResult{Outcome: ModelInvokeRuntimeUnavailable, Reason: err.Error()}, true
	}
	sessions.prepare.Lock()
	prepared, err := localworkspace.PrepareCodexInvokeHome(home, sourceHome, installed.Version, m.codexModelsCache())
	sessions.prepare.Unlock()
	if err != nil {
		return ModelInvokeResult{Outcome: ModelInvokeFailed, Reason: "Prepare Codex home: " + err.Error()}, true
	}
	if prepared.AuthenticationMissing {
		return ModelInvokeResult{Outcome: ModelInvokeAuthRequired, Reason: "Codex is not signed in"}, true
	}
	environment["CODEX_HOME"] = home
	args := []string{"--config", `web_search="disabled"`}
	named := codexInvokeModel(request.Model, prepared.Model, installed.DefaultModel)
	if named != "" {
		args = append(args, "--config", fmt.Sprintf("model=%q", named))
	}
	args = append(args, codexInvokeSandboxConfig(runtime.GOOS)...)
	for _, feature := range codexInvokeDisabledFeatures {
		args = append(args, "--config", "features."+feature+"=false")
	}
	invokeCtx, cancel := context.WithTimeout(ctx, modelInvokeTimeout(request.Timeout))
	defer cancel()
	answer, err := sessions.Run(invokeCtx, native.CodexModelRuntime{
		Executable: installed.ExecutablePath, Version: installed.Version, Model: cmp.Or(named, prepared.Model),
		Environment: environment, Dir: work, Args: args,
	}, native.CodexModelCall{
		Session: request.SessionKey, Instructions: request.Instructions, Input: request.Input,
		OutputSchema: request.OutputSchema, Effort: request.ReasoningEffort, MaxOutputChars: request.MaxOutputChars,
	})
	switch {
	case errors.Is(err, native.ErrCodexModelSessionBusy):
		return ModelInvokeResult{}, false
	case errors.Is(err, native.ErrCodexModelOutputLimit):
		return ModelInvokeResult{Outcome: ModelInvokeOutputLimited, Reason: "Model reply exceeded its output limit", Text: answer.Text}, true
	case err != nil:
		var diag native.RuntimeFailureDiagnostics
		var sessionErr *native.CodexModelFailureError
		if errors.As(err, &sessionErr) {
			diag = sessionErr.Diagnostics
		}
		result := classifyModelInvokeFailureWithDiagnostics(ctx, invokeCtx, "codex", err, "", err.Error(), "", diag)
		if result.Outcome == ModelInvokeTimedOut || result.Outcome == ModelInvokeCanceled {
			result.Text = answer.Text
		}
		return result, true
	case len(answer.Text) > ModelInvokeMaxTextBytes:
		return ModelInvokeResult{Outcome: ModelInvokeFailed, Reason: "Runtime reply exceeds 1 MiB"}, true
	}
	model := cmp.Or(answer.Model, named, prepared.Model)
	return ModelInvokeResult{
		Outcome: ModelInvokeCompleted, Text: answer.Text, Model: model,
		Usage: &ModelInvokeUsage{InputTokens: answer.Input, CachedInputTokens: answer.CachedInput, OutputTokens: answer.Output},
	}, true
}

func (m ModelInvoker) prepareTemp() (string, func(), error) {
	if m.TempBase == "" {
		root, err := os.MkdirTemp("", "linger-model-invoke-")
		if err != nil {
			return "", nil, err
		}
		return root, func() { _ = os.RemoveAll(root) }, nil
	}
	temp, err := localworkspace.PrepareOperationTemp(m.TempBase)
	if err != nil {
		return "", nil, err
	}
	return temp.Path, func() { _ = temp.Close() }, nil
}

type modelInvokeUnavailableError struct{ outcome, reason string }

func (e modelInvokeUnavailableError) Error() string { return e.reason }

// modelInvokeEnvironment copies the Runtime environment, points temporary
// files at the call's own directory and drops anything that could carry a
// Linger or TeamHub credential.
func modelInvokeEnvironment(source map[string]string, scratch string) map[string]string {
	environment := make(map[string]string, len(source)+3)
	for key, value := range source {
		upper := strings.ToUpper(key)
		if strings.HasPrefix(upper, "LINGER_") ||
			strings.HasPrefix(upper, "TEAMHUB_") || strings.HasPrefix(upper, "RUNNER_GATEWAY_") {
			continue
		}
		environment[key] = value
	}
	for _, key := range []string{"TMPDIR", "TMP", "TEMP"} {
		environment[key] = scratch
	}
	return environment
}

// modelInvokePrompt is written to the CLI's stdin: argv is size-limited and
// visible to every local process.
func modelInvokePrompt(instructions, input string) string {
	if instructions == "" {
		return input
	}
	return instructions + "\n\n<input>\n" + input + "\n</input>\n"
}

// codexWorkspaceFilesPrompt inlines the workspace input files, because Codex
// has no tool that reads them in workspace mode. A file that is not UTF-8 text
// is named but not shown.
func codexWorkspaceFilesPrompt(files []ModelInvokeFile) string {
	var prompt strings.Builder
	prompt.WriteString("\n<workspace_files>\nThe working directory already holds these files. You cannot read files, so their full contents are given here. Create, change or delete files only with apply_patch, using paths relative to the working directory.\n")
	for _, file := range files {
		if !utf8.Valid(file.Content) {
			fmt.Fprintf(&prompt, "<workspace_file path=%q bytes=\"%d\" binary=\"true\"/>\n", file.Path, len(file.Content))
			continue
		}
		fmt.Fprintf(&prompt, "<workspace_file path=%q>\n%s\n</workspace_file>\n", file.Path, file.Content)
	}
	prompt.WriteString("</workspace_files>\n")
	return prompt.String()
}

func codexModelInvocation(request ModelInvokeRequest, environment map[string]string, root, work string, installed ModelInvokeRuntime, modelsCache localworkspace.CodexModelsCachePeers) (modelInvocation, error) {
	sourceHome, err := localworkspace.CodexSourceHome(environment)
	if err != nil {
		return modelInvocation{}, modelInvokeUnavailableError{ModelInvokeRuntimeUnavailable, err.Error()}
	}
	home := filepath.Join(root, "codex-home")
	prepared, err := localworkspace.PrepareCodexInvokeHome(home, sourceHome, installed.Version, modelsCache)
	if err != nil {
		return modelInvocation{}, fmt.Errorf("prepare Codex home: %w", err)
	}
	if prepared.AuthenticationMissing {
		return modelInvocation{}, modelInvokeUnavailableError{ModelInvokeAuthRequired, "Codex is not signed in"}
	}
	named := codexInvokeModel(request.Model, prepared.Model, installed.DefaultModel)
	environment["CODEX_HOME"] = home
	schemaPath := ""
	if request.Mode == ModelInvokeStructured {
		schemaPath = filepath.Join(root, "schema.json")
		if err := os.WriteFile(schemaPath, request.OutputSchema, 0o600); err != nil {
			return modelInvocation{}, fmt.Errorf("write output schema: %w", err)
		}
	}
	lastPath := filepath.Join(root, "last.txt")
	events := &codexInvokeEvents{}
	return modelInvocation{
		args:        codexModelInvokeArgs(request.Mode, request.ReasoningEffort, named, work, schemaPath, lastPath),
		environment: environment,
		stdout:      events,
		model:       cmp.Or(named, prepared.Model),
		reply: func() (ModelInvokeResult, error) {
			text, err := readModelInvokeReply(lastPath)
			if err != nil {
				return ModelInvokeResult{}, err
			}
			return ModelInvokeResult{Text: text, Usage: events.usage()}, nil
		},
		failure:     events.failure,
		diagnostics: events.diagnostics,
	}, nil
}

// codexInvokeModel is the model a Codex call names explicitly on the command
// line. An explicit request model always wins so background calls follow the
// Agent's configured model and override config.toml. When a legacy caller
// names none, a model configured in config.toml still decides; otherwise the
// Runtime catalog's default for the signed-in account is used.
func codexInvokeModel(requested, configured, catalogDefault string) string {
	if model := strings.TrimSpace(requested); model != "" {
		return model
	}
	if configured != "" {
		return ""
	}
	return catalogDefault
}

// codexModelInvokeArgs builds the codex exec argv; an empty model leaves the
// choice to config.toml. The prompt is read from stdin, so no positional
// argument follows the options.
func codexModelInvokeArgs(mode, effort, model, work, schemaPath, lastPath string) []string {
	sandbox := "read-only"
	if mode == ModelInvokeWorkspace {
		sandbox = "workspace-write"
	}
	args := []string{
		"exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", sandbox, "--ignore-rules",
		"--color", "never", "-C", work,
	}
	if effort != "" {
		args = append(args, "-c", fmt.Sprintf("model_reasoning_effort=%q", effort))
	}
	args = append(args, "-c", `web_search="disabled"`)
	if model != "" {
		args = append(args, "-m", model)
	}
	args = append(args, codexInvokeSandboxConfig(runtime.GOOS)...)
	if mode == ModelInvokeWorkspace {
		for _, setting := range codexWorkspaceSandboxConfig {
			args = append(args, "-c", setting)
		}
	}
	for _, feature := range codexInvokeDisabledFeatures {
		if mode == ModelInvokeWorkspace && codexWorkspaceKeptFeatures[feature] {
			continue
		}
		args = append(args, "-c", "features."+feature+"=false")
	}
	args = append(args, native.CodexSubAgentConfig()...)
	if schemaPath != "" {
		args = append(args, "--output-schema", schemaPath)
	}
	return append(args, "--json", "-o", lastPath)
}

// codexInvokeEvents reads codex exec --json events as they stream, keeping
// only the reported usage and the last error. Oversized lines, such as a long
// agent message, are skipped.
type codexInvokeEvents struct {
	mu              sync.Mutex
	line            []byte
	skipping        bool
	lastUsage       *ModelInvokeUsage
	lastError       string
	lastDiagnostics native.RuntimeFailureDiagnostics
}

func (e *codexInvokeEvents) Write(value []byte) (int, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for remaining := value; len(remaining) > 0; {
		end := bytes.IndexByte(remaining, '\n')
		chunk := remaining
		if end >= 0 {
			chunk = remaining[:end]
		}
		if !e.skipping {
			if len(e.line)+len(chunk) > modelInvokeMaxEventLineBytes {
				e.line, e.skipping = e.line[:0], true
			} else {
				e.line = append(e.line, chunk...)
			}
		}
		if end < 0 {
			break
		}
		if !e.skipping {
			e.observe(e.line)
		}
		e.line, e.skipping = e.line[:0], false
		remaining = remaining[end+1:]
	}
	return len(value), nil
}

func (e *codexInvokeEvents) observe(line []byte) {
	var event struct {
		Type  string `json:"type"`
		Usage *struct {
			InputTokens       int64 `json:"input_tokens"`
			CachedInputTokens int64 `json:"cached_input_tokens"`
			OutputTokens      int64 `json:"output_tokens"`
		} `json:"usage"`
		Message        string          `json:"message"`
		CodexErrorInfo json.RawMessage `json:"codexErrorInfo"`
		Error          *struct {
			Message        string          `json:"message"`
			CodexErrorInfo json.RawMessage `json:"codexErrorInfo"`
		} `json:"error"`
	}
	if json.Unmarshal(line, &event) != nil {
		return
	}
	switch event.Type {
	case "turn.completed":
		if event.Usage != nil {
			e.lastUsage = &ModelInvokeUsage{
				InputTokens: event.Usage.InputTokens, CachedInputTokens: event.Usage.CachedInputTokens,
				OutputTokens: event.Usage.OutputTokens,
			}
		}
	case "error":
		e.lastError = event.Message
		if diag := native.CodexErrorDiagnostics(event.CodexErrorInfo); diag.Code != "" || diag.StatusCode != nil {
			e.lastDiagnostics = diag
		}
	case "turn.failed":
		if event.Error != nil {
			e.lastError = event.Error.Message
			if diag := native.CodexErrorDiagnostics(event.Error.CodexErrorInfo); diag.Code != "" || diag.StatusCode != nil {
				e.lastDiagnostics = diag
			}
		}
	}
}

func (e *codexInvokeEvents) usage() *ModelInvokeUsage {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.lastUsage
}

func (e *codexInvokeEvents) failure() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.lastError
}

func (e *codexInvokeEvents) diagnostics() (string, native.RuntimeFailureDiagnostics) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return "", e.lastDiagnostics
}

func claudeModelInvocation(request ModelInvokeRequest, environment map[string]string, configRoot string) (modelInvocation, error) {
	var prepared map[string]string
	var release func()
	var err error
	if configRoot == "" {
		prepared, release, err = localworkspace.ClaudeProbeEnvironment(environment)
	} else {
		prepared, err = localworkspace.ClaudeModelInvokeEnvironment(configRoot, environment)
	}
	if err != nil {
		return modelInvocation{}, fmt.Errorf("prepare Claude credentials: %w", err)
	}
	prepared = native.ClaudeEnvironment(prepared)
	stdout := &boundedProbeBuffer{limit: modelInvokeMaxJSONOutputBytes}
	var reported claudeInvokeOutput
	parse := func() error {
		if stdout.overflow {
			return errors.New("Runtime reply exceeds the model invocation limit")
		}
		if err := json.Unmarshal([]byte(stdout.String()), &reported); err != nil {
			return errors.New("Runtime reply is not valid JSON output")
		}
		return nil
	}
	requestedModel := strings.TrimSpace(request.Model)
	return modelInvocation{
		args:        claudeModelInvokeArgs(request.Mode, request.ReasoningEffort, requestedModel, request.OutputSchema),
		environment: prepared,
		stdout:      stdout,
		model:       requestedModel,
		release:     release,
		reply: func() (ModelInvokeResult, error) {
			if err := parse(); err != nil {
				return ModelInvokeResult{}, err
			}
			if reported.IsError {
				return ModelInvokeResult{}, errors.New(reported.Result)
			}
			text := reported.Result
			if request.Mode == ModelInvokeStructured && len(reported.StructuredOutput) != 0 && string(reported.StructuredOutput) != "null" {
				text = string(reported.StructuredOutput)
			}
			if len(text) > ModelInvokeMaxTextBytes {
				return ModelInvokeResult{}, errors.New("Runtime reply exceeds 1 MiB")
			}
			if strings.TrimSpace(text) == "" && request.Mode != ModelInvokeWorkspace {
				return ModelInvokeResult{}, errors.New("Runtime exited without a reply")
			}
			return ModelInvokeResult{Text: text, Model: reported.model(), Usage: reported.usage()}, nil
		},
		failure: func() string {
			if parse() == nil && reported.IsError {
				return reported.Result
			}
			return ""
		},
		diagnostics: func() (string, native.RuntimeFailureDiagnostics) {
			if parse() != nil {
				return "", native.RuntimeFailureDiagnostics{}
			}
			var diag native.RuntimeFailureDiagnostics
			if reported.APIErrorStatus != 0 {
				status := int(reported.APIErrorStatus)
				diag.StatusCode = &status
			}
			if strings.TrimSpace(reported.TerminalReason) == "prompt_too_long" {
				return "context_too_long", diag
			}
			return "", diag
		},
	}, nil
}

// claudeModelInvokeArgs builds the claude -p argv. --safe-mode turns off
// CLAUDE.md, Skills, hooks, MCP servers and plugins while sign-in still works;
// the prompt is read from stdin.
func claudeModelInvokeArgs(mode, effort, model string, schema json.RawMessage) []string {
	args := []string{"-p", "--output-format", "json"}
	if model != "" {
		args = append(args, "--model", model)
	}
	if mode == ModelInvokeStructured {
		args = append(args, "--json-schema", string(schema))
	}
	if mode == ModelInvokeWorkspace {
		args = append(args, "--tools", claudeWorkspaceTools, "--restricted", "--permission-mode", "acceptEdits")
	} else {
		args = append(args, "--tools", "", "--permission-mode", "dontAsk")
	}
	args = append(args, "--safe-mode", "--strict-mcp-config", "--no-session-persistence",
		"--disable-slash-commands")
	switch effort {
	case "":
	case "none":
		args = append(args, "--thinking", "disabled")
	default:
		args = append(args, "--effort", effort)
	}
	return args
}

type claudeInvokeOutput struct {
	IsError          bool            `json:"is_error"`
	TerminalReason   string          `json:"terminal_reason"`
	APIErrorStatus   float64         `json:"api_error_status"`
	Result           string          `json:"result"`
	StructuredOutput json.RawMessage `json:"structured_output"`
	Usage            *struct {
		InputTokens          int64 `json:"input_tokens"`
		CacheReadInputTokens int64 `json:"cache_read_input_tokens"`
		OutputTokens         int64 `json:"output_tokens"`
	} `json:"usage"`
	ModelUsage map[string]json.RawMessage `json:"modelUsage"`
}

func (o claudeInvokeOutput) usage() *ModelInvokeUsage {
	if o.Usage == nil {
		return nil
	}
	return &ModelInvokeUsage{
		InputTokens: o.Usage.InputTokens, CachedInputTokens: o.Usage.CacheReadInputTokens,
		OutputTokens: o.Usage.OutputTokens,
	}
}

func (o claudeInvokeOutput) model() string {
	models := make([]string, 0, len(o.ModelUsage))
	for model := range o.ModelUsage {
		models = append(models, model)
	}
	if len(models) != 1 {
		return ""
	}
	return models[0]
}

func readModelInvokeReply(path string) (string, error) {
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", errors.New("Runtime exited without a reply")
	}
	if err != nil {
		return "", err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, ModelInvokeMaxTextBytes+1))
	if err != nil {
		return "", err
	}
	if len(data) > ModelInvokeMaxTextBytes {
		return "", errors.New("Runtime reply exceeds 1 MiB")
	}
	if strings.TrimSpace(string(data)) == "" {
		return "", errors.New("Runtime exited without a reply")
	}
	return string(data), nil
}

func writeModelInvokeFiles(work string, files []ModelInvokeFile) error {
	if len(files) > ModelInvokeMaxWorkspaceFiles {
		return errors.New("Model invocation workspace has too many files")
	}
	for _, file := range files {
		relative := filepath.FromSlash(file.Path)
		if file.Path == "" || !filepath.IsLocal(relative) {
			return fmt.Errorf("Model invocation workspace path %q is not relative", file.Path)
		}
		if modelInvokeReservedPath(file.Path) {
			return fmt.Errorf("Model invocation workspace path %q is reserved for Runtime configuration", file.Path)
		}
		target := filepath.Join(work, relative)
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(target, file.Content, 0o600); err != nil {
			return err
		}
	}
	return nil
}

// modelInvokeReservedPath reports a path the Runtime CLI would load as
// instructions or configuration: AGENTS.md, AGENTS.override.md and CLAUDE.md
// at the root, and .codex or .claude at any depth. Matching ignores case
// because macOS and Windows file systems do.
func modelInvokeReservedPath(path string) bool {
	segments := strings.Split(strings.ToLower(filepath.ToSlash(filepath.Clean(filepath.FromSlash(path)))), "/")
	if len(segments) == 1 && (segments[0] == "agents.md" || segments[0] == "agents.override.md" || segments[0] == "claude.md") {
		return true
	}
	for _, segment := range segments {
		if segment == ".codex" || segment == ".claude" {
			return true
		}
	}
	return false
}

// readModelInvokeFiles returns the working directory's regular files. Links
// are skipped so a reply never carries a file from outside the directory.
func readModelInvokeFiles(work string) ([]ModelInvokeFile, error) {
	var files []ModelInvokeFile
	total := 0
	err := filepath.WalkDir(work, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		if len(files) == ModelInvokeMaxWorkspaceFiles {
			return errors.New("Model invocation workspace output has too many files")
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		total += int(info.Size())
		if total > ModelInvokeMaxWorkspaceBytes {
			return errors.New("Model invocation workspace output exceeds 2 MiB")
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(work, path)
		if err != nil {
			return err
		}
		files = append(files, ModelInvokeFile{Path: filepath.ToSlash(relative), Content: content})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, nil
}

var modelInvokeIncompatibleMarkers = []string{
	"unexpected argument", "unknown option", "unrecognized option", "unknown feature flag", "invalid value for",
}

var modelInvokeAuthMarkers = []string{
	"not logged in", "/login", "codex login", "unauthorized", "authentication required",
	"invalid api key", "invalid_api_key", "please sign in",
}

var posixNetworkErrnoPattern = regexp.MustCompile(`\b(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND)\b`)

type structuredAPIError struct {
	Code    string
	Type    string
	Message string
}

// parseStructuredAPIError extracts a structured provider API error object
// (`{"error":{"code":...,"type":...}}` or top-level `{"code":...,"type":...}`)
// from a whole JSON body or a client error line carrying an embedded JSON body.
func parseStructuredAPIError(text string) (structuredAPIError, bool) {
	rest := strings.TrimSpace(text)
	for len(rest) > 0 {
		idx := strings.IndexByte(rest, '{')
		if idx < 0 {
			return structuredAPIError{}, false
		}
		rest = rest[idx:]
		var body struct {
			Code    string `json:"code"`
			Type    string `json:"type"`
			Message string `json:"message"`
			Error   *struct {
				Code    string `json:"code"`
				Type    string `json:"type"`
				Message string `json:"message"`
			} `json:"error"`
		}
		dec := json.NewDecoder(strings.NewReader(rest))
		if err := dec.Decode(&body); err == nil {
			if body.Error != nil && (body.Error.Code != "" || body.Error.Type != "") {
				return structuredAPIError{
					Code:    strings.TrimSpace(body.Error.Code),
					Type:    strings.TrimSpace(body.Error.Type),
					Message: strings.TrimSpace(body.Error.Message),
				}, true
			}
			if body.Code != "" {
				return structuredAPIError{
					Code:    strings.TrimSpace(body.Code),
					Type:    strings.TrimSpace(body.Type),
					Message: strings.TrimSpace(body.Message),
				}, true
			}
		}
		rest = rest[1:]
	}
	return structuredAPIError{}, false
}

func isContextTooLongErrorCode(code string) bool {
	switch code {
	case "exceed_context_size_error", "context_length_exceeded", "context_window_exceeded", "contextWindowExceeded", "prompt_too_long":
		return true
	}
	return false
}

func isAuthErrorCode(code string) bool {
	switch code {
	case "invalid_api_key", "authentication_error", "authentication_failed", "unauthorized":
		return true
	}
	return false
}

func isUnavailableErrorCode(code string) bool {
	switch code {
	case "server_error", "overloaded_error", "service_unavailable", "unavailable_error", "model_not_loaded":
		return true
	}
	return false
}

func invocationDiagnostics(invocation modelInvocation) (string, native.RuntimeFailureDiagnostics) {
	if invocation.diagnostics == nil {
		return "", native.RuntimeFailureDiagnostics{}
	}
	return invocation.diagnostics()
}

// classifyModelInvokeFailure maps a failed run to an outcome. The caller's
// cancellation wins over the call's own deadline, which wins over the CLI's
// message.
func classifyModelInvokeFailure(ctx, invokeCtx context.Context, err error, stderr, reported string) ModelInvokeResult {
	return classifyModelInvokeFailureWithDiagnostics(ctx, invokeCtx, "", err, stderr, reported, "", native.RuntimeFailureDiagnostics{})
}

func classifyModelInvokeFailureWithDiagnostics(
	ctx, invokeCtx context.Context,
	runtimeType string,
	err error,
	stderr, reported, failureCode string,
	diagnostics native.RuntimeFailureDiagnostics,
) ModelInvokeResult {
	if ctx.Err() != nil {
		return ModelInvokeResult{Outcome: ModelInvokeCanceled, Reason: "Model invocation was canceled"}
	}
	if errors.Is(invokeCtx.Err(), context.DeadlineExceeded) {
		return ModelInvokeResult{Outcome: ModelInvokeTimedOut, Reason: "Model invocation timed out"}
	}
	reason := reported
	if reason == "" {
		if err == nil {
			err = errors.New("Runtime failed")
		}
		reason = liveFailureMessage(stderr, err)
	}
	reason = truncateRunes(redact.Text(strings.TrimSpace(reason)), 300)

	if failureCode != "" || diagnostics.Code != "" || diagnostics.StatusCode != nil {
		classified := ClassifyExecutionFailure(runtimeType, "", "failed", failureCode, diagnostics)
		switch classified.Code {
		case "context_too_long":
			return ModelInvokeResult{Outcome: ModelInvokeContextTooLong, Reason: "Model invocation prompt exceeds the model context window"}
		case "authentication_required":
			return ModelInvokeResult{Outcome: ModelInvokeAuthRequired, Reason: reason}
		case "model_unavailable":
			return ModelInvokeResult{Outcome: ModelInvokeRuntimeIncompatible, Reason: reason}
		case "model_service_error", "network_error":
			return ModelInvokeResult{Outcome: ModelInvokeRuntimeUnavailable, Reason: reason}
		}
	}

	apiSource := reported
	if apiSource == "" {
		apiSource = stderr
	}
	if apiErr, ok := parseStructuredAPIError(apiSource); ok {
		if apiErr.Code == "model_not_found" {
			unavailable := "The model is not available to this account"
			if apiErr.Message != "" {
				unavailable += ": " + apiErr.Message
			}
			return ModelInvokeResult{Outcome: ModelInvokeRuntimeIncompatible, Reason: truncateRunes(redact.Text(unavailable), 300)}
		}
		if isContextTooLongErrorCode(apiErr.Code) || isContextTooLongErrorCode(apiErr.Type) {
			return ModelInvokeResult{Outcome: ModelInvokeContextTooLong, Reason: "Model invocation prompt exceeds the model context window"}
		}
		if isAuthErrorCode(apiErr.Code) || isAuthErrorCode(apiErr.Type) {
			return ModelInvokeResult{Outcome: ModelInvokeAuthRequired, Reason: reason}
		}
		if isUnavailableErrorCode(apiErr.Code) || isUnavailableErrorCode(apiErr.Type) {
			return ModelInvokeResult{Outcome: ModelInvokeRuntimeUnavailable, Reason: reason}
		}
	}

	evidence := strings.ToLower(stderr + "\n" + reported)
	for _, marker := range modelInvokeIncompatibleMarkers {
		if strings.Contains(evidence, marker) {
			return ModelInvokeResult{Outcome: ModelInvokeRuntimeIncompatible, Reason: reason}
		}
	}
	for _, marker := range modelInvokeAuthMarkers {
		if strings.Contains(evidence, marker) {
			return ModelInvokeResult{Outcome: ModelInvokeAuthRequired, Reason: reason}
		}
	}
	if posixNetworkErrnoPattern.MatchString(stderr + "\n" + reported) {
		return ModelInvokeResult{Outcome: ModelInvokeRuntimeUnavailable, Reason: reason}
	}
	return ModelInvokeResult{Outcome: ModelInvokeFailed, Reason: reason}
}
