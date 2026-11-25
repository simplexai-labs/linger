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
	release <-chan struct{}
	runtime []string
}

func (g *gatewayModelSource) EnsureGateway(_ context.Context, runtimeType string) error {
	if g.release != nil {
		<-g.release
	}
	g.runtime = append(g.runtime, runtimeType)
	return g.err
}

// A Run on a BYOK gateway that cannot be mounted again fails before its
// Runtime starts, with the public code of the tool's structured cause.
func TestDaemonEnsuresTheModelGatewayBeforeARun(t *testing.T) {
	for _, tc := range []struct {
		name              string
		serviceFeatures   []string
		waitForDisconnect bool
		err               error
		terminal          string
		code              string
	}{
		{"gateway up", []string{serviceFeatureModelGatewayUnavailable}, false, nil, protocol.EventOperationCompleted, ""},
		{"endpoint unreachable", []string{serviceFeatureModelGatewayUnavailable}, false, &localmodels.ModelSourceError{Code: "BYOK_UNREACHABLE", Message: "Could not reach the endpoint."}, protocol.EventOperationFailed, "network_error"},
		{"network unavailable", []string{serviceFeatureModelGatewayUnavailable}, false, &localmodels.ModelSourceError{Code: "NETWORK_UNAVAILABLE", Message: "Network is unavailable."}, protocol.EventOperationFailed, "network_error"},
		{"key rejected", []string{serviceFeatureModelGatewayUnavailable}, false, &localmodels.ModelSourceError{Code: "BYOK_AUTH_FAILED", Message: "The endpoint rejected the key."}, protocol.EventOperationFailed, "authentication_required"},
		{"gateway failed with feature", []string{serviceFeatureModelGatewayUnavailable}, false, &localmodels.ModelSourceError{Code: "BYOK_GATEWAY_FAILED", Message: "Bifrost did not start."}, protocol.EventOperationFailed, "model_gateway_unavailable"},
		{"gateway failed after stream close keeps admitted feature", []string{serviceFeatureModelGatewayUnavailable}, true, &localmodels.ModelSourceError{Code: "BYOK_GATEWAY_FAILED", Message: "Bifrost did not start."}, protocol.EventOperationFailed, "model_gateway_unavailable"},
		{"gateway timeout with feature", []string{serviceFeatureModelGatewayUnavailable}, false, &localmodels.ModelSourceError{Code: "MODEL_SOURCE_TIMEOUT", Message: "Timed out starting the BYOK gateway on this Computer."}, protocol.EventOperationFailed, "model_gateway_unavailable"},
		{"gateway tool failed with feature", []string{serviceFeatureModelGatewayUnavailable}, false, &localmodels.ModelSourceError{Code: localmodels.CodeToolFailed, Message: "The BYOK gateway could not be started on this Computer."}, protocol.EventOperationFailed, "model_gateway_unavailable"},
		{"gateway failed without feature", nil, false, &localmodels.ModelSourceError{Code: "BYOK_GATEWAY_FAILED", Message: "Bifrost did not start."}, protocol.EventOperationFailed, "execution_failed"},
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
				{Type: "runner.welcome", ConnectionEpoch: 7, ServiceFeatures: tc.serviceFeatures},
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
			var release chan struct{}
			if tc.waitForDisconnect {
				release = make(chan struct{})
			}
			source := &gatewayModelSource{err: tc.err, release: release}
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
			if release != nil {
				if daemon.modelGatewayUnavailable.Load() {
					t.Fatal("modelGatewayUnavailable was not cleared after stream close")
				}
				close(release)
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

// A model call on a gateway that cannot be mounted again never reaches the
// Runtime, and its receipt names the tool's code. An endpoint or network the
// tool could not reach makes the call unavailable, so the caller waits for
// the Computer instead of spending attempts.
func TestModelInvokeReportsAModelGatewayThatCannotStart(t *testing.T) {
	for _, tc := range []struct {
		code, outcome string
	}{
		{"BYOK_UNREACHABLE", "unavailable"},
		{"NETWORK_UNAVAILABLE", "unavailable"},
		{"BYOK_AUTH_FAILED", "auth_required"},
		{"GATEWAY_START_FAILED", "runtime_unavailable"},
	} {
		t.Run(tc.code, func(t *testing.T) {
			invoker := newFakeModelInvoker()
			d, stream := modelInvokeFixture(t, invoker)
			d.modelSource = &gatewayModelSource{err: &localmodels.ModelSourceError{Code: tc.code, Message: "The gateway did not start."}}
			if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand("invoke-1", nil)); err != nil {
				t.Fatal(err)
			}
			payload := waitForModelInvoked(t, stream, "invoke-1")
			if payload["outcome"] != tc.outcome || payload["reason"] != "The model gateway could not be started ("+tc.code+")" {
				t.Fatalf("payload = %v", payload)
			}
			if invoker.calls() != 0 {
				t.Fatalf("invoker calls = %d, want 0", invoker.calls())
			}
		})
	}
}
