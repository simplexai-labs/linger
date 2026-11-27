package native

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

func TestAntigravityHookEndpointWritesHooksConfigAndRoutesBySession(t *testing.T) {
	if AntigravityHookTimeout != 15*time.Second {
		t.Fatalf("AntigravityHookTimeout = %v, want 15s", AntigravityHookTimeout)
	}
	ep, err := newAntigravityHookEndpoint("/opt/linger/daemon's-bin", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ep.Close() })

	hooksPath := filepath.Join(ep.Dir(), ".agents", "hooks.json")
	raw, err := os.ReadFile(hooksPath)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]map[string][]map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("hooks.json is invalid JSON: %v", err)
	}
	entry := doc["linger-steer"]
	if len(entry["PreInvocation"]) != 1 || len(entry["Stop"]) != 1 {
		t.Fatalf("unexpected hooks.json structure: %s", raw)
	}
	if runtime.GOOS == "windows" {
		if len(entry["PreToolUse"]) != 0 {
			t.Fatalf("expected resident PreToolUse omitted on Windows: %s", raw)
		}
	} else {
		if len(entry["PreToolUse"]) != 1 {
			t.Fatalf("unexpected PreToolUse structure: %s", raw)
		}
		if entry["PreToolUse"][0]["matcher"] != "run_command" {
			t.Fatalf("unexpected PreToolUse matcher: %v", entry["PreToolUse"][0])
		}
		nestedPreToolUse, _ := entry["PreToolUse"][0]["hooks"].([]any)
		if len(nestedPreToolUse) != 1 {
			t.Fatalf("unexpected PreToolUse hooks: %v", entry["PreToolUse"][0])
		}
		preToolUseCmd, _ := nestedPreToolUse[0].(map[string]any)["command"].(string)
		if !strings.Contains(preToolUseCmd, ep.URL()+"?event=PreToolUse") {
			t.Fatalf("PreToolUse hook command=%q missing ?event=PreToolUse", preToolUseCmd)
		}
	}
	cmd, _ := entry["PreInvocation"][0]["command"].(string)
	if !strings.Contains(cmd, "antigravity-hook") || !strings.Contains(cmd, ep.URL()) || strings.Contains(cmd, "?event=PreToolUse") {
		t.Fatalf("hook command=%q unexpected for PreInvocation URL %q", cmd, ep.URL())
	}

	// Unregistered sessions fail open with {} for PreInvocation and {"decision":"allow"} for PreToolUse.
	var out, errBuf bytes.Buffer
	code := AntigravityRunHook(strings.NewReader(`{"hookEventName":"PreInvocation","conversationId":"unknown","invocationNum":1}`), &out, &errBuf, ep.URL())
	if code != 0 || strings.TrimSpace(out.String()) != "{}" {
		t.Fatalf("unregistered PreInvocation code=%d out=%q", code, out.String())
	}
	out.Reset()
	code = AntigravityRunHook(strings.NewReader(`{"hookEventName":"PreToolUse","conversationId":"unknown","toolCall":{"name":"run_command"}}`), &out, &errBuf, ep.URL())
	if code != 0 || strings.TrimSpace(out.String()) != `{"decision":"allow"}` {
		t.Fatalf("unregistered PreToolUse code=%d out=%q", code, out.String())
	}
	out.Reset()
	code = AntigravityRunHook(strings.NewReader(`{"hookEventName":"PreToolUse"}`), &out, &errBuf, ep.URL())
	if code != 0 || strings.TrimSpace(out.String()) != `{"decision":"allow"}` {
		t.Fatalf("missing conversationId PreToolUse code=%d out=%q", code, out.String())
	}

	// Registered session receives the event and returns injectSteps; empty PreToolUse decision defaults to allow.
	var seenReq AntigravityHookRequest
	unreg := ep.Register("sess-1", func(_ context.Context, req AntigravityHookRequest) AntigravityHookResponse {
		seenReq = req
		if req.HookEventName == "PreInvocation" {
			return AntigravityHookResponse{
				InjectSteps: []AntigravityInjectStep{{UserMessage: "change direction"}},
			}
		}
		return AntigravityHookResponse{}
	})
	defer unreg()

	out.Reset()
	code = AntigravityRunHook(strings.NewReader(`{"hookEventName":"PreInvocation","conversationId":"sess-1","invocationNum":2}`), &out, &errBuf, ep.URL())
	if code != 0 {
		t.Fatalf("registered hook exit code=%d", code)
	}
	if seenReq.ConversationID != "sess-1" || seenReq.InvocationNum != 2 || seenReq.HookEventName != "PreInvocation" {
		t.Fatalf("seenReq=%+v", seenReq)
	}
	var resp AntigravityHookResponse
	if err := json.Unmarshal(out.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response %q: %v", out.String(), err)
	}
	if len(resp.InjectSteps) != 1 || resp.InjectSteps[0].UserMessage != "change direction" {
		t.Fatalf("resp=%+v", resp)
	}

	out.Reset()
	code = AntigravityRunHook(strings.NewReader(`{"hookEventName":"PreToolUse","conversationId":"sess-1","toolCall":{"name":"run_command"}}`), &out, &errBuf, ep.URL())
	if code != 0 || strings.TrimSpace(out.String()) != `{"decision":"allow"}` {
		t.Fatalf("empty PreToolUse response should default to allow: code=%d out=%q", code, out.String())
	}

	// After unregistering, the session fails open again.
	unreg()
	out.Reset()
	code = AntigravityRunHook(strings.NewReader(`{"hookEventName":"Stop","conversationId":"sess-1","fullyIdle":false}`), &out, &errBuf, ep.URL())
	if code != 0 || strings.TrimSpace(out.String()) != "{}" {
		t.Fatalf("after unregister code=%d out=%q", code, out.String())
	}
}

