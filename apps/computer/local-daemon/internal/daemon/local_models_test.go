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
	mu            sync.Mutex
	actions       []localmodels.Action
	refusal       *wire.LocalModelActionRefusal
	unanswered    bool
	ensured       []string
	ensureErr     error
	standby       map[string]bool
	loadedHealthy map[string]bool
	activeLeases  map[string]int
	leaseReleases int
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

func (f *fakeLocalModels) IsStandbyModel(piModel string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.standby[piModel]
}

func (f *fakeLocalModels) WillLoad(piModel string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.standby[piModel]
}

func (f *fakeLocalModels) IsLoadedHealthy(_ context.Context, piModel string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.loadedHealthy == nil {
		return !f.standby[piModel]
	}
	healthy, ok := f.loadedHealthy[piModel]
	if !ok {
		return true
	}
	return healthy
}

func (f *fakeLocalModels) AcquireUse(piModel string) func() {
	f.mu.Lock()
	if f.activeLeases == nil {
		f.activeLeases = make(map[string]int)
	}
	f.activeLeases[piModel]++
	f.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			f.mu.Lock()
			f.activeLeases[piModel]--
			f.leaseReleases++
			f.mu.Unlock()
		})
	}
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

func TestPublishLocalModelsGatesStorageFields(t *testing.T) {
	exists := true
	storage := &wire.LocalModelStorage{
		Dir:          "/home/alice/.simplexai/runtime/localmodels/models/models",
		PrimaryPath:  "/home/alice/.simplexai/runtime/localmodels/models/models/qwen.gguf",
		DedicatedDir: false,
		DiskBytes:    4096,
		FilesPresent: true,
		Files: []wire.LocalModelStorageFile{
			{Path: "/home/alice/.simplexai/runtime/localmodels/models/models/qwen.gguf", Role: "weights", SizeBytes: 4096, Present: true, Shared: false},
		},
	}
	snapshot := wire.LocalModelsSnapshot{
		Available:  true,
		ObservedAt: "2026-11-27T00:00:00Z",
		Host: &wire.LocalModelHost{
			Platform:        "linux",
			Arch:            "x86_64",
			OsLabel:         "Ubuntu",
			EngineLabel:     "llama.cpp",
			ModelsDir:       "/home/alice/.simplexai/runtime/localmodels/models/models",
			ModelsDirExists: &exists,
			Gpus:            []wire.LocalModelGpu{},
		},
		Pools: []wire.LocalModelPool{},
		Models: []wire.LocalModel{
			{ID: "qwen:Q4", Name: "Qwen", Quant: "Q4", Fit: "gpu", Pool: "gpu:0", State: "idle", Storage: storage},
		},
	}

	publish := func(feature bool) map[string]any {
		t.Helper()
		stream := &browserEventStream{}
		d := &Daemon{computerID: "computer", protocolVersion: protocol.Version, localModelsStream: stream}
		d.localModelsStorage.Store(feature)
		d.PublishLocalModels(snapshot)
		var frame struct {
			LocalModels map[string]any `json:"local_models"`
		}
		if err := json.Unmarshal(stream.events[0].Payload, &frame); err != nil {
			t.Fatal(err)
		}
		return frame.LocalModels
	}

	legacy := publish(false)
	legacyHost := legacy["host"].(map[string]any)
	if _, ok := legacyHost["models_dir"]; ok {
		t.Fatalf("legacy service received host.models_dir: %+v", legacyHost)
	}
	if _, ok := legacyHost["models_dir_exists"]; ok {
		t.Fatalf("legacy service received host.models_dir_exists: %+v", legacyHost)
	}
	legacyModel := legacy["models"].([]any)[0].(map[string]any)
	if _, ok := legacyModel["storage"]; ok {
		t.Fatalf("legacy service received model.storage: %+v", legacyModel)
	}
	// Caller-owned Host pointer and Models slice must remain unmutated.
	if snapshot.Host.ModelsDir == "" || snapshot.Host.ModelsDirExists == nil || snapshot.Models[0].Storage == nil {
		t.Fatalf("stripping mutated caller-owned snapshot: host=%+v model=%+v", snapshot.Host, snapshot.Models[0])
	}

	modern := publish(true)
	modernHost := modern["host"].(map[string]any)
	if modernHost["models_dir"] != snapshot.Host.ModelsDir || modernHost["models_dir_exists"] != true {
		t.Fatalf("modern host lost storage fields: %+v", modernHost)
	}
	modernModel := modern["models"].([]any)[0].(map[string]any)
	modernStorage, ok := modernModel["storage"].(map[string]any)
	if !ok || modernStorage["primary_path"] != storage.PrimaryPath {
		t.Fatalf("modern model lost storage: %+v", modernModel)
	}
}

