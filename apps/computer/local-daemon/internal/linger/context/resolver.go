package lingercontext

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/clicredential"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/registration"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

type ProviderInstallation struct {
	Type           string
	ExecutablePath string
	EntryPath      string
	Environment    map[string]string
	Version        string
	// ContextWindows maps a model ID to its discovered context length in
	// tokens.
	ContextWindows map[string]int
	// DefaultModel is the model the Runtime's catalog marks as its default
	// for the signed-in account; empty when it marks none.
	DefaultModel string
	// ModelGateway marks a Runtime whose model is served through the
	// localmodels gateway (local models or BYOK). Those models have no
	// provider-hosted web search, so the Runtime's own web tools stay off and
	// the Agent searches with the TeamHub CLI.
	ModelGateway bool
	// APILink marks a Runtime that reaches its models through an API gateway
	// and key rather than a vendor subscription: the localmodels gateway or
	// one the user set up in the Runtime's own configuration. Provider-hosted
	// web search may not run there, so its Agents are told to search with the
	// TeamHub CLI. Codex and Claude reach every model through one link.
	APILink bool
}

type WorkspaceGrant struct {
	GrantID  string
	TenantID string
	Path     string
}

type RegistrationBinding struct {
	RegistrationID string
	TenantID       string
	OwnerActorID   string
	ProviderType   string
	Status         registration.Status
}

// claudeWebToolGuide names Claude's own web tools when it uses them. Claude Code
// defers their definitions behind ToolSearch, so without it the model often
// does not think to search the web, as with the Computer tools in ToolGuide.
const claudeWebToolGuide = `Web tools: WebSearch searches the web and WebFetch reads one page. They are loaded on demand: before the first call, load them with ToolSearch (query "select:WebSearch,WebFetch").`

// teamHubWebFallback follows a subscription Runtime's own web tools, which it
// is told to use first.
const teamHubWebFallback = "If that fails, `teamhub web search <query>` and `teamhub web open <url>` search the web and read pages through the search providers the user set up, or DuckDuckGo without a key."

// teamHubWebToolGuide is the web access of Pi and of a Runtime on an API link.
const teamHubWebToolGuide = "Web tools: search the web with `teamhub web search <query>` and read one page as Markdown with `teamhub web open <url>`; both call search services such as Tavily or Exa and never drive a browser; `teamhub web list` shows the search backends and which are ready. Run `teamhub web search --help` for filters. Never open a search engine's results page; search with `teamhub web search`."

// teamHubWebOverOwnTools follows teamHubWebToolGuide for a Runtime on an API
// link that still has its own web tools.
const teamHubWebOverOwnTools = "Use them instead of your built-in web search and fetch tools, which may not work through the API this model is served by."

// piWindowsPowerShellGuide tells Windows Pi Agents to use PowerShell syntax
// and file/here-string inputs that avoid Windows PowerShell 5.1 argument
// corruption.
const piWindowsPowerShellGuide = "Shell on Windows: your shell tool is `powershell` (PowerShell), not bash; do not use POSIX heredocs (`<<'EOF'`), `&&`/`||` (unsupported in Windows PowerShell 5.1), or inline `VAR=val cmd`. Windows PowerShell 5.1 strips embedded `\"` from native command arguments, breaking inline JSON and quoted text: never pass inline JSON (`--questions`, `--message`, `--item`, `--schedule`, `--arguments`, `--segments`) or strings containing `\"`, newlines, `$`, `%`, `&`, or backticks on the command line; assigning JSON to a PowerShell variable (such as `$q` or `@args`) and passing it to an inline flag is corrupted the same way. Instead pipe a PowerShell single-quoted here-string (`@'` on its own line, the text or JSON, then `'@ | teamhub ... --<name>-file -` with `'@` at column 0), or write a UTF-8 file with the `write` tool (never PowerShell `>`, `Out-File`, or `Set-Content` without `-Encoding utf8`) and pass `--<name>-file <path>`. Quote comma-separated values or use repeatable flags such as `--message-id`, since unquoted `,` splits arguments in PowerShell."

