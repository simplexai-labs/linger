package native

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
)

const (
	// antigravityDefaultModel keeps the model the account already selects.
	antigravityDefaultModel = "antigravity-default"
	antigravityEventBuffer  = 256
)

var (
	errAntigravityWake          = errors.New("Antigravity woken by user input")
	antigravityHookEndpointFunc = AntigravitySharedHookEndpoint
	antigravityBeforeWakePrompt func()
)

func antigravityHookConfig(logger *slog.Logger) (*AntigravityHookEndpoint, []string) {
	ep, err := antigravityHookEndpointFunc()
	if err != nil {
		if logger != nil {
			logger.Warn("antigravity.hook_endpoint_unavailable", "error", err)
		}
		return nil, nil
	}
	return ep, []string{"--add-dir", ep.Dir()}
}

// antigravityQuietWindow is how long a session with no open tool call must
// stay silent before a background continuation counts as finished.
// Antigravity starts the continuation about four seconds after the command
// finishes. Tests lower it.
var antigravityQuietWindow = 15 * time.Second

// antigravityBackgroundLimit bounds that wait, since a production Run has no
// budget and a background command, such as a server, may never finish.
// Tests lower it.
var antigravityBackgroundLimit = 30 * time.Minute

// antigravityRuntime manages `agy acp` processes. Residency-capable servers
// park in antigravityResidents for Room-presence pre-starts and cross-turn
// reuse; legacy servers run one-shot per Operation.
type antigravityRuntime struct{ profile Profile }

func newAntigravityRuntime(profile Profile) Runtime { return &antigravityRuntime{profile: profile} }

func antigravityResolveProgram(program string) (string, error) {
	if program == "" {
		program = "agy"
	}
	if filepath.IsAbs(program) {
		return program, nil
	}
	return exec.LookPath(program)
}

func antigravityPromptHash(prompt string) string {
	sum := sha256.Sum256([]byte(prompt))
	return hex.EncodeToString(sum[:])
}

func (r *antigravityRuntime) Start(ctx context.Context, prompt string, spec RunSpec) (*Run, error) {
	if spec.AssignSessionID != "" {
		return nil, errors.New("Antigravity names its own sessions")
	}
	if len(spec.ComputerArgs) > 0 || len(spec.AgentArgs) > 0 {
		return nil, errors.New("Antigravity accepts no custom launch arguments")
	}
	if spec.Dir == "" || !filepath.IsAbs(spec.Dir) {
		return nil, errors.New("Antigravity requires an absolute working directory")
	}
	if spec.PrepareOnly {
		if spec.WarmMCP {
			return nil, errors.New("Antigravity has no MCP prepare")
		}
		program, err := antigravityResolveProgram(r.profile.Program)
		if err != nil {
			return nil, err
		}
		return r.prestart(ctx, spec, program, antigravityResidentKey(r.profile))
	}
	if strings.TrimSpace(prompt) == "" {
		return nil, errors.New("Antigravity requires a non-empty prompt")
	}
	mcpConfig := mcpNamespace(spec.MCPServers)
	directServers, err := acpMCPServers(mcpConfig)
	if err != nil {
		return nil, err
	}
	mcpShape, targets, mcpEligible := residentMCPShape(mcpConfig)
	program, err := antigravityResolveProgram(r.profile.Program)
	if err != nil {
		return nil, err
	}
	key := antigravityResidentKey(r.profile)
	fence := captureReleaseFence(r.profile)
	epoch := antigravityResidents.currentEpoch()
	hookEP, hookArgs := antigravityHookConfig(r.profile.Logger)
	hookDir := ""
	if hookEP != nil {
		hookDir = hookEP.Dir()
	}
	wantShape := antigravityShapeFor(program, r.profile, spec, hookDir, mcpShape, mcpEligible)

	if key != "" && antigravityResidents.enabled() {
		proc, adopted, err := antigravityResidents.take(key, antigravityMismatch(wantShape, spec), r.profile.Logger, spec.Readiness)
		if err != nil {
			return nil, err
		}
		if proc != nil {
			run, stale, err := r.reuse(ctx, proc, prompt, spec, mcpConfig, directServers, targets, mcpEligible, wantShape, fence, adopted)
			if err != nil || !stale {
				return run, err
			}
		}
	}

	if err := antigravityResidents.stopKey(key, r.profile.Logger, spec.Readiness); err != nil {
		return nil, err
	}
	parkEligible := key != "" && mcpEligible && antigravityResidents.enabled()
	var front *mcpFront
	servers := directServers
	if parkEligible && len(targets) > 0 {
		if front, err = newMCPFront(); err != nil {
			return nil, fmt.Errorf("Antigravity MCP front could not start: %w", err)
		}
		if err = front.Bind(targets); err != nil {
			front.Close()
			return nil, err
		}
		rewritten, rewriteErr := front.Rewrite(mcpConfig)
		if rewriteErr != nil {
			front.Close()
			return nil, rewriteErr
		}
		if servers, err = acpMCPServers(rewritten); err != nil {
			front.Close()
			return nil, err
		}
	}
	var releaseTemp func() error
	if r.profile.RetainProcessTemp != nil {
		if releaseTemp, err = r.profile.RetainProcessTemp(); err != nil {
			front.Close()
			return nil, fmt.Errorf("Antigravity process temp directory could not be retained: %w", err)
		}
	}
	runCtx, cancel := budgetContext(ctx, spec.Budget)
	proc, err := startACP(profileInvocation(program, nil, r.profile.Env), spec.Dir, r.profile.Logger, nil, hookArgs...)
	if err != nil {
		cancel()
		front.Close()
		if releaseTemp != nil {
			_ = releaseTemp()
		}
		return nil, err
	}
	proc.res.bind(key, r.profile)
	proc.res.bindEpoch(epoch)
	proc.front = front
	proc.hookEP = hookEP
	proc.storeRoot = antigravityStoreRoot(r.profile.Env)
	proc.releaseTemp = releaseTemp
	var parkShape *antigravityShape
	if parkEligible {
		parkShape = wantShape
	}
	turn := newAntigravityTurn(runCtx, cancel, r.profile, spec, proc, false, false, fence, parkShape)
	if err := proc.bind(turn); err != nil {
		cancel()
		antigravityResidents.retire(proc)
		return nil, err
	}
	spec.Readiness.spawned()
	spec.Readiness.session(spec.ResumeID != "")
	go turn.drive(prompt, servers)
	return &Run{Events: turn.events, Outcome: turn.outcome, Steer: turn.steer}, nil
}