func TestAntigravityRunHookFailsOpenAndSupportsDenyTools(t *testing.T) {
	ep, err := newAntigravityHookEndpoint("/bin/daemon", "")
	if err != nil {
		t.Fatal(err)
	}
	url := ep.URL()
	_ = ep.Close()

	var out, errBuf bytes.Buffer
	code := AntigravityRunHook(strings.NewReader(`{"hookEventName":"PreInvocation","conversationId":"sess-1"}`), &out, &errBuf, url)
	if code != 0 || out.String() != "{}\n" {
		t.Fatalf("unreachable PreInvocation hook code=%d out=%q", code, out.String())
	}

	out.Reset()
	code = AntigravityRunHook(strings.NewReader(`{"hookEventName":"PreToolUse","conversationId":"sess-1"}`), &out, &errBuf, url)
	if code != 0 || out.String() != "{\"decision\":\"allow\"}\n" {
		t.Fatalf("unreachable PreToolUse hook code=%d out=%q", code, out.String())
	}

	out.Reset()
	code = AntigravityRunHook(strings.NewReader(`{"hookEventName":"PreToolUse"}`), &out, &errBuf, "https://example.com/not-loopback")
	if code != 0 || out.String() != "{\"decision\":\"allow\"}\n" {
		t.Fatalf("non-loopback PreToolUse hook code=%d out=%q", code, out.String())
	}

	out.Reset()
	code = AntigravityRunHook(strings.NewReader(`{}`), &out, &errBuf, "http://127.0.0.1:1/bad")
	if code != 0 || out.String() != "{}\n" {
		t.Fatalf("closed port hook code=%d out=%q", code, out.String())
	}

	out.Reset()
	code = AntigravityRunHook(strings.NewReader(`{}`), &out, &errBuf, "https://example.com/not-loopback")
	if code != 0 || out.String() != "{}\n" {
		t.Fatalf("non-loopback hook code=%d out=%q", code, out.String())
	}

	out.Reset()
	code = AntigravityRunHook(strings.NewReader(`{"hookEventName":"PreToolUse","toolCall":{"name":"run_command"}}`), &out, &errBuf, antigravityHookDenyToolsArg)
	var denyResp AntigravityHookResponse
	if code != 0 || json.Unmarshal(out.Bytes(), &denyResp) != nil || denyResp.Decision != "deny" || denyResp.Reason == "" {
		t.Fatalf("deny-tools hook code=%d out=%q", code, out.String())
	}

	// PreToolUse URL fails open with {"decision":"allow"} even when stdin exceeds 1 MiB or is invalid JSON.
	liveEP, err := newAntigravityHookEndpoint("/bin/daemon", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = liveEP.Close() })
	preToolUseURL := liveEP.URL() + "?event=PreToolUse"
	oversized := strings.Repeat("x", maxAntigravityHookBytes+16)

	for name, body := range map[string]string{
		"oversized":    oversized,
		"invalid_json": "{not-json",
	} {
		t.Run("run_hook_pretooluse_"+name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			code := AntigravityRunHook(strings.NewReader(body), &stdout, &stderr, preToolUseURL)
			if code != 0 || stdout.String() != "{\"decision\":\"allow\"}\n" {
				t.Fatalf("PreToolUse %s code=%d out=%q, want allow", name, code, stdout.String())
			}
		})
		t.Run("endpoint_serve_pretooluse_"+name, func(t *testing.T) {
			resp, postErr := http.Post(preToolUseURL, "application/json", strings.NewReader(body))
			if postErr != nil {
				t.Fatal(postErr)
			}
			defer resp.Body.Close()
			respBody, _ := io.ReadAll(resp.Body)
			if resp.StatusCode != http.StatusOK || strings.TrimSpace(string(respBody)) != `{"decision":"allow"}` {
				t.Fatalf("serve PreToolUse %s status=%d body=%q, want allow", name, resp.StatusCode, string(respBody))
			}
		})
	}
}

