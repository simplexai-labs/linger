package native

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	piDefaultModel   = "pi-default"
	piBaseTools      = "read,bash,edit,write,grep,find,ls"
	piChildPipeDrain = time.Second
)

type piRuntime struct{ profile Profile }

func newPiRuntime(profile Profile) Runtime { return &piRuntime{profile: profile} }

// ErrPiUnsupportedEffort reports that a requested reasoning effort is outside
// Pi's supported --thinking vocabulary.
var ErrPiUnsupportedEffort = errors.New("Pi reasoning effort is unsupported")

// piThinkingLevel maps a product effort to Pi's --thinking value. An empty
// effort leaves Pi's own level in place.
func piThinkingLevel(effort string) (string, error) {
	switch effort {
	case "":
		return "", nil
	case "none":
		return "off", nil
	case "off", "minimal", "low", "medium", "high", "xhigh", "max":
		return effort, nil
	}
	return "", fmt.Errorf("%w: %q", ErrPiUnsupportedEffort, effort)
}

// piLaunchPlan is everything Start resolved before it takes or spawns a
// process for one turn.
type piLaunchPlan struct {
	prompt     string
	spec       RunSpec
	program    string
	thinking   string
	sessionID  string
	sessionDir string
	fence      releaseFence
	shape      *piShape // nil when the process may not park
	targets    map[string]string
	canSyncMCP bool
}

func (p *piRuntime) Start(ctx context.Context, prompt string, spec RunSpec) (*Run, error) {
	spec.MCPServers = mcpNamespace(spec.MCPServers)
	if !spec.providerPrepare() && strings.TrimSpace(prompt) == "" {
		return nil, errors.New("Pi requires a non-empty prompt")
	}
	if len(spec.ComputerArgs) > 0 || len(spec.AgentArgs) > 0 {
		return nil, errors.New("managed Pi accepts no custom launch arguments")
	}
	root, err := piSessionRoot(p.profile.Env)
	if err != nil {
		return nil, err
	}
	sessionID, err := piSessionIdentity(spec)
	if err != nil {
		return nil, err
	}
	plan := piLaunchPlan{prompt: prompt, spec: spec, sessionID: sessionID, sessionDir: filepath.Join(root, sessionID)}
	plan.fence = captureReleaseFence(p.profile)
	if plan.thinking, err = piThinkingLevel(spec.Effort); err != nil {
		return nil, err
	}
	if plan.program, err = piResolveProgram(p.profile.Program); err != nil {
		return nil, err
	}
	if spec.providerPrepare() {
		return p.prestart(ctx, root, plan)
	}
	mcpShape, targets, eligible := residentMCPShape(spec.MCPServers)
	if eligible && piResidents.enabled() {
		plan.targets = targets
		plan.canSyncMCP = p.canSyncMCP()
		plan.shape, err = piShapeFor(plan.program, p.args(plan, piInstructionsName, len(targets) > 0 || plan.canSyncMCP), p.profile, spec, mcpShape)
		if err != nil {
			return nil, err
		}
		proc, adopted, err := piResidents.take(plan.sessionDir, piMismatch(plan.shape, spec), p.profile.Logger, spec.Readiness)
		if err != nil {
			return nil, err
		}
		if proc != nil {
			run, stale, err := p.reuse(ctx, proc, plan, adopted)
			if err != nil || !stale {
				return run, err
			}
		}
	}
	// A stale or unconfirmed process on this session goes before the lock
	// is contended, so it never blocks the run and never doubles up.
	if err := piResidents.stopKey(plan.sessionDir, p.profile.Logger, spec.Readiness); err != nil {
		return nil, err
	}
	if _, err := piSessionFolder(root, sessionID); err != nil {
		return nil, err
	}
	lock, err := piLockSession(plan.sessionDir)
	if err != nil {
		return nil, err
	}
	if spec.ResumeID != "" {
		if err := piValidateSession(plan.sessionDir, sessionID, spec.Dir); err != nil {
			piReleaseLock(lock)
			return nil, err
		}
	}
	return p.spawn(ctx, plan, lock)
}

