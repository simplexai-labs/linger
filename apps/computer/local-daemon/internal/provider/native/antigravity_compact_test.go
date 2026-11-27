package native

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func takeParkedAntigravity(t *testing.T, contextKey string) *ParkedSession {
	t.Helper()
	session := TakeParkedSession("antigravity", contextKey)
	if session == nil {
		t.Fatalf("no parked antigravity session for %q", contextKey)
	}
	if TakeParkedSession("antigravity", contextKey) != nil {
		t.Fatal("a compacting antigravity process stayed in the resident table")
	}
	return session
}

func newAgyCompactHarness(t *testing.T, extra map[string]string) (*agyResidentHarness, string) {
	t.Helper()
	transcript := filepath.Join(t.TempDir(), "transcript.jsonl")
	env := map[string]string{agyFakeTranscriptEnv: transcript}
	for k, v := range extra {
		env[k] = v
	}
	return newAgyResidentHarness(t, "compact", env), transcript
}

func TestAntigravityCompactionParksTheProcessBack(t *testing.T) {
	h, _ := newAgyCompactHarness(t, nil)

	if TakeParkedSession("antigravity", h.profile.ContextKey) != nil {
		t.Fatal("took a session before any process was parked")
	}

	// An unadopted pre-start must never be taken for compaction.
	pre, err := h.runtime().Start(t.Context(), "", RunSpec{Dir: h.dir, PrepareOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, preOut := drainAgy(t, pre); preOut.Status != statusCompleted || !preOut.Parked {
		t.Fatalf("prestart=%+v", preOut)
	}
	if TakeParkedSession("antigravity", h.profile.ContextKey) != nil {
		t.Fatal("took an unadopted pre-start for compaction")
	}

	// Turn 1 adopts the pre-start, runs one turn, and parks the session.
	run1, err := h.runtime().Start(t.Context(), "turn one", RunSpec{Dir: h.dir, ExposeTurnStarted: true})
	if err != nil {
		t.Fatal(err)
	}
	_, out1 := drainAgy(t, run1)
	if out1.Status != statusCompleted || out1.SessionID != "fake-session" || out1.ExitConfirmed {
		t.Fatalf("turn1=%+v", out1)
	}

	if TakeParkedSession("antigravity", "ctx-other") != nil || TakeParkedSession("codex", h.profile.ContextKey) != nil {
		t.Fatal("took a process parked for another Context or Runtime")
	}

	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	result := takeParkedAntigravity(t, h.profile.ContextKey).CompactWithPrepare(ctx, "keep the open questions", nil)
	if result.Outcome != "compacted" || result.PreTokens == nil || *result.PreTokens != 12345 || result.Reason != "" {
		t.Fatalf("compaction=%+v", result)
	}

	prompts := h.requests()["session/prompt"]
	if len(prompts) != 2 {
		t.Fatalf("prompts=%d, want 2", len(prompts))
	}
	compactBlocks := prompts[1]["params"].(map[string]any)["prompt"].([]any)
	if got := compactBlocks[0].(map[string]any)["text"]; got != "/compact keep the open questions" {
		t.Fatalf("compaction prompt=%q, want %q", got, "/compact keep the open questions")
	}

	// Turn 2 reuses the same parked process.
	run2, err := h.runtime().Start(t.Context(), "turn two", RunSpec{
		Dir:               h.dir,
		ResumeID:          out1.SessionID,
		ExposeTurnStarted: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	events2, out2 := drainAgy(t, run2)
	if out2.Status != statusCompleted || events2[0].ProcessReused == nil || !*events2[0].ProcessReused || len(h.pids()) != 1 {
		t.Fatalf("turn2=%+v events0=%+v pids=%v", out2, events2[0], h.pids())
	}
}

func TestAntigravityCompactionNothingToCompactParksBack(t *testing.T) {
	h, _ := newAgyCompactHarness(t, map[string]string{agyFakeCompactModeEnv: "empty"})

	run1, err := h.runtime().Start(t.Context(), "turn one", RunSpec{Dir: h.dir})
	if err != nil {
		t.Fatal(err)
	}
	_, out1 := drainAgy(t, run1)
	if out1.Status != statusCompleted {
		t.Fatalf("turn1=%+v", out1)
	}

	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	result := takeParkedAntigravity(t, h.profile.ContextKey).CompactWithPrepare(ctx, "", nil)
	if result.Outcome != "nothing_to_compact" || result.PreTokens != nil || result.Reason != "" {
		t.Fatalf("compaction=%+v", result)
	}

	run2, err := h.runtime().Start(t.Context(), "turn two", RunSpec{
		Dir:               h.dir,
		ResumeID:          out1.SessionID,
		ExposeTurnStarted: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	events2, out2 := drainAgy(t, run2)
	if out2.Status != statusCompleted || events2[0].ProcessReused == nil || !*events2[0].ProcessReused || len(h.pids()) != 1 {
		t.Fatalf("turn2=%+v events0=%+v pids=%v", out2, events2[0], h.pids())
	}
}

func TestAntigravityCompactionUsesCompactionHookInitialStepsFallback(t *testing.T) {
	for _, tc := range []struct {
		name        string
		compactMode string
		wantOutcome string
	}{
		{name: "new_checkpoint_at_or_after_initial_steps", compactMode: "no-hook-on-normal", wantOutcome: "compacted"},
		{name: "only_older_checkpoint_before_initial_steps", compactMode: "no-hook-on-normal-empty", wantOutcome: "nothing_to_compact"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, transcript := newAgyCompactHarness(t, map[string]string{agyFakeCompactModeEnv: tc.compactMode})
			// Seed an older CHECKPOINT at step 0 before Turn 1 so the fallback must
			// distinguish it from a checkpoint written during compaction.
			agyFakeAppendJSONL(transcript, map[string]any{"step_index": 0, "type": "CHECKPOINT"})

			run1, err := h.runtime().Start(t.Context(), "turn one", RunSpec{Dir: h.dir})
			if err != nil {
				t.Fatal(err)
			}
			if _, out1 := drainAgy(t, run1); out1.Status != statusCompleted {
				t.Fatalf("turn1=%+v", out1)
			}

			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			result := takeParkedAntigravity(t, h.profile.ContextKey).CompactWithPrepare(ctx, "", nil)
			if result.Outcome != tc.wantOutcome {
				t.Fatalf("compaction=%+v, want outcome=%q", result, tc.wantOutcome)
			}
		})
	}
}

func TestAntigravityCompactionRefusesPermissions(t *testing.T) {
	for _, tc := range []struct {
		name        string
		compactMode string
		wantOutcome string
		wantOption  string
	}{
		{name: "selects_reject_once", compactMode: "permission", wantOutcome: "selected", wantOption: "deny"},
		{name: "cancels_without_reject_option", compactMode: "permission-no-reject", wantOutcome: "cancelled"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			permOut := filepath.Join(t.TempDir(), "perm.json")
			h, _ := newAgyCompactHarness(t, map[string]string{
				agyFakeCompactModeEnv:    tc.compactMode,
				agyFakeCompactPermOutEnv: permOut,
			})

			run1, err := h.runtime().Start(t.Context(), "turn one", RunSpec{Dir: h.dir})
			if err != nil {
				t.Fatal(err)
			}
			if _, out1 := drainAgy(t, run1); out1.Status != statusCompleted {
				t.Fatalf("turn1=%+v", out1)
			}

			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			result := takeParkedAntigravity(t, h.profile.ContextKey).CompactWithPrepare(ctx, "keep ids", nil)
			if result.Outcome != "compacted" {
				t.Fatalf("compaction=%+v", result)
			}

			raw, err := os.ReadFile(permOut)
			if err != nil {
				t.Fatalf("permission response file: %v", err)
			}
			var answer struct {
				Outcome struct {
					Outcome  string `json:"outcome"`
					OptionID string `json:"optionId"`
				} `json:"outcome"`
			}
			if err := json.Unmarshal(raw, &answer); err != nil {
				t.Fatalf("decode permission response %q: %v", raw, err)
			}
			if answer.Outcome.Outcome != tc.wantOutcome || answer.Outcome.OptionID != tc.wantOption {
				t.Fatalf("permission answer=%+v, want outcome=%q optionId=%q", answer.Outcome, tc.wantOutcome, tc.wantOption)
			}
		})
	}
}

func TestAntigravityCompactionCancelRetiresProcess(t *testing.T) {
	gate := filepath.Join(t.TempDir(), "compact-gate")
	h, _ := newAgyCompactHarness(t, map[string]string{
		agyFakeCompactModeEnv: "hang",
		agyFakeCompactGateEnv: gate,
	})

	run1, err := h.runtime().Start(t.Context(), "turn one", RunSpec{Dir: h.dir})
	if err != nil {
		t.Fatal(err)
	}
	_, out1 := drainAgy(t, run1)
	if out1.Status != statusCompleted {
		t.Fatalf("turn1=%+v", out1)
	}

	session := takeParkedAntigravity(t, h.profile.ContextKey)
	proc := session.antigravity
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan CompactResult, 1)
	go func() { done <- session.CompactWithPrepare(ctx, "hang", nil) }()

	awaitTrue(t, "compaction reached fake", 10*time.Second, func() bool {
		_, err := os.Stat(gate + ".started")
		return err == nil
	})
	cancel()

	select {
	case result := <-done:
		if result.Outcome != "canceled" {
			t.Fatalf("canceled compaction=%+v", result)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("canceled compaction did not return")
	}

	// Process must be retired before Compact returns and session/cancel sent.
	if proc.alive() || ContextHasParkedResident(h.profile.ContextKey) {
		t.Fatalf("canceled compaction left process alive=%v parked=%v", proc.alive(), ContextHasParkedResident(h.profile.ContextKey))
	}
	if len(h.requests()["session/cancel"]) == 0 {
		t.Fatalf("expected session/cancel on cancellation, requests=%v", h.requests())
	}

	run2, err := h.runtime().Start(t.Context(), "turn two", RunSpec{
		Dir:               h.dir,
		ResumeID:          out1.SessionID,
		ExposeTurnStarted: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	events2, out2 := drainAgy(t, run2)
	if out2.Status != statusCompleted || events2[0].ProcessReused == nil || *events2[0].ProcessReused || len(h.pids()) != 2 {
		t.Fatalf("turn2=%+v events0=%+v pids=%v", out2, events2[0], h.pids())
	}
}

func TestAntigravityCompactionFenceInvalidationRetires(t *testing.T) {
	gate := filepath.Join(t.TempDir(), "fence-gate")
	h, _ := newAgyCompactHarness(t, map[string]string{
		agyFakeCompactGateEnv: gate,
	})

	run1, err := h.runtime().Start(t.Context(), "turn one", RunSpec{Dir: h.dir})
	if err != nil {
		t.Fatal(err)
	}
	_, out1 := drainAgy(t, run1)
	if out1.Status != statusCompleted {
		t.Fatalf("turn1=%+v", out1)
	}

	session := takeParkedAntigravity(t, h.profile.ContextKey)
	proc := session.antigravity
	done := make(chan CompactResult, 1)
	go func() {
		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		done <- session.CompactWithPrepare(ctx, "keep ids", nil)
	}()

	awaitTrue(t, "compaction reached gate", 10*time.Second, func() bool {
		_, err := os.Stat(gate + ".started")
		return err == nil
	})

	// Advance the Context's release fence while compaction is in flight.
	if count, err := StopParkedResidentsForContext(h.profile.ContextKey); count != 0 || err != nil {
		t.Fatalf("StopParkedResidentsForContext=%d err=%v", count, err)
	}
	if err := os.WriteFile(gate, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	select {
	case result := <-done:
		if result.Outcome != "compacted" {
			t.Fatalf("fence-invalidated compaction=%+v", result)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("fence-invalidated compaction did not return")
	}

	if proc.alive() || ContextHasParkedResident(h.profile.ContextKey) {
		t.Fatalf("fence-invalidated compaction failed to retire: alive=%v parked=%v", proc.alive(), ContextHasParkedResident(h.profile.ContextKey))
	}
}

func TestAntigravityCompactionOpenToolAndMissingTranscriptRetire(t *testing.T) {
	t.Run("open_tool_retires", func(t *testing.T) {
		h, _ := newAgyCompactHarness(t, map[string]string{agyFakeCompactModeEnv: "open-tool"})
		run1, err := h.runtime().Start(t.Context(), "turn one", RunSpec{Dir: h.dir})
		if err != nil {
			t.Fatal(err)
		}
		if _, out1 := drainAgy(t, run1); out1.Status != statusCompleted {
			t.Fatalf("turn1=%+v", out1)
		}
		session := takeParkedAntigravity(t, h.profile.ContextKey)
		proc := session.antigravity
		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		result := session.CompactWithPrepare(ctx, "", nil)
		if result.Outcome != "compacted" {
			t.Fatalf("compaction=%+v", result)
		}
		if proc.alive() || ContextHasParkedResident(h.profile.ContextKey) {
			t.Fatalf("open tool during compaction must retire: alive=%v parked=%v", proc.alive(), ContextHasParkedResident(h.profile.ContextKey))
		}
	})

	t.Run("missing_transcript_fails_and_retires", func(t *testing.T) {
		h, _ := newAgyCompactHarness(t, map[string]string{agyFakeCompactModeEnv: "no-transcript"})
		run1, err := h.runtime().Start(t.Context(), "turn one", RunSpec{Dir: h.dir})
		if err != nil {
			t.Fatal(err)
		}
		if _, out1 := drainAgy(t, run1); out1.Status != statusCompleted {
			t.Fatalf("turn1=%+v", out1)
		}
		session := takeParkedAntigravity(t, h.profile.ContextKey)
		proc := session.antigravity
		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		result := session.CompactWithPrepare(ctx, "", nil)
		if result.Outcome != "failed" || proc.alive() || ContextHasParkedResident(h.profile.ContextKey) {
			t.Fatalf("missing transcript result=%+v alive=%v parked=%v", result, proc.alive(), ContextHasParkedResident(h.profile.ContextKey))
		}
	})
}

func TestInspectAntigravityCheckpointsHandlesLongLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "large.jsonl")
	huge := `{"step_index":1,"type":"MODEL_OUTPUT","payload":"` + strings.Repeat("a", 2<<20) + `"}`
	content := strings.Join([]string{
		`{"step_index":0,"type":"CHECKPOINT"}`,
		huge,
		`{"step_index":2,"type":"CHECKPOINT"}`,
	}, "\n")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	count, _, ok := inspectAntigravityCheckpoints(path, nil)
	if !ok || count != 2 {
		t.Fatalf("count=%d ok=%v, want count=2 ok=true", count, ok)
	}
}

func TestAntigravityCompactionTranscriptPathChangeUsesHookInitialSteps(t *testing.T) {
	for _, tc := range []struct {
		name        string
		compactMode string
		wantOutcome string
	}{
		{name: "no_new_checkpoint_on_new_path", compactMode: "empty", wantOutcome: "nothing_to_compact"},
		{name: "new_checkpoint_at_initial_steps_on_new_path", compactMode: "", wantOutcome: "compacted"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pathB := filepath.Join(t.TempDir(), "transcript-b.jsonl")
			// Seed pathB with a historical CHECKPOINT at step 0 before compaction.
			agyFakeAppendJSONL(pathB, map[string]any{"step_index": 0, "type": "CHECKPOINT"})
			h, pathA := newAgyCompactHarness(t, map[string]string{
				agyFakeCompactTranscriptEnv:   pathB,
				agyFakeCompactInitialStepsEnv: "5",
				agyFakeCompactModeEnv:         tc.compactMode,
			})

			run1, err := h.runtime().Start(t.Context(), "turn one", RunSpec{Dir: h.dir})
			if err != nil {
				t.Fatal(err)
			}
			if _, out1 := drainAgy(t, run1); out1.Status != statusCompleted {
				t.Fatalf("turn1=%+v", out1)
			}

			// Verify Turn 1 recorded pathA (so baselineOK starts true on pathA).
			session := takeParkedAntigravity(t, h.profile.ContextKey)
			session.antigravity.mu.Lock()
			initialPath := session.antigravity.transcriptPath
			session.antigravity.mu.Unlock()
			if initialPath != pathA {
				t.Fatalf("initial transcriptPath=%q, want %q", initialPath, pathA)
			}

			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			result := session.CompactWithPrepare(ctx, "", nil)
			if result.Outcome != tc.wantOutcome {
				t.Fatalf("compaction=%+v, want outcome=%q", result, tc.wantOutcome)
			}
			if !ContextHasParkedResident(h.profile.ContextKey) {
				t.Fatal("process should park back after verified compaction on changed transcript path")
			}
		})
	}
}

func TestAntigravityCompactionWithoutBaselineOrInitialStepsFailsClosedOnHistoricalCheckpoints(t *testing.T) {
	t.Run("zero_checkpoints_is_nothing_to_compact_and_parks", func(t *testing.T) {
		h, _ := newAgyCompactHarness(t, map[string]string{
			agyFakeCompactModeEnv:         "no-hook-on-normal-empty",
			agyFakeCompactInitialStepsEnv: "omit",
		})
		run1, err := h.runtime().Start(t.Context(), "turn one", RunSpec{Dir: h.dir})
		if err != nil {
			t.Fatal(err)
		}
		if _, out1 := drainAgy(t, run1); out1.Status != statusCompleted {
			t.Fatalf("turn1=%+v", out1)
		}

		session := takeParkedAntigravity(t, h.profile.ContextKey)
		proc := session.antigravity
		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		result := session.CompactWithPrepare(ctx, "", nil)
		if result.Outcome != "nothing_to_compact" || result.PreTokens != nil {
			t.Fatalf("compaction=%+v, want nothing_to_compact", result)
		}
		if !proc.alive() || !ContextHasParkedResident(h.profile.ContextKey) {
			t.Fatalf("expected process parked back: alive=%v parked=%v", proc.alive(), ContextHasParkedResident(h.profile.ContextKey))
		}
	})

	t.Run("historical_checkpoint_fails_and_retires", func(t *testing.T) {
		h, transcript := newAgyCompactHarness(t, map[string]string{
			agyFakeCompactModeEnv:         "no-hook-on-normal-empty",
			agyFakeCompactInitialStepsEnv: "omit",
		})
		agyFakeAppendJSONL(transcript, map[string]any{"step_index": 0, "type": "CHECKPOINT"})

		run1, err := h.runtime().Start(t.Context(), "turn one", RunSpec{Dir: h.dir})
		if err != nil {
			t.Fatal(err)
		}
		if _, out1 := drainAgy(t, run1); out1.Status != statusCompleted {
			t.Fatalf("turn1=%+v", out1)
		}

		session := takeParkedAntigravity(t, h.profile.ContextKey)
		proc := session.antigravity
		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		result := session.CompactWithPrepare(ctx, "", nil)
		if result.Outcome != "failed" || result.Reason != "Antigravity compaction could not be verified without a transcript baseline" {
			t.Fatalf("compaction=%+v, want fail-closed baseline verification error", result)
		}
		if proc.alive() || ContextHasParkedResident(h.profile.ContextKey) {
			t.Fatalf("expected unverified compaction to retire process: alive=%v parked=%v", proc.alive(), ContextHasParkedResident(h.profile.ContextKey))
		}
	})
}

func TestAntigravityCompactionSkipsPromptWhenTranscriptAndHookEndpointUnavailable(t *testing.T) {
	h, _ := newAgyCompactHarness(t, map[string]string{agyFakeCompactModeEnv: "no-transcript"})
	run1, err := h.runtime().Start(t.Context(), "turn one", RunSpec{Dir: h.dir})
	if err != nil {
		t.Fatal(err)
	}
	if _, out1 := drainAgy(t, run1); out1.Status != statusCompleted {
		t.Fatalf("turn1=%+v", out1)
	}

	session := takeParkedAntigravity(t, h.profile.ContextKey)
	proc := session.antigravity
	proc.hookEP = nil

	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	result := session.CompactWithPrepare(ctx, "keep ids", nil)
	if result.Outcome != "failed" || result.Reason != "Antigravity compaction transcript was unavailable" {
		t.Fatalf("compaction=%+v", result)
	}
	if proc.alive() || ContextHasParkedResident(h.profile.ContextKey) {
		t.Fatalf("expected retirement: alive=%v parked=%v", proc.alive(), ContextHasParkedResident(h.profile.ContextKey))
	}
	if prompts := h.requests()["session/prompt"]; len(prompts) != 1 {
		t.Fatalf("expected no compaction session/prompt to be sent, got %d prompts", len(prompts))
	}
}

func TestAntigravityCompactionPreCanceledContextRetiresWithoutPrompt(t *testing.T) {
	for _, tc := range []struct {
		name        string
		makeCtx     func() (context.Context, context.CancelFunc)
		wantOutcome string
		wantReason  string
	}{
		{
			name: "canceled",
			makeCtx: func() (context.Context, context.CancelFunc) {
				ctx, cancel := context.WithCancel(t.Context())
				cancel()
				return ctx, cancel
			},
			wantOutcome: "canceled",
			wantReason:  "Session compaction canceled",
		},
		{
			name: "deadline_exceeded",
			makeCtx: func() (context.Context, context.CancelFunc) {
				return context.WithDeadline(t.Context(), time.Now().Add(-time.Second))
			},
			wantOutcome: "failed",
			wantReason:  "Session compaction deadline exceeded",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, _ := newAgyCompactHarness(t, nil)
			run1, err := h.runtime().Start(t.Context(), "turn one", RunSpec{Dir: h.dir})
			if err != nil {
				t.Fatal(err)
			}
			if _, out1 := drainAgy(t, run1); out1.Status != statusCompleted {
				t.Fatalf("turn1=%+v", out1)
			}

			session := takeParkedAntigravity(t, h.profile.ContextKey)
			proc := session.antigravity
			ctx, cancel := tc.makeCtx()
			defer cancel()

			result := session.CompactWithPrepare(ctx, "keep ids", nil)
			if result.Outcome != tc.wantOutcome || result.Reason != tc.wantReason {
				t.Fatalf("compaction=%+v, want outcome=%q reason=%q", result, tc.wantOutcome, tc.wantReason)
			}
			if proc.alive() || ContextHasParkedResident(h.profile.ContextKey) {
				t.Fatalf("expected retirement: alive=%v parked=%v", proc.alive(), ContextHasParkedResident(h.profile.ContextKey))
			}
			if prompts := h.requests()["session/prompt"]; len(prompts) != 1 {
				t.Fatalf("expected no compaction session/prompt to be sent, got %d prompts", len(prompts))
			}
		})
	}
}

func TestScanAntigravityTranscriptRejectsSymlinks(t *testing.T) {
	storeRoot := t.TempDir()
	sessionID := "agy-sym-compact"
	logsDir := filepath.Join(storeRoot, "brain", sessionID, ".system_generated", "logs")
	if err := os.MkdirAll(logsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	canonical := filepath.Join(logsDir, "transcript.jsonl")
	if err := os.WriteFile(canonical, []byte(`{"step_index":2,"type":"CHECKPOINT"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if count, _, ok := inspectAntigravityCheckpointsInStore(canonical, storeRoot, sessionID, nil); !ok || count != 1 {
		t.Fatalf("canonical transcript = (%d, %v), want (1, true)", count, ok)
	}
	if runtime.GOOS == "windows" {
		return
	}

	// Reject a symlinked intermediate directory when matching the canonical store layout.
	outside := t.TempDir()
	outsideFile := filepath.Join(outside, "transcript.jsonl")
	if err := os.WriteFile(outsideFile, []byte(`{"step_index":1,"type":"CHECKPOINT"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	symRoot := t.TempDir()
	if err := os.MkdirAll(filepath.Join(symRoot, "brain", sessionID, ".system_generated"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(symRoot, "brain", sessionID, ".system_generated", "logs")); err != nil {
		t.Fatal(err)
	}
	symCanonical := filepath.Join(symRoot, "brain", sessionID, ".system_generated", "logs", "transcript.jsonl")
	if count, _, ok := inspectAntigravityCheckpointsInStore(symCanonical, symRoot, sessionID, nil); ok || count != 0 {
		t.Fatalf("symlinked store dir = (%d, %v), want (0, false)", count, ok)
	}

	// Reject a symlinked transcript file on direct path scans too.
	directLink := filepath.Join(t.TempDir(), "transcript.jsonl")
	if err := os.Symlink(outsideFile, directLink); err != nil {
		t.Fatal(err)
	}
	if count, _, ok := inspectAntigravityCheckpointsInStore(directLink, "", "", nil); ok || count != 0 {
		t.Fatalf("symlinked direct path = (%d, %v), want (0, false)", count, ok)
	}
}
