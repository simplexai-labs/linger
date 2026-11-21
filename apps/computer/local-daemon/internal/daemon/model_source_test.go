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

type fakeModelSourceManager struct {
	deadline  time.Time
	lastApply localmodels.ModelSourceApply
	calls     int
}

func (f *fakeModelSourceManager) Status(ctx context.Context) (wire.ModelSourceStatus, error) {
	f.deadline, _ = ctx.Deadline()
	return wire.ModelSourceStatus{
		Mode:         "subscription",
		Runtime:      "claude",
		RuntimeModel: "",
		Byok:         wire.ByokSummary{Configured: false, KeySaved: false},
	}, nil
}

func (f *fakeModelSourceManager) TestByok(ctx context.Context, input wire.ByokConfigInput) (wire.ByokTestResult, error) {
	f.calls++
	f.deadline, _ = ctx.Deadline()
	return wire.ByokTestResult{
		Ok:            true,
		Protocol:      "openai-chat",
		URL:           input.BaseURL + input.Path + input.Endpoint,
		ModelID:       input.ModelID,
		ContextWindow: 128000,
	}, nil
}

func (f *fakeModelSourceManager) ListByokModels(ctx context.Context, input wire.ByokConfigInput) (wire.ByokModelList, error) {
	f.calls++
	f.deadline, _ = ctx.Deadline()
	return wire.ByokModelList{URL: input.BaseURL + input.Path + "/models", Models: []wire.ByokModelListModelsItem{{ID: "vendor/model"}}}, nil
}

func (f *fakeModelSourceManager) Apply(ctx context.Context, apply localmodels.ModelSourceApply) (wire.ModelSourceStatus, error) {
	f.calls++
	f.deadline, _ = ctx.Deadline()
	f.lastApply = apply
	return wire.ModelSourceStatus{
		Mode:         apply.Mode,
		Runtime:      apply.Runtime,
		RuntimeModel: "localmodels-byok",
		GatewayURL:   "http://127.0.0.1:43120",
		Byok: wire.ByokSummary{
			Configured: true, KeySaved: true, Protocol: "openai-chat",
			BaseURL: "https://api.example.com", Path: "/api/paas/v4", Endpoint: "/chat/completions", ModelID: "gpt-5.4",
		},
	}, nil
}

func (f *fakeModelSourceManager) EnsureGateway(context.Context, string) error { return nil }

