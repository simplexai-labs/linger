package daemon

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/assignment"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/registration"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

func TestDebugInspectAntigravityGatedByServiceFeature(t *testing.T) {
	antigravityHome := filepath.Join(t.TempDir(), ".gemini", "antigravity-cli")
	logsDir := filepath.Join(antigravityHome, "brain", "conv-agy-1", ".system_generated", "logs")
	if err := os.MkdirAll(logsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	transcript := `{"type":"USER_INPUT","step_index":0,"created_at":"2026-11-20T10:00:00Z","content":"hello"}` + "\n" +
		`{"type":"PLANNER_RESPONSE","step_index":1,"created_at":"2026-11-20T10:00:02Z","thinking":"secret thoughts","content":"hi there"}` + "\n"
	if err := os.WriteFile(filepath.Join(logsDir, "transcript.jsonl"), []byte(transcript), 0o600); err != nil {
		t.Fatal(err)
	}

	stream := &fakeStream{}
	d, err := newTestDaemon(t, Options{
		ComputerID:        "computer-1",
		ControlPlane:      fakeControlPlane{stream: stream},
		IdentityStore:     fakeStore{},
		AntigravityHome:   antigravityHome,
		OperationResolver: prepareOperationResolver{workingDirectory: t.TempDir()},
	})
	if err != nil {
		t.Fatal(err)
	}
	d.daemonID = "daemon-1"
	if _, err := d.registrations.Apply(context.Background(), registration.Observation{
		RegistrationID: "reg-agy-1",
		Key: registration.Key{
			DaemonID: d.daemonID, TenantID: "tenant-1", OwnerActorID: "owner-1", ProviderType: "antigravity",
		},
		Status:   registration.StatusOnline,
		Revision: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.assignments.Apply(context.Background(), assignment.Command{
		Type: protocol.CommandAgentRunnerEnsure, CommandID: "assign-agy", RunnerID: "computer-1",
		TenantID: "tenant-1", AgentID: "agent-1", RegistrationID: "reg-agy-1",
		AssignmentRevision: 1, RunnerRevision: 1, WorkspaceGrantID: "grant-1",
		Runtime: json.RawMessage(`{"type":"antigravity"}`),
	}, 0); err != nil {
		t.Fatal(err)
	}

	command := protocol.Command{
		Type: protocol.CommandDebugInspect, CommandID: "cmd-agy-history", ProtocolVersion: "1.2",
		TenantID: "tenant-1", RunnerID: "computer-1", AgentID: "agent-1",
		RegistrationID: "reg-agy-1", AssignmentRevision: 1, ConnectionEpoch: 1, RunnerRevision: 1,
		WorkspaceGrantID: "grant-1", ExecutionContextKey: "ctx-agy-1",
		Payload: json.RawMessage(`{"detached_history":true,"request":{"kind":"history","runtime":{"type":"antigravity"},"session":{"thread_id":"conv-agy-1"},"limit":10}}`),
	}

	// Older Agent Service without antigravity_history receives unavailable + legacy codex_rollout source.
	legacyStream := &fakeStream{}
	if err := d.handleDebugInspect(context.Background(), legacyStream, command); err != nil {
		t.Fatal(err)
	}
	var legacyResult struct {
		Status       string `json:"status"`
		ProviderKind string `json:"provider_kind"`
		Instructions struct {
			Source string `json:"source"`
		} `json:"instructions"`
	}
	if err := json.Unmarshal(legacyStream.snapshotEvents()[0].Payload, &legacyResult); err != nil {
		t.Fatal(err)
	}
	if legacyResult.Status != "unavailable" || legacyResult.ProviderKind != "antigravity" || legacyResult.Instructions.Source != "codex_rollout" {
		t.Fatalf("legacy inspection = %+v", legacyResult)
	}

	// Accepting runner.welcome with antigravity_history enables native Antigravity inspection.
	welcome := protocol.Command{
		Type: protocol.CommandRunnerWelcome, CommandID: "cmd-welcome", ProtocolVersion: "1.2",
		RunnerID: "computer-1", ConnectionEpoch: 1,
		ServiceFeatures: []string{serviceFeatureAntigravityHistory},
	}
	if err := d.acceptRunnerWelcome(t.Context(), t.Context(), stream, welcome, 0); err != nil {
		t.Fatal(err)
	}

	enabledStream := &fakeStream{}
	if err := d.handleDebugInspect(context.Background(), enabledStream, command); err != nil {
		t.Fatal(err)
	}
	var enabledResult struct {
		Status       string `json:"status"`
		Source       string `json:"source"`
		Instructions struct {
			Source string `json:"source"`
		} `json:"instructions"`
		Records []struct {
			Ordinal        int            `json:"ordinal"`
			Role           string         `json:"role"`
			NativeRecord   map[string]any `json:"native_record"`
			RedactedFields []struct {
				Path   string `json:"path"`
				Reason string `json:"reason"`
			} `json:"redacted_fields"`
		} `json:"records"`
	}
	if err := json.Unmarshal(enabledStream.snapshotEvents()[0].Payload, &enabledResult); err != nil {
		t.Fatal(err)
	}
	if enabledResult.Status != "available" || enabledResult.Source != "antigravity_transcript" || enabledResult.Instructions.Source != "antigravity_transcript" {
		t.Fatalf("enabled inspection = %s", enabledStream.snapshotEvents()[0].Payload)
	}
	if len(enabledResult.Records) != 2 {
		t.Fatalf("records = %+v, want 2", enabledResult.Records)
	}
	if _, present := enabledResult.Records[1].NativeRecord["thinking"]; present {
		t.Fatalf("thinking leaked into native_record: %+v", enabledResult.Records[1].NativeRecord)
	}
	if enabledResult.Records[1].NativeRecord["content"] != "hi there" {
		t.Fatalf("unexpected content: %+v", enabledResult.Records[1].NativeRecord)
	}
	if len(enabledResult.Records[1].RedactedFields) != 1 ||
		enabledResult.Records[1].RedactedFields[0].Path != "/thinking" ||
		enabledResult.Records[1].RedactedFields[0].Reason != "reasoning_content" {
		t.Fatalf("redacted_fields = %+v, want /thinking reasoning_content", enabledResult.Records[1].RedactedFields)
	}

	// Disconnecting clears the service feature so a subsequent older service is protected.
	d.clearDiagnosticsStream(stream)
	afterReset := &fakeStream{}
	if err := d.handleDebugInspect(context.Background(), afterReset, command); err != nil {
		t.Fatal(err)
	}
	var resetResult struct {
		Status       string `json:"status"`
		Instructions struct {
			Source string `json:"source"`
		} `json:"instructions"`
	}
	if err := json.Unmarshal(afterReset.snapshotEvents()[0].Payload, &resetResult); err != nil {
		t.Fatal(err)
	}
	if resetResult.Status != "unavailable" || resetResult.Instructions.Source != "codex_rollout" {
		t.Fatalf("post-disconnect inspection = %+v", resetResult)
	}
}