// reuse runs a turn on a taken resident process. stale reports that the
// process could not be reused and the caller should fall back to a cold spawn.
func (r *antigravityRuntime) reuse(
	ctx context.Context, proc *acpProcess, prompt string, spec RunSpec,
	mcpConfig json.RawMessage, directServers []any, targets map[string]string, mcpEligible bool,
	wantShape *antigravityShape, fence releaseFence, adopted bool,
) (run *Run, stale bool, err error) {
	retireStale := func() (*Run, bool, error) {
		antigravityResidents.note(proc.res.loggerOr(r.profile.Logger), proc, "recycled", "stale", nil, false)
		spec.Readiness.recycled("stale", nil)
		if !antigravityResidents.retire(proc) {
			return nil, false, errResidentRecycleUnconfirmed
		}
		return nil, true, nil
	}
	if !proc.alive() {
		return retireStale()
	}
	var servers []any
	var parkShape *antigravityShape
	if mcpEligible {
		parkShape = wantShape
	}
	if adopted {
		switch {
		case mcpEligible && len(targets) > 0:
			front, frontErr := newMCPFront()
			if frontErr != nil {
				antigravityResidents.retire(proc)
				return nil, false, fmt.Errorf("Antigravity MCP front could not start: %w", frontErr)
			}
			if bindErr := front.Bind(targets); bindErr != nil {
				front.Close()
				antigravityResidents.retire(proc)
				return nil, false, bindErr
			}
			rewritten, rewriteErr := front.Rewrite(mcpConfig)
			if rewriteErr != nil {
				front.Close()
				antigravityResidents.retire(proc)
				return nil, false, rewriteErr
			}
			servers, err = acpMCPServers(rewritten)
			if err != nil {
				front.Close()
				antigravityResidents.retire(proc)
				return nil, false, err
			}
			proc.front = front
		case mcpEligible:
			servers = []any{}
		default:
			servers = directServers
			parkShape = nil
		}
	} else {
		if len(targets) > 0 {
			if proc.front == nil {
				return retireStale()
			}
			if err := proc.front.Bind(targets); err != nil {
				antigravityResidents.retire(proc)
				return nil, false, err
			}
		}
		servers = nil
	}
	runCtx, cancel := budgetContext(ctx, spec.Budget)
	turn := newAntigravityTurn(runCtx, cancel, r.profile, spec, proc, true, adopted, fence, parkShape)
	if err := proc.bind(turn); err != nil {
		cancel()
		if !adopted {
			proc.front.Unbind()
		}
		return retireStale()
	}
	go turn.drive(prompt, servers)
	return &Run{Events: turn.events, Outcome: turn.outcome, Steer: turn.steer}, false, nil
}

func newAntigravityTurn(
	runCtx context.Context, cancel context.CancelFunc, profile Profile, spec RunSpec, proc *acpProcess,
	reused, adopted bool, fence releaseFence, parkShape *antigravityShape,
) *antigravityTurn {
	return &antigravityTurn{
		profile: profile, spec: spec, proc: proc, runCtx: runCtx, cancel: cancel,
		reused: reused, adopted: adopted, fence: fence, parkShape: parkShape,
		turnID: "antigravity-turn-" + piRandomHex(12),
		hookEP: proc.hookEP,
		events: make(chan Event, antigravityEventBuffer), outcome: make(chan Outcome, 1),
		wakeCh: make(chan struct{}, 1), done: make(chan struct{}),
		tools: map[string]BackgroundTool{}, phase: "running",
		requests: newModelRequestClock(GranularityDelta),
	}
}

type antigravitySteer struct {
	text    string
	done    chan error
	claimed bool
	once    sync.Once
}

func (s *antigravitySteer) resolve(err error) {
	s.once.Do(func() { s.done <- err })
}

type acpPromptResult struct {
	gen uint64
	raw json.RawMessage
	err error
}

// antigravityTurn is the one prompt of an Operation.
type antigravityTurn struct {
	profile    Profile
	spec       RunSpec
	proc       *acpProcess
	runCtx     context.Context
	cancel     context.CancelFunc
	reused     bool
	adopted    bool
	compaction bool
	fence      releaseFence
	parkShape  *antigravityShape
	turnID     string
	hookEP     *AntigravityHookEndpoint

	events       chan Event
	outcome      chan Outcome
	wakeCh       chan struct{}
	done         chan struct{}
	emitMu       sync.RWMutex
	eventsClosed bool
	requests     *modelRequestClock

	mu sync.Mutex
	// prompting is set once session/prompt is sent; updates before it are
	// the history session/load replays and belong to earlier turns.
	prompting bool
	// replayedPrompts counts the user prompts session/load replayed.
	replayedPrompts int
	// background is set when the turn enters background wait so the process is
	// never parked with a background continuation in flight.
	background bool
	// sawActivity records whether the prompted turn observed any reasoning,
	// tool call, or plan. Antigravity surfaces some upstream refusals as a
	// plain agent_message_chunk followed by end_turn with no usage or activity.
	sawActivity     bool
	stopHookBlocked bool
	phase           string
	ended           bool
	wokenByUser     bool
	steers          []*antigravitySteer
	unregisterHook  func()
	sessionID       string
	preTokens       *int64
	textID          string
	output          strings.Builder
	tools           map[string]BackgroundTool
	// lastUpdate is when the prompted session last reported anything.
	lastUpdate time.Time
}

func (t *antigravityTurn) unregister() {
	t.mu.Lock()
	unreg := t.unregisterHook
	t.unregisterHook = nil
	t.mu.Unlock()
	if unreg != nil {
		unreg()
	}
}

func (t *antigravityTurn) triggerWake() {
	select {
	case t.wakeCh <- struct{}{}:
	default:
	}
}

func (t *antigravityTurn) takeSteersLocked() []*antigravitySteer {
	if len(t.steers) == 0 {
		return nil
	}
	steers := t.steers
	for _, s := range steers {
		s.claimed = true
	}
	t.steers = nil
	return steers
}

func (t *antigravityTurn) rejectSteersLocked() {
	actual := ""
	for _, s := range t.steers {
		s.resolve(&SteerError{
			Effect:         "definitely_not_applied",
			Reason:         "no_active_turn",
			ExpectedTurnID: t.turnID,
			ActualTurnID:   actual,
			Message:        "Antigravity turn ended before applying the steered input",
		})
	}
	t.steers = nil
}

func (t *antigravityTurn) snapshotToolsLocked() []BackgroundTool {
	if len(t.tools) == 0 {
		return nil
	}
	tools := make([]BackgroundTool, 0, len(t.tools))
	for _, tool := range t.tools {
		tools = append(tools, tool)
	}
	sort.Slice(tools, func(i, j int) bool {
		if !tools[i].StartedAt.Equal(tools[j].StartedAt) {
			return tools[i].StartedAt.Before(tools[j].StartedAt)
		}
		return tools[i].CallID < tools[j].CallID
	})
	return tools
}

func (t *antigravityTurn) emit(event Event) {
	if t.compaction {
		return
	}
	t.emitMu.RLock()
	defer t.emitMu.RUnlock()
	if t.eventsClosed || t.runCtx.Err() != nil {
		return
	}
	select {
	case t.events <- event:
	case <-t.runCtx.Done():
	}
}

func (t *antigravityTurn) finish(outcome Outcome) {
	t.mu.Lock()
	t.ended = true
	t.rejectSteersLocked()
	t.mu.Unlock()
	t.unregister()
	close(t.done)
	t.cancel()
	t.emitMu.Lock()
	t.eventsClosed = true
	close(t.events)
	t.emitMu.Unlock()
	t.outcome <- outcome
	close(t.outcome)
}

