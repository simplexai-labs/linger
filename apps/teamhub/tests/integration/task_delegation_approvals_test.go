package integration_test

import (
	"crypto/sha256"
	"net/http"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskdelegation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

// An AlterEgo's approval card expires after 10 minutes, and expiring wakes the
// AlterEgo like a decision; stopping the Task expires its cards without a
// wake.
func TestAlterEgoApprovalCardsExpireOrStopWithTheTask(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, issued, roomID := newAgentCLIIdentity(t)
	cards := typedcard.New(env.pool)

	t.Run("an expired card wakes the AlterEgo", func(t *testing.T) {
		created := createDelegatedTask(t, env, issued, "card-expiry", "Send the quote", "Send the quote.", roomID)
		worker := claimDelegatedTask(t, env, created.TaskID, "worker-card-expiry")
		effectID := worker.startTurn("run-card-expiry")
		contextKey := insertAlterEgoLocalRun(t, env, created.TaskID, "run-card-expiry", "Waiting for approval.")
		insertPendingRuntimePermission(t, env, roomID, contextKey, "decision_card_expiry")
		worker.endTurn(effectID, "run-card-expiry", "succeeded", "")
		worker.advance()
		assertDelegatedTaskState(t, env, created.TaskID, "waiting_for_approval", "pending_approval")

		if _, err := env.pool.Exec(t.Context(), `UPDATE decisions SET expires_at=clock_timestamp() WHERE id='decision_card_expiry'`); err != nil {
			t.Fatal(err)
		}
		expired, _, err := cards.ExpireDecision(t.Context(), "decision_card_expiry")
		if err != nil || !expired {
			t.Fatalf("expired=%v err=%v", expired, err)
		}
		// The AlterEgo is woken through decision.run, after the expiry commits.
		if got := countRows(t, env, `SELECT count(*) FROM river_job WHERE kind='decision.run'
			AND args->>'decision_id'='decision_card_expiry'`); got != 1 {
			t.Fatalf("expiry wake jobs=%d want=1", got)
		}
		// The expiry is a result: the AlterEgo is told as for a decision.
		notice, err := cards.HandOffDecision(t.Context(), "decision_card_expiry")
		if err != nil || notice.AlterEgoTaskID != created.TaskID || !strings.Contains(notice.Text, "Approval decision_card_expiry expired") {
			t.Fatalf("expiry notice=%+v err=%v", notice, err)
		}
		// An expired card no longer holds the Task waiting.
		if got := countRows(t, env, `SELECT count(*) FROM decisions WHERE alter_ego_task_id=$1 AND status='pending'`, created.TaskID); got != 0 {
			t.Fatalf("pending approvals after expiry=%d", got)
		}
		// A retried expiry job wakes nobody again.
		if expired, _, err := cards.ExpireDecision(t.Context(), "decision_card_expiry"); err != nil || expired {
			t.Fatalf("second expiry=%v err=%v", expired, err)
		}
		if got := countRows(t, env, `SELECT count(*) FROM river_job WHERE kind='decision.run'
			AND args->>'decision_id'='decision_card_expiry'`); got != 1 {
			t.Fatalf("expiry wake jobs after a retry=%d want=1", got)
		}
	})

	t.Run("stopping expires the cards without a wake", func(t *testing.T) {
		created := createDelegatedTask(t, env, issued, "card-stop", "Book the room", "Book the meeting room.", roomID)
		contextKey := insertAlterEgoLocalRun(t, env, created.TaskID, "run-card-stop", "Waiting.")
		insertPendingRuntimePermission(t, env, roomID, contextKey, "decision_card_stop")
		stopDelegatedTask(t, env, issued, roomID, "card-stop-stop", created.TaskID)
		assertDelegatedTaskState(t, env, created.TaskID, "canceled", "stopped")
		if got := countRows(t, env, `SELECT count(*) FROM river_job WHERE kind='task_delegation.expire_stopped_approvals'
			AND args->>'task_id'=$1`, created.TaskID); got != 1 {
			t.Fatalf("stop expiry jobs=%d want=1", got)
		}
		if err := cards.ExpireStoppedTaskApprovals(t.Context(), acmeTenant, created.TaskID); err != nil {
			t.Fatal(err)
		}
		if got := countRows(t, env, `SELECT count(*) FROM decisions WHERE id='decision_card_stop' AND status='expired'`); got != 1 {
			t.Fatalf("stopped Task's expired cards=%d want=1", got)
		}
		if got := countRows(t, env, `SELECT count(*) FROM river_job WHERE kind='decision.run'
			AND args->>'decision_id'='decision_card_stop'`); got != 0 {
			t.Fatalf("a stopped Task's card woke the AlterEgo: %d jobs", got)
		}
		// The card's own expiry job, due later, still wakes nobody.
		if _, err := env.pool.Exec(t.Context(), `UPDATE decisions SET expires_at=clock_timestamp() WHERE id='decision_card_stop'`); err != nil {
			t.Fatal(err)
		}
		if expired, _, err := cards.ExpireDecision(t.Context(), "decision_card_stop"); err != nil || expired {
			t.Fatalf("expiry job after stop expired=%v err=%v", expired, err)
		}
		if got := countRows(t, env, `SELECT count(*) FROM river_job WHERE kind='decision.run'
			AND args->>'decision_id'='decision_card_stop'`); got != 0 {
			t.Fatalf("the expiry job woke a stopped Task: %d jobs", got)
		}
	})

	t.Run("a stopped Task ignores connection and permission card results", func(t *testing.T) {
		created := createDelegatedTask(t, env, issued, "card-stop-connection", "Check calendar", "Check calendar in Chrome.", roomID)
		browserHash := sha256.Sum256([]byte(roomID + "\x00stop\x00browser"))
		browserCard, err := cards.CreateDecision(t.Context(), roomID, acmeOfficialAgentManagementID, "card-stop-browser", browserHash[:], typedcard.DecisionCommand{
			DeciderActorID: "actor_acme_alice",
			AlterEgoTaskID: created.TaskID,
			BrowserConnection: &typedcard.BrowserConnectionDecision{
				Prompt:     "Connect Chrome",
				ComputerID: "computer-stop-test",
			},
		})
		if err != nil {
			t.Fatalf("create browser_connection card: %v", err)
		}
		permHash := sha256.Sum256([]byte(roomID + "\x00stop\x00permission"))
		permCard, err := cards.CreateDecision(t.Context(), roomID, acmeOfficialAgentManagementID, "card-stop-perm", permHash[:], typedcard.DecisionCommand{
			DeciderActorID: "actor_acme_alice",
			AlterEgoTaskID: created.TaskID,
			ComputerPermission: &typedcard.ComputerPermissionDecision{
				ComputerID:  "computer-stop-test",
				Subject:     typedcard.ComputerPermissionSubjectComputerUse,
				Permissions: []string{typedcard.ComputerPermissionAccessibility},
				Reason:      "Click calendar button",
			},
		})
		if err != nil {
			t.Fatalf("create computer_permission card: %v", err)
		}

		stopDelegatedTask(t, env, issued, roomID, "card-stop-connection-stop", created.TaskID)
		if err := cards.ExpireStoppedTaskApprovals(t.Context(), acmeTenant, created.TaskID); err != nil {
			t.Fatal(err)
		}
		assertDelegatedTaskState(t, env, created.TaskID, "canceled", "stopped")
		if got := countRows(t, env, `SELECT count(*) FROM decisions WHERE id IN ($1,$2) AND status='pending'`, browserCard.DecisionID, permCard.DecisionID); got != 2 {
			t.Fatalf("pending connection/permission cards after stop=%d want=2", got)
		}

		attemptsBefore := countRows(t, env, `SELECT count(*) FROM task_attempts WHERE task_id=$1`, created.TaskID)
		inputsBefore := countRows(t, env, `SELECT count(*) FROM task_input_revisions WHERE task_id=$1`, created.TaskID)

		if err := cards.SettleBrowserConnections(t.Context(), acmeTenant, "actor_acme_alice", "computer-stop-test"); err != nil {
			t.Fatal(err)
		}
		browserNotice, err := cards.HandOffDecision(t.Context(), browserCard.DecisionID)
		if err != nil || browserNotice.AlterEgoTaskID != created.TaskID || browserNotice.Text == "" {
			t.Fatalf("browser notice=%+v err=%v", browserNotice, err)
		}
		delegation := taskdelegation.New(env.pool, agentauth.New(env.pool))
		settledResult, err := delegation.SendSystemInput(t.Context(), acmeOfficialAgentManagementID, created.TaskID, browserNotice.Text)
		if err != nil || settledResult.Delivery != "ignored" || settledResult.Status != "canceled" {
			t.Fatalf("settled system input on stopped Task=%+v err=%v", settledResult, err)
		}
		assertDelegatedTaskState(t, env, created.TaskID, "canceled", "stopped")
		if got := countRows(t, env, `SELECT count(*) FROM task_attempts WHERE task_id=$1`, created.TaskID); got != attemptsBefore {
			t.Fatalf("stopped Task attempts after settled card=%d want=%d", got, attemptsBefore)
		}
		if got := countRows(t, env, `SELECT count(*) FROM task_input_revisions WHERE task_id=$1`, created.TaskID); got != inputsBefore {
			t.Fatalf("stopped Task inputs after settled card=%d want=%d", got, inputsBefore)
		}

		if _, err := env.pool.Exec(t.Context(), `UPDATE decisions SET expires_at=clock_timestamp() WHERE id=$1`, permCard.DecisionID); err != nil {
			t.Fatal(err)
		}
		if expired, _, err := cards.ExpireDecision(t.Context(), permCard.DecisionID); err != nil || !expired {
			t.Fatalf("expire computer_permission card=%v err=%v", expired, err)
		}
		permNotice, err := cards.HandOffDecision(t.Context(), permCard.DecisionID)
		if err != nil || permNotice.AlterEgoTaskID != created.TaskID || permNotice.Text == "" {
			t.Fatalf("permission expiry notice=%+v err=%v", permNotice, err)
		}
		expiredResult, err := delegation.SendSystemInput(t.Context(), acmeOfficialAgentManagementID, created.TaskID, permNotice.Text)
		if err != nil || expiredResult.Delivery != "ignored" || expiredResult.Status != "canceled" {
			t.Fatalf("expired system input on stopped Task=%+v err=%v", expiredResult, err)
		}
		assertDelegatedTaskState(t, env, created.TaskID, "canceled", "stopped")
		if got := countRows(t, env, `SELECT count(*) FROM task_attempts WHERE task_id=$1`, created.TaskID); got != attemptsBefore {
			t.Fatalf("stopped Task attempts after expired card=%d want=%d", got, attemptsBefore)
		}
		if got := countRows(t, env, `SELECT count(*) FROM task_input_revisions WHERE task_id=$1`, created.TaskID); got != inputsBefore {
			t.Fatalf("stopped Task inputs after expired card=%d want=%d", got, inputsBefore)
		}

		idleTask := createDelegatedTask(t, env, issued, "card-idle-connection", "Check calendar", "Check calendar in Chrome.", roomID)
		worker := claimDelegatedTask(t, env, idleTask.TaskID, "worker-idle-connection")
		effectID := worker.startTurn("run-idle-connection")
		insertAlterEgoLocalRun(t, env, idleTask.TaskID, "run-idle-connection", "Waiting for Chrome connection.")
		worker.endTurn(effectID, "run-idle-connection", "succeeded", "")
		worker.advance()
		assertDelegatedTaskState(t, env, idleTask.TaskID, "idle", "run_succeeded")

		woken, err := delegation.SendSystemInput(t.Context(), acmeOfficialAgentManagementID, idleTask.TaskID, browserNotice.Text)
		if err != nil || woken.Delivery != "started" || woken.Status != "running" {
			t.Fatalf("connection notice on idle Task=%+v err=%v", woken, err)
		}
		assertDelegatedTaskState(t, env, idleTask.TaskID, "running", "")
	})
}

func stopDelegatedTask(t *testing.T, env *testEnv, issued agentcredential.Issued, roomID, invocation, taskID string) {
	t.Helper()
	code, body := postTaskCommand(t, env, issued, "stop", map[string]any{
		"invocation_id": mcpCreationInvocationID(invocation), "task_id": taskID,
	}, taskDelegationRoomContext(roomID))
	if code != http.StatusOK {
		t.Fatalf("task stop=%d %s", code, body)
	}
}