func TestLocalModelsForceLoadAndAdmissionV2Gating(t *testing.T) {
	library := &fakeLocalModels{}
	d := &Daemon{computerID: "computer", protocolVersion: protocol.Version, localModels: library, owners: []ComputerOwner{{TenantID: "tenant", OwnerActorID: "owner"}}}
	expires := time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
	send := func(fields map[string]any) map[string]any {
		t.Helper()
		request := map[string]any{
			"type": "execute", "kind": "local_models", "protocol_version": "2", "command_id": "command-force",
			"runner_id": "computer", "tenant_id": "tenant", "owner_actor_id": "owner", "connection_epoch": 7, "expires_at": expires,
		}
		for key, value := range fields {
			request[key] = value
		}
		payload, _ := json.Marshal(request)
		stream := &browserEventStream{}
		d.localModelsStream = stream
		if err := d.handleLocalModelsCommand(t.Context(), stream, protocol.Command{
			Type: protocol.CommandCapabilityLocalModels, ProtocolVersion: "2", CommandID: "command-force",
			RunnerID: "computer", ConnectionEpoch: 7, Payload: payload,
		}); err != nil {
			t.Fatal(err)
		}
		var frame map[string]any
		if err := json.Unmarshal(stream.events[0].Payload, &frame); err != nil {
			t.Fatal(err)
		}
		return frame
	}

	if frame := send(map[string]any{"action": "load", "model_id": "qwen3-4b:Q4_K_M", "force": true}); frame["outcome"] != "accepted" {
		t.Fatalf("force load outcome = %v", frame)
	}
	if len(library.actions) != 1 || !library.actions[0].Force {
		t.Fatalf("force load action = %+v", library.actions)
	}
	for _, invalid := range []map[string]any{
		{"action": "unload", "model_id": "qwen3-4b:Q4_K_M", "force": true},
		{"action": "download", "model_id": "qwen3-4b:Q4_K_M", "force": true},
		{"action": "refresh", "force": true},
	} {
		frame := send(invalid)
		if frame["outcome"] != "refused" || frame["refusal"].(map[string]any)["code"] != "MODEL_UNKNOWN" {
			t.Fatalf("%v answered %v", invalid, frame)
		}
	}

	// Refusal shortfall_bytes and can_force are stripped unless local_models_admission_v2 is negotiated.
	need, free, shortfall := uint64(10<<30), uint64(6<<30), uint64(4<<30)
	canForce := true
	library.refusal = &wire.LocalModelActionRefusal{
		Code: "LOAD_NO_ROOM", Pool: "unified", NeedBytes: &need, FreeBytes: &free,
		ShortfallBytes: &shortfall, CanForce: &canForce,
	}
	legacyFrame := send(map[string]any{"action": "load", "model_id": "qwen3-4b:Q4_K_M"})
	legacyRefusal := legacyFrame["refusal"].(map[string]any)
	if _, hasShortfall := legacyRefusal["shortfall_bytes"]; hasShortfall {
		t.Fatalf("legacy refusal leaked shortfall_bytes: %+v", legacyRefusal)
	}
	if _, hasCanForce := legacyRefusal["can_force"]; hasCanForce {
		t.Fatalf("legacy refusal leaked can_force: %+v", legacyRefusal)
	}

	d.localModelsAdmissionV2.Store(true)
	v2Frame := send(map[string]any{"action": "load", "model_id": "qwen3-4b:Q4_K_M"})
	v2Refusal := v2Frame["refusal"].(map[string]any)
	if v2Refusal["shortfall_bytes"] != float64(shortfall) || v2Refusal["can_force"] != true {
		t.Fatalf("admission v2 refusal lost room fields: %+v", v2Refusal)
	}

	// Snapshot elastic fields are stripped unless local_models_admission_v2 is negotiated.
	minBytes, retries := uint64(5<<30), uint64(1)
	pressureFree, pressureBudget := uint64(1<<30), uint64(8<<30)
	degraded, forced := true, true
	snap := wire.LocalModelsSnapshot{
		Available: true, ObservedAt: "2026-11-25T00:00:00Z", Pools: []wire.LocalModelPool{},
		Models: []wire.LocalModel{
			{
				ID: "m1:Q4", Name: "M1", Quant: "Q4", Fit: "gpu", Pool: "gpu:0", State: "loaded",
				MinimumMemoryBytes: &minBytes, Degraded: &degraded, DegradationReason: "reduced_context",
				RequestedPosture: &wire.LocalModelPosture{ContextTokens: 65536, Slots: 2},
				EffectivePosture: &wire.LocalModelPosture{ContextTokens: 32768, Slots: 1},
				MemoryPressureWarning: &wire.LocalModelPressureWarning{
					Level: "soft", Pool: "gpu:0", FreeBytes: &pressureFree, BudgetBytes: &pressureBudget,
				},
				OomRetries: &retries, Forced: &forced,
			},
			{
				ID: "m2:Q4", Name: "M2", Quant: "Q4", Fit: "gpu", Pool: "gpu:0", State: "failed",
				Error: &wire.LocalModelError{
					Code: "LOAD_NO_ROOM", Pool: "gpu:0", NeedBytes: &need, FreeBytes: &free,
					ShortfallBytes: &shortfall, CanForce: &canForce,
				},
			},
		},
	}
	publish := func(feature bool) wire.LocalModelsSnapshot {
		stream := &browserEventStream{}
		daemon := &Daemon{computerID: "computer", protocolVersion: protocol.Version, localModelsStream: stream}
		daemon.localModelsAdmissionV2.Store(feature)
		daemon.PublishLocalModels(snap)
		var frame wire.RunnerLocalModels
		if err := json.Unmarshal(stream.events[0].Payload, &frame); err != nil {
			t.Fatal(err)
		}
		return frame.LocalModels
	}
	oldSnap := publish(false)
	if oldSnap.Models[0].MinimumMemoryBytes != nil || oldSnap.Models[0].Degraded != nil ||
		oldSnap.Models[0].EffectivePosture != nil || oldSnap.Models[0].MemoryPressureWarning != nil ||
		oldSnap.Models[0].OomRetries != nil || oldSnap.Models[0].Forced != nil ||
		oldSnap.Models[1].Error.Pool != "" || oldSnap.Models[1].Error.ShortfallBytes != nil || oldSnap.Models[1].Error.CanForce != nil {
		t.Fatalf("legacy snapshot leaked admission v2 fields: %+v", oldSnap.Models)
	}
	v2Snap := publish(true)
	if v2Snap.Models[0].MinimumMemoryBytes == nil || *v2Snap.Models[0].MinimumMemoryBytes != minBytes ||
		v2Snap.Models[0].Degraded == nil || !*v2Snap.Models[0].Degraded ||
		v2Snap.Models[0].EffectivePosture == nil || v2Snap.Models[0].MemoryPressureWarning == nil ||
		v2Snap.Models[1].Error.ShortfallBytes == nil || *v2Snap.Models[1].Error.ShortfallBytes != shortfall ||
		v2Snap.Models[1].Error.CanForce == nil || !*v2Snap.Models[1].Error.CanForce {
		t.Fatalf("v2 snapshot lost admission v2 fields: %+v", v2Snap.Models)
	}
}
func TestPublishLocalModelsGatesCustomFeature(t *testing.T) {
	shardIdx, shardCnt, ctxTokens := uint64(1), uint64(3), uint64(4096)
	snapshot := wire.LocalModelsSnapshot{
		Available:  true,
		ObservedAt: "2026-11-26T00:00:00Z",
		Host: &wire.LocalModelHost{
			Platform: "darwin", Arch: "arm64", OsLabel: "macOS", EngineLabel: "llama.cpp",
			Gpus: []wire.LocalModelGpu{}, SupportedFormats: []string{"gguf", "mlx"},
		},
		Pools: []wire.LocalModelPool{},
		Models: []wire.LocalModel{
			{
				ID: "custom.hf.bartowski--qwen:Q4_K_M", Name: "Qwen", Quant: "Q4_K_M",
				Fit: "unified", Pool: "unified", State: "downloading",
				Engine:   "mlx",
				Origin:   "custom",
				Custom:   &wire.LocalModelCustomInfo{Hub: "huggingface", RepoID: "bartowski/Qwen", Format: "gguf", VariantID: "Q4_K_M", ShardCount: 3, StandbyOnRestart: true},
				Download: &wire.LocalModelDownloadProgress{Step: "download", DoneBytes: 10, TotalBytes: 100, ShardIndex: &shardIdx, ShardCount: &shardCnt},
				Verification: &wire.LocalModelVerification{
					Status: "verified", ContextTokens: &ctxTokens,
				},
				Error: &wire.LocalModelError{Code: "HUB_AUTH_REQUIRED", Detail: "gated"},
			},
		},
	}

	streamOld := &browserEventStream{}
	dOld := &Daemon{computerID: "computer", protocolVersion: protocol.Version, localModelsStream: streamOld}
	dOld.localModelsDiagnostics.Store(true)
	dOld.localModelsEngine.Store(true)
	dOld.PublishLocalModels(snapshot)
	var oldFrame wire.RunnerLocalModels
	if err := json.Unmarshal(streamOld.events[0].Payload, &oldFrame); err != nil {
		t.Fatal(err)
	}
	if len(oldFrame.LocalModels.Host.SupportedFormats) != 0 {
		t.Fatalf("legacy service received supported_formats: %v", oldFrame.LocalModels.Host.SupportedFormats)
	}
	oldModel := oldFrame.LocalModels.Models[0]
	if oldModel.Origin != "" || oldModel.Custom != nil || oldModel.Verification != nil || oldModel.Engine != "" ||
		oldModel.Download.ShardIndex != nil || oldModel.Download.ShardCount != nil ||
		oldModel.Error.Code != "UNKNOWN_ERROR" {
		t.Fatalf("legacy service received custom fields: %+v", oldModel)
	}

	streamNew := &browserEventStream{}
	dNew := &Daemon{computerID: "computer", protocolVersion: protocol.Version, localModelsStream: streamNew}
	dNew.localModelsDiagnostics.Store(true)
	dNew.localModelsEngine.Store(true)
	dNew.localModelsCustom.Store(true)
	dNew.PublishLocalModels(snapshot)
	var newFrame wire.RunnerLocalModels
	if err := json.Unmarshal(streamNew.events[0].Payload, &newFrame); err != nil {
		t.Fatal(err)
	}
	if len(newFrame.LocalModels.Host.SupportedFormats) != 2 {
		t.Fatalf("new service lost supported_formats: %v", newFrame.LocalModels.Host.SupportedFormats)
	}
	newModel := newFrame.LocalModels.Models[0]
	if newModel.Origin != "custom" || newModel.Custom == nil || newModel.Verification == nil || newModel.Engine != "mlx" ||
		newModel.Download.ShardIndex == nil || *newModel.Download.ShardIndex != 1 || newModel.Error.Code != "HUB_AUTH_REQUIRED" {
		t.Fatalf("new service lost custom fields: %+v", newModel)
	}
}

