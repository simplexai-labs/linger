package native

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"runtime"
	"strings"
)

const piStrataPinEnvKey = "LINGER_PI_STRATA_PIN"

// StrataPinSpec describes the PolyStrata `strata_pin` payload attached to a
// one-shot Pi prefix warm-up turn via LINGER_PI_STRATA_PIN. Only fields
// accepted by PolyStrata's strict request validator are serialized.
type StrataPinSpec struct {
	Name        string `json:"name"`
	PrefillOnly bool   `json:"prefill_only"`
	Resident    string `json:"resident,omitempty"`
	Anchor      string `json:"anchor,omitempty"`
}

// WarmupPiPrefix runs one tool-0-matching Pi RPC turn with prefill-only KV
// pinning enabled through the managed Pi extension, without writing a session
// file on disk.
func WarmupPiPrefix(ctx context.Context, profile Profile, dir, instructionsFile, model string, pin StrataPinSpec) error {
	if err := piCheckExtension(profile.ManagedMCPExtension); err != nil {
		return err
	}
	if strings.TrimSpace(instructionsFile) == "" {
		return errors.New("Pi prefix warm-up requires an instructions file")
	}
	if strings.TrimSpace(model) == "" || model == piDefaultModel {
		return errors.New("Pi prefix warm-up requires a resolved model")
	}
	if strings.TrimSpace(pin.Name) == "" {
		return errors.New("Pi prefix warm-up requires a pin name")
	}
	if strings.TrimSpace(dir) == "" {
		return errors.New("Pi prefix warm-up requires a working directory")
	}
	pinJSON, err := json.Marshal(pin)
	if err != nil {
		return fmt.Errorf("encode Pi strata_pin payload: %w", err)
	}
	program, err := piResolveProgram(profile.Program)
	if err != nil {
		return err
	}
	if profile.Logger == nil {
		profile.Logger = slog.Default()
	}

	env := make(map[string]string, len(profile.Env)+3)
	for key, value := range profile.Env {
		env[key] = value
	}
	env[piStrataPinEnvKey] = string(pinJSON)
	piExtensionNodePath(env, profile.ManagedMCPExtension)

	args := append([]string{"--mode", "rpc", "--no-session"}, PiRPCResourceArgs(instructionsFile)...)
	args = append(args, "--model", model, "--extension", profile.ManagedMCPExtension, "--tools", piBaseToolsFor(runtime.GOOS))

	procCtx, stop := context.WithCancel(context.Background())
	defer stop()
	cmd := ownedCommand(procCtx, profileInvocation(program, nil, env), args...)
	cmd.Dir, cmd.WaitDelay = dir, piChildPipeDrain
	proc, err := piLaunch(profile, cmd)
	if err != nil {
		return err
	}
	proc.sessionDir, proc.cancel = dir, stop
	proc.res.bind(dir, profile)
	proc.run()
	defer func() {
		if proc.stop() {
			piResidents.forget(proc)
		} else {
			piResidents.hold(proc)
		}
	}()

	probeCtx, cancelProbe := context.WithTimeout(ctx, piStartupBudget)
	_, err = proc.call(probeCtx, "get_state", nil, nil)
	cancelProbe()
	if err != nil {
		return fmt.Errorf("Pi prefix warm-up state could not be read: %w", err)
	}

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	turn := newPiTurn(runCtx, cancel, proc, false, releaseFence{}, profile.Logger)
	turn.oneShot = true
	if err := proc.bind(turn); err != nil {
		return err
	}
	go turn.drive(".")
	for range turn.events {
	}
	outcome := <-turn.outcome
	if outcome.Status != statusCompleted {
		if outcome.Error != "" {
			return fmt.Errorf("Pi prefix warm-up %s: %s", outcome.Status, outcome.Error)
		}
		return fmt.Errorf("Pi prefix warm-up finished with status %s", outcome.Status)
	}
	return nil
}
