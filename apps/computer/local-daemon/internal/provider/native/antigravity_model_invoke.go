package native

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

const antigravityModelInvokeMaxBuffer = (1 << 20) + 4096

type antigravityModelInvokeState struct {
	mu           sync.Mutex
	output       strings.Builder
	sawActivity  bool
	overflowed   bool
	promptCancel context.CancelFunc
	proc         atomic.Pointer[acpProcess]
}

func (s *antigravityModelInvokeState) handle(frame acpFrame) {
	switch frame.Method {
	case "session/update":
		var envelope struct {
			Update acpUpdate `json:"update"`
		}
		if json.Unmarshal(frame.Params, &envelope) != nil {
			return
		}
		update := envelope.Update
		switch update.SessionUpdate {
		case "agent_message_chunk":
			text := acpContentText(update.Content)
			if text == "" {
				return
			}
			var cancel context.CancelFunc
			s.mu.Lock()
			if !s.overflowed {
				remaining := antigravityModelInvokeMaxBuffer - s.output.Len()
				if len(text) > remaining {
					if remaining > 0 {
						s.output.WriteString(text[:remaining])
					}
					s.overflowed = true
					cancel = s.promptCancel
				} else {
					s.output.WriteString(text)
				}
			}
			s.mu.Unlock()
			if cancel != nil {
				cancel()
			}
		case "agent_thought_chunk", "plan":
			s.mu.Lock()
			s.sawActivity = true
			s.mu.Unlock()
		case "tool_call":
			s.mu.Lock()
			s.sawActivity = true
			if !s.overflowed {
				s.output.Reset()
			}
			s.mu.Unlock()
		}
	case "session/request_permission":
		go s.denyPermission(frame)
	default:
		if len(frame.ID) > 0 {
			if proc := s.proc.Load(); proc != nil {
				_ = proc.conn.respondError(frame.ID, -32601, "method not supported by Linger")
			}
		}
	}
}

func (s *antigravityModelInvokeState) denyPermission(frame acpFrame) {
	proc := s.proc.Load()
	if proc == nil {
		return
	}
	var request struct {
		Options []struct {
			OptionID string `json:"optionId"`
			Kind     string `json:"kind"`
		} `json:"options"`
	}
	if json.Unmarshal(frame.Params, &request) != nil {
		_ = proc.conn.respondError(frame.ID, -32602, "invalid permission request")
		return
	}
	for _, kind := range []string{"reject_once", "reject_always"} {
		for _, option := range request.Options {
			if option.Kind == kind {
				_ = proc.conn.respond(frame.ID, map[string]any{
					"outcome": map[string]any{"outcome": "selected", "optionId": option.OptionID},
				})
				return
			}
		}
	}
	_ = proc.conn.respond(frame.ID, map[string]any{"outcome": map[string]any{"outcome": "cancelled"}})
}

func (s *antigravityModelInvokeState) snapshot() (output string, sawActivity, overflowed bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.output.String(), s.sawActivity, s.overflowed
}

func writeAntigravityDenyToolsHooks(hooksDir, daemonExecutable string) error {
	agentsDir := filepath.Join(hooksDir, ".agents")
	if err := privatefs.EnsureDir(hooksDir); err != nil {
		return err
	}
	if err := privatefs.EnsureDir(agentsDir); err != nil {
		return err
	}
	hooksFile := filepath.Join(agentsDir, "hooks.json")
	doc := map[string]any{
		"linger-model-invoke": map[string]any{
			"PreToolUse": []any{
				map[string]any{
					"matcher": "*",
					"hooks": []any{map[string]any{
						"type":    "command",
						"command": antigravityHookCommand(daemonExecutable, antigravityHookDenyToolsArg),
						"timeout": 10,
					}},
				},
			},
		},
	}
	encoded, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	if err := privatefs.WriteFile(hooksFile, append(encoded, '\n'), true); err != nil {
		return err
	}
	return sealAntigravityHookDir(hooksDir, agentsDir, hooksFile)
}

