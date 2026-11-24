package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/localmodels"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

type fakeLocalModels struct {
	mu         sync.Mutex
	actions    []localmodels.Action
	refusal    *wire.LocalModelActionRefusal
	unanswered bool
	ensured    []string
	ensureErr  error
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

func (f *fakeLocalModels) EnsureLoaded(_ context.Context, piModel string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ensured = append(f.ensured, piModel)
	return f.ensureErr
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
		d.localModelsStream = stream
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
	d.localModelsStream = stream
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
	d.localModelsStream = stream
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
	d := &Daemon{computerID: "computer", protocolVersion: protocol.Version, diagnosticsStream: stream, localModelsStream: stream}
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

	d.diagnosticsStream, d.localModelsStream = nil, nil
	library.Refresh(t.Context())
	if len(stream.events) != 2 {
		t.Fatal("a snapshot was sent without a connection")
	}
}

// publishingLocalModels publishes one snapshot per Refresh, like the real
// library, and counts the reads.
type publishingLocalModels struct {
	fakeLocalModels
	publish   func(wire.LocalModelsSnapshot)
	refreshes chan struct{}
}

func (f *publishingLocalModels) Refresh(context.Context) wire.LocalModelsSnapshot {
	snapshot := wire.LocalModelsSnapshot{Available: true}
	f.publish(snapshot)
	f.refreshes <- struct{}{}
	return snapshot
}

// A newer Computer connected to an Agent Service that predates local models
// (a desktop upgrade leaves the old service running) must not send
// runner.local_models: that service closes the connection on the frame.
// Only a welcome whose service_features names local_models opens the family.
func TestLocalModelsFramesFollowTheWelcomeServiceFeatures(t *testing.T) {
	for _, test := range []struct {
		name     string
		features []string
		want     bool
	}{
		{name: "older service", features: nil, want: false},
		{name: "current service", features: []string{"local_models"}, want: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			device, err := transport.GenerateIdentity()
			if err != nil {
				t.Fatal(err)
			}
			release := make(chan struct{})
			stream := &fakeStream{
				commands: []protocol.Command{
					{Type: protocol.CommandRunnerWelcome, ConnectionEpoch: 1, ServiceFeatures: test.features},
					{Type: protocol.CommandRunnerReconciled, RunnerID: "computer-1", ConnectionEpoch: 1},
				},
				wait: release,
			}
			library := &publishingLocalModels{refreshes: make(chan struct{}, 4)}
			d, err := newTestDaemon(t, Options{
				ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream}, IdentityStore: fakeStore{value: device},
				OperationResolver: fakeOperationResolver{}, LocalModels: library,
				Owners: []ComputerOwner{{TenantID: "tenant", OwnerActorID: "owner"}},
			})
			if err != nil {
				t.Fatal(err)
			}
			library.publish = d.PublishLocalModels
			done := make(chan error, 1)
			go func() { done <- d.runConnection(t.Context(), device) }()
			// Commands apply in order, so the receipt marks the welcome applied.
			deadline := time.Now().Add(5 * time.Second)
			for !d.Reconciled() && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
			if !d.Reconciled() {
				t.Fatal("the connection was not welcomed")
			}
			if test.want {
				select {
				case <-library.refreshes:
				case <-time.After(5 * time.Second):
					t.Fatal("the welcomed connection did not read the library")
				}
			}
			// A library change while connected publishes through the same gate.
			d.PublishLocalModels(wire.LocalModelsSnapshot{Available: true})

			payload, _ := json.Marshal(map[string]any{
				"type": "execute", "kind": "local_models", "protocol_version": "2", "command_id": "command-1",
				"runner_id": "computer-1", "tenant_id": "tenant", "owner_actor_id": "owner", "connection_epoch": 1,
				"expires_at": time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano), "action": "refresh",
			})
			if err := d.handleLocalModelsCommand(t.Context(), stream, protocol.Command{
				Type: protocol.CommandCapabilityLocalModels, ProtocolVersion: "2", CommandID: "command-1",
				RunnerID: "computer-1", ConnectionEpoch: 1, Payload: payload,
			}); err != nil {
				t.Fatal(err)
			}
			close(release)
			if err := <-done; !errors.Is(err, io.EOF) {
				t.Fatalf("connection ended with %v", err)
			}

			var snapshots int
			var outcome protocol.Event
			for _, event := range stream.snapshotEvents() {
				switch event.Type {
				case protocol.EventLocalModels:
					snapshots++
				case protocol.EventCapabilityLocalModelsAccepted, protocol.EventCapabilityLocalModelsRefused:
					outcome = event
				}
			}
			if test.want {
				if snapshots != 2 || outcome.Type != protocol.EventCapabilityLocalModelsAccepted {
					t.Fatalf("snapshots = %d, outcome = %s", snapshots, outcome.Type)
				}
				return
			}
			select {
			case <-library.refreshes:
				t.Fatal("the library was read for a service that does not accept snapshots")
			default:
			}
			if snapshots != 0 || outcome.Type != protocol.EventCapabilityLocalModelsRefused {
				t.Fatalf("snapshots = %d, outcome = %s", snapshots, outcome.Type)
			}
			if actions := library.actions; len(actions) != 0 {
				t.Fatalf("the library ran %+v", actions)
			}
		})
	}
}

