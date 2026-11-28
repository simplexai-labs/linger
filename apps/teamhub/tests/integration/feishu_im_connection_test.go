package integration_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	nodeapi "github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

// fakeFeishuIM is the owner's Computer as Feishu IM reaches it: the feishu_im
// tools its Daemon runs through the owner's lark-cli, over a fake account.
type fakeFeishuIM struct {
	*recordingLocalComputers
	t  *testing.T
	mu sync.Mutex
	// The owner's lark-cli: logged in, the scopes its app does not enable, and
	// the logins started on it.
	loggedIn   bool
	openID     string
	name       string
	notEnabled []string
	logins     map[string]bool
}

func newFakeFeishuIM(t *testing.T) *fakeFeishuIM {
	t.Helper()
	return &fakeFeishuIM{recordingLocalComputers: &recordingLocalComputers{}, t: t, openID: "ou_alice", name: "Alice Zhang", logins: map[string]bool{}}
}

func (f *fakeFeishuIM) setLoggedIn(value bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.loggedIn = value
}

func (f *fakeFeishuIM) setNotEnabled(scopes ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.notEnabled = scopes
}

// approveLogins finishes every started login, as the owner does on Feishu's page.
func (f *fakeFeishuIM) approveLogins() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for id := range f.logins {
		f.logins[id] = true
	}
}

func (f *fakeFeishuIM) CallLocalComputerToolResult(_ context.Context, call nodeapi.LocalComputerToolCall) (map[string]any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if call.Server != nodeapi.FeishuIm {
		f.t.Errorf("unexpected Computer tool server %s", call.Server)
		return map[string]any{"status": "unavailable"}, nil
	}
	var arguments map[string]any
	if encoded, err := json.Marshal(call.Arguments); err != nil || json.Unmarshal(encoded, &arguments) != nil {
		f.t.Errorf("arguments do not survive JSON: %v", call.Arguments)
	}
	loginID, _ := arguments["login_id"].(string)
	switch call.ToolName {
	case "status":
		switch {
		case !f.loggedIn:
			return map[string]any{"status": "auth_required"}, nil
		case len(f.notEnabled) > 0:
			return map[string]any{"status": "missing_scope", "missing_scopes": anyList(f.notEnabled), "app_missing_scopes": anyList(f.notEnabled), "app_id": "cli_fake", "brand": "feishu"}, nil
		}
		return map[string]any{"status": "ok"}, nil
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
		path, _ := arguments["path"].(string)
		if path == "/open-apis/authen/v1/user_info" {
			return map[string]any{"status": "ok", "data": map[string]any{"open_id": f.openID, "name": f.name}}, nil
		}
		if !strings.HasPrefix(path, "/open-apis/im/v1/") {
			f.t.Errorf("a Feishu IM call left IM: %s", path)
			return map[string]any{"status": "invalid_request"}, nil
		}
		return map[string]any{"status": "ok", "data": map[string]any{"items": []any{}}}, nil
	}
	return map[string]any{"status": "unavailable"}, nil
}

func withFeishuIMComputer(fake *fakeFeishuIM) appOption { return withLocalComputers(fake) }

func createFeishuIMConnection(t *testing.T, env *testEnv, client *http.Client, idempotency string) (string, string) {
	t.Helper()
	status, _, body := env.request(client, http.MethodPost, "/v0/external-connections", map[string]string{"app_key": externalsource.FeishuIMAppKey}, idempotency)
	var connection struct {
		ID         string `json:"id"`
		Status     string `json:"status"`
		ConnectURL string `json:"connect_url"`
	}
	decode(t, body, &connection)
	if connection.ID == "" {
		t.Fatalf("create connection status=%d body=%s", status, body)
	}
	return connection.ID, connection.ConnectURL
}

