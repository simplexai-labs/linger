package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

func TestAgentRuntimeStateHTTPContractAndRecoveryChain(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatalf("open Agent Runtime State HTTP database: %v", err)
	}
	t.Cleanup(pool.Close)
	seedReadyFixtureComputers(t, pool)
	application, err := newTestApp(context.Background(), config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
		c.ArtifactStorageRoot = t.TempDir()
		c.ArtifactMaxBytes = 1 << 20
	}), skipping(app.SkillInstall), skipping(app.SkillPackageProbe),
		skipping(app.RoomDocumentJobs), skipping(app.AgentCredentialSweep), skipping(app.PersonalWikiJobs))
	if err != nil {
		t.Fatalf("start TeamHub for Agent Runtime State HTTP test: %v", err)
	}
	t.Cleanup(application.Close)

	handler := application.Handler()
	status, body := agentRuntimeStateRequest(t, handler, http.MethodGet,
		"/v0/agent-runtime/config?agent_id="+testRuntimeAgentID, teamHubInternalToken, nil)
	if status != http.StatusOK {
		t.Fatalf("get Runtime configuration status=%d body=%s", status, body)
	}
	var configSnapshot struct {
		AgentID               string `json:"agent_id"`
		ActorID               string `json:"actor_id"`
		TenantID              string `json:"tenant_id"`
		ConfigurationRevision string `json:"configuration_revision"`
		ContentHash           string `json:"content_hash"`
		Agent                 struct {
			Name         string `json:"name"`
			Instructions string `json:"instructions"`
		} `json:"agent"`
		Runtime struct {
			Type  string `json:"type"`
			Model string `json:"model"`
		} `json:"runtime"`
	}
	decode(t, body, &configSnapshot)
	if configSnapshot.AgentID != testRuntimeAgentID || configSnapshot.ActorID != "actor_acme_official" ||
		configSnapshot.TenantID != "tenant_acme" || configSnapshot.ConfigurationRevision != "1" ||
		configSnapshot.ContentHash == "" || configSnapshot.Agent.Name != "@official" ||
		configSnapshot.Runtime.Type != "local" || configSnapshot.Runtime.Model != "gpt-5" {
		t.Fatalf("unexpected Runtime configuration snapshot: %+v", configSnapshot)
	}
	status, replayBody := agentRuntimeStateRequest(t, handler, http.MethodGet,
		"/v0/agent-runtime/config?agent_id="+testRuntimeAgentID+"&revision=1", teamHubInternalToken, nil)
	if status != http.StatusOK || !bytes.Equal(body, replayBody) {
		t.Fatalf("Runtime configuration revision read status=%d body=%s first=%s", status, replayBody, body)
	}
	if _, err := pool.Exec(t.Context(), "UPDATE agent_registrations SET status='revoked' WHERE agent_management_id=$1", testRuntimeAgentID); err != nil {
		t.Fatal(err)
	}
	code, payload := agentRuntimeStateRequest(t, handler, http.MethodGet,
		"/v0/agent-runtime/config?agent_id="+testRuntimeAgentID, teamHubInternalToken, nil)
	assertAgentRuntimeHTTPError(t, code, payload, http.StatusNotFound, "NOT_FOUND")
	if _, err := pool.Exec(t.Context(), "UPDATE agent_registrations SET status='active' WHERE agent_management_id=$1", testRuntimeAgentID); err != nil {
		t.Fatal(err)
	}
	status, body = agentRuntimeStateRequest(t, handler, http.MethodGet,
		"/v0/agent-runtime/config?agent_id="+testRuntimeAgentID+"&revision=2", teamHubInternalToken, nil)
	assertAgentRuntimeHTTPError(t, status, body, http.StatusConflict, "AGENT_RUNTIME_CONFLICT")
	status, body = agentRuntimeStateRequest(t, handler, http.MethodGet,
		"/v0/agent-runtime/config?agent_id=missing-runtime-agent", teamHubInternalToken, nil)
	assertAgentRuntimeHTTPError(t, status, body, http.StatusNotFound, "NOT_FOUND")

	status, _ = agentRuntimeStateRequest(t, handler, http.MethodGet,
		"/v0/agent-runtime/contexts?agent_id="+testRuntimeAgentID, "", nil)
	if status != http.StatusUnauthorized {
		t.Fatalf("missing service bearer status=%d, want 401", status)
	}
	insertRuntimeRoomMembership(t, pool, "http-runtime")

	status, body = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/contexts", teamHubInternalToken, map[string]any{
		"target_residency": "active",
		"ref":              map[string]any{"kind": "meta", "agent_id": testRuntimeAgentID},
	})
	assertAgentRuntimeHTTPError(t, status, body, http.StatusBadRequest, "INVALID_REQUEST")
	ensureRequest := map[string]any{
		"target_residency": "active",
		"ref":              map[string]any{"kind": "meta", "agent_id": testRuntimeAgentID, "room_id": "http-runtime"},
	}
	status, body = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/contexts", teamHubInternalToken, ensureRequest)
	if status != http.StatusOK {
		t.Fatalf("ensure Context status=%d body=%s", status, body)
	}
	var ensured struct {
		Created bool `json:"created"`
		Context struct {
			ContextKey    string `json:"context_key"`
			StateRevision string `json:"state_revision"`
		} `json:"context"`
	}
	decode(t, body, &ensured)
	if !ensured.Created || ensured.Context.ContextKey == "" || ensured.Context.StateRevision != "1" {
		t.Fatalf("unexpected ensured Context: %+v", ensured)
	}
	contextKey := ensured.Context.ContextKey

	status, replayBody = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/contexts", teamHubInternalToken, ensureRequest)
	var replayed struct {
		Created bool `json:"created"`
		Context struct {
			ContextKey string `json:"context_key"`
		} `json:"context"`
	}
	decode(t, replayBody, &replayed)
	if status != http.StatusOK || replayed.Created || replayed.Context.ContextKey != contextKey {
		t.Fatalf("repeated ensure status=%d body=%s", status, replayBody)
	}

	status, body = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/epochs", teamHubInternalToken, map[string]any{
		"epoch": "http-runtime-epoch",
	})
	if status != http.StatusOK {
		t.Fatalf("start epoch status=%d body=%s", status, body)
	}
	const epoch = "http-runtime-epoch"

	status, body = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/trusted-turns", teamHubInternalToken, map[string]any{
		"command_id": "http-retired-command", "context_key": contextKey, "epoch": epoch,
		"inputs": []any{runtimeHTTPInput("http-retired-command-input", "invalid")},
	})
	assertAgentRuntimeHTTPError(t, status, body, http.StatusBadRequest, "INVALID_REQUEST")

	turnRequest := map[string]any{
		"context_key": contextKey, "epoch": epoch,
		"inputs": []any{runtimeHTTPInput("http-runtime-input", "first")},
	}
	var submitted teamhubinternal.SubmitAgentTrustedTurnResult
	status, body = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/trusted-turns", teamHubInternalToken, turnRequest)
	if status != http.StatusOK {
		t.Fatalf("submit trusted turn status=%d body=%s", status, body)
	}
	decode(t, body, &submitted)
	if submitted.RunId == "" || submitted.Created == nil || !*submitted.Created ||
		submitted.Context == nil || submitted.Context.TargetResidency != "active" {
		t.Fatalf("submitted trusted turn did not create a Run in an active Context: %s", body)
	}
	status, replayBody = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/trusted-turns", teamHubInternalToken, turnRequest)
	var repeated teamhubinternal.SubmitAgentTrustedTurnResult
	decode(t, replayBody, &repeated)
	if status != http.StatusOK || repeated.RunId != submitted.RunId || repeated.Created == nil || *repeated.Created {
		t.Fatalf("repeated trusted turn status=%d body=%s first=%s", status, replayBody, body)
	}

	status, body = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/runs/claim", teamHubInternalToken, map[string]any{
		"context_key": contextKey, "epoch": epoch, "claim_id": "http-claim-local-run",
	})
	if status != http.StatusOK {
		t.Fatalf("claim Local Run status=%d body=%s", status, body)
	}
	var runClaim struct {
		Claimed bool `json:"claimed"`
		Run     struct {
			RunID string `json:"run_id"`
		} `json:"run"`
	}
	decode(t, body, &runClaim)
	if !runClaim.Claimed || runClaim.Run.RunID != submitted.RunId {
		t.Fatalf("unexpected Local Run claim: %+v", runClaim)
	}

	configurationRevision := activeRuntimeConfigurationRevision(t, pool)
	checkpoint := runtimeHTTPSessionCheckpoint("0", configurationRevision, "http-thread-one")
	status, body = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/sessions/checkpoint", teamHubInternalToken, map[string]any{
		"context_key": contextKey, "epoch": epoch, "checkpoint": checkpoint,
	})
	if status != http.StatusOK {
		t.Fatalf("checkpoint RuntimeSession status=%d body=%s", status, body)
	}
	assertRuntimeHTTPSession(t, body, "1", "http-thread-one", "9007199254740993")

	status, body = agentRuntimeStateRequest(t, handler, http.MethodGet,
		"/v0/agent-runtime/session?context_key="+url.QueryEscape(contextKey), teamHubInternalToken, nil)
	if status != http.StatusOK {
		t.Fatalf("get RuntimeSession status=%d body=%s", status, body)
	}
	var sessionRead struct {
		Available bool            `json:"available"`
		Session   json.RawMessage `json:"session"`
	}
	decode(t, body, &sessionRead)
	if !sessionRead.Available {
		t.Fatalf("RuntimeSession unavailable after checkpoint: %s", body)
	}
	assertRuntimeHTTPSession(t, sessionRead.Session, "1", "http-thread-one", "9007199254740993")

	checkpoint = runtimeHTTPSessionCheckpoint("1", configurationRevision, "http-thread-two")
	status, body = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/runs/finish", teamHubInternalToken, map[string]any{
		"context_key": contextKey, "epoch": epoch, "run_id": submitted.RunId,
		"terminal": map[string]any{"type": "succeeded"}, "session": checkpoint,
	})
	if status != http.StatusOK {
		t.Fatalf("finish Local Run with Session status=%d body=%s", status, body)
	}
	var finished struct {
		Run struct {
			Status string `json:"status"`
		} `json:"run"`
		Session json.RawMessage `json:"session"`
	}
	decode(t, body, &finished)
	if finished.Run.Status != "succeeded" {
		t.Fatalf("finished Local Run status=%q body=%s", finished.Run.Status, body)
	}
	assertRuntimeHTTPSession(t, finished.Session, "2", "http-thread-two", "9007199254740993")

	// The fallback scan lists no Context once its only Run finished.
	status, body = agentRuntimeStateRequest(t, handler, http.MethodGet, "/v0/agent-runtime/runs/waiting", teamHubInternalToken, nil)
	if status != http.StatusOK {
		t.Fatalf("list waiting Contexts status=%d body=%s", status, body)
	}
	var waiting struct {
		ContextKeys []string `json:"context_keys"`
	}
	decode(t, body, &waiting)
	if slices.Contains(waiting.ContextKeys, contextKey) {
		t.Fatalf("finished Context still waits: %s", body)
	}

	status, body = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/trusted-turns", teamHubInternalToken, map[string]any{
		"context_key": contextKey, "epoch": "http-runtime-epoch-previous",
		"inputs": []any{runtimeHTTPInput("http-fenced-input", "fenced")},
	})
	assertAgentRuntimeHTTPError(t, status, body, http.StatusConflict, "CONTEXT_FENCED")
}

