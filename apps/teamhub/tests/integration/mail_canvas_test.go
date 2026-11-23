package integration_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	teamhubinternal "github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// The Human sends a Gmail canvas from its chat card: editing never reaches
// Gmail, Send uploads and sends exactly the reviewed version once, and Don't
// send is final.
func TestHumanSendsAGmailCanvasOnlyWhenSendIsClicked(t *testing.T) {
	allowParallelIntegrationTest(t)
	humanSendsMailCanvasOnlyWhenSendIsClicked(t, "gmail")
}

func TestHumanSendsAnOutlookCanvasOnlyWhenSendIsClicked(t *testing.T) {
	allowParallelIntegrationTest(t)
	humanSendsMailCanvasOnlyWhenSendIsClicked(t, "outlook")
}

func humanSendsMailCanvasOnlyWhenSendIsClicked(t *testing.T, target string) {
	t.Helper()
	var computes atomic.Int32
	replaced := make(chan string, 32)
	var bodies *pgxpool.Pool
	runtime := canvasRuntime(t, &computes, replaced, func() *pgxpool.Pool { return bodies })
	composioFake := newFakeComposio(t)
	var mu sync.Mutex
	var saves, sends int
	failNextUpload, failNextSend, draftGone := false, false, false
	composioFake.setIntercept(func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v3.1/tools/execute/proxy" {
			return false
		}
		var request struct {
			Endpoint string `json:"endpoint"`
			Method   string `json:"method"`
		}
		if json.NewDecoder(r.Body).Decode(&request) != nil {
			return false
		}
		mu.Lock()
		defer mu.Unlock()
		data := json.RawMessage(`{"id":"draft-1","message":{"id":"message-1","threadId":"thread-1"}}`)
		if failNextUpload && !strings.HasSuffix(request.Endpoint, "/send") {
			failNextUpload = false
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"message": "rejected"}})
			return true
		}
		if draftGone && !strings.HasSuffix(request.Endpoint, "/send") {
			draftGone = false
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"message": "not found"}})
			return true
		}
		if failNextSend && strings.HasSuffix(request.Endpoint, "/send") {
			failNextSend = false
			w.WriteHeader(http.StatusBadGateway)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"message": "upstream"}})
			return true
		}
		if target == "outlook" && request.Method == http.MethodGet {
			if strings.HasSuffix(request.Endpoint, "/attachments") {
				data = json.RawMessage(`{"value":[]}`)
			} else {
				data = json.RawMessage(`{"id":"draft-1","isDraft":true}`)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"status": http.StatusOK, "data": data})
			return true
		}
		if strings.HasSuffix(request.Endpoint, "/send") {
			sends++
			data = json.RawMessage(`{"id":"sent-1"}`)
		} else {
			saves++
		}
		status := http.StatusOK
		if target == "outlook" {
			data = json.RawMessage(`{"id":"draft-1","isDraft":true}`)
			if strings.HasSuffix(request.Endpoint, "/send") {
				status = http.StatusAccepted
				data = nil
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": status, "data": data})
		return true
	})
	counts := func() (int, int) {
		mu.Lock()
		defer mu.Unlock()
		return saves, sends
	}
	env, alice, _, sessionID := newVoiceLiveRoomWith(t, []appOption{starting(app.JobQueue)}, func(cfg *config.Config) {
		cfg.RoomDocument.RuntimeURL = runtime.URL
		composioFake.configure(cfg)
	})
	bodies = env.pool
	composioFake.seedAccount(t, env.pool, "ca_mail_"+target, "account_alice", target, composio.ConnectionActive)
	if _, err := env.pool.Exec(t.Context(), strings.ReplaceAll(`
 INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,revision,remote_principal_key,identity_label,toolkit_slug,auth_config_id,auto_reminders) VALUES('connection_mail_gmail','account_alice','gmail','ca_mail_gmail','active',1,'gmail:alice@example.test','alice@example.test','gmail','ac_gmail',false);
 INSERT INTO external_connection_agent_grants(id,connection_id,tenant_id,agent_actor_id,represented_human_actor_id,status) VALUES('grant_mail_gmail','connection_mail_gmail','tenant_acme','actor_acme_official','actor_acme_alice','active')`, "gmail", target)); err != nil {
		t.Fatal(err)
	}
	voice := func(callID, name string, arguments map[string]any) map[string]string {
		t.Helper()
		encoded, _ := json.Marshal(arguments)
		var result teamhubinternal.VoiceLiveToolResult
		decode(t, voiceRuntimeCall(t, env, http.MethodPost, "/internal/v1/voice/live-tool-calls", map[string]any{
			"voice_session_id": sessionID, "turn_id": "lt_" + callID, "call_id": callID, "name": name, "arguments": string(encoded),
		}, http.StatusOK), &result)
		var output map[string]string
		if err := json.Unmarshal([]byte(result.Output), &output); err != nil {
			t.Fatalf("%s=%s", callID, result.Output)
		}
		return output
	}
	open := func(callID, subject string) string {
		t.Helper()
		output := voice(callID, "open_email_canvas", map[string]any{"to": "amy@example.com", "subject": subject, "body": "Hi Amy,\n\nSee you Wednesday."})
		if output["document_id"] == "" {
			t.Fatalf("open=%v", output)
		}
		return output["document_id"]
	}
	type mailState struct {
		Status       string `json:"status"`
		Subject      string `json:"subject"`
		To           string `json:"to"`
		Error        string `json:"error"`
		SourceDigest string `json:"source_digest"`
	}
	read := func(documentID string) mailState {
		t.Helper()
		status, _, body := env.request(alice, http.MethodGet, "/v0/documents/"+documentID+"/mail", nil, "")
		var state mailState
		if status != http.StatusOK || json.Unmarshal(body, &state) != nil {
			t.Fatalf("read mail=%d %s", status, body)
		}
		return state
	}
	send := func(documentID, requestID, digest string) (int, []byte) {
		status, _, body := env.request(alice, http.MethodPost, "/v0/documents/"+documentID+"/mail", map[string]string{
			"connection_id": "connection_mail_" + target, "request_id": requestID, "source_digest": digest,
		}, "")
		return status, body
	}

	documentID := open("mail-1", "Wed pickup")
	draft := read(documentID)
	if draft.Status != "draft" || draft.Subject != "Wed pickup" || draft.To != "amy@example.com" || !strings.HasPrefix(draft.SourceDigest, "sha256:") {
		t.Fatalf("draft=%+v", draft)
	}
	// Opening and reading the email never reaches Gmail.
	if s, n := counts(); s != 0 || n != 0 {
		t.Fatalf("before Send saves=%d sends=%d", s, n)
	}
	// A version the Human did not review is refused.
	if status, body := send(documentID, "request-stale-0000001", "sha256:"+strings.Repeat("0", 64)); status != http.StatusConflict {
		t.Fatalf("stale digest=%d %s", status, body)
	}
	settle := func(documentID string) string {
		t.Helper()
		deadline := time.Now().Add(20 * time.Second)
		for {
			if status := read(documentID).Status; status != "queued" && status != "uploading" && status != "sending" {
				return status
			}
			if time.Now().After(deadline) {
				t.Fatalf("delivery did not settle: %+v", read(documentID))
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	// A rejected upload sent nothing, so the email can be sent again.
	mu.Lock()
	failNextUpload = true
	mu.Unlock()
	if status, body := send(documentID, "request-fail-00000001", draft.SourceDigest); status != http.StatusAccepted {
		t.Fatalf("send=%d %s", status, body)
	}
	if status := settle(documentID); status != "failed" {
		t.Fatalf("rejected upload=%s", status)
	}
	if s, n := counts(); s != 0 || n != 0 {
		t.Fatalf("after rejected upload saves=%d sends=%d", s, n)
	}
	if status, body := send(documentID, "request-send-00000001", draft.SourceDigest); status != http.StatusAccepted {
		t.Fatalf("send=%d %s", status, body)
	}
	deadline := time.Now().Add(20 * time.Second)
	for read(documentID).Status != "sent" {
		if time.Now().After(deadline) {
			var job string
			_ = env.pool.QueryRow(t.Context(), `SELECT state||' attempt='||attempt||' queue='||queue||' errors='||coalesce(errors::text,'') FROM river_job WHERE kind='mail.canvas_delivery'`).Scan(&job)
			t.Fatalf("delivery did not finish: %+v job=%s", read(documentID), job)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if s, n := counts(); s != 1 || n != 1 {
		t.Fatalf("after Send saves=%d sends=%d", s, n)
	}
	// The card's delivery is the record: voice cannot send it again, even
	// though no editor wrote the sent status into the canvas header.
	if again := voice("mail-voice", "send_email_canvas", map[string]any{"document_id": documentID, "confirmed": true}); again["error"] != "already_sent" {
		t.Fatalf("voice resend=%v", again)
	}
	// The same click replays its receipt; another one cannot send it again.
	if status, body := send(documentID, "request-send-00000001", draft.SourceDigest); status != http.StatusAccepted || !strings.Contains(string(body), `"sent"`) {
		t.Fatalf("replayed send=%d %s", status, body)
	}
	if status, body := send(documentID, "request-send-00000002", draft.SourceDigest); status != http.StatusConflict {
		t.Fatalf("second send=%d %s", status, body)
	}
	if status, _, body := env.request(alice, http.MethodPost, "/v0/documents/"+documentID+"/mail/decline", nil, ""); status != http.StatusConflict {
		t.Fatalf("decline after send=%d %s", status, body)
	}

	// Don't send is final and never reaches Gmail.
	declinedID := open("mail-2", "Thu pickup")
	if status, _, body := env.request(alice, http.MethodPost, "/v0/documents/"+declinedID+"/mail/decline", nil, ""); status != http.StatusOK || !strings.Contains(string(body), `"declined"`) {
		t.Fatalf("decline=%d %s", status, body)
	}
	if status, body := send(declinedID, "request-send-00000003", read(declinedID).SourceDigest); status != http.StatusConflict {
		t.Fatalf("send after decline=%d %s", status, body)
	}
	if s, n := counts(); s != 1 || n != 1 {
		t.Fatalf("after decline saves=%d sends=%d", s, n)
	}

	// An unconfirmed send is unknown; after checking Gmail the Human may send
	// it again instead of being stuck.
	unsureID := open("mail-3", "Fri pickup")
	mu.Lock()
	failNextSend = true
	mu.Unlock()
	if status, body := send(unsureID, "request-send-00000004", read(unsureID).SourceDigest); status != http.StatusAccepted {
		t.Fatalf("send=%d %s", status, body)
	}
	if status := settle(unsureID); status != "unknown" {
		t.Fatalf("unconfirmed send=%s", status)
	}
	if again := voice("mail-voice-3", "send_email_canvas", map[string]any{"document_id": unsureID, "confirmed": true}); again["error"] != "already_sent" {
		t.Fatalf("voice send of an unknown delivery=%v", again)
	}
	// A transient upload error keeps the draft and says nothing was sent.
	mu.Lock()
	failNextUpload = true
	mu.Unlock()
	if status, body := send(unsureID, "request-send-00000007", read(unsureID).SourceDigest); status != http.StatusAccepted {
		t.Fatalf("send again after unknown=%d %s", status, body)
	}
	if status := settle(unsureID); status != "failed" || !strings.Contains(read(unsureID).Error, "Nothing was sent") {
		t.Fatalf("transient upload error=%s %+v", status, read(unsureID))
	}
	// Gmail no longer has the earlier draft, as after a send that went out:
	// the card says it may have been sent instead of "nothing was sent".
	mu.Lock()
	draftGone = true
	mu.Unlock()
	if status, body := send(unsureID, "request-send-00000005", read(unsureID).SourceDigest); status != http.StatusAccepted {
		t.Fatalf("send again after unknown=%d %s", status, body)
	}
	if status := settle(unsureID); status != "failed" || !strings.Contains(read(unsureID).Error, "may already have been sent") {
		t.Fatalf("lost draft=%s %+v", status, read(unsureID))
	}
	if status, body := send(unsureID, "request-send-00000006", read(unsureID).SourceDigest); status != http.StatusAccepted {
		t.Fatalf("send after checking Gmail=%d %s", status, body)
	}
	if status := settle(unsureID); status != "sent" {
		t.Fatalf("resend after unknown=%s", status)
	}
	if target == "outlook" {
		composioFake.seedAccount(t, env.pool, "ca_second_gmail", "account_alice", "gmail", composio.ConnectionActive)
		if _, err := env.pool.Exec(t.Context(), `
 INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,identity_label,toolkit_slug,auth_config_id,auto_reminders) VALUES('connection_second_gmail','account_alice','gmail','ca_second_gmail','active','alice@gmail.test','gmail','ac_gmail',false);
 INSERT INTO external_connection_agent_grants(id,connection_id,tenant_id,agent_actor_id,represented_human_actor_id,status) VALUES('grant_second_gmail','connection_second_gmail','tenant_acme','actor_acme_official','actor_acme_alice','active')`); err != nil {
			t.Fatal(err)
		}
		args := map[string]any{"to": "bob@example.test", "subject": "Choose sender", "body": "Hello"}
		if output := voice("mail-ambiguous", "open_email_canvas", args); output["error"] != "mail_app_required" {
			t.Fatalf("ambiguous app=%v", output)
		}
		args["app"] = "outlook"
		if output := voice("mail-explicit", "open_email_canvas", args); output["document_id"] == "" {
			t.Fatalf("explicit Outlook=%v", output)
		}
	}
}
