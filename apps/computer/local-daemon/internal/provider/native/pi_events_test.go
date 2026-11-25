package native

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func newTestPiTurn(t *testing.T) *piTurn {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	return newPiTurn(ctx, cancel, &piProcess{sessionID: "pi-test-session"}, false, releaseFence{}, nil)
}

func piDrainEmitted(turn *piTurn) []Event {
	var out []Event
	for {
		select {
		case event := <-turn.events:
			out = append(out, event)
		default:
			return out
		}
	}
}

func piAssistantUpdateFrame(t *testing.T, update map[string]any) piEventFrame {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"type":                  "message_update",
		"assistantMessageEvent": update,
	})
	if err != nil {
		t.Fatal(err)
	}
	var frame piEventFrame
	if err := json.Unmarshal(raw, &frame); err != nil {
		t.Fatal(err)
	}
	return frame
}

func piMessageEndFrame(t *testing.T, role string) piEventFrame {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"type": "message_end",
		"message": map[string]any{
			"role":       role,
			"model":      "fixture/model",
			"stopReason": "stop",
			"content":    []any{},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var frame piEventFrame
	if err := json.Unmarshal(raw, &frame); err != nil {
		t.Fatal(err)
	}
	return frame
}

func TestPiEventsThinkingOrdersAndBoundaries(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)

	t.Run("anthropic_order", func(t *testing.T) {
		turn := newTestPiTurn(t)
		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "thinking_start"}), now)
		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "thinking_delta", "delta": "Checking"}), now)
		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "thinking_delta", "delta": " files"}), now)
		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "thinking_end", "content": "Checking files"}), now)
		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "toolcall_start", "id": "call-1", "toolName": "bash"}), now)

		events := piDrainEmitted(turn)
		if len(events) != 4 {
			t.Fatalf("events = %+v, want 4", events)
		}
		if events[0].Kind != EventReasoning || events[0].Body != "Checking" || events[0].Complete ||
			events[1].Kind != EventReasoning || events[1].Body != " files" || events[1].Complete ||
			events[2].Kind != EventReasoning || events[2].Body != "" || !events[2].Complete ||
			events[3].Kind != EventToolCallStart || events[3].ToolName != "bash" || events[3].ActivityKind != ActivityCommand || events[3].InvocationID != piInvocationID("call-1") {
			t.Fatalf("unexpected anthropic sequence: %+v", events)
		}
	})

	t.Run("openai_completions_late_thinking_end", func(t *testing.T) {
		turn := newTestPiTurn(t)
		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "thinking_start"}), now)
		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "thinking_delta", "delta": "Creating SVG"}), now)
		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "toolcall_start", "id": "call-2", "toolName": "write"}), now)
		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "toolcall_delta", "delta": "{}"}), now)
		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "thinking_end", "content": "Creating SVG"}), now)
		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "toolcall_end"}), now)

		events := piDrainEmitted(turn)
		if len(events) != 3 {
			t.Fatalf("events = %+v, want 3 (late thinking_end suppressed)", events)
		}
		if events[0].Kind != EventReasoning || events[0].Body != "Creating SVG" || events[0].Complete ||
			events[1].Kind != EventReasoning || events[1].Body != "" || !events[1].Complete ||
			events[2].Kind != EventToolCallStart || events[2].ToolName != "write" || events[2].ActivityKind != ActivityFileChange {
			t.Fatalf("unexpected openai completions sequence: %+v", events)
		}
	})

	t.Run("non_streaming_thinking_end_with_content", func(t *testing.T) {
		turn := newTestPiTurn(t)
		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "thinking_end", "content": "Full single line"}), now)

		events := piDrainEmitted(turn)
		if len(events) != 1 || events[0].Kind != EventReasoning || events[0].Body != "Full single line" || !events[0].Complete {
			t.Fatalf("events = %+v, want single complete reasoning event with body", events)
		}
	})

	t.Run("two_consecutive_thinking_blocks", func(t *testing.T) {
		turn := newTestPiTurn(t)
		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "thinking_start"}), now)
		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "thinking_delta", "delta": "Block one"}), now)
		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "thinking_end", "content": "Block one"}), now)
		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "thinking_start"}), now)
		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "thinking_delta", "delta": "Block two"}), now)
		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "thinking_end", "content": "Block two"}), now)

		events := piDrainEmitted(turn)
		if len(events) != 4 ||
			!events[1].Complete || events[1].Body != "" ||
			events[2].Body != "Block two" ||
			!events[3].Complete || events[3].Body != "" {
			t.Fatalf("events = %+v, want two complete thinking blocks", events)
		}
	})

	t.Run("text_start_and_message_end_flush_once", func(t *testing.T) {
		turn := newTestPiTurn(t)
		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "thinking_start"}), now)
		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "thinking_delta", "delta": "Before text"}), now)
		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "text_start"}), now)
		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "thinking_end", "content": "Before text"}), now)

		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "thinking_start"}), now)
		turn.apply(piAssistantUpdateFrame(t, map[string]any{"type": "thinking_delta", "delta": "Before message end"}), now)
		turn.apply(piMessageEndFrame(t, "assistant"), now)

		events := piDrainEmitted(turn)
		var completeCount int
		for _, event := range events {
			if event.Kind == EventReasoning && event.Complete {
				completeCount++
			}
		}
		if completeCount != 2 {
			t.Fatalf("complete reasoning count = %d, events = %+v", completeCount, events)
		}
	})
}
