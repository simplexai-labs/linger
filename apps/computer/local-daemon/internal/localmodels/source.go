package localmodels

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

const (
	modelSourceSchema       = "localmodels.model-source/v1"
	modelSourceStatusSchema = "localmodels.model-source-status/v1"
	modelSourceCheckSchema  = "localmodels.byok-check/v1"
	modelSourceModelsSchema = "localmodels.byok-models/v1"

	defaultModelSourceTimeout = 3 * time.Minute
	defaultByokTestTimeout    = 45 * time.Second
)

// ModelSourceError carries a structured error code and message from localmodels
// source operations without exposing local file paths or credentials.
type ModelSourceError struct {
	Code      string
	Message   string
	Retryable bool
}

func (e *ModelSourceError) Error() string { return e.Message }

// ModelSourceApply describes one model-source switch requested by the Computer owner.
type ModelSourceApply struct {
	Mode         string
	Runtime      string
	LocalModelID string
	Byok         *wire.ByokConfigInput
}

// OverlayState is the active model-source profile persisted by localmodels in
// <state_dir>/model-source.json.
type OverlayState struct {
	Mode         string
	Runtime      string
	RuntimeModel string
	// ModelLabel names the model the source serves, as the person entered it.
	ModelLabel   string
	GatewayURL   string
	Environment  map[string]string
	RuntimePaths map[string]string
}

type storedModelSourceFile struct {
	Schema       string            `json:"schema"`
	Mode         string            `json:"mode"`
	Runtime      string            `json:"runtime"`
	RuntimeModel string            `json:"runtime_model"`
	ModelLabel   string            `json:"model_label"`
	GatewayURL   *string           `json:"gateway_url"`
	Environment  map[string]string `json:"environment"`
	RuntimePaths map[string]string `json:"runtime_paths"`
}

var allowedOverlayEnvKeys = []string{"CODEX_HOME", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR"}

// ReadOverlay reads the persisted model-source.json from stateDir, returning
// nil when absent or invalid so callers preserve existing behavior.
func ReadOverlay(stateDir string) *OverlayState {
	if stateDir == "" {
		return nil
	}
	raw, err := readBounded(filepath.Join(stateDir, "model-source.json"), 64*1024)
	if err != nil {
		return nil
	}
	var doc storedModelSourceFile
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil
	}
	if doc.Schema != modelSourceSchema ||
		!slices.Contains([]string{"local", "subscription", "byok"}, doc.Mode) ||
		!slices.Contains([]string{"claude", "codex", "pi"}, doc.Runtime) {
		return nil
	}
	env := make(map[string]string)
	for _, key := range allowedOverlayEnvKeys {
		if value := strings.TrimSpace(doc.Environment[key]); value != "" && filepath.IsAbs(value) {
			env[key] = filepath.Clean(value)
		}
	}
	paths := make(map[string]string)
	for _, rt := range []string{"claude", "codex", "pi"} {
		if value := strings.TrimSpace(doc.RuntimePaths[rt]); value != "" && filepath.IsAbs(value) {
			paths[rt] = filepath.Clean(value)
		}
	}
	gatewayURL := ""
	if doc.GatewayURL != nil {
		gatewayURL = strings.TrimSpace(*doc.GatewayURL)
	}
	return &OverlayState{
		Mode:         doc.Mode,
		Runtime:      doc.Runtime,
		RuntimeModel: strings.TrimSpace(doc.RuntimeModel),
		ModelLabel:   strings.TrimSpace(doc.ModelLabel),
		GatewayURL:   gatewayURL,
		Environment:  env,
		RuntimePaths: paths,
	}
}

