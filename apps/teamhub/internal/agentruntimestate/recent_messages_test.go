package agentruntimestate

import (
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentmessages"
)

func TestValidSessionRecoveryReason(t *testing.T) {
	for _, tc := range []struct {
		reason string
		want   bool
	}{
		{"", true},
		{"session_not_found", true},
		{"context_too_long", true},
		{"timeout", false},
		{"other", false},
	} {
		if got := validSessionRecoveryReason(tc.reason); got != tc.want {
			t.Fatalf("validSessionRecoveryReason(%q) = %v, want %v", tc.reason, got, tc.want)
		}
	}
}

func TestPrimaryRecentMessagesInbox(t *testing.T) {
	owner := contextRecord{RoomID: pgtype.Text{String: "room-fallback", Valid: true}}
	inputs := []StoredRuntimeInput{
		{RuntimeInput: RuntimeInput{SourceInboxID: "thread:thread-1"}},
	}
	if got := primaryRecentMessagesInbox(owner, inputs); got != "thread:thread-1" {
		t.Fatalf("got %q, want thread:thread-1", got)
	}
	payloadInputs := []StoredRuntimeInput{
		{RuntimeInput: RuntimeInput{Payload: json.RawMessage(`{"sourceInboxIds":["room:room-2"]}`)}},
	}
	if got := primaryRecentMessagesInbox(owner, payloadInputs); got != "room:room-2" {
		t.Fatalf("got %q, want room:room-2", got)
	}
	if got := primaryRecentMessagesInbox(owner, nil); got != "room:room-fallback" {
		t.Fatalf("got %q, want room:room-fallback", got)
	}
}

func TestRunInputMessageIDsDeduplicates(t *testing.T) {
	inputs := []StoredRuntimeInput{
		{RuntimeInput: RuntimeInput{
			SourceMessageID: "msg-1",
			Payload:         json.RawMessage(`{"invocationMessageIds":["msg-1","msg-2"]}`),
		}},
		{RuntimeInput: RuntimeInput{
			SourceMessageID: "msg-2",
			Payload:         json.RawMessage(`{"invocationMessageIds":["msg-3"]}`),
		}},
	}
	got := runInputMessageIDs(inputs)
	want := []string{"msg-1", "msg-2", "msg-3"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got[%d]=%q, want %q", i, got[i], want[i])
		}
	}
}

func TestEncodeAgentHistoryCursorMatchesFormat(t *testing.T) {
	ts := time.Date(2026, 5, 1, 10, 20, 30, 0, time.UTC)
	encoded := agentmessages.EncodeCursor(ts, "msg-42")
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("decode cursor: %v", err)
	}
	var decoded struct {
		Time      time.Time `json:"time"`
		MessageID string    `json:"message_id"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal cursor: %v", err)
	}
	if !decoded.Time.Equal(ts) || decoded.MessageID != "msg-42" {
		t.Fatalf("decoded=%+v, want time=%v id=msg-42", decoded, ts)
	}
}

func TestTruncateRunes(t *testing.T) {
	body, truncated := truncateRunes("hello world", 5)
	if body != "hello..." || !truncated {
		t.Fatalf("got (%q, %v), want (%q, true)", body, truncated, "hello...")
	}
	body, truncated = truncateRunes("short", 10)
	if body != "short" || truncated {
		t.Fatalf("got (%q, %v), want (%q, false)", body, truncated, "short")
	}
}
