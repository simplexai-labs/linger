package daemon

import (
	"context"
	"encoding/json"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/localmodels"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

type fakeLocalModels struct {
	mu         sync.Mutex
	actions    []localmodels.Action
	refusal    *wire.LocalModelActionRefusal
	unanswered bool
}

func (f *fakeLocalModels) Act(_ context.Context, action localmodels.Action, _ time.Time) (*wire.LocalModelActionRefusal, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.actions = append(f.actions, action)
	return f.refusal, !f.unanswered
}

func (f *fakeLocalModels) Refresh(context.Context) wire.LocalModelsSnapshot {
	return wire.LocalModelsSnapshot{}
}

func TestLocalModelsCommandAnswersAcceptedOrRefused(t *testing.T) {
	library := &fakeLocalModels{}
	d := &Daemon{computerID: "computer", localModels: library, owners: []ComputerOwner{{TenantID: "tenant", OwnerActorID: "owner"}}}
	expires := time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
	send := func(fields map[string]any) (protocol.Event, map[string]any) {
		t.Helper()
		request := map[string]any{
			"type": "execute", "kind": "local_models", "protocol_version": "2", "command_id": "command-1",
			"runner_id": "computer", "tenant_id": "tenant", "owner_actor_id": "owner", "connection_epoch": 7, "expires_at": expires,
		}
		for key, value := range fields {
			request[key] = value
		}
		payload, _ := json.Marshal(request)
		stream := &browserEventStream{}
		command := protocol.Command{Type: protocol.CommandCapabilityLocalModels, ProtocolVersion: "2", CommandID: "command-1", RunnerID: "computer", ConnectionEpoch: 7, Payload: payload}
		if err := d.handleLocalModelsCommand(t.Context(), stream, command); err != nil {
			t.Fatal(err)
		}
		if len(stream.events) != 1 {
			t.Fatalf("events = %+v", stream.events)
		}
		var frame map[string]any
		if err := json.Unmarshal(stream.events[0].Payload, &frame); err != nil {
			t.Fatal(err)
		}
		if frame["type"] != "executed" || frame["kind"] != "local_models" || frame["command_id"] != "command-1" ||
			frame["runner_id"] != "computer" || frame["tenant_id"] != "tenant" || frame["connection_epoch"] != float64(7) ||
			frame["expires_at"] != expires || frame["action"] != request["action"] {
			t.Fatalf("identity was not echoed: %v", frame)
		}
		return stream.events[0], frame
	}

	event, frame := send(map[string]any{"action": "load", "model_id": "qwen3-4b:Q4_K_M", "unload_first": []string{"gemma3-4b:Q4_K_M"}})
	if event.Type != protocol.EventCapabilityLocalModelsAccepted || frame["outcome"] != "accepted" || frame["model_id"] != "qwen3-4b:Q4_K_M" || frame["refusal"] != nil {
		t.Fatalf("accepted = %s %v", event.Type, frame)
	}
	if got := library.actions[0]; got.Name != "load" || got.Model != "qwen3-4b:Q4_K_M" || len(got.UnloadFirst) != 1 || got.UnloadFirst[0] != "gemma3-4b:Q4_K_M" {
		t.Fatalf("action = %+v", got)
	}

	need, free := uint64(8<<30), uint64(2<<30)
	library.refusal = &wire.LocalModelActionRefusal{Code: "LOAD_NO_ROOM", Pool: "gpu:0", NeedBytes: &need, FreeBytes: &free}
	event, frame = send(map[string]any{"action": "load", "model_id": "qwen3-4b:Q4_K_M"})
	refusal, _ := frame["refusal"].(map[string]any)
	if event.Type != protocol.EventCapabilityLocalModelsRefused || frame["outcome"] != "refused" ||
		refusal["code"] != "LOAD_NO_ROOM" || refusal["pool"] != "gpu:0" || refusal["need_bytes"] != float64(need) || refusal["free_bytes"] != float64(free) {
		t.Fatalf("refused = %s %v", event.Type, frame)
	}
	library.refusal = nil

	calls := len(library.actions)
	for _, invalid := range []map[string]any{
		{"action": "download", "model_id": "--base-dir=/tmp"},
		{"action": "refresh", "model_id": "qwen3-4b:Q4_K_M"},
		{"action": "unload", "model_id": "qwen3-4b:Q4_K_M", "unload_first": []string{"other:Q4"}},
		{"action": "format", "model_id": "qwen3-4b:Q4_K_M"},
	} {
		if _, frame := send(invalid); frame["outcome"] != "refused" || frame["refusal"].(map[string]any)["code"] != "MODEL_UNKNOWN" {
			t.Fatalf("%v answered %v", invalid, frame)
		}
	}
	if _, frame := send(map[string]any{"action": "refresh", "owner_actor_id": "intruder"}); frame["refusal"].(map[string]any)["code"] != "TOOL_FAILED" {
		t.Fatalf("another owner answered %v", frame)
	}
	if len(library.actions) != calls {
		t.Fatalf("rejected commands reached the library: %+v", library.actions[calls:])
	}

	d.localModels = nil
	if _, frame := send(map[string]any{"action": "refresh"}); frame["refusal"].(map[string]any)["code"] != "TOOL_NOT_INSTALLED" {
		t.Fatalf("no library answered %v", frame)
	}
}

func TestLocalModelsCommandTheToolDidNotDecideInTimeGetsNoAnswer(t *testing.T) {
	library := &fakeLocalModels{unanswered: true}
	d := &Daemon{computerID: "computer", localModels: library, owners: []ComputerOwner{{TenantID: "tenant", OwnerActorID: "owner"}}}
	payload, _ := json.Marshal(map[string]any{
		"runner_id": "computer", "tenant_id": "tenant", "owner_actor_id": "owner", "action": "load", "model_id": "qwen3-4b:Q4_K_M",
		"expires_at": time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano),
	})
	stream := &browserEventStream{}
	if err := d.handleLocalModelsCommand(t.Context(), stream, protocol.Command{Type: protocol.CommandCapabilityLocalModels, Payload: payload}); err != nil {
		t.Fatal(err)
	}
	// "accepted" would claim a decision the tool never made.
	if len(stream.events) != 0 || len(library.actions) != 1 {
		t.Fatalf("events = %+v, actions = %+v", stream.events, library.actions)
	}
}

