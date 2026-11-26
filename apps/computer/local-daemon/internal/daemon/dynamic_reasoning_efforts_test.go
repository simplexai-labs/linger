package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/assignment"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

type recordingControlPlane struct {
	stream transport.Stream
	hellos []transport.Hello
}

func (r *recordingControlPlane) Connect(_ context.Context, hello transport.Hello) (transport.Stream, error) {
	r.hellos = append(r.hellos, hello)
	return r.stream, nil
}

func TestDaemonFiltersDynamicReasoningEffortsForLegacyServicesAndPublishesAfterWelcome(t *testing.T) {
	dynamicDiagnostics := json.RawMessage(`[{"type":"codex","status":"ready","protocol":"app-server","checked_at":"2026-11-25T00:00:00Z","models":[{"id":"gpt-5.4","label":"GPT-5.4","allowed_reasoning_effort":["minimal","low","high"],"default_reasoning_effort":"minimal"}]}]`)

	t.Run("welcome with dynamic_reasoning_efforts publishes unfiltered diagnostics", func(t *testing.T) {
		device, err := transport.GenerateIdentity()
		if err != nil {
			t.Fatal(err)
		}
		stream := &fakeStream{commands: []protocol.Command{
			{Type: protocol.CommandRunnerWelcome, ConnectionEpoch: 1, ServiceFeatures: []string{serviceFeatureDynamicReasoningEfforts}},
		}}
		cp := &recordingControlPlane{stream: stream}
		d, err := newTestDaemon(t, Options{
			ComputerID:         "computer-1",
			OperationResolver:  fakeOperationResolver{},
			ControlPlane:       cp,
			IdentityStore:      fakeStore{value: device},
			Runtimes:           []string{"codex"},
			RuntimeDiagnostics: dynamicDiagnostics,
		})
		if err != nil {
			t.Fatal(err)
		}
		d.daemonID = device.DaemonID
		if err := d.runConnection(context.Background(), device); !errors.Is(err, io.EOF) {
			t.Fatalf("runConnection() = %v, want EOF", err)
		}
		if d.dynamicReasoningEfforts.Load() {
			t.Fatal("dynamicReasoningEfforts was not cleared after disconnect")
		}
		if len(cp.hellos) != 1 {
			t.Fatalf("hello count = %d, want 1", len(cp.hellos))
		}
		var helloDiags []provider.RuntimeDiagnostic
		if err := json.Unmarshal(cp.hellos[0].RuntimeDiagnostics, &helloDiags); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(helloDiags[0].Models[0].AllowedReasoningEffort, []string{"low", "high"}) ||
			helloDiags[0].Models[0].DefaultReasoningEffort != "" {
			t.Fatalf("hello diagnostics did not filter non-legacy efforts: %+v", helloDiags[0].Models[0])
		}

		var diagEvents []protocol.Event
		for _, event := range stream.snapshotEvents() {
			if event.Type == protocol.EventRuntimeDiagnostics {
				diagEvents = append(diagEvents, event)
			}
		}
		if len(diagEvents) != 1 {
			t.Fatalf("runtime_diagnostics event count = %d, want 1", len(diagEvents))
		}
		var published []provider.RuntimeDiagnostic
		if err := json.Unmarshal(diagEvents[0].Payload, &published); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(published[0].Models[0].AllowedReasoningEffort, []string{"minimal", "low", "high"}) ||
			published[0].Models[0].DefaultReasoningEffort != "minimal" {
			t.Fatalf("post-welcome diagnostics = %+v, want unfiltered minimal effort", published[0].Models[0])
		}
	})

	t.Run("welcome without dynamic_reasoning_efforts keeps legacy filtering", func(t *testing.T) {
		device, err := transport.GenerateIdentity()
		if err != nil {
			t.Fatal(err)
		}
		release := make(chan struct{})
		stream := &fakeStream{
			commands: []protocol.Command{
				{Type: protocol.CommandRunnerWelcome, ConnectionEpoch: 1},
			},
			wait: release,
		}
		cp := &recordingControlPlane{stream: stream}
		d, err := newTestDaemon(t, Options{
			ComputerID:         "computer-1",
			OperationResolver:  fakeOperationResolver{},
			ControlPlane:       cp,
			IdentityStore:      fakeStore{value: device},
			Runtimes:           []string{"codex"},
			RuntimeDiagnostics: dynamicDiagnostics,
		})
		if err != nil {
			t.Fatal(err)
		}
		d.daemonID = device.DaemonID
		done := make(chan error, 1)
		go func() { done <- d.runConnection(context.Background(), device) }()
		deadline := time.Now().Add(5 * time.Second)
		for d.GatewayState() != "connected" && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		if d.GatewayState() != "connected" {
			t.Fatal("daemon did not reach connected state")
		}

		// No extra diagnostics event on welcome without the feature.
		for _, event := range stream.snapshotEvents() {
			if event.Type == protocol.EventRuntimeDiagnostics {
				t.Fatalf("unexpected post-welcome runtime_diagnostics without feature: %+v", event)
			}
		}
		// Subsequent UpdateRuntimeInventory must also filter non-legacy efforts.
		updated := json.RawMessage(`[{"type":"codex","status":"ready","protocol":"app-server","checked_at":"2026-11-25T00:01:00Z","models":[{"id":"gpt-5.4","label":"GPT-5.4","allowed_reasoning_effort":["minimal","medium"],"default_reasoning_effort":"minimal"}]}]`)
		if err := d.UpdateRuntimeInventory(context.Background(), []string{"codex"}, updated, nil); err != nil {
			t.Fatal(err)
		}
		close(release)
		if err := <-done; !errors.Is(err, io.EOF) {
			t.Fatalf("runConnection() = %v, want EOF", err)
		}
		var diagEvents []protocol.Event
		for _, event := range stream.snapshotEvents() {
			if event.Type == protocol.EventRuntimeDiagnostics {
				diagEvents = append(diagEvents, event)
			}
		}
		if len(diagEvents) != 1 {
			t.Fatalf("runtime_diagnostics event count = %d, want 1", len(diagEvents))
		}
		var published []provider.RuntimeDiagnostic
		if err := json.Unmarshal(diagEvents[0].Payload, &published); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(published[0].Models[0].AllowedReasoningEffort, []string{"medium"}) ||
			published[0].Models[0].DefaultReasoningEffort != "" {
			t.Fatalf("filtered update diagnostics = %+v, want [medium] with empty default", published[0].Models[0])
		}
	})
}

