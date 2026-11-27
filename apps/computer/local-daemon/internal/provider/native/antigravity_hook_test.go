package native

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

func TestAntigravityHookEndpointWritesHooksConfigAndRoutesBySession(t *testing.T) {
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
	cmd, _ := entry["PreInvocation"][0]["command"].(string)
	if !strings.Contains(cmd, "antigravity-hook") || !strings.Contains(cmd, ep.URL()) {
		t.Fatalf("hook command=%q missing antigravity-hook or URL %q", cmd, ep.URL())
	}

	// Unregistered sessions fail open with {}.
	var out, errBuf bytes.Buffer
	code := AntigravityRunHook(strings.NewReader(`{"hookEventName":"PreInvocation","conversationId":"unknown","invocationNum":1}`), &out, &errBuf, ep.URL())
	if code != 0 || strings.TrimSpace(out.String()) != "{}" {
		t.Fatalf("unregistered hook code=%d out=%q", code, out.String())
	}

	// Registered session receives the event and returns injectSteps.
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

	// After unregistering, the session fails open again.
	unreg()
	out.Reset()
	code = AntigravityRunHook(strings.NewReader(`{"hookEventName":"Stop","conversationId":"sess-1","fullyIdle":false}`), &out, &errBuf, ep.URL())
	if code != 0 || strings.TrimSpace(out.String()) != "{}" {
		t.Fatalf("after unregister code=%d out=%q", code, out.String())
	}
}

func TestAntigravityRunHookFailsOpenWhenEndpointUnreachable(t *testing.T) {
	ep, err := newAntigravityHookEndpoint("/bin/daemon", "")
	if err != nil {
		t.Fatal(err)
	}
	url := ep.URL()
	_ = ep.Close()

	var out, errBuf bytes.Buffer
	code := AntigravityRunHook(strings.NewReader(`{"hookEventName":"PreInvocation","conversationId":"sess-1"}`), &out, &errBuf, url)
	if code != 0 || out.String() != "{}\n" {
		t.Fatalf("unreachable hook code=%d out=%q", code, out.String())
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
