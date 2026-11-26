package native

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

func compactContextResult(ctx context.Context) CompactResult {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return CompactResult{Outcome: "failed", Reason: "Session compaction deadline exceeded"}
	}
	return CompactResult{Outcome: "canceled", Reason: "Session compaction canceled"}
}

func (s *ParkedSession) retirePi() {
	piResidents.retire(s.pi)
}

func (s *ParkedSession) parkPiOrRetire() {
	if !piResidents.park(s.pi, s.fence, false, s.logger, nil) {
		piResidents.retire(s.pi)
	}
}

// compactPi compacts a parked Pi process through Pi's native RPC compact
// command. Local pre-flight checks verify idle state, transcript validity, and
// structural compactability (matching Pi's cut-point and snapshotted
// keepRecentTokens rules without matching error prose) before invoking prepare
// or the compact RPC. On a clean JSON-RPC rejection, a bounded idle probe
// verifies the process is still healthy and parks it back when its fence admits
// it; transport failures, unhealthy probes, timeouts, and cancellations retire
// the process before returning. A non-canceled prepare error parks the
// untouched process back when its fence still admits it.
func (s *ParkedSession) compactPi(ctx context.Context, instructions string, prepare func(ctx context.Context, modelID string) error) CompactResult {
	p := s.pi

	probeCtx, probeCancel := context.WithTimeout(ctx, piProbeBudget)
	state, err := p.sessionState(probeCtx)
	probeCancel()
	if err != nil {
		s.retirePi()
		if ctx.Err() != nil {
			return compactContextResult(ctx)
		}
		return CompactResult{Outcome: "failed", Reason: err.Error()}
	}
	if state.IsStreaming || state.IsCompacting || state.PendingMessageCount != 0 {
		s.retirePi()
		return CompactResult{Outcome: "failed", Reason: "Pi parked process is not idle"}
	}
	sessionFile, err := piCompactSessionFile(p.sessionDir, p.sessionID, p.contextDir, state.SessionFile)
	if err != nil {
		s.retirePi()
		return CompactResult{Outcome: "failed", Reason: err.Error()}
	}
	if state.MessageCount != nil && *state.MessageCount == 0 {
		s.parkPiOrRetire()
		return CompactResult{Outcome: "nothing_to_compact"}
	}
	keepRecentTokens := piResolveKeepRecentTokens(p.compactionSettings, p.modelID())
	canCompact, err := piSessionCanCompact(sessionFile, keepRecentTokens)
	if err != nil {
		s.retirePi()
		return CompactResult{Outcome: "failed", Reason: err.Error()}
	}
	if !canCompact {
		s.parkPiOrRetire()
		return CompactResult{Outcome: "nothing_to_compact"}
	}

	if prepare != nil {
		err := prepare(ctx, p.modelID())
		if err != nil || ctx.Err() != nil {
			if ctx.Err() != nil {
				s.retirePi()
				return compactContextResult(ctx)
			}
			s.parkPiOrRetire()
			return CompactResult{Outcome: "failed", Reason: err.Error()}
		}
	}
	if ctx.Err() != nil {
		s.retirePi()
		return compactContextResult(ctx)
	}

	fields := map[string]any{}
	if trimmed := strings.TrimSpace(instructions); trimmed != "" {
		fields["customInstructions"] = trimmed
	}
	reply, err := p.call(ctx, "compact", fields, nil)
	if ctx.Err() != nil {
		if err != nil && reply.Type != "response" {
			abortCtx, abortCancel := context.WithTimeout(context.Background(), piAbortBudget)
			_, _ = p.call(abortCtx, "abort", nil, nil)
			abortCancel()
		}
		s.retirePi()
		return compactContextResult(ctx)
	}
	if err != nil {
		if reply.Type == "response" && reply.Command == "compact" && !reply.Success {
			postCtx, postCancel := context.WithTimeout(ctx, piProbeBudget)
			probeErr := p.probeIdle(postCtx)
			postCancel()
			if probeErr == nil && ctx.Err() == nil {
				s.parkPiOrRetire()
				return CompactResult{Outcome: "failed", Reason: err.Error()}
			}
			s.retirePi()
			if ctx.Err() != nil {
				return compactContextResult(ctx)
			}
			return CompactResult{Outcome: "failed", Reason: err.Error()}
		}
		s.retirePi()
		return CompactResult{Outcome: "failed", Reason: err.Error()}
	}

	var data struct {
		Summary          string `json:"summary"`
		FirstKeptEntryID string `json:"firstKeptEntryId"`
		TokensBefore     *int64 `json:"tokensBefore"`
	}
	if len(reply.Data) > 0 {
		if err := json.Unmarshal(reply.Data, &data); err != nil {
			s.retirePi()
			return CompactResult{Outcome: "failed", Reason: "Pi compact response invalid: " + err.Error()}
		}
	}

	postCtx, postCancel := context.WithTimeout(ctx, piProbeBudget)
	err = p.probeIdle(postCtx)
	postCancel()
	if err != nil {
		s.retirePi()
		if ctx.Err() != nil {
			return compactContextResult(ctx)
		}
		return CompactResult{Outcome: "failed", Reason: err.Error()}
	}
	s.parkPiOrRetire()
	return CompactResult{Outcome: "compacted", PreTokens: data.TokensBefore}
}

// piCompactSessionFile validates the session transcript directory and prefers
// Pi's reported sessionFile when it is a regular JSONL transcript inside
// sessionDir belonging to the same session and working directory.
func piCompactSessionFile(sessionDir, sessionID, contextDir, reported string) (string, error) {
	fallback, err := piFindSessionFile(sessionDir, sessionID, contextDir)
	if err != nil {
		return "", err
	}
	if candidate := piSafeSessionFile(sessionDir, reported); candidate != "" {
		want, err := filepath.EvalSymlinks(contextDir)
		if err == nil && strings.HasSuffix(candidate, ".jsonl") && piSessionHeaderMatches(candidate, sessionID, want) {
			return candidate, nil
		}
	}
	return fallback, nil
}

// piSafeSessionFile returns reported only when it names a regular, non-symlink
// file located under sessionDir.
func piSafeSessionFile(sessionDir, reported string) string {
	reported = strings.TrimSpace(reported)
	if reported == "" || !filepath.IsAbs(reported) {
		return ""
	}
	info, err := os.Lstat(reported)
	if err != nil || !info.Mode().IsRegular() {
		return ""
	}
	resolvedDir, err := filepath.EvalSymlinks(sessionDir)
	if err != nil {
		return ""
	}
	resolvedParent, err := filepath.EvalSymlinks(filepath.Dir(reported))
	if err != nil {
		return ""
	}
	rel, err := filepath.Rel(resolvedDir, resolvedParent)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return ""
	}
	return filepath.Join(resolvedParent, filepath.Base(reported))
}