// reuse runs a turn on a process taken from the table. stale means the
// probe or MCP attachment refused the process and the caller spawns instead.
func (p *piRuntime) reuse(ctx context.Context, proc *piProcess, plan piLaunchPlan, adopted bool) (run *Run, stale bool, err error) {
	runCtx, cancel := budgetContext(ctx, plan.spec.Budget)
	proc.mu.Lock()
	validateTranscript := !(adopted && proc.prestartCreated)
	proc.mu.Unlock()
	probeCtx, probeCancel := context.WithTimeout(runCtx, piProbeBudget)
	err = proc.probeIdleWithTranscript(probeCtx, validateTranscript)
	probeCancel()
	if err != nil {
		cancel()
		if ctx.Err() == nil {
			piResidents.note(proc.res.loggerOr(p.profile.Logger), proc, "recycled", "stale", nil, false)
			plan.spec.Readiness.recycled("stale", nil)
		}
		if !piResidents.retire(proc) {
			return nil, false, errResidentRecycleUnconfirmed
		}
		if ctx.Err() != nil {
			return nil, false, ctx.Err()
		}
		return nil, true, nil
	}
	if proc.shape == nil || proc.shape.mcp != plan.shape.mcp {
		attachCtx, attachCancel := context.WithTimeout(runCtx, piAttachBudget)
		err = p.attach(attachCtx, proc, plan)
		attachCancel()
		if err != nil {
			cancel()
			if ctx.Err() == nil {
				if p.profile.Logger != nil {
					p.profile.Logger.Warn("Pi process attachment failed", "pid", proc.pid, "adopted", adopted, "error", err)
				}
				piResidents.note(proc.res.loggerOr(p.profile.Logger), proc, "recycled", "attach_failed", nil, false)
				plan.spec.Readiness.recycled("attach_failed", nil)
			}
			if !piResidents.retire(proc) {
				return nil, false, errResidentRecycleUnconfirmed
			}
			if ctx.Err() != nil {
				return nil, false, ctx.Err()
			}
			return nil, true, nil
		}
	} else if proc.front != nil {
		if err := proc.front.Bind(plan.targets); err != nil {
			cancel()
			piResidents.retire(proc)
			return nil, false, err
		}
	}
	proc.mu.Lock()
	proc.prestartCreated = false
	proc.mu.Unlock()
	fail := func(err error) (*Run, bool, error) {
		cancel()
		piResidents.retire(proc)
		return nil, false, err
	}
	turn := newPiTurn(runCtx, cancel, proc, true, plan.fence, p.profile.Logger)
	turn.readiness = plan.spec.Readiness
	turn.reviewer, turn.dir = plan.spec.PermissionReviewer, plan.spec.Dir
	turn.stopHook = plan.spec.StopHook
	if err := proc.bind(turn); err != nil {
		return fail(err)
	}
	go turn.drive(plan.prompt)
	return turn.run(), false, nil
}

// launchProcess starts one Pi RPC child for plan. lock is already held;
// until the process launches, every failure releases what was acquired.
func (p *piRuntime) launchProcess(plan piLaunchPlan, lock *os.File) (*piProcess, error) {
	var (
		front       *mcpFront
		mcp         piMCPWiring
		releaseTemp func() error
		launched    bool
	)
	defer func() {
		if launched {
			return
		}
		front.Close()
		mcp.remove()
		if releaseTemp != nil {
			_ = releaseTemp()
		}
		piReleaseLock(lock)
	}()
	spec := plan.spec
	instructions := ""
	if spec.SystemPrompt != "" {
		instructions = filepath.Join(plan.sessionDir, piInstructionsName)
		if err := piWritePrivate(instructions, []byte(spec.SystemPrompt)); err != nil {
			return nil, fmt.Errorf("Pi instructions could not be written: %w", err)
		}
	}
	config := spec.MCPServers
	if plan.shape != nil && len(plan.targets) > 0 {
		var err error
		if front, err = newMCPFront(); err != nil {
			return nil, fmt.Errorf("Pi MCP front could not start: %w", err)
		}
		if err := front.Bind(plan.targets); err != nil {
			return nil, err
		}
		if config, err = front.Rewrite(config); err != nil {
			return nil, err
		}
	}
	var err error
	if mcp, err = piPrepareMCP(config, p.profile.ManagedMCPExtension, plan.sessionDir); err != nil {
		return nil, err
	}
	if !mcp.wired() && plan.canSyncMCP {
		if mcp, err = piPrepareEmptyMCP(p.profile.ManagedMCPExtension, plan.sessionDir); err != nil {
			return nil, err
		}
	}
	if spec.PermissionReviewer != nil {
		if err := piCheckExtension(p.profile.ManagedMCPExtension); err != nil {
			return nil, err
		}
	}
	// The session flags sit right after "--mode rpc".
	tail := p.args(plan, instructions, mcp.wired())
	args := append([]string{tail[0], tail[1], "--session-dir", plan.sessionDir, "--session-id", plan.sessionID}, tail[2:]...)
	env := make(map[string]string, len(p.profile.Env)+4)
	for key, value := range p.profile.Env {
		env[key] = value
	}
	if mcp.wired() {
		env[piMCPConfigEnvKey] = mcp.configPath
	}
	if extension := p.extensionPath(spec, mcp.wired()); extension != "" {
		piExtensionNodePath(env, extension)
	}
	if p.guardsShellText(spec) {
		env[piShellTextHookEnvKey] = spec.ShellTextHook
	}
	if spec.ContextWindow > 0 {
		env[piContextWindowEnvKey] = strconv.Itoa(spec.ContextWindow)
	}
	if p.profile.RetainProcessTemp != nil {
		if releaseTemp, err = p.profile.RetainProcessTemp(); err != nil {
			return nil, fmt.Errorf("Pi process temp directory could not be retained: %w", err)
		}
	}
	procCtx, procCancel := context.WithCancel(context.Background())
	cmd := ownedCommand(procCtx, profileInvocation(plan.program, nil, env), args...)
	cmd.Dir = spec.Dir
	cmd.WaitDelay = piChildPipeDrain
	proc, err := piLaunch(p.profile, cmd)
	if err != nil {
		procCancel()
		return nil, err
	}
	launched = true
	proc.cancel = procCancel
	proc.sessionID, proc.sessionDir, proc.contextDir = plan.sessionID, plan.sessionDir, spec.Dir
	proc.shape, proc.lock, proc.mcp, proc.front, proc.releaseTemp = plan.shape, lock, mcp, front, releaseTemp
	proc.canSyncMCP = plan.canSyncMCP
	proc.res.bind(plan.sessionDir, p.profile)
	return proc, nil
}