// codexWindowsPowerShellGuide tells Windows Codex Agents to avoid PowerShell
// 5.1 argument quote stripping and default ASCII stdin piping when invoking
// teamhub.
const codexWindowsPowerShellGuide = "Shell on Windows: your shell runs PowerShell, not bash; do not use POSIX heredocs (`<<'EOF'`), `&&`/`||` (unsupported in Windows PowerShell 5.1), or inline `VAR=val cmd`. Windows PowerShell 5.1 strips embedded `\"` from native command arguments and defaults piped stdin `$OutputEncoding` to ASCII, so for JSON (`--questions`, `--message`, `--item`, `--schedule`, `--arguments`, `--segments`) or text containing `\"`, newlines, non-ASCII characters, `$`, `%`, `&`, or backticks, never pass it inline or through a PowerShell variable (such as `$q` or `@args`, which is corrupted the same way) — write a UTF-8 file (never PowerShell `>`, `Out-File`, or `Set-Content` without `-Encoding utf8`) and pass `--<name>-file <path>` (or `--file <path>`). Quote comma-separated values or use repeatable flags such as `--message-id`, since unquoted `,` splits arguments in PowerShell."

// WindowsHostEnvironmentGuide describes Windows shell and Python
// conventions for Operations running on a Windows Local Computer.
const WindowsHostEnvironmentGuide = "Windows environment: prefer `python` or `py -3` over `python3`, because Windows Python and Miniconda installs often lack `python3.exe` and `python3` may hit the Microsoft Store stub (`Python was not found`). If Python is not on PATH, check `py -3` or common Miniconda/Anaconda paths such as `%USERPROFILE%\\miniconda3\\python.exe`. Avoid piping commands whose failure matters through `| head` or `| tail`, because pipes can mask non-zero exit codes."

// staticPrefixEndMarker is the internal insertion slot emitted between the
// static prefix and volatile context sections by node-services. It is consumed
// and removed by assembleResolvedInstructions so the model never sees it.
const staticPrefixEndMarker = "<!-- LINGER_STATIC_PREFIX_END -->"

func shellToolGuide(runtimeType, goos string, teamHubCLI bool) string {
	if goos != "windows" || !teamHubCLI {
		return ""
	}
	switch runtimeType {
	case "pi":
		return piWindowsPowerShellGuide
	case "codex":
		return codexWindowsPowerShellGuide
	default:
		return ""
	}
}

// webToolGuide describes the web tools an Operation has. A Runtime on a
// vendor subscription uses its own web tools first and the TeamHub CLI when
// they fail; one on an API link uses the TeamHub CLI, and on the localmodels
// gateway it has no web tools of its own. Without the TeamHub CLI only
// Claude's own tools are named.
func webToolGuide(runtimeType string, apiLink, modelGateway, teamHubCLI bool) string {
	ownTools := !modelGateway && (runtimeType == "claude" || runtimeType == "codex")
	switch {
	case !teamHubCLI && ownTools && runtimeType == "claude":
		return claudeWebToolGuide
	case !teamHubCLI:
		return ""
	case !ownTools:
		return teamHubWebToolGuide
	case apiLink:
		return teamHubWebToolGuide + " " + teamHubWebOverOwnTools
	case runtimeType == "claude":
		return claudeWebToolGuide + " Use them first. " + teamHubWebFallback
	default:
		return "Web tools: use your built-in web search first. " + teamHubWebFallback
	}
}

type ExecutionResolver struct {
	// Bound by the local launcher; never accepted from a wire request.
	ServiceCommand       []string
	TeamHubCLIBin        string
	ToolGuide            string // describes the Computer's local tools to every Operation
	HostEnvironmentGuide string // describes host OS environment caveats to every Operation
	Providers            map[string]ProviderInstallation
	ProviderLookup       func(context.Context, string) (ProviderInstallation, bool, error)
	WorkspaceGrants      map[string]WorkspaceGrant
	Registrations        map[string]RegistrationBinding
	RegistrationLookup   func(context.Context, string) (RegistrationBinding, bool, error)
	// CLICredentials finds the Agent-level TeamHub CLI credential the Daemon
	// stored. Nil leaves every Operation without a TeamHub CLI profile.
	CLICredentials CLICredentialLookup
	Views          interface {
		ValidatedView(context.Context, string, json.RawMessage) (ViewRecord, error)
	}
	// goos overrides runtime.GOOS in tests.
	goos string
}

func (r ExecutionResolver) targetOS() string {
	if r.goos != "" {
		return r.goos
	}
	return runtime.GOOS
}

