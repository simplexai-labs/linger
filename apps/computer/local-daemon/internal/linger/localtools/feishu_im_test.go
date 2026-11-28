package localtools

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

// fakeLarkCLIIM writes a lark-cli stand-in that records each call and answers
// from files named after its first two arguments, and returns a FeishuIM that
// runs it. It mirrors fakeLarkCLI but for the IM tool.
func fakeLarkCLIIM(t *testing.T) (*FeishuIM, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the lark-cli stand-in is a shell script")
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "lark-cli")
	body := `#!/bin/sh
d="` + dir + `"
key="$1-$2"
if [ "$3" = "--device-code" ]; then key="$key-device"; fi
printf '%s\n' "$@" > "$d/$key.argv"
if [ -f "$d/$key.sleep" ]; then sleep "$(cat "$d/$key.sleep")"; fi
cat > "$d/$key.stdin"
if [ -f "$d/$key.stdout" ]; then cat "$d/$key.stdout"; fi
if [ -f "$d/$key.stderr" ]; then cat "$d/$key.stderr" >&2; fi
exit "$(cat "$d/$key.exit" 2>/dev/null || echo 0)"
`
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	tool := &FeishuIM{larkClient: &larkClient{resolve: func() (string, error) { return script, nil }, env: []string{"PATH=" + os.Getenv("PATH")}, now: time.Now, logins: map[string]feishuLogin{}}}
	return tool, dir
}

func TestFeishuIMAPICallsTheOwnersIM(t *testing.T) {
	tool, dir := fakeLarkCLIIM(t)
	answer(t, dir, "api-POST", `{"ok":true,"identity":"user","data":{"message_id":"om_1"}}`, "", 0)
	result := tool.Call(context.Background(), "api", json.RawMessage(`{"method":"POST","path":"/open-apis/im/v1/messages","params":{"receive_id_type":"chat_id"},"data":{"receive_id":"oc_1","msg_type":"text","content":"{\"text\":\"hi\"}"}}`))
	if result["status"] != "ok" || string(result["data"].(json.RawMessage)) != `{"message_id":"om_1"}` {
		t.Fatalf("result = %#v", result)
	}
	want := []string{"api", "POST", "/open-apis/im/v1/messages", "--as", "user", "--format", "json", "--params", `{"receive_id_type":"chat_id"}`, "--data", "-"}
	if got := calledWith(t, dir, "api-POST"); !reflect.DeepEqual(got, want) {
		t.Fatalf("argv = %q, want %q", got, want)
	}
	if stdin, _ := os.ReadFile(filepath.Join(dir, "api-POST.stdin")); string(stdin) != `{"receive_id":"oc_1","msg_type":"text","content":"{\"text\":\"hi\"}"}` {
		t.Fatalf("stdin = %q", stdin)
	}
}

func TestFeishuIMAPIRefusesAnythingButIM(t *testing.T) {
	tool, dir := fakeLarkCLIIM(t)
	for _, request := range []string{
		`{"method":"GET","path":"/open-apis/mail/v1/user_mailboxes/me/profile"}`,
		`{"method":"GET","path":"/open-apis/im/v1/messages/../../../mail/v1/user_mailboxes/me"}`,
		`{"method":"GET","path":"/open-apis/im/v1x/messages"}`,
		`{"method":"GET","path":"/open-apis/im/v1/messages?page_size=1"}`,
		`{"method":"GET","path":"/open-apis/im/v1/messages%2F..%2F"}`,
		`{"method":"HEAD","path":"/open-apis/im/v1/messages"}`,
		`{"method":"PUT","path":"/open-apis/im/v1/messages/om_1"}`,
		`{"method":"PATCH","path":"/open-apis/im/v1/messages/om_1"}`,
		`{"method":"DELETE","path":"/open-apis/im/v1/messages/om_1"}`,
		`not json`,
	} {
		if result := tool.Call(context.Background(), "api", json.RawMessage(request)); result["status"] != "invalid_request" {
			t.Fatalf("%s: result = %#v", request, result)
		}
	}
	if entries, _ := filepath.Glob(filepath.Join(dir, "*.argv")); len(entries) != 0 {
		t.Fatalf("lark-cli ran for a refused request: %v", entries)
	}
}

func TestFeishuIMStatusNamesMissingScopes(t *testing.T) {
	tool, dir := fakeLarkCLIIM(t)
	answer(t, dir, "auth-check", `{"ok":false,"missing":["im:message"]}`, "", 1)
	answer(t, dir, "auth-scopes", `{"appId":"cli_x","brand":"feishu","userScopes":["im:chat:readonly"]}`, "", 0)
	result := tool.Call(context.Background(), "status", nil)
	if result["status"] != "missing_scope" {
		t.Fatalf("status = %#v", result)
	}
	if got := calledWith(t, dir, "auth-check"); got[3] != strings.Join(FeishuIMScopes, " ") {
		t.Fatalf("auth-check scope = %q", got[3])
	}
	missing, _ := result["missing_scopes"].([]string)
	if len(missing) != 1 || missing[0] != "im:message" {
		t.Fatalf("missing_scopes = %#v", result["missing_scopes"])
	}
	notEnabled, _ := result["app_missing_scopes"].([]string)
	if len(notEnabled) != 1 || notEnabled[0] != "im:message" {
		t.Fatalf("app_missing_scopes = %#v", result["app_missing_scopes"])
	}
}

func TestFeishuIMStatusOK(t *testing.T) {
	tool, dir := fakeLarkCLIIM(t)
	answer(t, dir, "auth-check", `{"ok":true}`, "", 0)
	if result := tool.Call(context.Background(), "status", nil); result["status"] != "ok" {
		t.Fatalf("status = %#v", result)
	}
}

func TestFeishuIMLoginKeepsTheDeviceCodeOnTheComputer(t *testing.T) {
	tool, dir := fakeLarkCLIIM(t)
	answer(t, dir, "auth-login", `{"device_code":"dc_1","verification_url":"https://accounts.feishu.cn/oauth/v3/device/verify?code=dc_1","expires_in":300}`, "", 0)
	result := tool.Call(context.Background(), "login_start", json.RawMessage(`{"login_id":"agent-1"}`))
	if result["status"] != "ok" || result["verification_url"] != "https://accounts.feishu.cn/oauth/v3/device/verify?code=dc_1" {
		t.Fatalf("login_start = %#v", result)
	}
	if got := calledWith(t, dir, "auth-login"); got[3] != strings.Join(FeishuIMScopes, " ") || got[4] != "--no-wait" {
		t.Fatalf("auth-login argv = %q", got)
	}
	// The device code stays in the tool, not the caller.
	if _, ok := result["device_code"]; ok {
		t.Fatalf("login_start leaked the device code: %#v", result)
	}
	answer(t, dir, "auth-login-device", `{"ok":true}`, "", 0)
	if wait := tool.Call(context.Background(), "login_wait", json.RawMessage(`{"login_id":"agent-1"}`)); wait["status"] != "ok" {
		t.Fatalf("login_wait = %#v", wait)
	}
	if got := calledWith(t, dir, "auth-login-device"); got[3] != "dc_1" {
		t.Fatalf("auth-login device argv = %q", got)
	}
}

func TestFeishuIMWithoutLarkCLI(t *testing.T) {
	tool := &FeishuIM{larkClient: &larkClient{resolve: func() (string, error) { return "", errors.New("missing") }, logins: map[string]feishuLogin{}}}
	if result := tool.Call(context.Background(), "status", nil); result["status"] != "not_installed" {
		t.Fatalf("status = %#v", result)
	}
}
