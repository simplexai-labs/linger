package integration_test

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/feishu"
)

func TestAgentReadsAndSendsFeishuMailAfterConfirmation(t *testing.T) {
	allowParallelIntegrationTest(t)
	fake := newFakeFeishu(t)
	env, alice, issued, roomID := newAgentCLIIdentity(t, starting(app.JobQueue), withAgentManagement(&recordingAgentManagement{}), withFeishuComputer(fake))
	agent := func(path string, payload map[string]any) map[string]any {
		t.Helper()
		status, body := postAgentInRoom(t, env, issued.AccessToken, roomID, path, payload)
		if status != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", path, status, body)
		}
		var decoded map[string]any
		if err := json.Unmarshal(body, &decoded); err != nil {
			t.Fatal(err)
		}
		return decoded
	}

	// Feishu Mail has no setup page: asked for it before it is connected, the
	// Agent gets a card in the chat, and its Connect starts a lark-cli login.
	runAliceAnotherMeOnAComputer(t, env)
	asked := agent("/api/agent/v1/apps/account", map[string]any{"app_key": externalsource.FeishuMailAppKey})
	cardID, _ := asked["interaction_id"].(string)
	if asked["status"] != "authorization_required" || cardID == "" {
		t.Fatalf("account before connecting = %v", asked)
	}
	connectionID := authorizeFeishuMail(t, env, alice, fake, func(connectionID string) {
		if status, _, body := env.request(alice, http.MethodPost, "/v0/decisions/"+cardID, map[string]any{
			"expected_version": 1, "decision": "approve", "connection_id": connectionID,
		}, "feishu-card-approve"); status != http.StatusOK {
			t.Fatalf("approve card status=%d body=%s", status, body)
		}
	})
	if !waitForExternalSource(func() bool {
		var current string
		_ = env.pool.QueryRow(t.Context(), `SELECT status FROM decisions WHERE id=$1`, cardID).Scan(&current)
		return current == "succeeded"
	}) {
		t.Fatal("the Feishu Mail card did not settle after consent")
	}
	ready := agent("/api/agent/v1/apps/account", map[string]any{"app_key": externalsource.FeishuMailAppKey})
	if account, _ := ready["account"].(map[string]any); ready["status"] != "ready" || account["connection_id"] != connectionID {
		t.Fatalf("account after consent = %v", ready)
	}
	assertFeishuMailSyncsOnlyNewMail(t, env, connectionID)
	execute := func(slug string, arguments map[string]any) map[string]any {
		t.Helper()
		return agent("/api/agent/v1/apps/tools/execute", map[string]any{
			"connection_id": connectionID, "tool_slug": slug, "tool_version": externalsource.FeishuMailToolVersion, "arguments": arguments,
		})
	}

	// The CLI binds TeamHub's own tools like Composio's, with their schemas.
	bound := agent("/api/agent/v1/apps/tools/bind", map[string]any{
		"connection_id": connectionID, "tool_version": externalsource.FeishuMailToolVersion,
		"tool_slugs": []string{externalsource.FeishuMailListMessages, externalsource.FeishuMailSendDraft},
	})
	if tools, _ := bound["tools"].([]any); len(tools) != 2 || !strings.Contains(string(mustJSON(t, tools)), `"input_schema"`) {
		t.Fatalf("bound tools = %v", bound)
	}

	listed := execute(externalsource.FeishuMailListMessages, map[string]any{"folder": "inbox", "page_size": 20})
	messages, _ := listed["data"].(map[string]any)["messages"].([]any)
	first, _ := messages[0].(map[string]any)
	if len(messages) != 3 || first["messageId"] != "msg_1" || first["unread"] != true || first["snippet"] != "Can we meet?" || first["receivedAt"] == nil {
		t.Fatalf("listed = %v", listed)
	}

	// Drafting runs at once and carries the attachment into the message.
	drafted := execute(externalsource.FeishuMailCreateDraft, map[string]any{
		"to": []string{"bob@example.com"}, "subject": "Plan", "body": "See attached", "body_format": "text",
		"attachments": []any{map[string]any{"name": "notes.txt", "content_type": "text/plain", "content_base64": base64.StdEncoding.EncodeToString([]byte("notes"))}},
	})
	draftID, _ := drafted["data"].(map[string]any)["draft_id"].(string)
	saved, err := feishu.ParseMessage(fake.draft(draftID))
	if err != nil || !slices.Equal(saved.To, []string{"bob@example.com"}) || saved.Subject != "Plan" || len(saved.Attachments) != 1 || string(saved.Attachments[0].Data) != "notes" {
		t.Fatalf("saved draft %s = %+v err=%v", draftID, saved, err)
	}

	// Sending waits for alice's card, which shows what the draft holds.
	held := execute(externalsource.FeishuMailSendDraft, map[string]any{"draft_id": draftID})
	if held["status"] != "confirmation_pending" || len(fake.sentDrafts()) != 0 {
		t.Fatalf("send before approval = %v sent=%v", held, fake.sentDrafts())
	}
	decisionID, _ := held["interaction_id"].(string)
	var view string
	var version int64
	if err := env.pool.QueryRow(t.Context(), `SELECT decision.view::text, card.version FROM decisions decision JOIN message_cards card ON card.message_id=decision.message_id WHERE decision.id=$1`, decisionID).Scan(&view, &version); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(view, "bob@example.com") || !strings.Contains(view, "notes.txt") || !strings.Contains(view, "See attached") {
		t.Fatalf("card view = %s", view)
	}
	if status, _, body := env.request(alice, http.MethodPost, "/v0/decisions/"+decisionID, map[string]any{"expected_version": version, "decision": "approve"}, "approve-feishu-send"); status != http.StatusOK {
		t.Fatalf("approve status=%d body=%s", status, body)
	}
	if !waitForExternalSource(func() bool { return slices.Equal(fake.sentDrafts(), []string{draftID}) }) {
		t.Fatalf("sent = %v", fake.sentDrafts())
	}

	archived := execute(externalsource.FeishuMailArchive, map[string]any{"message_id": "msg_1"})
	if moves := fake.movesMade(); archived["data"].(map[string]any)["message_id"] != "msg_1" || len(moves) != 1 || moves[0]["add_folder"] != "ARCHIVED" {
		t.Fatalf("archive = %v moves=%v", archived, moves)
	}

	// A folder-wide list without search text is refused before Feishu is called.
	status, body := postAgentInRoom(t, env, issued.AccessToken, roomID, "/api/agent/v1/apps/tools/execute", map[string]any{
		"connection_id": connectionID, "tool_slug": externalsource.FeishuMailListMessages, "tool_version": externalsource.FeishuMailToolVersion,
		"arguments": map[string]any{"folder": "all", "page_size": 20},
	})
	if status != http.StatusBadRequest || !strings.Contains(string(body), "invalid_input") {
		t.Fatalf("folder-wide list status=%d body=%s", status, body)
	}

	// Logged in to another mailbox, lark-cli is only asked whose it is: the
	// connection's tools touch nothing in the other mailbox.
	fake.setAddress("other@example.com")
	before := len(fake.apiPaths())
	status, body = postAgentInRoom(t, env, issued.AccessToken, roomID, "/api/agent/v1/apps/tools/execute", map[string]any{
		"connection_id": connectionID, "tool_slug": externalsource.FeishuMailListMessages, "tool_version": externalsource.FeishuMailToolVersion,
		"arguments": map[string]any{"folder": "inbox", "page_size": 20},
	})
	if status == http.StatusOK || !strings.Contains(string(body), "different Feishu mailbox") {
		t.Fatalf("list from another mailbox status=%d body=%s", status, body)
	}
	if after := fake.apiPaths()[before:]; !slices.Equal(after, []string{"profile"}) {
		t.Fatalf("calls with another mailbox logged in = %v", after)
	}
}