// codexLocalDefaultArgs keep reasoning summaries in the rollout consumed by
// Debug History and Room transcripts. The native adapter owns memory policy.
var codexLocalDefaultArgs = []string{
	"--config", `model_reasoning_summary="auto"`,
	"--config", "hide_agent_reasoning=false",
}

func (r ExecutionResolver) Resolve(ctx context.Context, command protocol.Command, encoded json.RawMessage) (provider.OperationSpec, error) {
	if command.RegistrationID == "" || command.AssignmentRevision == 0 {
		return provider.OperationSpec{}, errors.New("Operation lacks an Agent Runtime Assignment")
	}
	binding, ok, err := r.registration(ctx, command.RegistrationID)
	if err != nil {
		return provider.OperationSpec{}, err
	}
	if !ok || binding.RegistrationID != command.RegistrationID {
		return provider.OperationSpec{}, errors.New("Operation Registration binding is unavailable")
	}
	if binding.TenantID != command.TenantID {
		return provider.OperationSpec{}, errors.New("Operation Registration tenant binding is invalid")
	}
	if binding.ProviderType != command.RuntimeType {
		return provider.OperationSpec{}, errors.New("Operation Registration provider binding is invalid")
	}
	if binding.Status != registration.StatusOnline {
		return provider.OperationSpec{}, fmt.Errorf("Operation Local Runtime Registration is %s", binding.Status)
	}
	installation, ok, err := r.provider(ctx, command.RuntimeType)
	if err != nil {
		return provider.OperationSpec{}, err
	}
	if !ok || installation.Type != command.RuntimeType || installation.ExecutablePath == "" {
		return provider.OperationSpec{}, errors.New("local Runtime installation is unavailable")
	}
	grant, ok := r.WorkspaceGrants[command.WorkspaceGrantID]
	if !ok || grant.GrantID != command.WorkspaceGrantID || grant.TenantID != command.TenantID || grant.Path == "" {
		return provider.OperationSpec{}, errors.New("local workspace grant is unavailable")
	}
	if r.Views == nil {
		return provider.OperationSpec{}, errors.New("Context View store is unavailable")
	}
	view, err := r.Views.ValidatedView(ctx, command.ExecutionContextKey, command.ContextViewRef)
	if err != nil {
		return provider.OperationSpec{}, err
	}
	workingDirectory := view.WorkspacePath
	var request semanticRequest
	if err := json.Unmarshal(encoded, &request); err != nil {
		return provider.OperationSpec{}, fmt.Errorf("decode semantic Operation request: %w", err)
	}
	if request.Runtime.Type != command.RuntimeType {
		return provider.OperationSpec{}, errors.New("semantic Runtime does not match Operation identity")
	}
	if request.Runtime.ReasoningEffort != "" && !provider.ValidRuntimeReasoningEffort(request.Runtime.ReasoningEffort) {
		return provider.OperationSpec{}, errors.New("semantic Runtime reasoning effort is invalid")
	}
	if request.Kind != "run.start" {
		return provider.OperationSpec{}, fmt.Errorf("unsupported semantic Operation kind %q", request.Kind)
	}
	resumeSessionID := request.Session.threadID()
	if resumeSessionID == "" {
		resumeSessionID = request.Session.SessionID
	}
	if request.RunContext.ResumeAfterYield && resumeSessionID == "" {
		return provider.OperationSpec{}, errors.New("a yielded Run requires its native session identity")
	}
	if command.RuntimeType == "codex" && resumeSessionID == "" && (request.Session.ThreadIDCamel == nil || *request.Session.ThreadIDCamel != "") {
		return provider.OperationSpec{}, errors.New("Codex run.start requires a retained session or an explicit first-run marker")
	}
	developerInstructions := instructionValue(request.SessionOptions.DeveloperInstructions)
	var daemonStaticGuides []string
	if command.HostAccess == "trusted" {
		daemonStaticGuides = append(daemonStaticGuides, trustedHostServiceInstructions, boundServiceInstructions(r.ServiceCommand))
	}
	if r.ToolGuide != "" {
		daemonStaticGuides = append(daemonStaticGuides, r.ToolGuide)
	}
	if r.HostEnvironmentGuide != "" {
		daemonStaticGuides = append(daemonStaticGuides, r.HostEnvironmentGuide)
	}
	cliInstalled, err := r.cliCredentialInstalled(command.TenantID, command.AgentID)
	if err != nil {
		return provider.OperationSpec{}, err
	}
	teamHubCLI := cliInstalled && r.TeamHubCLIBin != ""
	webGuide := webToolGuide(command.RuntimeType, installation.APILink, installation.ModelGateway, teamHubCLI)
	if webGuide != "" {
		daemonStaticGuides = append(daemonStaticGuides, webGuide)
	}
	if shellGuide := shellToolGuide(command.RuntimeType, r.targetOS(), teamHubCLI); shellGuide != "" {
		daemonStaticGuides = append(daemonStaticGuides, shellGuide)
	}
	resolvedBase, resolvedDeveloper, systemPrompt, baseHadMarker, devHadMarker := assembleResolvedInstructions(
		instructionValue(request.SessionOptions.BaseInstructions),
		developerInstructions,
		daemonStaticGuides,
	)
	spec := provider.OperationSpec{
		OperationKind: request.Kind, Provider: command.RuntimeType,
		ExecutablePath: installation.ExecutablePath, WorkingDirectory: workingDirectory,
		Model: request.Runtime.Model, Prompt: request.Input.Text,
		ExecutionRunRef:   strings.TrimSpace(request.RunContext.ExecutionRunRef),
		ResumeAfterYield:  request.RunContext.ResumeAfterYield,
		HumanInteractions: request.RunContext.HumanInteractions,
		PermissionReview:  request.RunContext.PermissionReview,
		StopHook:          request.RunContext.StopHook,
		TeamHubCLIBin:     r.TeamHubCLIBin,
		ThinkingLevel:     request.Runtime.ReasoningEffort,
		ContextWindow:     installation.ContextWindows[request.Runtime.Model],
		ResumeSessionID:   resumeSessionID, Environment: cloneEnvironment(installation.Environment),
		ThreadName: request.SessionOptions.ThreadName, SystemPrompt: systemPrompt,
		BaseInstructions:      request.SessionOptions.BaseInstructions,
		DeveloperInstructions: request.SessionOptions.DeveloperInstructions,
		MCPRelays:             append(json.RawMessage(nil), request.RunResources.MCPServers...),
		CodexVersion:          installation.Version,
		WithoutNativeWebTools: installation.ModelGateway,
		TenantID:              command.TenantID, OwnerActorID: binding.OwnerActorID, AgentID: command.AgentID,
	}
	if baseHadMarker {
		spec.BaseInstructions = &resolvedBase
	}
	if devHadMarker || (!baseHadMarker && len(daemonStaticGuides) > 0) {
		spec.DeveloperInstructions = &resolvedDeveloper
	}
	// The profile path is stable and depends only on the Agent-level credential,
	// so a Run's first and later provider starts see the same environment.
	configuration := filepath.Join(workingDirectory, ".teamhub", "cli", "config.json")
	if info, err := os.Lstat(configuration); err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return provider.OperationSpec{}, errors.New("TeamHub CLI configuration or installation is unavailable; upgrade Local Computer")
		}
		checked, err := openContextFile(workingDirectory, ".teamhub/cli/config.json")
		if err != nil {
			return provider.OperationSpec{}, errors.New("TeamHub CLI configuration path is invalid")
		}
		_ = checked.Close()
	} else if !errors.Is(err, os.ErrNotExist) {
		return provider.OperationSpec{}, errors.New("TeamHub CLI configuration is unavailable")
	}
	if cliInstalled {
		if r.TeamHubCLIBin == "" {
			return provider.OperationSpec{}, errors.New("TeamHub CLI configuration or installation is unavailable; upgrade Local Computer")
		}
		if spec.Environment == nil {
			spec.Environment = make(map[string]string)
		}
		spec.Environment["TEAMHUB_CONFIG"] = configuration
		spec.Environment["TEAMHUB_PROFILE"] = "runtime"
		if r.targetOS() == "windows" {
			existing, ok := lookupEnvFold(spec.Environment, "WSLENV")
			if !ok {
				existing = os.Getenv("WSLENV")
			}
			setEnvFold(spec.Environment, "WSLENV", setWSLENV(existing, "TEAMHUB_CONFIG/p", "TEAMHUB_PROFILE"))
		}
		searchPath := spec.Environment["PATH"]
		if searchPath == "" {
			searchPath = os.Getenv("PATH")
		}
		spec.Environment["PATH"] = r.TeamHubCLIBin + string(os.PathListSeparator) + searchPath
	}
	if command.RuntimeType == "codex" {
		// Local Codex records the same reasoning the Cloud Runtime does and
		// disables native automatic Memory. These are daemon defaults: per-Agent
		// custom args still win by argv order.
		spec.ExtraArgs = append(spec.ExtraArgs, codexLocalDefaultArgs...)
	}
	if spec.MCPRelays == nil {
		spec.MCPRelays = json.RawMessage(`[]`)
	}
	if views, ok := r.Views.(interface {
		SharedTaskAccess(context.Context, string, string) (provider.SharedTaskAccess, error)
	}); ok {
		var reference ViewRef
		if err := json.Unmarshal(command.ContextViewRef, &reference); err != nil {
			return provider.OperationSpec{}, err
		}
		if spec.SharedTask, err = views.SharedTaskAccess(ctx, command.ExecutionContextKey, reference.ViewDigest); err != nil {
			return provider.OperationSpec{}, err
		}
	}
	if command.RuntimeType == "claude" {
		spec.ClaudeSkillNames = authorizedClaudeSkillNames(view.View.Mappings)
	}
	spec.ContextSkillDigest = contextSkillDigest(view.View.Mappings)
	if (command.RuntimeType == "claude" || command.RuntimeType == "pi") && resumeSessionID != "" && !spec.ResumeAfterYield && !request.Session.materialized() {
		spec.CreateProviderSessionID = resumeSessionID
		spec.ResumeSessionID = ""
	}
	if spec.ResumeSessionID == "" && request.PreviousSession != nil &&
		request.PreviousSession.ProviderType != "" && request.PreviousSession.SessionID != "" {
		spec.PreviousSession = &provider.PreviousSession{
			ProviderType: request.PreviousSession.ProviderType,
			SessionID:    request.PreviousSession.SessionID,
		}
	}
	return spec, nil
}

