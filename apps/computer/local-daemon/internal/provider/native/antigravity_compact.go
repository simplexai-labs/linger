package native

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/runtimehistory"
)

type antigravityTranscriptEntry struct {
	Type      string `json:"type"`
	StepIndex *int   `json:"step_index"`
}

func sameAntigravityTranscriptPath(left, right string) bool {
	cleanLeft := filepath.Clean(left)
	cleanRight := filepath.Clean(right)
	if cleanLeft == cleanRight {
		return true
	}
	if filepath.Base(cleanLeft) != filepath.Base(cleanRight) {
		return false
	}
	dirLeft, errLeft := filepath.EvalSymlinks(filepath.Dir(cleanLeft))
	dirRight, errRight := filepath.EvalSymlinks(filepath.Dir(cleanRight))
	return errLeft == nil && errRight == nil && dirLeft == dirRight
}

func scanAntigravityTranscript(path, storeRoot, sessionID string, visit func(antigravityTranscriptEntry)) bool {
	if path == "" {
		return false
	}
	var (
		file *os.File
		err  error
	)
	if storeRoot != "" && sessionID != "" &&
		sameAntigravityTranscriptPath(path, filepath.Join(storeRoot, "brain", sessionID, ".system_generated", "logs", "transcript.jsonl")) {
		file, _, err = runtimehistory.OpenAntigravityTranscript(storeRoot, sessionID)
	} else {
		file, _, err = runtimehistory.OpenAntigravityTranscriptPath(path)
	}
	if err != nil {
		return false
	}
	defer file.Close()
	reader := bufio.NewReaderSize(file, 64*1024)
	for {
		line, err := reader.ReadBytes('\n')
		if trimmed := bytes.TrimSpace(line); len(trimmed) > 0 {
			var entry antigravityTranscriptEntry
			if json.Unmarshal(trimmed, &entry) == nil {
				visit(entry)
			}
		}
		if errors.Is(err, io.EOF) {
			return true
		}
		if err != nil {
			return false
		}
	}
}

func inspectAntigravityCheckpoints(path string, minStep *int) (count int, hasAtOrAfter bool, ok bool) {
	return inspectAntigravityCheckpointsInStore(path, "", "", minStep)
}

func inspectAntigravityCheckpointsInStore(path, storeRoot, sessionID string, minStep *int) (count int, hasAtOrAfter bool, ok bool) {
	ok = scanAntigravityTranscript(path, storeRoot, sessionID, func(entry antigravityTranscriptEntry) {
		if entry.Type != "CHECKPOINT" {
			return
		}
		count++
		if minStep != nil && entry.StepIndex != nil && *entry.StepIndex >= *minStep {
			hasAtOrAfter = true
		}
	})
	return count, hasAtOrAfter, ok
}

func newAntigravityCompactionTurn(ctx context.Context, proc *acpProcess, sessionID string) *antigravityTurn {
	return &antigravityTurn{
		proc:       proc,
		runCtx:     ctx,
		compaction: true,
		prompting:  true,
		phase:      "running",
		sessionID:  sessionID,
		tools:      map[string]BackgroundTool{},
		requests:   newModelRequestClock(GranularityDelta),
	}
}