func (t *antigravityTurn) steer(ctx context.Context, request SteerRequest) (SteerAck, error) {
	if err := ctx.Err(); err != nil {
		return SteerAck{}, err
	}
	t.mu.Lock()
	if t.ended || t.runCtx.Err() != nil || request.ExpectedTurnID != t.turnID {
		ended := t.ended
		actual := t.turnID
		if ended {
			actual = ""
		}
		t.mu.Unlock()
		reason := "no_active_turn"
		if !ended && request.ExpectedTurnID != actual {
			reason = "target_mismatch"
		}
		return SteerAck{}, &SteerError{
			Effect:         "definitely_not_applied",
			Reason:         reason,
			ExpectedTurnID: request.ExpectedTurnID,
			ActualTurnID:   actual,
			Message:        "Antigravity has no matching active turn",
		}
	}
	steer := &antigravitySteer{text: request.Input, done: make(chan error, 1)}
	t.steers = append(t.steers, steer)
	wake := t.phase == "waiting_background"
	t.mu.Unlock()
	if wake {
		t.triggerWake()
	}
	select {
	case err := <-steer.done:
		if err != nil {
			return SteerAck{}, err
		}
		return SteerAck{TurnID: t.turnID}, nil
	case <-t.done:
		select {
		case err := <-steer.done:
			if err != nil {
				return SteerAck{}, err
			}
			return SteerAck{TurnID: t.turnID}, nil
		default:
		}
		return SteerAck{}, &SteerError{
			Effect:         "definitely_not_applied",
			Reason:         "no_active_turn",
			ExpectedTurnID: request.ExpectedTurnID,
			ActualTurnID:   "",
			Message:        "Antigravity turn ended before applying the steered input",
		}
	case <-ctx.Done():
		t.mu.Lock()
		withdrawn := false
		if !steer.claimed {
			if idx := slices.Index(t.steers, steer); idx >= 0 {
				t.steers = slices.Delete(t.steers, idx, idx+1)
				withdrawn = true
			}
		}
		t.mu.Unlock()
		if withdrawn {
			return SteerAck{}, &SteerError{
				Effect:         "definitely_not_applied",
				Reason:         "no_active_turn",
				ExpectedTurnID: request.ExpectedTurnID,
				ActualTurnID:   t.turnID,
				Message:        "Antigravity steer request was cancelled before delivery",
			}
		}
		select {
		case err := <-steer.done:
			if err != nil {
				return SteerAck{}, err
			}
			return SteerAck{TurnID: t.turnID}, nil
		case <-t.done:
			return SteerAck{}, &SteerError{
				Effect:         "uncertain",
				Reason:         "transport",
				ExpectedTurnID: request.ExpectedTurnID,
				ActualTurnID:   "",
				Message:        "Antigravity steer delivery could not be confirmed",
			}
		}
	}
}

func (t *antigravityTurn) onHook(hookCtx context.Context, req AntigravityHookRequest) AntigravityHookResponse {
	t.proc.noteTranscriptPath(req)
	switch req.HookEventName {
	case "PreInvocation":
		if t.compaction {
			return AntigravityHookResponse{}
		}
		t.mu.Lock()
		if t.ended || t.runCtx.Err() != nil {
			t.mu.Unlock()
			return AntigravityHookResponse{}
		}
		emitResumed := false
		trigger := "background_continuation"
		if t.phase == "waiting_background" {
			t.phase = "running"
			if t.wokenByUser {
				trigger = "user_input"
				t.wokenByUser = false
			}
			emitResumed = true
		} else if t.wokenByUser {
			t.wokenByUser = false
		}
		steers := t.takeSteersLocked()
		t.mu.Unlock()
		if emitResumed {
			if t.profile.Logger != nil {
				t.profile.Logger.Info("antigravity.hook.background_resumed", "session_id", req.ConversationID, "trigger", trigger)
			}
			t.emit(Event{
				Kind:              EventBackgroundResumed,
				ObservedAt:        time.Now(),
				BackgroundTrigger: trigger,
			})
		}
		if len(steers) == 0 {
			return AntigravityHookResponse{}
		}
		if t.profile.Logger != nil {
			t.profile.Logger.Info("antigravity.hook.steer_injected", "session_id", req.ConversationID, "invocation_num", req.InvocationNum, "count", len(steers))
		}
		steps := make([]AntigravityInjectStep, 0, len(steers))
		for _, s := range steers {
			steps = append(steps, AntigravityInjectStep{UserMessage: s.text})
			s.resolve(nil)
		}
		return AntigravityHookResponse{InjectSteps: steps}

	case "PreToolUse":
		if t.compaction {
			return AntigravityHookResponse{Decision: "deny", Reason: "Tools are disabled during compaction."}
		}
		if t.spec.ShellTextHook != "" && runtime.GOOS != "windows" && req.ToolCall != nil {
			toolName := strings.ToLower(strings.TrimSpace(req.ToolCall.Name))
			if toolName == "" || toolName == "run_command" {
				cmd, _ := req.ToolCall.Args["CommandLine"].(string)
				if cmd == "" {
					cmd, _ = req.ToolCall.Args["command"].(string)
				}
				if cmd != "" && permission.ShellTextRewritten(cmd) {
					if t.profile.Logger != nil {
						t.profile.Logger.Info("antigravity.hook.shell_text_denied", "session_id", req.ConversationID, "tool_name", req.ToolCall.Name)
					}
					return AntigravityHookResponse{Decision: "deny", Reason: permission.ShellTextMessage}
				}
			}
		}
		return AntigravityHookResponse{Decision: "allow"}

	case "Stop":
		if t.compaction {
			return AntigravityHookResponse{}
		}
		if req.FullyIdle != nil && !*req.FullyIdle {
			t.mu.Lock()
			if t.ended || t.runCtx.Err() != nil {
				t.mu.Unlock()
				return AntigravityHookResponse{}
			}
			tools := t.snapshotToolsLocked()
			hasSteers := len(t.steers) > 0
			emitWaiting := false
			if len(tools) > 0 {
				if hasSteers {
					// Wake immediately rather than advertising background idle wait when
					// a steer is already waiting.
				} else if t.phase != "waiting_background" {
					t.phase = "waiting_background"
					t.background = true
					emitWaiting = true
				}
			}
			t.mu.Unlock()
			if len(tools) > 0 && hasSteers {
				t.triggerWake()
			} else if emitWaiting {
				if t.profile.Logger != nil {
					t.profile.Logger.Info("antigravity.hook.background_waiting", "session_id", req.ConversationID, "tool_count", len(tools))
				}
				t.emit(Event{
					Kind:            EventBackgroundWaiting,
					ObservedAt:      time.Now(),
					BackgroundTools: tools,
				})
			}
			return AntigravityHookResponse{}
		}
		t.mu.Lock()
		eligible := t.spec.StopHook != nil && !t.ended && t.runCtx.Err() == nil && len(t.tools) == 0 && len(t.steers) == 0 &&
			(req.TerminationReason == "" || req.TerminationReason == "NO_TOOL_CALL") &&
			strings.TrimSpace(req.Error) == ""
		// agy emits continuationActive: false even on re-entry, so guard
		// against repeat blocking with executionNum and local turn state too.
		stopHookActive := req.ContinuationActive || req.ExecutionNum > 0 || t.stopHookBlocked
		stopHook := t.spec.StopHook
		t.mu.Unlock()
		if !eligible {
			return AntigravityHookResponse{}
		}
		stopCtx, stopCancel := context.WithCancel(hookCtx)
		defer stopCancel()
		stopWatcher := context.AfterFunc(t.runCtx, stopCancel)
		defer stopWatcher()
		decision := stopHook(stopCtx, StopHookRequest{
			Runtime:        "antigravity",
			StopHookActive: stopHookActive,
		})
		if decision.Action == "block" {
			reason := strings.TrimSpace(decision.Reason)
			if reason != "" {
				t.mu.Lock()
				if t.ended || t.runCtx.Err() != nil {
					t.mu.Unlock()
					return AntigravityHookResponse{}
				}
				t.stopHookBlocked = true
				t.textID = ""
				t.mu.Unlock()
				if t.profile.Logger != nil {
					t.profile.Logger.Info("antigravity.hook.stop_blocked",
						"session_id", req.ConversationID,
						"execution_num", req.ExecutionNum,
						"stop_hook_active", stopHookActive,
					)
				}
				return AntigravityHookResponse{Decision: "continue", Reason: reason}
			}
		}
		return AntigravityHookResponse{}
	}
	return AntigravityHookResponse{}
}