func TestAgentLocalRunReplyStatus(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatalf("open Agent Local Run reply status database: %v", err)
	}
	t.Cleanup(pool.Close)
	seedReadyFixtureComputers(t, pool)
	application, err := newTestApp(context.Background(), config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
		c.ArtifactStorageRoot = t.TempDir()
		c.ArtifactMaxBytes = 1 << 20
	}), skipping(app.SkillInstall), skipping(app.SkillPackageProbe),
		skipping(app.RoomDocumentJobs), skipping(app.AgentCredentialSweep), skipping(app.PersonalWikiJobs))
	if err != nil {
		t.Fatalf("start TeamHub for reply status test: %v", err)
	}
	t.Cleanup(application.Close)

	const (
		roomID   = "http-reply-status-room"
		threadID = "http-reply-status-thread"
		epoch    = "http-reply-status-epoch"
	)
	insertRuntimeRoomMembership(t, pool, roomID)
	insertRuntimeRoomMembershipForAgent(t, pool, threadID, "actor_acme_alice")
	for _, stmt := range []string{
		`INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments)
		 VALUES('reply-status-root','tenant_acme','http-reply-status-room','actor_acme_alice','Root','[{"type":"text","content":"Root"}]')`,
		`UPDATE rooms SET parent_room_id='http-reply-status-room',root_message_id='reply-status-root'
		 WHERE id='http-reply-status-thread' AND tenant_id='tenant_acme'`,
		`INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments)
		 VALUES('reply-status-thread-msg','tenant_acme','http-reply-status-thread','actor_acme_alice','In thread','[{"type":"text","content":"In thread"}]')`,
	} {
		if _, err := pool.Exec(t.Context(), stmt); err != nil {
			t.Fatalf("seed reply status Room and Thread: %v", err)
		}
	}

	handler := application.Handler()
	status, body := agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/contexts", teamHubInternalToken, map[string]any{
		"target_residency": "active",
		"ref":              map[string]any{"kind": "meta", "agent_id": testRuntimeAgentID, "room_id": roomID},
	})
	if status != http.StatusOK {
		t.Fatalf("ensure Context status=%d body=%s", status, body)
	}
	var ensured struct {
		Context struct {
			ContextKey string `json:"context_key"`
		} `json:"context"`
	}
	decode(t, body, &ensured)
	contextKey := ensured.Context.ContextKey

	status, body = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/epochs", teamHubInternalToken, map[string]any{
		"epoch": epoch,
	})
	if status != http.StatusOK {
		t.Fatalf("start epoch status=%d body=%s", status, body)
	}

	queryReplyStatus := func(runID string) (int, []byte) {
		t.Helper()
		path := "/v0/agent-runtime/runs/reply-status?context_key=" + url.QueryEscape(contextKey) + "&local_run_id=" + url.QueryEscape(runID)
		return agentRuntimeStateRequest(t, handler, http.MethodGet, path, teamHubInternalToken, nil)
	}
	// inboxes are the Inboxes where the reply landed, in order.
	assertReplied := func(runID string, want bool, inboxes ...string) {
		t.Helper()
		code, raw := queryReplyStatus(runID)
		if code != http.StatusOK {
			t.Fatalf("reply status for %s status=%d body=%s", runID, code, raw)
		}
		var result teamhubinternal.AgentLocalRunReplyStatus
		decode(t, raw, &result)
		if result.Replied != want {
			t.Fatalf("reply status for %s replied=%v, want %v", runID, result.Replied, want)
		}
		if result.RepliedInboxIds == nil || !slices.Equal(*result.RepliedInboxIds, append([]string{}, inboxes...)) {
			t.Fatalf("reply status for %s inboxes=%s, want %v", runID, raw, inboxes)
		}
	}
	startRun := func(inputID string) string {
		t.Helper()
		code, raw := agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/trusted-turns", teamHubInternalToken, map[string]any{
			"context_key": contextKey, "epoch": epoch,
			"inputs": []any{runtimeHTTPInput(inputID, "question")},
		})
		if code != http.StatusOK {
			t.Fatalf("submit turn %s status=%d body=%s", inputID, code, raw)
		}
		var submitted teamhubinternal.SubmitAgentTrustedTurnResult
		decode(t, raw, &submitted)
		code, raw = agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/runs/claim", teamHubInternalToken, map[string]any{
			"context_key": contextKey, "epoch": epoch, "claim_id": "claim-" + inputID,
		})
		if code != http.StatusOK {
			t.Fatalf("claim run %s status=%d body=%s", inputID, code, raw)
		}
		return submitted.RunId
	}
	finishRun := func(runID string) {
		t.Helper()
		code, raw := agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/runs/finish", teamHubInternalToken, map[string]any{
			"context_key": contextKey, "epoch": epoch, "run_id": runID,
			"terminal": map[string]any{"type": "succeeded"},
		})
		if code != http.StatusOK {
			t.Fatalf("finish run %s status=%d body=%s", runID, code, raw)
		}
	}

	// Missing Run returns 404 NOT_FOUND.
	status, body = queryReplyStatus("missing-run")
	assertAgentRuntimeHTTPError(t, status, body, http.StatusNotFound, "NOT_FOUND")

	// Seed an older finished Run and an older unattributed message before Run 1 starts.
	run0 := startRun("reply-run-0")
	finishRun(run0)
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments,message_kind,created_at)
		VALUES('msg-before-run','tenant_acme',$1,'actor_acme_official','Old reply',
		       '[{"type":"text","content":"Old reply"}]'::jsonb,'conversation',clock_timestamp()-interval '1 minute')`, roomID); err != nil {
		t.Fatalf("insert pre-run message: %v", err)
	}

	// Run 1: non-conversation messages and delayed messages attributed to another Run do not count;
	// an attributed conversation message does count.
	run1 := startRun("reply-run-1")
	assertReplied(run1, false)
	for _, stmt := range []struct {
		id      string
		kind    string
		localID string
		notice  any
	}{
		{id: "msg-notice", kind: "room_notice", localID: run1, notice: `{"type":"member_added"}`},
		{id: "msg-runtime", kind: "agent_runtime", localID: run1, notice: nil},
		{id: "msg-other-run", kind: "conversation", localID: run0, notice: nil},
	} {
		if _, err := pool.Exec(t.Context(), `
			INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments,message_kind,local_run_id,notice,created_at)
			VALUES($1,'tenant_acme',$2,'actor_acme_official','Non-reply',
			       '[{"type":"text","content":"Non-reply"}]'::jsonb,$3,$4,$5::jsonb,clock_timestamp())`,
			stmt.id, roomID, stmt.kind, stmt.localID, stmt.notice); err != nil {
			t.Fatalf("insert %s: %v", stmt.id, err)
		}
	}
	assertReplied(run1, false)
	insertRuntimeRunMessageFixture(t, pool, roomID, "msg-run1-reply", run1, "Direct reply")
	assertReplied(run1, true, "room:"+roomID)
	finishRun(run1)

	// Run 2: attributed presentation sequence counts even before items deliver into messages.
	run2 := startRun("reply-run-2")
	assertReplied(run2, false)
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO agent_presentation_sequences(id,tenant_id,room_id,agent_actor_id,local_run_id,status)
		VALUES('seq-run2','tenant_acme',$1,'actor_acme_official',$2,'pending')`, roomID, run2); err != nil {
		t.Fatalf("insert attributed sequence: %v", err)
	}
	assertReplied(run2, true, "room:"+roomID)
	finishRun(run2)

	// Run 3: unattributed presentation sequence created during the Run counts.
	run3 := startRun("reply-run-3")
	assertReplied(run3, false)
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO agent_presentation_sequences(id,tenant_id,room_id,agent_actor_id,local_run_id,status,created_at)
		VALUES('seq-run3-unattributed','tenant_acme',$1,'actor_acme_official',NULL,'pending',clock_timestamp())`, roomID); err != nil {
		t.Fatalf("insert unattributed sequence: %v", err)
	}
	assertReplied(run3, true, "room:"+roomID)
	finishRun(run3)

	// Run 4: unattributed conversation message written during the Run counts.
	run4 := startRun("reply-run-4")
	assertReplied(run4, false)
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments,message_kind,local_run_id,created_at)
		VALUES('msg-run4-unattributed','tenant_acme',$1,'actor_acme_official','Early reply',
		       '[{"type":"text","content":"Early reply"}]'::jsonb,'conversation',NULL,clock_timestamp())`, roomID); err != nil {
		t.Fatalf("insert unattributed message: %v", err)
	}
	assertReplied(run4, true, "room:"+roomID)
	finishRun(run4)

	// Run 5: emoji reaction in a Thread of the Room written during the Run counts.
	run5 := startRun("reply-run-5")
	assertReplied(run5, false)
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO message_reactions(message_id,tenant_id,room_id,actor_id,reaction_id,created_at)
		VALUES('reply-status-thread-msg','tenant_acme',$1,'actor_acme_official','thumbs_up',clock_timestamp())`, threadID); err != nil {
		t.Fatalf("insert thread reaction: %v", err)
	}
	// A reply in a Thread answers that Thread's Inbox, not the Room's.
	assertReplied(run5, true, "thread:"+threadID)
	insertRuntimeRunMessageFixture(t, pool, roomID, "msg-run5-room-reply", run5, "Room reply")
	assertReplied(run5, true, "room:"+roomID, "thread:"+threadID)
	finishRun(run5)

	// Run 6: a Task's work Room delivers its Messages on the Task's Inbox, so
	// a reply in that Room answers the Task's Inbox too; a reply in one of its
	// Threads does not.
	const taskID = "http-reply-status-task"
	// The Task, its first generation and that generation's participant
	// reference each other, so they are written in one transaction.
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO work_items(id,tenant_id,number,kind,title,created_by_actor_id,updated_by_actor_id,state,task_execution_generation,task_execution_status,task_execution_revision,task_desired_control,task_control_revision,task_control_settled_revision,task_execution_updated_at,task_next_reconcile_at,task_lease_generation)
		VALUES('http-reply-status-task','tenant_acme',98766,'task','reply status task','actor_acme_alice','actor_acme_alice','in_progress',1,'idle',1,'run',0,0,now(),now(),0);
		INSERT INTO task_execution_generations(task_id,tenant_id,generation,result_agent_actor_id,spec,spec_hash)
		VALUES('http-reply-status-task','tenant_acme',1,'actor_acme_official','{}',decode(repeat('00',32),'hex'));
		INSERT INTO task_execution_participants(task_id,tenant_id,generation,actor_id,agent_management_id,execution_context_ref)
		VALUES('http-reply-status-task','tenant_acme',1,'actor_acme_official','`+testRuntimeAgentID+`',
		       jsonb_build_object('kind','alter_ego','agentId','`+testRuntimeAgentID+`','taskId','http-reply-status-task'));
		INSERT INTO work_item_room_links(work_item_id,tenant_id,link_type,room_id,linked_by_actor_id)
		VALUES('http-reply-status-task','tenant_acme','work','http-reply-status-room','actor_acme_alice')`); err != nil {
		t.Fatalf("seed Task work Room: %v", err)
	}
	run6 := startRun("reply-run-6")
	assertReplied(run6, false)
	insertRuntimeRunMessageFixture(t, pool, threadID, "msg-run6-thread-reply", run6, "Thread reply")
	assertReplied(run6, true, "thread:"+threadID)
	insertRuntimeRunMessageFixture(t, pool, roomID, "msg-run6-room-reply", run6, "Room reply")
	assertReplied(run6, true, "room:"+roomID, "task:"+taskID, "thread:"+threadID)
	finishRun(run6)
}

