package native

import (
	"log/slog"
	"path/filepath"
	"slices"
	"strings"

	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

// antigravityResidents keys each `agy acp` process by its Context key: parked,
// or held while its tree is not yet confirmed gone.
var antigravityResidents = newResidentTable[*acpProcess]("antigravity")

// antigravityResidentStore is the Antigravity resident table as the
// cross-provider stop functions see it.
func antigravityResidentStore() residentStore { return antigravityResidents }

// antigravityResidentKey returns the Context key for residency, or empty when
// the launch is non-resident.
func antigravityResidentKey(profile Profile) string {
	return strings.TrimSpace(profile.ContextKey)
}

// antigravityShape is what a running `agy acp` process has baked in. Only a
// process with a non-nil shape can park.
type antigravityShape struct {
	execPath    string
	cwd         string
	env         string
	auth        string
	skills      string
	agentID     string
	hookDir     string
	runtimeHome string
	mcp         string
	mcpEligible bool
}

func cleanAntigravityRuntimeHome(home string) string {
	trimmed := strings.TrimSpace(home)
	if trimmed == "" {
		return ""
	}
	return filepath.Clean(trimmed)
}

// antigravityShapeEnv drops the temp variables: reused turns inherit the
// spawning turn's temp directory, so they never decide reuse.
func antigravityShapeEnv(env []string) []string {
	out := make([]string, 0, len(env))
	for _, entry := range env {
		name, _, _ := strings.Cut(entry, "=")
		switch strings.ToUpper(name) {
		case "TMPDIR", "TMP", "TEMP":
			continue
		}
		out = append(out, entry)
	}
	return out
}

func antigravityShapeFor(program string, profile Profile, spec RunSpec, hookDir, mcpShape string, mcpEligible bool) *antigravityShape {
	return &antigravityShape{
		execPath:    program,
		cwd:         spec.Dir,
		env:         strings.Join(antigravityShapeEnv(childEnvironment(profile.Env)), "\x00"),
		auth:        localworkspace.AntigravityAuthFingerprint(profile.Env),
		skills:      profile.ResidentSkillDigest,
		agentID:     profile.AgentID,
		hookDir:     hookDir,
		runtimeHome: cleanAntigravityRuntimeHome(spec.RuntimeHome),
		mcp:         mcpShape,
		mcpEligible: mcpEligible,
	}
}

// differsBase names the launch-baked fields that keep a parked process from
// serving want, in deterministic reporting order.
func (s *antigravityShape) differsBase(want *antigravityShape) []string {
	var fields []string
	add := func(differs bool, name string) {
		if differs {
			fields = append(fields, name)
		}
	}
	add(s.execPath != want.execPath, "exec_path")
	add(s.cwd != want.cwd, "cwd")
	add(s.env != want.env, "env")
	add(s.auth != want.auth, "auth")
	add(s.skills != want.skills, "skills")
	add(s.agentID != want.agentID, "agent_id")
	add(s.hookDir != want.hookDir, "hook_dir")
	add(s.runtimeHome != want.runtimeHome, "runtime_home")
	return fields
}

// antigravityMismatch applies the Antigravity reuse rules against want for
// spec. An unbound prestart serves both repeated prepares and a first Run; a
// post-turn resident serves only the same session, MCP set, and reversible
// model/thinking state.
func antigravityMismatch(want *antigravityShape, spec RunSpec) func(*acpProcess) []string {
	return func(p *acpProcess) []string {
		if p.shape == nil || !p.caps.supportsResidency() {
			return []string{"shape"}
		}
		fields := p.shape.differsBase(want)
		if p.res.hasEpoch && p.res.epoch != antigravityResidents.currentEpoch() && !slices.Contains(fields, "auth") {
			fields = append(fields, "auth")
		}
		p.mu.Lock()
		sessionID := p.sessionID
		defaultModel := p.defaultModel
		defaultEffort := p.defaultEffort
		explicitModelSet := p.explicitModelSet
		explicitEffortSet := p.explicitEffortSet
		p.mu.Unlock()

		if p.res.isPrestart() {
			return fields
		}
		if spec.ResumeID == "" || spec.ResumeID != sessionID {
			fields = append(fields, "session")
		}
		if spec.providerPrepare() {
			return fields
		}
		if !want.mcpEligible || !p.shape.mcpEligible || p.shape.mcp != want.mcp {
			fields = append(fields, "mcp")
		}
		if (spec.Model == "" || spec.Model == antigravityDefaultModel) && explicitModelSet && defaultModel == "" {
			fields = append(fields, "model")
		}
		effectiveModel := spec.Model
		if effectiveModel == "" || effectiveModel == antigravityDefaultModel {
			effectiveModel = defaultModel
		}
		// Switching models preserves any explicit thought_level override on the
		// server, so clearing Effort can only revert in place when returning to
		// the session's initial model whose default effort was observed.
		if spec.Effort == "" && explicitEffortSet && (defaultEffort == "" || defaultModel == "" || effectiveModel != defaultModel) {
			fields = append(fields, "thinking")
		}
		return fields
	}
}

// StopParkedAntigravityResidentsForCredentials invalidates in-flight parking
// and stops every parked Antigravity resident process when Antigravity's
// authentication or installation state changes.
func StopParkedAntigravityResidentsForCredentials() error {
	_, err := antigravityResidents.invalidateAll("credentials_changed", slog.Default())
	return err
}

// StopParkedAntigravityResidentForHome stops any parked Antigravity resident
// process bound to home before its seeded credentials or settings change.
func StopParkedAntigravityResidentForHome(home string) error {
	clean := cleanAntigravityRuntimeHome(home)
	if clean == "" {
		return nil
	}
	_, err := antigravityResidents.stopWhere("credentials_changed", func(p *acpProcess) bool {
		return p.runtimeHome == clean
	}, slog.Default())
	return err
}