// compactAntigravity submits /compact on the parked ACP session and verifies
// compaction from CHECKPOINT records written to the session's JSONL transcript.
// A clean turn with no open tool calls parks the process back; any other end
// retires the process before returning.
func (s *ParkedSession) compactAntigravity(ctx context.Context, instructions string) CompactResult {
	proc := s.antigravity
	if ctx.Err() != nil {
		antigravityResidents.retire(proc)
		return compactContextResult(ctx)
	}
	proc.mu.Lock()
	sessionID := proc.sessionID
	transcriptPath := proc.transcriptPath
	storeRoot := proc.storeRoot
	proc.mu.Unlock()
	hookEP := proc.hookEP

	if sessionID == "" || !proc.alive() {
		antigravityResidents.retire(proc)
		return CompactResult{Outcome: "failed", Reason: "Antigravity parked process has no active session"}
	}
	if transcriptPath == "" && hookEP == nil {
		antigravityResidents.retire(proc)
		return CompactResult{Outcome: "failed", Reason: "Antigravity compaction transcript was unavailable"}
	}

	prompt := strings.TrimSpace("/compact " + strings.TrimSpace(instructions))
	baselineCount, _, baselineOK := inspectAntigravityCheckpointsInStore(transcriptPath, storeRoot, sessionID, nil)
	if ctx.Err() != nil {
		antigravityResidents.retire(proc)
		return compactContextResult(ctx)
	}

	turn := newAntigravityCompactionTurn(ctx, proc, sessionID)
	if err := proc.bind(turn); err != nil {
		antigravityResidents.retire(proc)
		return CompactResult{Outcome: "failed", Reason: "Antigravity parked process was not idle for compaction"}
	}

	var (
		hookMu             sync.Mutex
		hookTranscriptPath string
		hookInitialSteps   *int
		unregOnce          sync.Once
		unregister         = func() {}
	)
	if hookEP != nil {
		unreg := hookEP.Register(sessionID, func(_ context.Context, req AntigravityHookRequest) AntigravityHookResponse {
			hookMu.Lock()
			if req.TranscriptPath != "" {
				hookTranscriptPath = req.TranscriptPath
			}
			if hookInitialSteps == nil &&
				req.HookEventName == "PreInvocation" && req.InvocationNum == 0 && req.InitialNumSteps != nil {
				steps := *req.InitialNumSteps
				hookInitialSteps = &steps
			}
			hookMu.Unlock()
			proc.noteTranscriptPath(req)
			if req.HookEventName == "PreToolUse" {
				return AntigravityHookResponse{Decision: "deny", Reason: "Tools are disabled during compaction."}
			}
			return AntigravityHookResponse{}
		})
		unregister = func() { unregOnce.Do(unreg) }
		defer unregister()
	}

	raw, err := proc.conn.call(ctx, "session/prompt", map[string]any{
		"sessionId": sessionID,
		"prompt":    []any{map[string]any{"type": "text", "text": prompt}},
	})
	unregister()
	if err != nil {
		if ctx.Err() != nil {
			_ = proc.conn.notify("session/cancel", map[string]any{"sessionId": sessionID})
		}
		proc.unbind(turn)
		antigravityResidents.retire(proc)
		switch {
		case ctx.Err() != nil:
			return compactContextResult(ctx)
		case errors.Is(err, errACPClosed):
			return CompactResult{Outcome: "failed", Reason: "Antigravity exited during session compaction"}
		default:
			return CompactResult{Outcome: "failed", Reason: "Antigravity session/prompt failed: " + err.Error()}
		}
	}

	var result struct {
		StopReason string `json:"stopReason"`
	}
	if unmarshalErr := json.Unmarshal(raw, &result); unmarshalErr != nil || result.StopReason != "end_turn" {
		proc.unbind(turn)
		antigravityResidents.retire(proc)
		switch {
		case ctx.Err() != nil:
			return compactContextResult(ctx)
		case result.StopReason != "":
			return CompactResult{Outcome: "failed", Reason: "Antigravity compaction stopped: " + result.StopReason}
		default:
			return CompactResult{Outcome: "failed", Reason: "Antigravity compaction returned an unexpected response"}
		}
	}

	hookMu.Lock()
	observedPath := hookTranscriptPath
	initialSteps := hookInitialSteps
	hookMu.Unlock()
	if observedPath != "" {
		if transcriptPath != "" && observedPath != transcriptPath {
			baselineOK = false
		}
		transcriptPath = observedPath
	}

	if transcriptPath == "" {
		proc.unbind(turn)
		antigravityResidents.retire(proc)
		return CompactResult{Outcome: "failed", Reason: "Antigravity compaction transcript was unavailable"}
	}
	afterCount, hasCheckpointFromTurn, afterOK := inspectAntigravityCheckpointsInStore(transcriptPath, storeRoot, sessionID, initialSteps)
	if !afterOK {
		proc.unbind(turn)
		antigravityResidents.retire(proc)
		return CompactResult{Outcome: "failed", Reason: "Antigravity compaction transcript could not be read"}
	}

	var compacted bool
	switch {
	case baselineOK:
		compacted = afterCount > baselineCount
	case initialSteps != nil:
		compacted = hasCheckpointFromTurn
	case afterCount == 0:
		compacted = false
	default:
		proc.unbind(turn)
		antigravityResidents.retire(proc)
		return CompactResult{Outcome: "failed", Reason: "Antigravity compaction could not be verified without a transcript baseline"}
	}

	turn.mu.Lock()
	openTools := len(turn.tools)
	var preTokens *int64
	if turn.preTokens != nil {
		v := *turn.preTokens
		preTokens = &v
	}
	turn.mu.Unlock()

	var compactResult CompactResult
	if compacted {
		compactResult = CompactResult{Outcome: "compacted", PreTokens: preTokens}
	} else {
		compactResult = CompactResult{Outcome: "nothing_to_compact"}
	}

	parked := false
	if ctx.Err() == nil && openTools == 0 && proc.alive() {
		proc.mu.Lock()
		canPark := proc.turn == turn && !proc.res.isStopping()
		if canPark {
			proc.turn = nil
		}
		proc.mu.Unlock()
		if canPark {
			parked = antigravityResidents.park(proc, s.fence, false, s.logger, nil)
		}
	}
	if !parked {
		proc.unbind(turn)
		antigravityResidents.retire(proc)
	}
	return compactResult
}
