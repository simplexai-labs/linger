package daemon

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/localmodels"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

type telemetryRecordingStream struct {
	mu     sync.Mutex
	events []protocol.Event
}

func (s *telemetryRecordingStream) Receive(context.Context) (protocol.Command, error) {
	return protocol.Command{}, context.Canceled
}

func (s *telemetryRecordingStream) Send(_ context.Context, event protocol.Event) error {
	s.mu.Lock()
	s.events = append(s.events, event)
	s.mu.Unlock()
	return nil
}

func (s *telemetryRecordingStream) Close() error { return nil }

type fakeTelemetryProvider struct {
	mu           sync.Mutex
	subscribes   int
	lastTTL      time.Duration
	lastInterval time.Duration
	unsubscribes int
}

func (f *fakeTelemetryProvider) Subscribe(leaseTTL time.Duration, interval time.Duration) {
	f.mu.Lock()
	f.subscribes++
	f.lastTTL = leaseTTL
	f.lastInterval = interval
	f.mu.Unlock()
}

func (f *fakeTelemetryProvider) Unsubscribe() {
	f.mu.Lock()
	f.unsubscribes++
	f.mu.Unlock()
}

func TestSystemTelemetryMonotonicRevisionsAndServiceFeatureGate(t *testing.T) {
	stream := &telemetryRecordingStream{}
	provider := &fakeTelemetryProvider{}
	d := &Daemon{
		computerID:      "computer-1",
		protocolVersion: protocol.Version,
		systemTelemetry: provider,
	}

	// Without service_features declaring system_telemetry, publishing is a no-op.
	d.PublishSystemTelemetry(localmodels.TelemetryUpdate{
		Status: localmodels.TelemetryStatusOK,
		Snapshot: &wire.SystemTelemetrySnapshot{
			Schema: "localmodels.stack-view/v1", GeneratedAt: "2026-11-26T10:00:00Z", Source: "live",
		},
	})
	if len(stream.events) != 0 {
		t.Fatalf("expected no frames when stream has no system_telemetry feature, got %d", len(stream.events))
	}

	// Enable system_telemetry stream on connection epoch 4.
	d.connectionMu.Lock()
	d.systemTelemetryStream = stream
	d.systemTelemetryEpoch = 4
	d.connectionMu.Unlock()

	interval := uint64(1000)
	subPayload, err := json.Marshal(wire.CapabilitySystemTelemetrySubscribe{
		Type: wire.TypeCapabilitySystemTelemetrySubscribe, ProtocolVersion: protocol.Version,
		CommandID: "cmd-1", RunnerID: "computer-1", ConnectionEpoch: 4, LeaseTtlMs: 30000, IntervalMs: &interval,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := d.handleSystemTelemetrySubscribe(stream, protocol.Command{
		Type: protocol.CommandCapabilitySystemTelemetrySubscribe, ConnectionEpoch: 4, Payload: subPayload,
	}); err != nil {
		t.Fatalf("subscribe failed: %v", err)
	}
	if provider.subscribes != 1 || provider.lastTTL != 30*time.Second || provider.lastInterval != time.Second {
		t.Fatalf("unexpected subscribe state: %+v", provider)
	}

	for i := 0; i < 3; i++ {
		d.PublishSystemTelemetry(localmodels.TelemetryUpdate{
			Status: localmodels.TelemetryStatusOK,
			Snapshot: &wire.SystemTelemetrySnapshot{
				Schema: "localmodels.stack-view/v1", GeneratedAt: "2026-11-26T10:00:00Z", Source: "live",
			},
		})
	}
	if len(stream.events) != 3 {
		t.Fatalf("expected 3 telemetry events, got %d", len(stream.events))
	}
	for idx, ev := range stream.events {
		var frame wire.RunnerSystemTelemetry
		if err := json.Unmarshal(ev.Payload, &frame); err != nil {
			t.Fatalf("decode frame %d: %v", idx, err)
		}
		wantRev := uint64(idx + 1)
		if frame.Revision != wantRev || frame.ConnectionEpoch != 4 || frame.Status != "ok" {
			t.Fatalf("frame %d = %+v, want revision %d epoch 4", idx, frame, wantRev)
		}
	}

	// Disconnect immediately unsubscribes the telemetry provider.
	d.clearDiagnosticsStream(stream)
	if provider.unsubscribes != 1 {
		t.Fatalf("expected disconnect to unsubscribe provider once, got %d", provider.unsubscribes)
	}
}

func TestSystemTelemetryUnsubscribeAndNilProviderDegradesCleanly(t *testing.T) {
	stream := &telemetryRecordingStream{}
	d := &Daemon{
		computerID:            "computer-1",
		protocolVersion:       protocol.Version,
		systemTelemetryStream: stream,
		systemTelemetryEpoch:  2,
	}

	subPayload, _ := json.Marshal(wire.CapabilitySystemTelemetrySubscribe{
		Type: wire.TypeCapabilitySystemTelemetrySubscribe, ProtocolVersion: protocol.Version,
		CommandID: "cmd-sub", RunnerID: "computer-1", ConnectionEpoch: 2, LeaseTtlMs: 15000,
	})
	if err := d.handleSystemTelemetrySubscribe(stream, protocol.Command{
		Type: protocol.CommandCapabilitySystemTelemetrySubscribe, ConnectionEpoch: 2, Payload: subPayload,
	}); err != nil {
		t.Fatalf("subscribe with nil provider failed: %v", err)
	}
	if len(stream.events) != 1 {
		t.Fatalf("expected 1 unsupported frame, got %d", len(stream.events))
	}
	var frame wire.RunnerSystemTelemetry
	if err := json.Unmarshal(stream.events[0].Payload, &frame); err != nil {
		t.Fatal(err)
	}
	if frame.Status != localmodels.TelemetryStatusUnsupported || frame.Reason == nil || frame.Reason.Code != localmodels.CodeTelemetryToolNotInstalled {
		t.Fatalf("unexpected unsupported frame: %+v", frame)
	}

	provider := &fakeTelemetryProvider{}
	d.systemTelemetry = provider
	unsubPayload, _ := json.Marshal(wire.CapabilitySystemTelemetryUnsubscribe{
		Type: wire.TypeCapabilitySystemTelemetryUnsubscribe, ProtocolVersion: protocol.Version,
		CommandID: "cmd-unsub", RunnerID: "computer-1", ConnectionEpoch: 2,
	})
	if err := d.handleSystemTelemetryUnsubscribe(stream, protocol.Command{
		Type: protocol.CommandCapabilitySystemTelemetryUnsubscribe, ConnectionEpoch: 2, Payload: unsubPayload,
	}); err != nil {
		t.Fatalf("unsubscribe failed: %v", err)
	}
	if provider.unsubscribes != 1 {
		t.Fatalf("expected 1 unsubscribe call, got %d", provider.unsubscribes)
	}

	// Ensure context cancellation during Send never panics.
	_ = context.Background()
}
