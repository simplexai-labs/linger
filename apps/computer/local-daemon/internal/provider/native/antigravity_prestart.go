package native

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

// antigravitySettledRun is a Run that never launched a turn: its events are
// closed and its single Outcome is ready.
func antigravitySettledRun(outcome Outcome) *Run {
	events := make(chan Event)
	close(events)
	outcomes := make(chan Outcome, 1)
	outcomes <- outcome
	close(outcomes)
	return &Run{Events: events, Outcome: outcomes}
}

// prestart launches `agy acp` ahead of a Room-presence Run, checks ACP
// capabilities, warms the backend with session/list without creating any
// conversation, and parks the unbound process for the Context's next Run.
func (r *antigravityRuntime) prestart(ctx context.Context, spec RunSpec, program, key string) (*Run, error) {
	if key == "" || !antigravityResidents.enabled() {
		return nil, fmt.Errorf("%w: Antigravity residency is unavailable", ErrProviderPrepareNotEligible)
	}
	fence := captureReleaseFence(r.profile)
	epoch := antigravityResidents.currentEpoch()
	hookEP, hookArgs := antigravityHookConfig(r.profile.Logger)
	hookDir := ""
	if hookEP != nil {
		hookDir = hookEP.Dir()
	}
	wantShape := antigravityShapeFor(program, r.profile, spec, hookDir, "", false)

	live, fields := antigravityResidents.peek(key, antigravityMismatch(wantShape, spec))
	if live && len(fields) == 0 {
		return antigravitySettledRun(Outcome{Status: statusCompleted, SessionID: spec.ResumeID}), nil
	}
	reason := "spawn"
	if live {
		reason = "incompatible"
	}
	stopped, err := antigravityResidents.stopWhere(reason, func(proc *acpProcess) bool { return proc.res.key == key }, r.profile.Logger)
	for range stopped {
		spec.Readiness.recycled(reason, fields)
	}
	if err != nil {
		return nil, err
	}

	var releaseTemp func() error
	if r.profile.RetainProcessTemp != nil {
		if releaseTemp, err = r.profile.RetainProcessTemp(); err != nil {
			return nil, fmt.Errorf("Antigravity process temp directory could not be retained: %w", err)
		}
	}
	proc, err := startACP(profileInvocation(program, nil, r.profile.Env), spec.Dir, r.profile.Logger, nil, hookArgs...)
	if err != nil {
		if releaseTemp != nil {
			_ = releaseTemp()
		}
		return nil, err
	}
	proc.res.bind(key, r.profile)
	proc.res.bindEpoch(epoch)
	proc.hookEP = hookEP
	proc.storeRoot = antigravityStoreRoot(r.profile.Env)
	proc.releaseTemp = releaseTemp
	spec.Readiness.spawned()

	caps, err := acpInitialize(ctx, proc.conn)
	if err != nil {
		antigravityResidents.retire(proc)
		return nil, fmt.Errorf("initialize Antigravity pre-start: %w", err)
	}
	if !caps.supportsResidency() {
		antigravityResidents.retire(proc)
		return nil, fmt.Errorf("%w: Antigravity ACP server lacks session list or resume support", ErrProviderPrepareNotEligible)
	}
	_, err = acpOpenSession(ctx, proc.conn, r.profile.Env, func() (json.RawMessage, error) {
		return proc.conn.call(ctx, "session/list", map[string]any{"cwd": spec.Dir})
	})
	if err != nil {
		antigravityResidents.retire(proc)
		if acpNeedsAuth(err) {
			return nil, errors.New("Antigravity sign-in is required")
		}
		return nil, fmt.Errorf("warm Antigravity pre-start: %w", err)
	}
	proc.caps = caps
	proc.shape = wantShape
	if !antigravityResidents.park(proc, fence, true, r.profile.Logger, spec.Readiness) {
		antigravityResidents.retire(proc)
		return nil, errors.New("Antigravity provider prepare could not park the process")
	}
	return antigravitySettledRun(Outcome{Status: statusCompleted, SessionID: spec.ResumeID, Parked: true}), nil
}
