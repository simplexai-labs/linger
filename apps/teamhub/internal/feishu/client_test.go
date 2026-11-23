package feishu

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

// fakeComputer answers each tool call with the next prepared result and
// records the calls.
type fakeComputer struct {
	results []map[string]any
	err     error
	calls   []fakeCall
}

type fakeCall struct {
	tool      string
	arguments map[string]any
}

func (f *fakeComputer) call(_ context.Context, tool string, arguments map[string]any) (map[string]any, error) {
	f.calls = append(f.calls, fakeCall{tool: tool, arguments: arguments})
	if f.err != nil {
		return nil, f.err
	}
	result := f.results[0]
	f.results = f.results[1:]
	return result, nil
}

func TestMailboxCallsTheOwnersMailboxPath(t *testing.T) {
	computer := &fakeComputer{results: []map[string]any{{"status": "ok", "data": map[string]any{"items": []any{"m1", "m2"}, "has_more": true, "page_token": "next"}}}}
	ids, next, err := NewMailbox(computer.call, nil).ListMessageIDs(context.Background(), FolderInbox, true, 20, "token")
	if err != nil || !reflect.DeepEqual(ids, []string{"m1", "m2"}) || next != "next" {
		t.Fatalf("ids = %v, next = %q, err = %v", ids, next, err)
	}
	want := fakeCall{tool: "api", arguments: map[string]any{
		"method": "GET", "path": "/open-apis/mail/v1/user_mailboxes/me/messages",
		"params": map[string]any{"page_size": 20, "folder_id": "INBOX", "only_unread": true, "page_token": "token"},
	}}
	if !reflect.DeepEqual(computer.calls, []fakeCall{want}) {
		t.Fatalf("calls = %#v", computer.calls)
	}
}

func TestMailboxErrorsFollowTheComputersStatus(t *testing.T) {
	cases := []struct {
		result map[string]any
		check  func(error) bool
	}{
		{map[string]any{"status": "auth_required"}, func(err error) bool { return errors.Is(err, ErrAuthorizationRequired) && IsAuthFailure(err) }},
		{map[string]any{"status": "missing_scope", "missing_scopes": []any{"mail:a"}, "app_missing_scopes": []any{"mail:a"}, "app_id": "cli_abc123", "brand": "feishu"}, func(err error) bool {
			var missing *ScopesMissingError
			return errors.As(err, &missing) && reflect.DeepEqual(missing.NotEnabled, []string{"mail:a"}) && IsAuthFailure(err) &&
				missing.PermissionsURL() == "https://open.feishu.cn/app/cli_abc123/auth"
		}},
		{map[string]any{"status": "failed", "code": float64(99991400)}, func(err error) bool {
			var limited *RateLimitError
			return errors.As(err, &limited)
		}},
		{map[string]any{"status": "failed", "code": float64(99991677)}, IsAuthFailure},
		{map[string]any{"status": "failed", "code": float64(1230001), "detail": "no such message"}, func(err error) bool {
			var apiErr *APIError
			return errors.As(err, &apiErr) && apiErr.Code == 1230001 && !IsAuthFailure(err) && !IsComputerFailure(err)
		}},
		{map[string]any{"status": "failed", "error_subtype": "not_found"}, IsNotFound},
		{map[string]any{"status": "not_installed"}, func(err error) bool {
			var computer *ComputerError
			return errors.As(err, &computer) && computer.Status == StatusNotInstalled
		}},
		{map[string]any{"status": "failed"}, IsComputerFailure},
		{map[string]any{"status": "outcome_unknown"}, IsComputerFailure},
	}
	for _, testCase := range cases {
		computer := &fakeComputer{results: []map[string]any{testCase.result}}
		if _, err := NewMailbox(computer.call, nil).GetMessage(context.Background(), "m1"); !testCase.check(err) {
			t.Fatalf("result %v: err = %v", testCase.result, err)
		}
	}
}

func TestPermissionsURLNamesOnlyAWellFormedApp(t *testing.T) {
	if got := (&ScopesMissingError{AppID: "cli_abc", Brand: "lark"}).PermissionsURL(); got != "https://open.larksuite.com/app/cli_abc/auth" {
		t.Fatalf("lark = %q", got)
	}
	for _, appID := range []string{"", "cli_abc/../x", "abc", "cli_a?b"} {
		if got := (&ScopesMissingError{AppID: appID}).PermissionsURL(); got != "" {
			t.Fatalf("%q = %q", appID, got)
		}
	}
}

