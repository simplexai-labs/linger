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

type localModelOperationResolver struct{ fakeOperationResolver }

func (r localModelOperationResolver) Resolve(ctx context.Context, command protocol.Command, request json.RawMessage) (provider.OperationSpec, error) {
	spec, err := r.fakeOperationResolver.Resolve(ctx, command, request)
	spec.Model = localRunModel
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