func TestAntigravitySharedHookEndpointCloseCleansTempDir(t *testing.T) {
	t.Cleanup(func() { _ = CloseAntigravitySharedHookEndpoint() })

	ep1, err := AntigravitySharedHookEndpoint()
	if err != nil {
		t.Fatal(err)
	}
	dir1 := ep1.Dir()
	if _, err := os.Stat(filepath.Join(dir1, ".agents", "hooks.json")); err != nil {
		t.Fatalf("expected hooks.json in %q: %v", dir1, err)
	}
	if err := CloseAntigravitySharedHookEndpoint(); err != nil {
		t.Fatalf("CloseAntigravitySharedHookEndpoint error: %v", err)
	}
	if _, err := os.Stat(dir1); !os.IsNotExist(err) {
		t.Fatalf("expected temp dir %q removed after close, stat err=%v", dir1, err)
	}
	if err := CloseAntigravitySharedHookEndpoint(); err != nil {
		t.Fatalf("idempotent close error: %v", err)
	}

	ep2, err := AntigravitySharedHookEndpoint()
	if err != nil {
		t.Fatalf("re-init error: %v", err)
	}
	if ep2.Dir() == dir1 {
		t.Fatalf("expected fresh temp dir after close, got %q again", dir1)
	}
}

func TestAntigravityHookEndpointCanonicalizesDir(t *testing.T) {
	ep, err := newAntigravityHookEndpoint("/bin/daemon", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ep.Close() })

	resolved, err := filepath.EvalSymlinks(ep.Dir())
	if err != nil {
		t.Fatalf("EvalSymlinks(%q): %v", ep.Dir(), err)
	}
	if ep.Dir() != resolved {
		t.Fatalf("ep.Dir()=%q, want canonical symlink-resolved path %q", ep.Dir(), resolved)
	}
}

func TestAntigravityHookCommandForOS(t *testing.T) {
	const endpointURL = "http://127.0.0.1:54321/antigravity-hook/0123456789abcdef"

	winStandard := antigravityHookCommandForOS("windows", `C:\Program Files\Linger\linger-computer-daemon.exe`, endpointURL)
	wantWinStandard := `"C:\Program Files\Linger\linger-computer-daemon.exe" antigravity-hook ` + endpointURL
	if winStandard != wantWinStandard {
		t.Fatalf("windows standard command=%q, want %q", winStandard, wantWinStandard)
	}
	if strings.HasPrefix(winStandard, `"`) && strings.HasSuffix(winStandard, `"`) && strings.Count(winStandard, `"`) > 2 {
		t.Fatalf("windows standard command would have quotes stripped by cmd /c: %q", winStandard)
	}

	for _, specialExe := range []string{
		`C:\Program Files (x86)\Linger\linger-computer-daemon.exe`,
		`C:\Users\A&B\linger-computer-daemon.exe`,
	} {
		got := antigravityHookCommandForOS("windows", specialExe, endpointURL)
		want := `""` + specialExe + `" antigravity-hook "` + endpointURL + `""`
		if got != want {
			t.Fatalf("windows special exe (%q) command=%q, want %q", specialExe, got, want)
		}
	}

	posix := antigravityHookCommandForOS("darwin", "/opt/linger/daemon's-bin", endpointURL)
	wantPosix := `'/opt/linger/daemon'\''s-bin' antigravity-hook '` + endpointURL + `'`
	if posix != wantPosix {
		t.Fatalf("posix command=%q, want %q", posix, wantPosix)
	}
}

