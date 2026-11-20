package agentruntimestate

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestDeliverFallbackReplyValidation(t *testing.T) {
	svc := &Service{}
	for _, test := range []struct {
		name  string
		input DeliverFallbackReplyInput
		want  error
	}{
		{
			name:  "empty context key",
			input: DeliverFallbackReplyInput{Epoch: "epoch-1", RunID: "run-1", Text: "hello"},
			want:  ErrInvalid,
		},
		{
			name:  "empty run id",
			input: DeliverFallbackReplyInput{ContextKey: "ctx-1", Epoch: "epoch-1", Text: "hello"},
			want:  ErrInvalid,
		},
		{
			name:  "whitespace only text",
			input: DeliverFallbackReplyInput{ContextKey: "ctx-1", Epoch: "epoch-1", RunID: "run-1", Text: "  \n\t  "},
			want:  ErrInvalid,
		},
		{
			name:  "oversized text",
			input: DeliverFallbackReplyInput{ContextKey: "ctx-1", Epoch: "epoch-1", RunID: "run-1", Text: strings.Repeat("a", maxFallbackReplyRunes+1)},
			want:  ErrResponseTooLarge,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := svc.DeliverFallbackReply(context.Background(), test.input)
			if !errors.Is(err, test.want) {
				t.Fatalf("err = %v, want %v", err, test.want)
			}
		})
	}
}

func TestFallbackReplyDeterministicIdentifiers(t *testing.T) {
	msg1 := fallbackReplyMessageID("ctx:room-1", "run-1")
	msg2 := fallbackReplyMessageID("ctx:room-1", "run-1")
	msgOther := fallbackReplyMessageID("ctx:room-1", "run-2")
	if msg1 != msg2 || msg1 == msgOther {
		t.Fatalf("message ids: %q %q %q", msg1, msg2, msgOther)
	}
	if !strings.HasPrefix(msg1, "message_") || len(msg1) > 64 {
		t.Fatalf("unexpected message id format: %q", msg1)
	}
	inv1 := fallbackReplyInvocationID("ctx:room-1", "run-1")
	if !invocationPattern.MatchString(inv1) {
		t.Fatalf("invocation id %q does not match invocationPattern", inv1)
	}
}