func (t *antigravityTurn) park(outcome Outcome) bool {
	p := t.proc
	t.mu.Lock()
	clean := !t.background && len(t.tools) == 0 && t.sessionID != ""
	t.mu.Unlock()
	if outcome.Status != statusCompleted || t.runCtx.Err() != nil || !clean ||
		p.shape == nil || !p.caps.supportsResidency() || !p.alive() ||
		!antigravityResidents.enabled() {
		return false
	}
	p.mu.Lock()
	if t.runCtx.Err() != nil || p.res.isStopping() || p.turn != t {
		p.mu.Unlock()
		return false
	}
	p.turn = nil
	p.mu.Unlock()
	p.front.Unbind()
	if !antigravityResidents.park(p, t.fence, false, t.profile.Logger, t.spec.Readiness) {
		return false
	}
	t.finish(outcome)
	return true
}

func (t *antigravityTurn) drive(prompt string, servers []any) {
	outcome := t.exchange(prompt, servers)
	if status := interruptedStatus(t.runCtx); status != "" && outcome.Status != statusCompleted {
		outcome.Status, outcome.FailureCode = status, ""
		if outcome.Error == "" {
			outcome.Error = "Antigravity turn was " + status
		}
		if outcome.PublicDetail == "" {
			outcome.PublicDetail = outcome.Error
		}
	}
	t.mu.Lock()
	outcome.SessionID = t.sessionID
	t.mu.Unlock()
	if t.park(outcome) {
		return
	}
	t.proc.unbind(t)
	exitedBeforeStop := !t.proc.alive()
	confirmed := t.proc.stop()
	outcome.ExitConfirmed = confirmed
	outcome.ExitUnconfirmed = !confirmed
	if confirmed {
		antigravityResidents.forget(t.proc)
	} else {
		antigravityResidents.hold(t.proc)
	}
	if outcome.Status == statusFailed && outcome.Diagnostics.empty() && exitedBeforeStop && t.proc.cmd.ProcessState != nil {
		outcome.Diagnostics = processExitDiagnostics(t.proc.cmd.ProcessState)
	}
	t.finish(outcome)
}