// cliCredentialInstalled reports whether the Daemon holds the Agent's TeamHub
// CLI credential.
func (r ExecutionResolver) cliCredentialInstalled(tenantID, agentID string) (bool, error) {
	if r.CLICredentials == nil {
		return false, nil
	}
	_, err := r.CLICredentials.Lookup(tenantID, agentID)
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, clicredential.ErrNotInstalled):
		return false, nil
	default:
		return false, errors.New("TeamHub CLI credential is unavailable")
	}
}

// contextSkillDigest identifies the Skill packages the View publishes into
// the workspace, from the View's own file digests: a file a Runtime or an
// Agent writes there later does not change it.
func contextSkillDigest(mappings []Mapping) string {
	var records []string
	for _, mapping := range mappings {
		if mapping.Kind != "skills" || mapping.TargetPath != ".agents/skills" {
			continue
		}
		for _, file := range mapping.Files {
			records = append(records, fmt.Sprintf("%s\x00%s\x00%t", file.RelativePath, file.SHA256, file.Executable))
		}
	}
	slices.Sort(records)
	sum := sha256.New()
	for _, record := range records {
		_, _ = fmt.Fprintf(sum, "%d:%s\n", len(record), record)
	}
	return hex.EncodeToString(sum.Sum(nil))
}

