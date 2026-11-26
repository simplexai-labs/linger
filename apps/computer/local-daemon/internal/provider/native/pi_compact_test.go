package native

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func piTakeParkedForTest(t *testing.T, contextKey string) *ParkedSession {
	t.Helper()
	session := TakeParkedSession("pi", contextKey)
	if session == nil {
		t.Fatalf("no parked pi session to compact for %s", contextKey)
	}
	if TakeParkedSession("pi", contextKey) != nil {
		t.Fatal("a compacting Pi process stayed in the resident table")
	}
	return session
}

func piEventReused(events []Event) (bool, bool) {
	for _, event := range events {
		if event.Kind == EventStatus && event.ProcessReused != nil {
			return *event.ProcessReused, true
		}
	}
	return false, false
}

func piWriteAgentSettings(t *testing.T, agentDir, content string) {
	t.Helper()
	path := filepath.Join(agentDir, "settings.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func piNewCompactableAgentDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	piWriteAgentSettings(t, dir, `{"compaction":{"keepRecentTokens":0}}`)
	return dir
}

func piWriteProjectSettings(t *testing.T, contextDir, content string) {
	t.Helper()
	path := filepath.Join(contextDir, ".pi", "settings.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func piWriteJSONLLines(t *testing.T, path string, lines []map[string]any) {
	t.Helper()
	var buf strings.Builder
	for _, entry := range lines {
		encoded, err := json.Marshal(entry)
		if err != nil {
			t.Fatal(err)
		}
		buf.Write(encoded)
		buf.WriteByte('\n')
	}
	if err := os.WriteFile(path, []byte(buf.String()), 0o600); err != nil {
		t.Fatal(err)
	}
}

func piLastJSONLID(t *testing.T, path string) string {
	t.Helper()
	entries, err := piReadSessionEntries(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) == 0 {
		t.Fatalf("no entries in %s", path)
	}
	return entries[len(entries)-1].ID
}

func piAppendJSONLLines(t *testing.T, path string, lines []map[string]any) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	for _, entry := range lines {
		encoded, err := json.Marshal(entry)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write(append(encoded, '\n')); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPiCompactionParksTheProcessBack(t *testing.T) {
	instructionsFile := filepath.Join(t.TempDir(), "compact-instructions")
	h := piNewResidentHome(t, map[string]string{
		piResidentCompactInstructionsEnv: instructionsFile,
		"PI_CODING_AGENT_DIR":            piNewCompactableAgentDir(t),
	})
	const sessionID = "pi-compact-park"
	const modelID = "localmodels-library/fixture-model"

	if TakeParkedSession("pi", h.profile.ContextKey) != nil {
		t.Fatal("took a session before any process was parked")
	}

	// An unadopted pre-start has no conversation to compact and must be skipped.
	prestartOut := h.prestart(RunSpec{AssignSessionID: sessionID, Model: modelID})
	if prestartOut.Status != statusCompleted || !prestartOut.Parked {
		t.Fatalf("prestart = %+v", prestartOut)
	}
	if TakeParkedSession("pi", h.profile.ContextKey) != nil {
		t.Fatal("took an unadopted Pi pre-start for compaction")
	}

	// Turn 1 adopts the pre-start and parks a real conversation.
	events1, out1 := h.turn("one", RunSpec{AssignSessionID: sessionID, Model: modelID})
	if out1.Status != statusCompleted {
		t.Fatalf("turn 1 = %+v", out1)
	}
	if reused, ok := piEventReused(events1); !ok || !reused {
		t.Fatalf("turn 1 did not adopt pre-start: events=%+v", events1)
	}
	proc := h.parked(sessionID)
	if proc == nil {
		t.Fatal("turn 1 did not park Pi process")
	}

	// Must not take from another context or another runtime.
	if TakeParkedSession("pi", "ctx-other") != nil || TakeParkedSession("claude", h.profile.ContextKey) != nil {
		t.Fatal("took a Pi process parked for another Context or Runtime")
	}

	session := piTakeParkedForTest(t, h.profile.ContextKey)
	var preparedModel string
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	result := session.CompactWithPrepare(ctx, "  keep open questions  ", func(_ context.Context, gotModel string) error {
		preparedModel = gotModel
		return nil
	})
	if result.Outcome != "compacted" || result.PreTokens == nil || *result.PreTokens != 32100 || result.Reason != "" {
		t.Fatalf("compaction = %+v", result)
	}
	if preparedModel != modelID {
		t.Fatalf("prepare modelID = %q, want %q", preparedModel, modelID)
	}
	gotInstructions, err := os.ReadFile(instructionsFile)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotInstructions) != "keep open questions" {
		t.Fatalf("customInstructions = %q, want %q", string(gotInstructions), "keep open questions")
	}
	if h.parked(sessionID) != proc {
		t.Fatal("compacted Pi process was not parked back")
	}

	// Turn 2 reuses the compacted process with a single spawn overall.
	events2, out2 := h.turn("two", RunSpec{ResumeID: sessionID, Model: modelID})
	reused, ok := piEventReused(events2)
	if out2.Status != statusCompleted || !ok || !reused || h.lines("spawn") != 1 {
		t.Fatalf("turn 2 = %+v reused=(%v,%v) spawns=%d", out2, reused, ok, h.lines("spawn"))
	}
}

func TestPiCompactionSmallSessionUnderDefaultBudgetSkipsPrepareAndCompact(t *testing.T) {
	// Default keepRecentTokens (20000) is far larger than a short turn.
	h := piNewResidentHome(t, map[string]string{"PI_CODING_AGENT_DIR": t.TempDir()})
	const sessionID = "pi-compact-small"
	proc := h.createParked(sessionID, RunSpec{})

	var prepareCalls atomic.Int32
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	result := piTakeParkedForTest(t, h.profile.ContextKey).CompactWithPrepare(ctx, "summarize", func(context.Context, string) error {
		prepareCalls.Add(1)
		return nil
	})
	if result.Outcome != "nothing_to_compact" || result.PreTokens != nil || result.Reason != "" {
		t.Fatalf("small session compaction = %+v, want nothing_to_compact", result)
	}
	if prepareCalls.Load() != 0 || h.lines("compact") != 0 {
		t.Fatalf("prepareCalls=%d compacts=%d, want 0/0", prepareCalls.Load(), h.lines("compact"))
	}
	if h.parked(sessionID) != proc {
		t.Fatal("small session process was not parked back")
	}

	events, out := h.turn("next", RunSpec{ResumeID: sessionID})
	reused, ok := piEventReused(events)
	if out.Status != statusCompleted || !ok || !reused || h.lines("spawn") != 1 {
		t.Fatalf("turn after small nothing_to_compact = %+v reused=(%v,%v) spawns=%d", out, reused, ok, h.lines("spawn"))
	}
}

func TestPiCompactionIgnoresProjectSettings(t *testing.T) {
	const modelID = "localmodels-library/fixture-model"

	t.Run("project keepRecentTokens zero does not override default 20000", func(t *testing.T) {
		h := piNewResidentHome(t, map[string]string{"PI_CODING_AGENT_DIR": t.TempDir()})
		piWriteProjectSettings(t, h.dir, `{
			"compaction": {
				"keepRecentTokens": 0,
				"modelOverrides": {
					"localmodels-library/fixture-model": { "keepRecentTokens": 0 }
				}
			}
		}`)
		const sessionID = "pi-compact-ignore-project-zero"
		proc := h.createParked(sessionID, RunSpec{Model: modelID})

		var prepareCalls atomic.Int32
		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		result := piTakeParkedForTest(t, h.profile.ContextKey).CompactWithPrepare(ctx, "summarize", func(context.Context, string) error {
			prepareCalls.Add(1)
			return nil
		})
		if result.Outcome != "nothing_to_compact" || result.PreTokens != nil || result.Reason != "" {
			t.Fatalf("compaction = %+v, want nothing_to_compact", result)
		}
		if prepareCalls.Load() != 0 || h.lines("compact") != 0 {
			t.Fatalf("prepareCalls=%d compacts=%d, want 0/0", prepareCalls.Load(), h.lines("compact"))
		}
		if h.parked(sessionID) != proc {
			t.Fatal("process was not parked back when project settings were ignored")
		}
	})

	t.Run("project keepRecentTokens zero does not override global agent settings", func(t *testing.T) {
		agentDir := t.TempDir()
		piWriteAgentSettings(t, agentDir, `{"compaction":{"keepRecentTokens":5000}}`)
		h := piNewResidentHome(t, map[string]string{"PI_CODING_AGENT_DIR": agentDir})
		piWriteProjectSettings(t, h.dir, `{"compaction":{"keepRecentTokens":0}}`)
		const sessionID = "pi-compact-ignore-project-over-global"
		proc := h.createParked(sessionID, RunSpec{Model: modelID})

		var prepareCalls atomic.Int32
		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		result := piTakeParkedForTest(t, h.profile.ContextKey).CompactWithPrepare(ctx, "", func(context.Context, string) error {
			prepareCalls.Add(1)
			return nil
		})
		if result.Outcome != "nothing_to_compact" || prepareCalls.Load() != 0 || h.lines("compact") != 0 {
			t.Fatalf("compaction = %+v prepareCalls=%d compacts=%d", result, prepareCalls.Load(), h.lines("compact"))
		}
		if h.parked(sessionID) != proc {
			t.Fatal("process was not parked back when global budget exceeded session size")
		}
	})

	t.Run("large project keepRecentTokens does not block global zero budget", func(t *testing.T) {
		h := piNewResidentHome(t, map[string]string{"PI_CODING_AGENT_DIR": piNewCompactableAgentDir(t)})
		piWriteProjectSettings(t, h.dir, `{
			"compaction": {
				"keepRecentTokens": 999999,
				"modelOverrides": {
					"localmodels-library/fixture-model": { "keepRecentTokens": 999999 }
				}
			}
		}`)
		const sessionID = "pi-compact-ignore-project-large"
		proc := h.createParked(sessionID, RunSpec{Model: modelID})

		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		result := piTakeParkedForTest(t, h.profile.ContextKey).CompactWithPrepare(ctx, "", nil)
		if result.Outcome != "compacted" || h.lines("compact") != 1 {
			t.Fatalf("compaction = %+v compacts=%d, want compacted/1", result, h.lines("compact"))
		}
		if h.parked(sessionID) != proc {
			t.Fatal("process was not parked back after compacting under global zero budget")
		}
	})
}

func TestPiCompactionSnapshotsSettingsAtLaunch(t *testing.T) {
	t.Run("settings edit from 20000 to 0 after launch does not change snapshotted budget", func(t *testing.T) {
		agentDir := t.TempDir()
		piWriteAgentSettings(t, agentDir, `{"compaction":{"keepRecentTokens":20000}}`)
		h := piNewResidentHome(t, map[string]string{"PI_CODING_AGENT_DIR": agentDir})
		const sessionID = "pi-compact-snapshot-20000"
		proc := h.createParked(sessionID, RunSpec{})

		// Mutate global settings.json after Pi has already launched and parked.
		piWriteAgentSettings(t, agentDir, `{"compaction":{"keepRecentTokens":0}}`)

		var prepareCalls atomic.Int32
		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		result := piTakeParkedForTest(t, h.profile.ContextKey).CompactWithPrepare(ctx, "", func(context.Context, string) error {
			prepareCalls.Add(1)
			return nil
		})
		if result.Outcome != "nothing_to_compact" || prepareCalls.Load() != 0 || h.lines("compact") != 0 {
			t.Fatalf("compaction = %+v prepareCalls=%d compacts=%d, want nothing_to_compact/0/0", result, prepareCalls.Load(), h.lines("compact"))
		}
		if h.parked(sessionID) != proc {
			t.Fatal("process was not parked back under snapshotted 20000 budget")
		}
	})

	t.Run("settings edit from 0 to 20000 after launch keeps snapshotted zero budget", func(t *testing.T) {
		agentDir := t.TempDir()
		piWriteAgentSettings(t, agentDir, `{"compaction":{"keepRecentTokens":0}}`)
		h := piNewResidentHome(t, map[string]string{"PI_CODING_AGENT_DIR": agentDir})
		const sessionID = "pi-compact-snapshot-0"
		proc := h.createParked(sessionID, RunSpec{})

		piWriteAgentSettings(t, agentDir, `{"compaction":{"keepRecentTokens":20000}}`)

		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		result := piTakeParkedForTest(t, h.profile.ContextKey).CompactWithPrepare(ctx, "", nil)
		if result.Outcome != "compacted" || h.lines("compact") != 1 {
			t.Fatalf("compaction = %+v compacts=%d, want compacted/1", result, h.lines("compact"))
		}
		if h.parked(sessionID) != proc {
			t.Fatal("process was not parked back under snapshotted 0 budget")
		}
	})
}

func TestPiCompactionPostCompactionMetadataReturnsNothingToCompact(t *testing.T) {
	h := piNewResidentHome(t, map[string]string{"PI_CODING_AGENT_DIR": piNewCompactableAgentDir(t)})
	const sessionID = "pi-compact-post-meta"
	proc := h.createParked(sessionID, RunSpec{})

	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	first := piTakeParkedForTest(t, h.profile.ContextKey).CompactWithPrepare(ctx, "", nil)
	if first.Outcome != "compacted" || h.lines("compact") != 1 {
		t.Fatalf("first = %+v compacts=%d", first, h.lines("compact"))
	}

	// Append non-message metadata entries after the compaction entry so the
	// last JSONL line is not type "compaction", yet zero new context messages exist.
	sessionFile := filepath.Join(h.sessionDir(sessionID), "fixture_"+sessionID+".jsonl")
	parent := piLastJSONLID(t, sessionFile)
	piAppendJSONLLines(t, sessionFile, []map[string]any{
		{"type": "thinking_level_change", "id": "meta-1", "parentId": parent, "thinkingLevel": "high"},
		{"type": "model_change", "id": "meta-2", "parentId": "meta-1", "provider": "p", "modelId": "m"},
		{"type": "session_info", "id": "meta-3", "parentId": "meta-2", "name": "renamed"},
		{"type": "label", "id": "meta-4", "parentId": "meta-3", "targetId": parent, "label": "checkpoint"},
		{"type": "usage", "id": "meta-5", "parentId": "meta-4", "tokens": 100},
		{"type": "custom", "id": "meta-6", "parentId": "meta-5", "customType": "note", "data": map[string]any{"k": "v"}},
	})

	var prepareCalls atomic.Int32
	second := piTakeParkedForTest(t, h.profile.ContextKey).CompactWithPrepare(ctx, "", func(context.Context, string) error {
		prepareCalls.Add(1)
		return nil
	})
	if second.Outcome != "nothing_to_compact" || second.PreTokens != nil || second.Reason != "" {
		t.Fatalf("post-metadata compaction = %+v, want nothing_to_compact", second)
	}
	if prepareCalls.Load() != 0 || h.lines("compact") != 1 {
		t.Fatalf("prepareCalls=%d compacts=%d, want 0/1", prepareCalls.Load(), h.lines("compact"))
	}
	if h.parked(sessionID) != proc {
		t.Fatal("process was not parked back after post-metadata nothing_to_compact")
	}
}

func TestPiCompactionNothingToCompactWhenAlreadyCompactedOrEmpty(t *testing.T) {
	t.Run("already compacted", func(t *testing.T) {
		h := piNewResidentHome(t, map[string]string{"PI_CODING_AGENT_DIR": piNewCompactableAgentDir(t)})
		const sessionID = "pi-compact-repeat"
		proc := h.createParked(sessionID, RunSpec{})

		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		first := piTakeParkedForTest(t, h.profile.ContextKey).CompactWithPrepare(ctx, "summarize", nil)
		if first.Outcome != "compacted" || h.lines("compact") != 1 {
			t.Fatalf("first = %+v compacts=%d", first, h.lines("compact"))
		}

		var prepareCalls atomic.Int32
		second := piTakeParkedForTest(t, h.profile.ContextKey).CompactWithPrepare(ctx, "summarize again", func(context.Context, string) error {
			prepareCalls.Add(1)
			return nil
		})
		if second.Outcome != "nothing_to_compact" || second.PreTokens != nil || second.Reason != "" {
			t.Fatalf("second = %+v, want nothing_to_compact", second)
		}
		if prepareCalls.Load() != 0 || h.lines("compact") != 1 {
			t.Fatalf("prepareCalls=%d compacts=%d, want 0/1", prepareCalls.Load(), h.lines("compact"))
		}
		if h.parked(sessionID) != proc {
			t.Fatal("process was not parked back after nothing_to_compact")
		}

		events, out := h.turn("after", RunSpec{ResumeID: sessionID})
		reused, ok := piEventReused(events)
		if out.Status != statusCompleted || !ok || !reused || h.lines("spawn") != 1 {
			t.Fatalf("turn after nothing_to_compact = %+v reused=(%v,%v) spawns=%d", out, reused, ok, h.lines("spawn"))
		}
	})

	t.Run("already compacted after long transcript line", func(t *testing.T) {
		h := piNewResidentHome(t, map[string]string{"PI_CODING_AGENT_DIR": piNewCompactableAgentDir(t)})
		const sessionID = "pi-compact-long-line"
		h.createParked(sessionID, RunSpec{})

		sessionFile := filepath.Join(h.sessionDir(sessionID), "fixture_"+sessionID+".jsonl")
		parent := piLastJSONLID(t, sessionFile)
		piAppendJSONLLines(t, sessionFile, []map[string]any{
			{
				"type":     "message",
				"id":       "long-1",
				"parentId": parent,
				"message":  map[string]any{"role": "toolResult", "content": []any{map[string]any{"type": "text", "text": strings.Repeat("x", 128<<10)}}},
			},
			{
				"type":             "compaction",
				"id":               "comp-long",
				"parentId":         "long-1",
				"summary":          "done",
				"firstKeptEntryId": "long-1",
				"tokensBefore":     40000,
			},
		})

		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		result := piTakeParkedForTest(t, h.profile.ContextKey).CompactWithPrepare(ctx, "", nil)
		if result.Outcome != "nothing_to_compact" || h.lines("compact") != 0 {
			t.Fatalf("result = %+v compacts=%d", result, h.lines("compact"))
		}
	})

	t.Run("messageCount zero", func(t *testing.T) {
		h := piNewResidentHome(t, map[string]string{
			piResidentMessageCountEnv: "0",
			"PI_CODING_AGENT_DIR":     piNewCompactableAgentDir(t),
		})
		const sessionID = "pi-compact-empty"
		proc := h.createParked(sessionID, RunSpec{})

		var prepareCalls atomic.Int32
		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		result := piTakeParkedForTest(t, h.profile.ContextKey).CompactWithPrepare(ctx, "ignored", func(context.Context, string) error {
			prepareCalls.Add(1)
			return nil
		})
		if result.Outcome != "nothing_to_compact" || result.PreTokens != nil || prepareCalls.Load() != 0 || h.lines("compact") != 0 {
			t.Fatalf("empty session compaction = %+v prepareCalls=%d compacts=%d", result, prepareCalls.Load(), h.lines("compact"))
		}
		if h.parked(sessionID) != proc {
			t.Fatal("process was not parked back after empty nothing_to_compact")
		}

		events, out := h.turn("after", RunSpec{ResumeID: sessionID})
		reused, ok := piEventReused(events)
		if out.Status != statusCompleted || !ok || !reused || h.lines("spawn") != 1 {
			t.Fatalf("turn after empty nothing_to_compact = %+v reused=(%v,%v) spawns=%d", out, reused, ok, h.lines("spawn"))
		}
	})
}

func TestPiCompactionCancelAbortsAndRetires(t *testing.T) {
	h := piNewResidentHome(t, map[string]string{
		piResidentCompactModeEnv: "hang",
		"PI_CODING_AGENT_DIR":    piNewCompactableAgentDir(t),
	})
	const sessionID = "pi-compact-cancel"
	proc := h.createParked(sessionID, RunSpec{})

	session := piTakeParkedForTest(t, h.profile.ContextKey)
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan CompactResult, 1)
	go func() { done <- session.CompactWithPrepare(ctx, "slow", nil) }()

	awaitTrue(t, "Pi compact RPC started", 10*time.Second, func() bool { return h.lines("compact") == 1 })
	cancel()

	select {
	case result := <-done:
		if result.Outcome != "canceled" {
			t.Fatalf("canceled compaction = %+v", result)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("canceled Pi compaction did not return")
	}

	if h.lines("abort") != 1 {
		t.Fatalf("abort count = %d, want 1", h.lines("abort"))
	}
	if !piProcessGone(proc.pid) {
		t.Fatalf("canceled Pi process pid %d is still alive after Compact returned", proc.pid)
	}
	if TakeParkedSession("pi", h.profile.ContextKey) != nil {
		t.Fatal("canceled Pi process remained parked")
	}
	h.assertLockFree(sessionID)

	events, out := h.turn("two", RunSpec{ResumeID: sessionID})
	reused, ok := piEventReused(events)
	if out.Status != statusCompleted || !ok || reused || h.lines("spawn") != 2 {
		t.Fatalf("turn after canceled compaction = %+v reused=(%v,%v) spawns=%d", out, reused, ok, h.lines("spawn"))
	}
}

func TestPiCompactionFailureBehavior(t *testing.T) {
	t.Run("clean RPC rejection while still idle parks healthy process back", func(t *testing.T) {
		h := piNewResidentHome(t, map[string]string{
			piResidentCompactModeEnv: "fail",
			"PI_CODING_AGENT_DIR":    piNewCompactableAgentDir(t),
		})
		const sessionID = "pi-compact-fail-idle"
		proc := h.createParked(sessionID, RunSpec{})

		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		result := piTakeParkedForTest(t, h.profile.ContextKey).CompactWithPrepare(ctx, "", nil)
		if result.Outcome != "failed" || !strings.Contains(result.Reason, "fixture compaction rejected") {
			t.Fatalf("rejected compaction = %+v", result)
		}
		if h.parked(sessionID) != proc {
			t.Fatal("healthy Pi process was not parked back after clean RPC rejection")
		}
		if piProcessGone(proc.pid) {
			t.Fatalf("healthy Pi process pid %d exited after clean RPC rejection", proc.pid)
		}

		events, out := h.turn("two", RunSpec{ResumeID: sessionID})
		reused, ok := piEventReused(events)
		if out.Status != statusCompleted || !ok || !reused || h.lines("spawn") != 1 {
			t.Fatalf("turn after clean RPC rejection = %+v reused=(%v,%v) spawns=%d", out, reused, ok, h.lines("spawn"))
		}
	})

	t.Run("transport EOF during compact retires process", func(t *testing.T) {
		h := piNewResidentHome(t, map[string]string{
			piResidentCompactModeEnv: "exit",
			"PI_CODING_AGENT_DIR":    piNewCompactableAgentDir(t),
		})
		const sessionID = "pi-compact-eof"
		proc := h.createParked(sessionID, RunSpec{})

		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		result := piTakeParkedForTest(t, h.profile.ContextKey).CompactWithPrepare(ctx, "", nil)
		if result.Outcome != "failed" || result.Reason == "" {
			t.Fatalf("EOF compaction = %+v", result)
		}
		if !piProcessGone(proc.pid) {
			t.Fatalf("EOF Pi process pid %d is still alive after CompactWithPrepare returned", proc.pid)
		}
		if TakeParkedSession("pi", h.profile.ContextKey) != nil {
			t.Fatal("EOF Pi process remained parked")
		}
		h.assertLockFree(sessionID)

		events, out := h.turn("two", RunSpec{ResumeID: sessionID})
		reused, ok := piEventReused(events)
		if out.Status != statusCompleted || !ok || reused || h.lines("spawn") != 2 {
			t.Fatalf("turn after EOF compaction = %+v reused=(%v,%v) spawns=%d", out, reused, ok, h.lines("spawn"))
		}
	})

	t.Run("clean RPC rejection while non-idle retires process", func(t *testing.T) {
		h := piNewResidentHome(t, map[string]string{
			piResidentCompactModeEnv: "fail_streaming",
			"PI_CODING_AGENT_DIR":    piNewCompactableAgentDir(t),
		})
		const sessionID = "pi-compact-fail-streaming"
		proc := h.createParked(sessionID, RunSpec{})

		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		result := piTakeParkedForTest(t, h.profile.ContextKey).CompactWithPrepare(ctx, "", nil)
		if result.Outcome != "failed" || !strings.Contains(result.Reason, "fixture compaction rejected") {
			t.Fatalf("non-idle rejected compaction = %+v", result)
		}
		if !piProcessGone(proc.pid) {
			t.Fatalf("non-idle rejected Pi process pid %d is still alive", proc.pid)
		}
		if TakeParkedSession("pi", h.profile.ContextKey) != nil {
			t.Fatal("non-idle rejected Pi process remained parked")
		}
		h.assertLockFree(sessionID)

		events, out := h.turn("two", RunSpec{ResumeID: sessionID})
		reused, ok := piEventReused(events)
		if out.Status != statusCompleted || !ok || reused || h.lines("spawn") != 2 {
			t.Fatalf("turn after non-idle rejected compaction = %+v reused=(%v,%v) spawns=%d", out, reused, ok, h.lines("spawn"))
		}
	})
}

func TestPiCompactionFenceInvalidationRetires(t *testing.T) {
	gate := filepath.Join(t.TempDir(), "release-compact")
	h := piNewResidentHome(t, map[string]string{
		piResidentCompactModeEnv: "wait_file:" + gate,
		"PI_CODING_AGENT_DIR":    piNewCompactableAgentDir(t),
	})
	const sessionID = "pi-compact-fence"
	proc := h.createParked(sessionID, RunSpec{})

	session := piTakeParkedForTest(t, h.profile.ContextKey)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	done := make(chan CompactResult, 1)
	go func() { done <- session.CompactWithPrepare(ctx, "keep decisions", nil) }()

	awaitTrue(t, "Pi compact RPC started", 10*time.Second, func() bool { return h.lines("compact") == 1 })

	// Invalidate the Context's release fence while compaction is in flight.
	if _, err := StopParkedResidentsForContext(h.profile.ContextKey); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(gate, []byte("go"), 0o600); err != nil {
		t.Fatal(err)
	}

	select {
	case result := <-done:
		if result.Outcome != "compacted" || result.PreTokens == nil || *result.PreTokens != 32100 {
			t.Fatalf("fence-invalidated compaction = %+v", result)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("fence-invalidated Pi compaction did not return")
	}

	if h.parked(sessionID) != nil || TakeParkedSession("pi", h.profile.ContextKey) != nil {
		t.Fatal("fence-invalidated Pi process was parked back")
	}
	if !piProcessGone(proc.pid) {
		t.Fatalf("fence-invalidated Pi process pid %d survived", proc.pid)
	}
	h.assertLockFree(sessionID)
}

func TestPiCompactionPrepareOrderingAndErrors(t *testing.T) {
	t.Run("prepare skipped when process is not idle", func(t *testing.T) {
		streamingFlag := filepath.Join(t.TempDir(), "streaming")
		h := piNewResidentHome(t, map[string]string{
			piResidentStreamingFileEnv: streamingFlag,
			"PI_CODING_AGENT_DIR":      piNewCompactableAgentDir(t),
		})
		const sessionID = "pi-compact-not-idle"
		proc := h.createParked(sessionID, RunSpec{})

		if err := os.WriteFile(streamingFlag, []byte("1"), 0o600); err != nil {
			t.Fatal(err)
		}
		var prepareCalls atomic.Int32
		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		result := piTakeParkedForTest(t, h.profile.ContextKey).CompactWithPrepare(ctx, "", func(context.Context, string) error {
			prepareCalls.Add(1)
			return nil
		})
		if result.Outcome != "failed" || !strings.Contains(result.Reason, "not idle") {
			t.Fatalf("non-idle compaction = %+v", result)
		}
		if prepareCalls.Load() != 0 || h.lines("compact") != 0 || !piProcessGone(proc.pid) {
			t.Fatalf("prepareCalls=%d compacts=%d gone=%v", prepareCalls.Load(), h.lines("compact"), piProcessGone(proc.pid))
		}
	})

	t.Run("prepare skipped on pre-canceled ctx", func(t *testing.T) {
		h := piNewResidentHome(t, map[string]string{"PI_CODING_AGENT_DIR": piNewCompactableAgentDir(t)})
		const sessionID = "pi-compact-precancel"
		proc := h.createParked(sessionID, RunSpec{})

		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		var prepareCalls atomic.Int32
		result := piTakeParkedForTest(t, h.profile.ContextKey).CompactWithPrepare(ctx, "", func(context.Context, string) error {
			prepareCalls.Add(1)
			return nil
		})
		if result.Outcome != "canceled" || prepareCalls.Load() != 0 || h.lines("compact") != 0 || !piProcessGone(proc.pid) {
			t.Fatalf("precanceled = %+v prepareCalls=%d compacts=%d gone=%v", result, prepareCalls.Load(), h.lines("compact"), piProcessGone(proc.pid))
		}
		h.assertLockFree(sessionID)
	})

	t.Run("prepare receives modelID observed from get_state", func(t *testing.T) {
		const stateModel = "localmodels-library/qwen3-4b"
		h := piNewResidentHome(t, map[string]string{
			piResidentStateModelEnv: stateModel,
			"PI_CODING_AGENT_DIR":   piNewCompactableAgentDir(t),
		})
		const sessionID = "pi-compact-state-model"
		h.createParked(sessionID, RunSpec{})

		var gotModel string
		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		result := piTakeParkedForTest(t, h.profile.ContextKey).CompactWithPrepare(ctx, "", func(_ context.Context, modelID string) error {
			gotModel = modelID
			return nil
		})
		if result.Outcome != "compacted" || gotModel != stateModel {
			t.Fatalf("result=%+v gotModel=%q, want compacted with %q", result, gotModel, stateModel)
		}
	})

	t.Run("non-canceled prepare error parks untouched process back or retires on invalidated fence", func(t *testing.T) {
		h := piNewResidentHome(t, map[string]string{"PI_CODING_AGENT_DIR": piNewCompactableAgentDir(t)})
		const sessionID = "pi-compact-prepare-err"
		proc := h.createParked(sessionID, RunSpec{})

		ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
		defer cancel()
		first := piTakeParkedForTest(t, h.profile.ContextKey).CompactWithPrepare(ctx, "", func(context.Context, string) error {
			return errors.New("gateway down")
		})
		if first.Outcome != "failed" || !strings.Contains(first.Reason, "gateway down") || h.lines("compact") != 0 {
			t.Fatalf("first prepare error = %+v compacts=%d", first, h.lines("compact"))
		}
		if h.parked(sessionID) != proc {
			t.Fatal("untouched Pi process was not parked back after non-canceled prepare error")
		}

		// When the fence is invalidated during prepare, the process must retire instead of parking.
		second := piTakeParkedForTest(t, h.profile.ContextKey).CompactWithPrepare(ctx, "", func(context.Context, string) error {
			_, err := StopParkedResidentsForContext(h.profile.ContextKey)
			if err != nil {
				t.Error(err)
			}
			return errors.New("model load failed")
		})
		if second.Outcome != "failed" || !strings.Contains(second.Reason, "model load failed") || h.lines("compact") != 0 {
			t.Fatalf("second prepare error = %+v compacts=%d", second, h.lines("compact"))
		}
		if h.parked(sessionID) != nil || !piProcessGone(proc.pid) {
			t.Fatal("fence-invalidated Pi process was not retired after prepare error")
		}
		h.assertLockFree(sessionID)
	})

	t.Run("canceled ctx during prepare retires process without calling compact", func(t *testing.T) {
		h := piNewResidentHome(t, map[string]string{"PI_CODING_AGENT_DIR": piNewCompactableAgentDir(t)})
		const sessionID = "pi-compact-prepare-cancel"
		proc := h.createParked(sessionID, RunSpec{})

		ctx, cancel := context.WithCancel(t.Context())
		result := piTakeParkedForTest(t, h.profile.ContextKey).CompactWithPrepare(ctx, "", func(prepareCtx context.Context, _ string) error {
			cancel()
			<-prepareCtx.Done()
			return prepareCtx.Err()
		})
		if result.Outcome != "canceled" || h.lines("compact") != 0 {
			t.Fatalf("prepare cancel = %+v compacts=%d", result, h.lines("compact"))
		}
		if h.parked(sessionID) != nil || !piProcessGone(proc.pid) {
			t.Fatal("Pi process was not retired after prepare cancellation")
		}
		h.assertLockFree(sessionID)
	})
}

func TestPiResolveKeepRecentTokensPrecedence(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	if got := piAgentDirFromEnv([]string{"HOME=" + home}); got != filepath.Join(home, ".pi", "agent") {
		t.Fatalf("default agentDir = %q", got)
	}
	if got := piAgentDirFromEnv([]string{"HOME=" + home, "PI_CODING_AGENT_DIR=~/custom-pi"}); got != filepath.Join(home, "custom-pi") {
		t.Fatalf("tilde agentDir = %q", got)
	}

	// Default 20000 when agentDir is empty or has no settings.json.
	if got := piResolveKeepRecentTokens(piLoadCompactionSettings(""), "provider/model-a"); got != 20000 {
		t.Fatalf("empty agentDir keepRecentTokens = %d, want 20000", got)
	}
	agentDir := t.TempDir()
	if got := piResolveKeepRecentTokens(piLoadCompactionSettings(agentDir), "provider/model-a"); got != 20000 {
		t.Fatalf("default keepRecentTokens = %d, want 20000", got)
	}

	// Malformed settings.json falls back safely to default.
	piWriteAgentSettings(t, agentDir, "{not-json")
	if got := piResolveKeepRecentTokens(piLoadCompactionSettings(agentDir), "provider/model-a"); got != 20000 {
		t.Fatalf("malformed keepRecentTokens = %d, want 20000", got)
	}

	// Global settings (with UTF-8 BOM), modelOverrides, explicit 0, and invalid value fallback.
	piWriteAgentSettings(t, agentDir, "\xef\xbb\xbf"+`{
		"compaction": {
			"keepRecentTokens": 12000,
			"modelOverrides": {
				"provider/model-a": { "keepRecentTokens": 6000 },
				"provider/model-zero": { "keepRecentTokens": 0 },
				"provider/model-neg": { "keepRecentTokens": -5 },
				"provider/model-str": { "keepRecentTokens": "100" }
			}
		}
	}`)
	settings := piLoadCompactionSettings(agentDir)
	if got := piResolveKeepRecentTokens(settings, "provider/other"); got != 12000 {
		t.Fatalf("global keepRecentTokens = %d, want 12000", got)
	}
	if got := piResolveKeepRecentTokens(settings, "provider/model-a"); got != 6000 {
		t.Fatalf("global modelOverride = %d, want 6000", got)
	}
	if got := piResolveKeepRecentTokens(settings, "provider/model-zero"); got != 0 {
		t.Fatalf("global explicit 0 modelOverride = %d, want 0", got)
	}
	if got := piResolveKeepRecentTokens(settings, "provider/model-neg"); got != 12000 {
		t.Fatalf("negative modelOverride fell back to %d, want 12000", got)
	}
	if got := piResolveKeepRecentTokens(settings, "provider/model-str"); got != 12000 {
		t.Fatalf("non-numeric modelOverride fell back to %d, want 12000", got)
	}
	if got := piResolveKeepRecentTokens(settings, ""); got != 12000 {
		t.Fatalf("empty modelID keepRecentTokens = %d, want 12000", got)
	}

	// Explicit global compaction.keepRecentTokens = 0 overrides default.
	piWriteAgentSettings(t, agentDir, `{"compaction":{"keepRecentTokens":0}}`)
	if got := piResolveKeepRecentTokens(piLoadCompactionSettings(agentDir), "provider/other"); got != 0 {
		t.Fatalf("global explicit 0 keepRecentTokens = %d, want 0", got)
	}
}

func TestPiSessionCanCompactStructuralCases(t *testing.T) {
	header := map[string]any{"type": "session", "version": 3, "id": "sess-1", "cwd": "/tmp"}
	msg := func(id, parent, role, text string) map[string]any {
		entry := map[string]any{
			"type": "message",
			"id":   id,
			"message": map[string]any{
				"role":    role,
				"content": []any{map[string]any{"type": "text", "text": text}},
			},
		}
		if parent != "" {
			entry["parentId"] = parent
		}
		return entry
	}

	t.Run("split turn cuts at assistant and summarizes user prefix", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "split.jsonl")
		// 400 chars = 100 tokens on assistant; keepRecentTokens = 80 cuts at m2 (assistant),
		// splitting turn [m1, m2] so turnPrefixMessages contains m1 (user).
		piWriteJSONLLines(t, path, []map[string]any{
			header,
			msg("m1", "", "user", "hello"),
			msg("m2", "m1", "assistant", strings.Repeat("a", 400)),
		})
		can, err := piSessionCanCompact(path, 80)
		if err != nil || !can {
			t.Fatalf("split turn = (%v, %v), want (true, nil)", can, err)
		}
		// Under a larger budget (200 tokens), cut falls back to m1 (user) with nothing before it.
		canSmall, err := piSessionCanCompact(path, 200)
		if err != nil || canSmall {
			t.Fatalf("under budget = (%v, %v), want (false, nil)", canSmall, err)
		}
	})

	t.Run("toolResult is never a cut point", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "tool-result.jsonl")
		// Huge toolResult exceeds budget on its own; cut point falls back to m2 (assistant),
		// splitting the turn and summarizing m1 (user).
		piWriteJSONLLines(t, path, []map[string]any{
			header,
			msg("m1", "", "user", "run ls"),
			{
				"type":     "message",
				"id":       "m2",
				"parentId": "m1",
				"message": map[string]any{
					"role":    "assistant",
					"content": []any{map[string]any{"type": "toolCall", "name": "bash", "arguments": map[string]any{"command": "ls"}}},
				},
			},
			msg("m3", "m2", "toolResult", strings.Repeat("o", 1200)),
		})
		can, err := piSessionCanCompact(path, 200)
		if err != nil || !can {
			t.Fatalf("toolResult split turn = (%v, %v), want (true, nil)", can, err)
		}

		// Without a preceding user/turn entry, assistant + huge toolResult has nothing before m1.
		pathNoPrefix := filepath.Join(t.TempDir(), "tool-result-only.jsonl")
		piWriteJSONLLines(t, pathNoPrefix, []map[string]any{
			header,
			{
				"type": "message",
				"id":   "m1",
				"message": map[string]any{
					"role":    "assistant",
					"content": []any{map[string]any{"type": "toolCall", "name": "bash", "arguments": map[string]any{"command": "ls"}}},
				},
			},
			msg("m2", "m1", "toolResult", strings.Repeat("o", 1200)),
		})
		canNoPrefix, err := piSessionCanCompact(pathNoPrefix, 200)
		if err != nil || canNoPrefix {
			t.Fatalf("assistant+toolResult only = (%v, %v), want (false, nil)", canNoPrefix, err)
		}
	})

	t.Run("context_edit omission and replacement", func(t *testing.T) {
		// Omitting m2 shrinks total tokens below keepRecentTokens -> not compactable.
		pathOmit := filepath.Join(t.TempDir(), "edit-omit.jsonl")
		piWriteJSONLLines(t, pathOmit, []map[string]any{
			header,
			msg("m1", "", "user", "short"),
			msg("m2", "m1", "assistant", strings.Repeat("a", 800)),
			{"type": "context_edit", "id": "e1", "parentId": "m2", "targetId": "m2", "replacement": nil},
		})
		can, err := piSessionCanCompact(pathOmit, 100)
		if err != nil || can {
			t.Fatalf("omitted assistant = (%v, %v), want (false, nil)", can, err)
		}

		// Recovery omission suffix: m1 exceeds budget, m2 (assistant) is omitted at the suffix,
		// so cutIndex advances past m1 and summarizes m1.
		pathRecovery := filepath.Join(t.TempDir(), "edit-recovery.jsonl")
		piWriteJSONLLines(t, pathRecovery, []map[string]any{
			header,
			msg("m1", "", "user", strings.Repeat("u", 800)),
			msg("m2", "m1", "assistant", "failed attempt"),
			{"type": "context_edit", "id": "e1", "parentId": "m2", "targetId": "m2", "replacement": nil},
		})
		canRecovery, err := piSessionCanCompact(pathRecovery, 100)
		if err != nil || !canRecovery {
			t.Fatalf("recovery omission suffix = (%v, %v), want (true, nil)", canRecovery, err)
		}

		// String replacement on assistant wraps as text block and counts toward budget.
		pathReplace := filepath.Join(t.TempDir(), "edit-replace.jsonl")
		piWriteJSONLLines(t, pathReplace, []map[string]any{
			header,
			msg("m1", "", "user", "hello"),
			msg("m2", "m1", "assistant", "short"),
			{"type": "context_edit", "id": "e1", "parentId": "m2", "targetId": "m2", "replacement": map[string]any{"content": strings.Repeat("r", 800)}},
		})
		canReplace, err := piSessionCanCompact(pathReplace, 100)
		if err != nil || !canReplace {
			t.Fatalf("string replacement on assistant = (%v, %v), want (true, nil)", canReplace, err)
		}
	})

	t.Run("multi-compaction chain ignores older compaction and summarizes new tail", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "multi-compact.jsonl")
		piWriteJSONLLines(t, path, []map[string]any{
			header,
			msg("m1", "", "user", strings.Repeat("a", 800)),
			msg("m2", "m1", "assistant", strings.Repeat("b", 800)),
			{"type": "compaction", "id": "c1", "parentId": "m2", "summary": "s1", "firstKeptEntryId": "m2", "tokensBefore": 500},
			msg("m3", "c1", "user", "follow-up"),
			msg("m4", "m3", "assistant", "short reply"),
			// c2 keeps from m2 so c1 lies inside c2's retained range (must contribute 0 messages).
			{"type": "compaction", "id": "c2", "parentId": "m4", "summary": "s2", "firstKeptEntryId": "m4", "tokensBefore": 600},
			// Only small reply m4 retained + metadata after c2 -> under budget (200 tokens).
			{"type": "thinking_level_change", "id": "t1", "parentId": "c2", "thinkingLevel": "low"},
		})
		canUnder, err := piSessionCanCompact(path, 200)
		if err != nil || canUnder {
			t.Fatalf("multi-compaction under budget = (%v, %v), want (false, nil)", canUnder, err)
		}

		// Adding a large new turn after c2 crosses keepRecentTokens and becomes compactable.
		piAppendJSONLLines(t, path, []map[string]any{
			msg("m5", "t1", "user", strings.Repeat("u", 600)),
			msg("m6", "m5", "assistant", strings.Repeat("v", 600)),
		})
		canOver, err := piSessionCanCompact(path, 200)
		if err != nil || !canOver {
			t.Fatalf("multi-compaction over budget = (%v, %v), want (true, nil)", canOver, err)
		}
	})

	t.Run("branching ignores abandoned branch and handles long JSONL lines and images", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "branch-and-long.jsonl")
		piWriteJSONLLines(t, path, []map[string]any{
			header,
			msg("m1", "", "user", "root"),
			// Abandoned huge branch (>128 KiB line).
			msg("abandoned", "m1", "assistant", strings.Repeat("z", 128<<10)),
			// Active small branch rooted at m1.
			msg("m2", "m1", "assistant", "tiny"),
		})
		can, err := piSessionCanCompact(path, 200)
		if err != nil || can {
			t.Fatalf("active small branch = (%v, %v), want (false, nil)", can, err)
		}

		// An image block contributes 4800 chars = 1200 tokens, and supplementary runes count as 2 UTF-16 units.
		if got := piUTF16Len("\U0001F600a"); got != 3 {
			t.Fatalf("piUTF16Len(emoji+a) = %d, want 3", got)
		}
		pathImg := filepath.Join(t.TempDir(), "image.jsonl")
		piWriteJSONLLines(t, pathImg, []map[string]any{
			header,
			msg("m1", "", "user", "look"),
			{
				"type":     "message",
				"id":       "m2",
				"parentId": "m1",
				"message": map[string]any{
					"role":    "user",
					"content": []any{map[string]any{"type": "image", "data": "base64"}},
				},
			},
		})
		canImg, err := piSessionCanCompact(pathImg, 1200)
		if err != nil || !canImg {
			t.Fatalf("image block at exact 1200-token budget = (%v, %v), want (true, nil)", canImg, err)
		}
	})

	t.Run("ID-less JSONL entries are not compactable", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "idless.jsonl")
		piWriteJSONLLines(t, path, []map[string]any{
			header,
			{
				"type":    "message",
				"message": map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": strings.Repeat("u", 800)}}},
			},
			{
				"type":    "message",
				"message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": strings.Repeat("a", 800)}}},
			},
		})
		can, err := piSessionCanCompact(path, 0)
		if err != nil || can {
			t.Fatalf("ID-less transcript = (%v, %v), want (false, nil)", can, err)
		}
	})
}