type blockingDiagnosticsStream struct {
	mu               sync.Mutex
	commands         []protocol.Command
	events           []protocol.Event
	wait             <-chan struct{}
	firstDiagBlocked chan struct{}
	releaseFirstDiag <-chan struct{}
	blockedOnce      bool
}

func (s *blockingDiagnosticsStream) Receive(context.Context) (protocol.Command, error) {
	s.mu.Lock()
	if len(s.commands) > 0 {
		cmd := s.commands[0]
		s.commands = s.commands[1:]
		s.mu.Unlock()
		return cmd, nil
	}
	s.mu.Unlock()
	if s.wait != nil {
		<-s.wait
	}
	return protocol.Command{}, io.EOF
}

func (s *blockingDiagnosticsStream) Send(_ context.Context, event protocol.Event) error {
	if event.Type == protocol.EventRuntimeDiagnostics {
		s.mu.Lock()
		shouldBlock := !s.blockedOnce
		s.blockedOnce = true
		s.mu.Unlock()
		if shouldBlock {
			close(s.firstDiagBlocked)
			<-s.releaseFirstDiag
		}
	}
	s.mu.Lock()
	s.events = append(s.events, event)
	s.mu.Unlock()
	return nil
}

func (s *blockingDiagnosticsStream) Close() error { return nil }

func (s *blockingDiagnosticsStream) snapshotDiagnostics() []protocol.Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []protocol.Event
	for _, event := range s.events {
		if event.Type == protocol.EventRuntimeDiagnostics {
			out = append(out, event)
		}
	}
	return out
}

