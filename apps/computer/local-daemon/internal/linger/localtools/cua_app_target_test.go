package localtools

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestParseLSAppInfoExtractsBundleAndName(t *testing.T) {
	raw := `"CFBundleIdentifier"="com.apple.Safari"
"LSDisplayName"="Safari"
`
	bundle, name := parseLSAppInfo(raw)
	if bundle != "com.apple.Safari" || name != "Safari" {
		t.Fatalf("got (%q, %q), want (com.apple.Safari, Safari)", bundle, name)
	}
	pid, displayName := parseLSAppPIDAndName("pid = 512\n\"LSDisplayName\"=\"Google Chrome\"\n")
	if pid != 512 || displayName != "Google Chrome" {
		t.Fatalf("parseLSAppPIDAndName = (%d, %q)", pid, displayName)
	}
}

func TestPIDAppIdentityCachesAndHandlesPIDReuse(t *testing.T) {
	origStart := lookupPIDStart
	origInfo := lookupPIDAppInfo
	t.Cleanup(func() {
		lookupPIDStart = origStart
		lookupPIDAppInfo = origInfo
		pidAppCacheMu.Lock()
		pidAppCache = map[pidStartKey]cachedAppIdentity{}
		pidAppCacheMu.Unlock()
	})

	startTime := "Mon Nov 28 10:00:00 2026"
	appBundle := "com.apple.Safari"
	appName := "Safari"
	infoCalls := 0
	lookupPIDStart = func(_ context.Context, _ int) (string, error) {
		return startTime, nil
	}
	lookupPIDAppInfo = func(_ context.Context, _ int) (string, string, bool) {
		infoCalls++
		return appBundle, appName, true
	}

	b, n, ok := pidAppIdentity(context.Background(), 4242)
	if !ok || b != "com.apple.Safari" || n != "Safari" || infoCalls != 1 {
		t.Fatalf("first lookup: (%q, %q, %v) calls=%d", b, n, ok, infoCalls)
	}
	b, n, ok = pidAppIdentity(context.Background(), 4242)
	if !ok || b != "com.apple.Safari" || n != "Safari" || infoCalls != 1 {
		t.Fatalf("cached lookup: (%q, %q, %v) calls=%d", b, n, ok, infoCalls)
	}
	startTime = "Mon Nov 28 10:05:00 2026"
	appBundle = "com.apple.Notes"
	appName = "Notes"
	b, n, ok = pidAppIdentity(context.Background(), 4242)
	if !ok || b != "com.apple.Notes" || n != "Notes" || infoCalls != 2 {
		t.Fatalf("reused pid lookup: (%q, %q, %v) calls=%d", b, n, ok, infoCalls)
	}
}