func agentRuntimeStateRequest(
	t *testing.T,
	handler http.Handler,
	method, path, token string,
	payload any,
) (int, []byte) {
	t.Helper()
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("encode Agent Runtime State request: %v", err)
		}
		body = bytes.NewReader(encoded)
	}
	request := httptest.NewRequest(method, path, body)
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response.Code, response.Body.Bytes()
}

func runtimeHTTPInput(inputID, body string) map[string]any {
	return map[string]any{
		"input_id": inputID, "source_kind": "trusted_turn",
		"payload": map[string]any{"messageId": inputID, "body": body},
	}
}

func runtimeHTTPSessionCheckpoint(expectedRevision string, configurationRevision int64, threadID string) map[string]any {
	return map[string]any{
		"expected_revision": expectedRevision, "provider_kind": "codex", "schema_version": "1",
		"session":   map[string]any{"threadId": threadID, "largeSequence": json.Number("9007199254740993")},
		"thread_id": threadID, "configuration_revision": strconv.FormatInt(configurationRevision, 10),
	}
}

func assertRuntimeHTTPSession(t *testing.T, raw []byte, revision, threadID, largeSequence string) {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value struct {
		Revision string `json:"revision"`
		ThreadID string `json:"thread_id"`
		Session  struct {
			LargeSequence json.Number `json:"largeSequence"`
		} `json:"session"`
	}
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("decode RuntimeSession response: %v body=%s", err, raw)
	}
	if value.Revision != revision || value.ThreadID != threadID || value.Session.LargeSequence.String() != largeSequence {
		t.Fatalf("RuntimeSession revision=%q thread=%q largeSequence=%q, want %q/%q/%q",
			value.Revision, value.ThreadID, value.Session.LargeSequence.String(), revision, threadID, largeSequence)
	}
}

func assertAgentRuntimeHTTPError(t *testing.T, status int, body []byte, wantStatus int, wantCode string) {
	t.Helper()
	var response struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	decode(t, body, &response)
	if status != wantStatus || response.Error.Code != wantCode {
		t.Fatalf("Agent Runtime error status=%d code=%q body=%s, want %d/%q", status, response.Error.Code, body, wantStatus, wantCode)
	}
}
