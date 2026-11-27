package daemon

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/localmodels"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

type fakeLocalSpeechLibrary struct {
	actRefusal     *wire.LocalSpeechActionRefusal
	actAnswered    bool
	lastAction     localmodels.SpeechAction
	transcribeRes  localmodels.SpeechTranscribeResult
	transcribeErr  error
	lastTranscribe localmodels.SpeechTranscribeRequest
	refreshCount   int
}

func (f *fakeLocalSpeechLibrary) Act(_ context.Context, action localmodels.SpeechAction, _ time.Time) (*wire.LocalSpeechActionRefusal, bool) {
	f.lastAction = action
	return f.actRefusal, f.actAnswered
}

func (f *fakeLocalSpeechLibrary) Refresh(_ context.Context) wire.LocalSpeechSnapshot {
	f.refreshCount++
	return wire.LocalSpeechSnapshot{Available: true, ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), Models: []wire.LocalSpeechModel{}}
}

func (f *fakeLocalSpeechLibrary) Transcribe(_ context.Context, req localmodels.SpeechTranscribeRequest) (localmodels.SpeechTranscribeResult, error) {
	f.lastTranscribe = req
	return f.transcribeRes, f.transcribeErr
}

type captureEventStream struct {
	events []protocol.Event
}

func (s *captureEventStream) Send(_ context.Context, event protocol.Event) error {
	s.events = append(s.events, event)
	return nil
}

func (s *captureEventStream) Receive(_ context.Context) (protocol.Command, error) {
	return protocol.Command{}, context.Canceled
}

func (s *captureEventStream) Close() error { return nil }

func TestLocalSpeechFeatureGateAndHandlers(t *testing.T) {
	stream := &captureEventStream{}
	fake := &fakeLocalSpeechLibrary{
		actAnswered: true,
		transcribeRes: localmodels.SpeechTranscribeResult{
			Text:            "testing local speech",
			Language:        "en",
			Model:           "sensevoice-small",
			RequestedDevice: "cpu",
			EffectiveDevice: "cpu",
		},
	}
	d := &Daemon{
		protocolVersion: protocol.Version,
		computerID:      "comp_1",
		owners:          []ComputerOwner{{TenantID: "ten_1", OwnerActorID: "act_1"}},
		localSpeech:     fake,
	}

	// Without local_voice_asr announced in runner.welcome, PublishLocalSpeech sends nothing.
	d.PublishLocalSpeech(wire.LocalSpeechSnapshot{Available: true, ObservedAt: "2026-11-26T00:00:00Z", Models: []wire.LocalSpeechModel{}})
	if len(stream.events) != 0 {
		t.Fatalf("expected 0 events before feature gate, got %d", len(stream.events))
	}

	// Activate local_voice_asr stream.
	d.localSpeechStream = stream
	d.PublishLocalSpeech(wire.LocalSpeechSnapshot{Available: true, ObservedAt: "2026-11-26T00:00:00Z", Models: []wire.LocalSpeechModel{}})
	if len(stream.events) != 1 || stream.events[0].Type != protocol.EventLocalSpeech {
		t.Fatalf("expected runner.local_speech event, got %+v", stream.events)
	}

	// Action command accepted.
	actionPayload, _ := json.Marshal(wire.CapabilityLocalSpeechActionExecute{
		Type:            wire.TypeExecute,
		Kind:            wire.KindLocalSpeechAction,
		ProtocolVersion: protocol.Version,
		CommandID:       "cmd_1",
		RunnerID:        "comp_1",
		TenantID:        "ten_1",
		OwnerActorID:    "act_1",
		ConnectionEpoch: 1,
		ExpiresAt:       time.Now().UTC().Add(30 * time.Second).Format(time.RFC3339Nano),
		Action:          localmodels.SpeechActionDownload,
		ModelID:         "sensevoice-small",
	})
	if err := d.handleLocalSpeechActionCommand(context.Background(), stream, protocol.Command{
		Type: protocol.CommandCapabilityLocalSpeechAction, ProtocolVersion: protocol.Version,
		CommandID: "cmd_1", RunnerID: "comp_1", ConnectionEpoch: 1, Payload: actionPayload,
	}); err != nil {
		t.Fatalf("handleLocalSpeechActionCommand failed: %v", err)
	}
	if len(stream.events) != 2 || stream.events[1].Type != protocol.EventCapabilityLocalSpeechActionAccepted {
		t.Fatalf("expected accepted event, got %+v", stream.events[len(stream.events)-1])
	}

	// Transcribe command rejected for wrong owner.
	badOwnerPayload, _ := json.Marshal(wire.CapabilityLocalAsrTranscribeExecute{
		Type:            wire.TypeExecute,
		Kind:            wire.KindLocalAsrTranscribe,
		ProtocolVersion: protocol.Version,
		CommandID:       "cmd_2",
		RunnerID:        "comp_1",
		TenantID:        "ten_1",
		OwnerActorID:    "act_other",
		ConnectionEpoch: 1,
		ExpiresAt:       time.Now().UTC().Add(30 * time.Second).Format(time.RFC3339Nano),
		AudioWavBase64:  "UklGRg==",
	})
	if err := d.handleLocalAsrTranscribeCommand(context.Background(), stream, protocol.Command{
		Type: protocol.CommandCapabilityLocalAsrTranscribe, ProtocolVersion: protocol.Version,
		CommandID: "cmd_2", RunnerID: "comp_1", ConnectionEpoch: 1, Payload: badOwnerPayload,
	}); err != nil {
		t.Fatalf("handleLocalAsrTranscribeCommand failed: %v", err)
	}
	if len(stream.events) != 3 || stream.events[2].Type != protocol.EventCapabilityLocalAsrTranscribeFailed {
		t.Fatalf("expected failed event for wrong owner, got %+v", stream.events[len(stream.events)-1])
	}

	// Transcribe command succeeded for owner.
	okPayload, _ := json.Marshal(wire.CapabilityLocalAsrTranscribeExecute{
		Type:            wire.TypeExecute,
		Kind:            wire.KindLocalAsrTranscribe,
		ProtocolVersion: protocol.Version,
		CommandID:       "cmd_3",
		RunnerID:        "comp_1",
		TenantID:        "ten_1",
		OwnerActorID:    "act_1",
		ConnectionEpoch: 1,
		ExpiresAt:       time.Now().UTC().Add(30 * time.Second).Format(time.RFC3339Nano),
		ModelID:         "sensevoice-small",
		Language:        "en",
		AudioWavBase64:  "UklGRg==",
	})
	if err := d.handleLocalAsrTranscribeCommand(context.Background(), stream, protocol.Command{
		Type: protocol.CommandCapabilityLocalAsrTranscribe, ProtocolVersion: protocol.Version,
		CommandID: "cmd_3", RunnerID: "comp_1", ConnectionEpoch: 1, Payload: okPayload,
	}); err != nil {
		t.Fatalf("handleLocalAsrTranscribeCommand failed: %v", err)
	}
	if len(stream.events) != 4 || stream.events[3].Type != protocol.EventCapabilityLocalAsrTranscribeSucceeded {
		t.Fatalf("expected succeeded event, got %+v", stream.events[len(stream.events)-1])
	}
}