func authorizedClaudeSkillNames(mappings []Mapping) []string {
	names := []string{}
	seen := map[string]bool{}
	for _, mapping := range mappings {
		if mapping.Kind != "skills" || mapping.TargetPath != ".agents/skills" || mapping.Access != "read_only" {
			continue
		}
		for _, file := range mapping.Files {
			parts := strings.Split(file.RelativePath, "/")
			if len(parts) == 2 && parts[1] == "SKILL.md" && parts[0] != "" && !seen[parts[0]] {
				seen[parts[0]] = true
				names = append(names, parts[0])
			}
		}
	}
	return names
}

func (r ExecutionResolver) ValidateAgentRunner(ctx context.Context, command protocol.Command, encoded json.RawMessage) error {
	if command.RegistrationID == "" || command.AssignmentRevision == 0 {
		return errors.New("Agent Runner lacks an Agent Runtime Assignment")
	}
	binding, ok, err := r.registration(ctx, command.RegistrationID)
	if err != nil {
		return err
	}
	if !ok || binding.TenantID != command.TenantID {
		return errors.New("Agent Runner Registration binding is invalid")
	}
	if binding.Status != registration.StatusOnline {
		return fmt.Errorf("Agent Runner Local Runtime Registration is %s", binding.Status)
	}
	var payload struct {
		Runtime struct {
			Type string `json:"type"`
		} `json:"runtime"`
		WorkspaceGrantID string `json:"workspace_grant_id"`
	}
	if err := json.Unmarshal(encoded, &payload); err != nil {
		return err
	}
	installation, ok, err := r.provider(ctx, payload.Runtime.Type)
	if err != nil {
		return err
	}
	if payload.Runtime.Type != binding.ProviderType || !ok || installation.ExecutablePath == "" {
		return errors.New("Agent Runner Runtime is unavailable")
	}
	grant, ok := r.WorkspaceGrants[payload.WorkspaceGrantID]
	if !ok || grant.TenantID != command.TenantID || grant.Path == "" {
		return errors.New("Agent Runner workspace grant is unavailable")
	}
	return nil
}