func TestResolveAppTargetCoversAllCuaToolShapes(t *testing.T) {
	origStart := lookupPIDStart
	origInfo := lookupPIDAppInfo
	origName := lookupAppBundleByName
	t.Cleanup(func() {
		lookupPIDStart = origStart
		lookupPIDAppInfo = origInfo
		lookupAppBundleByName = origName
		pidAppCacheMu.Lock()
		pidAppCache = map[pidStartKey]cachedAppIdentity{}
		pidAppCacheMu.Unlock()
	})

	lookupPIDStart = func(_ context.Context, _ int) (string, error) { return "t1", nil }
	lookupPIDAppInfo = func(_ context.Context, pid int) (string, string, bool) {
		switch pid {
		case 10:
			return "com.apple.Safari", "Safari", true
		case 15:
			return "com.apple.Notes", "Notes", true
		case 20:
			return "com.apple.systempreferences", "System Settings", true
		default:
			return "", "", false
		}
	}
	lookupAppBundleByName = func(_ context.Context, name string) (string, string, bool) {
		if name == "Slack" {
			return "com.tinyspeck.slackmacgap", "Slack", true
		}
		return "", "", false
	}

	op := &operation{}
	op.reads.observe(cuaRead(t, "window_id=7 pid=10 snapshot_id=s1\n- [1] AXButton \"Go\"", map[string]string{"snapshot_id": "s1"}))

	// launch_app by bundle_id
	if got := op.resolveAppTarget(context.Background(), "launch_app", json.RawMessage(`{"bundle_id":"com.apple.Notes","name":"Notes"}`)); got == nil || got.BundleID != "com.apple.Notes" || got.App != "Notes" {
		t.Fatalf("launch_app bundle_id = %+v", got)
	}
	// launch_app by name
	if got := op.resolveAppTarget(context.Background(), "launch_app", json.RawMessage(`{"name":"Slack"}`)); got == nil || got.BundleID != "com.tinyspeck.slackmacgap" || got.App != "Slack" {
		t.Fatalf("launch_app name = %+v", got)
	}
	// pid
	if got := op.resolveAppTarget(context.Background(), "get_window_state", json.RawMessage(`{"pid":10}`)); got == nil || got.BundleID != "com.apple.Safari" {
		t.Fatalf("pid = %+v", got)
	}
	// element_token
	if got := op.resolveAppTarget(context.Background(), "click", json.RawMessage(`{"element_token":"s1:1"}`)); got == nil || got.BundleID != "com.apple.Safari" {
		t.Fatalf("element_token = %+v", got)
	}
	// run_actions prioritizes protected app over benign step
	if got := op.resolveAppTarget(context.Background(), "run_actions", json.RawMessage(`{"actions":[{"tool":"click","pid":10},{"tool":"click","pid":20}]}`)); got == nil || got.BundleID != "com.apple.systempreferences" {
		t.Fatalf("run_actions protected = %+v", got)
	}
	// run_actions rejects mixed unapproved apps so only one app cannot hide another
	if got := op.resolveAppTarget(context.Background(), "run_actions", json.RawMessage(`{"actions":[{"tool":"click","pid":10},{"tool":"click","pid":15}]}`)); got == nil || !strings.Contains(got.DenyReason, "COMPUTER_MULTI_APP_BATCH") {
		t.Fatalf("run_actions multi-app = %+v", got)
	}
	// run_actions rejects mixed resolved + unresolved step (fail closed)
	if got := op.resolveAppTarget(context.Background(), "run_actions", json.RawMessage(`{"actions":[{"tool":"click","pid":10},{"tool":"click","pid":999}]}`)); got == nil || !strings.Contains(got.DenyReason, "COMPUTER_TARGET_REQUIRED") {
		t.Fatalf("run_actions unresolved mix = %+v", got)
	}
	// run_actions with single unapproved app across multiple steps returns that app
	if got := op.resolveAppTarget(context.Background(), "run_actions", json.RawMessage(`{"actions":[{"tool":"click","pid":10},{"tool":"type_text","pid":10}]}`)); got == nil || got.BundleID != "com.apple.Safari" || got.DenyReason != "" {
		t.Fatalf("run_actions single app = %+v", got)
	}
	// run_script args.bundle_id
	if got := op.resolveAppTarget(context.Background(), "run_script", json.RawMessage(`{"args":{"bundle_id":"com.apple.Notes","app":"Notes"},"script":"return 1"}`)); got == nil || got.BundleID != "com.apple.Notes" {
		t.Fatalf("run_script args = %+v", got)
	}
	// run_script literal getApp("com.apple.Notes")
	if got := op.resolveAppTarget(context.Background(), "run_script", json.RawMessage(`{"script":"const app = cua.getApp('com.apple.Notes');"}`)); got == nil || got.BundleID != "com.apple.Notes" {
		t.Fatalf("run_script literal = %+v", got)
	}
	// run_script referencing multiple unapproved apps is rejected
	if got := op.resolveAppTarget(context.Background(), "run_script", json.RawMessage(`{"script":"cua.getApp('com.apple.Safari'); cua.getApp('com.apple.Notes');"}`)); got == nil || !strings.Contains(got.DenyReason, "COMPUTER_MULTI_APP_SCRIPT") {
		t.Fatalf("run_script multi-app = %+v", got)
	}
	// run_script with no target and no approved apps refuses upfront rather than empty allowlist
	if got := op.resolveAppTarget(context.Background(), "run_script", json.RawMessage(`{"script":"return 1;"}`)); got == nil || !strings.Contains(got.DenyReason, "COMPUTER_TARGET_REQUIRED") {
		t.Fatalf("run_script targetless = %+v", got)
	}
}

func TestGuardedScriptEnforcesApprovedAppsNamesAndReroutes(t *testing.T) {
	script := guardedScript("{}", "return cua.getApp('Google Chrome');", 0, 10, 10, &scriptAppAllowlist{
		PIDs:    []int{10, 11},
		Bundles: []string{"com.google.chrome"},
		Names:   []string{"google chrome"},
	})
	for _, want := range []string{
		"COMPUTER_APP_NOT_APPROVED",
		`{"10":true,"11":true}`,
		`{"com.google.chrome":true}`,
		`{"google chrome":true}`,
		"checkReroute",
		"checkAppCall(k, c, o)",
		"checkAppResult",
	} {
		if !strings.Contains(script, want) {
			t.Errorf("guardedScript missing %q:\n%s", want, script)
		}
	}
}
