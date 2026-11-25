package native

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// piResidents keys each Pi process by its session directory: parked, or
// held while its tree is not yet confirmed gone.
var piResidents = newResidentTable[*piProcess]("pi")

// piResidentStore is the Pi resident table as the cross-provider stop
// functions see it.
func piResidentStore() residentStore { return piResidents }

// piShape is what a running Pi process has baked in. Only a process with a
// shape can park.
type piShape struct {
	execPath        string
	cwd             string
	args            string
	env             string
	systemPrompt    string
	skills          string
	settings        string
	projectSettings string
	mcp             string
	contextWindow   int
}

// differs names the baked-in fields that keep a parked process from serving
// want. Values are never reported. When checkMCP is false, MCP servers are a
// Run's attachment synchronized on reuse, so they never keep a process from
// serving.
func (s *piShape) differs(want *piShape, checkMCP bool) []string {
	var fields []string
	add := func(differs bool, name string) {
		if differs {
			fields = append(fields, name)
		}
	}
	add(s.execPath != want.execPath, "exec_path")
	add(s.cwd != want.cwd, "cwd")
	add(s.args != want.args, "args")
	add(s.env != want.env, "env")
	add(s.systemPrompt != want.systemPrompt, "system_prompt")
	add(s.skills != want.skills, "skills")
	add(s.settings != want.settings, "settings")
	add(s.projectSettings != want.projectSettings, "project_settings")
	if checkMCP {
		add(s.mcp != want.mcp, "mcp")
	}
	add(s.contextWindow != want.contextWindow, "context_window")
	return fields
}

// piMismatch applies the Pi reuse rules against want for spec. A pre-start
// serves only the session it was spawned for, in the same create or resume
// mode.
func piMismatch(want *piShape, spec RunSpec) func(*piProcess) []string {
	return func(p *piProcess) []string {
		if p.shape == nil {
			return []string{"shape"}
		}
		p.mu.Lock()
		created, canSyncMCP := p.prestartCreated, p.canSyncMCP
		p.mu.Unlock()
		prestart := p.res.isPrestart()
		fields := p.shape.differs(want, !canSyncMCP)
		switch {
		case prestart && created:
			if spec.AssignSessionID != p.sessionID || spec.ResumeID != "" {
				fields = append(fields, "session")
			}
		case prestart:
			if spec.AssignSessionID != "" || spec.ResumeID != p.sessionID {
				fields = append(fields, "session")
			}
		default:
			if spec.AssignSessionID != "" {
				fields = append(fields, "create_session")
			}
			if spec.ResumeID == "" || spec.ResumeID != p.sessionID {
				fields = append(fields, "session")
			}
		}
		return fields
	}
}

// piShapeFor computes the reuse shape of a launch. args is the launch argv
// without the session flags, with the instruction path as a placeholder.
func piShapeFor(program string, args []string, profile Profile, spec RunSpec, mcpShape string) (*piShape, error) {
	project, err := piFileFingerprint(filepath.Join(spec.Dir, ".pi", "settings.json"))
	if err != nil {
		return nil, err
	}
	prompt := sha256.Sum256([]byte(spec.SystemPrompt))
	return &piShape{
		execPath:        program,
		cwd:             spec.Dir,
		args:            strings.Join(args, "\x00"),
		env:             strings.Join(piShapeEnv(childEnvironment(profile.Env)), "\x00"),
		systemPrompt:    hex.EncodeToString(prompt[:]),
		skills:          profile.ResidentSkillDigest,
		settings:        profile.PiConfigDigest,
		projectSettings: project,
		mcp:             mcpShape,
		contextWindow:   spec.ContextWindow,
	}, nil
}

// piShapeEnv drops the temp variables: reused turns inherit the spawning
// turn's temp directory, so they never decide reuse.
func piShapeEnv(env []string) []string {
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

// piFileFingerprint hashes one file; a missing file hashes as empty.
func piFileFingerprint(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("Pi project settings could not be read: %w", err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}
