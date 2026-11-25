package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/localmodels"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

const localRunModel = "localmodels-library/localmodels-lib-qwen3-4b-q4-k-m/Qwen3-4B-Q4_K_M"

type localModelOperationResolver struct {
	fakeOperationResolver
	piAgentDir string
}

func (r localModelOperationResolver) Resolve(ctx context.Context, command protocol.Command, request json.RawMessage) (provider.OperationSpec, error) {
	spec, err := r.fakeOperationResolver.Resolve(ctx, command, request)
	spec.Model = localRunModel
	if r.piAgentDir != "" {
		spec.TenantID = command.TenantID
		spec.OwnerActorID = "owner-1"
		spec.AgentID = command.AgentID
		spec.ScopeID = command.ExecutionContextKey
		spec.Environment = map[string]string{"PI_CODING_AGENT_DIR": r.piAgentDir}
	}
	return spec, err
}

// A Pi Run whose local model cannot be loaded fails before its Runtime
// starts, with local_model_unavailable when the Agent Service accepts it and
// model_unavailable otherwise, and the model stays offered.
func TestPiRunFailsWhenItsLocalModelCannotLoad(t *testing.T) {
	for _, tc := range []struct {
		name     string
		features []string
		code     string
	}{
		{"service accepts local_model_unavailable", []string{serviceFeatureLocalModelUnavailable}, "local_model_unavailable"},
		{"older service", nil, "model_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) { runPiRunWithUnloadableModel(t, tc.features, tc.code) })
	}
}

func runPiRunWithUnloadableModel(t *testing.T, features []string, wantCode string) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	payload := mustJSON(map[string]any{
		"kind": "run.start", "runtime": map[string]any{"type": "pi"},
		"input": map[string]any{"type": "text", "text": "hello"},
	})
	stream := &fakeStream{commands: []protocol.Command{
		{Type: "runner.welcome", ConnectionEpoch: 7, ServiceFeatures: features},
		{Type: protocol.CommandRegistrationSnapshot, CommandID: "registration-snapshot-1", ConnectionEpoch: 7,
			Payload: mustJSON([]transport.RuntimeRegistration{{
				RegistrationID: "reg-1",
				Observation: transport.RegistrationObservation{
					TenantID: "tenant-1", OwnerActorID: "owner-1", ProviderType: "pi",
					Status: "online", Revision: 1, Capabilities: []string{"turn"},
				},
			}})},
		{Type: protocol.CommandOperationStart, CommandID: "cmd-123",
			ProtocolVersion: "1.2", TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1,
			AgentID: "agent-1", OperationID: "op-1", ConnectionEpoch: 7, Payload: payload,
			RunnerRevision: 1, Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "pi",
			ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1", ContextViewRef: testContextViewRef,
		},
	}}
	library := &fakeLocalModels{ensureErr: &localmodels.LocalModelLoadError{Code: "LOAD_NO_ROOM", ModelID: "qwen3-4b:Q4_K_M"}}
	started := false
	var rejected []string
	daemon, err := newTestDaemon(t, Options{
		OnModelUnavailable: func(runtimeType, modelID string) { rejected = append(rejected, runtimeType, modelID) },
		ComputerID:         "computer-1",
		OperationResolver:  localModelOperationResolver{},
		ControlPlane:       fakeControlPlane{stream: stream},
		IdentityStore:      fakeStore{value: device},
		LocalModels:        library,
		Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			started = true
			return nil, errors.New("the Runtime must not start")
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	daemon.daemonID = device.DaemonID
	if err := daemon.runConnection(context.Background(), device); !errors.Is(err, io.EOF) {
		t.Fatalf("Run() error = %v, want EOF from fake stream", err)
	}
	var terminal protocol.Event
	deadline := time.Now().Add(5 * time.Second)
	for terminal.Type == "" && time.Now().Before(deadline) {
		for _, event := range stream.snapshotEvents() {
			if event.Type == protocol.EventOperationCompleted || event.Type == protocol.EventOperationFailed {
				terminal = event
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if terminal.Type != protocol.EventOperationFailed {
		t.Fatalf("terminal = %s, want %s", terminal.Type, protocol.EventOperationFailed)
	}
	if started {
		t.Fatal("the Runtime started")
	}
	if len(library.ensured) != 1 || library.ensured[0] != localRunModel {
		t.Fatalf("EnsureLoaded calls = %v", library.ensured)
	}
	var failed struct {
		Failure provider.RuntimeExecutionFailure `json:"failure"`
	}
	if err := json.Unmarshal(terminal.Payload, &failed); err != nil {
		t.Fatal(err)
	}
	if failed.Failure.Code != wantCode || failed.Failure.RuntimeType != "pi" {
		t.Fatalf("failure = %+v", failed.Failure)
	}
	// The Computer could not load the model; the provider did not refuse it.
	if len(rejected) != 0 {
		t.Fatalf("rejected %v", rejected)
	}
}

// Only a Pi Run that names a model asks the library.
func TestEnsureLocalModelSkipsRunsWithoutAPiModel(t *testing.T) {
	library := &fakeLocalModels{}
	d := &Daemon{localModels: library}
	for _, tc := range []struct{ runtimeType, model string }{{"codex", localRunModel}, {"claude", localRunModel}, {"pi", ""}} {
		if code, err := d.ensureLocalModel(t.Context(), tc.runtimeType, tc.model); code != "" || err != nil {
			t.Fatalf("%s %q: code %q, err %v", tc.runtimeType, tc.model, code, err)
		}
	}
	if len(library.ensured) != 0 {
		t.Fatalf("EnsureLoaded calls = %v", library.ensured)
	}
	if code, err := d.ensureLocalModel(t.Context(), "pi", localRunModel); code != "" || err != nil || len(library.ensured) != 1 {
		t.Fatalf("a loaded model: code %q, err %v, calls %v", code, err, library.ensured)
	}
}

// A Pi Run on a library model holds an active use lease while the provider runs
// and releases it once after the terminal event, preventing idle auto-unload
// mid-run without leaking leases.
func TestPiRunHoldsAndReleasesLocalModelUseLease(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	payload := mustJSON(map[string]any{
		"kind": "run.start", "runtime": map[string]any{"type": "pi"},
		"input": map[string]any{"type": "text", "text": "hello"},
	})
	streamRelease := make(chan struct{})
	stream := &fakeStream{
		commands: []protocol.Command{
			{Type: "runner.welcome", ConnectionEpoch: 7, ServiceFeatures: []string{serviceFeatureLocalModelUnavailable}},
			{Type: protocol.CommandRegistrationSnapshot, CommandID: "registration-snapshot-1", ConnectionEpoch: 7,
				Payload: mustJSON([]transport.RuntimeRegistration{{
					RegistrationID: "reg-1",
					Observation: transport.RegistrationObservation{
						TenantID: "tenant-1", OwnerActorID: "owner-1", ProviderType: "pi",
						Status: "online", Revision: 1, Capabilities: []string{"turn"},
					},
				}})},
			{Type: protocol.CommandOperationStart, CommandID: "cmd-lease-1",
				ProtocolVersion: "1.2", TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1,
				AgentID: "agent-1", OperationID: "op-lease-1", ConnectionEpoch: 7, Payload: payload,
				RunnerRevision: 1, Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "pi",
				ExecutionContextKey: "context-lease-1", RuntimeInstanceID: "runtime-1", ContextViewRef: testContextViewRef,
			},
		},
		wait: streamRelease,
	}
	library := &fakeLocalModels{}
	providerStarted := make(chan struct{}, 1)
	providerRelease := make(chan struct{})
	d, err := newTestDaemon(t, Options{
		ComputerID:        "computer-1",
		OperationResolver: localModelOperationResolver{piAgentDir: t.TempDir()},
		ControlPlane:      fakeControlPlane{stream: stream},
		IdentityStore:     fakeStore{value: device},
		LocalModels:       library,
		Executor: provider.Executor{
			RuntimeHomeRoot: t.TempDir(),
			TempBase:        t.TempDir(),
			NewBackend: func(string, native.Profile) (native.Runtime, error) {
				providerStarted <- struct{}{}
				return heldBackend{release: providerRelease}, nil
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	d.daemonID = device.DaemonID
	done := make(chan error, 1)
	go func() { done <- d.runConnection(context.Background(), device) }()

	select {
	case <-providerStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("Pi provider did not start")
	}
	library.mu.Lock()
	activeWhileRunning := library.activeLeases[localRunModel]
	releasesWhileRunning := library.leaseReleases
	library.mu.Unlock()
	if activeWhileRunning != 1 || releasesWhileRunning != 0 {
		t.Fatalf("while running: activeLeases=%d releases=%d, want 1 and 0", activeWhileRunning, releasesWhileRunning)
	}

	close(providerRelease)
	awaitAcceptedOperationEvent(t, stream, "op-lease-1", protocol.EventOperationCompleted)
	close(streamRelease)
	if err := <-done; !errors.Is(err, io.EOF) {
		t.Fatalf("runConnection() error = %v, want EOF", err)
	}
	d.WaitForOperations()

	library.mu.Lock()
	activeAfter := library.activeLeases[localRunModel]
	releasesAfter := library.leaseReleases
	library.mu.Unlock()
	if activeAfter != 0 || releasesAfter != 1 {
		t.Fatalf("after terminal event: activeLeases=%d releases=%d, want 0 and 1", activeAfter, releasesAfter)
	}
}

func TestPiRunEmitsLoadingLocalModelStatusBeforeEnsureLoaded(t *testing.T) {
	for _, tc := range []struct {
		name         string
		features     []string
		standby      bool
		wantPreStart bool
	}{
		{"standby with loading status feature", []string{serviceFeatureLocalModelUnavailable, serviceFeatureLocalModelLoadingStatus}, true, true},
		{"standby without loading status feature", []string{serviceFeatureLocalModelUnavailable}, true, false},
		{"already loaded with loading status feature", []string{serviceFeatureLocalModelUnavailable, serviceFeatureLocalModelLoadingStatus}, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			device, err := transport.GenerateIdentity()
			if err != nil {
				t.Fatal(err)
			}
			payload := mustJSON(map[string]any{
				"kind": "run.start", "runtime": map[string]any{"type": "pi"},
				"input": map[string]any{"type": "text", "text": "hello"},
			})
			stream := &fakeStream{commands: []protocol.Command{
				{Type: "runner.welcome", ConnectionEpoch: 7, ServiceFeatures: tc.features},
				{Type: protocol.CommandRegistrationSnapshot, CommandID: "registration-snapshot-1", ConnectionEpoch: 7,
					Payload: mustJSON([]transport.RuntimeRegistration{{
						RegistrationID: "reg-1",
						Observation: transport.RegistrationObservation{
							TenantID: "tenant-1", OwnerActorID: "owner-1", ProviderType: "pi",
							Status: "online", Revision: 1, Capabilities: []string{"turn"},
						},
					}})},
				{Type: protocol.CommandOperationStart, CommandID: "cmd-loading-1",
					ProtocolVersion: "1.2", TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1,
					AgentID: "agent-1", OperationID: "op-loading-1", ConnectionEpoch: 7, Payload: payload,
					RunnerRevision: 1, Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "pi",
					ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1", ContextViewRef: testContextViewRef,
				},
			}}
			library := &fakeLocalModels{
				standby:   map[string]bool{localRunModel: tc.standby},
				ensureErr: &localmodels.LocalModelLoadError{Code: "LOAD_NO_ROOM", ModelID: "qwen3-4b:Q4_K_M"},
			}
			daemon, err := newTestDaemon(t, Options{
				ComputerID:        "computer-1",
				OperationResolver: localModelOperationResolver{},
				ControlPlane:      fakeControlPlane{stream: stream},
				IdentityStore:     fakeStore{value: device},
				LocalModels:       library,
				Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
					return nil, errors.New("the Runtime must not start")
				}},
			})
			if err != nil {
				t.Fatal(err)
			}
			daemon.daemonID = device.DaemonID
			if err := daemon.runConnection(context.Background(), device); !errors.Is(err, io.EOF) {
				t.Fatalf("runConnection error = %v, want EOF", err)
			}
			var foundLoadingEvent bool
			deadline := time.Now().Add(5 * time.Second)
			for time.Now().Before(deadline) {
				events := stream.snapshotEvents()
				var terminal bool
				for _, ev := range events {
					if ev.Type == protocol.EventOperationFailed {
						terminal = true
					}
					if ev.Type == protocol.EventOperationEvent {
						var body map[string]any
						if json.Unmarshal(ev.Payload, &body) == nil &&
							body["type"] == "status.changed" &&
							body["status"] == "queued" &&
							body["stage"] == "loading_local_model" {
							foundLoadingEvent = true
						}
					}
				}
				if terminal {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			if foundLoadingEvent != tc.wantPreStart {
				t.Fatalf("foundLoadingEvent = %v, want %v", foundLoadingEvent, tc.wantPreStart)
			}
		})
	}
}