func TestHandleModelSourceCommandValidatesOwnerExpiryAndActions(t *testing.T) {
	manager := &fakeModelSourceManager{}
	d := &Daemon{
		computerID:      "comp-1",
		protocolVersion: protocol.Version,
		modelSource:     manager,
		owners:          []ComputerOwner{{TenantID: "tenant-1", OwnerActorID: "owner-1"}},
	}
	expires := time.Now().Add(time.Minute).UTC().Truncate(time.Millisecond)
	stream := &browserEventStream{}

	// 1. Status succeeds for the Computer's owner.
	statusCmd, _ := json.Marshal(wire.CapabilityModelSource{
		ProtocolVersion: protocol.Version,
		CommandID:       "cmd-status",
		RunnerID:        "comp-1",
		TenantID:        "tenant-1",
		OwnerActorID:    "owner-1",
		ConnectionEpoch: 1,
		ExpiresAt:       expires.Format(time.RFC3339Nano),
		Type:            wire.TypeExecute,
		Kind:            wire.KindModelSource,
		Action:          "status",
	})
	if err := d.handleModelSourceCommand(t.Context(), stream, protocol.Command{
		Type: protocol.CommandCapabilityModelSource, CommandID: "cmd-status", RunnerID: "comp-1", ConnectionEpoch: 1, Payload: statusCmd,
	}); err != nil {
		t.Fatal(err)
	}
	if len(stream.events) != 1 || stream.events[0].Type != protocol.EventCapabilityModelSourceSucceeded {
		t.Fatalf("expected succeeded event, got %+v", stream.events)
	}
	if !manager.deadline.Equal(expires) {
		t.Fatalf("expected command deadline %v, got %v", expires, manager.deadline)
	}

	// 2. Apply succeeds and returns updated ModelSourceStatus.
	applyCmd, _ := json.Marshal(wire.CapabilityModelSource{
		ProtocolVersion: protocol.Version,
		CommandID:       "cmd-apply",
		RunnerID:        "comp-1",
		TenantID:        "tenant-1",
		OwnerActorID:    "owner-1",
		ConnectionEpoch: 1,
		ExpiresAt:       expires.Format(time.RFC3339Nano),
		Type:            wire.TypeExecute,
		Kind:            wire.KindModelSource,
		Action:          "apply",
		Mode:            "byok",
		Runtime:         "claude",
		Byok: &wire.ByokConfigInput{
			BaseURL:  "https://api.example.com",
			Path:     "/api/paas/v4",
			Endpoint: "/chat/completions",
			Protocol: "openai-chat",
			APIKey:   "sk-secret",
			ModelID:  "gpt-5.4",
		},
	})
	if err := d.handleModelSourceCommand(t.Context(), stream, protocol.Command{
		Type: protocol.CommandCapabilityModelSource, CommandID: "cmd-apply", RunnerID: "comp-1", ConnectionEpoch: 1, Payload: applyCmd,
	}); err != nil {
		t.Fatal(err)
	}
	if len(stream.events) != 2 || stream.events[1].Type != protocol.EventCapabilityModelSourceSucceeded {
		t.Fatalf("expected apply succeeded event, got %+v", stream.events)
	}
	var succeeded wire.CapabilityModelSourceSucceeded
	if err := json.Unmarshal(stream.events[1].Payload, &succeeded); err != nil {
		t.Fatal(err)
	}
	if succeeded.Status == nil || succeeded.Status.Mode != "byok" || succeeded.Status.RuntimeModel != "localmodels-byok" {
		t.Fatalf("unexpected apply status payload: %+v", succeeded.Status)
	}
	// An Agent Service that did not declare byok_endpoint rejects the
	// summary's path and endpoint, so they are left out until it does.
	if succeeded.Status.Byok.Path != "" || succeeded.Status.Byok.Endpoint != "" ||
		succeeded.Status.Byok.BaseURL != "https://api.example.com" {
		t.Fatalf("summary for an Agent Service without byok_endpoint = %+v", succeeded.Status.Byok)
	}
	d.byokEndpoint.Store(true)
	if err := d.handleModelSourceCommand(t.Context(), stream, protocol.Command{
		Type: protocol.CommandCapabilityModelSource, CommandID: "cmd-apply", RunnerID: "comp-1", ConnectionEpoch: 1, Payload: applyCmd,
	}); err != nil {
		t.Fatal(err)
	}
	succeeded = wire.CapabilityModelSourceSucceeded{}
	if err := json.Unmarshal(stream.events[len(stream.events)-1].Payload, &succeeded); err != nil {
		t.Fatal(err)
	}
	if succeeded.Status == nil || succeeded.Status.Byok.Path != "/api/paas/v4" || succeeded.Status.Byok.Endpoint != "/chat/completions" {
		t.Fatalf("summary for an Agent Service with byok_endpoint = %+v", succeeded.Status)
	}
	stream.events = stream.events[:2]

	// 3. Another actor is rejected with MODEL_SOURCE_FORBIDDEN.
	intruderCmd, _ := json.Marshal(wire.CapabilityModelSource{
		ProtocolVersion: protocol.Version,
		CommandID:       "cmd-intruder",
		RunnerID:        "comp-1",
		TenantID:        "tenant-1",
		OwnerActorID:    "other-actor",
		ConnectionEpoch: 1,
		ExpiresAt:       expires.Format(time.RFC3339Nano),
		Type:            wire.TypeExecute,
		Kind:            wire.KindModelSource,
		Action:          "status",
	})
	if err := d.handleModelSourceCommand(t.Context(), stream, protocol.Command{
		Type: protocol.CommandCapabilityModelSource, CommandID: "cmd-intruder", RunnerID: "comp-1", ConnectionEpoch: 1, Payload: intruderCmd,
	}); err != nil {
		t.Fatal(err)
	}
	if len(stream.events) != 3 || stream.events[2].Type != protocol.EventCapabilityModelSourceFailed {
		t.Fatalf("expected failed event for intruder, got %+v", stream.events)
	}
}

