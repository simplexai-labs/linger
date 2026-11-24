package native

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
)

// InvokePiModel runs a single tool-free RPC turn on Pi, using model when
// specified (or Pi's default model when omitted), with the same Pi profile
// and event handling as managed execution but no persistent session. It
// returns the model Pi ran.
func InvokePiModel(ctx context.Context, profile Profile, dir, instructionsFile, model, prompt, effort string) (Outcome, string, error) {
	thinking, err := piThinkingLevel(effort)
	if err != nil {
		return Outcome{}, "", err
	}
	args := append([]string{"--mode", "rpc", "--no-session", "--no-tools"}, PiRPCResourceArgs(instructionsFile)...)
	if model != "" && model != piDefaultModel {
		args = append(args, "--model", model)
	}
	if thinking != "" {
		args = append(args, "--thinking", thinking)
	}
	profile.Logger = slog.Default()
	procCtx, stop := context.WithCancel(context.Background())
	defer stop()
	cmd := ownedCommand(procCtx, profileInvocation(profile.Program, nil, profile.Env), args...)
	cmd.Dir, cmd.WaitDelay = dir, piChildPipeDrain
	proc, err := piLaunch(profile, cmd)
	if err != nil {
		return Outcome{}, "", err
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
	state, err := proc.call(probeCtx, "get_state", nil, nil)
	var catalog piCatalogState
	if err != nil || json.Unmarshal(state.Data, &catalog) != nil {
		cancelProbe()
		return Outcome{}, "", errors.New("Pi background model state could not be read")
	}
	if clamped, ok := piStateThinkingLevel(catalog, thinking); ok {
		if _, err := proc.call(probeCtx, "set_thinking_level", map[string]any{"level": clamped}, nil); err != nil {
			cancelProbe()
			return Outcome{}, "", errors.New("Pi background thinking level could not be applied")
		}
	}
	cancelProbe()
	reportedModel := ""
	if catalog.Model.ID != "" {
		reportedModel = catalog.Model.Provider + "/" + catalog.Model.ID
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	turn := newPiTurn(runCtx, cancel, proc, false, releaseFence{}, profile.Logger)
	turn.oneShot = true
	if err := proc.bind(turn); err != nil {
		return Outcome{}, "", err
	}
	go turn.drive(prompt)
	for range turn.events {
	}
	return <-turn.outcome, reportedModel, nil
}
