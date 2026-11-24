package integration_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/mail"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	nodeapi "github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

// fakeFeishu is the owner's Computer as Feishu Mail reaches it: the
// feishu_mail tools its Daemon runs through the owner's lark-cli, over a fake
// mailbox. It records which Computer each call reached.
type fakeFeishu struct {
	*recordingLocalComputers
	t  *testing.T
	mu sync.Mutex
	// The owner's lark-cli: logged in with every mail scope, to address, the
	// scopes its app does not enable, and the logins started on it, approved
	// or not.
	loggedIn      bool
	notInstalled  bool
	notConfigured bool
	address       string
	notEnabled    []string
	logins        map[string]bool
	targets       []nodeapi.LocalComputerToolCall
	// The mailbox: its messages by ID and folder, saved drafts by ID, the
	// drafts sent, and the moves made.
	mail    map[string]map[string]any
	folders map[string][]string
	drafts  map[string][]byte
	sent    []string
	moves   []map[string]any
}

// fakeFeishuMessage is one message of the fake mailbox, received hoursAgo.
func fakeFeishuMessage(id, from, subject, body string, hoursAgo float64, state int) map[string]any {
	encoded := func(text string) string { return base64.URLEncoding.EncodeToString([]byte(text)) }
	return map[string]any{
		"message_id": id, "thread_id": "thread_" + id, "subject": subject, "message_state": state,
		"internal_date": strconv.FormatInt(time.Now().Add(-time.Duration(hoursAgo*float64(time.Hour))).UnixMilli(), 10),
		"head_from":     map[string]any{"mail_address": from}, "to": []any{map[string]any{"mail_address": "zhang@example.com"}},
		"label_ids": []string{"UNREAD"}, "body_preview": encoded(body), "body_plain_text": encoded(body),
	}
}

func newFakeFeishu(t *testing.T) *fakeFeishu {
	t.Helper()
	return &fakeFeishu{recordingLocalComputers: &recordingLocalComputers{}, t: t, address: "Zhang@Example.com", logins: map[string]bool{}, drafts: map[string][]byte{},
		mail: map[string]map[string]any{
			"msg_1":       fakeFeishuMessage("msg_1", "alice@example.com", "Quarterly plan", "Can we meet?", 1, 1),
			"msg_receipt": fakeFeishuMessage("msg_receipt", "no-reply@shop.example.com", "Your receipt", "Paid", 2, 1),
			"msg_old":     fakeFeishuMessage("msg_old", "carol@example.com", "Old news", "Long ago", 240, 1),
			"msg_sent":    fakeFeishuMessage("msg_sent", "zhang@example.com", "Re: Quarterly plan", "Friday works", 0.5, 2),
		},
		folders: map[string][]string{"INBOX": {"msg_1", "msg_receipt", "msg_old"}, "SENT": {"msg_sent"}},
	}
}

// withFeishuComputer makes fake the Computer every owner's Feishu Mail runs on.
func withFeishuComputer(fake *fakeFeishu) appOption { return withLocalComputers(fake) }

