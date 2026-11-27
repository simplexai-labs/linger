package localtools

import (
	"bytes"
	"context"
	"encoding/json"
	"path"
	"strings"
)

// FeishuIMScopes are the user scopes Feishu IM needs: reading and sending
// messages in the owner's chats, and reading chat info. A login requests
// exactly these; lark-cli adds them to the scopes the owner already granted.
var FeishuIMScopes = []string{
	"im:message",
	"im:chat:readonly",
}

// feishuIMAPIPrefix is the only API prefix a request may reach: the owner's
// own IM messages and chats. lark-cli may hold other Feishu scopes on this
// Computer, and TeamHub's calls must not reach them.
const feishuIMAPIPrefix = "/open-apis/im/v1"

// feishuIMIdentityPath is the owner's own user profile, the one call outside
// the IM prefix a request may reach: it names the account a connection is
// bound to, the way Feishu Mail reads its mailbox profile.
const feishuIMIdentityPath = "/open-apis/authen/v1/user_info"

// FeishuIM runs the Feishu IM calls TeamHub sends this Computer through its
// owner's own lark-cli login. A request names only a method and an API path
// under the owner's IM, and its JSON.
type FeishuIM struct {
	*larkClient
}

// NewFeishuIM returns a FeishuIM that looks for lark-cli on every call, so
// installing it later needs no restart.
func NewFeishuIM() *FeishuIM { return &FeishuIM{larkClient: newLarkClient()} }

// Call runs one Feishu IM tool. Status "ok" carries its result; any other
// status names why nothing usable came back.
func (m *FeishuIM) Call(ctx context.Context, name string, arguments json.RawMessage) map[string]any {
	binary, err := m.resolve()
	if err != nil {
		return map[string]any{"status": "not_installed"}
	}
	switch name {
	case "api":
		return m.larkClient.api(ctx, binary, arguments, feishuIMMethod, feishuIMRequestPath)
	case "status":
		return m.larkClient.status(ctx, binary, FeishuIMScopes, "")
	case "login_start":
		return m.loginStart(ctx, binary, FeishuIMScopes, arguments)
	case "login_wait":
		return m.loginWait(ctx, binary, arguments)
	}
	return map[string]any{"status": "unavailable"}
}

type feishuIMAPIRequest struct {
	Method string          `json:"method"`
	Path   string          `json:"path"`
	Params map[string]any  `json:"params"`
	Data   json.RawMessage `json:"data"`
}

func (m *FeishuIM) api(ctx context.Context, binary string, arguments json.RawMessage) map[string]any {
	var request feishuIMAPIRequest
	if json.Unmarshal(arguments, &request) != nil || !larkMethod(request.Method, "GET", "POST") || !feishuIMRequestPath(request.Path) {
		return map[string]any{"status": "invalid_request"}
	}
	args := []string{"api", request.Method, request.Path, "--as", "user", "--format", "json"}
	if len(request.Params) > 0 {
		encoded, err := json.Marshal(request.Params)
		if err != nil {
			return map[string]any{"status": "invalid_request"}
		}
		args = append(args, "--params", string(encoded))
	}
	var stdin []byte
	if data := bytes.TrimSpace(request.Data); len(data) > 0 && string(data) != "null" {
		args = append(args, "--data", "-")
		stdin = data
	}
	stdout, failure := m.run(ctx, binary, args, stdin)
	if failure != nil {
		return failure
	}
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal(stdout, &envelope) != nil {
		return map[string]any{"status": "failed"}
	}
	if len(envelope.Data) == 0 {
		envelope.Data = json.RawMessage("{}")
	}
	return map[string]any{"status": "ok", "data": envelope.Data}
}

// feishuIMRequestPath admits a clean path at or under the owner's IM, or the
// owner's own user profile. A query belongs in params, so a path holding one
// is refused.
func feishuIMRequestPath(requestPath string) bool {
	if strings.ContainsAny(requestPath, "?#%\\") || path.Clean(requestPath) != requestPath {
		return false
	}
	return requestPath == feishuIMIdentityPath ||
		requestPath == feishuIMAPIPrefix || strings.HasPrefix(requestPath, feishuIMAPIPrefix+"/")
}

// feishuIMMethod admits the read and send calls Feishu IM needs. A recall or
// delete is not an Agent action, so PUT, PATCH and DELETE are refused.
func feishuIMMethod(method string) bool { return larkMethod(method, "GET", "POST") }
