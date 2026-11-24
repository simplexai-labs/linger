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

// fakeLarkCLI writes a lark-cli stand-in that records each call and answers
// from files named after its first two arguments (its third too, for a
// device-code wait): <key>.stdout, <key>.stderr, <key>.exit, <key>.sleep.
func fakeLarkCLI(t *testing.T) (*FeishuMail, string) {
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
	tool := &FeishuMail{resolve: func() (string, error) { return script, nil }, env: []string{"PATH=" + os.Getenv("PATH")}, now: time.Now, logins: map[string]feishuLogin{}}
	return tool, dir
}

func answer(t *testing.T, dir, key, stdout, stderr string, exit int) {
	t.Helper()
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(dir, key+"."+name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if stdout != "" {
		write("stdout", stdout)
	}
	if stderr != "" {
		write("stderr", stderr)
	}
	if exit != 0 {
		write("exit", string(rune('0'+exit)))
	}
}

func calledWith(t *testing.T, dir, key string) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, key+".argv"))
	if err != nil {
		t.Fatalf("lark-cli was not called for %s: %v", key, err)
	}
	return strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
}

func TestFeishuMailAPICallsTheOwnersMailbox(t *testing.T) {
	tool, dir := fakeLarkCLI(t)
	answer(t, dir, "api-POST", `{"ok":true,"identity":"user","data":{"draft":{"id":"d1"}}}`, "", 0)
	result := tool.Call(context.Background(), "api", json.RawMessage(`{"method":"POST","path":"/open-apis/mail/v1/user_mailboxes/me/drafts","params":{"page_size":2},"data":{"raw":"abc"}}`))
	if result["status"] != "ok" || string(result["data"].(json.RawMessage)) != `{"draft":{"id":"d1"}}` {
		t.Fatalf("result = %#v", result)
	}
	want := []string{"api", "POST", "/open-apis/mail/v1/user_mailboxes/me/drafts", "--as", "user", "--format", "json", "--params", `{"page_size":2}`, "--data", "-"}
	if got := calledWith(t, dir, "api-POST"); !reflect.DeepEqual(got, want) {
		t.Fatalf("argv = %q, want %q", got, want)
	}
	if stdin, _ := os.ReadFile(filepath.Join(dir, "api-POST.stdin")); string(stdin) != `{"raw":"abc"}` {
		t.Fatalf("stdin = %q", stdin)
	}
}