func TestAntigravityHookEndpointUsesOperationTempBaseAndCleansUp(t *testing.T) {
	opTempBase := filepath.Join(t.TempDir(), "daemon-state", "operation-tmp")
	ep, err := newAntigravityHookEndpoint("/bin/daemon", opTempBase)
	if err != nil {
		t.Fatal(err)
	}
	expectedBase := opTempBase
	if resolved, err := filepath.EvalSymlinks(opTempBase); err == nil && resolved != "" {
		expectedBase = resolved
	}
	hookDir := ep.Dir()
	opTempDir := filepath.Dir(hookDir)
	if !strings.HasPrefix(opTempDir, expectedBase+string(os.PathSeparator)) {
		_ = ep.Close()
		t.Fatalf("hook endpoint dir %q is not under operation-tmp base %q", hookDir, expectedBase)
	}
	if err := privatefs.CheckPath(hookDir, "directory", true); err != nil {
		_ = ep.Close()
		t.Fatalf("hookDir not private: %v", err)
	}
	if err := privatefs.CheckPath(filepath.Join(hookDir, ".agents", "hooks.json"), "file", true); err != nil {
		_ = ep.Close()
		t.Fatalf("hooks.json not private: %v", err)
	}
	if removed, _, err := localworkspace.PruneOperationTemps(opTempBase, nil); err != nil || removed != 0 {
		_ = ep.Close()
		t.Fatalf("prune removed active hook endpoint dir: removed=%d err=%v", removed, err)
	}
	if err := ep.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := os.Stat(opTempDir); !os.IsNotExist(err) {
		t.Fatalf("hook operation temp dir survived Close: %v", err)
	}

	// Shared singleton respects ConfigureAntigravityHookTempBase.
	t.Cleanup(func() {
		_ = CloseAntigravitySharedHookEndpoint()
		ConfigureAntigravityHookTempBase("")
	})
	_ = CloseAntigravitySharedHookEndpoint()
	ConfigureAntigravityHookTempBase(opTempBase)
	shared, err := AntigravitySharedHookEndpoint()
	if err != nil {
		t.Fatalf("AntigravitySharedHookEndpoint: %v", err)
	}
	sharedOpDir := filepath.Dir(shared.Dir())
	if !strings.HasPrefix(sharedOpDir, expectedBase+string(os.PathSeparator)) {
		t.Fatalf("shared hook dir %q is not under configured base %q", shared.Dir(), expectedBase)
	}
	if err := CloseAntigravitySharedHookEndpoint(); err != nil {
		t.Fatalf("CloseAntigravitySharedHookEndpoint: %v", err)
	}
	if _, err := os.Stat(sharedOpDir); !os.IsNotExist(err) {
		t.Fatalf("shared hook dir survived close: %v", err)
	}
}

func TestAntigravityHookEndpointCloseJoinsRemoveRootError(t *testing.T) {
	sentinel := os.ErrPermission
	ep := &AntigravityHookEndpoint{
		dir:        t.TempDir(),
		removeRoot: func() error { return sentinel },
	}
	if err := ep.Close(); !errors.Is(err, sentinel) {
		t.Fatalf("Close() = %v, want joined %v", err, sentinel)
	}
}

func TestAntigravityHooksDocumentOmitsPreToolUseOnWindows(t *testing.T) {
	exe := `C:\Program Files (x86)\Linger\linger-computer-daemon.exe`

	winDoc := antigravityHooksDocument("windows", exe, "http://127.0.0.1:12345/hook")
	winGroup := winDoc["linger-steer"].(map[string]any)
	if _, ok := winGroup["PreInvocation"]; !ok {
		t.Fatal("windows hooks document missing PreInvocation")
	}
	if _, ok := winGroup["Stop"]; !ok {
		t.Fatal("windows hooks document missing Stop")
	}
	if _, ok := winGroup["PreToolUse"]; ok {
		t.Fatalf("windows hooks document must omit PreToolUse: %v", winGroup)
	}

	for _, goos := range []string{"darwin", "linux"} {
		posixDoc := antigravityHooksDocument(goos, "/opt/linger/daemon", "http://127.0.0.1:12345/hook")
		group := posixDoc["linger-steer"].(map[string]any)
		preToolUse, ok := group["PreToolUse"].([]any)
		if !ok || len(preToolUse) != 1 {
			t.Fatalf("%s hooks document missing PreToolUse: %v", goos, group)
		}
		nested := preToolUse[0].(map[string]any)["hooks"].([]any)
		cmd, _ := nested[0].(map[string]any)["command"].(string)
		if !strings.Contains(cmd, "http://127.0.0.1:12345/hook?event=PreToolUse") {
			t.Fatalf("%s PreToolUse command = %q", goos, cmd)
		}
	}
}