func TestPublishLocalModelsDowngradesDiagnosticsForOlderServices(t *testing.T) {
	need, have := uint64(16<<30), uint64(8<<30)
	conc, hostRAM := uint64(1), uint64(19<<30)
	rich := wire.LocalModelsSnapshot{
		Available:  true,
		ObservedAt: "2026-11-22T00:00:00Z",
		Debug:      &wire.LocalModelsDebugInfo{Mode: "tiny", Source: "env"},
		Pools:      []wire.LocalModelPool{},
		Models: []wire.LocalModel{
			{
				ID: "m1:Q4", Name: "M1", Quant: "Q4", Fit: "none", State: "absent",
				Engine: "polystrata", EngineLabel: "PolyStrata 0.2.19-poly.1 · CUDA",
				Concurrency: &conc, HostRamBytes: &hostRAM,
				Availability: wire.LocalModelAvailability{
					Downloadable: false,
					Reason: &wire.LocalModelAvailabilityReason{
						Code:          "DRIVER_UPDATE_REQUIRED",
						RequiredCuda:  "12.8",
						DetectedCuda:  "11.8",
						DriverVersion: "525.60",
					},
				},
			},
			{
				ID: "m2:Q4", Name: "M2", Quant: "Q4", Fit: "none", State: "absent",
				Availability: wire.LocalModelAvailability{
					Downloadable: false,
					Reason: &wire.LocalModelAvailabilityReason{
						Code: "MEMORY_INSUFFICIENT", NeedBytes: &need, HaveBytes: &have, MemoryKind: "ram",
					},
				},
			},
			{
				ID: "m3:Q4", Name: "M3", Quant: "Q4", Fit: "gpu", Pool: "gpu:0", State: "failed",
				Error: &wire.LocalModelError{Code: "UNKNOWN_ERROR", Detail: "future"},
			},
		},
	}

	// Without local_models_diagnostics, local_models_engine, or local_models_concurrency_probe,
	// new fields and codes are downgraded cleanly.
	probing := true
	rich.Models = append(rich.Models, wire.LocalModel{
		ID: "m4:Q4", Name: "M4", Quant: "Q4", Fit: "gpu", Pool: "gpu:0", State: "loading",
		ConcurrencyProbing: &probing,
	})
	streamOld := &browserEventStream{}
	dOld := &Daemon{computerID: "computer", protocolVersion: protocol.Version, localModelsStream: streamOld}
	dOld.PublishLocalModels(rich)
	var oldFrame wire.RunnerLocalModels
	if err := json.Unmarshal(streamOld.events[0].Payload, &oldFrame); err != nil {
		t.Fatal(err)
	}
	if oldFrame.LocalModels.Debug != nil {
		t.Fatalf("legacy service received debug: %+v", oldFrame.LocalModels.Debug)
	}
	if oldFrame.LocalModels.Models[0].Engine != "" || oldFrame.LocalModels.Models[0].EngineLabel != "" ||
		oldFrame.LocalModels.Models[0].Concurrency != nil || oldFrame.LocalModels.Models[0].HostRamBytes != nil {
		t.Fatalf("legacy service received engine metadata: %+v", oldFrame.LocalModels.Models[0])
	}
	if oldFrame.LocalModels.Models[3].ConcurrencyProbing != nil {
		t.Fatalf("legacy service received concurrency_probing: %+v", oldFrame.LocalModels.Models[3])
	}
	r0 := oldFrame.LocalModels.Models[0].Availability.Reason
	if r0 == nil || r0.Code != "PLATFORM_UNSUPPORTED" || r0.RequiredCuda != "" || r0.DetectedCuda != "" {
		t.Fatalf("legacy reason 0 = %+v", r0)
	}
	r1 := oldFrame.LocalModels.Models[1].Availability.Reason
	if r1 == nil || r1.Code != "MEMORY_INSUFFICIENT" || r1.MemoryKind != "" || r1.NeedBytes == nil || *r1.NeedBytes != need {
		t.Fatalf("legacy reason 1 = %+v", r1)
	}
	if oldFrame.LocalModels.Models[2].Error == nil || oldFrame.LocalModels.Models[2].Error.Code != "ENGINE_START_FAILED" {
		t.Fatalf("legacy error = %+v", oldFrame.LocalModels.Models[2].Error)
	}

	// With local_models_diagnostics alone, diagnostics pass through while engine metadata is still stripped.
	streamDiag := &browserEventStream{}
	dDiag := &Daemon{computerID: "computer", protocolVersion: protocol.Version, localModelsStream: streamDiag}
	dDiag.localModelsDiagnostics.Store(true)
	dDiag.PublishLocalModels(rich)
	var diagFrame wire.RunnerLocalModels
	if err := json.Unmarshal(streamDiag.events[0].Payload, &diagFrame); err != nil {
		t.Fatal(err)
	}
	if diagFrame.LocalModels.Debug == nil || diagFrame.LocalModels.Debug.Mode != "tiny" ||
		diagFrame.LocalModels.Models[0].Availability.Reason.Code != "DRIVER_UPDATE_REQUIRED" ||
		diagFrame.LocalModels.Models[1].Availability.Reason.MemoryKind != "ram" ||
		diagFrame.LocalModels.Models[2].Error.Code != "UNKNOWN_ERROR" {
		t.Fatalf("diagnostics frame lost diagnostic fields: %+v", diagFrame.LocalModels)
	}
	if diagFrame.LocalModels.Models[0].Engine != "" || diagFrame.LocalModels.Models[0].Concurrency != nil ||
		diagFrame.LocalModels.Models[0].HostRamBytes != nil {
		t.Fatalf("diagnostics-only service received engine metadata: %+v", diagFrame.LocalModels.Models[0])
	}

	// With local_models_diagnostics, local_models_engine, and local_models_concurrency_probe,
	// all fields pass through intact.
	streamFull := &browserEventStream{}
	dFull := &Daemon{computerID: "computer", protocolVersion: protocol.Version, localModelsStream: streamFull}
	dFull.localModelsDiagnostics.Store(true)
	dFull.localModelsEngine.Store(true)
	dFull.localModelsConcurrencyProbe.Store(true)
	dFull.PublishLocalModels(rich)
	var fullFrame wire.RunnerLocalModels
	if err := json.Unmarshal(streamFull.events[0].Payload, &fullFrame); err != nil {
		t.Fatal(err)
	}
	m0 := fullFrame.LocalModels.Models[0]
	if m0.Engine != "polystrata" || m0.EngineLabel != "PolyStrata 0.2.19-poly.1 · CUDA" ||
		m0.Concurrency == nil || *m0.Concurrency != 1 ||
		m0.HostRamBytes == nil || *m0.HostRamBytes != hostRAM {
		t.Fatalf("full frame lost engine fields: %+v", m0)
	}
	if m3 := fullFrame.LocalModels.Models[3]; m3.ConcurrencyProbing == nil || !*m3.ConcurrencyProbing {
		t.Fatalf("full frame lost concurrency_probing: %+v", m3)
	}
	// Diagnostics + engine without concurrency_probe still strips concurrency_probing.
	if diagFrame.LocalModels.Models[3].ConcurrencyProbing != nil {
		t.Fatalf("service without concurrency_probe received concurrency_probing: %+v", diagFrame.LocalModels.Models[3])
	}
}