func TestHandleModelSourceCommandRejectsMissingOrUnknownByokProtocol(t *testing.T) {
	manager := &fakeModelSourceManager{}
	d := &Daemon{
		computerID:      "comp-1",
		protocolVersion: protocol.Version,
		modelSource:     manager,
		owners:          []ComputerOwner{{TenantID: "tenant-1", OwnerActorID: "owner-1"}},
	}
	expires := time.Now().Add(time.Minute).UTC().Truncate(time.Millisecond)

	cases := []struct {
		name     string
		action   string
		mode     string
		protocol string
	}{
		{name: "test empty protocol", action: "test", protocol: ""},
		{name: "test unknown protocol", action: "test", protocol: "gemini"},
		{name: "models empty protocol", action: "models", protocol: ""},
		{name: "models unknown protocol", action: "models", protocol: "gemini"},
		{name: "apply empty protocol", action: "apply", mode: "byok", protocol: ""},
		{name: "apply unknown protocol", action: "apply", mode: "byok", protocol: "gemini"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stream := &browserEventStream{}
			payload, _ := json.Marshal(wire.CapabilityModelSource{
				ProtocolVersion: protocol.Version,
				CommandID:       "cmd-" + tc.action,
				RunnerID:        "comp-1",
				TenantID:        "tenant-1",
				OwnerActorID:    "owner-1",
				ConnectionEpoch: 1,
				ExpiresAt:       expires.Format(time.RFC3339Nano),
				Type:            wire.TypeExecute,
				Kind:            wire.KindModelSource,
				Action:          tc.action,
				Mode:            tc.mode,
				Byok: &wire.ByokConfigInput{
					BaseURL:  "https://api.example.com",
					ModelID:  "gpt-5.4",
					Protocol: tc.protocol,
				},
			})
			if err := d.handleModelSourceCommand(t.Context(), stream, protocol.Command{
				Type: protocol.CommandCapabilityModelSource, CommandID: "cmd-" + tc.action, RunnerID: "comp-1", ConnectionEpoch: 1, Payload: payload,
			}); err != nil {
				t.Fatal(err)
			}
			if len(stream.events) != 1 || stream.events[0].Type != protocol.EventCapabilityModelSourceFailed {
				t.Fatalf("expected failed event, got %+v", stream.events)
			}
			var failed wire.CapabilityModelSourceFailed
			if err := json.Unmarshal(stream.events[0].Payload, &failed); err != nil {
				t.Fatal(err)
			}
			if failed.Error.Code != "BYOK_INVALID_CONFIG" {
				t.Fatalf("expected BYOK_INVALID_CONFIG, got %q", failed.Error.Code)
			}
		})
	}
	if manager.calls != 0 {
		t.Fatalf("expected invalid protocol commands not to reach localmodels, got %d calls", manager.calls)
	}

	// Switching back to the saved BYOK config omits request.Byok and still succeeds.
	stream := &browserEventStream{}
	reuseCmd, _ := json.Marshal(wire.CapabilityModelSource{
		ProtocolVersion: protocol.Version,
		CommandID:       "cmd-apply-saved",
		RunnerID:        "comp-1",
		TenantID:        "tenant-1",
		OwnerActorID:    "owner-1",
		ConnectionEpoch: 1,
		ExpiresAt:       expires.Format(time.RFC3339Nano),
		Type:            wire.TypeExecute,
		Kind:            wire.KindModelSource,
		Action:          "apply",
		Mode:            "byok",
	})
	if err := d.handleModelSourceCommand(t.Context(), stream, protocol.Command{
		Type: protocol.CommandCapabilityModelSource, CommandID: "cmd-apply-saved", RunnerID: "comp-1", ConnectionEpoch: 1, Payload: reuseCmd,
	}); err != nil {
		t.Fatal(err)
	}
	if len(stream.events) != 1 || stream.events[0].Type != protocol.EventCapabilityModelSourceSucceeded || manager.calls != 1 {
		t.Fatalf("expected saved-BYOK apply to succeed once, events=%+v calls=%d", stream.events, manager.calls)
	}
}
