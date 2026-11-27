package localtools

import (
	"context"
	"encoding/json"
	"path"
	"strings"
)

// FeishuMailScopes are the user scopes Feishu Mail needs: the mailbox
// profile, folders and messages read, sending, drafts and moving mail. A
// login requests exactly these; lark-cli adds them to the scopes the owner
// already granted.
var FeishuMailScopes = []string{
	"mail:user_mailbox:readonly",
	"mail:user_mailbox.folder:read",
	"mail:user_mailbox.message:readonly",
	"mail:user_mailbox.message.subject:read",
	"mail:user_mailbox.message.address:read",
	"mail:user_mailbox.message.body:read",
	"mail:user_mailbox.message:send",
	"mail:user_mailbox.message:modify",
}

// feishuMailboxPath is the only API path a request may reach: the owner's
// own mailbox. lark-cli may hold other Feishu scopes on this Computer, and
// TeamHub's calls must not reach them.
const feishuMailboxPath = "/open-apis/mail/v1/user_mailboxes/me"

// FeishuMail runs the Feishu Mail calls TeamHub sends this Computer through
// its owner's own lark-cli login. A request names only a method and an API
// path under the owner's mailbox and its JSON.
type FeishuMail struct {
	*larkClient
}

// NewFeishuMail returns a FeishuMail that looks for lark-cli on every call,
// so installing it later needs no restart.
func NewFeishuMail() *FeishuMail {
	return &FeishuMail{larkClient: newLarkClient()}
}

// Call runs one Feishu Mail tool. Status "ok" carries its result; any other
// status names why nothing usable came back.
func (m *FeishuMail) Call(ctx context.Context, name string, arguments json.RawMessage) map[string]any {
	binary, err := m.resolve()
	if err != nil {
		return map[string]any{"status": "not_installed"}
	}
	switch name {
	case "api":
		return m.larkClient.api(ctx, binary, arguments, feishuMailMethod, feishuMailboxRequestPath)
	case "status":
		return m.larkClient.status(ctx, binary, FeishuMailScopes, feishuMailboxPath+"/profile")
	case "login_start":
		return m.loginStart(ctx, binary, FeishuMailScopes, arguments)
	case "login_wait":
		return m.loginWait(ctx, binary, arguments)
	}
	return map[string]any{"status": "unavailable"}
}

// feishuMailboxRequestPath admits a clean path at or under the owner's
// mailbox. A query belongs in params, so a path holding one is refused.
func feishuMailboxRequestPath(requestPath string) bool {
	if strings.ContainsAny(requestPath, "?#%\\") || path.Clean(requestPath) != requestPath {
		return false
	}
	return requestPath == feishuMailboxPath || strings.HasPrefix(requestPath, feishuMailboxPath+"/")
}

// feishuMailMethod admits the HTTP methods Feishu Mail may call.
func feishuMailMethod(method string) bool {
	return larkMethod(method, "GET", "POST", "PUT", "PATCH", "DELETE")
}
