package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

type fakeWakeStream struct {
	mu           sync.Mutex
	probeCount   int
	probeTimeout time.Duration
	events       []protocol.Event
}

func (s *fakeWakeStream) Receive(ctx context.Context) (protocol.Command, error) {
	<-ctx.Done()
	return protocol.Command{}, ctx.Err()
}

func (s *fakeWakeStream) Send(_ context.Context, event protocol.Event) error {
	s.mu.Lock()
	s.events = append(s.events, event)
	s.mu.Unlock()
	return nil
}

func (s *fakeWakeStream) Close() error { return nil }

func (s *fakeWakeStream) ProbeLiveness(timeout time.Duration) error {
	s.mu.Lock()
	s.probeCount++
	s.probeTimeout = timeout
	s.mu.Unlock()
	return nil
}

type fakeWakeLocalModels struct {
	fakeLocalModels
	mu        sync.Mutex
	calls     int
	onRecover func(ctx context.Context, onUnhealthy func(modelIDs, piModels []string, gatewayUnhealthy bool))
}

func (f *fakeWakeLocalModels) RecoverAfterWake(ctx context.Context, onUnhealthy func(modelIDs, piModels []string, gatewayUnhealthy bool)) {
	f.mu.Lock()
	f.calls++
	fn := f.onRecover
	f.mu.Unlock()
	if fn != nil {
		fn(ctx, onUnhealthy)
	}
}

func TestHandlePowerResumeProbesGatewayAndInterruptsUnhealthyPreWakeRuns(t *testing.T) {
	now := time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)
	stream := &fakeWakeStream{}

	var localRunCancelled, codexRunCancelled, postWakeRunCancelled, localInvokeCancelled atomic.Bool
	var codexInvokeCancelled atomic.Bool

	lib := &fakeWakeLocalModels{
		onRecover: func(_ context.Context, onUnhealthy func(modelIDs, piModels []string, gatewayUnhealthy bool)) {
			onUnhealthy([]string{"qwen3-4b:Q4_K_M"}, []string{localRunModel}, false)
		},
	}

	d := &Daemon{
		now:             func() time.Time { return now },
		operationStream: stream,
		localModels:     lib,
		activeOperations: map[string]*activeOperation{
			"op-local-prewake": {
				identity:  OperationIdentity{OperationID: "op-local-prewake", RuntimeType: "pi"},
				model:     localRunModel,
				startedAt: now.Add(-time.Minute),
				running:   true,
				cancel:    func() { localRunCancelled.Store(true) },
			},
			"op-codex-prewake": {
				identity:  OperationIdentity{OperationID: "op-codex-prewake", RuntimeType: "codex"},
				model:     "gpt-5",
				startedAt: now.Add(-time.Minute),
				running:   true,
				cancel:    func() { codexRunCancelled.Store(true) },
			},
			"op-local-postwake": {
				identity:  OperationIdentity{OperationID: "op-local-postwake", RuntimeType: "pi"},
				model:     localRunModel,
				startedAt: now.Add(time.Second),
				running:   true,
				cancel:    func() { postWakeRunCancelled.Store(true) },
			},
		},
		modelInvokes: map[string]*modelInvoke{
			"inv-local": {
				id:          "inv-local",
				runtimeType: "pi",
				model:       localRunModel,
				startedAt:   now.Add(-time.Minute),
				cancel:      func() { localInvokeCancelled.Store(true) },
			},
			"inv-codex": {
				id:          "inv-codex",
				runtimeType: "codex",
				model:       "gpt-5",
				startedAt:   now.Add(-time.Minute),
				cancel:      func() { codexInvokeCancelled.Store(true) },
			},
		},
	}

	d.HandlePowerResume(t.Context(), 5*time.Minute)

	stream.mu.Lock()
	probed, timeout := stream.probeCount, stream.probeTimeout
	stream.mu.Unlock()
	if probed != 1 || timeout != wakeGatewayProbeTimeout {
		t.Fatalf("gateway probe count=%d timeout=%s", probed, timeout)
	}
	if !localRunCancelled.Load() {
		t.Fatal("pre-wake in-flight local-model Run was not interrupted")
	}
	if d.activeOperations["op-local-prewake"].reason != sleepInterruptedLocalModelReason {
		t.Fatalf("reason = %q, want %q", d.activeOperations["op-local-prewake"].reason, sleepInterruptedLocalModelReason)
	}
	if codexRunCancelled.Load() {
		t.Fatal("unrelated codex Run was interrupted")
	}
	if postWakeRunCancelled.Load() {
		t.Fatal("post-wake local-model Run was interrupted")
	}
	if !localInvokeCancelled.Load() {
		t.Fatal("pre-wake local-model invoke was not cancelled")
	}
	if codexInvokeCancelled.Load() {
		t.Fatal("unrelated codex model invoke was cancelled")
	}
}