// spawn launches a fresh Pi process for the turn. lock is already held;
// until the process runs, every failure releases what was acquired.
func (p *piRuntime) spawn(ctx context.Context, plan piLaunchPlan, lock *os.File) (*Run, error) {
	proc, err := p.launchProcess(plan, lock)
	if err != nil {
		return nil, err
	}
	spec := plan.spec
	runCtx, cancel := budgetContext(ctx, spec.Budget)
	turn := newPiTurn(runCtx, cancel, proc, false, plan.fence, p.profile.Logger)
	turn.requestedThinking = plan.thinking
	turn.readiness = plan.spec.Readiness
	turn.reviewer, turn.dir = spec.PermissionReviewer, spec.Dir
	turn.stopHook = plan.spec.StopHook
	spec.Readiness.spawned()
	spec.Readiness.session(spec.ResumeID != "")
	_ = proc.bind(turn)
	turn.timing("pi.process_spawned", "pid", proc.pid)
	proc.run()
	go turn.drive(plan.prompt)
	return turn.run(), nil
}

// args is the launch argv after the session flags: "--mode rpc", the
// resource policy, then the per-turn options. instructions is the
// instruction path, or empty when there are none.
func (p *piRuntime) args(plan piLaunchPlan, instructions string, wired bool) []string {
	spec := plan.spec
	prompt := ""
	if spec.SystemPrompt != "" {
		prompt = instructions
	}
	args := append([]string{"--mode", "rpc"}, PiRPCResourceArgs(prompt)...)
	if spec.Model != "" && spec.Model != piDefaultModel {
		args = append(args, "--model", spec.Model)
	}
	if plan.thinking != "" {
		args = append(args, "--thinking", plan.thinking)
	}
	if spec.Title != "" {
		args = append(args, "--name", spec.Title)
	}
	if skills := filepath.Join(spec.Dir, ".agents", "skills"); spec.Dir != "" {
		if info, err := os.Stat(skills); err == nil && info.IsDir() {
			args = append(args, "--skill", skills)
		}
	}
	// The managed extension carries prompt hygiene, compaction bounds, shell
	// text checks, permission review (over RPC via piProcess.answerDialog),
	// and deferred MCP wiring.
	tools := piBaseTools
	if extension := p.extensionPath(spec, wired); extension != "" {
		args = append(args, "--extension", extension)
	}
	if wired {
		tools += ",tool_search,mcp__*"
	}
	return append(args, "--tools", tools)
}

// canSyncMCP reports whether a resident Pi process can load the managed
// extension up front so Runs can attach or update MCP servers in place.
func (p *piRuntime) canSyncMCP() bool {
	return p.profile.ManagedMCPExtension != "" && piResidents.enabled()
}

// extensionPath is the managed extension a launch loads, or empty. A Run that
// needs MCP, review, or the shell text check requires it; otherwise it loads
// only when installed, for prompt hygiene and compaction bounds.
func (p *piRuntime) extensionPath(spec RunSpec, wired bool) string {
	if wired || spec.PermissionReviewer != nil || p.guardsShellText(spec) {
		return p.profile.ManagedMCPExtension
	}
	return piManagedExtensionPath(p.profile.ManagedMCPExtension)
}

// guardsShellText reports whether the managed extension runs the
// shell-text-hook before the Run's bash calls.
func (p *piRuntime) guardsShellText(spec RunSpec) bool {
	return spec.ShellTextHook != "" && p.profile.ManagedMCPExtension != ""
}

// piResolveProgram finds the Pi executable on the Daemon's own search path.
// The lookup error is returned unchanged.
func piResolveProgram(program string) (string, error) {
	if program == "" {
		program = "pi"
	}
	if filepath.IsAbs(program) {
		return program, nil
	}
	return exec.LookPath(program)
}