func TestExpiredLocalModelsCommandIsNotStarted(t *testing.T) {
	library := &fakeLocalModels{}
	d := &Daemon{computerID: "computer", localModels: library, owners: []ComputerOwner{{TenantID: "tenant", OwnerActorID: "owner"}}}
	payload, _ := json.Marshal(map[string]any{
		"runner_id": "computer", "tenant_id": "tenant", "owner_actor_id": "owner", "action": "download", "model_id": "qwen3-4b:Q4_K_M",
		"expires_at": time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano),
	})
	stream := &browserEventStream{}
	if err := d.handleLocalModelsCommand(t.Context(), stream, protocol.Command{Type: protocol.CommandCapabilityLocalModels, Payload: payload}); err != nil {
		t.Fatal(err)
	}
	if len(stream.events) != 0 || len(library.actions) != 0 {
		t.Fatalf("expired command answered %+v and ran %+v", stream.events, library.actions)
	}
}

// A Computer without the tool reports available:false on connect through the
// real library.
func TestConnectedComputerWithoutTheToolReportsToolNotInstalled(t *testing.T) {
	stream := &browserEventStream{}
	d := &Daemon{computerID: "computer", protocolVersion: protocol.Version, diagnosticsStream: stream}
	library := localmodels.New(localmodels.Options{JobDirectory: filepath.Join(t.TempDir(), "jobs"), Publish: d.PublishLocalModels})
	defer library.Close()
	d.localModels = library
	library.Refresh(t.Context())
	library.Refresh(t.Context())
	if len(stream.events) != 2 {
		t.Fatalf("events = %+v", stream.events)
	}
	for index, event := range stream.events {
		var frame wire.RunnerLocalModels
		if err := json.Unmarshal(event.Payload, &frame); err != nil {
			t.Fatal(err)
		}
		if event.Type != protocol.EventLocalModels || frame.Type != "runner.local_models" || frame.ProtocolVersion != "2" ||
			frame.RunnerID != "computer" || frame.Revision != uint64(index+1) || frame.LocalModels.Available ||
			frame.LocalModels.Reason == nil || frame.LocalModels.Reason.Code != "TOOL_NOT_INSTALLED" {
			t.Fatalf("frame %d = %s %+v", index, event.Type, frame)
		}
	}

	d.diagnosticsStream = nil
	library.Refresh(t.Context())
	if len(stream.events) != 2 {
		t.Fatal("a snapshot was sent without a connection")
	}
}
