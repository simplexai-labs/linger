package daemon

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/localmodels"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

// fakeParkedSession holds a compaction until release or cancellation. A
// canceled compaction takes a moment to retire its process, as a real one does.
type fakeParkedSession struct {
	started         chan struct{}
	release         chan struct{}
	finished        chan struct{}
	result          native.CompactResult
	modelID         string
	instructions    string
	skipPrepare     bool
	compacted       atomic.Bool
	released        atomic.Bool
	retired         atomic.Bool
	prepareCalls    atomic.Int32
	preparedModelID string
}

func newFakeParkedSession(result native.CompactResult) *fakeParkedSession {
	return &fakeParkedSession{started: make(chan struct{}), release: make(chan struct{}), finished: make(chan struct{}), result: result}
}

func (s *fakeParkedSession) CompactWithPrepare(ctx context.Context, instructions string, prepare func(ctx context.Context, modelID string) error) native.CompactResult {
	s.instructions = instructions
	defer close(s.finished)
	if ctx.Err() != nil {
		s.retired.Store(true)
		return native.CompactResult{Outcome: "canceled", Reason: "Session compaction canceled"}
	}
	if s.skipPrepare {
		return s.result
	}
	if prepare != nil {
		s.prepareCalls.Add(1)
		s.preparedModelID = s.modelID
		err := prepare(ctx, s.modelID)
		if err != nil || ctx.Err() != nil {
			if ctx.Err() != nil {
				s.retired.Store(true)
				return native.CompactResult{Outcome: "canceled", Reason: "Session compaction canceled"}
			}
			s.released.Store(true)
			return native.CompactResult{Outcome: "failed", Reason: err.Error()}
		}
	}
	s.compacted.Store(true)
	close(s.started)
	select {
	case <-s.release:
		return s.result
	case <-ctx.Done():
		time.Sleep(50 * time.Millisecond)
		s.retired.Store(true)
		return native.CompactResult{Outcome: "canceled", Reason: "Session compaction canceled"}
	}
}

// compactionOrderBackend records whether the Context's compaction had finished
// when a start reached the provider.
type compactionOrderBackend struct {
	compaction *fakeParkedSession
	afterIt    chan bool
}

func (b *compactionOrderBackend) Start(context.Context, string, native.RunSpec) (*native.Run, error) {
	select {
	case <-b.compaction.finished:
		b.afterIt <- true
	default:
		b.afterIt <- false
	}
	events := make(chan native.Event)
	close(events)
	outcomes := make(chan native.Outcome, 1)
	outcomes <- native.Outcome{Status: "completed", SessionID: "thread-1"}
	close(outcomes)
	return &native.Run{Events: events, Outcome: outcomes}, nil
}

// sessionCompactFixture parks session for context-1 and counts takes.
func sessionCompactFixture(t *testing.T, session *fakeParkedSession, backend native.Runtime) (*Daemon, *fakeStream, *atomic.Int32) {
	t.Helper()
	if backend == nil {
		backend = &providerPrepareBackend{}
	}
	stream := &fakeStream{}
	d, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream}, IdentityStore: fakeStore{},
		OperationResolver: prepareOperationResolver{workingDirectory: t.TempDir()},
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			return backend, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	takes := &atomic.Int32{}
	d.takeParkedSession = func(runtimeType, contextKey string) parkedSession {
		takes.Add(1)
		if session == nil || runtimeType != "claude" || contextKey != "context-1" {
			return nil
		}
		return session
	}
	t.Cleanup(d.WaitForOperations)
	return d, stream, takes
}

func sessionCompactCommand(compactID string) protocol.Command {
	return protocol.Command{
		Type: protocol.CommandSessionCompact, CommandID: "command-" + compactID, ProtocolVersion: "1.2",
		RunnerID: "computer-1", ConnectionEpoch: 1, AgentID: "agent-1", RuntimeType: "claude", ExecutionContextKey: "context-1",
		Payload: mustJSON(map[string]any{"compact_id": compactID, "instructions": "Keep decisions."}),
	}
}

