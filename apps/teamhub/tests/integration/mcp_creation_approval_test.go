package integration_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcreationapproval"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentsendmessage"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

func TestAgentCreationApprovalPostgreSQLVerticalSlice(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newAgentRunEnv(t, "http://127.0.0.1:1")
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	if _, err := env.pool.Exec(t.Context(), `
		UPDATE agent_registrations
		SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_acme_alice'
		WHERE actor_id='actor_acme_official' AND tenant_id=$1`, acmeTenant); err != nil {
		t.Fatal(err)
	}
	originRoomID := createPrivateRoom(t, env, alice, "MCP Creation "+suffix, "mcp-creation-room-"+suffix)
	if status, body := putRoomMember(t, env, alice, originRoomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Creation Agent status=%d body=%s", status, body)
	}
	discussionAgentActorID := "actor_mcp_discussion_agent_" + suffix
	discussionAgentManagementID := "agent-management-mcp-discussion-" + suffix
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO actors(id,tenant_id,kind,display_name,handle)
		VALUES($1,$2,'agent','Discussion Worker',$3)`,
		discussionAgentActorID, acmeTenant, "@discussion-worker-"+suffix); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO agent_registrations(
			actor_id,tenant_id,agent_management_id,status,description,instructions,runtime_model,
			created_by_actor_id,visibility_scope,agent_type,
			computer_id,local_runtime_type,workspace_grant_id
		) VALUES($1,$2,$3,'active','Researches evidence.','Execute discussed Tasks.','gpt-5',
			'actor_acme_alice','sponsor','general','computer_fixture','codex','grant_files')`,
		discussionAgentActorID, acmeTenant, discussionAgentManagementID); err != nil {
		t.Fatal(err)
	}
	workspaceAgentActorID := "actor_mcp_workspace_agent_" + suffix
	inactiveAgentActorID := "actor_mcp_inactive_agent_" + suffix
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO actors(id,tenant_id,kind,display_name,handle) VALUES
			($1,$3,'agent','Workspace Worker',$4),
			($2,$3,'agent','Inactive Worker',$5)`,
		workspaceAgentActorID, inactiveAgentActorID, acmeTenant,
		"@workspace-worker-"+suffix, "@inactive-worker-"+suffix); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO agent_registrations(
			actor_id,tenant_id,agent_management_id,status,description,instructions,runtime_model,
			created_by_actor_id,visibility_scope,agent_type,
			computer_id,local_runtime_type,workspace_grant_id
		) VALUES
			($1,$3,$4,'active','Visible across the workspace.','Work safely.','gpt-5','actor_acme_alice','workspace','general','computer_fixture','codex','grant_files'),
			($2,$3,$5,'revoked','Not active yet.','Work safely.','gpt-5','actor_acme_alice','sponsor','general','computer_fixture','codex','grant_files')`,
		workspaceAgentActorID, inactiveAgentActorID, acmeTenant,
		"agent-management-mcp-workspace-"+suffix, "agent-management-mcp-inactive-"+suffix); err != nil {
		t.Fatal(err)
	}
	if status, body := putRoomMember(t, env, alice, originRoomID, discussionAgentActorID, "member"); status != http.StatusOK {
		t.Fatalf("add discussion Agent status=%d body=%s", status, body)
	}
	contexts := agentauth.New(env.pool)
	issued, err := agentcredential.New(env.pool).IssueManaged(t.Context(), acmeOfficialAgentManagementID, "creation approval")
	if err != nil {
		t.Fatal(err)
	}
	token := issued.AccessToken

	service := agentcreationapproval.New(env.pool, contexts, typedcard.New(env.pool))
	available, err := service.ListAvailableAgents(
		t.Context(), token, "", 100,
	)
	if err != nil {
		t.Fatalf("list Sponsor-authorized Agents: %v", err)
	}
	availableByID := make(map[string]agentcreationapproval.AvailableAgent, len(available.Agents))
	for _, agent := range available.Agents {
		availableByID[agent.ActorID] = agent
	}
	if availableByID[discussionAgentActorID].Name != "Discussion Worker" ||
		availableByID[workspaceAgentActorID].Name != "Workspace Worker" {
		t.Fatalf("available Agents=%+v", available.Agents)
	}
	for _, forbiddenActorID := range []string{
		inactiveAgentActorID, "actor_acme_official",
	} {
		if _, found := availableByID[forbiddenActorID]; found {
			t.Fatalf("unauthorized Agent %s was listed: %+v", forbiddenActorID, available.Agents)
		}
	}

	status, _, roomArtifactBody := requestUnifiedDocumentMultipart(
		t, env, alice, "/v0/rooms/"+originRoomID+"/documents/uploads",
		"mcp-creation-room-artifact-"+suffix,
		map[string]string{
			"filename": "room-brief-v1.txt", "representation_format": "plain_text", "media_type": "text/plain",
		},
		"room-brief-v1.txt", []byte("frozen Room brief v1\n"),
	)
	if status != http.StatusCreated {
		t.Fatalf("upload Room Creation artifact status=%d body=%s", status, roomArtifactBody)
	}
	var roomArtifact uploadedDocumentRef
	decode(t, roomArtifactBody, &roomArtifact)
	if roomArtifact.ID == "" || roomArtifact.CurrentVersion.ID == "" {
		t.Fatalf("Room Creation artifact=%+v", roomArtifact)
	}
	nativeArtifactID := "document_mcp_room_native_" + suffix
	nativeRevisionID := "document_revision_mcp_room_native_" + suffix
	nativeArtifactTitle := "Room native brief " + suffix
	nativeArtifactStatements := []struct {
		query string
		args  []any
	}{
		{
			query: `INSERT INTO documents(
				id,tenant_id,title,format,native_representation_format,owner_actor_id,owner_actor_kind,
				creator_actor_id,creator_actor_kind,status
			) VALUES($1,'tenant_acme',$2,'blocknote','markdown','actor_acme_alice','human',
				'actor_acme_alice','human','active')`,
			args: []any{nativeArtifactID, nativeArtifactTitle},
		},
		{
			query: `INSERT INTO document_revisions(
				id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,
				state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id
			) VALUES($1,'tenant_acme',$2,0,'\x00',repeat('d',64),'\x00',
				'6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
				'[]'::jsonb,'actor_acme_alice')`,
			args: []any{nativeRevisionID, nativeArtifactID},
		},
		{
			query: `INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids) SELECT draft.document_id,draft.persisted_seq::bigint,revision.state_bytes,draft.state_vector::bytea,ARRAY(SELECT asset->>'asset_id' FROM jsonb_array_elements(revision.asset_manifest) asset ORDER BY 1),revision.thread_manifest,ARRAY[draft.last_content_actor_id]::text[] FROM (VALUES ($1,'tenant_acme',$2,0,'\x00',repeat('d',64),$3,'actor_acme_alice')) AS draft(document_id,tenant_id,title,persisted_seq,state_vector,full_state_fingerprint,current_revision_id,last_content_actor_id) JOIN document_revisions revision ON revision.id=draft.current_revision_id`,
			args:  []any{nativeArtifactID, nativeArtifactTitle, nativeRevisionID},
		},
		{
			query: `INSERT INTO document_context_bindings(
				id,tenant_id,document_id,binding_kind,room_id,status,role
			) VALUES($1,'tenant_acme',$2,'room',$3,'active','manager')`,
			args: []any{"document_binding_mcp_room_native_" + suffix, nativeArtifactID, originRoomID},
		},
	}
	for _, statement := range nativeArtifactStatements {
		if _, err := env.pool.Exec(t.Context(), statement.query, statement.args...); err != nil {
			t.Fatalf("seed native Room Creation artifact: %v", err)
		}
	}

	roomName := "Created MCP Room " + suffix
	roomInput := agentcreationapproval.Input{
		RequestKind: "room_creation",
		RoomCaller: &agentcreationapproval.RoomCallerInput{
			Name: roomName, MemberIDs: []string{"actor_acme_official"},
			Artifacts:              []string{nativeArtifactID, roomArtifact.ID},
			InitialMessageSegments: []messagecreation.Segment{{Type: "text", Content: "Start the new Room."}},
		},
		RoomEffective: &agentcreationapproval.RoomEffectivePayload{
			Name: roomName, MemberIDs: []string{"actor_acme_official"},
			Artifacts:              []string{nativeArtifactID, roomArtifact.ID},
			InitialMessageSegments: []messagecreation.Segment{{Type: "text", Content: "Start the new Room."}},
		},
		SourceInboxIDs: []string{"room:" + originRoomID},
		InvocationID:   mcpCreationInvocationID(suffix + ":room"),
	}
	// The requesting Meta sends its Room Context, as its CLI configuration does.
	roomCtx := agentauth.WithTarget(t.Context(), "room", originRoomID)
	roomsBefore := countRows(t, env, `SELECT count(*) FROM rooms WHERE tenant_id=$1`, acmeTenant)
	createdRoom, err := service.Submit(roomCtx, token, roomInput)
	if err != nil {
		t.Fatalf("create Room: %v", err)
	}
	created := decodeRoomCreated(t, createdRoom)
	createdRoomID := created.RoomID
	if len(created.SkippedArtifacts) != 0 {
		t.Fatalf("created Room skipped=%s", createdRoom.Created)
	}
	if got := countRows(t, env, `SELECT count(*) FROM rooms WHERE tenant_id=$1`, acmeTenant); got != roomsBefore+1 {
		t.Fatalf("Room count=%d want=%d", got, roomsBefore+1)
	}
	// The Sponsor owns the Room; no approval card is posted.
	if got := countRows(t, env, `SELECT count(*) FROM rooms room JOIN room_members member ON member.room_id=room.id
		WHERE room.id=$1 AND room.name=$2 AND member.actor_id='actor_acme_alice' AND member.role='owner'`, createdRoomID, roomName); got != 1 {
		t.Fatalf("created Room owned by the Sponsor=%d want=1", got)
	}
	if got := countRows(t, env, `SELECT count(*) FROM decisions WHERE room_id=$1`, originRoomID); got != 0 {
		t.Fatalf("Room creation posted %d cards", got)
	}
	var initialMessageID string
	var initialSegmentsJSON []byte
	if err := env.pool.QueryRow(t.Context(), `
		SELECT id,segments FROM messages
		WHERE room_id=$1 AND author_actor_id='actor_acme_official' AND message_kind='conversation'
	`, createdRoomID).Scan(&initialMessageID, &initialSegmentsJSON); err != nil {
		t.Fatal(err)
	}
	var initialSegments []messagecreation.Segment
	if err := json.Unmarshal(initialSegmentsJSON, &initialSegments); err != nil {
		t.Fatal(err)
	}
	if len(initialSegments) != 5 || initialSegments[0].Content != "Start the new Room." ||
		initialSegments[1].Type != "text" || initialSegments[1].Content != "\n" ||
		initialSegments[2].Type != "document" || initialSegments[2].Content != nativeArtifactTitle ||
		initialSegments[2].DocumentID != nativeArtifactID || initialSegments[2].DocumentVersionID != "" ||
		initialSegments[2].Presentation != "card" ||
		initialSegments[3].Type != "text" || initialSegments[3].Content != "\n" ||
		initialSegments[4].Type != "document" || initialSegments[4].Content != "room-brief-v1.txt" ||
		initialSegments[4].DocumentID != roomArtifact.ID || initialSegments[4].DocumentVersionID != "" ||
		initialSegments[4].Presentation != "card" {
		t.Fatalf("created Room initial segments=%+v", initialSegments)
	}
	var attachedDocumentID, attachedVersionID, fileBindingRole, nativeBindingRole string
	if err := env.pool.QueryRow(t.Context(), `SELECT
		(SELECT attachments->0->>'document_id' FROM messages WHERE id=$1),
		(SELECT attachments->0->>'document_version_id' FROM messages WHERE id=$1),
		(SELECT role FROM document_context_bindings
		 WHERE room_id=$2 AND document_id=$3 AND binding_kind='room' AND status='active'),
		(SELECT role FROM document_context_bindings
		 WHERE room_id=$2 AND document_id=$4 AND binding_kind='room' AND status='active')
	`, initialMessageID, createdRoomID, roomArtifact.ID, nativeArtifactID).Scan(
		&attachedDocumentID, &attachedVersionID, &fileBindingRole, &nativeBindingRole,
	); err != nil {
		t.Fatal(err)
	}
	if attachedDocumentID != roomArtifact.ID || attachedVersionID != roomArtifact.CurrentVersion.ID ||
		fileBindingRole != "manager" || nativeBindingRole != "manager" {
		t.Fatalf("created Room artifact document=%s version=%s file binding=%s native binding=%s",
			attachedDocumentID, attachedVersionID, fileBindingRole, nativeBindingRole)
	}
	_, sendErr := newAgentSendService(t, env.pool, contexts).Send(
		roomCtx, token,
		agentSendInput("room:"+createdRoomID, mcpCreationInvocationID(suffix+":cross-room-send"),
			agentsendmessage.PreparedSegment{Type: "text", Content: "Must be forbidden."}))
	if !errors.Is(sendErr, agentsendmessage.ErrForbidden) {
		t.Fatalf("cross-room send error=%v want Forbidden", sendErr)
	}
	assertRoomCreationHandoff(t, env, createdRoomID, originRoomID, nil, "",
		[]string{nativeArtifactID, roomArtifact.ID})

	// A retried submission replays the Room it created.
	replayed, err := service.Submit(roomCtx, token, roomInput)
	if err != nil || !replayed.Replay || !bytes.Equal(replayed.Created, createdRoom.Created) {
		t.Fatalf("replayed Room creation=%+v err=%v", replayed, err)
	}
	if got := countRows(t, env, `SELECT count(*) FROM rooms WHERE tenant_id=$1`, acmeTenant); got != roomsBefore+1 {
		t.Fatalf("replayed Room creation duplicated Room: got=%d want=%d", got, roomsBefore+1)
	}
	if got := countRows(t, env, `SELECT jsonb_array_length(attachments) FROM messages WHERE id=$1`, initialMessageID); got != 1 {
		t.Fatalf("replayed Room creation attachments=%d want=1", got)
	}
	assertRoomCreationHandoff(t, env, createdRoomID, originRoomID, nil, "",
		[]string{nativeArtifactID, roomArtifact.ID})

	// A Document no longer in the origin Room cannot be shared, so no Room is created.
	status, _, otherArtifactBody := requestUnifiedDocumentMultipart(
		t, env, alice, "/v0/rooms/"+originRoomID+"/documents/uploads",
		"mcp-creation-other-artifact-"+suffix,
		map[string]string{
			"filename": "other-brief.txt", "representation_format": "plain_text", "media_type": "text/plain",
		},
		"other-brief.txt", []byte("trashed before creation\n"),
	)
	if status != http.StatusCreated {
		t.Fatalf("upload other Room artifact status=%d body=%s", status, otherArtifactBody)
	}
	var otherArtifact uploadedDocumentRef
	decode(t, otherArtifactBody, &otherArtifact)
	status, _, body := env.request(
		alice, http.MethodDelete, "/v0/documents/"+otherArtifact.ID, nil,
		"mcp-creation-trash-artifact-"+suffix,
	)
	if status != http.StatusNoContent {
		t.Fatalf("trash Room artifact status=%d body=%s", status, body)
	}
	trashedCaller, trashedEffective := *roomInput.RoomCaller, *roomInput.RoomEffective
	trashedCaller.Name, trashedEffective.Name = "Trashed Artifact MCP Room "+suffix, "Trashed Artifact MCP Room "+suffix
	trashedCaller.Artifacts, trashedEffective.Artifacts = []string{otherArtifact.ID}, []string{otherArtifact.ID}
	trashedInput := roomInput
	trashedInput.RoomCaller, trashedInput.RoomEffective = &trashedCaller, &trashedEffective
	trashedInput.InvocationID = mcpCreationInvocationID(suffix + ":room-trashed-artifact")
	roomsBeforeTrashed := countRows(t, env, `SELECT count(*) FROM rooms WHERE tenant_id=$1`, acmeTenant)
	if _, err := service.Submit(roomCtx, token, trashedInput); err == nil {
		t.Fatal("a Room with a trashed artifact was created")
	}
	if got := countRows(t, env, `SELECT count(*) FROM rooms WHERE tenant_id=$1`, acmeTenant); got != roomsBeforeTrashed {
		t.Fatalf("trashed-artifact Rooms=%d want=%d", got, roomsBeforeTrashed)
	}

	// Frozen Versions/Revisions are immutable. Exercise unavailable or
	// mismatched historical content at the Document guard itself.
	for _, contentCase := range []struct{ documentID, versionID, revisionID, tenantID, reason string }{
		{roomArtifact.ID, otherArtifact.CurrentVersion.ID, "", acmeTenant, "frozen_content_unavailable"},
		{nativeArtifactID, "", "revision_missing", acmeTenant, "frozen_content_unavailable"},
	} {
		tx, err := env.pool.Begin(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		_, reason, reviewErr := document.LockRoomCreationArtifactInTransaction(t.Context(), tx,
			"account_alice", contentCase.tenantID, contentCase.documentID, contentCase.versionID, contentCase.revisionID)
		_ = tx.Rollback(t.Context())
		if reviewErr != nil || reason != contentCase.reason {
			t.Fatalf("content review reason=%q want=%q err=%v", reason, contentCase.reason, reviewErr)
		}
	}
	frozenArtifacts := []typedcard.RoomCreationArtifactSnapshot{
		{DocumentID: nativeArtifactID, DocumentRevisionID: nativeRevisionID},
		{DocumentID: roomArtifact.ID, DocumentVersionID: roomArtifact.CurrentVersion.ID},
	}
	frozenSegments := []messagecreation.Segment{
		{Type: "text", Content: "Start the approved Room."},
		{Type: "text", Content: "\n"},
		{Type: "document", Content: nativeArtifactTitle, DocumentID: nativeArtifactID, Presentation: "card"},
		{Type: "text", Content: "\n"},
		{Type: "document", Content: "room-brief-v1.txt", DocumentID: roomArtifact.ID, Presentation: "card"},
	}
	pendingCard := func(t *testing.T, name string, description *string) typedcard.CreateResult {
		t.Helper()
		return postRoomCreationCard(t, env, roomCreationApprovalInputFor(t, typedcard.RoomCreationSnapshot{
			OriginRoomID: originRoomID, Name: name, Description: description, MemberIDs: []string{"actor_acme_official"},
			Artifacts: frozenArtifacts, InitialMessageSegments: frozenSegments,
		}, mcpCreationInvocationID(t.Name())[24:56]))
	}
	assertRoomCreationApprovalAccessTransactions(t, env, alice, originRoomID, frozenArtifacts, frozenSegments,
		roomArtifact.ID, nativeArtifactID)
	t.Run("handoff carries the description as purpose", func(t *testing.T) {
		purpose := "Plan the launch with the brief."
		caller, effective := *roomInput.RoomCaller, *roomInput.RoomEffective
		caller.Name, effective.Name = "Purpose MCP Room "+suffix, "Purpose MCP Room "+suffix
		caller.Description, effective.Description = &purpose, &purpose
		input := roomInput
		input.RoomCaller, input.RoomEffective = &caller, &effective
		input.InvocationID = mcpCreationInvocationID(suffix + ":room-purpose")
		result, err := service.Submit(roomCtx, token, input)
		if err != nil {
			t.Fatal(err)
		}
		assertRoomCreationHandoff(t, env, decodeRoomCreated(t, result).RoomID, originRoomID, nil, purpose,
			[]string{nativeArtifactID, roomArtifact.ID})
	})
	t.Run("an earlier pending card creates its Room on approval", func(t *testing.T) {
		pending := pendingCard(t, "Approved MCP Room "+suffix, nil)
		before := countRows(t, env, `SELECT count(*) FROM rooms WHERE tenant_id=$1`, acmeTenant)
		httpStatus, _, response := env.request(alice, http.MethodPost, "/v0/decisions/"+pending.DecisionID,
			map[string]any{"decision": "approve", "expected_version": int64(1)}, "approve-room-"+suffix)
		if httpStatus != http.StatusOK {
			t.Fatalf("approve status=%d body=%s", httpStatus, response)
		}
		var approvedRoomID, runtimeBody string
		if err := env.pool.QueryRow(t.Context(), `SELECT request.result->'data'->>'created_room_id',message.body
			FROM decisions request JOIN messages message
			ON message.card_context_message_id=request.message_id AND message.message_kind='agent_runtime'
			WHERE request.id=$1 AND request.status='succeeded'`, pending.DecisionID).Scan(&approvedRoomID, &runtimeBody); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(runtimeBody, `"created_room_id":"`+approvedRoomID+`"`) ||
			!strings.Contains(runtimeBody, `"skipped_artifacts":[]`) ||
			!strings.Contains(runtimeBody, `<room-communication-pattern>`) {
			t.Fatalf("approval runtime=%s", runtimeBody)
		}
		if got := countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1
			AND card_context_message_id=$2 AND message_kind='conversation'
			AND body LIKE '%'||$3||'%'`, originRoomID, pending.MessageID, approvedRoomID); got != 1 {
			t.Fatal("visible Room result must include the Room ID")
		}
		assertRoomCreationHandoff(t, env, approvedRoomID, originRoomID, &pending, "",
			[]string{nativeArtifactID, roomArtifact.ID})
		// A repeated decision carries a stale card version.
		httpStatus, _, response = env.request(alice, http.MethodPost, "/v0/decisions/"+pending.DecisionID,
			map[string]any{"decision": "approve", "expected_version": int64(1)}, "")
		if httpStatus != http.StatusConflict {
			t.Fatalf("repeated decision status=%d body=%s", httpStatus, response)
		}
		if got := countRows(t, env, `SELECT count(*) FROM rooms WHERE tenant_id=$1`, acmeTenant); got != before+1 {
			t.Fatalf("approved Rooms=%d want=%d", got, before+1)
		}
	})
	t.Run("denying an earlier pending card creates no Room or document delivery", func(t *testing.T) {
		pending := pendingCard(t, "Denied MCP Room "+suffix, nil)
		roomCount := countRows(t, env, `SELECT count(*) FROM rooms WHERE tenant_id=$1`, acmeTenant)
		bindingCount := countRows(t, env, `SELECT count(*) FROM document_context_bindings WHERE tenant_id=$1`, acmeTenant)
		httpStatus, _, response := env.request(alice, http.MethodPost,
			"/v0/decisions/"+pending.DecisionID,
			map[string]any{"decision": "deny", "expected_version": 1, "comment": "Use the existing Room."}, "deny-room-"+suffix)
		if httpStatus != http.StatusOK {
			t.Fatalf("deny status=%d body=%s", httpStatus, response)
		}
		if countRows(t, env, `SELECT count(*) FROM rooms WHERE tenant_id=$1`, acmeTenant) != roomCount || countRows(t, env, `SELECT count(*) FROM document_context_bindings WHERE tenant_id=$1`, acmeTenant) != bindingCount {
			t.Fatal("denial created Room or Binding")
		}
		if got := countRows(t, env, `SELECT count(*) FROM decisions WHERE id=$1 AND status='denied' AND result IS NULL`, pending.DecisionID); got != 1 {
			t.Fatal("denial result invalid")
		}
		if got := countRows(t, env, `SELECT count(*) FROM messages WHERE card_context_message_id=$1 AND message_kind='agent_runtime'`, pending.MessageID); got != 0 {
			t.Fatal("denial sent approval notification")
		}
		handoffDigest := sha256.Sum256([]byte("room-creation-handoff:" + pending.DecisionID))
		if got := countRows(t, env, `SELECT count(*) FROM messages WHERE id=$1`, fmt.Sprintf("message_%x", handoffDigest[:16])); got != 0 {
			t.Fatal("denial sent a Room Creation handoff")
		}
	})
}

// decodeRoomCreated reads the Room a submission created at once.
func decodeRoomCreated(t *testing.T, result agentcreationapproval.Result) typedcard.RoomCreated {
	t.Helper()
	var created typedcard.RoomCreated
	if result.Created == nil {
		t.Fatalf("submission was not created at once: %+v", result)
	}
	if err := json.Unmarshal(result.Created, &created); err != nil {
		t.Fatal(err)
	}
	if !created.Accepted || created.Status != typedcard.RoomCreatedStatus || created.RoomID == "" {
		t.Fatalf("created Room=%s", result.Created)
	}
	return created
}

// assertRoomCreationHandoff checks the single Agent handoff appended to a
// created Room: no cross-Room card context, one Mention for the requesting
// Agent, request facts, and only delivered Document references. For a Room an
// approval card created, approval names it, and the handoff also carries an ID
// derived from the request and the decision's facts.
func assertRoomCreationHandoff(
	t *testing.T,
	env *testEnv,
	roomID, originRoomID string,
	approval *typedcard.CreateResult,
	wantPurpose string,
	wantDocumentIDs []string,
	forbidden ...string,
) {
	t.Helper()
	if got := countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1 AND message_kind='agent_runtime'`, roomID); got != 1 {
		t.Fatalf("Room Creation handoff messages=%d want=1", got)
	}
	var id, body string
	var segments []byte
	var cardContextEmpty bool
	if err := env.pool.QueryRow(t.Context(), `
		SELECT id,body,segments,card_context_message_id IS NULL FROM messages
		WHERE room_id=$1 AND message_kind='agent_runtime'
	`, roomID).Scan(&id, &body, &segments, &cardContextEmpty); err != nil {
		t.Fatal(err)
	}
	if approval != nil {
		digest := sha256.Sum256([]byte("room-creation-handoff:" + approval.DecisionID))
		if want := fmt.Sprintf("message_%x", digest[:16]); id != want {
			t.Fatalf("handoff ID=%s want request-derived %s", id, want)
		}
	}
	if !cardContextEmpty {
		t.Fatal("handoff must not set a cross-Room card_context")
	}
	// The initial message is authored by the requesting Agent itself, so the
	// handoff Mention is the only actionable input that wakes its new Context.
	if got := countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1 AND 'actor_acme_official'=ANY(mentioned_actor_ids)`, roomID); got != 1 {
		t.Fatalf("handoff Agent mentions in new Room=%d want=1", got)
	}
	if got := countRows(t, env, `SELECT count(*) FROM messages WHERE id=$1 AND 'actor_acme_official'=ANY(mentioned_actor_ids)`, id); got != 1 {
		t.Fatalf("handoff mention rows=%d want=1", got)
	}
	if got := countRows(t, env, `
		SELECT count(*) FROM room_events handoff
		JOIN messages initial ON initial.room_id=handoff.room_id AND initial.message_kind='conversation'
		JOIN room_events initial_event ON initial_event.resource_id=initial.id AND initial_event.event_type='message.created'
		WHERE handoff.room_id=$1 AND handoff.resource_id=$2 AND handoff.event_type='message.created'
		  AND handoff.room_seq>initial_event.room_seq
	`, roomID, id); got != 1 {
		t.Fatalf("handoff events after the initial message=%d want=1", got)
	}
	if got := countRows(t, env, `
		SELECT count(*) FROM messages handoff JOIN messages origin
		  ON origin.room_id=$2 AND origin.tenant_id=handoff.tenant_id AND length(origin.body)>0
		WHERE handoff.id=$1 AND strpos(handoff.body, origin.body)>0
	`, id, originRoomID); got != 0 {
		t.Fatalf("handoff copied %d origin Room message bodies: %s", got, body)
	}
	payloadText := strings.SplitN(strings.SplitN(body, "Room creation handoff=", 2)[1], "\n", 2)[0]
	var payload struct {
		Kind          string                                   `json:"kind"`
		RequestID     string                                   `json:"creation_approval_request_id"`
		CardMessageID string                                   `json:"approval_card_message_id"`
		OriginRoomID  string                                   `json:"origin_room_id"`
		OriginInboxID string                                   `json:"origin_room_inbox_id"`
		RoomInboxID   string                                   `json:"room_inbox_id"`
		Purpose       *string                                  `json:"purpose"`
		Delivered     []typedcard.RoomCreationArtifactSnapshot `json:"delivered_artifacts"`
		Decision      string                                   `json:"decision"`
		DecidedBy     string                                   `json:"decided_by"`
		DecidedAt     string                                   `json:"decided_at"`
	}
	if err := json.Unmarshal([]byte(payloadText), &payload); err != nil {
		t.Fatalf("handoff payload %q: %v", payloadText, err)
	}
	if payload.Kind != "room_creation_handoff" || payload.OriginRoomID != originRoomID ||
		payload.OriginInboxID != "room:"+originRoomID || payload.RoomInboxID != "room:"+roomID {
		t.Fatalf("handoff payload=%+v", payload)
	}
	if approval == nil {
		if payload.RequestID != "" || payload.CardMessageID != "" || payload.Decision != "" || payload.DecidedBy != "" || payload.DecidedAt != "" {
			t.Fatalf("handoff of a Room created at once names a decision: %+v", payload)
		}
	} else {
		if payload.RequestID != approval.DecisionID || payload.CardMessageID != approval.MessageID {
			t.Fatalf("handoff payload=%+v", payload)
		}
		// Decision facts must equal the persisted decision, not a separately sampled clock.
		var requestStatus, decidedBy string
		var decidedAt time.Time
		if err := env.pool.QueryRow(t.Context(), `
			SELECT status,decided_by_actor_id,decided_at FROM decisions WHERE id=$1
		`, approval.DecisionID).Scan(&requestStatus, &decidedBy, &decidedAt); err != nil {
			t.Fatal(err)
		}
		payloadDecidedAt, err := time.Parse(time.RFC3339Nano, payload.DecidedAt)
		if err != nil || !strings.HasSuffix(payload.DecidedAt, "Z") {
			t.Fatalf("handoff decided_at=%q must be RFC3339 UTC: %v", payload.DecidedAt, err)
		}
		if requestStatus != "succeeded" || payload.Decision != "approved" || payload.DecidedBy != decidedBy ||
			!payloadDecidedAt.Equal(decidedAt) {
			t.Fatalf("handoff decision=%q decided_by=%q decided_at=%s want %q %q %s",
				payload.Decision, payload.DecidedBy, payload.DecidedAt, requestStatus, decidedBy, decidedAt.UTC().Format(time.RFC3339Nano))
		}
	}
	if wantPurpose == "" {
		if payload.Purpose != nil || strings.Contains(payloadText, `"purpose"`) {
			t.Fatalf("handoff without description must omit purpose: %s", payloadText)
		}
	} else if payload.Purpose == nil || *payload.Purpose != wantPurpose {
		t.Fatalf("handoff purpose=%v want %q", payload.Purpose, wantPurpose)
	}
	if len(payload.Delivered) != len(wantDocumentIDs) {
		t.Fatalf("handoff delivered=%+v want %v", payload.Delivered, wantDocumentIDs)
	}
	for i, documentID := range wantDocumentIDs {
		if payload.Delivered[i].DocumentID != documentID {
			t.Fatalf("handoff delivered=%+v want %v", payload.Delivered, wantDocumentIDs)
		}
	}
	for _, content := range []string{body, string(segments)} {
		for _, needle := range append([]string{"skipped"}, forbidden...) {
			if strings.Contains(content, needle) {
				t.Fatalf("handoff contains %q: %s", needle, content)
			}
		}
	}
}

func mcpCreationInvocationID(label string) string {
	digest := sha256.Sum256([]byte("MCP Creation JSON-RPC invocation:" + label))
	return fmt.Sprintf("agent-invocation-sha256:%x", digest[:])
}
