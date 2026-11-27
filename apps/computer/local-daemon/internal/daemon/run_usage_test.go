package daemon

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

func TestTerminalRunUsageBuckets(t *testing.T) {
	count := int64(2)
	result := provider.Result{Status: "completed", Output: "done", Usage: map[string]native.TokenCount{"model-b": {Input: 10, CacheRead: 20, Output: 30, Reasoning: 8}, "model-a": {Input: 3, Output: 4}}, LastUsage: map[string]native.TokenCount{"model-b": {Input: 1, CacheRead: 2, Output: 3}}, CompactionCount: &count}
	{
		var payload map[string]any
		spec := provider.OperationSpec{Provider: "codex", OperationKind: "run.start"}
		if err := json.Unmarshal(terminalPayloadFor(spec, result, false, false), &payload); err != nil {
			t.Fatal(err)
		}
		usage := payload["usage"].([]any)
		if len(usage) != 2 {
			t.Fatalf("usage count=%d", len(usage))
		}
		first, second := usage[0].(map[string]any), usage[1].(map[string]any)
		if first["model"] != "model-a" || first["compaction_count"] != float64(2) || second["compaction_count"] != float64(0) {
			t.Fatalf("compactions duplicated: %v", usage)
		}
		if second["output"] != float64(30) || second["reasoning"] != float64(8) || second["cache_read"] != float64(20) {
			t.Fatalf("buckets=%v", second)
		}
		if second["last"].(map[string]any)["input"] != float64(1) {
			t.Fatal("missing last request")
		}
		result.Status = "failed"
		if err := json.Unmarshal(terminalPayloadFor(spec, result, false, false), &payload); err != nil || payload["usage"] == nil {
			t.Fatalf("failed usage lost: %s", terminalPayloadFor(spec, result, false, false))
		}
	}
}

func TestReportedRunUsageSkipsUnusableEntries(t *testing.T) {
	count := int64(2)
	spec := provider.OperationSpec{Provider: "claude", OperationKind: "run.start"}
	result := provider.Result{Status: "completed", Usage: map[string]native.TokenCount{
		"<synthetic>": {},
		"model-zero":  {},
		"model-a":     {Input: 3, Output: 4},
		"model-b":     {Output: 2, Reasoning: 3},
	}, LastUsage: map[string]native.TokenCount{"model-b": {Output: 1, Reasoning: 1}}, CompactionCount: &count}
	usage := reportedRunUsage(spec, result, false)
	if len(usage) != 2 {
		t.Fatalf("usage=%v", usage)
	}
	first, second := usage[0], usage[1]
	if first["model"] != "model-a" || first["compaction_count"] != int64(2) || second["compaction_count"] != int64(0) {
		t.Fatalf("compactions not on first kept model: %v", usage)
	}
	if _, ok := second["reasoning"]; ok {
		t.Fatalf("reasoning above output reported: %v", second)
	}
	if _, ok := second["last"].(map[string]any)["reasoning"]; ok {
		t.Fatalf("last reasoning above output reported: %v", second["last"])
	}
	if reportedRunUsage(spec, provider.Result{Usage: map[string]native.TokenCount{"<synthetic>": {}}}, false) != nil {
		t.Fatal("unusable-only usage reported")
	}
}

func TestNativeResumeMeasurementOnTerminalOutcomes(t *testing.T) {
	{
		for _, outcome := range []string{"completed", "failed", "aborted"} {
			spec := provider.OperationSpec{Provider: "codex", OperationKind: "run.start"}
			result := provider.Result{Status: outcome, NativeResume: &native.NativeResumeMeasurement{DurationMs: 123, Result: "error"}}
			var payload map[string]any
			if err := json.Unmarshal(terminalWithUsage(map[string]any{"reason": "cancel"}, spec, result, false), &payload); err != nil {
				t.Fatal(err)
			}
			if payload["native_resume"] == nil {
				t.Fatalf("measurement lost: %v", payload)
			}
			if err := json.Unmarshal(terminalPayloadFor(spec, result, false, false), &payload); err != nil {
				t.Fatal(err)
			}
			if payload["native_resume"] == nil {
				t.Fatalf("terminal lost: %v", payload)
			}
		}
	}
}

func TestAntigravityRunUsageProviderFeatureGateAndReasoning(t *testing.T) {
	compactions := int64(3)
	spec := provider.OperationSpec{Provider: "antigravity", OperationKind: "run.start"}
	result := provider.Result{
		Status: "completed",
		Output: "ok",
		Usage: map[string]native.TokenCount{
			"gemini-pro": {Input: 100, CacheRead: 40, Output: 25, Reasoning: 10},
		},
		LastUsage: map[string]native.TokenCount{
			"gemini-pro": {Input: 20, CacheRead: 5, Output: 12, Reasoning: 4},
		},
		CompactionCount: &compactions,
	}

	withFeature := reportedRunUsage(spec, result, true)
	if len(withFeature) != 1 {
		t.Fatalf("withFeature=%v", withFeature)
	}
	entry := withFeature[0]
	if entry["provider"] != "antigravity" || entry["model"] != "gemini-pro" || entry["reasoning"] != int64(10) || entry["compaction_count"] != int64(3) {
		t.Fatalf("entry=%+v", entry)
	}
	last, ok := entry["last"].(map[string]any)
	if !ok || last["reasoning"] != int64(4) || last["output"] != int64(12) {
		t.Fatalf("last=%+v", entry["last"])
	}

	withoutFeature := reportedRunUsage(spec, result, false)
	if len(withoutFeature) != 1 || withoutFeature[0]["provider"] != "unknown" || withoutFeature[0]["reasoning"] != int64(10) || withoutFeature[0]["compaction_count"] != int64(3) {
		t.Fatalf("withoutFeature=%+v", withoutFeature)
	}
}