func TestHandlePowerResumeSettlesPreWakeLocalRunAsCancelled(t *testing.T) {
	stream := &fakeWakeStream{}
	ledger := NewMemoryLedger()
	command := protocol.Command{
		Type: protocol.CommandOperationStart, CommandID: "cmd-wake", ProtocolVersion: "2",
		TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1,
		AgentID: "agent-1", OperationID: "op-sleep-1", ConnectionEpoch: 1, RunnerRevision: 1,
		Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "pi",
		OperationKind: "run.start", ExecutionContextKey: "ctx-1", RuntimeInstanceID: "rt-1",
		ContextViewRef: testContextViewRef,
	}
	if _, err := ledger.Begin(t.Context(), operationIdentity(command)); err != nil {
		t.Fatal(err)
	}
	opCtx, opCancel := context.WithCancel(t.Context())
	now := time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)
	d := &Daemon{
		now:             func() time.Time { return now },
		ledger:          ledger,
		operationStream: stream,
		activeOperations: map[string]*activeOperation{
			command.OperationID: {
				identity:  operationIdentity(command),
				model:     localRunModel,
				startedAt: now.Add(-2 * time.Minute),
				running:   true,
				ctx:       opCtx,
				cancel:    opCancel,
			},
		},
		modelInvokes: map[string]*modelInvoke{},
	}

	d.interruptOperationsForWake(now, "local", []string{localRunModel}, false)
	if !errors.Is(opCtx.Err(), context.Canceled) {
		t.Fatalf("operation context not cancelled: %v", opCtx.Err())
	}
	d.finishOperation(t.Context(), command, provider.OperationSpec{
		Provider: "pi", Model: localRunModel, OperationKind: "run.start",
	}, provider.Result{
		Status:           "cancelled",
		Error:            "operation cancelled",
		CleanupConfirmed: true,
	})

	stream.mu.Lock()
	events := append([]protocol.Event(nil), stream.events...)
	stream.mu.Unlock()
	if len(events) != 1 || events[0].Type != protocol.EventOperationCancelled {
		t.Fatalf("events = %+v, want single operation.cancelled", events)
	}
	var payload struct {
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(events[0].Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Reason != sleepInterruptedLocalModelReason {
		t.Fatalf("cancelled reason = %q, want %q", payload.Reason, sleepInterruptedLocalModelReason)
	}
}

func TestHandlePowerResumeCoalescesAndSkipsWhenClosing(t *testing.T) {
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	var calls atomic.Int32
	lib := &fakeWakeLocalModels{
		onRecover: func(context.Context, func([]string, []string, bool)) {
			if calls.Add(1) == 1 {
				entered <- struct{}{}
				<-release
			}
		},
	}
	d := &Daemon{
		now:              time.Now,
		localModels:      lib,
		activeOperations: map[string]*activeOperation{},
		modelInvokes:     map[string]*modelInvoke{},
	}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		d.HandlePowerResume(t.Context(), time.Minute)
	}()
	<-entered
	d.HandlePowerResume(t.Context(), 2*time.Minute)
	d.HandlePowerResume(t.Context(), 3*time.Minute)
	close(release)
	wg.Wait()

	if got := calls.Load(); got != 2 {
		t.Fatalf("calls = %d, want 2 (initial + 1 coalesced follow-up)", got)
	}

	d.closing = true
	d.HandlePowerResume(t.Context(), time.Minute)
	if got := calls.Load(); got != 2 {
		t.Fatalf("closing daemon ran wake recovery: calls = %d", got)
	}
	_ = native.RuntimeFailureDiagnostics{}
}