// exchange opens or updates the session, applies model and thinking options,
// and runs the prompt to its stop reason.
func (t *antigravityTurn) exchange(prompt string, servers []any) Outcome {
	started := time.Now()
	conn, spec := t.proc.conn, t.spec
	failed := func(code, message string) Outcome {
		return Outcome{Status: statusFailed, FailureCode: code, Error: message, PublicDetail: message, ElapsedMs: time.Since(started).Milliseconds()}
	}
	// A resumed session is known before agy loads it, which takes seconds,
	// so the Run starts now; a new session reports its id once agy names it.
	resumed := spec.ResumeID != ""
	startedEarly := resumed && spec.ExposeTurnStarted
	if startedEarly {
		t.started(spec.ResumeID, started)
	}

	var sessionID string
	if !t.reused || t.adopted {
		var caps acpCapabilities
		if !t.reused {
			var err error
			if caps, err = acpInitialize(t.runCtx, conn); err != nil {
				return failed("protocol_incompatible", "Antigravity ACP handshake failed: "+err.Error())
			}
			t.proc.caps = caps
			if caps.supportsResidency() && t.parkShape != nil {
				t.proc.shape = t.parkShape
			}
		} else {
			caps = t.proc.caps
			spec.Readiness.session(resumed)
		}
		method := "session/new"
		if resumed {
			if caps.SessionResume {
				method = "session/resume"
			} else {
				method = "session/load"
			}
		}
		params := map[string]any{"cwd": spec.Dir, "mcpServers": servers}
		if spec.SystemPrompt != "" {
			params["_meta"] = map[string]any{"antigravity": map[string]any{"systemPrompt": map[string]any{"append": spec.SystemPrompt}}}
		}
		if resumed {
			params["sessionId"] = spec.ResumeID
		}
		raw, err := acpOpenSession(t.runCtx, conn, t.profile.Env, func() (json.RawMessage, error) {
			return conn.call(t.runCtx, method, params)
		})
		if acpNeedsAuth(err) {
			return failed("authentication_required", "Antigravity sign-in is required")
		}
		refusal := ""
		var refused *acpError
		switch {
		case resumed && errors.As(err, &refused):
			refusal = "Antigravity could not load session " + spec.ResumeID + ": " + err.Error()
		case err != nil:
			return failed("", "Antigravity "+method+" failed: "+err.Error())
		case method == "session/load":
			t.mu.Lock()
			replayed := t.replayedPrompts
			t.mu.Unlock()
			// session/load accepts an id Antigravity never stored and only the
			// prompt fails. A stored session holds at least the prompt of the
			// turn that made it, so a load that replays no prompt found no
			// session.
			if replayed == 0 {
				refusal = "Antigravity has no stored session " + spec.ResumeID
			}
		}
		if refusal != "" {
			return t.resumeRefused(failed("session_not_found", refusal))
		}
		var session acpSession
		if json.Unmarshal(raw, &session) != nil || session.SessionID == "" {
			if !resumed {
				return failed("", "Antigravity "+method+" returned no session")
			}
			session.SessionID = spec.ResumeID
		}
		sessionID = session.SessionID
		if t.adopted {
			t.proc.shape = t.parkShape
		}
		defaultModel := acpConfigValue(session.ConfigOptions, "model")
		defaultEffort := acpConfigValue(session.ConfigOptions, "thought_level")
		t.mu.Lock()
		t.sessionID = sessionID
		t.mu.Unlock()
		t.proc.mu.Lock()
		t.proc.sessionID = sessionID
		t.proc.systemPromptHash = antigravityPromptHash(spec.SystemPrompt)
		t.proc.defaultModel = defaultModel
		t.proc.defaultEffort = defaultEffort
		t.proc.appliedModel = defaultModel
		t.proc.appliedEffort = defaultEffort
		t.proc.explicitModelSet = false
		t.proc.explicitEffortSet = false
		t.proc.mu.Unlock()

		if spec.Model != "" && spec.Model != antigravityDefaultModel {
			options, err := t.configure(sessionID, "model", spec.Model)
			if err != nil {
				return failed(acpOptionFailure(err), "Antigravity model "+spec.Model+" could not be selected: "+err.Error())
			}
			t.proc.mu.Lock()
			t.proc.appliedModel = spec.Model
			t.proc.explicitModelSet = true
			t.proc.appliedEffort = acpConfigValue(options, "thought_level")
			t.proc.mu.Unlock()
		}
		if spec.Effort != "" {
			if _, err := t.configure(sessionID, "thought_level", spec.Effort); err != nil {
				return failed(acpOptionFailure(err), "Antigravity thinking level "+spec.Effort+" could not be selected: "+err.Error())
			}
			t.proc.mu.Lock()
			t.proc.appliedEffort = spec.Effort
			t.proc.explicitEffortSet = true
			t.proc.mu.Unlock()
		}
	} else {
		t.proc.mu.Lock()
		sessionID = t.proc.sessionID
		currentPromptHash := t.proc.systemPromptHash
		defaultModel := t.proc.defaultModel
		defaultEffort := t.proc.defaultEffort
		appliedModel := t.proc.appliedModel
		appliedEffort := t.proc.appliedEffort
		explicitModelSet := t.proc.explicitModelSet
		explicitEffortSet := t.proc.explicitEffortSet
		t.proc.mu.Unlock()

		wantPromptHash := antigravityPromptHash(spec.SystemPrompt)
		if wantPromptHash != currentPromptHash {
			// Passing an empty mcpServers list keeps the already-attached MCP
			// connections intact without opening duplicates.
			params := map[string]any{
				"sessionId":  sessionID,
				"cwd":        spec.Dir,
				"mcpServers": []any{},
				"_meta": map[string]any{
					"antigravity": map[string]any{
						"systemPrompt": map[string]any{"append": spec.SystemPrompt},
					},
				},
			}
			raw, err := acpOpenSession(t.runCtx, conn, t.profile.Env, func() (json.RawMessage, error) {
				return conn.call(t.runCtx, "session/resume", params)
			})
			if acpNeedsAuth(err) {
				return failed("authentication_required", "Antigravity sign-in is required")
			}
			var refused *acpError
			if errors.As(err, &refused) {
				return t.resumeRefused(failed("session_not_found", "Antigravity could not resume session "+sessionID+": "+err.Error()))
			}
			if err != nil {
				return failed("", "Antigravity session/resume failed: "+err.Error())
			}
			var session acpSession
			if json.Unmarshal(raw, &session) == nil && len(session.ConfigOptions) > 0 {
				appliedModel = acpConfigValue(session.ConfigOptions, "model")
				appliedEffort = acpConfigValue(session.ConfigOptions, "thought_level")
			}
			t.proc.mu.Lock()
			t.proc.systemPromptHash = wantPromptHash
			t.proc.appliedModel = appliedModel
			t.proc.appliedEffort = appliedEffort
			t.proc.mu.Unlock()
		}
		t.mu.Lock()
		t.sessionID = sessionID
		t.mu.Unlock()

		modelRequested := spec.Model != "" && spec.Model != antigravityDefaultModel
		targetModel := ""
		if modelRequested {
			targetModel = spec.Model
		} else if explicitModelSet {
			targetModel = defaultModel
		}
		modelChanged := false
		if targetModel != "" && targetModel != appliedModel {
			options, err := t.configure(sessionID, "model", targetModel)
			if err != nil {
				return failed(acpOptionFailure(err), "Antigravity model "+targetModel+" could not be selected: "+err.Error())
			}
			appliedModel = targetModel
			explicitModelSet = modelRequested
			modelChanged = true
			appliedEffort = acpConfigValue(options, "thought_level")
			t.proc.mu.Lock()
			t.proc.appliedModel = appliedModel
			t.proc.appliedEffort = appliedEffort
			t.proc.explicitModelSet = explicitModelSet
			t.proc.mu.Unlock()
		} else if !modelRequested && explicitModelSet {
			t.proc.mu.Lock()
			t.proc.explicitModelSet = false
			t.proc.mu.Unlock()
		}

		effortRequested := spec.Effort != ""
		targetEffort := ""
		if effortRequested {
			targetEffort = spec.Effort
		} else if explicitEffortSet {
			targetEffort = defaultEffort
		}
		if targetEffort != "" && (targetEffort != appliedEffort || modelChanged) {
			if _, err := t.configure(sessionID, "thought_level", targetEffort); err != nil {
				return failed(acpOptionFailure(err), "Antigravity thinking level "+targetEffort+" could not be selected: "+err.Error())
			}
			t.proc.mu.Lock()
			t.proc.appliedEffort = targetEffort
			t.proc.explicitEffortSet = effortRequested
			t.proc.mu.Unlock()
		} else if !effortRequested && explicitEffortSet {
			t.proc.mu.Lock()
			t.proc.explicitEffortSet = false
			t.proc.mu.Unlock()
		}
	}

	if t.hookEP != nil {
		unreg := t.hookEP.Register(sessionID, t.onHook)
		t.mu.Lock()
		t.unregisterHook = unreg
		t.mu.Unlock()
	}
	defer t.unregister()

	t.mu.Lock()
	t.prompting = true
	t.mu.Unlock()
	dispatched := time.Now()
	if !startedEarly {
		t.started(sessionID, dispatched)
	}
	modelName := spec.Model
	if modelName == "" {
		modelName = antigravityDefaultModel
	}
	totalUsage := map[string]TokenCount{}
	lastUsage := map[string]TokenCount{}
	hasUsage := false
	hasNonzeroUsage := false
	results := make(chan acpPromptResult, 8)
	var activeGen uint64 = 1
	if err := t.launchPrompt(sessionID, prompt, activeGen, results); err != nil {
		if errors.Is(err, errACPClosed) {
			return failed("", "Antigravity exited before the turn finished")
		}
		return failed("", "Antigravity session/prompt failed: "+err.Error())
	}

	var stopReason string
	for {
		var res acpPromptResult
		select {
		case res = <-results:
		case <-t.wakeCh:
			_, wakeErr := t.sendWakePrompt(sessionID, &activeGen, results)
			if wakeErr != nil {
				if errors.Is(wakeErr, errACPClosed) {
					return failed("", "Antigravity exited before the turn finished")
				}
				return failed("", "Antigravity session/prompt failed: "+wakeErr.Error())
			}
			continue
		case <-t.runCtx.Done():
			_, _ = t.cancelPrompt(sessionID)
			return failed("", "Antigravity session/prompt failed: "+t.runCtx.Err().Error())
		case <-t.proc.conn.closed:
			select {
			case res = <-results:
			default:
				return failed("", "Antigravity exited before the turn finished")
			}
		}
		if res.err != nil {
			if res.gen < activeGen {
				if errors.Is(res.err, errACPClosed) {
					return failed("", "Antigravity exited before the turn finished")
				}
				continue
			}
			if t.runCtx.Err() != nil {
				_, _ = t.cancelPrompt(sessionID)
			}
			if errors.Is(res.err, errACPClosed) {
				return failed("", "Antigravity exited before the turn finished")
			}
			return failed("", "Antigravity session/prompt failed: "+res.err.Error())
		}
		reason, gotUsage, nonzeroUsage := t.recordPromptUsage(modelName, res.raw, totalUsage, lastUsage)
		if gotUsage {
			hasUsage = true
		}
		if nonzeroUsage {
			hasNonzeroUsage = true
		}
		if res.gen < activeGen {
			continue
		}
		stopReason = reason
		if stopReason != "end_turn" {
			break
		}
		sentWakePrompt := false
		for !sentWakePrompt {
			t.mu.Lock()
			openTools := t.snapshotToolsLocked()
			hasSteers := len(t.steers) > 0
			wasWaiting := t.phase == "waiting_background"
			if len(openTools) == 0 {
				if wasWaiting {
					t.phase = "running"
				}
				t.mu.Unlock()
				if wasWaiting {
					t.emit(Event{Kind: EventBackgroundResumed, ObservedAt: time.Now(), BackgroundTrigger: "background_continuation"})
				}
				break
			}
			if hasSteers {
				t.mu.Unlock()
				sent, wakeErr := t.sendWakePrompt(sessionID, &activeGen, results)
				if wakeErr != nil {
					if errors.Is(wakeErr, errACPClosed) {
						return failed("", "Antigravity exited before the turn finished")
					}
					return failed("", "Antigravity session/prompt failed: "+wakeErr.Error())
				}
				if sent {
					sentWakePrompt = true
					break
				}
				continue
			}
			emitWaiting := !wasWaiting
			t.phase = "waiting_background"
			t.background = true
			// The continuation's text is a new message.
			t.textID = ""
			t.mu.Unlock()
			if emitWaiting {
				t.emit(Event{Kind: EventBackgroundWaiting, ObservedAt: time.Now(), BackgroundTools: openTools})
			}
			bgErr := t.awaitBackgroundOrWake()
			if errors.Is(bgErr, errAntigravityWake) {
				sent, wakeErr := t.sendWakePrompt(sessionID, &activeGen, results)
				if wakeErr != nil {
					if errors.Is(wakeErr, errACPClosed) {
						return failed("", "Antigravity exited before the turn finished")
					}
					return failed("", "Antigravity session/prompt failed: "+wakeErr.Error())
				}
				if sent {
					sentWakePrompt = true
					break
				}
				continue
			}
			if errors.Is(bgErr, errACPClosed) {
				return failed("", "Antigravity exited before the turn finished")
			}
			if bgErr != nil {
				_, _ = t.cancelPrompt(sessionID)
				stopReason = "cancelled"
				break
			}
			t.mu.Lock()
			stillWaiting := t.phase == "waiting_background"
			if stillWaiting {
				t.phase = "running"
			}
			t.mu.Unlock()
			if stillWaiting {
				t.emit(Event{Kind: EventBackgroundResumed, ObservedAt: time.Now(), BackgroundTrigger: "background_continuation"})
			}
			break
		}
		if !sentWakePrompt {
			break
		}
	}
	outcome := Outcome{ElapsedMs: time.Since(started).Milliseconds()}
	t.mu.Lock()
	// Untrimmed, as the reply Agent Service reads from the stream.
	outcome.Output = t.output.String()
	sawActivity := t.sawActivity
	t.mu.Unlock()
	if hasUsage {
		outcome.Usage = totalUsage
		outcome.LastUsage = lastUsage
	}
	switch stopReason {
	case "end_turn":
		if !hasNonzeroUsage && !sawActivity {
			outcome.Status = statusFailed
			outcome.Error = strings.TrimSpace(outcome.Output)
			if outcome.Error == "" {
				outcome.Error = "Antigravity ended the turn without a model response"
			}
			outcome.PublicDetail = outcome.Error
			outcome.Output = ""
		} else {
			outcome.Status = statusCompleted
		}
	case "cancelled":
		outcome.Status, outcome.Error = statusAborted, "Antigravity turn was cancelled"
	default:
		outcome.Status, outcome.Error = statusFailed, "Antigravity stopped the turn: "+stopReason
		outcome.PublicDetail = outcome.Error
	}
	return outcome
}