func TestMailboxStatusAndLogin(t *testing.T) {
	computer := &fakeComputer{results: []map[string]any{
		{"status": "ok", "address": "Me@Example.com"},
		{"status": "ok", "verification_url": "https://accounts.feishu.cn/v", "expires_in": float64(600)},
		{"status": "pending"},
		{"status": "ok"},
		{"status": "expired"},
	}}
	mailbox := NewMailbox(computer.call, nil)
	ctx := context.Background()
	if address, err := mailbox.Status(ctx); err != nil || address != "me@example.com" {
		t.Fatalf("status = %q, %v", address, err)
	}
	login, err := mailbox.StartLogin(ctx, "feishu_upstream_1")
	if err != nil || login.URL != "https://accounts.feishu.cn/v" || login.ExpiresAt.IsZero() {
		t.Fatalf("login = %#v, %v", login, err)
	}
	for _, want := range []LoginState{LoginPending, LoginDone, LoginGone} {
		if state, err := mailbox.WaitLogin(ctx, "feishu_upstream_1"); err != nil || state != want {
			t.Fatalf("wait = %v, %v; want %v", state, err, want)
		}
	}
	if computer.calls[1].arguments["login_id"] != "feishu_upstream_1" || computer.calls[2].tool != "login_wait" {
		t.Fatalf("calls = %#v", computer.calls)
	}
}

func TestMailboxComputerOutageIsAComputerFailure(t *testing.T) {
	outage := &ComputerError{Status: StatusComputerOffline}
	computer := &fakeComputer{err: outage}
	if _, err := NewMailbox(computer.call, nil).Status(context.Background()); !errors.Is(err, outage) || IsAuthFailure(err) {
		t.Fatalf("err = %v", err)
	}
}

func TestDraftsNameTheMailboxAsTheirSender(t *testing.T) {
	// Feishu refuses a draft without a From header as an invalid MIME message.
	computer := &fakeComputer{results: []map[string]any{
		{"status": "ok", "data": map[string]any{"primary_email_address": "Me@Example.com"}},
		{"status": "ok", "data": map[string]any{"draft": map[string]any{"id": "d1"}}},
	}}
	mailbox := NewMailbox(computer.call, nil)
	raw := []byte("To: bob@example.com\r\nSubject: Hi\r\n\r\nHello\r\n")
	if id, err := mailbox.CreateDraft(context.Background(), raw); err != nil || id != "d1" {
		t.Fatalf("create = %q, %v", id, err)
	}
	if computer.calls[0].arguments["path"] != "/open-apis/mail/v1/user_mailboxes/me/profile" {
		t.Fatalf("calls = %#v", computer.calls)
	}
	sent, err := DecodeBase64URL(computer.calls[1].arguments["data"].(map[string]string)["raw"])
	if err != nil || !strings.HasPrefix(string(sent), "From: me@example.com\r\nTo: bob@example.com") {
		t.Fatalf("draft = %q, %v", sent, err)
	}

	// A message that names its sender keeps it, with no profile read.
	withSender := &fakeComputer{results: []map[string]any{{"status": "ok", "data": map[string]any{}}}}
	if err := NewMailbox(withSender.call, nil).UpdateDraft(context.Background(), "d1", append([]byte("From: alias@example.com\r\n"), raw...)); err != nil || len(withSender.calls) != 1 {
		t.Fatalf("update err = %v, calls = %#v", err, withSender.calls)
	}
}

func TestDownloadAttachmentFetchesThePresignedLinkItself(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("file")) }))
	defer server.Close()
	computer := &fakeComputer{results: []map[string]any{{"status": "ok", "data": map[string]any{"download_urls": []any{
		map[string]any{"attachment_id": "a1", "download_url": server.URL + "/a1"},
	}}}}}
	data, err := NewMailbox(computer.call, server.Client()).DownloadAttachment(context.Background(), "m1", "a1")
	if err != nil || string(data) != "file" {
		t.Fatalf("data = %q, err = %v", data, err)
	}
	if computer.calls[0].arguments["path"] != "/open-apis/mail/v1/user_mailboxes/me/messages/m1/attachments/download_url" {
		t.Fatalf("calls = %#v", computer.calls)
	}
	plain := &fakeComputer{results: []map[string]any{{"status": "ok", "data": map[string]any{"download_urls": []any{
		map[string]any{"attachment_id": "a1", "download_url": "http://example.com/a1"},
	}}}}}
	if _, err := NewMailbox(plain.call, server.Client()).DownloadAttachment(context.Background(), "m1", "a1"); err == nil {
		t.Fatal("a plain-HTTP attachment link was fetched")
	}
}