func (r ExecutionResolver) provider(ctx context.Context, runtimeType string) (ProviderInstallation, bool, error) {
	if r.ProviderLookup != nil {
		return r.ProviderLookup(ctx, runtimeType)
	}
	installation, ok := r.Providers[runtimeType]
	return installation, ok, nil
}

func (r ExecutionResolver) registration(ctx context.Context, registrationID string) (RegistrationBinding, bool, error) {
	if r.RegistrationLookup != nil {
		return r.RegistrationLookup(ctx, registrationID)
	}
	binding, ok := r.Registrations[registrationID]
	return binding, ok, nil
}

type semanticRequest struct {
	Kind    string `json:"kind"`
	Runtime struct {
		Type            string `json:"type"`
		Model           string `json:"model,omitempty"`
		ReasoningEffort string `json:"reasoning_effort,omitempty"`
	} `json:"runtime"`
	SessionOptions struct {
		ThreadName            string  `json:"thread_name"`
		BaseInstructions      *string `json:"base_instructions,omitempty"`
		DeveloperInstructions *string `json:"developer_instructions,omitempty"`
	} `json:"session_options"`
	Session         semanticSession `json:"session,omitempty"`
	PreviousSession *struct {
		ProviderType string `json:"provider_type"`
		SessionID    string `json:"session_id"`
	} `json:"previous_session,omitempty"`
	Input struct {
		Text string `json:"text,omitempty"`
	} `json:"input,omitempty"`
	RunResources struct {
		MCPServers json.RawMessage `json:"mcp_servers"`
	} `json:"run_resources,omitempty"`
	RunContext struct {
		ExecutionRunRef   string `json:"execution_run_ref,omitempty"`
		ResumeAfterYield  bool   `json:"resume_after_yield,omitempty"`
		HumanInteractions bool   `json:"human_interactions,omitempty"`
		PermissionReview  bool   `json:"permission_review,omitempty"`
		StopHook          bool   `json:"stop_hook,omitempty"`
	} `json:"run_context,omitempty"`
}

type semanticSession struct {
	ThreadID           string  `json:"thread_id,omitempty"`
	ThreadIDCamel      *string `json:"threadId,omitempty"`
	SessionID          string  `json:"session_id,omitempty"`
	SessionIDCamel     string  `json:"sessionId,omitempty"`
	Provider           string  `json:"provider,omitempty"`
	LingerMaterialized *bool   `json:"lingerMaterialized,omitempty"`
}

func (s semanticSession) threadID() string {
	threadID := ""
	if s.ThreadIDCamel != nil {
		threadID = *s.ThreadIDCamel
	}
	return firstNonEmpty(s.ThreadID, threadID, s.SessionID, s.SessionIDCamel)
}
func (s semanticSession) materialized() bool {
	return s.LingerMaterialized == nil || *s.LingerMaterialized
}

func instructionValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func joinNonEmptySections(parts ...string) string {
	nonEmpty := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			nonEmpty = append(nonEmpty, trimmed)
		}
	}
	return strings.Join(nonEmpty, "\n\n")
}