func (f *fakeFeishu) CallLocalComputerToolResult(_ context.Context, call nodeapi.LocalComputerToolCall) (map[string]any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if call.Server != nodeapi.FeishuMail {
		f.t.Errorf("unexpected Computer tool server %s", call.Server)
		return map[string]any{"status": "unavailable"}, nil
	}
	f.targets = append(f.targets, call)
	// The arguments reach the Computer as JSON.
	var arguments map[string]any
	if encoded, err := json.Marshal(call.Arguments); err != nil || json.Unmarshal(encoded, &arguments) != nil {
		f.t.Errorf("arguments do not survive JSON: %v", call.Arguments)
	}
	loginID, _ := arguments["login_id"].(string)
	if f.notInstalled {
		return map[string]any{"status": "not_installed"}, nil
	}
	if f.notConfigured {
		return map[string]any{"status": "not_configured", "error_type": "config"}, nil
	}
	switch call.ToolName {
	case "status":
		switch {
		case !f.loggedIn:
			return map[string]any{"status": "auth_required"}, nil
		case len(f.notEnabled) > 0:
			return map[string]any{"status": "missing_scope", "missing_scopes": anyList(f.notEnabled), "app_missing_scopes": anyList(f.notEnabled), "app_id": "cli_fake", "brand": "feishu"}, nil
		}
		return map[string]any{"status": "ok", "address": f.address}, nil
	case "login_start":
		f.logins[loginID] = false
		return map[string]any{"status": "ok", "verification_url": "https://accounts.feishu.cn/oauth/v1/device/verify?flow=" + loginID, "expires_in": float64(600)}, nil
	case "login_wait":
		approved, ok := f.logins[loginID]
		switch {
		case !ok:
			return map[string]any{"status": "expired"}, nil
		case !approved:
			return map[string]any{"status": "pending"}, nil
		}
		delete(f.logins, loginID)
		f.loggedIn = true
		return map[string]any{"status": "ok"}, nil
	case "api":
		if !f.loggedIn {
			return map[string]any{"status": "auth_required"}, nil
		}
		method, _ := arguments["method"].(string)
		path, _ := arguments["path"].(string)
		mailPath, ok := strings.CutPrefix(path, "/open-apis/mail/v1/user_mailboxes/me/")
		if !ok {
			f.t.Errorf("a Feishu Mail call left the mailbox: %s", path)
			return map[string]any{"status": "invalid_request"}, nil
		}
		params, _ := arguments["params"].(map[string]any)
		data, _ := arguments["data"].(map[string]any)
		return f.serveMail(method, mailPath, params, data), nil
	}
	f.t.Errorf("unexpected Feishu Mail tool %s", call.ToolName)
	return map[string]any{"status": "unavailable"}, nil
}

// serveMail answers the mail API as lark-cli relays it: the response's data,
// or a refusal with Feishu's code.
func (f *fakeFeishu) serveMail(method, path string, params, body map[string]any) map[string]any {
	ok := func(data map[string]any) map[string]any { return map[string]any{"status": "ok", "data": data} }
	switch {
	case method == http.MethodGet && path == "messages":
		ids, found := f.folders[fmt.Sprint(params["folder_id"])]
		if !found {
			return map[string]any{"status": "failed", "code": float64(1230001), "detail": "folder_id required"}
		}
		return ok(map[string]any{"items": anyList(ids), "has_more": false})
	case method == http.MethodPost && path == "messages/batch_get":
		ids, _ := body["message_ids"].([]any)
		messages := make([]any, 0, len(ids))
		for _, id := range ids {
			if message, found := f.mail[fmt.Sprint(id)]; found {
				messages = append(messages, message)
			}
		}
		return ok(map[string]any{"messages": messages})
	case method == http.MethodGet && strings.HasPrefix(path, "messages/"):
		message, found := f.mail[strings.TrimPrefix(path, "messages/")]
		if !found {
			return map[string]any{"status": "failed", "code": float64(1234008), "error_subtype": "not_found", "detail": "message not found"}
		}
		return ok(map[string]any{"message": message})
	case method == http.MethodGet && path == "profile":
		return ok(map[string]any{"primary_email_address": f.address})
	case method == http.MethodPost && path == "drafts":
		raw, err := base64.URLEncoding.DecodeString(fmt.Sprint(body["raw"]))
		if err != nil {
			return map[string]any{"status": "failed", "code": float64(1230001), "detail": "raw must be base64url"}
		}
		// Feishu refuses a draft that does not name its sender.
		if parsed, err := mail.ReadMessage(bytes.NewReader(raw)); err != nil || parsed.Header.Get("From") != "zhang@example.com" {
			return map[string]any{"status": "failed", "code": float64(1230001), "detail": "invalid mime format"}
		}
		id := fmt.Sprintf("draft_%d", len(f.drafts)+1)
		f.drafts[id] = raw
		return ok(map[string]any{"draft": map[string]any{"id": id}})
	case method == http.MethodGet && strings.HasPrefix(path, "drafts/"):
		id := strings.TrimPrefix(path, "drafts/")
		return ok(map[string]any{"draft": map[string]any{
			"id": id, "message": map[string]any{"message_id": "draft_message_" + id, "raw": base64.URLEncoding.EncodeToString(f.drafts[id])},
		}})
	case method == http.MethodPost && strings.HasPrefix(path, "drafts/") && strings.HasSuffix(path, "/send"):
		id := strings.TrimSuffix(strings.TrimPrefix(path, "drafts/"), "/send")
		f.sent = append(f.sent, id)
		return ok(map[string]any{"message_id": "sent_" + id, "thread_id": "thread_sent"})
	case method == http.MethodPost && path == "messages/batch_modify":
		f.moves = append(f.moves, body)
		return ok(map[string]any{})
	}
	f.t.Errorf("unexpected Feishu mail request %s %s", method, path)
	return map[string]any{"status": "failed", "code": float64(404)}
}

