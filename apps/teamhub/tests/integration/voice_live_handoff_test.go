package integration_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentmessages"
	teamhubinternal "github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func TestVoiceLiveRoomHandoffReportsAndFollowups(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, targetRoom, previousSession := newVoiceLiveRoom(t)
	if status, _, body := env.request(alice, http.MethodDelete, "/v0/voice-sessions/"+previousSession, nil, "close-group-call"); status != http.StatusOK {
		t.Fatalf("close group call=%d %s", status, body)
	}
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/direct-rooms", map[string]any{"peer_actor_id": "actor_acme_official"}, "")
	if status != http.StatusOK && status != http.StatusCreated {
		t.Fatalf("open direct=%d %s", status, body)
	}
	var direct httpapi.Room
	decode(t, body, &direct)
	status, _, body = env.request(alice, http.MethodPost, "/v0/rooms/"+direct.Id+"/voice-sessions", map[string]any{"purpose": "chat_live"}, "handoff-call")
	if status != http.StatusCreated {
		t.Fatalf("start private Live=%d %s", status, body)
	}
	var session httpapi.VoiceSession
	decode(t, body, &session)
	// The session timestamp and report timestamp need not come from the same clock.
	if _, err := env.pool.Exec(t.Context(), `UPDATE voice_sessions SET created_at=created_at+interval '1 minute' WHERE id=$1`, session.Id); err != nil {
		t.Fatal(err)
	}

	issued, err := agentcredential.New(env.pool).IssueManaged(t.Context(), acmeOfficialAgentManagementID, "Room handoff test")
	if err != nil {
		t.Fatal(err)
	}
	call := func(turn, id, name string, args map[string]any) map[string]any {
		t.Helper()
		encoded, _ := json.Marshal(args)
		body := voiceRuntimeCall(t, env, http.MethodPost, "/internal/v1/voice/live-tool-calls", map[string]any{"voice_session_id": session.Id, "turn_id": turn, "call_id": id, "name": name, "arguments": string(encoded)}, http.StatusOK)
		var result teamhubinternal.VoiceLiveToolResult
		decode(t, body, &result)
		var output map[string]any
		decode(t, []byte(result.Output), &output)
		return output
	}
	handoff := func(room, key string) string {
		t.Helper()
		args := map[string]any{"room_id": room, "instruction": "Ask the travel Agents to plan the offsite and report decisions."}
		if preview := call(key+"_ask", key+"_preview", "hand_off_to_room", args); preview["status"] != "needs_confirmation" {
			t.Fatalf("preview=%v", preview)
		}
		args["confirmed"] = true
		if early := call(key+"_ask", key+"_early", "hand_off_to_room", args); early["status"] != "awaiting_answer" {
			t.Fatalf("same-turn confirmation=%v", early)
		}
		first := call(key+"_yes", key+"_commit", "hand_off_to_room", args)
		if first["status"] != "accepted" {
			t.Fatalf("handoff=%v", first)
		}
		again := call(key+"_yes", key+"_retry", "hand_off_to_room", args)
		if again["handoff_id"] != first["handoff_id"] {
			t.Fatalf("duplicate=%v first=%v", again, first)
		}
		return first["handoff_id"].(string)
	}
	handoffID := handoff(targetRoom, "first")
	if n := countRows(t, env, `SELECT count(*) FROM agent_local_runs run JOIN agent_execution_contexts context ON context.context_key=run.context_key WHERE context.room_id=$1`, direct.Id); n != 0 {
		t.Fatalf("Live started %d Meta Runs", n)
	}
	if n := countRows(t, env, `SELECT count(*) FROM voice_live_tasks WHERE voice_session_id=$1`, session.Id); n != 0 {
		t.Fatalf("handoff started %d Tasks", n)
	}
	var disposition string
	if err := env.pool.QueryRow(t.Context(), `SELECT disposition FROM agent_inbox_message_disposition($1,'actor_acme_official','',$2,$3)`, acmeTenant, "room:"+targetRoom, handoffID).Scan(&disposition); err != nil || disposition != "notify" {
		t.Fatalf("target wake=%s err=%v", disposition, err)
	}

	// Creation uses the same member admission and includes the call's Agent.
	create := map[string]any{"name": "Second voice group"}
	call("create_ask", "create_preview", "create_room", create)
	create["confirmed"] = true
	created := call("create_yes", "create_commit", "create_room", create)
	secondRoom, ok := created["room_id"].(string)
	if !ok {
		t.Fatalf("create=%v", created)
	}
	if n := countRows(t, env, `SELECT count(*) FROM active_room_members WHERE room_id=$1 AND actor_id IN ('actor_acme_alice','actor_acme_official')`, secondRoom); n != 2 {
		t.Fatalf("created member count=%d", n)
	}
	secondHandoff := handoff(secondRoom, "second")
	env.createMessage(alice, targetRoom, "Travel group is choosing a hotel.", "travel-discussion")
	env.createMessage(alice, secondRoom, "Second group is choosing a venue.", "other-discussion")
	recent := call("read_turn", "read_group", "search_messages", map[string]any{"room_id": targetRoom, "query": ""})
	entries, ok := recent["messages"].([]any)
	if !ok || len(entries) == 0 {
		t.Fatalf("recent discussion=%v", recent)
	}
	for _, entry := range entries {
		if entry.(map[string]any)["room_id"] != targetRoom {
			t.Fatalf("crossed Room search=%v", recent)
		}
	}

	directMessage := func(room string, payload map[string]any, want int) map[string]any {
		t.Helper()
		encoded, _ := json.Marshal(payload)
		request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, env.server.URL+"/api/agent/v1/direct-messages", bytes.NewReader(encoded))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+issued.AccessToken)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-TeamHub-Context-Kind", "room")
		request.Header.Set("X-TeamHub-Context-Id", room)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var result map[string]any
		if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != want {
			t.Fatalf("report=%d %v want=%d", response.StatusCode, result, want)
		}
		return result
	}
	report := func(room, id, key string, want int) map[string]any {
		t.Helper()
		return directMessage(room, map[string]any{"invocation_id": "agent-invocation-sha256:" + semanticDigest([]byte(key)), "handoff_id": id, "handoff_state": "waiting_for_user", "messages": []string{"What is the accommodation budget?"}}, want)
	}
	report(secondRoom, handoffID, "wrong-room", http.StatusForbidden)
	firstReport := report(targetRoom, handoffID, "first-report", http.StatusOK)
	replay := report(targetRoom, handoffID, "first-report", http.StatusOK)
	if replay["duplicate_request"] != true {
		t.Fatalf("report replay=%v", replay)
	}
	// Routing fields cannot collide with ordinary message text in a retry.
	directMessage(targetRoom, map[string]any{
		"invocation_id": "agent-invocation-sha256:" + semanticDigest([]byte("first-report")),
		"messages":      []string{handoffID, "waiting_for_user", "What is the accommodation budget?"},
	}, http.StatusConflict)
	report(secondRoom, secondHandoff, "second-report", http.StatusOK)
	readReports := func() []teamhubinternal.VoiceLiveRoomReport {
		t.Helper()
		body := voiceRuntimeCall(t, env, http.MethodGet, "/internal/v1/voice/sessions/"+session.Id+"/live-tasks", nil, http.StatusOK)
		var result teamhubinternal.VoiceLiveTaskList
		decode(t, body, &result)
		if result.RoomReports == nil {
			return nil
		}
		return *result.RoomReports
	}
	reports := readReports()
	if len(reports) != 2 || reports[0].HandoffId != handoffID || reports[0].RoomId != targetRoom || reports[1].HandoffId != secondHandoff {
		t.Fatalf("reports=%+v", reports)
	}
	if !strings.Contains(reports[0].Text, "accommodation budget") {
		t.Fatalf("report text=%s", reports[0].Text)
	}
	args := map[string]any{"room_id": targetRoom, "handoff_id": handoffID, "instruction": "The accommodation budget is 1000. Continue with that limit."}
	call("follow_ask", "follow_preview", "hand_off_to_room", args)
	args["confirmed"] = true
	continued := call("follow_yes", "follow_commit", "hand_off_to_room", args)
	if continued["handoff_id"] != handoffID {
		t.Fatalf("followup=%v", continued)
	}
	if n := countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1 AND message_kind='agent_runtime' AND body LIKE '%The accommodation budget is 1000%'`, targetRoom); n != 1 {
		t.Fatalf("followup messages=%d", n)
	}
	// A handoff cannot be retargeted, even to another authorized Room.
	args["room_id"] = secondRoom
	args["confirmed"] = false
	call("wrong_ask", "wrong_preview", "hand_off_to_room", args)
	args["confirmed"] = true
	if refused := call("wrong_yes", "wrong_commit", "hand_off_to_room", args); refused["error"] != "room_or_handoff_unavailable" {
		t.Fatalf("retarget=%v", refused)
	}
	messageID := firstReport["message_ids"].([]any)[0].(string)
	history, err := agentmessages.New(env.pool).Read(t.Context(), agentmessages.Reader{TenantID: acmeTenant, ActorID: "actor_acme_official"}, agentmessages.ReadInput{MessageIDs: []string{messageID}})
	if err != nil || history.Messages == nil || len(*history.Messages) != 1 || (*history.Messages)[0].RoomHandoff == nil || (*history.Messages)[0].RoomHandoff.HandoffID != handoffID {
		t.Fatalf("private history routing=%+v err=%v", history, err)
	}

	call("ack_turn", "ack_reports", "ack_room_reports", map[string]any{"message_ids": []string{messageID}})
	if remaining := readReports(); len(remaining) != 1 || remaining[0].HandoffId != secondHandoff {
		t.Fatalf("after ack=%+v", remaining)
	}

	// Departure removes report authority even though the member row remains.
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO room_member_states(room_id,actor_id,participation_epoch_id,left_at,left_room_seq)
 SELECT room_id,actor_id,membership_epoch_id,clock_timestamp(),0 FROM room_members WHERE room_id=$1 AND actor_id='actor_acme_alice'
 ON CONFLICT(room_id,actor_id) DO UPDATE SET left_at=clock_timestamp(),participation_epoch_id=EXCLUDED.participation_epoch_id`, targetRoom); err != nil {
		t.Fatal(err)
	}
	report(targetRoom, handoffID, "departed-report", http.StatusForbidden)
	if status, _, body := env.request(alice, http.MethodDelete, "/v0/voice-sessions/"+session.Id, nil, "end-handoff-call"); status != http.StatusOK {
		t.Fatalf("end=%d %s", status, body)
	}
	report(secondRoom, secondHandoff, "after-call", http.StatusOK)
	if n := countRows(t, env, `SELECT count(*) FROM room_handoff_reports report JOIN messages message ON message.id=report.message_id WHERE message.room_id=$1`, direct.Id); n != 3 {
		t.Fatalf("durable private reports=%d", n)
	}
}
