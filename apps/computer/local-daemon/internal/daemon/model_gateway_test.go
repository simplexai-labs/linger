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

type gatewayModelSource struct {
	fakeModelSourceManager
	err     error
	runtime []string
}

func (g *gatewayModelSource) EnsureGateway(_ context.Context, runtimeType string) error {
	g.runtime = append(g.runtime, runtimeType)
	return g.err
}

// A Run on a BYOK gateway that cannot be mounted again fails before its
// Runtime starts, with the public code of the tool's structured cause.
func TestDaemonEnsuresTheModelGatewayBeforeARun(t *testing.T) {
	for _, tc := range []struct {
		name     string
		err      error
		terminal string
		code     string
	}{
		{"gateway up", nil, protocol.EventOperationCompleted, ""},
		{"endpoint unreachable", &localmodels.ModelSourceError{Code: "BYOK_UNREACHABLE", Message: "Could not reach the endpoint."}, protocol.EventOperationFailed, "network_error"},
		{"key rejected", &localmodels.ModelSourceError{Code: "BYOK_AUTH_FAILED", Message: "The endpoint rejected the key."}, protocol.EventOperationFailed, "authentication_required"},
		{"gateway failed", &localmodels.ModelSourceError{Code: "BYOK_GATEWAY_FAILED", Message: "Bifrost did not start."}, protocol.EventOperationFailed, "execution_failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			device, err := transport.GenerateIdentity()
			if err != nil {
				t.Fatal(err)
			}
			messages := make(chan native.Event)
			results := make(chan native.Outcome, 1)
			close(messages)
			results <- native.Outcome{Status: "completed", Output: "pong"}
			close(results)
			payload := mustJSON(map[string]any{
				"kind": "run.start", "runtime": map[string]any{"type": "codex"},
				"input": map[string]any{"type": "text", "text": "hello"},
			})
			stream := &fakeStream{commands: []protocol.Command{
				{Type: "runner.welcome", ConnectionEpoch: 7},
				{Type: protocol.CommandRegistrationSnapshot, CommandID: "registration-snapshot-1", ConnectionEpoch: 7,
					Payload: mustJSON([]transport.RuntimeRegistration{{
						RegistrationID: "reg-1",
						Observation: transport.RegistrationObservation{
							TenantID: "tenant-1", OwnerActorID: "owner-1", ProviderType: "codex",
							Status: "online", Revision: 1, Capabilities: []string{"turn"},
						},
					}})},
				{Type: protocol.CommandOperationStart, CommandID: "cmd-123",
					ProtocolVersion: "1.2", TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1,
					AgentID: "agent-1", OperationID: "op-1", ConnectionEpoch: 7, Payload: payload,
					RunnerRevision: 1, Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "codex",
					ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1", ContextViewRef: testContextViewRef,
				},
			}}
			source := &gatewayModelSource{err: tc.err}
			started := false
			daemon, err := newTestDaemon(t, Options{
				ComputerID:        "computer-1",
				OperationResolver: fakeOperationResolver{},
				ControlPlane:      fakeControlPlane{stream: stream},
				IdentityStore:     fakeStore{value: device},
				ModelSource:       source,
				Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
					started = true
					return fakeBackend{session: &native.Run{Events: messages, Outcome: results}}, nil
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
			if terminal.Type != tc.terminal {
				t.Fatalf("terminal = %s, want %s", terminal.Type, tc.terminal)
			}
			if len(source.runtime) != 1 || source.runtime[0] != "codex" {
				t.Fatalf("EnsureGateway calls = %v, want one for codex", source.runtime)
			}
			if started != (tc.err == nil) {
				t.Fatalf("Runtime started = %v, want %v", started, tc.err == nil)
			}
			if tc.code == "" {
				return
			}
			var failed struct {
				Failure provider.RuntimeExecutionFailure `json:"failure"`
			}
			if err := json.Unmarshal(terminal.Payload, &failed); err != nil {
				t.Fatal(err)
			}
			if failed.Failure.Code != tc.code || failed.Failure.RuntimeType != "codex" {
				t.Fatalf("failure = %+v, want code %s for codex", failed.Failure, tc.code)
			}
		})
	}
}