func waitForSessionCompacted(t *testing.T, stream *fakeStream, compactID string) map[string]any {
	t.Helper()
	watchdog := time.After(5 * time.Second)
	for {
		for _, event := range stream.snapshotEvents() {
			var payload map[string]any
			_ = json.Unmarshal(event.Payload, &payload)
			if event.Type == protocol.EventSessionCompacted && payload["compact_id"] == compactID {
				return payload
			}
		}
		select {
		case <-watchdog:
			t.Fatalf("no session.compacted for %s", compactID)
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestSessionCompactWithoutParkedProcessAnswersNoProcess(t *testing.T) {
	d, stream, takes := sessionCompactFixture(t, nil, nil)
	if err := d.handleSessionCompact(context.Background(), stream, sessionCompactCommand("compact-none")); err != nil {
		t.Fatal(err)
	}
	payload := waitForSessionCompacted(t, stream, "compact-none")
	if payload["outcome"] != "no_process" || payload["reason"] == nil || payload["execution_context_key"] != "context-1" || takes.Load() != 1 {
		t.Fatalf("payload=%v takes=%d, want no_process after one take", payload, takes.Load())
	}
}

func TestSessionCompactRefusedWithoutTakingTheProcess(t *testing.T) {
	for name, setup := range map[string]func(*Daemon){
		"draining":        func(d *Daemon) { d.draining = true },
		"locally stopped": func(d *Daemon) { d.locallyStopped["agent-1"] = true },
		"active operation": func(d *Daemon) {
			d.activeOperations["operation-1"] = &activeOperation{identity: OperationIdentity{ExecutionContextKey: "context-1"}}
		},
		"provider prepare": func(d *Daemon) {
			d.providerPrepares["context-1"] = &providerPrepare{id: "prepare-1", contextKey: "context-1", done: make(chan struct{})}
		},
	} {
		t.Run(name, func(t *testing.T) {
			d, stream, takes := sessionCompactFixture(t, newFakeParkedSession(native.CompactResult{}), nil)
			setup(d)
			if err := d.handleSessionCompact(context.Background(), stream, sessionCompactCommand("compact-refused")); err != nil {
				t.Fatal(err)
			}
			payload := waitForSessionCompacted(t, stream, "compact-refused")
			if payload["outcome"] != "no_process" || payload["reason"] == nil || takes.Load() != 0 {
				t.Fatalf("payload=%v takes=%d, want no_process without a take", payload, takes.Load())
			}
		})
	}
}

func TestSessionCompactReportsCompactedAndBusyForASecondCompaction(t *testing.T) {
	preTokens := int64(44445)
	session := newFakeParkedSession(native.CompactResult{Outcome: "compacted", PreTokens: &preTokens})
	d, stream, takes := sessionCompactFixture(t, session, nil)
	if err := d.handleSessionCompact(context.Background(), stream, sessionCompactCommand("compact-1")); err != nil {
		t.Fatal(err)
	}
	<-session.started
	if err := d.handleSessionCompact(context.Background(), stream, sessionCompactCommand("compact-2")); err != nil {
		t.Fatal(err)
	}
	if payload := waitForSessionCompacted(t, stream, "compact-2"); payload["outcome"] != "no_process" || payload["reason"] != "Context is busy" {
		t.Fatalf("second compaction payload=%v, want busy", payload)
	}
	close(session.release)
	payload := waitForSessionCompacted(t, stream, "compact-1")
	if payload["outcome"] != "compacted" || payload["pre_tokens"] != float64(preTokens) || payload["duration_ms"] == nil ||
		payload["reason"] != nil || payload["command_id"] != "command-compact-1" || payload["runner_id"] != "computer-1" {
		t.Fatalf("payload=%v, want compacted with pre_tokens", payload)
	}
	if session.instructions != "Keep decisions." || takes.Load() != 1 {
		t.Fatalf("instructions=%q takes=%d", session.instructions, takes.Load())
	}
	d.WaitForOperations()
	if d.sessionCompactInFlight("context-1") {
		t.Fatal("finished compaction left its entry")
	}
}

func TestSessionCompactRunStartWaitsForInterruptedCompaction(t *testing.T) {
	session := newFakeParkedSession(native.CompactResult{Outcome: "compacted"})
	backend := &compactionOrderBackend{compaction: session, afterIt: make(chan bool, 1)}
	d, stream, _ := sessionCompactFixture(t, session, backend)
	d.openMCPProxies = func(context.Context, json.RawMessage, mcpproxy.OperationIdentity) (*mcpproxy.Set, error) {
		return &mcpproxy.Set{}, nil
	}
	if err := d.handleSessionCompact(context.Background(), stream, sessionCompactCommand("compact-run")); err != nil {
		t.Fatal(err)
	}
	<-session.started
	start := startFromPrepare(prepareCommand("operation-compact"))
	if err := d.handleOperationStart(context.Background(), stream, start); err != nil {
		t.Fatal(err)
	}
	select {
	case afterIt := <-backend.afterIt:
		if !afterIt {
			t.Fatal("start reached the provider while the compaction still held the process")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("start never reached the provider")
	}
	if payload := waitForSessionCompacted(t, stream, "compact-run"); payload["outcome"] != "canceled" {
		t.Fatalf("payload=%v, want canceled", payload)
	}
}

func TestSessionCompactStopsForProviderPrepareContextReleaseAgentStopAndDrain(t *testing.T) {
	for name, stop := range map[string]func(*Daemon){
		"provider prepare": func(d *Daemon) { d.interruptSessionCompact(context.Background(), "context-1", "provider_prepare") },
		"context release": func(d *Daemon) {
			waitSessionCompacts(context.Background(), d.cancelSessionCompacts(sessionCompactForContext("context-1"), "context_release"))
		},
		"agent stop": func(d *Daemon) {
			if err := d.StopAgentRunner(context.Background(), "agent-1"); err != nil {
				t.Error(err)
			}
		},
		"drain": func(d *Daemon) { d.Drain(); d.WaitForOperations() },
	} {
		t.Run(name, func(t *testing.T) {
			session := newFakeParkedSession(native.CompactResult{Outcome: "compacted"})
			d, stream, _ := sessionCompactFixture(t, session, nil)
			if err := d.handleSessionCompact(context.Background(), stream, sessionCompactCommand("compact-stop")); err != nil {
				t.Fatal(err)
			}
			<-session.started
			stop(d)
			select {
			case <-session.finished:
			default:
				t.Fatalf("%s returned before the compaction released its process", name)
			}
			if payload := waitForSessionCompacted(t, stream, "compact-stop"); payload["outcome"] != "canceled" {
				t.Fatalf("payload=%v, want canceled", payload)
			}
		})
	}
}

func TestSessionCompactedReceiptBoundsReasonAndPreTokens(t *testing.T) {
	d, stream, _ := sessionCompactFixture(t, nil, nil)
	command := sessionCompactCommand("compact-receipt")
	negative := int64(-1)
	long := "Bearer fixture-secret-value " + strings.Repeat("é", 600)
	for _, result := range []native.CompactResult{
		{Outcome: "failed", Reason: long, PreTokens: &negative},
		{Outcome: "failed", Reason: "   "},
	} {
		if err := d.sendSessionCompacted(context.Background(), stream, command, "compact-receipt", result, time.Millisecond); err != nil {
			t.Fatal(err)
		}
	}
	events := stream.snapshotEvents()
	var payloads []map[string]any
	for _, event := range events {
		var payload map[string]any
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		payloads = append(payloads, payload)
	}
	if len(payloads) != 2 {
		t.Fatalf("receipts=%v", payloads)
	}
	reason, _ := payloads[0]["reason"].(string)
	if utf8.RuneCountInString(reason) != receiptReasonLimit || strings.Contains(reason, "fixture-secret-value") || !utf8.ValidString(reason) {
		t.Fatalf("reason has %d characters: %q", utf8.RuneCountInString(reason), reason)
	}
	if _, present := payloads[0]["pre_tokens"]; present {
		t.Fatalf("negative pre_tokens was sent: %v", payloads[0])
	}
	if _, present := payloads[1]["reason"]; present {
		t.Fatalf("blank reason was sent: %v", payloads[1])
	}
}

type blockingLocalModels struct {
	fakeLocalModels
	started chan struct{}
	release chan struct{}
}

func (b *blockingLocalModels) EnsureLoaded(ctx context.Context, piModel string) error {
	b.ensured = append(b.ensured, piModel)
	if b.started != nil {
		close(b.started)
	}
	select {
	case <-b.release:
		return b.ensureErr
	case <-ctx.Done():
		return ctx.Err()
	}
}

func piSessionCompactCommand(compactID string) protocol.Command {
	command := sessionCompactCommand(compactID)
	command.RuntimeType = "pi"
	return command
}

func TestSessionCompactPiEnsuresModelGatewayAndLocalModel(t *testing.T) {
	t.Run("ensures gateway and local model before compacting", func(t *testing.T) {
		preTokens := int64(32100)
		session := newFakeParkedSession(native.CompactResult{Outcome: "compacted", PreTokens: &preTokens})
		session.modelID = localRunModel
		close(session.release)
		d, stream, _ := sessionCompactFixture(t, session, nil)
		source := &gatewayModelSource{}
		library := &fakeLocalModels{}
		d.modelSource = source
		d.localModels = library
		d.takeParkedSession = func(runtimeType, contextKey string) parkedSession {
			if runtimeType == "pi" && contextKey == "context-1" {
				return session
			}
			return nil
		}
		if err := d.handleSessionCompact(context.Background(), stream, piSessionCompactCommand("compact-pi-ok")); err != nil {
			t.Fatal(err)
		}
		payload := waitForSessionCompacted(t, stream, "compact-pi-ok")
		if payload["outcome"] != "compacted" || payload["pre_tokens"] != float64(preTokens) {
			t.Fatalf("payload=%v, want compacted", payload)
		}
		if len(source.runtime) != 1 || source.runtime[0] != "pi" {
			t.Fatalf("EnsureGateway calls = %v, want [pi]", source.runtime)
		}
		if len(library.ensured) != 1 || library.ensured[0] != localRunModel {
			t.Fatalf("EnsureLoaded calls = %v, want [%s]", library.ensured, localRunModel)
		}
		if !session.compacted.Load() || session.released.Load() || session.retired.Load() {
			t.Fatalf("compacted=%v released=%v retired=%v", session.compacted.Load(), session.released.Load(), session.retired.Load())
		}
	})

	t.Run("releases untouched session when gateway fails", func(t *testing.T) {
		session := newFakeParkedSession(native.CompactResult{Outcome: "compacted"})
		session.modelID = localRunModel
		d, stream, _ := sessionCompactFixture(t, session, nil)
		source := &gatewayModelSource{err: &localmodels.ModelSourceError{Code: "BYOK_GATEWAY_FAILED", Message: "Bifrost did not start."}}
		library := &fakeLocalModels{}
		d.modelSource = source
		d.localModels = library
		d.takeParkedSession = func(runtimeType, contextKey string) parkedSession {
			if runtimeType == "pi" && contextKey == "context-1" {
				return session
			}
			return nil
		}
		if err := d.handleSessionCompact(context.Background(), stream, piSessionCompactCommand("compact-pi-gw-fail")); err != nil {
			t.Fatal(err)
		}
		payload := waitForSessionCompacted(t, stream, "compact-pi-gw-fail")
		if payload["outcome"] != "failed" || !strings.Contains(payload["reason"].(string), "Bifrost did not start.") {
			t.Fatalf("payload=%v, want failed with gateway reason", payload)
		}
		if len(library.ensured) != 0 || session.compacted.Load() || !session.released.Load() || session.retired.Load() {
			t.Fatalf("ensured=%v compacted=%v released=%v retired=%v", library.ensured, session.compacted.Load(), session.released.Load(), session.retired.Load())
		}
	})

	t.Run("releases untouched session when local model fails", func(t *testing.T) {
		session := newFakeParkedSession(native.CompactResult{Outcome: "compacted"})
		session.modelID = localRunModel
		d, stream, _ := sessionCompactFixture(t, session, nil)
		source := &gatewayModelSource{}
		library := &fakeLocalModels{ensureErr: &localmodels.LocalModelLoadError{Code: "LOAD_NO_ROOM", ModelID: "qwen3-4b:Q4_K_M"}}
		d.modelSource = source
		d.localModels = library
		d.takeParkedSession = func(runtimeType, contextKey string) parkedSession {
			if runtimeType == "pi" && contextKey == "context-1" {
				return session
			}
			return nil
		}
		if err := d.handleSessionCompact(context.Background(), stream, piSessionCompactCommand("compact-pi-lm-fail")); err != nil {
			t.Fatal(err)
		}
		payload := waitForSessionCompacted(t, stream, "compact-pi-lm-fail")
		if payload["outcome"] != "failed" || payload["reason"] == nil {
			t.Fatalf("payload=%v, want failed", payload)
		}
		if session.compacted.Load() || !session.released.Load() || session.retired.Load() {
			t.Fatalf("compacted=%v released=%v retired=%v", session.compacted.Load(), session.released.Load(), session.retired.Load())
		}
	})

	t.Run("retires session when canceled during local model readiness", func(t *testing.T) {
		session := newFakeParkedSession(native.CompactResult{Outcome: "compacted"})
		session.modelID = localRunModel
		d, stream, _ := sessionCompactFixture(t, session, nil)
		library := &blockingLocalModels{started: make(chan struct{}), release: make(chan struct{})}
		d.localModels = library
		d.takeParkedSession = func(runtimeType, contextKey string) parkedSession {
			if runtimeType == "pi" && contextKey == "context-1" {
				return session
			}
			return nil
		}
		if err := d.handleSessionCompact(context.Background(), stream, piSessionCompactCommand("compact-pi-lm-cancel")); err != nil {
			t.Fatal(err)
		}
		<-library.started
		d.interruptSessionCompact(context.Background(), "context-1", "run_start")
		payload := waitForSessionCompacted(t, stream, "compact-pi-lm-cancel")
		if payload["outcome"] != "canceled" {
			t.Fatalf("payload=%v, want canceled", payload)
		}
		if session.compacted.Load() || session.released.Load() || !session.retired.Load() {
			t.Fatalf("compacted=%v released=%v retired=%v", session.compacted.Load(), session.released.Load(), session.retired.Load())
		}
	})

	t.Run("nothing_to_compact skips gateway and local model readiness", func(t *testing.T) {
		session := newFakeParkedSession(native.CompactResult{Outcome: "nothing_to_compact"})
		session.modelID = localRunModel
		session.skipPrepare = true
		d, stream, _ := sessionCompactFixture(t, session, nil)
		source := &gatewayModelSource{err: &localmodels.ModelSourceError{Code: "BYOK_GATEWAY_FAILED", Message: "should not run"}}
		library := &fakeLocalModels{ensureErr: &localmodels.LocalModelLoadError{Code: "LOAD_NO_ROOM", ModelID: "qwen3-4b:Q4_K_M"}}
		d.modelSource = source
		d.localModels = library
		d.takeParkedSession = func(runtimeType, contextKey string) parkedSession {
			if runtimeType == "pi" && contextKey == "context-1" {
				return session
			}
			return nil
		}
		if err := d.handleSessionCompact(context.Background(), stream, piSessionCompactCommand("compact-pi-noop")); err != nil {
			t.Fatal(err)
		}
		payload := waitForSessionCompacted(t, stream, "compact-pi-noop")
		if payload["outcome"] != "nothing_to_compact" {
			t.Fatalf("payload=%v, want nothing_to_compact", payload)
		}
		if len(source.runtime) != 0 || len(library.ensured) != 0 || session.prepareCalls.Load() != 0 {
			t.Fatalf("gateway=%v ensured=%v prepareCalls=%d, want none", source.runtime, library.ensured, session.prepareCalls.Load())
		}
	})

	t.Run("holds and releases local model use lease during Pi compaction", func(t *testing.T) {
		session := newFakeParkedSession(native.CompactResult{Outcome: "compacted"})
		session.modelID = localRunModel
		d, stream, _ := sessionCompactFixture(t, session, nil)
		library := &fakeLocalModels{}
		d.localModels = library
		d.takeParkedSession = func(runtimeType, contextKey string) parkedSession {
			if runtimeType == "pi" && contextKey == "context-1" {
				return session
			}
			return nil
		}
		if err := d.handleSessionCompact(context.Background(), stream, piSessionCompactCommand("compact-pi-lease")); err != nil {
			t.Fatal(err)
		}
		<-session.started

		library.mu.Lock()
		activeWhileRunning := library.activeLeases[localRunModel]
		releasesWhileRunning := library.leaseReleases
		library.mu.Unlock()
		if activeWhileRunning != 1 || releasesWhileRunning != 0 {
			t.Fatalf("during compaction: activeLeases=%d releases=%d, want 1 and 0", activeWhileRunning, releasesWhileRunning)
		}

		close(session.release)
		payload := waitForSessionCompacted(t, stream, "compact-pi-lease")
		if payload["outcome"] != "compacted" {
			t.Fatalf("payload=%v, want compacted", payload)
		}

		library.mu.Lock()
		activeAfter := library.activeLeases[localRunModel]
		releasesAfter := library.leaseReleases
		library.mu.Unlock()
		if activeAfter != 0 || releasesAfter != 1 {
			t.Fatalf("after compaction: activeLeases=%d releases=%d, want 0 and 1", activeAfter, releasesAfter)
		}
	})
}

func TestSessionCompactCodexAndClaudeSkipModelReadiness(t *testing.T) {
	for _, runtimeType := range []string{"codex", "claude"} {
		t.Run(runtimeType, func(t *testing.T) {
			session := newFakeParkedSession(native.CompactResult{Outcome: "compacted"})
			session.modelID = localRunModel
			close(session.release)
			d, stream, _ := sessionCompactFixture(t, session, nil)
			source := &gatewayModelSource{err: &localmodels.ModelSourceError{Code: "BYOK_GATEWAY_FAILED", Message: "should not run"}}
			library := &fakeLocalModels{ensureErr: &localmodels.LocalModelLoadError{Code: "LOAD_NO_ROOM", ModelID: "qwen3-4b:Q4_K_M"}}
			d.modelSource = source
			d.localModels = library
			d.takeParkedSession = func(rt, contextKey string) parkedSession {
				if rt == runtimeType && contextKey == "context-1" {
					return session
				}
				return nil
			}
			cmd := sessionCompactCommand("compact-" + runtimeType + "-skip-readiness")
			cmd.RuntimeType = runtimeType
			if err := d.handleSessionCompact(context.Background(), stream, cmd); err != nil {
				t.Fatal(err)
			}
			payload := waitForSessionCompacted(t, stream, "compact-"+runtimeType+"-skip-readiness")
			if payload["outcome"] != "compacted" {
				t.Fatalf("payload=%v, want compacted", payload)
			}
			if len(source.runtime) != 0 || len(library.ensured) != 0 || session.prepareCalls.Load() != 0 {
				t.Fatalf("gateway=%v ensured=%v prepareCalls=%d, want none", source.runtime, library.ensured, session.prepareCalls.Load())
			}
			if !session.compacted.Load() {
				t.Fatal("session did not compact")
			}
		})
	}
}

func TestInvalidateAntigravityResidentsCancelsOnlyAntigravityCompaction(t *testing.T) {
	agySession := newFakeParkedSession(native.CompactResult{Outcome: "compacted"})
	codexSession := newFakeParkedSession(native.CompactResult{Outcome: "compacted"})
	d, stream, _ := sessionCompactFixture(t, nil, nil)
	d.takeParkedSession = func(runtimeType, contextKey string) parkedSession {
		switch {
		case runtimeType == "antigravity" && contextKey == "ctx-agy":
			return agySession
		case runtimeType == "codex" && contextKey == "ctx-codex":
			return codexSession
		default:
			return nil
		}
	}

	agyCmd := sessionCompactCommand("compact-agy")
	agyCmd.RuntimeType = "antigravity"
	agyCmd.ExecutionContextKey = "ctx-agy"
	codexCmd := sessionCompactCommand("compact-codex")
	codexCmd.RuntimeType = "codex"
	codexCmd.ExecutionContextKey = "ctx-codex"

	if err := d.handleSessionCompact(context.Background(), stream, agyCmd); err != nil {
		t.Fatal(err)
	}
	if err := d.handleSessionCompact(context.Background(), stream, codexCmd); err != nil {
		t.Fatal(err)
	}
	<-agySession.started
	<-codexSession.started

	d.InvalidateAntigravityResidents("credentials_changed")

	if payload := waitForSessionCompacted(t, stream, "compact-agy"); payload["outcome"] != "canceled" {
		t.Fatalf("antigravity compaction payload=%v, want canceled", payload)
	}
	select {
	case <-codexSession.finished:
		t.Fatal("unrelated Codex compaction was canceled by InvalidateAntigravityResidents")
	default:
	}
	if !d.sessionCompactInFlight("ctx-codex") {
		t.Fatal("expected Codex compaction to remain in flight")
	}

	close(codexSession.release)
	if payload := waitForSessionCompacted(t, stream, "compact-codex"); payload["outcome"] != "compacted" {
		t.Fatalf("codex compaction payload=%v, want compacted", payload)
	}
}