type fakeCustomLocalModels struct {
	fakeLocalModels
	searchResult wire.LocalModelCustomSearchResult
	probeResult  wire.LocalModelCustomProbeResult
	customErr    error
	assignedID   string
}

func (f *fakeCustomLocalModels) ActWithResult(ctx context.Context, action localmodels.Action, deadline time.Time) (string, *wire.LocalModelActionRefusal, bool) {
	refusal, answered := f.Act(ctx, action, deadline)
	id := action.Model
	if id == "" {
		id = f.assignedID
	}
	return id, refusal, answered
}

func (f *fakeCustomLocalModels) SearchCustom(_ context.Context, _ wire.LocalModelCustomSearchInput) (wire.LocalModelCustomSearchResult, error) {
	return f.searchResult, f.customErr
}

func (f *fakeCustomLocalModels) ProbeCustom(_ context.Context, _ wire.LocalModelCustomProbeInput) (wire.LocalModelCustomProbeResult, error) {
	return f.probeResult, f.customErr
}

func TestHandleLocalModelsCustomCommandSearchAndProbe(t *testing.T) {
	httpStatus := uint64(401)
	lib := &fakeCustomLocalModels{
		probeResult: wire.LocalModelCustomProbeResult{
			Outcome:       "gated",
			HubHTTPStatus: &httpStatus,
			Repo: &wire.LocalModelCustomProbeRepo{
				Hub: "huggingface", RepoID: "meta-llama/Llama-3.1-8B-GGUF", URL: "https://huggingface.co/meta-llama/Llama-3.1-8B-GGUF",
			},
		},
	}
	stream := &browserEventStream{}
	d := &Daemon{
		computerID:      "computer",
		protocolVersion: protocol.Version,
		owners:          []ComputerOwner{{TenantID: "tenant", OwnerActorID: "owner"}},
		localModels:     lib,
	}
	payload, _ := json.Marshal(wire.CapabilityLocalModelsCustom{
		ProtocolVersion: protocol.Version, CommandID: "cmd-1", RunnerID: "computer",
		TenantID: "tenant", OwnerActorID: "owner", ConnectionEpoch: 1,
		ExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano),
		Type:      wire.TypeExecute, Kind: wire.KindLocalModelsCustom, Action: "probe",
		Probe: &wire.LocalModelCustomProbeInput{Target: "meta-llama/Llama-3.1-8B-GGUF", Hub: "huggingface"},
	})
	if err := d.handleLocalModelsCustomCommand(t.Context(), stream, protocol.Command{
		Type: protocol.CommandCapabilityLocalModelsCustom, ProtocolVersion: protocol.Version,
		CommandID: "cmd-1", RunnerID: "computer", ConnectionEpoch: 1, Payload: payload,
	}); err != nil {
		t.Fatal(err)
	}
	if len(stream.events) != 1 || stream.events[0].Type != protocol.EventCapabilityLocalModelsCustomSucceeded {
		t.Fatalf("unexpected events: %+v", stream.events)
	}
	var res wire.CapabilityLocalModelsCustomSucceeded
	if err := json.Unmarshal(stream.events[0].Payload, &res); err != nil {
		t.Fatal(err)
	}
	if res.ProbeResult == nil || res.ProbeResult.Outcome != "gated" || *res.ProbeResult.HubHTTPStatus != 401 {
		t.Fatalf("unexpected probe response: %+v", res.ProbeResult)
	}
}