func anyList(values []string) []any {
	list := make([]any, len(values))
	for i, value := range values {
		list[i] = value
	}
	return list
}

func (f *fakeFeishu) approveLogins() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for id := range f.logins {
		f.logins[id] = true
	}
}

func (f *fakeFeishu) setLoggedIn(loggedIn bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.loggedIn = loggedIn
}

// setNotInstalled takes lark-cli off the owner's Computer.
func (f *fakeFeishu) setNotInstalled(notInstalled bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.notInstalled = notInstalled
}

// setNotConfigured leaves the owner's lark-cli without a Feishu app.
func (f *fakeFeishu) setNotConfigured(notConfigured bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.notConfigured = notConfigured
}

// setAddress logs the owner's lark-cli in to another mailbox.
func (f *fakeFeishu) setAddress(address string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.address = address
}

// apiPaths lists the mailbox paths of the api calls made so far.
func (f *fakeFeishu) apiPaths() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	paths := []string{}
	for _, call := range f.targets {
		if call.ToolName == "api" {
			encoded, _ := json.Marshal(call.Arguments)
			var arguments struct {
				Path string `json:"path"`
			}
			_ = json.Unmarshal(encoded, &arguments)
			paths = append(paths, strings.TrimPrefix(arguments.Path, "/open-apis/mail/v1/user_mailboxes/me/"))
		}
	}
	return paths
}

func (f *fakeFeishu) setNotEnabled(scopes ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.notEnabled = scopes
}

func (f *fakeFeishu) sentDrafts() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.sent)
}

func (f *fakeFeishu) draft(id string) []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.drafts[id]
}

func (f *fakeFeishu) movesMade() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.moves)
}

func (f *fakeFeishu) computersReached() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	reached := []string{}
	for _, call := range f.targets {
		if !slices.Contains(reached, call.ComputerId) {
			reached = append(reached, call.ComputerId)
		}
	}
	return reached
}

// authorizeFeishuMail connects alice's mailbox through a lark-cli login on
// her AnotherMe's Computer and returns the active connection. approve, when
// set, runs while the connection waits on the login, as the Connect button of
// a chat card does.
func authorizeFeishuMail(t *testing.T, env *testEnv, alice *http.Client, fake *fakeFeishu, approve func(connectionID string)) string {
	t.Helper()
	runAliceAnotherMeOnAComputer(t, env)
	connectionID, connectURL := createFeishuMailConnection(t, env, alice, "feishu-connect")
	if !strings.HasPrefix(connectURL, "https://accounts.feishu.cn/") {
		t.Fatalf("connect URL = %q", connectURL)
	}
	if approve != nil {
		approve(connectionID)
	}
	finishFeishuLogin(t, env, alice, fake, connectionID)
	return connectionID
}

// finishFeishuLogin approves the lark-cli logins on the fake Computer, as the
// owner does on Feishu's page, and waits for the connection to turn active.
// The connection's checks poll the login; asking for its check at once, as a
// returning authorization window does, keeps the test off the test database
// container's clock, which may run ahead of this process.
func finishFeishuLogin(t *testing.T, env *testEnv, alice *http.Client, fake *fakeFeishu, connectionID string) {
	t.Helper()
	fake.approveLogins()
	checkFeishuConnectionNow(t, env, alice, connectionID)
	if !waitForExternalSource(func() bool { return feishuConnectionStatus(t, env, connectionID) == "active" }) {
		t.Fatalf("the Feishu Mail connection stayed %s", feishuConnectionStatus(t, env, connectionID))
	}
}

func checkFeishuConnectionNow(t *testing.T, env *testEnv, alice *http.Client, connectionID string) {
	t.Helper()
	var upstreamID string
	if err := env.pool.QueryRow(t.Context(), `SELECT upstream_connection_id FROM external_connections WHERE id=$1`, connectionID).Scan(&upstreamID); err != nil {
		t.Fatal(err)
	}
	if status, _, body := env.request(alice, http.MethodPost, "/v0/external-connection-completions", map[string]string{"connected_account_id": upstreamID}, ""); status != http.StatusNoContent {
		t.Fatalf("check now status=%d body=%s", status, body)
	}
}