func (t *antigravityTurn) launchPrompt(sessionID, text string, gen uint64, results chan<- acpPromptResult) error {
	reply, release, err := t.proc.conn.sendRequest("session/prompt", map[string]any{
		"sessionId": sessionID,
		"prompt":    []any{map[string]any{"type": "text", "text": text}},
	})
	if err != nil {
		return err
	}
	t.requests.begin("", time.Now())
	go func() {
		raw, awaitErr := t.proc.conn.awaitReply(t.runCtx, reply, release)
		results <- acpPromptResult{gen: gen, raw: raw, err: awaitErr}
	}()
	return nil
}

func (t *antigravityTurn) sendWakePrompt(sessionID string, activeGen *uint64, results chan<- acpPromptResult) (bool, error) {
	if fn := antigravityBeforeWakePrompt; fn != nil {
		fn()
	}
	t.mu.Lock()
	steers := t.takeSteersLocked()
	if len(steers) == 0 {
		t.mu.Unlock()
		return false, nil
	}
	wasWaiting := t.phase == "waiting_background"
	t.phase = "running"
	t.wokenByUser = true
	t.textID = ""
	t.mu.Unlock()
	if wasWaiting {
		t.emit(Event{
			Kind:              EventBackgroundResumed,
			ObservedAt:        time.Now(),
			BackgroundTrigger: "user_input",
		})
	}
	parts := make([]string, 0, len(steers))
	for _, s := range steers {
		parts = append(parts, s.text)
	}
	*activeGen++
	if err := t.launchPrompt(sessionID, strings.Join(parts, "\n\n"), *activeGen, results); err != nil {
		for _, s := range steers {
			s.resolve(&SteerError{
				Effect:         "definitely_not_applied",
				Reason:         "transport",
				ExpectedTurnID: t.turnID,
				ActualTurnID:   t.turnID,
				Message:        "Antigravity prompt wake could not be sent: " + err.Error(),
			})
		}
		return false, err
	}
	for _, s := range steers {
		s.resolve(nil)
	}
	return true, nil
}

func (t *antigravityTurn) recordPromptUsage(model string, raw json.RawMessage, total, last map[string]TokenCount) (string, bool, bool) {
	var result struct {
		StopReason string             `json:"stopReason"`
		Usage      *antigravityTokens `json:"usage"`
	}
	_ = json.Unmarshal(raw, &result)
	if result.Usage == nil {
		return result.StopReason, false, false
	}
	count := result.Usage.count()
	prev := total[model]
	total[model] = TokenCount{
		Input:      prev.Input + count.Input,
		Output:     prev.Output + count.Output,
		CacheRead:  prev.CacheRead + count.CacheRead,
		CacheWrite: prev.CacheWrite + count.CacheWrite,
		Reasoning:  prev.Reasoning + count.Reasoning,
	}
	last[model] = count
	now := time.Now()
	response := t.requests.respond(ModelResponse{Model: model, Usage: count}, now)
	t.emit(Event{Kind: EventModelResponse, ObservedAt: now, Response: &response})
	return result.StopReason, true, result.Usage.nonzero()
}

// awaitBackgroundOrWake holds a turn that ended while a tool call still runs,
// waiting until all open tools finish and the session goes quiet, or until
// new user input wakes the turn via wakeCh.
func (t *antigravityTurn) awaitBackgroundOrWake() error {
	t.mu.Lock()
	open := len(t.tools) > 0
	t.mu.Unlock()
	if !open {
		return nil
	}
	if t.profile.Logger != nil {
		t.profile.Logger.Info("runtime.turn.background_wait", "provider", "antigravity")
	}
	limit := time.NewTimer(antigravityBackgroundLimit)
	defer limit.Stop()
	tick := time.NewTicker(antigravityQuietWindow / 30)
	defer tick.Stop()
	for {
		select {
		case <-t.wakeCh:
			return errAntigravityWake
		case <-t.runCtx.Done():
			return t.runCtx.Err()
		case <-t.proc.conn.closed:
			return errACPClosed
		case <-limit.C:
			if t.profile.Logger != nil {
				t.profile.Logger.Warn("runtime.turn.background_limit", "provider", "antigravity")
			}
			return nil
		case <-tick.C:
		}
		t.mu.Lock()
		settled := len(t.tools) == 0 && time.Since(t.lastUpdate) >= antigravityQuietWindow
		t.mu.Unlock()
		if settled {
			return nil
		}
	}
}

