package integration_test

import (
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

// decisionMessageResponse is a decision card Message as the Web reads it.
type decisionMessageResponse struct {
	ID          string `json:"id"`
	RoomID      string `json:"room_id"`
	MessageKind string `json:"message_kind"`
	RawMessage  string `json:"raw_message"`
	Author      struct {
		ID   string `json:"id"`
		Kind string `json:"kind"`
	} `json:"author"`
	Segments []struct {
		Type       string `json:"type"`
		Content    string `json:"content"`
		Target     string `json:"target"`
		TargetType string `json:"target_type"`
	} `json:"segments"`
	Card struct {
		CardType      string `json:"card_type"`
		Intent        string `json:"intent"`
		Version       int64  `json:"version"`
		DecisionID    string `json:"decision_id"`
		Kind          string `json:"kind"`
		Status        string `json:"status"`
		Title         string `json:"title"`
		DecisionOwner struct {
			ID          string `json:"id"`
			DisplayName string `json:"display_name"`
		} `json:"decision_owner"`
		Requester struct {
			ID   string `json:"id"`
			Kind string `json:"kind"`
		} `json:"requester"`
		Answer *struct {
			Decision     string `json:"decision"`
			Comment      string `json:"comment"`
			ConnectionID string `json:"connection_id"`
		} `json:"answer"`
	} `json:"card"`
}

// Exercises the persisted consent, grant, card and targeted receipt as one transaction.
func TestConnectionAuthorizationGeneralAgentPostgreSQL(t *testing.T) {
	allowParallelIntegrationTest(t)
	composioFake := newFakeComposio(t)
	env, alice := newAgentRunEnvWithConfig(t, "http://127.0.0.1:1", composioFake.configure)
	roomID := createPrivateRoom(t, env, alice, "Connection authorization", "connection-auth-room")
	if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); code != http.StatusOK {
		t.Fatalf("member: %d %s", code, body)
	}
	sources := composioFake.externalSources(t, env.pool, nil)
	newCards := func() *typedcard.Service {
		cards := typedcard.New(env.pool)
		cards.SetConnectionAuthorizer(sources)
		return cards
	}
	cards := newCards()
	create := func(key string) decisionMessageResponse {
		t.Helper()
		hash := sha256.Sum256([]byte(key))
		result, err := cards.CreateDecision(t.Context(), roomID, acmeOfficialAgentManagementID, key, hash[:], typedcard.DecisionCommand{DeciderActorID: "actor_acme_alice", ConnectionAuth: &typedcard.ConnectionAuthDecision{Prompt: "Allow the Room Agent to use Notion", AppKey: "notion"}})
		if err != nil {
			t.Fatal(err)
		}
		var message decisionMessageResponse
		decode(t, result.Body, &message)
		return message
	}
	insert := func(id, owner, provider, state string) {
		t.Helper()
		if _, err := env.pool.Exec(t.Context(), `INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,toolkit_slug) VALUES($1,$2,$3,$1,$4,$3)`, id, owner, provider, state); err != nil {
			t.Fatal(err)
		}
	}
	decide := func(message decisionMessageResponse, decision, connection, key string, version int64) (int, []byte) {
		t.Helper()
		request := map[string]any{"expected_version": version, "decision": decision}
		if connection != "" {
			request["connection_id"] = connection
		}
		code, _, body := env.request(alice, http.MethodPost, "/v0/decisions/"+message.Card.DecisionID, request, key)
		return code, body
	}
	assertState := func(message decisionMessageResponse, state string, receipts int) {
		t.Helper()
		var current string
		if err := env.pool.QueryRow(t.Context(), `SELECT status FROM decisions WHERE id=$1`, message.Card.DecisionID).Scan(&current); err != nil {
			t.Fatal(err)
		}
		if current != state {
			t.Fatalf("state=%s want %s", current, state)
		}
		if got := countRows(t, env, `SELECT count(*) FROM messages WHERE card_context_message_id=$1 AND message_kind='agent_runtime'`, message.ID); got != receipts {
			t.Fatalf("receipts=%d want %d", got, receipts)
		}
	}
	assertGrant := func(connection string, want int) {
		t.Helper()
		if got := countRows(t, env, `SELECT count(*) FROM external_connection_agent_grants WHERE connection_id=$1 AND agent_actor_id='actor_acme_official' AND status='active'`, connection); got != want {
			t.Fatalf("grants=%d want %d", got, want)
		}
	}
	reconcile := func() {
		t.Helper()
		if err := newCards().ReconcileConnectionAuthorizations(t.Context()); err != nil {
			t.Fatal(err)
		}
	}

	insert("auth-active", "account_alice", "notion", "active")
	insert("auth-wrong-app", "account_alice", "gmail", "active")
	message := create("active")
	if got := countRows(t, env, `SELECT count(*) FROM agent_registrations WHERE actor_id='actor_acme_official' AND agent_type='general' AND represented_human_actor_id IS NULL`); got != 1 {
		t.Fatal("fixture must be a general Agent without an AnotherMe binding")
	}
	eligible, err := sources.ListAgentConnectionAccess(t.Context(), "account_alice", "auth-active")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, agent := range eligible {
		if agent.AgentActorID == "actor_acme_official" && !agent.Granted {
			found = true
		}
	}
	if !found {
		t.Fatal("general Agent is absent from the grant picker")
	}

	assertGrant("auth-active", 0)
	if code, body := decide(message, "approve", "auth-wrong-app", "invalid-auth-wrong-app", 1); code != http.StatusForbidden {
		t.Fatalf("provider decision: %d %s", code, body)
	}
	if code, body := decide(message, "approve", "auth-active", "active-consent", 1); code != http.StatusOK {
		t.Fatalf("approve: %d %s", code, body)
	}
	// A decided card is not decided again.
	if code, body := decide(message, "approve", "auth-active", "active-consent", 1); code != http.StatusConflict || !containsJSONText(body, "CARD_CONFLICT") {
		t.Fatalf("repeated approve: %d %s", code, body)
	}
	assertState(message, "succeeded", 1)
	assertGrant("auth-active", 1)
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	connections, err := sources.ListGrantedAgentToolConnectionsInTx(t.Context(), tx, "actor_acme_official", acmeTenant, "auth-active", "notion")
	if err != nil || len(connections) != 1 {
		t.Fatalf("general Agent discovery: %+v %v", connections, err)
	}
	if _, err = sources.LockGrantedAgentToolConnectionInTx(t.Context(), tx, "actor_acme_official", acmeTenant, "auth-active"); err != nil {
		t.Fatal(err)
	}
	_ = tx.Rollback(t.Context())
	if _, err = sources.SetAgentConnectionAccess(t.Context(), "account_alice", "auth-active", "actor_acme_official", false); err != nil {
		t.Fatal(err)
	}
	tx, err = env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = sources.LockGrantedAgentToolConnectionInTx(t.Context(), tx, "actor_acme_official", acmeTenant, "auth-active"); err == nil {
		t.Fatal("revoked connection remained executable")
	}
	_ = tx.Rollback(t.Context())

	for _, outcome := range []string{"succeeded", "cancelled", "expired", "failed"} {
		t.Run(outcome, func(t *testing.T) {
			connection := "auth-pending-" + outcome
			insert(connection, "account_alice", "notion", "pending")
			pending := create(outcome)
			if code, body := decide(pending, "approve", connection, "consent-"+outcome, 1); code != http.StatusOK {
				t.Fatalf("pending consent: %d %s", code, body)
			}
			assertState(pending, "authorizing", 0)
			assertGrant(connection, 0)
			var bound string
			if err := env.pool.QueryRow(t.Context(), `SELECT answer->>'connection_id' FROM decisions WHERE id=$1`, pending.Card.DecisionID).Scan(&bound); err != nil || bound != connection {
				t.Fatalf("durable binding=%s err=%v", bound, err)
			}
			// New service instance represents recovery after the browser or API process exits.
			reconcile()
			assertState(pending, "authorizing", 0)
			expected := outcome
			grantCount := 0
			switch outcome {
			case "succeeded":
				grantCount = 1
			case "cancelled":
				expected = "denied"
				if code, body := decide(pending, "deny", "", "cancel-authorization", 2); code != http.StatusOK {
					t.Fatalf("cancel: %d %s", code, body)
				}
			case "expired":
				if _, err := env.pool.Exec(t.Context(), `UPDATE decisions SET expires_at=now()-interval '1 minute' WHERE id=$1`, pending.Card.DecisionID); err != nil {
					t.Fatal(err)
				}
			}
			connectionState := "active"
			if outcome == "failed" {
				connectionState = "failed"
			}
			if _, err := env.pool.Exec(t.Context(), `UPDATE external_connections SET status=$2 WHERE id=$1`, connection, connectionState); err != nil {
				t.Fatal(err)
			}
			var workers sync.WaitGroup
			failures := make(chan error, 2)
			for range 2 {
				workers.Add(1)
				go func() {
					defer workers.Done()
					err := newCards().ReconcileConnectionAuthorizations(t.Context())
					failures <- err
				}()
			}
			workers.Wait()
			close(failures)
			for err := range failures {
				if err != nil {
					t.Fatal(err)
				}
			}
			reconcile()
			assertState(pending, expected, 1)
			assertGrant(connection, grantCount)
		})
	}
	unanswered := create("unanswered-expiry")
	if _, err := env.pool.Exec(t.Context(), `UPDATE decisions SET expires_at=now()-interval '1 minute' WHERE id=$1`, unanswered.Card.DecisionID); err != nil {
		t.Fatal(err)
	}
	reconcile()
	assertState(unanswered, "expired", 1)
	// A card cannot manufacture a usable grant for an Agent outside this conversation.
	pending := create("membership-lost")
	insert("auth-membership", "account_alice", "notion", "pending")
	if code, body := decide(pending, "approve", "auth-membership", "membership-consent", 1); code != http.StatusOK {
		t.Fatalf("consent: %d %s", code, body)
	}
	if _, err := env.pool.Exec(t.Context(), `DELETE FROM room_members WHERE room_id=$1 AND actor_id='actor_acme_official'`, roomID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE external_connections SET status='active' WHERE id='auth-membership'`); err != nil {
		t.Fatal(err)
	}
	reconcile()
	assertState(pending, "failed", 1)
	assertGrant("auth-membership", 0)
}

func TestConnectionAuthorizationReusesCardPerAccountPostgreSQL(t *testing.T) {
	allowParallelIntegrationTest(t)
	composioFake := newFakeComposio(t)
	env, alice := newAgentRunEnvWithConfig(t, "http://127.0.0.1:1", composioFake.configure)
	roomID := createPrivateRoom(t, env, alice, "Connection authorization accounts", "connection-auth-accounts")
	if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); code != http.StatusOK {
		t.Fatalf("member: %d %s", code, body)
	}
	cards := typedcard.New(env.pool)
	cards.SetConnectionAuthorizer(composioFake.externalSources(t, env.pool, nil))
	create := func(key, account string) typedcard.CreateResult {
		t.Helper()
		hash := sha256.Sum256([]byte(key))
		result, err := cards.CreateDecision(t.Context(), roomID, acmeOfficialAgentManagementID, key, hash[:], typedcard.DecisionCommand{DeciderActorID: "actor_acme_alice",
			ConnectionAuth: &typedcard.ConnectionAuthDecision{Prompt: "Connect Notion", AppKey: "notion", Account: account, ReusePending: true}})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	work := create("account-work-1", "work@example.com")
	again := create("account-work-2", "work@example.com")
	if !again.Replay || again.DecisionID != work.DecisionID {
		t.Fatalf("same account must reuse its card: first=%+v again=%+v", work, again)
	}
	home := create("account-home", "home@example.com")
	if home.Replay || home.DecisionID == work.DecisionID {
		t.Fatalf("another account must get its own card: work=%+v home=%+v", work, home)
	}
	unnamed := create("account-none", "")
	if unnamed.Replay || unnamed.DecisionID == work.DecisionID || unnamed.DecisionID == home.DecisionID {
		t.Fatalf("a request without an account must not reuse a named card: %+v", unnamed)
	}
	var account string
	if err := env.pool.QueryRow(t.Context(), `SELECT view->>'account' FROM decisions WHERE id=$1`, work.DecisionID).Scan(&account); err != nil || account != "work@example.com" {
		t.Fatalf("stored account=%q err=%v", account, err)
	}
}

// Background scans must leave cards of deleting or deleted Rooms untouched and keep live Rooms working.
func TestConnectionAuthorizationSkipsDeletedRoomPostgreSQL(t *testing.T) {
	allowParallelIntegrationTest(t)
	composioFake := newFakeComposio(t)
	env, alice := newAgentRunEnvWithConfig(t, "http://127.0.0.1:1", composioFake.configure)
	sources := composioFake.externalSources(t, env.pool, nil)
	cards := typedcard.New(env.pool)
	cards.SetConnectionAuthorizer(sources)
	newRoom := func(t *testing.T, name, key string) string {
		t.Helper()
		roomID := createPrivateRoom(t, env, alice, name, key)
		if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); code != http.StatusOK {
			t.Fatalf("member: %d %s", code, body)
		}
		return roomID
	}
	create := func(t *testing.T, roomID, key string) decisionMessageResponse {
		t.Helper()
		hash := sha256.Sum256([]byte(key))
		result, err := cards.CreateDecision(t.Context(), roomID, acmeOfficialAgentManagementID, key, hash[:], typedcard.DecisionCommand{DeciderActorID: "actor_acme_alice", ConnectionAuth: &typedcard.ConnectionAuthDecision{Prompt: "Allow the Room Agent to use Notion", AppKey: "notion"}})
		if err != nil {
			t.Fatal(err)
		}
		var message decisionMessageResponse
		decode(t, result.Body, &message)
		return message
	}
	age := func(t *testing.T, message decisionMessageResponse) {
		t.Helper()
		if _, err := env.pool.Exec(t.Context(), `UPDATE decisions SET expires_at=now()-interval '1 minute' WHERE id=$1`, message.Card.DecisionID); err != nil {
			t.Fatal(err)
		}
	}
	setDeletion := func(t *testing.T, roomID string) {
		t.Helper()
		if _, err := env.pool.Exec(t.Context(), `UPDATE rooms SET deletion_started_at=now(),deletion_started_by_actor_id='actor_acme_alice' WHERE id=$1`, roomID); err != nil {
			t.Fatal(err)
		}
	}
	type cardSnapshot struct {
		status  string
		version int64
	}
	snapshot := func(t *testing.T, message decisionMessageResponse) cardSnapshot {
		t.Helper()
		var current cardSnapshot
		if err := env.pool.QueryRow(t.Context(), `SELECT d.status,c.version FROM decisions d JOIN message_cards c ON c.message_id=d.message_id WHERE d.id=$1`, message.Card.DecisionID).Scan(&current.status, &current.version); err != nil {
			t.Fatal(err)
		}
		return current
	}
	assertUntouched := func(t *testing.T, message decisionMessageResponse, before cardSnapshot) {
		t.Helper()
		if after := snapshot(t, message); after != before {
			t.Fatalf("card after scan=%+v want %+v", after, before)
		}
		if got := countRows(t, env, `SELECT count(*) FROM messages WHERE card_context_message_id=$1 AND message_kind='agent_runtime'`, message.ID); got != 0 {
			t.Fatalf("receipts=%d want 0", got)
		}
	}
	reconcileTwice := func(t *testing.T) {
		t.Helper()
		for range 2 {
			if err := cards.ReconcileConnectionAuthorizations(t.Context()); err != nil {
				t.Fatal(err)
			}
		}
	}

	t.Run("deleted Room", func(t *testing.T) {
		roomID := newRoom(t, "Deleted connection auth", "connection-auth-deleted-room")
		unauthorized := create(t, roomID, "deleted-unauthorized")
		age(t, unauthorized)
		if _, err := env.pool.Exec(t.Context(), `INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,toolkit_slug) VALUES('auth-deleted-room','account_alice','notion','auth-deleted-room','pending','notion')`); err != nil {
			t.Fatal(err)
		}
		authorizing := create(t, roomID, "deleted-authorizing")
		code, _, body := env.request(alice, http.MethodPost, "/v0/decisions/"+authorizing.Card.DecisionID, map[string]any{"expected_version": 1, "decision": "approve", "connection_id": "auth-deleted-room"}, "deleted-authorizing-consent")
		if code != http.StatusOK {
			t.Fatalf("consent: %d %s", code, body)
		}
		if _, err := env.pool.Exec(t.Context(), `UPDATE external_connections SET status='active' WHERE id='auth-deleted-room'`); err != nil {
			t.Fatal(err)
		}
		beforeUnauthorized := snapshot(t, unauthorized)
		beforeAuthorizing := snapshot(t, authorizing)
		if beforeUnauthorized.status != "pending" || beforeAuthorizing.status != "authorizing" {
			t.Fatalf("fixture states=%+v %+v", beforeUnauthorized, beforeAuthorizing)
		}
		code, _, body = env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID, nil, "delete-connection-auth-room")
		if code != http.StatusNoContent {
			t.Fatalf("delete: %d %s", code, body)
		}
		if got := countRows(t, env, `SELECT count(*) FROM rooms WHERE id=$1 AND deletion_started_at IS NOT NULL`, roomID); got != 1 {
			t.Fatalf("deletion_started_at set=%d want 1", got)
		}
		if code == http.StatusAccepted {
			// Finalize waits for Document Runtime fences; mark the tombstone directly.
			// deletion_started_at comes from the TeamHub clock, which may run ahead
			// of the database clock, so the tombstone never precedes it.
			if _, err := env.pool.Exec(t.Context(), `UPDATE rooms SET deleted_at=greatest(now(),deletion_started_at),deleted_by_actor_id=deletion_started_by_actor_id WHERE id=$1`, roomID); err != nil {
				t.Fatal(err)
			}
		}
		if got := countRows(t, env, `SELECT count(*) FROM rooms WHERE id=$1 AND deleted_at IS NOT NULL`, roomID); got != 1 {
			t.Fatalf("deleted_at set=%d want 1", got)
		}
		reconcileTwice(t)
		assertUntouched(t, unauthorized, beforeUnauthorized)
		assertUntouched(t, authorizing, beforeAuthorizing)
		if got := countRows(t, env, `SELECT count(*) FROM external_connection_agent_grants WHERE connection_id='auth-deleted-room' AND status='active'`); got != 0 {
			t.Fatalf("grants=%d want 0", got)
		}
	})

	t.Run("deleting Room", func(t *testing.T) {
		roomID := newRoom(t, "Deleting connection auth", "connection-auth-deleting-room")
		unauthorized := create(t, roomID, "deleting-unauthorized")
		age(t, unauthorized)
		before := snapshot(t, unauthorized)
		setDeletion(t, roomID)
		reconcileTwice(t)
		assertUntouched(t, unauthorized, before)
	})

	t.Run("Room deletion during scan", func(t *testing.T) {
		roomID := newRoom(t, "Racing connection auth", "connection-auth-race-room")
		unauthorized := create(t, roomID, "race-unauthorized")
		age(t, unauthorized)
		before := snapshot(t, unauthorized)
		lockKey := "room-membership|" + roomID
		holder, err := env.pool.Begin(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		defer holder.Rollback(t.Context())
		if _, err := holder.Exec(t.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, lockKey); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() {
			err := cards.ReconcileConnectionAuthorizations(t.Context())
			done <- err
		}()
		deadline := time.Now().Add(10 * time.Second)
		for countRows(t, env, `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted AND ((classid::bigint<<32)|objid::bigint)=hashtextextended($1, 0)`, lockKey) == 0 {
			if time.Now().After(deadline) {
				t.Fatal("scan did not wait for the Room membership lock")
			}
			time.Sleep(20 * time.Millisecond)
		}
		// Like the real deletion, mark the Room while holding its membership lock.
		if _, err := holder.Exec(t.Context(), `UPDATE rooms SET deletion_started_at=now(),deletion_started_by_actor_id='actor_acme_alice' WHERE id=$1`, roomID); err != nil {
			t.Fatal(err)
		}
		if err := holder.Commit(t.Context()); err != nil {
			t.Fatal(err)
		}
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(30 * time.Second):
			t.Fatal("scan did not finish after the deletion committed")
		}
		assertUntouched(t, unauthorized, before)
	})

	t.Run("live Room", func(t *testing.T) {
		roomID := newRoom(t, "Live connection auth", "connection-auth-live-room")
		unauthorized := create(t, roomID, "live-unauthorized")
		age(t, unauthorized)
		reconcileTwice(t)
		if got := snapshot(t, unauthorized).status; got != "expired" {
			t.Fatalf("live card status=%s want expired", got)
		}
		if got := countRows(t, env, `SELECT count(*) FROM messages WHERE card_context_message_id=$1 AND message_kind='agent_runtime'`, unauthorized.ID); got != 1 {
			t.Fatalf("receipts=%d want 1", got)
		}
	})
}

// Each card schedules its decision expiry, and a Connection that becomes active
// settles the cards waiting on it without the periodic sweep.
func TestConnectionAuthorizationCardJobsPostgreSQL(t *testing.T) {
	allowParallelIntegrationTest(t)
	composioFake := newFakeComposio(t)
	env, alice := newAgentRunEnvWithConfig(t, "http://127.0.0.1:1", composioFake.configure)
	roomID := createPrivateRoom(t, env, alice, "Connection authorization jobs", "connection-auth-jobs-room")
	if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); code != http.StatusOK {
		t.Fatalf("member: %d %s", code, body)
	}
	cards := typedcard.New(env.pool)
	cards.SetConnectionAuthorizer(composioFake.externalSources(t, env.pool, nil))
	create := func(key string) decisionMessageResponse {
		t.Helper()
		hash := sha256.Sum256([]byte(key))
		result, err := cards.CreateDecision(t.Context(), roomID, acmeOfficialAgentManagementID, key, hash[:], typedcard.DecisionCommand{DeciderActorID: "actor_acme_alice", ConnectionAuth: &typedcard.ConnectionAuthDecision{Prompt: "Allow the Room Agent to use Notion", AppKey: "notion"}})
		if err != nil {
			t.Fatal(err)
		}
		var message decisionMessageResponse
		decode(t, result.Body, &message)
		return message
	}
	status := func(message decisionMessageResponse) (current string) {
		t.Helper()
		if err := env.pool.QueryRow(t.Context(), `SELECT status FROM decisions WHERE id=$1`, message.Card.DecisionID).Scan(&current); err != nil {
			t.Fatal(err)
		}
		return current
	}

	waiting := create("expiry-job")
	var scheduledIn time.Duration
	if err := env.pool.QueryRow(t.Context(), `SELECT extract(epoch FROM scheduled_at-now())::bigint*1000000000 FROM river_job WHERE kind='decision.expire' AND args->>'decision_id'=$1`, waiting.Card.DecisionID).Scan(&scheduledIn); err != nil || scheduledIn < 29*time.Minute || scheduledIn > 30*time.Minute {
		t.Fatalf("expiry job scheduled in %s err=%v", scheduledIn, err)
	}
	// Before the deadline the job waits out the rest of it.
	if _, wait, err := cards.ExpireDecision(t.Context(), waiting.Card.DecisionID); err != nil || wait < 29*time.Minute || status(waiting) != "pending" {
		t.Fatalf("early expiry wait=%s status=%s err=%v", wait, status(waiting), err)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE decisions SET expires_at=now()-interval '1 minute' WHERE id=$1`, waiting.Card.DecisionID); err != nil {
		t.Fatal(err)
	}
	if expired, wait, err := cards.ExpireDecision(t.Context(), waiting.Card.DecisionID); err != nil || !expired || wait != 0 || status(waiting) != "expired" {
		t.Fatalf("due expiry wait=%s status=%s err=%v", wait, status(waiting), err)
	}
	receipts := func(message decisionMessageResponse) int {
		return countRows(t, env, `SELECT count(*) FROM messages WHERE card_context_message_id=$1 AND message_kind='agent_runtime'`, message.ID)
	}
	if got := receipts(waiting); got != 1 {
		t.Fatalf("expiry receipts=%d want 1", got)
	}
	// The sweep expiring a card first leaves its expiry job nothing to tell.
	swept := create("expiry-swept")
	if _, err := env.pool.Exec(t.Context(), `UPDATE decisions SET expires_at=now()-interval '1 minute' WHERE id=$1`, swept.Card.DecisionID); err != nil {
		t.Fatal(err)
	}
	if err := cards.ReconcileConnectionAuthorizations(t.Context()); err != nil || status(swept) != "expired" {
		t.Fatalf("swept status=%s err=%v", status(swept), err)
	}
	if expired, _, err := cards.ExpireDecision(t.Context(), swept.Card.DecisionID); err != nil || expired || receipts(swept) != 1 {
		t.Fatalf("expiry job after the sweep expired=%t receipts=%d err=%v", expired, receipts(swept), err)
	}

	if _, err := env.pool.Exec(t.Context(), `INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,toolkit_slug) VALUES('auth-settle','account_alice','notion','auth-settle','pending','notion')`); err != nil {
		t.Fatal(err)
	}
	authorizing := create("settle-job")
	if code, _, body := env.request(alice, http.MethodPost, "/v0/decisions/"+authorizing.Card.DecisionID, map[string]any{"expected_version": 1, "decision": "approve", "connection_id": "auth-settle"}, "settle-consent"); code != http.StatusOK {
		t.Fatalf("consent: %d %s", code, body)
	}
	// A pending Connection leaves the card waiting.
	if err := cards.SettleConnectionAuthorizations(t.Context(), "auth-settle"); err != nil || status(authorizing) != "authorizing" {
		t.Fatalf("pending settle status=%s err=%v", status(authorizing), err)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE external_connections SET status='active' WHERE id='auth-settle'`); err != nil {
		t.Fatal(err)
	}
	if err := cards.SettleConnectionAuthorizations(t.Context(), "auth-settle"); err != nil || status(authorizing) != "succeeded" {
		t.Fatalf("active settle status=%s err=%v", status(authorizing), err)
	}
	if got := countRows(t, env, `SELECT count(*) FROM external_connection_agent_grants WHERE connection_id='auth-settle' AND agent_actor_id='actor_acme_official' AND status='active'`); got != 1 {
		t.Fatalf("grants=%d want 1", got)
	}
}

func TestConnectionAuthorizationSettlesSupersededDuplicateRecoveryPostgreSQL(t *testing.T) {
	allowParallelIntegrationTest(t)

	t.Run("immediate settlement via duplicate recovery job", func(t *testing.T) {
		databaseURL := newIntegrationDatabase(t)
		pool, err := pgxpool.New(t.Context(), databaseURL)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(pool.Close)
		releaseCandidate := make(chan struct{})
		provider := &fakeGmailProvider{
			identityEmail: "alice@example.test",
			identityWait: map[string]chan struct{}{
				"ca_link_2": releaseCandidate,
			},
		}
		composioFake := newFakeComposio(t)
		cfg := config.ForTest(func(c *config.Config) {
			c.DatabaseURL = databaseURL
			c.SessionTTL = time.Hour
			c.CookieName = "teamhub_session"
			c.ArtifactStorageRoot = t.TempDir()
			c.ArtifactMaxBytes = 2 << 20
		})
		composioFake.configure(&cfg)
		application, err := newTestApp(t.Context(), cfg, skipping(app.SkillInstall), skipping(app.SkillPackageProbe),
			withComposio(provider), starting(app.JobQueue))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(application.Close)
		server := httptest.NewServer(application.Handler())
		registerIntegrationServerCleanup(t, server)
		env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
		alice := env.login("alice", alicePassword)

		// Create canonical Gmail connection connOld (ca_link_1), then mark it failed.
		status, _, body := env.request(alice, http.MethodPost, "/v0/external-connections", map[string]any{"app_key": "gmail"}, "dup-settle-old")
		if status != http.StatusCreated {
			t.Fatalf("create old connection status=%d body=%s", status, body)
		}
		var connOld struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		}
		decode(t, body, &connOld)
		completeAuthorizations(t, env, alice)
		if !waitForExternalSource(func() bool {
			status, _, body = env.request(alice, http.MethodGet, "/v0/external-connections/"+connOld.ID, nil, "")
			if status == http.StatusOK {
				decode(t, body, &connOld)
			}
			return status == http.StatusOK && connOld.Status == "active"
		}) {
			t.Fatalf("connOld not active: %s", body)
		}
		if _, err := pool.Exec(t.Context(), `UPDATE external_connections SET status='failed',status_error_code='provider_auth_failed',next_status_check_at=now()+interval '1 hour' WHERE id=$1`, connOld.ID); err != nil {
			t.Fatal(err)
		}

		// Create Room and connection_auth card for gmail.
		roomID := createPrivateRoom(t, env, alice, "Duplicate recovery settle", "dup-recovery-room")
		if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); code != http.StatusOK {
			t.Fatalf("member: %d %s", code, body)
		}
		cards := typedcard.New(pool)
		cards.SetConnectionAuthorizer(composioFake.externalSources(t, pool, provider))
		hash := sha256.Sum256([]byte("dup-recovery-card"))
		created, err := cards.CreateDecision(t.Context(), roomID, acmeOfficialAgentManagementID, "dup-recovery-card", hash[:], typedcard.DecisionCommand{
			DeciderActorID: "actor_acme_alice",
			ConnectionAuth: &typedcard.ConnectionAuthDecision{Prompt: "Connect Gmail for the Room Agent", AppKey: "gmail"},
		})
		if err != nil {
			t.Fatal(err)
		}
		var cardMsg decisionMessageResponse
		decode(t, created.Body, &cardMsg)

		// Create a fresh pending candidate connNew (ca_link_2) and approve the card against connNew.
		status, _, body = env.request(alice, http.MethodPost, "/v0/external-connections", map[string]any{"app_key": "gmail"}, "dup-settle-new")
		if status != http.StatusCreated {
			t.Fatalf("create new connection status=%d body=%s", status, body)
		}
		var connNew struct {
			ID string `json:"id"`
		}
		decode(t, body, &connNew)
		status, _, body = env.request(alice, http.MethodPost, "/v0/decisions/"+cardMsg.Card.DecisionID,
			map[string]any{"expected_version": 1, "decision": "approve", "connection_id": connNew.ID}, "dup-settle-approve")
		if status != http.StatusOK {
			t.Fatalf("approve card status=%d body=%s", status, body)
		}

		// Complete OAuth for connNew with the same principal so reconcileDuplicateConnection recovers connOld.
		close(releaseCandidate)
		completeAuthorizations(t, env, alice)

		var decisionStatus, boundConnectionID string
		if !waitForExternalSource(func() bool {
			err := pool.QueryRow(t.Context(), `SELECT status, coalesce(answer->>'connection_id','') FROM decisions WHERE id=$1`, cardMsg.Card.DecisionID).Scan(&decisionStatus, &boundConnectionID)
			return err == nil && decisionStatus == "succeeded"
		}) {
			t.Fatalf("decision did not settle as succeeded: status=%q bound=%q", decisionStatus, boundConnectionID)
		}
		if boundConnectionID != connOld.ID {
			t.Fatalf("answer.connection_id=%q want canonical %q", boundConnectionID, connOld.ID)
		}
		var candidateStatus, candidateError, candidatePrincipal string
		if err := pool.QueryRow(t.Context(), `SELECT status, coalesce(status_error_code,''), coalesce(remote_principal_key,'') FROM external_connections WHERE id=$1`, connNew.ID).Scan(&candidateStatus, &candidateError, &candidatePrincipal); err != nil {
			t.Fatal(err)
		}
		if candidateStatus != "revoked" || candidateError != "duplicate_remote_principal" || candidatePrincipal != "gmail:alice@example.test" {
			t.Fatalf("candidate=(%q,%q,%q) want revoked/duplicate_remote_principal/gmail:alice@example.test", candidateStatus, candidateError, candidatePrincipal)
		}
		if got := countRows(t, env, `SELECT count(*) FROM external_connection_agent_grants WHERE connection_id=$1 AND agent_actor_id='actor_acme_official' AND status='active'`, connOld.ID); got != 1 {
			t.Fatalf("canonical grants=%d want 1", got)
		}
		if got := countRows(t, env, `SELECT count(*) FROM external_connection_agent_grants WHERE connection_id=$1 AND agent_actor_id='actor_acme_official' AND status='active'`, connNew.ID); got != 0 {
			t.Fatalf("candidate grants=%d want 0", got)
		}
		var handoffText string
		if err := pool.QueryRow(t.Context(), `SELECT body FROM messages WHERE card_context_message_id=$1 AND message_kind='agent_runtime'`, cardMsg.ID).Scan(&handoffText); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(handoffText, `"connection_id":"`+connOld.ID+`"`) || strings.Contains(handoffText, connNew.ID) {
			t.Fatalf("handoff=%q want canonical %q and not candidate %q", handoffText, connOld.ID, connNew.ID)
		}
	})

	t.Run("sweep settlement and revoked canonical handling", func(t *testing.T) {
		composioFake := newFakeComposio(t)
		env, alice := newAgentRunEnvWithConfig(t, "http://127.0.0.1:1", composioFake.configure)
		roomID := createPrivateRoom(t, env, alice, "Duplicate recovery sweep", "dup-recovery-sweep-room")
		if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); code != http.StatusOK {
			t.Fatalf("member: %d %s", code, body)
		}
		cards := typedcard.New(env.pool)
		cards.SetConnectionAuthorizer(composioFake.externalSources(t, env.pool, nil))
		createCard := func(key string) decisionMessageResponse {
			t.Helper()
			hash := sha256.Sum256([]byte(key))
			result, err := cards.CreateDecision(t.Context(), roomID, acmeOfficialAgentManagementID, key, hash[:], typedcard.DecisionCommand{
				DeciderActorID: "actor_acme_alice",
				ConnectionAuth: &typedcard.ConnectionAuthDecision{Prompt: "Allow the Room Agent to use Gmail", AppKey: "gmail"},
			})
			if err != nil {
				t.Fatal(err)
			}
			var message decisionMessageResponse
			decode(t, result.Body, &message)
			return message
		}

		// Case 1: periodic sweep settles authorizing card bound to a superseded candidate as succeeded.
		if _, err := env.pool.Exec(t.Context(), `INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,toolkit_slug,remote_principal_key) VALUES('conn_old_sweep','account_alice','gmail','up_old_sweep','failed','gmail','gmail:sweep@example.test')`); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(t.Context(), `INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,toolkit_slug) VALUES('conn_new_sweep','account_alice','gmail','up_new_sweep','pending','gmail')`); err != nil {
			t.Fatal(err)
		}
		sweepCard := createCard("sweep-recovery")
		if code, _, body := env.request(alice, http.MethodPost, "/v0/decisions/"+sweepCard.Card.DecisionID,
			map[string]any{"expected_version": 1, "decision": "approve", "connection_id": "conn_new_sweep"}, "sweep-approve"); code != http.StatusOK {
			t.Fatalf("approve: %d %s", code, body)
		}
		if _, err := env.pool.Exec(t.Context(), `UPDATE external_connections SET status='revoked',status_error_code='duplicate_remote_principal',remote_principal_key='gmail:sweep@example.test' WHERE id='conn_new_sweep'`); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(t.Context(), `UPDATE external_connections SET status='active' WHERE id='conn_old_sweep'`); err != nil {
			t.Fatal(err)
		}
		if err := cards.ReconcileConnectionAuthorizations(t.Context()); err != nil {
			t.Fatal(err)
		}
		var sweepStatus, sweepBound string
		if err := env.pool.QueryRow(t.Context(), `SELECT status, coalesce(answer->>'connection_id','') FROM decisions WHERE id=$1`, sweepCard.Card.DecisionID).Scan(&sweepStatus, &sweepBound); err != nil {
			t.Fatal(err)
		}
		if sweepStatus != "succeeded" || sweepBound != "conn_old_sweep" {
			t.Fatalf("sweep decision=(%q,%q) want succeeded/conn_old_sweep", sweepStatus, sweepBound)
		}
		if got := countRows(t, env, `SELECT count(*) FROM external_connection_agent_grants WHERE connection_id='conn_old_sweep' AND agent_actor_id='actor_acme_official' AND status='active'`); got != 1 {
			t.Fatalf("sweep canonical grants=%d want 1", got)
		}
		var sweepHandoff string
		if err := env.pool.QueryRow(t.Context(), `SELECT body FROM messages WHERE card_context_message_id=$1 AND message_kind='agent_runtime'`, sweepCard.ID).Scan(&sweepHandoff); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(sweepHandoff, `"connection_id":"conn_old_sweep"`) {
			t.Fatalf("sweep handoff=%q want conn_old_sweep", sweepHandoff)
		}

		// Case 2: if canonical conn_old was subsequently disconnected (revoked), a card waiting on conn_new settles as failed.
		if _, err := env.pool.Exec(t.Context(), `INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,toolkit_slug,remote_principal_key) VALUES('conn_old_revoked','account_alice','gmail','up_old_revoked','failed','gmail','gmail:revoked@example.test')`); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(t.Context(), `INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,toolkit_slug) VALUES('conn_new_revoked','account_alice','gmail','up_new_revoked','pending','gmail')`); err != nil {
			t.Fatal(err)
		}
		revokedCard := createCard("revoked-canonical")
		if code, _, body := env.request(alice, http.MethodPost, "/v0/decisions/"+revokedCard.Card.DecisionID,
			map[string]any{"expected_version": 1, "decision": "approve", "connection_id": "conn_new_revoked"}, "revoked-approve"); code != http.StatusOK {
			t.Fatalf("approve: %d %s", code, body)
		}
		if _, err := env.pool.Exec(t.Context(), `UPDATE external_connections SET status='revoked',status_error_code='duplicate_remote_principal',remote_principal_key='gmail:revoked@example.test' WHERE id='conn_new_revoked'`); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(t.Context(), `UPDATE external_connections SET status='revoked' WHERE id='conn_old_revoked'`); err != nil {
			t.Fatal(err)
		}
		if err := cards.SettleConnectionAuthorizations(t.Context(), "conn_new_revoked"); err != nil {
			t.Fatal(err)
		}
		var revokedStatus, revokedBound string
		if err := env.pool.QueryRow(t.Context(), `SELECT status, coalesce(answer->>'connection_id','') FROM decisions WHERE id=$1`, revokedCard.Card.DecisionID).Scan(&revokedStatus, &revokedBound); err != nil {
			t.Fatal(err)
		}
		if revokedStatus != "failed" || revokedBound != "conn_new_revoked" {
			t.Fatalf("revoked canonical decision=(%q,%q) want failed/conn_new_revoked", revokedStatus, revokedBound)
		}
		if got := countRows(t, env, `SELECT count(*) FROM external_connection_agent_grants WHERE connection_id IN ('conn_old_revoked','conn_new_revoked') AND status='active'`); got != 0 {
			t.Fatalf("revoked canonical grants=%d want 0", got)
		}
	})
}