func TestPublishLocalModelsGatesExternalHolders(t *testing.T) {
	snapshot := wire.LocalModelsSnapshot{
		Pools: []wire.LocalModelPool{
			{ID: "gpu:0", Kind: "gpu", ExternalHolders: []wire.LocalModelPoolExternalHolder{{Name: "msedge", Bytes: 10}}},
			{ID: "ram", Kind: "ram", ExternalHolders: []wire.LocalModelPoolExternalHolder{}},
		},
	}
	publish := func(feature bool) []map[string]any {
		t.Helper()
		stream := &browserEventStream{}
		d := &Daemon{computerID: "computer", protocolVersion: protocol.Version, localModelsStream: stream}
		d.localModelsExternalHolders.Store(feature)
		d.PublishLocalModels(snapshot)
		var frame struct {
			LocalModels struct {
				Pools []map[string]any `json:"pools"`
			} `json:"local_models"`
		}
		if err := json.Unmarshal(stream.events[0].Payload, &frame); err != nil {
			t.Fatal(err)
		}
		return frame.LocalModels.Pools
	}

	for _, pool := range publish(false) {
		if _, ok := pool["external_holders"]; ok {
			t.Fatalf("legacy service received external_holders: %+v", pool)
		}
	}
	if len(snapshot.Pools[0].ExternalHolders) != 1 || snapshot.Pools[1].ExternalHolders == nil {
		t.Fatalf("stripping mutated the caller's snapshot: %+v", snapshot.Pools)
	}

	pools := publish(true)
	if holders, ok := pools[0]["external_holders"].([]any); !ok || len(holders) != 1 {
		t.Fatalf("holders did not pass through: %+v", pools[0])
	}
	if holders, ok := pools[1]["external_holders"].([]any); !ok || len(holders) != 0 {
		t.Fatalf("empty holders did not pass through as []: %+v", pools[1])
	}
}