// cancelPrompt asks Antigravity to end the running prompt. The process is
// stopped right after, so the cancelled stop reason is not awaited.
func (t *antigravityTurn) cancelPrompt(sessionID string) (json.RawMessage, error) {
	_ = t.proc.conn.notify("session/cancel", map[string]any{"sessionId": sessionID})
	return nil, t.runCtx.Err()
}

func (t *antigravityTurn) configure(sessionID, option, value string) ([]acpConfigOption, error) {
	raw, err := t.proc.conn.call(t.runCtx, "session/set_config_option", map[string]any{"sessionId": sessionID, "configId": option, "value": value})
	if err != nil {
		return nil, err
	}
	var result struct {
		ConfigOptions []acpConfigOption `json:"configOptions"`
	}
	_ = json.Unmarshal(raw, &result)
	return result.ConfigOptions, nil
}

// acpOptionFailure classifies a refused model or level: Antigravity answers
// an unknown value with invalid params.
func acpOptionFailure(err error) string {
	var rpc *acpError
	if errors.As(err, &rpc) && rpc.Code == -32602 {
		return "model_not_offered"
	}
	return ""
}

type antigravityTokens struct {
	InputTokens       int64 `json:"inputTokens"`
	OutputTokens      int64 `json:"outputTokens"`
	ThoughtTokens     int64 `json:"thoughtTokens"`
	CachedReadTokens  int64 `json:"cachedReadTokens"`
	CachedWriteTokens int64 `json:"cachedWriteTokens"`
}

func (u antigravityTokens) nonzero() bool {
	return u.InputTokens > 0 || u.OutputTokens > 0 || u.ThoughtTokens > 0 || u.CachedReadTokens > 0 || u.CachedWriteTokens > 0
}

// count maps ACP usage onto TokenCount, where Input excludes cache reads and
// writes and Reasoning is part of Output.
func (u antigravityTokens) count() TokenCount {
	return TokenCount{
		Input:      max(u.InputTokens-u.CachedReadTokens-u.CachedWriteTokens, 0),
		Output:     u.OutputTokens + u.ThoughtTokens,
		CacheRead:  u.CachedReadTokens,
		CacheWrite: u.CachedWriteTokens,
		Reasoning:  u.ThoughtTokens,
	}
}

// handle runs on the ACP reader for every notification and agent request.
func (t *antigravityTurn) handle(frame acpFrame) {
	switch frame.Method {
	case "session/update":
		t.update(frame.Params, time.Now())
	case "session/request_permission":
		go t.permission(frame)
	default:
		if len(frame.ID) > 0 {
			_ = t.proc.conn.respondError(frame.ID, -32601, "method not supported by Linger")
		}
	}
}

type acpUpdate struct {
	SessionUpdate string          `json:"sessionUpdate"`
	Content       json.RawMessage `json:"content"`
	Name          string          `json:"name"`
	MessageID     string          `json:"messageId"`
	ToolCallID    string          `json:"toolCallId"`
	Title         string          `json:"title"`
	Kind          string          `json:"kind"`
	Status        string          `json:"status"`
	RawInput      json.RawMessage `json:"rawInput"`
	RawOutput     json.RawMessage `json:"rawOutput"`
	Used          *int64          `json:"used,omitempty"`
	Entries       []struct {
		Content string `json:"content"`
		Status  string `json:"status"`
	} `json:"entries"`
}

// started reports the turn-started status, which carries the session: the
// checkpoint a first Run reports for its new session.
func (t *antigravityTurn) started(sessionID string, at time.Time) {
	if !t.spec.ExposeTurnStarted {
		return
	}
	reused := t.reused
	t.emit(Event{Kind: EventStatus, Status: "running", TurnID: t.turnID, SessionID: sessionID, ProcessReused: &reused, SentAt: at})
}

// resumeRefused marks an outcome whose retained session Antigravity does
// not hold.
func (t *antigravityTurn) resumeRefused(outcome Outcome) Outcome {
	outcome.ResumeRefused = true
	return outcome
}

func (t *antigravityTurn) update(params json.RawMessage, observed time.Time) {
	var envelope struct {
		Update acpUpdate `json:"update"`
	}
	if json.Unmarshal(params, &envelope) != nil {
		return
	}
	update := envelope.Update
	t.mu.Lock()
	prompting := t.prompting
	if !prompting && update.SessionUpdate == "user_message_chunk" {
		t.replayedPrompts++
	}
	resumedFromWait := false
	if prompting {
		t.lastUpdate = observed
		switch update.SessionUpdate {
		case "agent_message_chunk", "agent_thought_chunk", "tool_call", "plan":
			if t.phase == "waiting_background" {
				t.phase = "running"
				resumedFromWait = true
			}
		}
	}
	t.mu.Unlock()
	if !prompting {
		return
	}
	if resumedFromWait {
		t.emit(Event{Kind: EventBackgroundResumed, ObservedAt: observed, BackgroundTrigger: "background_continuation"})
	}
	switch update.SessionUpdate {
	case "agent_message_chunk":
		text := acpContentText(update.Content)
		if text == "" {
			return
		}
		t.requests.item("", observed)
		t.mu.Lock()
		if t.textID == "" {
			// The reply is the last message, as Agent Service reads the
			// stream, so a new message replaces the output.
			t.textID = "antigravity-text-" + piRandomHex(12)
			t.output.Reset()
		}
		id := t.textID
		t.output.WriteString(text)
		t.mu.Unlock()
		t.emit(Event{Kind: EventText, ObservedAt: observed, ID: id, ModelMessageID: update.MessageID, Body: text})
	case "agent_thought_chunk":
		if text := acpContentText(update.Content); text != "" {
			t.mu.Lock()
			t.sawActivity = true
			t.mu.Unlock()
			t.requests.item("", observed)
			t.emit(Event{Kind: EventReasoning, ObservedAt: observed, ModelMessageID: update.MessageID, Body: text})
		}
	case "tool_call":
		toolName := antigravityToolName(update)
		callID := antigravityInvocationID(update.ToolCallID)
		// Text after a tool call is a new message.
		t.mu.Lock()
		t.sawActivity = true
		t.textID = ""
		t.tools[update.ToolCallID] = BackgroundTool{CallID: callID, ToolName: toolName, StartedAt: observed}
		t.mu.Unlock()
		t.emit(Event{
			Kind: EventToolCall, ObservedAt: observed, ToolName: toolName, InvocationID: callID,
			Input: antigravityInput(update.RawInput), ActivityKind: antigravityActivity(update.Kind), ActivityTitle: update.Title,
		})
		t.toolResult(update, observed)
	case "tool_call_update":
		t.toolResult(update, observed)
	case "usage_update":
		if t.compaction && update.Used != nil && *update.Used > 0 {
			used := *update.Used
			t.mu.Lock()
			if t.preTokens == nil {
				t.preTokens = &used
			}
			t.mu.Unlock()
		}
	case "plan":
		t.mu.Lock()
		t.sawActivity = true
		t.mu.Unlock()
		steps := make([]any, 0, len(update.Entries))
		for _, entry := range update.Entries {
			if entry.Content == "" {
				continue
			}
			status := entry.Status
			if status != "in_progress" && status != "completed" {
				status = "pending"
			}
			steps = append(steps, map[string]any{"content": entry.Content, "status": status})
		}
		t.emit(Event{Kind: EventPlan, Input: map[string]any{"steps": steps}})
	}
}

