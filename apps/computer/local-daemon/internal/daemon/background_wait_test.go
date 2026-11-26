package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

func TestDaemonGatesBackgroundWaitEventsByWelcomeFeature(t *testing.T) {
	for _, tc := range []struct {
		name            string
		serviceFeatures []string
		wantWireEvents  int
	}{
		{"without feature", nil, 0},
		{"with operation_background_wait", []string{serviceFeatureOperationBackgroundWait}, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			device, err := transport.GenerateIdentity()
			if err != nil {
				t.Fatal(err)
			}
			messages := make(chan native.Event, 2)
			results := make(chan native.Outcome, 1)
			at := time.UnixMilli(10_000)
			messages <- native.Event{
				Kind:       native.EventBackgroundWaiting,
				ObservedAt: at,
				BackgroundTools: []native.BackgroundTool{
					{CallID: "call-1", ToolName: "schedule", StartedAt: at},
				},
			}
			messages <- native.Event{
				Kind:              native.EventBackgroundResumed,
				ObservedAt:        at.Add(time.Second),
				BackgroundTrigger: "user_input",
			}
			close(messages)
			results <- native.Outcome{Status: "completed", Output: "done"}
			close(results)

			payload := mustJSON(map[string]any{
				"kind": "run.start", "runtime": map[string]any{"type": "antigravity"},
				"input": map[string]any{"type": "text", "text": "hello"},
			})
			stream := &fakeStream{commands: []protocol.Command{
				{Type: "runner.welcome", ConnectionEpoch: 7, ServiceFeatures: tc.serviceFeatures},
				{Type: protocol.CommandRegistrationSnapshot, CommandID: "registration-snapshot-1", ConnectionEpoch: 7,
					Payload: mustJSON([]transport.RuntimeRegistration{{
						RegistrationID: "reg-1",
						Observation: transport.RegistrationObservation{
							TenantID: "tenant-1", OwnerActorID: "owner-1", ProviderType: "antigravity",
							Status: "online", Revision: 1, Capabilities: []string{"turn"},
						},
					}})},
				{Type: protocol.CommandOperationStart, CommandID: "cmd-123",
					ProtocolVersion: "2", TenantID: "tenant-1", RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1,
					AgentID: "agent-1", OperationID: "op-1", ConnectionEpoch: 7, Payload: payload,
					RunnerRevision: 1, Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "antigravity",
					ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1", ContextViewRef: testContextViewRef,
				},
			}}
			daemon, err := newTestDaemon(t, Options{
				ComputerID:        "computer-1",
				OperationResolver: fakeOperationResolver{},
				ControlPlane:      fakeControlPlane{stream: stream},
				IdentityStore:     fakeStore{value: device},
				Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
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
			if daemon.operationBackgroundWait.Load() {
				t.Fatal("operationBackgroundWait was not cleared after stream close")
			}

			var bgEvents []string
			deadline := time.Now().Add(5 * time.Second)
			completed := false
			for !completed && time.Now().Before(deadline) {
				bgEvents = nil
				for _, ev := range stream.snapshotEvents() {
					if ev.Type == protocol.EventOperationCompleted {
						completed = true
					}
					if ev.Type == protocol.EventOperationEvent {
						var decoded struct {
							Type string `json:"type"`
						}
						if json.Unmarshal(ev.Payload, &decoded) == nil &&
							(decoded.Type == "run.background_waiting" || decoded.Type == "run.background_resumed") {
							bgEvents = append(bgEvents, decoded.Type)
						}
					}
				}
				time.Sleep(10 * time.Millisecond)
			}
			if !completed {
				t.Fatal("operation did not complete")
			}
			if len(bgEvents) != tc.wantWireEvents {
				t.Fatalf("background wire events = %v (len %d), want len %d", bgEvents, len(bgEvents), tc.wantWireEvents)
			}
		})
	}
}