func TestAntigravityUsageProviderDowngradesOnReplayWithoutFeature(t *testing.T) {
	compactions := int64(1)
	spec := provider.OperationSpec{Provider: "antigravity", OperationKind: "run.start"}
	completedResult := provider.Result{
		Status: "completed",
		Output: "done",
		Usage: map[string]native.TokenCount{
			"gemini-pro": {Input: 50, Output: 15, Reasoning: 5},
		},
		CompactionCount: &compactions,
	}
	failedResult := provider.Result{
		Status: "failed",
		Error:  "upstream failed",
		Usage: map[string]native.TokenCount{
			"gemini-pro": {Input: 10, Output: 4, Reasoning: 2},
		},
		CompactionCount: &compactions,
	}
	cancelledResult := provider.Result{
		Status: "aborted",
		Usage: map[string]native.TokenCount{
			"gemini-pro": {Input: 8, Output: 3, Reasoning: 1},
		},
		CompactionCount: &compactions,
	}

	for _, tc := range []struct {
		name      string
		eventType string
		payload   json.RawMessage
	}{
		{"completed", protocol.EventOperationCompleted, terminalPayloadFor(spec, completedResult, false, true)},
		{"failed", protocol.EventOperationFailed, terminalPayloadFor(spec, failedResult, false, true)},
		{"cancelled", protocol.EventOperationCancelled, terminalWithUsage(map[string]any{"reason": "cancelled"}, spec, cancelledResult, true)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stream := &fakeStream{}
			d, err := newTestDaemon(t, Options{
				ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream}, IdentityStore: fakeStore{},
				OperationResolver: fakeOperationResolver{},
			})
			if err != nil {
				t.Fatal(err)
			}
			opID := "op-" + tc.name
			identity := OperationIdentity{
				ProtocolVersion: protocol.Version, HostAccess: "trusted", TenantID: "tenant-1",
				RunnerID: "computer-1", RegistrationID: "reg-1", AssignmentRevision: 1,
				AgentID: "agent-1", OperationID: opID, ConnectionEpoch: 1, RunnerRevision: 1,
				Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1",
				RuntimeType: "antigravity", OperationKind: "run.start",
				ExecutionContextKey: "room:1", RuntimeInstanceID: "inst-1",
			}
			if _, err := d.ledger.Begin(context.Background(), identity); err != nil {
				t.Fatal(err)
			}
			if _, err := d.ledger.Complete(context.Background(), identity, protocol.Event{
				Type: tc.eventType, OperationID: opID, RuntimeType: "antigravity",
				SentAt: time.Now().UTC(), Payload: tc.payload,
			}); err != nil {
				t.Fatal(err)
			}

			// Reconnect to an older Agent Service without antigravity_usage_provider.
			d.antigravityUsageProvider.Store(false)
			if err := d.replayRetainedEvents(context.Background(), stream, []string{opID}); err != nil {
				t.Fatal(err)
			}
			replayed := stream.snapshotEvents()
			if len(replayed) != 1 {
				t.Fatalf("replayed count=%d, want 1", len(replayed))
			}
			var decoded map[string]any
			if err := json.Unmarshal(replayed[0].Payload, &decoded); err != nil {
				t.Fatal(err)
			}
			usage := decoded["usage"].([]any)
			if got := usage[0].(map[string]any)["provider"]; got != "unknown" {
				t.Fatalf("downgraded replay provider=%v, want unknown", got)
			}

			// Subsequent reconnect to a newer Agent Service with the feature keeps "antigravity".
			newerStream := &fakeStream{}
			d.antigravityUsageProvider.Store(true)
			if err := d.replayRetainedEvents(context.Background(), newerStream, []string{opID}); err != nil {
				t.Fatal(err)
			}
			replayedNewer := newerStream.snapshotEvents()
			if len(replayedNewer) != 1 {
				t.Fatalf("newer replayed count=%d, want 1", len(replayedNewer))
			}
			var decodedNewer map[string]any
			if err := json.Unmarshal(replayedNewer[0].Payload, &decodedNewer); err != nil {
				t.Fatal(err)
			}
			usageNewer := decodedNewer["usage"].([]any)
			if got := usageNewer[0].(map[string]any)["provider"]; got != "antigravity" {
				t.Fatalf("newer replay provider=%v, want antigravity (ledger must not be mutated)", got)
			}
		})
	}
}