// toolResult emits a tool call's result once, when it reaches a terminal
// status.
func (t *antigravityTurn) toolResult(update acpUpdate, observed time.Time) {
	if update.Status != "completed" && update.Status != "failed" {
		return
	}
	t.mu.Lock()
	_, open := t.tools[update.ToolCallID]
	delete(t.tools, update.ToolCallID)
	t.mu.Unlock()
	if !open {
		return
	}
	t.requests.ready("", observed)
	output := acpToolOutput(update.Content)
	if output == "" && len(update.RawOutput) > 0 && string(update.RawOutput) != "null" {
		output = piText(update.RawOutput)
	}
	t.emit(Event{Kind: EventToolOutput, ObservedAt: observed, Status: antigravityToolStatus(update), InvocationID: antigravityInvocationID(update.ToolCallID), Output: output})
}

// antigravityInput is a tool call's input with its shell command under
// "command", where every Runtime's command reads it; run_command names it
// "CommandLine".
func antigravityInput(raw json.RawMessage) map[string]any {
	var input map[string]any
	if json.Unmarshal(raw, &input) != nil {
		return nil
	}
	if command, ok := input["CommandLine"].(string); ok {
		if _, named := input["command"]; !named {
			input["command"] = command
		}
	}
	return input
}

// antigravityToolStatus is a tool call's terminal status. run_command reports
// a command that exits non-zero as completed, with its exit code in the raw
// output.
func antigravityToolStatus(update acpUpdate) string {
	var output struct {
		ExitCode *int `json:"exit_code"`
	}
	if update.Status == "completed" && json.Unmarshal(update.RawOutput, &output) == nil && output.ExitCode != nil && *output.ExitCode != 0 {
		return "failed"
	}
	return update.Status
}

// permission answers session/request_permission: through the Run's
// permission review when it has one, otherwise with the allow option, as
// the Runtime runs with the Agent's full local authority.
func (t *antigravityTurn) permission(frame acpFrame) {
	var request struct {
		ToolCall acpUpdate `json:"toolCall"`
		Options  []struct {
			OptionID string `json:"optionId"`
			Kind     string `json:"kind"`
		} `json:"options"`
	}
	if json.Unmarshal(frame.Params, &request) != nil {
		_ = t.proc.conn.respondError(frame.ID, -32602, "invalid permission request")
		return
	}
	allow := !t.compaction
	if allow {
		if reviewer := t.spec.PermissionReviewer; reviewer != nil {
			allow = reviewer.Review(t.runCtx, antigravityReview(request.ToolCall, t.spec.Dir)).Decision == permission.Allow
		}
	}
	wanted := []string{"reject_once", "reject_always"}
	if allow {
		wanted = []string{"allow_once", "allow_always"}
	}
	for _, kind := range wanted {
		for _, option := range request.Options {
			if option.Kind == kind {
				_ = t.proc.conn.respond(frame.ID, map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": option.OptionID}})
				return
			}
		}
	}
	_ = t.proc.conn.respond(frame.ID, map[string]any{"outcome": map[string]any{"outcome": "cancelled"}})
}

// antigravityReview builds the permission review of one tool call.
func antigravityReview(call acpUpdate, workspace string) permission.Request {
	return toolReview("antigravity", antigravityToolName(call), call.Kind == "execute", antigravityInput(call.RawInput), workspace)
}

// toolReview builds the permission review of one call of a Runtime that
// hands the Daemon its tool calls. A command call is reviewed as a shell
// command, from its input's "command", so the shared shell rules apply.
func toolReview(runtime, tool string, isCommand bool, input map[string]any, workspace string) permission.Request {
	if input == nil {
		input = map[string]any{}
	}
	encoded, _ := json.Marshal(input)
	command := ""
	if isCommand {
		command, _ = input["command"].(string)
		if tool == "powershell" {
			tool = "PowerShell"
		} else {
			tool = "Bash"
		}
	}
	request := permission.Request{Action: permission.Action{
		Runtime: runtime, Surface: permission.Surface(tool, command), Tool: tool,
		Command: command, Input: string(encoded),
	}}
	if isCommand {
		request.Evidence = permission.ScriptEvidence(command, workspace)
	}
	return request
}

// antigravityToolName is the tool's own name, such as run_command. The
// title is a fallback only: Antigravity titles a command with its whole,
// unredacted command line, which the call's input already carries.
func antigravityToolName(update acpUpdate) string {
	if update.Name != "" {
		return update.Name
	}
	if update.Title != "" {
		return update.Title
	}
	if update.Kind != "" {
		return update.Kind
	}
	return "tool"
}

// antigravityActivity maps an ACP tool kind to the Runtime-neutral class.
func antigravityActivity(kind string) string {
	switch kind {
	case "read":
		return ActivityRead
	case "edit", "delete", "move":
		return ActivityFileChange
	case "search":
		return ActivitySearch
	case "execute":
		return ActivityCommand
	case "fetch":
		return ActivityBrowse
	}
	return ActivityTool
}

func antigravityInvocationID(native string) string {
	sum := sha256.Sum256([]byte(native))
	return "antigravity-call-" + hex.EncodeToString(sum[:])
}

// acpContentText is the text of one ACP content block.
func acpContentText(raw json.RawMessage) string {
	var block struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &block) != nil || block.Type != "text" {
		return ""
	}
	return block.Text
}

// acpToolOutput joins the text of a tool call's content list.
func acpToolOutput(raw json.RawMessage) string {
	var items []struct {
		Type    string          `json:"type"`
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &items) != nil {
		return ""
	}
	var text strings.Builder
	for _, item := range items {
		if item.Type == "content" {
			text.WriteString(acpContentText(item.Content))
		}
	}
	return text.String()
}

// acpMCPServers turns the Operation's {"mcpServers":{...}} document into
// ACP's server list: stdio servers with name/value environment pairs, and
// HTTP servers with name/value headers.
func acpMCPServers(config json.RawMessage) ([]any, error) {
	_, servers, ok := decodeMCPDocument(config)
	if !ok {
		return nil, errors.New("MCP configuration must be an object with an mcpServers object")
	}
	names := make([]string, 0, len(servers))
	for name := range servers {
		names = append(names, name)
	}
	sort.Strings(names)
	out := make([]any, 0, len(names))
	for _, name := range names {
		server, ok := servers[name].(map[string]any)
		if name == "" || !ok {
			return nil, errors.New("MCP server requires a name and object configuration")
		}
		kind, _ := server["type"].(string)
		url, _ := server["url"].(string)
		command, _ := server["command"].(string)
		switch {
		case command != "":
			args := []any{}
			if list, ok := server["args"].([]any); ok {
				args = list
			}
			out = append(out, map[string]any{"name": name, "command": command, "args": args, "env": acpPairs(server["env"])})
		case url != "":
			if kind == "" || strings.EqualFold(kind, "streamable-http") {
				kind = "http"
			}
			out = append(out, map[string]any{"type": strings.ToLower(kind), "name": name, "url": url, "headers": acpPairs(server["headers"])})
		default:
			return nil, fmt.Errorf("MCP server %s has neither a command nor a URL", name)
		}
	}
	return out, nil
}

func acpPairs(value any) []any {
	object, _ := value.(map[string]any)
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	pairs := make([]any, 0, len(keys))
	for _, key := range keys {
		pairs = append(pairs, map[string]any{"name": key, "value": fmt.Sprint(object[key])})
	}
	return pairs
}
