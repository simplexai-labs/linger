package feishu

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
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

// feishuLinks is a client that reaches server for every host, as if it
// served Feishu's attachment domains.
func feishuLinks(server *httptest.Server) *http.Client {
	transport := server.Client().Transport.(*http.Transport).Clone()
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
	transport.TLSClientConfig.ServerName = "example.com"
	return &http.Client{Transport: transport}
}

func attachmentLink(link string) *fakeComputer {
	return &fakeComputer{results: []map[string]any{{"status": "ok", "data": map[string]any{"download_urls": []any{
		map[string]any{"attachment_id": "a1", "download_url": link},
	}}}}}
}

func TestDownloadAttachmentFetchesThePresignedLinkItself(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/elsewhere" {
			http.Redirect(w, request, "https://attacker.example.com/a1", http.StatusFound)
			return
		}
		_, _ = w.Write([]byte("file"))
	}))
	defer server.Close()
	ctx := context.Background()
	computer := attachmentLink("https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=a1")
	data, err := NewMailbox(computer.call, feishuLinks(server)).DownloadAttachment(ctx, "m1", "a1")
	if err != nil || string(data) != "file" {
		t.Fatalf("data = %q, err = %v", data, err)
	}
	if computer.calls[0].arguments["path"] != "/open-apis/mail/v1/user_mailboxes/me/messages/m1/attachments/download_url" {
		t.Fatalf("calls = %#v", computer.calls)
	}

	// TeamHub fetches the link from inside its own network: a link anywhere
	// but Feishu's attachment domains, or a redirect away from them, is refused.
	for _, link := range []string{
		"http://internal-api-drive-stream.feishu.cn/a1",
		server.URL + "/a1",
		"https://metadata.internal/a1",
		"https://feishu.cn.attacker.example.com/a1",
		"https://internal-api-drive-stream.feishu.cn:8443/a1",
		"https://internal-api-drive-stream.feishu.cn/elsewhere",
	} {
		if _, err := NewMailbox(attachmentLink(link).call, feishuLinks(server)).DownloadAttachment(ctx, "m1", "a1"); err == nil {
			t.Fatalf("the attachment link %s was fetched", link)
		}
	}
}

func profile(address string) map[string]any {
	return map[string]any{"status": "ok", "data": map[string]any{"primary_email_address": address}}
}

func TestBoundMailboxRefusesAnotherLoggedInMailbox(t *testing.T) {
	// The owner switched lark-cli to another account after connecting.
	computer := &fakeComputer{results: []map[string]any{profile("other@example.com")}}
	mailbox := NewMailbox(computer.call, nil).BoundTo(" Me@Example.com ")
	ctx := context.Background()
	if _, _, err := mailbox.ListMessageIDs(ctx, FolderInbox, false, 20, ""); !errors.Is(err, ErrMailboxChanged) || !IsAuthFailure(err) {
		t.Fatalf("list err = %v", err)
	}
	// The check is not repeated, and nothing reaches the other mailbox.
	if _, err := mailbox.GetMessage(ctx, "m1"); !errors.Is(err, ErrMailboxChanged) {
		t.Fatalf("read err = %v", err)
	}
	if len(computer.calls) != 1 || computer.calls[0].arguments["path"] != mailboxPath+"/profile" {
		t.Fatalf("calls = %#v", computer.calls)
	}

	status := &fakeComputer{results: []map[string]any{{"status": "ok", "address": "other@example.com"}}}
	if _, err := NewMailbox(status.call, nil).BoundTo("me@example.com").Status(ctx); !errors.Is(err, ErrMailboxChanged) {
		t.Fatalf("status err = %v", err)
	}
}

func TestBoundMailboxChecksItsIdentityOnce(t *testing.T) {
	computer := &fakeComputer{results: []map[string]any{
		profile("ME@example.com"),
		{"status": "ok", "data": map[string]any{"items": []any{}}},
		{"status": "ok", "data": map[string]any{"draft": map[string]any{"id": "d1"}}},
	}}
	mailbox := NewMailbox(computer.call, nil).BoundTo("me@example.com")
	ctx := context.Background()
	if _, _, err := mailbox.ListMessageIDs(ctx, FolderInbox, false, 20, ""); err != nil {
		t.Fatalf("list err = %v", err)
	}
	// The draft names the bound address as its sender with no second profile read.
	if _, err := mailbox.CreateDraft(ctx, []byte("To: bob@example.com\r\nSubject: Hi\r\n\r\nHello\r\n")); err != nil {
		t.Fatalf("draft err = %v", err)
	}
	if len(computer.calls) != 3 || computer.calls[0].arguments["path"] != mailboxPath+"/profile" {
		t.Fatalf("calls = %#v", computer.calls)
	}
	sent, err := DecodeBase64URL(computer.calls[2].arguments["data"].(map[string]string)["raw"])
	if err != nil || !strings.HasPrefix(string(sent), "From: me@example.com\r\n") {
		t.Fatalf("draft = %q, %v", sent, err)
	}
}

func TestInboxSinceNamesThePageToReadOnFrom(t *testing.T) {
	since := time.UnixMilli(1_000_000)
	stamp := func(offset int64) string { return strconv.FormatInt(since.UnixMilli()+offset, 10) }
	page := func(ids []any, next string) map[string]any {
		return map[string]any{"status": "ok", "data": map[string]any{"items": ids, "has_more": next != "", "page_token": next}}
	}
	messages := func(dates ...string) map[string]any {
		items := make([]any, len(dates))
		for i, date := range dates {
			items[i] = map[string]any{"message_id": "m" + strconv.Itoa(i), "internal_date": date}
		}
		return map[string]any{"status": "ok", "data": map[string]any{"messages": items}}
	}
	ctx := context.Background()

	// Every mail on both pages is new: the backlog goes on past them.
	backlog := &fakeComputer{results: []map[string]any{
		page([]any{"m0"}, "p2"), messages(stamp(20)),
		page([]any{"m0"}, "p3"), messages(stamp(10)),
	}}
	found, next, err := NewMailbox(backlog.call, nil).InboxSince(ctx, since, "p1", 2)
	if err != nil || len(found) != 2 || next != "p3" {
		t.Fatalf("found %d, next %q, err %v", len(found), next, err)
	}
	if backlog.calls[0].arguments["params"].(map[string]any)["page_token"] != "p1" {
		t.Fatalf("calls = %#v", backlog.calls)
	}

	// Older mail on the page ends the read, though Feishu has more pages.
	caughtUp := &fakeComputer{results: []map[string]any{page([]any{"m0", "m1"}, "p2"), messages(stamp(5), stamp(-5))}}
	found, next, err = NewMailbox(caughtUp.call, nil).InboxSince(ctx, since, "", 2)
	if err != nil || len(found) != 1 || next != "" || len(caughtUp.calls) != 2 {
		t.Fatalf("found %d, next %q, err %v, calls %d", len(found), next, err, len(caughtUp.calls))
	}
}

func TestUnconfiguredLarkCLIIsNotAnAuthorizationFailure(t *testing.T) {
	err := statusError("status check", map[string]any{"status": StatusNotConfigured, "detail": "not configured"})
	var computer *ComputerError
	if !errors.As(err, &computer) || computer.Status != StatusNotConfigured || IsAuthFailure(err) {
		t.Fatalf("err = %#v", err)
	}
}