// runAliceAnotherMeOnAComputer puts alice's active AnotherMe on her online
// fixture Computer, whose lark-cli Feishu Mail runs through.
func runAliceAnotherMeOnAComputer(t *testing.T, env *testEnv) {
	t.Helper()
	actorID := anotherMeActorID(t, env, acmeTenant, "actor_acme_alice")
	if actorID == "" {
		if connectAnotherMeComputer(t, env, acmeTenant, "actor_acme_alice") == "" {
			t.Fatal("alice has no AnotherMe to run Feishu Mail through")
		}
		return
	}
	seedAnotherMeComputers(t, env.pool)
	bindLocalFixtureRegistration(t, env.pool, actorID)
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET agent_management_id=coalesce(agent_management_id,'agent_alice_another_me') WHERE actor_id=$1`, actorID); err != nil {
		t.Fatal(err)
	}
}

func createFeishuMailConnection(t *testing.T, env *testEnv, alice *http.Client, key string) (string, string) {
	t.Helper()
	status, _, body := env.request(alice, http.MethodPost, "/v0/external-connections", map[string]string{"app_key": externalsource.FeishuMailAppKey}, key)
	if status != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", status, body)
	}
	var connection struct {
		ID         string `json:"id"`
		Status     string `json:"status"`
		ConnectURL string `json:"connect_url"`
	}
	decode(t, body, &connection)
	if connection.Status != "pending" {
		t.Fatalf("connection = %s", body)
	}
	return connection.ID, connection.ConnectURL
}

func feishuConnectionStatus(t *testing.T, env *testEnv, connectionID string) string {
	t.Helper()
	var current string
	if err := env.pool.QueryRow(t.Context(), `SELECT status FROM external_connections WHERE id=$1`, connectionID).Scan(&current); err != nil {
		t.Fatal(err)
	}
	return current
}

func TestFeishuMailConnectsThroughTheOwnersLarkCLI(t *testing.T) {
	allowParallelIntegrationTest(t)
	fake := newFakeFeishu(t)
	env, alice := newTaskWorkerEnv(t, starting(app.JobQueue), withAgentManagement(&recordingAgentManagement{}), withFeishuComputer(fake),
		withConfig(func(cfg *config.Config) { cfg.Jobs.PollInterval = riverTestPollInterval }))

	// Reaching owners' Computers makes Feishu Mail available without Composio.
	status, _, body := env.request(alice, http.MethodGet, "/v0/external-apps", nil, "")
	if status != http.StatusOK || !strings.Contains(string(body), `"key":"feishu_mail"`) {
		t.Fatalf("list apps status=%d body=%s", status, body)
	}

	// Without an online Computer running her AnotherMe, there is no lark-cli
	// to run.
	status, _, body = env.request(alice, http.MethodPost, "/v0/external-connections", map[string]string{"app_key": externalsource.FeishuMailAppKey}, "feishu-offline")
	if status != http.StatusConflict || !strings.Contains(string(body), "FEISHU_COMPUTER_OFFLINE") {
		t.Fatalf("offline status=%d body=%s", status, body)
	}
	if connectAnotherMeComputer(t, env, acmeTenant, "actor_acme_alice") == "" {
		t.Fatal("alice has no AnotherMe")
	}
	computerID := anotherMeFixtureComputerID(acmeTenant, "actor_acme_alice")

	// A scope the lark-cli app does not enable cannot be granted by logging in.
	fake.setLoggedIn(true)
	fake.setNotEnabled("mail:user_mailbox.message:send")
	status, _, body = env.request(alice, http.MethodPost, "/v0/external-connections", map[string]string{"app_key": externalsource.FeishuMailAppKey}, "feishu-scopes")
	if status != http.StatusConflict || !strings.Contains(string(body), "FEISHU_SCOPES_NOT_ENABLED") || !strings.Contains(string(body), "mail:user_mailbox.message:send") ||
		!strings.Contains(string(body), "https://open.feishu.cn/app/cli_fake/auth") {
		t.Fatalf("scopes status=%d body=%s", status, body)
	}
	fake.setNotEnabled()

	// Logged out, connecting starts a lark-cli login whose page is the link;
	// the connection stays pending until alice finishes it.
	fake.setLoggedIn(false)
	connectionID, connectURL := createFeishuMailConnection(t, env, alice, "feishu-login")
	if !strings.HasPrefix(connectURL, "https://accounts.feishu.cn/") {
		t.Fatalf("connect URL = %q", connectURL)
	}
	if current := feishuConnectionStatus(t, env, connectionID); current != "pending" {
		t.Fatalf("status before the login finished = %s", current)
	}
	finishFeishuLogin(t, env, alice, fake, connectionID)
	var label, principal, toolkit, authConfig string
	if err := env.pool.QueryRow(t.Context(), `SELECT coalesce(identity_label,''),coalesce(remote_principal_key,''),toolkit_slug,auth_config_id FROM external_connections WHERE id=$1`, connectionID).Scan(&label, &principal, &toolkit, &authConfig); err != nil {
		t.Fatal(err)
	}
	if label != "zhang@example.com" || principal != "feishu_mail:zhang@example.com" || toolkit != "feishu" || authConfig != "lark-cli" {
		t.Fatalf("label=%s principal=%s toolkit=%s auth_config=%s", label, principal, toolkit, authConfig)
	}
	if reached := fake.computersReached(); !slices.Equal(reached, []string{computerID}) {
		t.Fatalf("Computers reached = %v, want alice's %s", reached, computerID)
	}

	// A lark-cli that no longer serves the mailbox expires the connection at
	// its next check.
	fake.setLoggedIn(false)
	revision := func(connectionID string) int64 {
		t.Helper()
		var current int64
		if err := env.pool.QueryRow(t.Context(), `SELECT revision FROM external_connections WHERE id=$1`, connectionID).Scan(&current); err != nil {
			t.Fatal(err)
		}
		return current
	}
	status, _, body = env.request(alice, http.MethodPost, "/v0/external-connections/"+connectionID+"/status-checks", map[string]int64{"expected_revision": revision(connectionID)}, "")
	if status != http.StatusOK && status != http.StatusCreated && status != http.StatusAccepted {
		t.Fatalf("status check status=%d body=%s", status, body)
	}
	if !waitForExternalSource(func() bool { return feishuConnectionStatus(t, env, connectionID) == "expired" }) {
		t.Fatalf("status after logging out = %s", feishuConnectionStatus(t, env, connectionID))
	}

	// Disconnecting leaves the owner's lark-cli login alone: it serves their
	// other uses too.
	status, _, body = env.request(alice, http.MethodPost, "/v0/external-connections/"+connectionID+"/disconnects", map[string]int64{"expected_revision": revision(connectionID)}, "")
	if status != http.StatusOK && status != http.StatusAccepted {
		t.Fatalf("disconnect status=%d body=%s", status, body)
	}
	if !waitForExternalSource(func() bool { return feishuConnectionStatus(t, env, connectionID) == "revoked" }) {
		t.Fatalf("status after disconnect = %s", feishuConnectionStatus(t, env, connectionID))
	}

	// Already logged in, a connection needs no login page.
	fake.setLoggedIn(true)
	againID, againURL := createFeishuMailConnection(t, env, alice, "feishu-again")
	checkFeishuConnectionNow(t, env, alice, againID)
	if againURL != "" || !waitForExternalSource(func() bool { return feishuConnectionStatus(t, env, againID) == "active" }) {
		t.Fatalf("connection while logged in url=%q status=%s", againURL, feishuConnectionStatus(t, env, againID))
	}

	// lark-cli acts as whoever is logged in to it now: switched to another
	// mailbox, it no longer serves this connection, which expires.
	fake.setAddress("other@example.com")
	status, _, body = env.request(alice, http.MethodPost, "/v0/external-connections/"+againID+"/status-checks", map[string]int64{"expected_revision": revision(againID)}, "")
	if status != http.StatusOK && status != http.StatusCreated && status != http.StatusAccepted {
		t.Fatalf("status check status=%d body=%s", status, body)
	}
	if !waitForExternalSource(func() bool { return feishuConnectionStatus(t, env, againID) == "expired" }) {
		t.Fatalf("status after switching mailboxes = %s", feishuConnectionStatus(t, env, againID))
	}
}