// InvokeAntigravityModel runs one stateless, tool-disabled ACP prompt against
// an isolated temporary Gemini directory without touching the user's
// ~/.gemini/antigravity-cli store. It returns the turn outcome and the model
// Antigravity selected.
func InvokeAntigravityModel(
	ctx context.Context,
	profile Profile,
	workDir, scratchDir, instructions, model, prompt, effort string,
) (outcome Outcome, reportedModel string, err error) {
	started := time.Now()
	program, err := antigravityResolveProgram(profile.Program)
	if err != nil {
		return Outcome{}, "", err
	}
	if antigravityProbeHome(profile.Env) == "" && !antigravityHasAPIKey(profile.Env) {
		return Outcome{}, "", errors.New("Antigravity background call requires HOME or Gemini API key")
	}
	geminiDir, logFile, err := prepareAntigravityIsolatedDir(filepath.Join(scratchDir, "antigravity-home"), profile.Env, true)
	if err != nil {
		return Outcome{}, "", err
	}
	daemonExe, err := os.Executable()
	if err != nil {
		return Outcome{}, "", fmt.Errorf("locate Daemon executable for Antigravity model invoke hooks: %w", err)
	}
	hooksDir := filepath.Join(scratchDir, "antigravity-hooks")
	if err := writeAntigravityDenyToolsHooks(hooksDir, daemonExe); err != nil {
		unlockAntigravityHookDir(hooksDir)
		return Outcome{}, "", err
	}
	if resolved, err := filepath.EvalSymlinks(hooksDir); err == nil && resolved != "" {
		hooksDir = resolved
	}
	defer unlockAntigravityHookDir(hooksDir)

	promptCtx, promptCancel := context.WithCancel(ctx)
	defer promptCancel()
	state := &antigravityModelInvokeState{promptCancel: promptCancel}
	extraArgs := []string{
		"--gemini-dir", geminiDir,
		"--log-file", logFile,
		"--add-dir", hooksDir,
		"--include-default-customizations=false",
	}
	logger := profile.Logger
	if logger == nil {
		logger = slog.Default()
	}
	proc, err := startACP(profileInvocation(program, nil, profile.Env), workDir, logger, state.handle, extraArgs...)
	if err != nil {
		return Outcome{}, "", err
	}
	state.proc.Store(proc)
	proc.res.bind(workDir, profile)

	var sessionID string
	defer func() {
		_, _, overflowed := state.snapshot()
		if (ctx.Err() != nil || overflowed) && sessionID != "" {
			_ = proc.conn.notify("session/cancel", map[string]any{"sessionId": sessionID})
		}
		confirmed := proc.stop()
		if confirmed {
			antigravityResidents.forget(proc)
		} else {
			antigravityResidents.hold(proc)
		}
		outcome.ExitConfirmed = confirmed
		outcome.ExitUnconfirmed = !confirmed
	}()

	failed := func(code, message string) Outcome {
		return Outcome{
			Status:       statusFailed,
			FailureCode:  code,
			Error:        message,
			PublicDetail: message,
			ElapsedMs:    time.Since(started).Milliseconds(),
		}
	}

	if _, err := acpInitialize(ctx, proc.conn); err != nil {
		return failed("protocol_incompatible", "Antigravity ACP handshake failed: "+err.Error()), "", nil
	}
	sessionParams := map[string]any{"cwd": workDir, "mcpServers": []any{}}
	if instructions != "" {
		sessionParams["_meta"] = map[string]any{
			"antigravity": map[string]any{
				"systemPrompt": map[string]any{"append": instructions},
			},
		}
	}
	raw, err := acpOpenSession(ctx, proc.conn, profile.Env, func() (json.RawMessage, error) {
		return proc.conn.call(ctx, "session/new", sessionParams)
	})
	if acpNeedsAuth(err) {
		return failed("authentication_required", "Antigravity sign-in is required"), "", nil
	}
	if err != nil {
		return failed("", "Antigravity session/new failed: "+err.Error()), "", nil
	}
	var session acpSession
	if json.Unmarshal(raw, &session) != nil || session.SessionID == "" {
		return failed("", "Antigravity session/new returned no session"), "", nil
	}
	sessionID = session.SessionID
	reportedModel = acpConfigValue(session.ConfigOptions, "model")
	if model != "" && model != antigravityDefaultModel {
		if _, err := proc.conn.call(ctx, "session/set_config_option", map[string]any{
			"sessionId": sessionID,
			"configId":  "model",
			"value":     model,
		}); err != nil {
			return failed(acpOptionFailure(err), "Antigravity model "+model+" could not be selected: "+err.Error()), "", nil
		}
		reportedModel = model
	}

	effectiveEffort, listedInCatalog := antigravityClampModelInvokeEffort(antigravityCatalog(session), reportedModel, effort)
	if effectiveEffort != "" {
		if _, err := proc.conn.call(ctx, "session/set_config_option", map[string]any{
			"sessionId": sessionID,
			"configId":  "thought_level",
			"value":     effectiveEffort,
		}); err != nil {
			var rpc *acpError
			if !(errors.As(err, &rpc) && rpc.Code == -32602 && !listedInCatalog) {
				return failed(acpOptionFailure(err), "Antigravity thinking level "+effectiveEffort+" could not be selected: "+err.Error()), reportedModel, nil
			}
		}
	}

	promptRaw, promptErr := proc.conn.call(promptCtx, "session/prompt", map[string]any{
		"sessionId": sessionID,
		"prompt":    []any{map[string]any{"type": "text", "text": prompt}},
	})
	output, sawActivity, overflowed := state.snapshot()
	if overflowed && ctx.Err() == nil {
		return Outcome{
			Status:    statusCompleted,
			Output:    output,
			ElapsedMs: time.Since(started).Milliseconds(),
		}, reportedModel, nil
	}
	if promptErr != nil {
		if status := interruptedStatus(ctx); status != "" {
			return Outcome{
				Status:    status,
				Error:     "Antigravity session/prompt failed: " + ctx.Err().Error(),
				ElapsedMs: time.Since(started).Milliseconds(),
			}, reportedModel, nil
		}
		if errors.Is(promptErr, errACPClosed) {
			return failed("", "Antigravity exited before the turn finished"), reportedModel, nil
		}
		return failed("", "Antigravity session/prompt failed: "+promptErr.Error()), reportedModel, nil
	}

	var result struct {
		StopReason string             `json:"stopReason"`
		Usage      *antigravityTokens `json:"usage"`
	}
	_ = json.Unmarshal(promptRaw, &result)
	hasNonzeroUsage := result.Usage != nil && result.Usage.nonzero()
	outcome = Outcome{
		Output:    output,
		ElapsedMs: time.Since(started).Milliseconds(),
	}
	if result.Usage != nil {
		modelKey := reportedModel
		if modelKey == "" {
			modelKey = antigravityDefaultModel
		}
		count := result.Usage.count()
		outcome.Usage = map[string]TokenCount{modelKey: count}
		outcome.LastUsage = map[string]TokenCount{modelKey: count}
	}
	switch result.StopReason {
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
		outcome.Status = statusAborted
		outcome.Error = "Antigravity turn was cancelled"
	default:
		outcome.Status = statusFailed
		outcome.Error = "Antigravity stopped the turn: " + result.StopReason
		outcome.PublicDetail = outcome.Error
	}
	return outcome, reportedModel, nil
}

// antigravityClampModelInvokeEffort resolves the thinking level for model from
// the live session catalog. It reports whether the catalog listed explicit
// effort options for that model.
func antigravityClampModelInvokeEffort(catalog ModelList, model, requested string) (string, bool) {
	requested = strings.TrimSpace(requested)
	if requested == "" {
		return "", false
	}
	for _, option := range catalog.Models {
		if option.ID != model {
			continue
		}
		if option.Effort == nil || len(option.Effort.Options) == 0 {
			return "", true
		}
		allowed := make([]string, len(option.Effort.Options))
		for i, entry := range option.Effort.Options {
			allowed[i] = entry.Value
		}
		return NormalizeReasoningEffort(requested, allowed, option.Effort.Default), true
	}
	return requested, false
}