// assertFeishuMailSyncsOnlyNewMail checks that a new Feishu Mail connection
// imports nothing from before it, and that the nightly sync brings the mail
// people wrote to and from the mailbox into the Wiki.
func assertFeishuMailSyncsOnlyNewMail(t *testing.T, env *testEnv, connectionID string) {
	t.Helper()
	ctx := t.Context()
	if !waitForExternalSource(func() bool {
		var completed bool
		_ = env.pool.QueryRow(ctx, `SELECT mail_import_status='completed' AND mail_synced_until IS NOT NULL FROM external_connections WHERE id=$1`, connectionID).Scan(&completed)
		return completed
	}) {
		t.Fatal("the Feishu Mail connection did not start syncing")
	}
	sources := func() []string {
		rows, err := env.pool.Query(ctx, `SELECT source_key FROM wiki_source_items WHERE source_key LIKE 'mail:feishu_mail:%' ORDER BY source_key`)
		if err != nil {
			t.Fatal(err)
		}
		keys, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			t.Fatal(err)
		}
		return keys
	}
	var imported int
	if err := env.pool.QueryRow(ctx, `SELECT mail_import_read FROM external_connections WHERE id=$1`, connectionID).Scan(&imported); err != nil || imported != 0 || len(sources()) != 0 {
		t.Fatalf("connecting imported mail: read=%d sources=%v err=%v", imported, sources(), err)
	}
	// A night later the sync reads the day before it.
	if _, err := env.pool.Exec(ctx, `UPDATE external_connections SET mail_synced_until=now()-interval '1 day' WHERE id=$1`, connectionID); err != nil {
		t.Fatal(err)
	}
	if err := externalsource.New(env.pool, nil).EnqueueMailSyncs(ctx, time.Now().Add(48*time.Hour)); err != nil {
		t.Fatal(err)
	}
	mailbox := "feishu_mail:zhang@example.com"
	want := []string{externalsource.MailWikiSourceKey(mailbox, "message:msg_1"), externalsource.MailWikiSourceKey(mailbox, "message:msg_sent")}
	slices.Sort(want)
	if !waitForExternalSource(func() bool { return slices.Equal(sources(), want) }) {
		t.Fatalf("synced Wiki sources = %v, want %v", sources(), want)
	}
}

