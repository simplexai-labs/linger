package integration_test

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/feishu"
	teamhubinternal "github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// With only Feishu Mail connected, the live voice reads the inbox, writes an
// email canvas for Feishu Mail, saves it as a Feishu draft and sends it after
// the user's yes; the Human sends another canvas from its card.
func TestFeishuMailCanvasIsWrittenByVoiceAndSentFromTheCard(t *testing.T) {
	allowParallelIntegrationTest(t)
	var computes atomic.Int32
	replaced := make(chan string, 64)
	var bodies *pgxpool.Pool
	runtime := canvasRuntime(t, &computes, replaced, func() *pgxpool.Pool { return bodies })
	fake := newFakeFeishu(t)
	env, alice, _, sessionID := newVoiceLiveRoomWith(t, []appOption{starting(app.JobQueue), withAgentManagement(&recordingAgentManagement{}), withFeishuComputer(fake)}, func(cfg *config.Config) {
		cfg.RoomDocument.RuntimeURL = runtime.URL
	})
	bodies = env.pool
	connectionID := authorizeFeishuMail(t, env, alice, fake, nil)
	if status, _, body := env.request(alice, http.MethodPut, "/v0/external-connections/"+connectionID+"/agent-grants/actor_acme_official", map[string]bool{"granted": true}, ""); status != http.StatusOK {
		t.Fatalf("grant status=%d body=%s", status, body)
	}
	call := func(turnID, callID, name string, arguments map[string]any) map[string]any {
		t.Helper()
		encoded, _ := json.Marshal(arguments)
		var result teamhubinternal.VoiceLiveToolResult
		decode(t, voiceRuntimeCall(t, env, http.MethodPost, "/internal/v1/voice/live-tool-calls", map[string]any{
			"voice_session_id": sessionID, "turn_id": turnID, "call_id": callID, "name": name, "arguments": string(encoded),
		}, http.StatusOK), &result)
		var output map[string]any
		if err := json.Unmarshal([]byte(result.Output), &output); err != nil {
			t.Fatalf("%s output=%s", callID, result.Output)
		}
		return output
	}

	found := call("lt_read", "mail-1", "search_mail", map[string]any{})
	messages, _ := found["messages"].([]any)
	if len(messages) != 3 || messages[0].(map[string]any)["from"] != "alice@example.com" || found["account"] != "zhang@example.com" {
		t.Fatalf("search_mail=%v", found)
	}
	read := call("lt_read", "mail-2", "read_mail", map[string]any{"message_id": "msg_1"})
	if read["text"] != "Can we meet?" || read["subject"] != "Quarterly plan" {
		t.Fatalf("read_mail=%v", read)
	}

	// The only mail app connected is Feishu Mail, so the canvas targets it.
	opened := call("lt_write", "email-1", "open_email_canvas", map[string]any{
		"to": "amy@example.com", "subject": "Wed pickup", "body": "Hi Amy,\n\nWed 9 am at the airport?",
	})
	documentID, _ := opened["document_id"].(string)
	state := func(documentID string) map[string]any {
		t.Helper()
		status, _, body := env.request(alice, http.MethodGet, "/v0/documents/"+documentID+"/mail", nil, "")
		var decoded map[string]any
		if status != http.StatusOK || json.Unmarshal(body, &decoded) != nil {
			t.Fatalf("mail state=%d %s", status, body)
		}
		return decoded
	}
	if documentID == "" || state(documentID)["target"] != "feishu_mail" {
		t.Fatalf("open=%v", opened)
	}
	saved := call("lt_save", "save-1", "save_email_draft", map[string]any{"document_id": documentID})
	draftID, _ := saved["draft_id"].(string)
	if saved["status"] != "saved" || draftID == "" {
		t.Fatalf("save=%v", saved)
	}
	draft, err := feishu.ParseMessage(fake.draft(draftID))
	if err != nil || !slices.Equal(draft.To, []string{"amy@example.com"}) || draft.Subject != "Wed pickup" || !strings.Contains(draft.HTML, "airport") {
		t.Fatalf("Feishu draft=%+v err=%v", draft, err)
	}
	asked := call("lt_ask", "send-1", "send_email_canvas", map[string]any{"document_id": documentID, "confirmed": false})
	if asked["status"] != "needs_confirmation" || len(fake.sentDrafts()) != 0 {
		t.Fatalf("ask=%v sent=%v", asked, fake.sentDrafts())
	}
	if sent := call("lt_yes", "send-2", "send_email_canvas", map[string]any{"document_id": documentID, "confirmed": true}); sent["status"] != "sent" {
		t.Fatalf("send=%v", sent)
	}
	if !slices.Equal(fake.sentDrafts(), []string{draftID}) {
		t.Fatalf("sent=%v", fake.sentDrafts())
	}

	// The Human sends another canvas from its card in the chat.
	second := call("lt_write_2", "email-2", "open_email_canvas", map[string]any{
		"to": "bob@example.com", "subject": "Budget", "body": "Hi Bob,\n\nBudget attached soon.",
	})
	secondID, _ := second["document_id"].(string)
	current := state(secondID)
	status, _, body := env.request(alice, http.MethodPost, "/v0/documents/"+secondID+"/mail", map[string]string{
		"connection_id": connectionID, "request_id": "request-feishu-000001", "source_digest": current["source_digest"].(string),
	}, "")
	if status != http.StatusAccepted {
		t.Fatalf("card send=%d %s", status, body)
	}
	deadline := time.Now().Add(20 * time.Second)
	for state(secondID)["status"] != "sent" {
		if time.Now().After(deadline) {
			t.Fatalf("card delivery=%v", state(secondID))
		}
		time.Sleep(100 * time.Millisecond)
	}
	if sent := fake.sentDrafts(); len(sent) != 2 {
		t.Fatalf("sent=%v", sent)
	}
}