func TestDaemonSerializesDiagnosticsRevisionsAcrossWelcomeAndInventoryUpdate(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	initialDiagnostics := json.RawMessage(`[{"type":"codex","status":"ready","protocol":"app-server","checked_at":"2026-11-25T00:00:00Z","models":[{"id":"gpt-5.4","label":"GPT-5.4","allowed_reasoning_effort":["minimal","low"],"default_reasoning_effort":"minimal"}]}]`)
	firstDiagBlocked := make(chan struct{})
	releaseFirstDiag := make(chan struct{})
	releaseStream := make(chan struct{})
	stream := &blockingDiagnosticsStream{
		commands: []protocol.Command{
			{Type: protocol.CommandRunnerWelcome, ConnectionEpoch: 1, ServiceFeatures: []string{serviceFeatureDynamicReasoningEfforts}},
		},
		wait:             releaseStream,
		firstDiagBlocked: firstDiagBlocked,
		releaseFirstDiag: releaseFirstDiag,
	}
	cp := &recordingControlPlane{stream: stream}
	d, err := newTestDaemon(t, Options{
		ComputerID:         "computer-1",
		OperationResolver:  fakeOperationResolver{},
		ControlPlane:       cp,
		IdentityStore:      fakeStore{value: device},
		Runtimes:           []string{"codex"},
		RuntimeDiagnostics: initialDiagnostics,
	})
	if err != nil {
		t.Fatal(err)
	}
	d.daemonID = device.DaemonID

	connDone := make(chan error, 1)
	go func() { connDone <- d.runConnection(context.Background(), device) }()

	// Wait until activateStreamAndReplay is mid-Send while holding connectionMu.
	select {
	case <-firstDiagBlocked:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for activateStreamAndReplay diagnostics send")
	}

	// Launch concurrent UpdateRuntimeInventory calls while welcome replay is in flight.
	intermediateDiagnostics := json.RawMessage(`[{"type":"codex","status":"ready","protocol":"app-server","checked_at":"2026-11-25T00:01:00Z","models":[{"id":"gpt-5.4","label":"GPT-5.4","allowed_reasoning_effort":["minimal","medium"],"default_reasoning_effort":"medium"}]}]`)
	finalDiagnostics := json.RawMessage(`[{"type":"codex","status":"ready","protocol":"app-server","checked_at":"2026-11-25T00:02:00Z","models":[{"id":"gpt-5.4","label":"GPT-5.4","allowed_reasoning_effort":["minimal","low","high","custom_2"],"default_reasoning_effort":"custom_2"}]}]`)

	updateErrs := make(chan error, 2)
	firstUpdateStarted := make(chan struct{})
	go func() {
		close(firstUpdateStarted)
		updateErrs <- d.UpdateRuntimeInventory(context.Background(), []string{"codex"}, intermediateDiagnostics, nil)
	}()
	<-firstUpdateStarted
	// Give the first update a moment to contend on connectionMu before releasing welcome send.
	time.Sleep(15 * time.Millisecond)
	close(releaseFirstDiag)

	if err := <-updateErrs; err != nil {
		t.Fatalf("intermediate UpdateRuntimeInventory failed: %v", err)
	}
	if err := d.UpdateRuntimeInventory(context.Background(), []string{"codex"}, finalDiagnostics, nil); err != nil {
		t.Fatalf("final UpdateRuntimeInventory failed: %v", err)
	}

	close(releaseStream)
	if err := <-connDone; !errors.Is(err, io.EOF) {
		t.Fatalf("runConnection() = %v, want EOF", err)
	}

	diagEvents := stream.snapshotDiagnostics()
	if len(diagEvents) < 2 {
		t.Fatalf("runtime_diagnostics event count = %d, want >= 2", len(diagEvents))
	}
	for i := 1; i < len(diagEvents); i++ {
		if diagEvents[i].Revision <= diagEvents[i-1].Revision {
			t.Fatalf("diagnostics revisions not strictly increasing: [%d]=%d [%d]=%d",
				i-1, diagEvents[i-1].Revision, i, diagEvents[i].Revision)
		}
	}
	var last []provider.RuntimeDiagnostic
	if err := json.Unmarshal(diagEvents[len(diagEvents)-1].Payload, &last); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(last[0].Models[0].AllowedReasoningEffort, []string{"minimal", "low", "high", "custom_2"}) ||
		last[0].Models[0].DefaultReasoningEffort != "custom_2" {
		t.Fatalf("final diagnostics payload = %+v, want latest unfiltered efforts", last[0].Models[0])
	}
}

