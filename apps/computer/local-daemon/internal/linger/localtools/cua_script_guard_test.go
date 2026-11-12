package localtools

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// guardHarness runs a guarded script in node against a fake cua that logs
// what reaches it. The driver runs scripts in its own JS engine; node checks
// the same prelude's semantics.
const guardHarness = `import fs from "fs";
const log = [];
class App { constructor(n, pid, windowId) { this.n = n; this.pid = pid; this.windowId = windowId; } hotkey(keys, on, options) { log.push("hotkey:" + keys.join("+") + ":" + JSON.stringify({pid: this.pid, ...on, ...options})); return "hotkeyed"; } click(a) { log.push("raw:" + JSON.stringify(a)); return "clicked"; } typeText(text, on, options) { log.push("type:" + JSON.stringify(options)); return "typed"; } pressKey(key, on) { log.push("key:" + key); return "pressed"; } getState(options) { log.push("state:" + JSON.stringify(options)); return {tree_markdown: ""}; } }
const fake = { call(t, a) { log.push("call:" + t + ":" + JSON.stringify(a)); return Promise.resolve({ok: true}); },
  launch(name) { log.push("launched:" + name); return Promise.resolve(new App("l", 7, 1)); },
  getApp(target) { return Promise.resolve(new App("a", target && target.pid, target && target.windowId)); },
  listApps() { return Promise.resolve([new App("b")]); },
  box() { return Promise.resolve({inner: {app: new App("c")}}); },
  sleep(ms) { log.push("sleep:" + (ms >= 100 && ms < 250 ? "paced" : ms)); return Promise.resolve(); } };
Object.defineProperty(globalThis, "cua", {value: Object.freeze(fake), writable: false, configurable: false});
const AsyncFunction = (async function () {}).constructor;
let result;
try { result = await new AsyncFunction(fs.readFileSync(process.argv[2], "utf8"))(); } catch (e) { result = "threw:" + e.message; }
console.log(JSON.stringify({result, log}));
`

func TestScriptGuardRefusesForbiddenInputInAJSEngine(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	dir := t.TempDir()
	harness := filepath.Join(dir, "harness.mjs")
	if err := os.WriteFile(harness, []byte(guardHarness), 0o600); err != nil {
		t.Fatal(err)
	}
	cases := []struct{ name, body, want, notLogged string }{
		{"background call passes", `return await cua.call("click", {pid: 1});`, `call:click:{\"pid\":1}`, ""},
		{"top-level key", `return await cua.call("click", {delivery_mode: "foreground"});`, "threw:COMPUTER_SCRIPT_REFUSED", "call:"},
		{"computed nested key", `return await cua.call("click", {a: [{["deliv" + "ery_mode"]: "x"}]});`, "threw:COMPUTER_SCRIPT_REFUSED", "call:"},
		{"toJSON", `return await cua.call("click", {toJSON() { return {delivery_mode: "foreground"}; }});`, "threw:COMPUTER_SCRIPT_REFUSED", "call:"},
		{"app method", `const app = await cua.getApp({pid: 1}); return app.click({delivery_mode: "foreground"});`, "threw:COMPUTER_SCRIPT_REFUSED", "raw:"},
		{"handle in an array", `const apps = await cua.listApps(); return apps[0].click({delivery_mode: "foreground"});`, "threw:COMPUTER_SCRIPT_REFUSED", "raw:"},
		{"handle in an object", `const b = await cua.box(); return b.inner.app.click({out_file: "/tmp/x"});`, "threw:COMPUTER_SCRIPT_REFUSED", "raw:"},
		{"no global object", `return [typeof globalThis, typeof eval, typeof Function, typeof this].join(",");`, "undefined,undefined,undefined,undefined", ""},
		{"no function constructor", `return typeof (async function () {}).constructor;`, "undefined", ""},
		{"closing the wrapper", "return 1; }).call(undefined); })(globalThis.cua, globalThis, eval, Function); (function () { return (async function () {", "threw:COMPUTER_SCRIPT_REFUSED: the script is not one complete function body", "call:"},
		{"closing the wrapper to call", `}); await globalThis.cua.call("click", {["deliv" + "ery_mode"]: "foreground"}); (async function () {`, "threw:", "call:"},
		{"inputs", `return [args.n, DEADLINE].join(",");`, `"1,42"`, ""},
		{"read without a screenshot", `const app = await cua.getApp({pid: 1}); await app.getState(); await app.getState({query: "Search"}); await app.getState({include_screenshot: true}); return "read";`, `"state:{\"include_screenshot\":false}","state:{\"include_screenshot\":false,\"query\":\"Search\"}","state:{\"include_screenshot\":true}"`, ""},
		{"frozen builtins", `try { JSON.parse = () => ({delivery_mode: 1}); } catch (e) { return "refused"; } return "changed";`, "refused", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			script := filepath.Join(dir, "script.js")
			if err := os.WriteFile(script, []byte(guardedScript(`{"n":1}`, tc.body, 42, 0, 0)), 0o600); err != nil {
				t.Fatal(err)
			}
			out, err := exec.Command(node, harness, script).CombinedOutput()
			if err != nil {
				t.Fatalf("node: %v\n%s", err, out)
			}
			got := string(out)
			if !strings.Contains(got, tc.want) || tc.notLogged != "" && strings.Contains(got, `"`+tc.notLogged) {
				t.Fatalf("got %s, want %q without %q reaching the driver", got, tc.want, tc.notLogged)
			}
		})
	}
}