func TestFeishuMailAPIRefusesAnythingButTheMailbox(t *testing.T) {
	tool, dir := fakeLarkCLI(t)
	for _, request := range []string{
		`{"method":"GET","path":"/open-apis/im/v1/messages"}`,
		`{"method":"GET","path":"/open-apis/mail/v1/user_mailboxes/me/../../../im/v1/chats"}`,
		`{"method":"GET","path":"/open-apis/mail/v1/user_mailboxes/meX"}`,
		`{"method":"GET","path":"/open-apis/mail/v1/user_mailboxes/someone@example.com/messages"}`,
		`{"method":"GET","path":"/open-apis/mail/v1/user_mailboxes/me/messages?page_size=1"}`,
		`{"method":"GET","path":"/open-apis/mail/v1/user_mailboxes/me/messages%2F..%2F"}`,
		`{"method":"HEAD","path":"/open-apis/mail/v1/user_mailboxes/me/messages"}`,
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

func TestFeishuMailFailuresCarryLarkErrorFields(t *testing.T) {
	cases := []struct {
		stderr string
		want   map[string]any
	}{
		{`{"ok":false,"error":{"type":"authorization","subtype":"missing_scope","code":99991679,"message":"m","missing_scopes":["mail:user_mailbox:readonly"]}}`,
			map[string]any{"status": "missing_scope", "error_type": "authorization", "error_subtype": "missing_scope", "detail": "m", "code": int64(99991679), "missing_scopes": []string{"mail:user_mailbox:readonly"}}},
		{`{"ok":false,"error":{"type":"authentication","subtype":"unknown","message":"m"}}`,
			map[string]any{"status": "auth_required", "error_type": "authentication", "error_subtype": "unknown", "detail": "m"}},
		{`{"ok":false,"error":{"type":"api","subtype":"rate_limited","code":99991400,"message":"m"}}`,
			map[string]any{"status": "failed", "error_type": "api", "error_subtype": "rate_limited", "detail": "m", "code": int64(99991400)}},
		{`{"ok":false,"error":{"type":"config","subtype":"not_configured","message":"not configured","hint":"run lark-cli config init --new"}}`,
			map[string]any{"status": "not_configured", "error_type": "config", "error_subtype": "not_configured", "detail": "not configured"}},
		{`panic: not json`, map[string]any{"status": "failed"}},
	}
	for _, testCase := range cases {
		tool, dir := fakeLarkCLI(t)
		answer(t, dir, "api-GET", "", testCase.stderr, 3)
		result := tool.Call(context.Background(), "api", json.RawMessage(`{"method":"GET","path":"/open-apis/mail/v1/user_mailboxes/me/profile"}`))
		if !reflect.DeepEqual(result, testCase.want) {
			t.Fatalf("stderr %s: result = %#v", testCase.stderr, result)
		}
	}
}

func TestFeishuMailStatusNamesTheMailbox(t *testing.T) {
	tool, dir := fakeLarkCLI(t)
	answer(t, dir, "auth-check", `{"ok":true,"granted":[],"missing":[]}`, "", 0)
	answer(t, dir, "api-GET", `{"ok":true,"data":{"primary_email_address":" Me@Example.COM "}}`, "", 0)
	result := tool.Call(context.Background(), "status", nil)
	if !reflect.DeepEqual(result, map[string]any{"status": "ok", "address": "me@example.com"}) {
		t.Fatalf("result = %#v", result)
	}
	if got := calledWith(t, dir, "auth-check"); got[3] != strings.Join(FeishuMailScopes, " ") {
		t.Fatalf("checked scopes = %q", got)
	}
}

func TestFeishuMailStatusTellsScopesTheAppDoesNotEnable(t *testing.T) {
	tool, dir := fakeLarkCLI(t)
	// lark-cli exits 1 when scopes are missing, with its report on stdout.
	answer(t, dir, "auth-check", `{"ok":false,"missing":["mail:a","mail:b"]}`, "", 1)
	answer(t, dir, "auth-scopes", `{"appId":"cli_test","brand":"lark","userScopes":["mail:a","docx:document:readonly"]}`, "", 0)
	result := tool.Call(context.Background(), "status", nil)
	want := map[string]any{"status": "missing_scope", "missing_scopes": []string{"mail:a", "mail:b"}, "app_missing_scopes": []string{"mail:b"}, "app_id": "cli_test", "brand": "lark"}
	if !reflect.DeepEqual(result, want) {
		t.Fatalf("result = %#v", result)
	}
}

func TestFeishuMailStatusReportsAnOwnerWhoIsNotLoggedIn(t *testing.T) {
	tool, dir := fakeLarkCLI(t)
	answer(t, dir, "auth-check", "", `{"ok":false,"error":{"type":"authentication","subtype":"not_logged_in","message":"m"}}`, 3)
	if result := tool.Call(context.Background(), "status", nil); result["status"] != "auth_required" {
		t.Fatalf("result = %#v", result)
	}
}

func TestFeishuMailReportsALarkCLINeverSetUp(t *testing.T) {
	// Before lark-cli config init, auth check exits 3 with the reason on
	// stdout, and a login answers it on stdout with exit 0.
	notConfigured := `{"ok":false,"error":{"type":"config","subtype":"not_configured","message":"not configured","hint":"run lark-cli config init --new"}}`
	tool, dir := fakeLarkCLI(t)
	answer(t, dir, "auth-check", notConfigured, "", 3)
	if result := tool.Call(context.Background(), "status", nil); result["status"] != "not_configured" {
		t.Fatalf("status = %#v", result)
	}
	if entries, _ := filepath.Glob(filepath.Join(dir, "api-GET.argv")); len(entries) != 0 {
		t.Fatal("the mailbox was read before lark-cli was set up")
	}
	answer(t, dir, "auth-login", notConfigured, "", 0)
	if result := tool.Call(context.Background(), "login_start", json.RawMessage(`{"login_id":"feishu_upstream_1"}`)); result["status"] != "not_configured" {
		t.Fatalf("login = %#v", result)
	}
}

func TestFeishuMailLoginKeepsTheDeviceCodeOnTheComputer(t *testing.T) {
	tool, dir := fakeLarkCLI(t)
	answer(t, dir, "auth-login", `{"device_code":"secret-code","verification_url":"https://accounts.feishu.cn/verify?code=1","expires_in":600}`, "", 0)
	login := json.RawMessage(`{"login_id":"feishu_upstream_1"}`)
	started := tool.Call(context.Background(), "login_start", login)
	if started["status"] != "ok" || started["verification_url"] != "https://accounts.feishu.cn/verify?code=1" || started["expires_in"] != 600 {
		t.Fatalf("started = %#v", started)
	}
	for _, value := range started {
		if value == "secret-code" {
			t.Fatal("the device code left the Computer")
		}
	}
	if got := calledWith(t, dir, "auth-login"); got[3] != strings.Join(FeishuMailScopes, " ") || got[4] != "--no-wait" {
		t.Fatalf("login argv = %q", got)
	}
	answer(t, dir, "auth-login-device", `{"ok":true}`, "", 0)
	if result := tool.Call(context.Background(), "login_wait", login); result["status"] != "ok" {
		t.Fatalf("wait = %#v", result)
	}
	if got := calledWith(t, dir, "auth-login-device"); got[3] != "secret-code" {
		t.Fatalf("wait argv = %q", got)
	}
	if result := tool.Call(context.Background(), "login_wait", login); result["status"] != "expired" {
		t.Fatalf("a finished login was kept: %#v", result)
	}
	if result := tool.Call(context.Background(), "login_start", json.RawMessage(`{"login_id":"../x"}`)); result["status"] != "invalid_request" {
		t.Fatalf("an invalid login name was accepted: %#v", result)
	}
}

func TestFeishuMailLoginWaitAnswersPendingBeforeTheDeadline(t *testing.T) {
	tool, dir := fakeLarkCLI(t)
	answer(t, dir, "auth-login", `{"device_code":"c","verification_url":"https://accounts.feishu.cn/v","expires_in":600}`, "", 0)
	wait := json.RawMessage(`{"login_id":"l1"}`)
	tool.Call(context.Background(), "login_start", wait)
	if err := os.WriteFile(filepath.Join(dir, "auth-login-device.sleep"), []byte("5"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), loginWaitMargin+time.Second)
	defer cancel()
	if result := tool.Call(ctx, "login_wait", wait); result["status"] != "pending" {
		t.Fatalf("wait = %#v", result)
	}
	if err := os.Remove(filepath.Join(dir, "auth-login-device.sleep")); err != nil {
		t.Fatal(err)
	}
	answer(t, dir, "auth-login-device", `{"ok":true}`, "", 0)
	if result := tool.Call(context.Background(), "login_wait", wait); result["status"] != "ok" {
		t.Fatalf("the pending login was dropped: %#v", result)
	}
}

func TestFeishuMailLoginExpires(t *testing.T) {
	tool, dir := fakeLarkCLI(t)
	answer(t, dir, "auth-login", `{"device_code":"c","verification_url":"https://accounts.feishu.cn/v","expires_in":60}`, "", 0)
	login := json.RawMessage(`{"login_id":"l1"}`)
	tool.Call(context.Background(), "login_start", login)
	tool.now = func() time.Time { return time.Now().Add(time.Minute) }
	if result := tool.Call(context.Background(), "login_wait", login); result["status"] != "expired" {
		t.Fatalf("wait = %#v", result)
	}
	answer(t, dir, "auth-login", `{"device_code":"c","verification_url":"http://plain.example/v","expires_in":60}`, "", 0)
	if result := tool.Call(context.Background(), "login_start", login); result["status"] != "failed" {
		t.Fatalf("a non-HTTPS verification link was accepted: %#v", result)
	}
}

func TestFeishuMailWithoutLarkCLI(t *testing.T) {
	tool := &FeishuMail{resolve: func() (string, error) { return "", errors.New("missing") }, logins: map[string]feishuLogin{}}
	if result := tool.Call(context.Background(), "status", nil); result["status"] != "not_installed" {
		t.Fatalf("result = %#v", result)
	}
}

func TestLarkNativeBinaryRunsTheBinaryBesideTheNpmLauncher(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the npm launcher is a symlink on Unix")
	}
	root := t.TempDir()
	pkg := filepath.Join(root, "lib", "node_modules", "@larksuite", "cli")
	for _, dir := range []string{filepath.Join(pkg, "scripts"), filepath.Join(pkg, "bin"), filepath.Join(root, "bin")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(pkg, "scripts", "run.js"), []byte("#!/usr/bin/env node\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "bin", "lark-cli")
	if err := os.Symlink(filepath.Join(pkg, "scripts", "run.js"), link); err != nil {
		t.Fatal(err)
	}
	if _, ok := larkNativeBinary(link); ok {
		t.Fatal("a launcher without its native binary was accepted")
	}
	native := filepath.Join(pkg, "bin", "lark-cli")
	if err := os.WriteFile(native, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	got, ok := larkNativeBinary(link)
	want, _ := filepath.EvalSymlinks(native)
	if !ok || got != want {
		t.Fatalf("larkNativeBinary = %q, %v; want %q", got, ok, want)
	}
}
