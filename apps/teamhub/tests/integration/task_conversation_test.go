package integration_test

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskexecution"
)

func TestTaskConversationShowsOnlyItsAgentsInputs(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	suffix := "task-conversation-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Task conversation "+suffix, "task-conversation-room-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Task participant status=%d body=%s", status, body)
	}
	task := createManagedTaskFixture(t, env, roomID, suffix)
	const peer = "actor_acme_conversation_peer"
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO actors(id,tenant_id,kind,display_name,handle)
		VALUES($1,$2,'agent','Peer','conversation-peer')`, peer, acmeTenant); err != nil {
		t.Fatal(err)
	}

	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	queries := store.New(tx)
	if _, err := taskexecution.AppendTaskInput(t.Context(), queries, taskexecution.TaskInput{
		TaskID: task.ID, Cause: taskexecution.TaskInputSystem, Body: "The card was approved.",
	}); err != nil {
		t.Fatalf("append system input: %v", err)
	}
	// Another participant's inbox holds its own copies; they are not the Task's.
	if _, err := taskexecution.AppendParticipantMetaWakes(
		t.Context(), queries, task.ID, acmeTenant, "actor_acme_alice", taskexecution.InputSourceMessage,
		[]string{peer}, taskexecution.TurnMessageInput{
			MessageID: "peer-message-" + suffix, RawMessage: "Only the peer received this.",
			Segments: json.RawMessage(`[{"type":"text","content":"Only the peer received this."}]`),
			Author:   &taskexecution.TurnMessageAuthor{ActorID: "actor_acme_alice", Kind: "human", DisplayName: "Alice"},
		},
	); err != nil {
		t.Fatalf("append peer input: %v", err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}

	status, _, body := env.request(alice, http.MethodGet, "/v0/tasks/"+task.ID+"/conversation", nil, "")
	if status != http.StatusOK {
		t.Fatalf("read conversation status=%d body=%s", status, body)
	}
	var conversation struct {
		Inputs []struct {
			Body   string `json:"body"`
			Source string `json:"source"`
		} `json:"inputs"`
		Cards []json.RawMessage `json:"cards"`
	}
	decode(t, body, &conversation)
	if len(conversation.Inputs) != 2 ||
		conversation.Inputs[0].Body != "Return a summary." || conversation.Inputs[0].Source != "message" ||
		conversation.Inputs[1].Body != "The card was approved." || conversation.Inputs[1].Source != "system" ||
		conversation.Cards == nil || len(conversation.Cards) != 0 {
		t.Fatalf("conversation=%s", body)
	}

	// Any Human in the Task's tenant reads it, Room membership or not; a Human
	// of another tenant does not learn the Task exists.
	bob := seedPeerHuman(t, env)
	if status, _, body := env.request(bob, http.MethodGet, "/v0/tasks/"+task.ID+"/conversation", nil, ""); status != http.StatusOK {
		t.Fatalf("a Human of the tenant outside the Room status=%d body=%s", status, body)
	}
	outsider := seedOtherTenantHuman(t, env)
	if status, _, body := env.request(outsider, http.MethodGet, "/v0/tasks/"+task.ID+"/conversation", nil, ""); status != http.StatusNotFound {
		t.Fatalf("a Human of another tenant status=%d body=%s", status, body)
	}
	if status, _, body := env.request(alice, http.MethodGet, "/v0/tasks/workitem_missing/conversation", nil, ""); status != http.StatusNotFound {
		t.Fatalf("missing Task status=%d body=%s", status, body)
	}
}

// seedOtherTenantHuman signs in a Human whose only tenant is not acme.
func seedOtherTenantHuman(t *testing.T, env *testEnv) *http.Client {
	t.Helper()
	const email, password = "carol@example.com", "teamhub-dev-carol"
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO accounts(id,email,password_hash) VALUES('account_carol',$1,$2)`,
		email, lowCostIntegrationPasswordHash(email, password)); err != nil {
		t.Fatalf("seed other tenant account: %v", err)
	}
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO actors(id,tenant_id,kind,display_name,account_id)
		VALUES('actor_other_carol','tenant_conversation_other','human','carol','account_carol')`); err != nil {
		t.Fatalf("seed other tenant Human: %v", err)
	}
	return env.login(email, password)
}