func TestDaemonConnectionHelloFiltersNonLegacyAgentRunnerEfforts(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	stream := &fakeStream{commands: []protocol.Command{
		{Type: protocol.CommandRunnerWelcome, ConnectionEpoch: 1},
	}}
	cp := &recordingControlPlane{stream: stream}
	d, err := newTestDaemon(t, Options{
		ComputerID:        "computer-1",
		OperationResolver: fakeOperationResolver{},
		ControlPlane:      cp,
		IdentityStore:     fakeStore{value: device},
		Runtimes:          []string{"codex"},
	})
	if err != nil {
		t.Fatal(err)
	}
	d.daemonID = device.DaemonID

	for _, cmd := range []assignment.Command{
		{
			Type:               protocol.CommandAgentRunnerEnsure,
			CommandID:          "cmd-minimal",
			RunnerID:           "computer-1",
			TenantID:           "tenant-1",
			AgentID:            "agent-minimal",
			RegistrationID:     "reg-1",
			AssignmentRevision: 1,
			RunnerRevision:     1,
			WorkspaceGrantID:   "grant-1",
			Runtime:            json.RawMessage(`{"type":"codex","model":"gpt-5.4","reasoning_effort":"minimal"}`),
		},
		{
			Type:               protocol.CommandAgentRunnerEnsure,
			CommandID:          "cmd-high",
			RunnerID:           "computer-1",
			TenantID:           "tenant-1",
			AgentID:            "agent-high",
			RegistrationID:     "reg-1",
			AssignmentRevision: 1,
			RunnerRevision:     1,
			WorkspaceGrantID:   "grant-1",
			Runtime:            json.RawMessage(`{"type":"codex","model":"gpt-5.4","reasoning_effort":"high"}`),
		},
	} {
		if _, err := d.assignments.Apply(context.Background(), cmd, 0); err != nil {
			t.Fatal(err)
		}
	}

	if err := d.runConnection(context.Background(), device); !errors.Is(err, io.EOF) {
		t.Fatalf("runConnection() = %v, want EOF", err)
	}
	if len(cp.hellos) != 1 {
		t.Fatalf("hello count = %d, want 1", len(cp.hellos))
	}
	var helloRunners []assignment.Record
	if err := json.Unmarshal(cp.hellos[0].AgentRunners, &helloRunners); err != nil {
		t.Fatal(err)
	}
	if len(helloRunners) != 2 {
		t.Fatalf("hello.AgentRunners count = %d, want 2", len(helloRunners))
	}
	helloByAgent := map[string]map[string]any{}
	for _, rec := range helloRunners {
		var rt map[string]any
		if err := json.Unmarshal(rec.Runtime, &rt); err != nil {
			t.Fatal(err)
		}
		helloByAgent[rec.AgentID] = rt
	}
	if _, hasEffort := helloByAgent["agent-minimal"]["reasoning_effort"]; hasEffort {
		t.Fatalf("hello.AgentRunners kept non-legacy reasoning_effort: %v", helloByAgent["agent-minimal"])
	}
	if helloByAgent["agent-minimal"]["type"] != "codex" || helloByAgent["agent-minimal"]["model"] != "gpt-5.4" {
		t.Fatalf("hello.AgentRunners dropped other runtime fields: %v", helloByAgent["agent-minimal"])
	}
	if helloByAgent["agent-high"]["reasoning_effort"] != "high" {
		t.Fatalf("hello.AgentRunners altered legacy reasoning_effort: %v", helloByAgent["agent-high"])
	}

	// Stored assignments must not be mutated.
	stored, err := d.assignments.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	storedByAgent := map[string]map[string]any{}
	for _, rec := range stored {
		var rt map[string]any
		if err := json.Unmarshal(rec.Runtime, &rt); err != nil {
			t.Fatal(err)
		}
		storedByAgent[rec.AgentID] = rt
	}
	if storedByAgent["agent-minimal"]["reasoning_effort"] != "minimal" {
		t.Fatalf("d.assignments was mutated: %v", storedByAgent["agent-minimal"])
	}
}