// A paced script waits before each input and stops at its input limit, and
// the inputs past it never reach the driver.
func TestScriptGuardPacesInputsForTheComputersChrome(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	dir := t.TempDir()
	harness := filepath.Join(dir, "harness.mjs")
	script := filepath.Join(dir, "script.js")
	body := `await cua.call("click", {pid: 1}); await cua.call("get_window_state", {pid: 1}); const app = await cua.getApp({pid: 1}); app.click({pid: 1}); await cua.call("press_key", {pid: 1}); return "done";`
	if err := os.WriteFile(harness, []byte(guardHarness), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(script, []byte(guardedScript(`{}`, body, 42, 2, 0)), 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(node, harness, script).CombinedOutput()
	if err != nil {
		t.Fatalf("node: %v\n%s", err, out)
	}
	got := string(out)
	if !strings.Contains(got, "threw:COMPUTER_SCRIPT_INPUT_LIMIT") || strings.Count(got, "sleep:paced") != 2 || strings.Contains(got, "press_key") || !strings.Contains(got, "call:get_window_state") {
		t.Fatalf("got %s", got)
	}
}

// In the Computer's own browser a script types with a short gap between
// characters unless it names one, and one fixed wait lasts at most
// scriptSleepLimit: pages are waited for with app.waitFor.
func TestScriptGuardSpeedsTypingAndCapsWaits(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	dir := t.TempDir()
	harness := filepath.Join(dir, "harness.mjs")
	script := filepath.Join(dir, "script.js")
	body := `const app = await cua.getApp({pid: 1}); await app.typeText("kettle", {role: "AXTextField"}); await app.typeText("pot", undefined, {delay_ms: 40}); await cua.sleep(5000); await cua.sleep(700); return "done";`
	if err := os.WriteFile(harness, []byte(guardHarness), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(script, []byte(guardedScript(`{}`, body, 42, 20, 0)), 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(node, harness, script).CombinedOutput()
	if err != nil {
		t.Fatalf("node: %v\n%s", err, out)
	}
	got := string(out)
	for _, want := range []string{`type:{\"delay_ms\":` + strconv.Itoa(agentChromeTypeDelay) + `}`, `type:{\"delay_ms\":40}`, `"sleep:` + strconv.Itoa(scriptSleepLimit) + `"`, `"sleep:700"`} {
		if !strings.Contains(got, want) {
			t.Fatalf("got %s, want %s", got, want)
		}
	}
}

// No script opens an app or URL, paced or not: launch_app's site checks hold,
// and the key rule knows every app the script reaches.
func TestScriptGuardRefusesLaunchApp(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	dir := t.TempDir()
	harness := filepath.Join(dir, "harness.mjs")
	if err := os.WriteFile(harness, []byte(guardHarness), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		body  string
		limit int
	}{
		{`return await cua.call("launch_app", {urls: ["https://example.com/"]});`, 2},
		{`return await cua.call("launch_app", {urls: ["https://example.com/"]});`, 0},
		{`return await cua.launch("com.google.Chrome");`, 0},
	} {
		script := filepath.Join(dir, "script.js")
		if err := os.WriteFile(script, []byte(guardedScript(`{}`, tc.body, 42, tc.limit, 0)), 0o600); err != nil {
			t.Fatal(err)
		}
		out, err := exec.Command(node, harness, script).CombinedOutput()
		if err != nil {
			t.Fatalf("node: %v\n%s", err, out)
		}
		if got := string(out); !strings.Contains(got, "threw:COMPUTER_SCRIPT_REFUSED") || strings.Contains(got, "call:launch_app") || strings.Contains(got, "launched") {
			t.Fatalf("%s (limit %d): got %s, want refused", tc.body, tc.limit, got)
		}
	}
}

// In the user's everyday Chrome a script sends no shortcut, typed text or
// unbound key; a plain key bound to an element and other input still go.
func TestScriptGuardRefusesKeysForTheEverydayChrome(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	dir := t.TempDir()
	harness := filepath.Join(dir, "harness.mjs")
	if err := os.WriteFile(harness, []byte(guardHarness), 0o600); err != nil {
		t.Fatal(err)
	}
	// The user's Chrome runs as pid 1. A script cannot tell which window a
	// token was read from, so it sends that Chrome no key at all.
	for _, tc := range []struct{ body, want string }{
		{`return await cua.call("hotkey", {pid: 1, window_id: 12, keys: ["cmd", "["]});`, "threw:COMPUTER_KEYS_REFUSED"},
		{`return await cua.call("hotkey", {keys: ["cmd", "w"]});`, "threw:COMPUTER_KEYS_REFUSED"},
		{`return await cua.call("hotkey", {pid: 2, keys: ["cmd", "s"]});`, "call:hotkey"},
		{`const app = await cua.getApp({pid: 1, windowId: 12}); return app.typeText("kettle", "s1:2");`, "threw:COMPUTER_KEYS_REFUSED"},
		{`const app = await cua.getApp({pid: 1, windowId: 9}); return app.hotkey(["cmd", "w"]);`, "threw:COMPUTER_KEYS_REFUSED"},
		{`const app = await cua.getApp({pid: 2, windowId: 5}); return app.hotkey(["cmd", "s"]);`, "hotkeyed"},
		{`return await cua.call("press_key", {pid: 1, window_id: 12, key: "return", element_token: "s1:2"});`, "threw:COMPUTER_KEYS_REFUSED"},
		{`const app = await cua.getApp({pid: 1, windowId: 12}); return app.pressKey("return", "s1:2");`, "threw:COMPUTER_KEYS_REFUSED"},
		{`const app = await cua.getApp({pid: 2, windowId: 5}); return app.pressKey("return", "s1:2");`, "pressed"},
		{`return await cua.call("click", {pid: 1, element_token: "s1:2"});`, "call:click"},
		{`return await cua.call("launch_app", {bundle_id: "com.google.Chrome"});`, "threw:COMPUTER_SCRIPT_REFUSED"},
		// Arguments that name an app or window of their own would override
		// the app the key is called on.
		{`const app = await cua.getApp({pid: 2, windowId: 5}); return app.hotkey(["cmd", "w"], undefined, {pid: 1});`, "threw:COMPUTER_KEYS_REFUSED"},
		{`const app = await cua.getApp({pid: 2, windowId: 5}); return app.pressKey("return", {app: "Google Chrome"});`, "threw:COMPUTER_KEYS_REFUSED"},
		{`return await cua.call("press_key", {pid: 2, key: "return", target: {pid: 1}});`, "threw:COMPUTER_KEYS_REFUSED"},
		{`const app = await cua.getApp({pid: 2, windowId: 5}); return app.pressKey("return", {role: "AXTextField", name: "Search"});`, "pressed"},
		// An app object whose pid the guard cannot read could be that Chrome.
		{`const apps = await cua.listApps(); return apps[0].hotkey(["cmd", "w"]);`, "threw:COMPUTER_KEYS_REFUSED"},
		{`const app = await cua.getApp({name: "Google Chrome"}); return app.hotkey(["cmd", "w"]);`, "threw:COMPUTER_KEYS_REFUSED"},
	} {
		script := filepath.Join(dir, "script.js")
		if err := os.WriteFile(script, []byte(guardedScript(`{}`, tc.body, 42, 20, 1)), 0o600); err != nil {
			t.Fatal(err)
		}
		out, err := exec.Command(node, harness, script).CombinedOutput()
		if err != nil {
			t.Fatalf("node: %v\n%s", err, out)
		}
		if got := string(out); !strings.Contains(got, tc.want) {
			t.Fatalf("%s: got %s, want %q", tc.body, got, tc.want)
		}
	}
}