// assembleResolvedInstructions replaces staticPrefixEndMarker (in either
// developer or base instructions) with static Daemon guides and places
// per-Agent BaseInstructions before the dynamic tail when the slot is in
// developer instructions. Legacy inputs without the marker keep
// BaseInstructions first and append guides at the end.
func assembleResolvedInstructions(base, developer string, daemonStaticGuides []string) (string, string, string, bool, bool) {
	if staticPart, dynamicPart, hasMarker := strings.Cut(developer, staticPrefixEndMarker); hasMarker {
		staticSection := joinNonEmptySections(append([]string{staticPart}, daemonStaticGuides...)...)
		resolvedDeveloper := joinNonEmptySections(staticSection, dynamicPart)
		systemPrompt := joinNonEmptySections(staticSection, base, dynamicPart)
		return base, resolvedDeveloper, systemPrompt, false, true
	}
	if staticPart, dynamicPart, hasMarker := strings.Cut(base, staticPrefixEndMarker); hasMarker {
		staticSection := joinNonEmptySections(append([]string{staticPart}, daemonStaticGuides...)...)
		resolvedBase := joinNonEmptySections(staticSection, dynamicPart)
		systemPrompt := joinNonEmptySections(resolvedBase, developer)
		return resolvedBase, developer, systemPrompt, true, false
	}
	resolvedDeveloper := joinNonEmptySections(append([]string{developer}, daemonStaticGuides...)...)
	systemPrompt := joinNonEmptySections(base, resolvedDeveloper)
	return base, resolvedDeveloper, systemPrompt, false, false
}

const trustedHostServiceInstructions = "When the user asks for a local server or other process that must remain available after this turn, start it through the Computer daemon with `linger-computer daemon service start <name> -- <command> [args...]`. Do not use shell backgrounding or nohup for a persistent service because command-process containment will stop it. Use `linger-computer daemon service stop <name>` before replacing it, and verify the final localhost URL after the managed start returns."

func cloneEnvironment(input map[string]string) map[string]string {
	if len(input) == 0 {
		return nil
	}
	result := make(map[string]string, len(input))
	for key, value := range input {
		result[key] = value
	}
	return result
}

func lookupEnvFold(env map[string]string, name string) (string, bool) {
	if value, ok := env[name]; ok {
		return value, true
	}
	for key, value := range env {
		if strings.EqualFold(key, name) {
			return value, true
		}
	}
	return "", false
}

func setEnvFold(env map[string]string, name, value string) {
	for key := range env {
		if key != name && strings.EqualFold(key, name) {
			delete(env, key)
		}
	}
	env[name] = value
}

// setWSLENV replaces any existing colon-separated WSLENV entries whose
// variable names (matched case-insensitively before any '/') match entries,
// preserving unrelated entries in order and appending entries with their
// canonical names and flags.
func setWSLENV(existing string, entries ...string) string {
	replacing := make(map[string]bool, len(entries))
	for _, entry := range entries {
		name, _, _ := strings.Cut(entry, "/")
		if name != "" {
			replacing[strings.ToUpper(name)] = true
		}
	}
	var result []string
	for _, item := range strings.Split(existing, ":") {
		if item == "" {
			continue
		}
		name, _, _ := strings.Cut(item, "/")
		if name == "" || replacing[strings.ToUpper(name)] {
			continue
		}
		result = append(result, item)
	}
	seen := make(map[string]bool, len(entries))
	for _, entry := range entries {
		if entry == "" {
			continue
		}
		name, _, _ := strings.Cut(entry, "/")
		key := strings.ToUpper(name)
		if name == "" || seen[key] {
			continue
		}
		result = append(result, entry)
		seen[key] = true
	}
	return strings.Join(result, ":")
}

func boundServiceInstructions(command []string) string {
	if len(command) == 0 {
		return "No bound Computer CLI is available in this launch. Do not guess a global linger-computer installation or another Computer config. Report persistent-service management as unavailable if the task needs it."
	}
	encoded, _ := json.Marshal(command)
	return "The current Computer CLI executable and fixed arguments are " + string(encoded) + ". Append daemon service start <name> -- <command> [args...], daemon service list --json, or daemon service stop <name> to this exact argument vector. Quote arguments for the host shell. Do not invoke the bare global linger-computer launcher or choose another config. This binding contains no credential."
}