func TestFeishuIMConnectsThroughTheOwnersLarkCLI(t *testing.T) {
	allowParallelIntegrationTest(t)
	fake := newFakeFeishuIM(t)
	env, alice := newTaskWorkerEnv(t, starting(app.JobQueue), withAgentManagement(&recordingAgentManagement{}), withFeishuIMComputer(fake),
		withConfig(func(cfg *config.Config) { cfg.Jobs.PollInterval = riverTestPollInterval }))

	// Reaching owners' Computers makes Feishu IM available without Composio.
	status, _, body := env.request(alice, http.MethodGet, "/v0/external-apps", nil, "")
	if status != http.StatusOK || !strings.Contains(string(body), `"key":"feishu_im"`) {
		t.Fatalf("list apps status=%d body=%s", status, body)
	}

	// Without an online Computer running her AnotherMe, there is no lark-cli.
	status, _, body = env.request(alice, http.MethodPost, "/v0/external-connections", map[string]string{"app_key": externalsource.FeishuIMAppKey}, "feishu-im-offline")
	if status != http.StatusConflict || !strings.Contains(string(body), "FEISHU_COMPUTER_OFFLINE") {
		t.Fatalf("offline status=%d body=%s", status, body)
	}
	if connectAnotherMeComputer(t, env, acmeTenant, "actor_acme_alice") == "" {
		t.Fatal("alice has no AnotherMe")
	}

	// A scope the lark-cli app does not enable cannot be granted by logging in.
	fake.setLoggedIn(true)
	fake.setNotEnabled("im:message")
	status, _, body = env.request(alice, http.MethodPost, "/v0/external-connections", map[string]string{"app_key": externalsource.FeishuIMAppKey}, "feishu-im-scopes")
	if status != http.StatusConflict || !strings.Contains(string(body), "FEISHU_SCOPES_NOT_ENABLED") || !strings.Contains(string(body), "im:message") ||
		!strings.Contains(string(body), "https://open.feishu.cn/app/cli_fake/auth") {
		t.Fatalf("scopes status=%d body=%s", status, body)
	}
	fake.setNotEnabled()

	// Logged out, connecting starts a lark-cli login whose page is the link.
	fake.setLoggedIn(false)
	connectionID, connectURL := createFeishuIMConnection(t, env, alice, "feishu-im-login")
	if !strings.HasPrefix(connectURL, "https://accounts.feishu.cn/") {
		t.Fatalf("connect URL = %q", connectURL)
	}
	if current := feishuConnectionStatus(t, env, connectionID); current != "pending" {
		t.Fatalf("status before the login finished = %s", current)
	}

	// The owner finishes the login on Feishu's page; the connection's check
	// polls it and the connection turns active.
	fake.approveLogins()
	checkFeishuConnectionNow(t, env, alice, connectionID)
	if !waitForExternalSource(func() bool { return feishuConnectionStatus(t, env, connectionID) == "active" }) {
		t.Fatalf("the Feishu IM connection stayed %s", feishuConnectionStatus(t, env, connectionID))
	}
}

func TestFeishuIMConnectionIsActiveWhenTheOwnerIsLoggedIn(t *testing.T) {
	allowParallelIntegrationTest(t)
	fake := newFakeFeishuIM(t)
	fake.setLoggedIn(true)
	env, alice := newTaskWorkerEnv(t, starting(app.JobQueue), withAgentManagement(&recordingAgentManagement{}), withFeishuIMComputer(fake),
		withConfig(func(cfg *config.Config) { cfg.Jobs.PollInterval = riverTestPollInterval }))
	connectAnotherMeComputer(t, env, acmeTenant, "actor_acme_alice")

	// A lark-cli already logged in with every IM scope needs no page.
	connectionID, connectURL := createFeishuIMConnection(t, env, alice, "feishu-im-ready")
	if connectURL != "" {
		t.Fatalf("connect URL = %q, want none", connectURL)
	}
	// The connection's first check finds the owner already logged in.
	checkFeishuConnectionNow(t, env, alice, connectionID)
	if !waitForExternalSource(func() bool { return feishuConnectionStatus(t, env, connectionID) == "active" }) {
		t.Fatalf("status = %s", feishuConnectionStatus(t, env, connectionID))
	}
}
