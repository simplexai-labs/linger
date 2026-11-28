package agentruntimestate

import (
	"encoding/json"
	"testing"

	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func TestOutputsAndTheStoppedEventCloseTheirSegment(t *testing.T) {
	for _, test := range []struct {
		eventType string
		payload   string
		closes    bool
	}{
		{"presentation.output_created", `{"type":"presentation.output_created"}`, true},
		{"status.changed", `{"type":"status.changed","status":"stopped","outcome":"completed"}`, true},
		{"status.changed", `{"type":"status.changed","status":"working"}`, false},
		{"status.changed", `{"type":"status.changed","status":"queued"}`, false},
		{"status.changed", `{"type":"status.changed","status":"waiting_background"}`, false},
		{"activity.finished", `{"type":"activity.finished","activity_id":"a","outcome":"succeeded"}`, false},
		{"plan.updated", `{"type":"plan.updated","steps":[]}`, false},
	} {
		if got := closesSegment(test.eventType, json.RawMessage(test.payload)); got != test.closes {
			t.Fatalf("%s %s closes=%t want %t", test.eventType, test.payload, got, test.closes)
		}
	}
}

func TestPublicRunStatusShowsUnfinishedRunsAsActive(t *testing.T) {
	for status, want := range map[string]httpapi.RoomRunStatusState{
		"queued": httpapi.RoomRunStatusStateActive, "running": httpapi.RoomRunStatusStateActive,
		"succeeded": httpapi.RoomRunStatusStateCompleted,
		"failed":    httpapi.RoomRunStatusStateAborted, "canceled": httpapi.RoomRunStatusStateAborted,
	} {
		if got := PublicRunStatus(status); got != want {
			t.Fatalf("%s -> %s, want %s", status, got, want)
		}
	}
}

func TestSegmentIDsAreStablePerRunAndOrdinal(t *testing.T) {
	first, again, second := deriveSegmentID("run-1", 1), deriveSegmentID("run-1", 1), deriveSegmentID("run-1", 2)
	if first != again || first == second || first == deriveSegmentID("run-2", 1) {
		t.Fatalf("segment IDs %s %s %s", first, again, second)
	}
}

func TestNormalizeOfferedPresentationEventLoadingLocalModelStage(t *testing.T) {
	normalized, err := normalizeOfferedPresentationEvent(json.RawMessage(`{"type":"status.changed","status":"queued","stage":"loading_local_model"}`))
	if err != nil {
		t.Fatalf("valid loading_local_model status rejected: %v", err)
	}
	if normalized.EventType != "status.changed" {
		t.Fatalf("event type = %q", normalized.EventType)
	}
	var payload map[string]any
	if err := json.Unmarshal(normalized.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["status"] != "queued" || payload["stage"] != "loading_local_model" {
		t.Fatalf("normalized payload = %v", payload)
	}

	for _, invalid := range []string{
		`{"type":"status.changed","status":"working","stage":"loading_local_model"}`,
		`{"type":"status.changed","status":"queued","stage":"unknown_stage"}`,
	} {
		if _, err := normalizeOfferedPresentationEvent(json.RawMessage(invalid)); err == nil {
			t.Errorf("invalid event accepted: %s", invalid)
		}
	}
}