func isManagedGatewayProfilePath(stateDir, candidate string) bool {
	if stateDir == "" || candidate == "" {
		return false
	}
	cleaned := filepath.Clean(candidate)
	for _, sub := range []string{"gateway-home", "byok-home"} {
		prefix := filepath.Clean(filepath.Join(stateDir, sub))
		if cleaned == prefix || strings.HasPrefix(cleaned, prefix+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// OverlayEnvironment computes the effective Runtime discovery/execution
// environment by applying stateDir/model-source.json over base without
// restarting the Daemon.
func OverlayEnvironment(base map[string]string, stateDir string) map[string]string {
	result := maps.Clone(base)
	if result == nil {
		result = make(map[string]string)
	}
	overlay := ReadOverlay(stateDir)
	if overlay == nil {
		return result
	}
	for _, key := range allowedOverlayEnvKeys {
		if isManagedGatewayProfilePath(stateDir, result[key]) {
			delete(result, key)
		}
	}
	if overlay.Mode == "subscription" {
		return result
	}
	if len(overlay.Environment) > 0 {
		if _, managedClaude := overlay.Environment["CLAUDE_CONFIG_DIR"]; managedClaude {
			// Claude prefers its process environment to its settings, so an endpoint
			// or key inherited from the Daemon's shell would bypass the source's profile.
			for _, name := range localworkspace.ClaudeAuthEnvironmentNames {
				delete(result, name)
			}
		}
		for key, value := range overlay.Environment {
			result[key] = value
		}
		return result
	}
	if overlay.Mode == "local" && stateDir != "" {
		piProfile := filepath.Join(stateDir, "gateway-home", ".pi", "agent")
		if info, err := os.Stat(piProfile); err == nil && info.IsDir() {
			result["PI_CODING_AGENT_DIR"] = piProfile
		}
	}
	return result
}

// OverlayRuntimePaths supplements configured Runtime executable paths with
// managed Runtimes under <home>/runtime/harness/bin or recorded in model-source.json.
func OverlayRuntimePaths(configured map[string]string, stateDir string) map[string]string {
	result := maps.Clone(configured)
	if result == nil {
		result = make(map[string]string)
	}
	if overlay := ReadOverlay(stateDir); overlay != nil {
		for rt, exe := range overlay.RuntimePaths {
			if current := result[rt]; current == "" {
				if info, err := os.Stat(exe); err == nil && info.Mode().IsRegular() {
					result[rt] = exe
				}
			}
		}
	}
	if harness := HarnessRoot(stateDir); harness != "" {
		binDir := filepath.Join(harness, "bin")
		for _, rt := range []string{"claude", "codex", "pi"} {
			if result[rt] != "" {
				continue
			}
			candidate := filepath.Join(binDir, rt)
			if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
				result[rt] = candidate
			}
		}
	}
	return result
}

// ModelSourceOptions configures a ModelSource controller.
type ModelSourceOptions struct {
	Tool          *Tool
	Environment   map[string]string
	JobDirectory  string
	HarnessRoot   string
	NodePath      string
	StatusTimeout time.Duration
	TestTimeout   time.Duration
	ApplyTimeout  time.Duration
	// OnApplied runs synchronously after Apply mutates model-source.json or
	// local models so Runtime discovery and library snapshots update before
	// Apply returns to the caller. It returns each Runtime's model catalog as
	// that discovery found it, nil when discovery failed.
	OnApplied func(context.Context) map[string][]RuntimeModelOption
}

// RuntimeModelOption is one model a Runtime offers, as Runtime discovery
// reports it.
type RuntimeModelOption struct {
	ID                     string
	AllowedReasoningEffort []string
	DefaultReasoningEffort string
	IsDefault              bool
}

// ModelSource inspects, tests and switches the Computer's active model source
// (local models, native subscriptions, or BYOK mounted on Bifrost).
type ModelSource struct {
	tool          *Tool
	environment   map[string]string
	jobDirectory  string
	harnessRoot   string
	nodePath      string
	statusTimeout time.Duration
	testTimeout   time.Duration
	applyTimeout  time.Duration
	onApplied     func(context.Context) map[string][]RuntimeModelOption
	mu            sync.Mutex
}

// NewModelSource constructs a ModelSource controller for the given localmodels Tool.
func NewModelSource(options ModelSourceOptions) *ModelSource {
	harnessRoot := options.HarnessRoot
	if harnessRoot == "" && options.Tool != nil {
		harnessRoot = HarnessRoot(options.Tool.StateDirectory)
	}
	statusTimeout := options.StatusTimeout
	if statusTimeout <= 0 {
		statusTimeout = defaultStatusTimeout
	}
	testTimeout := options.TestTimeout
	if testTimeout <= 0 {
		testTimeout = defaultByokTestTimeout
	}
	applyTimeout := options.ApplyTimeout
	if applyTimeout <= 0 {
		applyTimeout = defaultModelSourceTimeout
	}
	return &ModelSource{
		tool:          options.Tool,
		environment:   maps.Clone(options.Environment),
		jobDirectory:  options.JobDirectory,
		harnessRoot:   harnessRoot,
		nodePath:      options.NodePath,
		statusTimeout: statusTimeout,
		testTimeout:   testTimeout,
		applyTimeout:  applyTimeout,
		onApplied:     options.OnApplied,
	}
}

// byokStdinPayload sends path and endpoint even when empty: an empty one
// appends nothing, which localmodels tells apart from a missing field.
type byokStdinPayload struct {
	BaseURL       string  `json:"baseUrl"`
	Path          string  `json:"path"`
	Endpoint      string  `json:"endpoint"`
	Protocol      string  `json:"protocol"`
	APIKey        string  `json:"apiKey,omitempty"`
	ModelID       string  `json:"modelId"`
	ContextWindow *uint64 `json:"contextWindow,omitempty"`
	ReuseSavedKey *bool   `json:"reuseSavedKey,omitempty"`
}

func encodeByokStdin(input *wire.ByokConfigInput) ([]byte, error) {
	if input == nil {
		return nil, nil
	}
	return json.Marshal(byokStdinPayload{
		BaseURL:       input.BaseURL,
		Path:          input.Path,
		Endpoint:      input.Endpoint,
		Protocol:      input.Protocol,
		APIKey:        input.APIKey,
		ModelID:       input.ModelID,
		ContextWindow: input.ContextWindow,
		ReuseSavedKey: input.ReuseSavedKey,
	})
}

type sourceStatusDocument struct {
	Schema       string            `json:"schema"`
	Mode         string            `json:"mode"`
	Runtime      string            `json:"runtime"`
	RuntimeModel string            `json:"runtime_model"`
	GatewayURL   *string           `json:"gateway_url"`
	Environment  map[string]string `json:"environment"`
	RuntimePaths map[string]string `json:"runtime_paths"`
	Byok         wire.ByokSummary  `json:"byok"`
	OK           *bool             `json:"ok,omitempty"`
	Code         string            `json:"code,omitempty"`
	Message      string            `json:"message,omitempty"`
}

// Status reads the Computer's current model source and redacted BYOK summary.
func (m *ModelSource) Status(ctx context.Context) (wire.ModelSourceStatus, error) {
	if m.tool == nil || !m.tool.installed() {
		return wire.ModelSourceStatus{}, &ModelSourceError{
			Code:    CodeToolNotInstalled,
			Message: "The localmodels tool is not installed on this Computer.",
		}
	}
	runCtx, cancel := context.WithTimeout(ctx, m.statusTimeout)
	defer cancel()
	args := []string{"-P", "-s", "-m", "localmodels", "source", "status", "--base-dir", m.tool.BaseDirectory, "--json"}
	if m.harnessRoot != "" {
		args = append(args, "--harness-root", m.harnessRoot)
	}
	stdout, exitCode, err := m.runTool(runCtx, "source_status", args, nil)
	if err != nil {
		return wire.ModelSourceStatus{}, &ModelSourceError{
			Code:      CodeToolFailed,
			Message:   "Could not read model source status on this Computer.",
			Retryable: true,
		}
	}
	if exitCode != 0 {
		if unsupported := unsupportedSourceCommand(exitCode, stdout); unsupported != nil {
			return wire.ModelSourceStatus{}, unsupported
		}
		return wire.ModelSourceStatus{}, parseToolFailure(stdout, CodeToolFailed, "Could not read model source status on this Computer.")
	}
	return parseSourceStatus(stdout)
}

// TestByok sends one request to the BYOK endpoint's address in its wire
// format, without persisting credentials or mutating the active model source.
func (m *ModelSource) TestByok(ctx context.Context, input wire.ByokConfigInput) (wire.ByokTestResult, error) {
	var doc struct {
		Protocol      string `json:"protocol"`
		URL           string `json:"url"`
		ModelID       string `json:"model_id"`
		ContextWindow uint64 `json:"context_window"`
	}
	if err := m.runEndpointCommand(ctx, input, modelSourceCheckSchema, &doc, "check"); err != nil {
		return wire.ByokTestResult{}, err
	}
	return wire.ByokTestResult{
		Ok:            true,
		Protocol:      doc.Protocol,
		URL:           doc.URL,
		ModelID:       doc.ModelID,
		ContextWindow: doc.ContextWindow,
	}, nil
}

// ListByokModels lists the models a BYOK endpoint serves without persisting
// credentials.
func (m *ModelSource) ListByokModels(ctx context.Context, input wire.ByokConfigInput) (wire.ByokModelList, error) {
	var list wire.ByokModelList
	if err := m.runEndpointCommand(ctx, input, modelSourceModelsSchema, &list, "models"); err != nil {
		return wire.ByokModelList{}, err
	}
	return list, nil
}

// runEndpointCommand runs a read-only `localmodels source` command against a
// BYOK endpoint, its API key on stdin, and decodes its document into result.
func (m *ModelSource) runEndpointCommand(ctx context.Context, input wire.ByokConfigInput, schema string, result any, verb string, flags ...string) error {
	if m.tool == nil || !m.tool.installed() {
		return &ModelSourceError{
			Code:    CodeToolNotInstalled,
			Message: "The localmodels tool is not installed on this Computer.",
		}
	}
	stdin, err := encodeByokStdin(&input)
	if err != nil {
		return &ModelSourceError{
			Code:    "BYOK_INVALID_CONFIG",
			Message: "BYOK configuration is invalid.",
		}
	}
	runCtx, cancel := context.WithTimeout(ctx, m.testTimeout)
	defer cancel()
	args := append([]string{"-P", "-s", "-m", "localmodels", "source", verb, "--config-stdin", "--json"}, flags...)
	stdout, exitCode, runErr := m.runTool(runCtx, "source_"+verb, args, stdin)
	if runErr != nil {
		return &ModelSourceError{
			Code:      "BYOK_CHECK_TIMEOUT",
			Message:   "Timed out while reaching the BYOK endpoint.",
			Retryable: true,
		}
	}
	if unsupported := unsupportedSourceCommand(exitCode, stdout); unsupported != nil {
		return unsupported
	}
	var outcome struct {
		Schema  string `json:"schema"`
		OK      bool   `json:"ok"`
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if json.Unmarshal(stdout, &outcome) != nil || (outcome.OK && json.Unmarshal(stdout, result) != nil) {
		return &ModelSourceError{
			Code:      CodeToolFailed,
			Message:   "The BYOK endpoint check returned an unreadable response.",
			Retryable: true,
		}
	}
	if exitCode != 0 || !outcome.OK || outcome.Schema != schema {
		code := outcome.Code
		if code == "" {
			code = "BYOK_CHECK_FAILED"
		}
		msg := strings.TrimSpace(outcome.Message)
		if msg == "" {
			msg = "Could not reach the BYOK endpoint."
		}
		return &ModelSourceError{
			Code:      code,
			Message:   clip(msg, 500),
			Retryable: code == "BYOK_UNREACHABLE",
		}
	}
	return nil
}

// Apply switches the Computer's active model source (unloading local models or
// mounting BYOK on Bifrost as needed) and triggers synchronous Runtime refresh.
func (m *ModelSource) Apply(ctx context.Context, apply ModelSourceApply) (wire.ModelSourceStatus, error) {
	if m.tool == nil || !m.tool.installed() {
		return wire.ModelSourceStatus{}, &ModelSourceError{
			Code:    CodeToolNotInstalled,
			Message: "The localmodels tool is not installed on this Computer.",
		}
	}
	if !slices.Contains([]string{"local", "subscription", "byok"}, apply.Mode) {
		return wire.ModelSourceStatus{}, &ModelSourceError{
			Code:    "MODEL_SOURCE_INVALID",
			Message: "Unsupported model source mode.",
		}
	}
	if apply.Runtime != "" && !slices.Contains([]string{"claude", "codex", "pi"}, apply.Runtime) {
		return wire.ModelSourceStatus{}, &ModelSourceError{
			Code:    "MODEL_SOURCE_INVALID",
			Message: "Unsupported AI runtime.",
		}
	}
	if apply.LocalModelID != "" && !ValidModelID(apply.LocalModelID) {
		return wire.ModelSourceStatus{}, &ModelSourceError{
			Code:    "MODEL_UNKNOWN",
			Message: "Invalid local model identifier.",
		}
	}
	stdin, err := encodeByokStdin(apply.Byok)
	if err != nil {
		return wire.ModelSourceStatus{}, &ModelSourceError{
			Code:    "BYOK_INVALID_CONFIG",
			Message: "BYOK configuration is invalid.",
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	runCtx, cancel := context.WithTimeout(ctx, m.applyTimeout)
	defer cancel()
	args := []string{
		"-P", "-s", "-m", "localmodels", "source", "apply",
		"--mode", apply.Mode,
		"--base-dir", m.tool.BaseDirectory,
		"--json",
	}
	if apply.Runtime != "" {
		args = append(args, "--runtime", apply.Runtime)
	}
	if apply.LocalModelID != "" {
		args = append(args, "--model", apply.LocalModelID)
	}
	if m.harnessRoot != "" {
		args = append(args, "--harness-root", m.harnessRoot)
	}
	if node := m.resolveNodePath(); node != "" {
		args = append(args, "--node", node)
	}
	if len(stdin) > 0 {
		args = append(args, "--config-stdin")
	}
	stdout, exitCode, runErr := m.runTool(runCtx, "source_apply", args, stdin)
	if runErr != nil {
		return wire.ModelSourceStatus{}, &ModelSourceError{
			Code:      CodeToolFailed,
			Message:   "Model source switch timed out or could not run on this Computer.",
			Retryable: true,
		}
	}
	if exitCode != 0 {
		if unsupported := unsupportedSourceCommand(exitCode, stdout); unsupported != nil {
			return wire.ModelSourceStatus{}, unsupported
		}
		return wire.ModelSourceStatus{}, parseToolFailure(stdout, CodeToolFailed, "Could not switch model source on this Computer.")
	}
	status, err := parseSourceStatus(stdout)
	if err != nil {
		return wire.ModelSourceStatus{}, err
	}
	// Persist runtime_paths discovered by source apply into model-source.json so
	// OverlayRuntimePaths can resolve newly installed managed runtimes immediately.
	m.persistRuntimePaths(stdout)
	var catalogs map[string][]RuntimeModelOption
	if m.onApplied != nil {
		catalogs = m.onApplied(runCtx)
	}
	status.RuntimeModel, status.ReasoningEffort = agentRuntimeModel(status.Runtime, status.RuntimeModel, catalogs[status.Runtime])
	return status, nil
}

// agentRuntimeModel picks the model the Computer's Agents run after a switch:
// the target model when the Runtime's catalog offers it, else the catalog's
// default, else its first entry. A Runtime without a catalog runs the target
// model, or its host default under the id Agent Service and TeamHub use for
// it. The effort is the model's default, else its first allowed one, because
// a model that offers efforts needs one.
func agentRuntimeModel(runtime, target string, catalog []RuntimeModelOption) (string, string) {
	if len(catalog) == 0 {
		if target != "" {
			return target, ""
		}
		return runtime + "-default", ""
	}
	index := slices.IndexFunc(catalog, func(model RuntimeModelOption) bool { return target != "" && model.ID == target })
	if index < 0 {
		index = max(0, slices.IndexFunc(catalog, func(model RuntimeModelOption) bool { return model.IsDefault }))
	}
	model := catalog[index]
	effort := resolveDefaultReasoningEffort(model.AllowedReasoningEffort, model.DefaultReasoningEffort)
	return model.ID, effort
}

func resolveDefaultReasoningEffort(allowed []string, preferred string) string {
	if len(allowed) == 0 {
		return ""
	}
	if preferred != "" && slices.Contains(allowed, preferred) {
		return preferred
	}
	for _, candidate := range []string{"medium", "low", "high"} {
		if slices.Contains(allowed, candidate) {
			return candidate
		}
	}
	for _, effort := range allowed {
		if effort != "none" {
			return effort
		}
	}
	return allowed[0]
}

func (m *ModelSource) persistRuntimePaths(stdout []byte) {
	if m.tool == nil || m.tool.StateDirectory == "" {
		return
	}
	var doc sourceStatusDocument
	if err := json.Unmarshal(stdout, &doc); err != nil || len(doc.RuntimePaths) == 0 {
		return
	}
	stateFile := filepath.Join(m.tool.StateDirectory, "model-source.json")
	raw, err := readBounded(stateFile, 64*1024)
	if err != nil {
		return
	}
	var current map[string]any
	if err := json.Unmarshal(raw, &current); err != nil {
		return
	}
	current["runtime_paths"] = doc.RuntimePaths
	encoded, err := json.MarshalIndent(current, "", "  ")
	if err != nil {
		return
	}
	tmp := stateFile + ".paths.tmp"
	if err := os.WriteFile(tmp, append(encoded, '\n'), 0o600); err != nil {
		return
	}
	_ = os.Rename(tmp, stateFile)
}

func (m *ModelSource) resolveNodePath() string {
	if m.nodePath != "" {
		return m.nodePath
	}
	if pathVal := m.environment["PATH"]; pathVal != "" {
		for _, dir := range filepath.SplitList(pathVal) {
			candidate := filepath.Join(dir, "node")
			if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
				return candidate
			}
		}
	}
	if found, err := exec.LookPath("node"); err == nil {
		return found
	}
	return ""
}

func parseSourceStatus(stdout []byte) (wire.ModelSourceStatus, error) {
	var doc sourceStatusDocument
	if err := json.Unmarshal(stdout, &doc); err != nil || doc.Schema != modelSourceStatusSchema {
		return wire.ModelSourceStatus{}, &ModelSourceError{
			Code:      CodeToolFailed,
			Message:   "Model source status output did not match its contract.",
			Retryable: true,
		}
	}
	if !slices.Contains([]string{"local", "subscription", "byok"}, doc.Mode) ||
		!slices.Contains([]string{"claude", "codex", "pi"}, doc.Runtime) {
		return wire.ModelSourceStatus{}, &ModelSourceError{
			Code:      CodeToolFailed,
			Message:   "Model source status reported an unknown mode or runtime.",
			Retryable: true,
		}
	}
	status := wire.ModelSourceStatus{
		Mode:         doc.Mode,
		Runtime:      doc.Runtime,
		RuntimeModel: doc.RuntimeModel,
		Byok:         doc.Byok,
	}
	if doc.GatewayURL != nil && *doc.GatewayURL != "" {
		status.GatewayURL = *doc.GatewayURL
	}
	return status, nil
}

// unsupportedSourceCommand detects a localmodels CLI without the source
// subcommand, which exits with CLI usage status 2 and empty stdout whereas
// structured source failures emit JSON on stdout.
func unsupportedSourceCommand(exitCode int, stdout []byte) error {
	if exitCode == 2 && len(bytes.TrimSpace(stdout)) == 0 {
		return &ModelSourceError{
			Code:      CodeModelSourceUnsupported,
			Message:   "The localmodels tool on this Computer does not support model sources.",
			Retryable: false,
		}
	}
	return nil
}

func parseToolFailure(stdout []byte, fallbackCode, fallbackMessage string) error {
	var errDoc struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Detail  string `json:"detail"`
	}
	if err := json.Unmarshal(stdout, &errDoc); err == nil {
		code := strings.TrimSpace(errDoc.Code)
		if code == "" {
			code = fallbackCode
		}
		msg := strings.TrimSpace(errDoc.Message)
		if msg == "" {
			msg = strings.TrimSpace(errDoc.Detail)
		}
		if msg == "" {
			msg = fallbackMessage
		}
		return &ModelSourceError{
			Code:      code,
			Message:   clip(msg, 500),
			Retryable: code == "BYOK_UNREACHABLE" || code == "NETWORK_UNAVAILABLE",
		}
	}
	return &ModelSourceError{Code: fallbackCode, Message: fallbackMessage, Retryable: true}
}

// runTool executes localmodels with stdout in a temporary file and stderr on
// the null device (not pipes), matching Library.runOnce so a Bifrost gateway
// child spawned by source apply survives after the CLI process exits.
func (m *ModelSource) runTool(ctx context.Context, label string, args []string, stdin []byte) ([]byte, int, error) {
	dir := m.jobDirectory
	if dir == "" {
		dir = os.TempDir()
	}
	output, _, exitCode, err := m.tool.runBuffered(ctx, m.environment, dir, "model-source", maxEventLine, args, stdin)
	if err != nil && ctx.Err() != nil {
		return nil, -1, errors.Join(fmt.Errorf("%s cancelled", label), err)
	}
	return output, exitCode, err
}
