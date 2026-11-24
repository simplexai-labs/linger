package localmodels

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

const (
	modelSourceSchema       = "localmodels.model-source/v1"
	modelSourceStatusSchema = "localmodels.model-source-status/v1"
	modelSourceCheckSchema  = "localmodels.byok-check/v1"
	modelSourceModelsSchema = "localmodels.byok-models/v1"

	// Leave headroom inside the Runner Gateway's 180s apply budget so the
	// Computer returns a structured MODEL_SOURCE_TIMEOUT before the gateway aborts.
	defaultModelSourceTimeout = 165 * time.Second
	// Leave headroom inside the Runner Gateway's 45s status/probe budget so the
	// Computer returns a structured timeout before the gateway aborts.
	defaultModelSourceStatusTimeout = 40 * time.Second
	defaultByokTestTimeout          = 40 * time.Second
	// Reserve 15s inside Apply's 165s budget for synchronous post-apply Runtime
	// discovery (giving `source apply` 150s) while capping discovery at 30s when
	// `source apply` finishes earlier.
	defaultOnAppliedReserve = 15 * time.Second
	defaultOnAppliedMax     = 30 * time.Second
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

func pathWithin(prefix, candidate string) bool {
	cleanPrefix := filepath.Clean(prefix)
	cleanCandidate := filepath.Clean(candidate)
	if runtime.GOOS == "windows" {
		cleanPrefix = strings.ToLower(cleanPrefix)
		cleanCandidate = strings.ToLower(cleanCandidate)
	}
	return cleanCandidate == cleanPrefix || strings.HasPrefix(cleanCandidate, cleanPrefix+string(filepath.Separator))
}

func hasManagedProfileSuffix(cleaned string, homes ...string) bool {
	matchHome := func(part string) bool {
		if runtime.GOOS == "windows" {
			return slices.ContainsFunc(homes, func(home string) bool { return strings.EqualFold(part, home) })
		}
		return slices.Contains(homes, part)
	}
	matchSegment := func(part, want string) bool {
		if runtime.GOOS == "windows" {
			return strings.EqualFold(part, want)
		}
		return part == want
	}
	parts := strings.Split(filepath.ToSlash(cleaned), "/")
	for i := range parts {
		if !matchSegment(parts[i], "localmodels") {
			continue
		}
		if i+1 < len(parts) && matchHome(parts[i+1]) {
			return true
		}
		if i+2 < len(parts) && matchSegment(parts[i+1], "tools") && matchHome(parts[i+2]) {
			return true
		}
	}
	return false
}

func isManagedProfilePath(stateDir, candidate string, homes ...string) bool {
	if candidate == "" {
		return false
	}
	cleaned := filepath.Clean(candidate)
	if stateDir != "" {
		for _, root := range []string{ToolsDirectory(stateDir), stateDir} {
			if root == "" {
				continue
			}
			for _, sub := range homes {
				if pathWithin(filepath.Join(root, sub), cleaned) {
					return true
				}
			}
		}
	}
	return hasManagedProfileSuffix(cleaned, homes...)
}

func envLookup(environment map[string]string, key string) string {
	if value, ok := environment[key]; ok {
		return strings.TrimSpace(value)
	}
	for k, value := range environment {
		if strings.EqualFold(k, key) {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

// localGatewayPiProfile resolves the existing managed gateway-home Pi profile
// shared by both localmodels tool invocations (when model-source.json exists)
// and local-mode Runtime discovery. It keeps the verified legacy profile
// while library models are loaded on that gateway. Otherwise it prefers
// tools/gateway-home, then state/gateway-home, then a managed gateway-home
// named in model-source.json (local mode) or the Daemon's base environment.
func localGatewayPiProfile(base map[string]string, stateDir string, overlay *OverlayState, legacy *legacyGateway) string {
	if legacy != nil {
		return legacy.piProfile
	}
	candidates := make([]string, 0, 4)
	if stateDir != "" {
		if toolsDir := ToolsDirectory(stateDir); toolsDir != "" {
			candidates = append(candidates, filepath.Join(toolsDir, "gateway-home", ".pi", "agent"))
		}
		candidates = append(candidates, filepath.Join(stateDir, "gateway-home", ".pi", "agent"))
	}
	if overlay != nil && overlay.Mode == "local" {
		if configured := strings.TrimSpace(overlay.Environment["PI_CODING_AGENT_DIR"]); configured != "" && filepath.IsAbs(configured) &&
			isManagedProfilePath(stateDir, configured, "gateway-home") {
			candidates = append(candidates, filepath.Clean(configured))
		}
	}
	if existing := envLookup(base, "PI_CODING_AGENT_DIR"); existing != "" && filepath.IsAbs(existing) &&
		isManagedProfilePath(stateDir, existing, "gateway-home") {
		candidates = append(candidates, filepath.Clean(existing))
	}
	for _, candidate := range candidates {
		if dirExists(candidate) {
			return candidate
		}
	}
	return ""
}

// runtimeProfileKeys names the environment variable that selects each
// Runtime's profile directory.
var runtimeProfileKeys = map[string]string{"codex": "CODEX_HOME", "claude": "CLAUDE_CONFIG_DIR", "pi": "PI_CODING_AGENT_DIR"}

// GatewayRuntime reports whether a Runtime with this effective environment
// reaches its model through the localmodels gateway, serving local models or a
// BYOK endpoint, rather than its own provider: its profile is one localmodels
// manages. Such models have no provider-hosted web search.
func GatewayRuntime(environment map[string]string, stateDir, runtimeType string) bool {
	if stateDir == "" {
		return false
	}
	key, ok := runtimeProfileKeys[runtimeType]
	return ok && isManagedProfilePath(stateDir, envLookup(environment, key), "gateway-home", "byok-home")
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
		for key, value := range result {
			if slices.ContainsFunc(allowedOverlayEnvKeys, func(allowed string) bool { return strings.EqualFold(key, allowed) }) &&
				isManagedProfilePath(stateDir, value, "byok-home") {
				delete(result, key)
			}
		}
		return result
	}
	for key, value := range result {
		if slices.ContainsFunc(allowedOverlayEnvKeys, func(allowed string) bool { return strings.EqualFold(key, allowed) }) &&
			isManagedProfilePath(stateDir, value, "gateway-home", "byok-home") {
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
			if overlay.Mode == "local" && key == "PI_CODING_AGENT_DIR" && isManagedProfilePath(stateDir, value, "byok-home") {
				continue
			}
			result[key] = value
		}
	}
	if overlay.Mode == "local" {
		legacy := legacyLoadedGateway(stateDir, base, overlay)
		if piProfile := localGatewayPiProfile(base, stateDir, overlay, legacy); piProfile != "" {
			result["PI_CODING_AGENT_DIR"] = piProfile
		}
	}
	return result
}

var managedRuntimeNames = []string{"claude", "codex", "pi"}

// OverlayRuntimePaths supplements configured Runtime executable paths with
// managed Runtimes recorded in model-source.json, under <home>/runtime/harness/bin,
// or under <home>/runtime/harness/tools/<runtime>/<version>.
func OverlayRuntimePaths(configured map[string]string, stateDir string) map[string]string {
	result := maps.Clone(configured)
	if result == nil {
		result = make(map[string]string)
	}
	if overlay := ReadOverlay(stateDir); overlay != nil {
		for rt, exe := range overlay.RuntimePaths {
			if !isExecutableFile(result[rt]) && isExecutableFile(exe) {
				result[rt] = exe
			}
		}
	}
	if harness := HarnessRoot(stateDir); harness != "" {
		for rt, exe := range discoverHarnessRuntimePaths(harness) {
			if !isExecutableFile(result[rt]) {
				result[rt] = exe
			}
		}
	}
	return result
}

func executableNames(name string) []string {
	if runtime.GOOS != "windows" || filepath.Ext(name) != "" {
		return []string{name}
	}
	return []string{name + ".exe", name + ".com", name + ".cmd", name + ".bat", name + ".ps1"}
}

func isExecutableFile(candidate string) bool {
	if candidate == "" || !filepath.IsAbs(candidate) {
		return false
	}
	info, err := os.Stat(candidate)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	return runtime.GOOS == "windows" || info.Mode().Perm()&0o111 != 0
}

func harnessExecutableInDir(dir, rt string) string {
	for _, name := range executableNames(rt) {
		candidate := filepath.Join(dir, name)
		if isExecutableFile(candidate) {
			return candidate
		}
	}
	return ""
}

func harnessToolsExecutable(harness, rt string) string {
	toolsRTDir := filepath.Join(harness, "tools", rt)
	entries, err := os.ReadDir(toolsRTDir)
	if err != nil {
		return ""
	}
	bestVersion := ""
	bestExecutable := ""
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		versionDir := filepath.Join(toolsRTDir, name)
		info, err := os.Stat(versionDir)
		if err != nil || !info.IsDir() {
			continue
		}
		candidate := harnessExecutableInDir(versionDir, rt)
		if candidate == "" {
			continue
		}
		if bestExecutable == "" || compareVersionNames(name, bestVersion) > 0 {
			bestVersion = name
			bestExecutable = candidate
		}
	}
	return bestExecutable
}

func discoverHarnessRuntimePaths(harness string) map[string]string {
	paths := make(map[string]string)
	if harness == "" {
		return paths
	}
	binDir := filepath.Join(harness, "bin")
	for _, rt := range managedRuntimeNames {
		if exe := harnessExecutableInDir(binDir, rt); exe != "" {
			paths[rt] = exe
			continue
		}
		if exe := harnessToolsExecutable(harness, rt); exe != "" {
			paths[rt] = exe
		}
	}
	return paths
}

func isASCIIAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := range len(s) {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func trimLeadingZeros(s string) string {
	trimmed := strings.TrimLeft(s, "0")
	if trimmed == "" {
		return "0"
	}
	return trimmed
}

func compareNumericTokens(a, b string) int {
	a, b = trimLeadingZeros(a), trimLeadingZeros(b)
	if len(a) != len(b) {
		return cmp.Compare(len(a), len(b))
	}
	return strings.Compare(a, b)
}

type parsedVersion struct {
	isVersion bool
	core      []string
	hasPre    bool
	pre       []string
}

func parseVersionName(raw string) parsedVersion {
	s := raw
	if idx := strings.IndexByte(s, '+'); idx >= 0 {
		s = s[:idx]
	}
	if len(s) >= 2 && (s[0] == 'v' || s[0] == 'V') && s[1] >= '0' && s[1] <= '9' {
		s = s[1:]
	}
	coreStr, preStr, hasPre := strings.Cut(s, "-")
	if hasPre && preStr == "" {
		return parsedVersion{}
	}
	parts := strings.Split(coreStr, ".")
	if len(parts) == 0 {
		return parsedVersion{}
	}
	for _, part := range parts {
		if !isASCIIAllDigits(part) {
			return parsedVersion{}
		}
	}
	var pre []string
	if hasPre {
		pre = strings.Split(preStr, ".")
	}
	return parsedVersion{isVersion: true, core: parts, hasPre: hasPre, pre: pre}
}

func splitNaturalChunks(s string) []string {
	var chunks []string
	for i := 0; i < len(s); {
		digit := s[i] >= '0' && s[i] <= '9'
		j := i + 1
		for j < len(s) && (s[j] >= '0' && s[j] <= '9') == digit {
			j++
		}
		chunks = append(chunks, s[i:j])
		i = j
	}
	return chunks
}

func compareNaturalNames(a, b string) int {
	ca, cb := splitNaturalChunks(a), splitNaturalChunks(b)
	for i := range min(len(ca), len(cb)) {
		da, db := isASCIIAllDigits(ca[i]), isASCIIAllDigits(cb[i])
		var c int
		if da && db {
			c = compareNumericTokens(ca[i], cb[i])
		} else {
			c = strings.Compare(ca[i], cb[i])
		}
		if c != 0 {
			return c
		}
	}
	if len(ca) != len(cb) {
		return cmp.Compare(len(ca), len(cb))
	}
	return strings.Compare(a, b)
}

func compareVersionNames(a, b string) int {
	va, vb := parseVersionName(a), parseVersionName(b)
	if va.isVersion != vb.isVersion {
		if va.isVersion {
			return 1
		}
		return -1
	}
	if !va.isVersion {
		return compareNaturalNames(a, b)
	}
	for i := range max(len(va.core), len(vb.core)) {
		segA, segB := "0", "0"
		if i < len(va.core) {
			segA = va.core[i]
		}
		if i < len(vb.core) {
			segB = vb.core[i]
		}
		if c := compareNumericTokens(segA, segB); c != 0 {
			return c
		}
	}
	if va.hasPre != vb.hasPre {
		if !va.hasPre {
			return 1
		}
		return -1
	}
	if va.hasPre {
		for i := range min(len(va.pre), len(vb.pre)) {
			pa, pb := va.pre[i], vb.pre[i]
			da, db := isASCIIAllDigits(pa), isASCIIAllDigits(pb)
			var c int
			switch {
			case da && db:
				c = compareNumericTokens(pa, pb)
			case da != db:
				if da {
					c = -1
				} else {
					c = 1
				}
			default:
				c = strings.Compare(pa, pb)
			}
			if c != 0 {
				return c
			}
		}
		if len(va.pre) != len(vb.pre) {
			return cmp.Compare(len(va.pre), len(vb.pre))
		}
	}
	if len(va.core) != len(vb.core) {
		return cmp.Compare(len(va.core), len(vb.core))
	}
	return strings.Compare(a, b)
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
	// remountedAt and remountErr are the last gateway remount's finish time
	// and outcome, under mu, so Runs that waited for it share its outcome.
	remountedAt time.Time
	remountErr  error
	// waiting, when set, runs once a Run has noted when it started waiting
	// for mu, so a test can release the lock after every Run waits on it.
	waiting func()
}

// NewModelSource constructs a ModelSource controller for the given localmodels Tool.
func NewModelSource(options ModelSourceOptions) *ModelSource {
	harnessRoot := options.HarnessRoot
	if harnessRoot == "" && options.Tool != nil {
		harnessRoot = HarnessRoot(options.Tool.StateDirectory)
	}
	statusTimeout := options.StatusTimeout
	if statusTimeout <= 0 {
		statusTimeout = defaultModelSourceStatusTimeout
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
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			return wire.ModelSourceStatus{}, &ModelSourceError{
				Code:      "MODEL_SOURCE_TIMEOUT",
				Message:   "Timed out reading model source status on this Computer.",
				Retryable: true,
			}
		}
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
		return wire.ModelSourceStatus{}, parseToolFailure(stdout, CodeToolFailed, "Could not read model source status on this Computer.", "")
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
		if errors.Is(runErr, context.DeadlineExceeded) || errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			return &ModelSourceError{
				Code:      "BYOK_CHECK_TIMEOUT",
				Message:   "Timed out while reaching the BYOK endpoint.",
				Retryable: true,
			}
		}
		return &ModelSourceError{
			Code:      CodeToolFailed,
			Message:   "Could not run the BYOK endpoint check on this Computer.",
			Retryable: true,
		}
	}
	if unsupported := unsupportedSourceCommand(exitCode, stdout); unsupported != nil {
		return unsupported
	}
	doc := lastJSONDocument(stdout)
	var outcome struct {
		Schema  string `json:"schema"`
		OK      bool   `json:"ok"`
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if len(doc) == 0 || json.Unmarshal(doc, &outcome) != nil || (outcome.OK && json.Unmarshal(doc, result) != nil) {
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
		return &ModelSourceError{
			Code:      code,
			Message:   sanitizeModelSourceMessage(outcome.Message, "Could not reach the BYOK endpoint.", input.APIKey),
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
	previousPaths := m.readExecutableRuntimePaths()

	applyDeadline := time.Now().Add(m.applyTimeout)
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(applyDeadline) {
		applyDeadline = ctxDeadline
	}
	toolDeadline := applyDeadline
	if m.onApplied != nil && time.Until(applyDeadline) > 2*defaultOnAppliedReserve {
		toolDeadline = applyDeadline.Add(-defaultOnAppliedReserve)
	}
	runCtx, cancel := context.WithDeadline(ctx, toolDeadline)
	defer cancel()
	args := m.applyArgs(apply.Mode, apply.Runtime, apply.LocalModelID, len(stdin) > 0)
	stdout, exitCode, runErr := m.runTool(runCtx, "source_apply", args, stdin)
	if runErr != nil {
		if errors.Is(runErr, context.DeadlineExceeded) || errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			return wire.ModelSourceStatus{}, &ModelSourceError{
				Code:      "MODEL_SOURCE_TIMEOUT",
				Message:   "Model source switch timed out on this Computer.",
				Retryable: true,
			}
		}
		return wire.ModelSourceStatus{}, &ModelSourceError{
			Code:      CodeToolFailed,
			Message:   "Could not run the model source switch on this Computer.",
			Retryable: true,
		}
	}
	if exitCode != 0 {
		if unsupported := unsupportedSourceCommand(exitCode, stdout); unsupported != nil {
			return wire.ModelSourceStatus{}, unsupported
		}
		apiKey := ""
		if apply.Byok != nil {
			apiKey = apply.Byok.APIKey
		}
		failure := parseToolFailure(stdout, CodeToolFailed, "Could not switch model source on this Computer.", apiKey)
		var msErr *ModelSourceError
		if errors.As(failure, &msErr) && (msErr.Code == "GATEWAY_REGISTRATION_FAILED" || msErr.Code == "BYOK_GATEWAY_FAILED") {
			m.tool.rotateUnownedBifrostAddr()
		}
		return wire.ModelSourceStatus{}, failure
	}
	status, err := parseSourceStatus(stdout)
	if err != nil {
		return wire.ModelSourceStatus{}, err
	}
	// Persist runtime_paths discovered by source apply into model-source.json so
	// OverlayRuntimePaths can resolve newly installed managed runtimes immediately.
	m.persistRuntimePaths(stdout, previousPaths)
	var catalogs map[string][]RuntimeModelOption
	if m.onApplied != nil {
		if remaining := time.Until(applyDeadline); remaining > 0 {
			// source apply already mutated model-source.json on disk; run Runtime
			// discovery within the remaining Apply budget without inheriting cancel.
			refreshBudget := min(m.statusTimeout, defaultOnAppliedMax, remaining)
			refreshCtx, refreshCancel := context.WithTimeout(context.WithoutCancel(ctx), refreshBudget)
			catalogs = m.onApplied(refreshCtx)
			refreshCancel()
		}
	}
	status.RuntimeModel, status.ReasoningEffort = agentRuntimeModel(status.Mode, status.Runtime, status.RuntimeModel, catalogs[status.Runtime])
	return status, nil
}

// applyArgs builds one `source apply`. Without a configuration on stdin, a
// BYOK apply mounts the configuration localmodels saved.
func (m *ModelSource) applyArgs(mode, runtime, localModelID string, configStdin bool) []string {
	args := []string{
		"-P", "-s", "-m", "localmodels", "source", "apply",
		"--mode", mode,
		"--base-dir", m.tool.BaseDirectory,
		"--json",
	}
	if runtime != "" {
		args = append(args, "--runtime", runtime)
	}
	if localModelID != "" {
		args = append(args, "--model", localModelID)
	}
	if m.harnessRoot != "" {
		args = append(args, "--harness-root", m.harnessRoot)
	}
	if node := m.resolveNodePath(); node != "" {
		args = append(args, "--node", node)
	}
	if configStdin {
		args = append(args, "--config-stdin")
	}
	return args
}

func isByokRuntimeModel(id string) bool {
	return id == "localmodels-byok" || strings.HasSuffix(id, "/localmodels-byok")
}

func isLocalRuntimeModel(id string) bool {
	return !isByokRuntimeModel(id) &&
		(strings.HasPrefix(id, "localmodels/") || strings.HasPrefix(id, "localmodels-library/"))
}

// agentRuntimeModel picks the model the Computer's Agents run after a switch:
// the target model when the Runtime's catalog offers it, else a mode-compatible
// default or catalog entry. In local mode only localmodels/ and
// localmodels-library/ models are eligible; if none exist, an empty model ID is
// returned so TeamHub refuses rather than routing Agents to a cloud model. In
// subscription mode stale localmodels-byok entries are excluded. A non-local
// Runtime without a catalog runs the target model, or its host default under
// the id Agent Service and TeamHub use for it. The effort is the model's
// default, else its first allowed one, because a model that offers efforts
// needs one.
func agentRuntimeModel(mode, runtime, target string, catalog []RuntimeModelOption) (string, string) {
	if mode == "local" {
		if !isLocalRuntimeModel(target) {
			target = ""
		}
		localCandidates := make([]RuntimeModelOption, 0, len(catalog))
		for _, model := range catalog {
			if isLocalRuntimeModel(model.ID) {
				localCandidates = append(localCandidates, model)
			}
		}
		if len(localCandidates) == 0 {
			if target != "" {
				return target, ""
			}
			return "", ""
		}
		index := slices.IndexFunc(localCandidates, func(model RuntimeModelOption) bool { return target != "" && model.ID == target })
		if index < 0 {
			index = slices.IndexFunc(localCandidates, func(model RuntimeModelOption) bool { return model.IsDefault })
		}
		if index < 0 {
			index = 0
		}
		model := localCandidates[index]
		effort := model.DefaultReasoningEffort
		if effort == "" && len(model.AllowedReasoningEffort) > 0 {
			effort = model.AllowedReasoningEffort[0]
		}
		return model.ID, effort
	}
	avoidByok := mode == "subscription"
	if avoidByok && isByokRuntimeModel(target) {
		target = ""
	}
	candidates := catalog
	if avoidByok && len(catalog) > 0 {
		filtered := make([]RuntimeModelOption, 0, len(catalog))
		for _, model := range catalog {
			if !isByokRuntimeModel(model.ID) {
				filtered = append(filtered, model)
			}
		}
		candidates = filtered
	}
	if len(candidates) == 0 {
		if target != "" {
			return target, ""
		}
		return runtime + "-default", ""
	}
	index := slices.IndexFunc(candidates, func(model RuntimeModelOption) bool { return target != "" && model.ID == target })
	if index < 0 {
		index = max(0, slices.IndexFunc(candidates, func(model RuntimeModelOption) bool { return model.IsDefault }))
	}
	model := candidates[index]
	effort := model.DefaultReasoningEffort
	if effort == "" && len(model.AllowedReasoningEffort) > 0 {
		effort = model.AllowedReasoningEffort[0]
	}
	return model.ID, effort
}

func (m *ModelSource) readExecutableRuntimePaths() map[string]string {
	if m.tool == nil || m.tool.StateDirectory == "" {
		return nil
	}
	overlay := ReadOverlay(m.tool.StateDirectory)
	if overlay == nil || len(overlay.RuntimePaths) == 0 {
		return nil
	}
	paths := make(map[string]string, len(overlay.RuntimePaths))
	for rt, exe := range overlay.RuntimePaths {
		if slices.Contains(managedRuntimeNames, rt) && isExecutableFile(exe) {
			paths[rt] = exe
		}
	}
	return paths
}

func (m *ModelSource) persistRuntimePaths(stdout []byte, previousPaths map[string]string) {
	if m.tool == nil || m.tool.StateDirectory == "" {
		return
	}
	harness := m.harnessRoot
	if harness == "" {
		harness = HarnessRoot(m.tool.StateDirectory)
	}
	outsideHarness := func(exe string) bool {
		return harness == "" || !pathWithin(harness, exe)
	}
	// Keep only paths the Daemon cannot rediscover on read (valid previous
	// executables outside the harness, plus explicit paths reported by apply);
	// OverlayRuntimePaths owns scanning <harness>/bin and tools/<rt>/<ver>.
	merged := make(map[string]string)
	for rt, exe := range previousPaths {
		if slices.Contains(managedRuntimeNames, rt) && isExecutableFile(exe) && outsideHarness(exe) {
			merged[rt] = exe
		}
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
	if existing, ok := current["runtime_paths"].(map[string]any); ok {
		for rt, val := range existing {
			exe, isStr := val.(string)
			trimmed := strings.TrimSpace(exe)
			cleaned := filepath.Clean(trimmed)
			if isStr && slices.Contains(managedRuntimeNames, rt) && isExecutableFile(cleaned) && outsideHarness(cleaned) && merged[rt] == "" {
				merged[rt] = cleaned
			}
		}
	}
	docBytes := lastJSONDocument(stdout)
	var doc sourceStatusDocument
	if len(docBytes) > 0 && json.Unmarshal(docBytes, &doc) == nil {
		for rt, exe := range doc.RuntimePaths {
			trimmed := strings.TrimSpace(exe)
			if slices.Contains(managedRuntimeNames, rt) && trimmed != "" && filepath.IsAbs(trimmed) {
				merged[rt] = filepath.Clean(trimmed)
			}
		}
	}
	if len(merged) == 0 {
		if _, hadPaths := current["runtime_paths"]; !hadPaths {
			return
		}
		delete(current, "runtime_paths")
	} else {
		current["runtime_paths"] = merged
	}
	encoded, err := json.MarshalIndent(current, "", "  ")
	if err != nil {
		return
	}
	tmp := stateFile + ".paths.tmp"
	if err := os.WriteFile(tmp, append(encoded, '\n'), 0o600); err != nil {
		return
	}
	if err := os.Rename(tmp, stateFile); err != nil {
		_ = os.Remove(tmp)
	}
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

// lastJSONDocument extracts the final JSON object from stdout, tolerating
// preceding JSONL progress events, pretty-printed multi-line JSON objects, and
// non-JSON prefix lines emitted by localmodels before the terminal document.
func lastJSONDocument(stdout []byte) []byte {
	trimmed := bytes.TrimSpace(stdout)
	if len(trimmed) == 0 {
		return nil
	}
	var last []byte
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	for {
		var raw json.RawMessage
		err := dec.Decode(&raw)
		if err == nil {
			candidate := bytes.TrimSpace(raw)
			if len(candidate) > 0 && candidate[0] == '{' {
				last = candidate
			}
			continue
		}
		if errors.Is(err, io.EOF) {
			return last
		}
		offset := int(dec.InputOffset())
		if offset >= len(trimmed) {
			return last
		}
		next := bytes.IndexByte(trimmed[offset:], '{')
		if next < 0 {
			return last
		}
		if next == 0 {
			offset++
			if offset >= len(trimmed) {
				return last
			}
			next = bytes.IndexByte(trimmed[offset:], '{')
			if next < 0 {
				return last
			}
		}
		trimmed = trimmed[offset+next:]
		dec = json.NewDecoder(bytes.NewReader(trimmed))
	}
}

func parseSourceStatus(stdout []byte) (wire.ModelSourceStatus, error) {
	docBytes := lastJSONDocument(stdout)
	var doc sourceStatusDocument
	if len(docBytes) == 0 || json.Unmarshal(docBytes, &doc) != nil || doc.Schema != modelSourceStatusSchema {
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

// sanitizeModelSourceMessage removes the submitted BYOK secret and recognizable
// credentials before an error message leaves the Computer; TeamHub owns full
// public-response scrubbing of user-home paths and URL query strings.
func sanitizeModelSourceMessage(raw, fallback, secret string) string {
	scrubbed := strings.TrimSpace(raw)
	if scrubbed == "" {
		return fallback
	}
	scrubbed = redact.Text(redactSecret(scrubbed, secret))
	cleaned := strings.Join(strings.Fields(scrubbed), " ")
	if cleaned == "" {
		return fallback
	}
	return clip(cleaned, 500)
}

func parseToolFailure(stdout []byte, fallbackCode, fallbackMessage, secret string) error {
	docBytes := lastJSONDocument(stdout)
	var errDoc struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Detail  string `json:"detail"`
		Error   string `json:"error"`
	}
	if len(docBytes) > 0 && json.Unmarshal(docBytes, &errDoc) == nil {
		code := strings.TrimSpace(errDoc.Code)
		if code == "" {
			code = fallbackCode
		}
		msg := strings.TrimSpace(errDoc.Message)
		if msg == "" {
			msg = strings.TrimSpace(errDoc.Detail)
		}
		if msg == "" {
			msg = strings.TrimSpace(errDoc.Error)
		}
		return &ModelSourceError{
			Code:      code,
			Message:   sanitizeModelSourceMessage(msg, fallbackMessage, secret),
			Retryable: code == "BYOK_UNREACHABLE" || code == "NETWORK_UNAVAILABLE" || code == "MODEL_SOURCE_TIMEOUT" || code == "BYOK_CHECK_TIMEOUT",
		}
	}
	return &ModelSourceError{Code: fallbackCode, Message: fallbackMessage, Retryable: true}
}

func redactSecret(text, secret string) string {
	trimmed := strings.TrimSpace(secret)
	if trimmed == "" || text == "" {
		return text
	}
	if secret != trimmed {
		text = strings.ReplaceAll(text, secret, "[REDACTED]")
	}
	return strings.ReplaceAll(text, trimmed, "[REDACTED]")
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