// TestFeishuMailSetupKeepsTheConnectionCardPending covers an Agent asking for
// a card before setup, and the owner's read-only checks on that same card.
func TestFeishuMailSetupKeepsTheConnectionCardPending(t *testing.T) {
	allowParallelIntegrationTest(t)
	fake := newFakeFeishu(t)
	env, alice, issued, roomID := newAgentCLIIdentity(t, starting(app.JobQueue), withAgentManagement(&recordingAgentManagement{}), withFeishuComputer(fake))
	const setupPath = "/v0/external-apps/feishu-mail/setup"

	status, body := postAgentInRoom(t, env, issued.AccessToken, roomID, "/api/agent/v1/apps/account", map[string]any{"app_key": externalsource.FeishuMailAppKey})
	var result struct {
		Status string `json:"status"`
	}
	decode(t, body, &result)
	if status != http.StatusOK || result.Status != "authorization_required" {
		t.Fatalf("connect with no Computer = %d %s", status, body)
	}
	check := func(wantCode string, wantCommands ...string) {
		t.Helper()
		status, _, body := env.request(alice, http.MethodGet, setupPath, nil, "")
		var decoded struct {
			Error struct {
				Code    string `json:"code"`
				Details []struct {
					Field, Reason string
				} `json:"details"`
			} `json:"error"`
		}
		decode(t, body, &decoded)
		var commands []string
		for _, detail := range decoded.Error.Details {
			if detail.Field == "command" {
				commands = append(commands, detail.Reason)
			}
		}
		if status != http.StatusConflict || decoded.Error.Code != wantCode || !slices.Equal(commands, wantCommands) {
			t.Fatalf("setup = %d %s, want %s with commands %v", status, body, wantCode, wantCommands)
		}
	}

	check("FEISHU_COMPUTER_OFFLINE")
	runAliceAnotherMeOnAComputer(t, env)
	fake.setNotInstalled(true)
	check("LARK_CLI_NOT_INSTALLED", feishu.InstallCommand)
	fake.setNotInstalled(false)
	fake.setNotConfigured(true)
	check("LARK_CLI_NOT_CONFIGURED", feishu.SetupCommand)
	fake.setNotConfigured(false)
	fake.setLoggedIn(true)
	fake.setNotEnabled("mail:user_mailbox:readonly")
	check("FEISHU_SCOPES_NOT_ENABLED")
	fake.setNotEnabled()
	fake.setLoggedIn(false)
	if status, _, body := env.request(alice, http.MethodGet, setupPath, nil, ""); status != http.StatusNoContent {
		t.Fatalf("setup while logged out = %d %s", status, body)
	}
	var cards int
	if err := env.pool.QueryRow(t.Context(), `SELECT count(*) FROM decisions WHERE room_id=$1 AND status='pending'`, roomID).Scan(&cards); err != nil || cards != 1 {
		t.Fatalf("pending cards after setup checks = %d, %v", cards, err)
	}
	var connections int
	if err := env.pool.QueryRow(t.Context(), `SELECT count(*) FROM external_connections WHERE provider='feishu_mail'`).Scan(&connections); err != nil || connections != 0 {
		t.Fatalf("connections created by setup checks = %d, %v", connections, err)
	}
	_, connectURL := createFeishuMailConnection(t, env, alice, "feishu-from-setup")
	if connectURL == "" {
		t.Fatal("explicit Connect did not start Feishu authorization")
	}
}
