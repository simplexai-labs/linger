package integration_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentmessages"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
)

func TestAgentRuntimeClearSessionRecoveryRules(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	revision := activeRuntimeConfigurationRevision(t, env.pool)

	submitted, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{
		ContextKey: env.contextKey,
		Epoch:      env.epoch,
		Inputs:     []agentruntimestate.RuntimeInput{runtimeInput("seed-recovery-clear", "trusted_turn", "", "seed")},
	})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
		ClaimID: "claim-seed-recovery", ContextKey: env.contextKey, Epoch: env.epoch,
	})
	if err != nil || claimed.Run == nil {
		t.Fatalf("claim seed run: %+v %v", claimed, err)
	}
	checkpoint := runtimeSessionCheckpoint(0, revision, "thread-recovery-1")
	if _, err := env.service.FinishLocalRun(t.Context(), agentruntimestate.FinishLocalRunInput{
		ContextKey: env.contextKey, Epoch: env.epoch, RunID: submitted.RunID,
		Terminal: json.RawMessage(`{"type":"succeeded"}`),
		Session:  &checkpoint,
	}); err != nil {
		t.Fatal(err)
	}

	// Same-revision clear without recovery_reason is rejected on an active Context.
	if _, err := env.service.ClearRuntimeSession(t.Context(), agentruntimestate.ClearRuntimeSessionInput{
		ContextKey: env.contextKey, Epoch: env.epoch, ConfigurationRevision: revision,
	}); !errors.Is(err, agentruntimestate.ErrConflict) {
		t.Fatalf("plain same-revision clear error=%v, want ErrConflict", err)
	}

	// Combining recovery_reason with expected_current_configuration_revision is rejected.
	expectedRev := revision
	if _, err := env.service.ClearRuntimeSession(t.Context(), agentruntimestate.ClearRuntimeSessionInput{
		ContextKey: env.contextKey, Epoch: env.epoch, ConfigurationRevision: revision,
		ExpectedCurrentConfigurationRevision: &expectedRev,
		RecoveryReason:                       "context_too_long",
	}); !errors.Is(err, agentruntimestate.ErrInvalid) {
		t.Fatalf("mutually exclusive clear error=%v, want ErrInvalid", err)
	}

	// While a Run is running, recovery clear conflicts.
	second, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{
		ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{runtimeInput("running-recovery-clear", "trusted_turn", "", "next")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
		ClaimID: "claim-running-recovery", ContextKey: env.contextKey, Epoch: env.epoch,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := env.service.ClearRuntimeSession(t.Context(), agentruntimestate.ClearRuntimeSessionInput{
		ContextKey: env.contextKey, Epoch: env.epoch, ConfigurationRevision: revision,
		RecoveryReason: "session_not_found",
	}); !errors.Is(err, agentruntimestate.ErrConflict) {
		t.Fatalf("clear while running error=%v, want ErrConflict", err)
	}

	// Once requeued (idle active Context), recovery_reason clears the same-revision Session.
	if err := env.service.RequeueLocalRun(t.Context(), agentruntimestate.RequeueLocalRunInput{
		ContextKey: env.contextKey, Epoch: env.epoch, RunID: second.RunID,
	}); err != nil {
		t.Fatal(err)
	}
	cleared, err := env.service.ClearRuntimeSession(t.Context(), agentruntimestate.ClearRuntimeSessionInput{
		ContextKey: env.contextKey, Epoch: env.epoch, ConfigurationRevision: revision,
		RecoveryReason: "context_too_long",
	})
	if err != nil || !cleared.Cleared {
		t.Fatalf("recovery clear after requeue: %+v %v", cleared, err)
	}
	session, err := env.service.GetRuntimeSession(t.Context(), env.contextKey)
	if err != nil || session != nil {
		t.Fatalf("session after recovery clear: %+v %v", session, err)
	}
}

func TestAgentRuntimeClaimAttachesRecentMessagesOnlyWithoutSession(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	revision := activeRuntimeConfigurationRevision(t, env.pool)
	roomID := testRuntimeInboxRoom
	inboxID := "room:" + roomID

	// Seed Room messages visible to the test runtime agent.
	var agentActorID string
	if err := env.pool.QueryRow(t.Context(),
		`SELECT agent_actor_id FROM agent_execution_contexts WHERE context_key=$1`,
		env.contextKey,
	).Scan(&agentActorID); err != nil {
		t.Fatal(err)
	}
	insertRoomMsg := func(id, authorActorID, body string, createdAt time.Time) {
		t.Helper()
		var roomSeq int64
		if err := env.pool.QueryRow(t.Context(),
			`SELECT COALESCE(MAX(room_seq), 0) + 1 FROM room_events WHERE tenant_id=$1 AND room_id=$2`,
			acmeTenant, roomID,
		).Scan(&roomSeq); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(t.Context(), `
			INSERT INTO messages (id, tenant_id, room_id, author_actor_id, body, segments, message_kind, created_at)
			VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, 'conversation', $6)
		`, id, acmeTenant, roomID, authorActorID, body, createdAt); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(t.Context(), `
			INSERT INTO room_events (tenant_id, room_id, room_seq, event_type, resource_id, payload, created_at)
			VALUES ($1, $2, $3, 'message.created', $4, '{}'::jsonb, $5)
		`, acmeTenant, roomID, roomSeq, id, createdAt); err != nil {
			t.Fatal(err)
		}
	}

	baseTime := time.Date(2026, 5, 1, 10, 0, 0, 0, time.UTC)
	for i := 1; i <= 7; i++ {
		insertRoomMsg(fmt.Sprintf("msg_hist_%d", i), "actor_alice", fmt.Sprintf("History %d", i), baseTime.Add(time.Duration(i)*time.Minute))
	}
	insertRoomMsg("msg_current_8", "actor_alice", "Current request", baseTime.Add(8*time.Minute))
	insertRoomMsg("msg_agent_mid_9", agentActorID, "Mid-turn agent progress", baseTime.Add(9*time.Minute))
	insertRoomMsg("msg_future_user_10", "actor_alice", "Later user message", baseTime.Add(10*time.Minute))

	// First input establishes prior Context history.
	first, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{
		ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{runtimeInput("in-hist-1", "trusted_turn", "", "earlier")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
		ClaimID: "claim-hist-1", ContextKey: env.contextKey, Epoch: env.epoch,
	}); err != nil {
		t.Fatal(err)
	}
	checkpoint := runtimeSessionCheckpoint(0, revision, "thread-hist-1")
	if _, err := env.service.FinishLocalRun(t.Context(), agentruntimestate.FinishLocalRunInput{
		ContextKey: env.contextKey, Epoch: env.epoch, RunID: first.RunID,
		Terminal: json.RawMessage(`{"type":"succeeded"}`),
		Session:  &checkpoint,
	}); err != nil {
		t.Fatal(err)
	}

	// Second Run anchored at msg_current_8: with a persisted Session, recent_messages is omitted.
	currentInput := runtimeInput("in-hist-2", "trusted_turn", "", "Current request")
	currentInput.SourceInboxID = inboxID
	currentInput.SourceMessageID = "msg_current_8"
	second, err := env.service.SubmitTrustedTurn(t.Context(), agentruntimestate.SubmitTrustedTurnInput{
		ContextKey: env.contextKey, Epoch: env.epoch,
		Inputs: []agentruntimestate.RuntimeInput{currentInput},
	})
	if err != nil {
		t.Fatal(err)
	}
	withSession, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
		ClaimID: "claim-hist-2-session", ContextKey: env.contextKey, Epoch: env.epoch,
	})
	if err != nil || withSession.Run == nil {
		t.Fatalf("claim with session: %+v %v", withSession, err)
	}
	if withSession.Run.RecentMessages != nil {
		t.Fatalf("expected nil recent_messages while session exists, got %+v", withSession.Run.RecentMessages)
	}

	// Requeue and clear the Session with recovery_reason, then re-claim (attempt 2).
	if err := env.service.RequeueLocalRun(t.Context(), agentruntimestate.RequeueLocalRunInput{
		ContextKey: env.contextKey, Epoch: env.epoch, RunID: second.RunID,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := env.service.ClearRuntimeSession(t.Context(), agentruntimestate.ClearRuntimeSessionInput{
		ContextKey: env.contextKey, Epoch: env.epoch, ConfigurationRevision: revision,
		RecoveryReason: "context_too_long",
	}); err != nil {
		t.Fatal(err)
	}
	recovered, err := env.service.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{
		ClaimID: "claim-hist-2-fresh", ContextKey: env.contextKey, Epoch: env.epoch,
	})
	if err != nil || recovered.Run == nil || recovered.Run.RecentMessages == nil {
		t.Fatalf("claim fresh session: %+v %v", recovered, err)
	}
	recent := recovered.Run.RecentMessages
	if recent.InboxID != inboxID || len(recent.Messages) != 5 || recent.NextCursor == "" {
		t.Fatalf("unexpected recent_messages: %+v", recent)
	}
	// On retry (attempt 2), chronological window includes msg_hist_4..7 + msg_agent_mid_9,
	// excluding msg_current_8 (current input) and msg_future_user_10 (later user message).
	wantIDs := []string{"msg_hist_4", "msg_hist_5", "msg_hist_6", "msg_hist_7", "msg_agent_mid_9"}
	for i, wantID := range wantIDs {
		if recent.Messages[i].MessageID != wantID {
			t.Fatalf("recent.Messages[%d].MessageID = %q, want %q (all=%+v)", i, recent.Messages[i].MessageID, wantID, recent.Messages)
		}
	}

	// Verify next_cursor pages cleanly through agentmessages.
	historySvc := agentmessages.New(env.pool)
	olderPage, err := historySvc.Read(t.Context(), agentmessages.Reader{
		TenantID: acmeTenant, ActorID: agentActorID,
	}, agentmessages.ReadInput{
		InboxID: inboxID,
		Cursor:  recent.NextCursor,
		Limit:   5,
	})
	if err != nil {
		t.Fatalf("agentmessages.Read with next_cursor: %v", err)
	}
	if olderPage.Messages == nil || len(*olderPage.Messages) != 3 || (*olderPage.Messages)[0].MessageID != "msg_hist_3" {
		t.Fatalf("older page=%+v, want 3 messages starting at msg_hist_3", olderPage)
	}
}
