//go:build unix

package transport

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

// The TypeScript consumer test validates these real native outcomes after the
// production Go wire serializer, rather than reconstructing the enum by hand.
func TestClaudeInputWireOutcomes(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal(err)
	}
	cli := filepath.Join(t.TempDir(), "claude-fixture")
	// The fixture keeps running main-agent tools after the input echo until a
	// PostToolUse hook answer carries steered input, then ends the turn, so
	// a later steer is never carried.
	script := `#!` + python + `
import json, sys, time
def emit(frame):
    print(json.dumps(frame), flush=True)
def hook(n):
    time.sleep(0.05)
    emit({'type': 'control_request', 'request_id': 'hook-%d' % n, 'request': {'subtype': 'hook_callback', 'callback_id': 'hook_steer',
          'input': {'hook_event_name': 'PostToolUse', 'tool_name': 'Bash', 'tool_input': {}}}})
hooks, turn = 0, None
for line in sys.stdin:
    frame = json.loads(line)
    if frame['type'] == 'control_request':
        emit({'type': 'control_response', 'response': {'subtype': 'success', 'request_id': frame['request_id']}})
    elif frame['type'] == 'control_response':
        if 'additionalContext' in line:
            emit({'type': 'result', 'subtype': 'success', 'is_error': False, 'terminal_reason': 'completed', 'result': 'done',
                  'session_id': 'fixture-session', 'user_message_uuid': turn})
        elif hooks < 200:
            hooks += 1
            hook(hooks)
    elif frame['type'] == 'user':
        turn = frame['uuid']
        emit({'type': 'user', 'isReplay': True, 'uuid': turn, 'session_id': 'fixture-session'})
        hook(hooks)
`
	if err := os.WriteFile(cli, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	backend, err := native.Open("claude", native.Profile{Program: cli, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	session, err := backend.Start(ctx, "initial", native.RunSpec{
		ExposeTurnStarted: true,
		ClaudePolicy:      &native.ClaudeToolPolicy{},
	})
	if err != nil {
		t.Fatal(err)
	}
	var turn string
	select {
	case message := <-session.Events:
		turn = message.TurnID
	case <-ctx.Done():
		t.Fatal("initial native replay not observed")
	}
	if turn == "" {
		t.Fatal("missing run turn")
	}
	go func() {
		for range session.Events {
		}
	}()
	ack, err := session.Steer(ctx, native.SteerRequest{ExpectedTurnID: turn, Input: "confirmed"})
	if err != nil || ack.TurnID != turn {
		t.Fatalf("ACK target mismatch: %+v %v", ack, err)
	}
	_, err = session.Steer(ctx, native.SteerRequest{ExpectedTurnID: turn, Input: "late"})
	var failure *native.SteerError
	if !errors.As(err, &failure) || failure.Effect != "definitely_not_applied" || failure.Reason != "no_active_turn" {
		t.Fatalf("invalid native failure: %v", err)
	}
	select {
	case result := <-session.Outcome:
		if result.Status != "completed" {
			t.Fatalf("steered turn result=%+v", result)
		}
	case <-ctx.Done():
		t.Fatal("steered native turn did not end")
	}
	base := protocol.Event{
		ProtocolVersion: "2", TenantID: "tenant-1", RunnerID: "computer-1",
		AgentID: "agent-1", OperationID: "operation-1", RegistrationID: "registration-1", AssignmentRevision: 1,
		ConnectionEpoch: 1, RunnerRevision: 1, Generation: 1, ExecutionLeaseID: "lease-1",
		WorkspaceGrantID: "grant-1", RuntimeType: "claude", HostAccess: "trusted",
		ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1",
		ContextViewRef: json.RawMessage(`{"view_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`),
	}
	base.Type, base.CommandID, base.Sequence = protocol.EventOperationInputAck, "input-1", 15
	base.Payload, _ = json.Marshal(map[string]any{"turn_id": ack.TurnID})
	confirmed, err := replyMap(base)
	if err != nil {
		t.Fatal(err)
	}
	base.Type, base.CommandID, base.Sequence = protocol.EventOperationInputRejected, "input-2", 16
	base.Payload, _ = json.Marshal(map[string]any{"expected_turn_id": turn, "actual_turn_id": failure.ActualTurnID, "effect": failure.Effect, "reason": failure.Reason, "message": failure.Message})
	rejected, err := replyMap(base)
	if err != nil {
		t.Fatal(err)
	}
	if target := os.Getenv("LINGER_CLAUDE_INPUT_WIRE_FIXTURE"); target != "" {
		encoded, err := json.Marshal([]any{confirmed, rejected})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, encoded, 0600); err != nil {
			t.Fatal(err)
		}
	}
}
