//go:build darwin || linux

package localtools

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

// Exercises the public unified HTTP surface against the pinned MCP and an
// isolated Chrome. No user's profile or extension participates.
func TestUnifiedUIBrowserLive(t *testing.T) {
	if os.Getenv("LINGER_UI_BROWSER_PROBE") != "1" {
		t.Skip("opt-in real unified browser probe")
	}
	node, entry, chrome := os.Getenv("LINGER_PLAYWRIGHT_COMPAT_NODE"), os.Getenv("LINGER_PLAYWRIGHT_COMPAT_ENTRY"), os.Getenv("LINGER_UI_BROWSER_CHROME")
	if node == "" || entry == "" || chrome == "" {
		t.Fatal("set browser probe paths")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Minute)
	defer cancel()
	profile := t.TempDir()
	process := exec.CommandContext(ctx, chrome, "--headless=new", "--remote-debugging-port=0", "--user-data-dir="+profile, "--no-first-run", "--no-default-browser-check", "about:blank")
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = process.Process.Kill(); _ = process.Wait() })
	var port string
	for deadline := time.Now().Add(30 * time.Second); port == "" && time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
		if data, err := os.ReadFile(filepath.Join(profile, "DevToolsActivePort")); err == nil {
			port, _, _ = strings.Cut(string(data), "\n")
		}
	}
	if port == "" {
		t.Fatal("Chrome did not open debugging port")
	}
	var submits atomic.Int32
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		switch r.URL.Path {
		case "/next":
			_, _ = fmt.Fprint(w, `<h1>Second page</h1><form id="f"><label>Note: Jo's order<input name="note"></label><button>Save #42</button></form><script>f.onsubmit=async e=>{e.preventDefault();await fetch('/saved',{method:'POST'});setTimeout(()=>document.body.innerHTML='<h1>Saved</h1>',150)}</script>`)
		case "/saved":
			submits.Add(1)
			_, _ = fmt.Fprint(w, "ok")
		default:
			_, _ = fmt.Fprint(w, `<h1>First page</h1><a href="/next">Next</a>`)
		}
	}))
	defer fixture.Close()
	m := laneManager(t, t.TempDir())
	m.options = Options{NodePath: node, PlaywrightEntry: entry, StateDirectory: t.TempDir()}
	m.env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + t.TempDir()}
	// Supply only the test's existing Chrome. Bind discovers its own tool
	// catalog and applies the same Operation policy as a normal Agent run.
	m.noEverydayChrome = true
	spec := provider.OperationSpec{AgentID: "unified-live", WorkingDirectory: t.TempDir()}
	m.browsers[spec.AgentID] = &nativeBrowser{endpoint: "http://127.0.0.1:" + port, done: make(chan struct{})}
	identity := mcpproxy.OperationIdentity{OperationID: t.Name(), ExecutionLeaseID: "lease", RuntimeType: "codex"}
	set, err := mcpproxy.Open(ctx, nil, identity)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := set.Close(); err != nil {
			t.Error(err)
		}
	})
	if err = m.Bind(ctx, spec, identity, set); err != nil {
		t.Fatal(err)
	}
	if err = m.BindUI(ctx, spec, identity, set); err != nil {
		t.Fatal(err)
	}
	release, err := set.RegisterToolReviewer(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	var config struct {
		Servers map[string]struct {
			URL string `json:"url"`
		} `json:"mcpServers"`
	}
	if err = json.Unmarshal(set.Config(), &config); err != nil {
		t.Fatal(err)
	}
	if len(config.Servers) != 1 || config.Servers["computer"].URL == "" {
		t.Fatalf("private drivers exposed: %s", set.Config())
	}
	f := &uiRuntimeFixture{set: set, url: config.Servers["computer"].URL}
	listed := f.rpc(t, ctx, "tools/list", nil)
	var catalog struct {
		Tools []tool `json:"tools"`
	}
	if err = json.Unmarshal(listed, &catalog); err != nil {
		t.Fatal(err)
	}
	if len(catalog.Tools) != 2 || catalog.Tools[0].Name != "ui_exec" || catalog.Tools[1].Name != "ui_reset" {
		t.Fatalf("public catalog: %s", listed)
	}
	check := func(code string) json.RawMessage {
		t.Helper()
		got := f.execute(t, code)
		if strings.Contains(string(got), `"isError":true`) {
			t.Fatalf("exec failed: %s", got)
		}
		return got
	}
	url, _ := json.Marshal(fixture.URL)
	check(`const help=await ui.help('browser');
if(help.methods.some(x=>x.name==='run_code_unsafe')) throw Error('unsafe capability exposed');
const first=await ui.page(` + string(url) + `);
await first.click('link','Next');
state.note='retained across calls'; return 'second page';`)
	got := check(`const second=await ui.page();
const filled=await second.type('textbox',"Note: Jo's order",state.note);
if(!filled.text.includes(state.note)) throw Error('state lost');
await filled.click('button','Save #42');
await ui.browser.wait_for({text:'Saved'});
ui.emit(await ui.browser.snapshot({})); ui.emit(await ui.browser.take_screenshot({})); return state.note;`)
	if submits.Load() != 1 || !strings.Contains(string(got), "Saved") || !strings.Contains(string(got), `"type":"image"`) || !strings.Contains(string(got), `"mimeType":"image/png"`) {
		t.Fatalf("completion or native image missing; submits=%d result=%s", submits.Load(), got)
	}
	reset := f.rpc(t, ctx, "tools/call", map[string]any{"name": "ui_reset", "arguments": map[string]any{}})
	if !strings.Contains(string(reset), `"reset":true`) {
		t.Fatal(string(reset))
	}
	after := check(`if(Object.keys(state).length)throw Error('state not reset');const snapshot=await ui.browser.snapshot({});ui.emit(snapshot);return 'reset retained page';`)
	if !strings.Contains(string(after), "Saved") || submits.Load() != 1 {
		t.Fatalf("reset changed page: %s", after)
	}
	if _, err = os.Stat(profile); err != nil {
		t.Fatal("reset removed profile", err)
	}
	t.Log("public ui_exec/ui_reset; actual MCP two-page async form; state retained; one submit; native image; reset retained page/profile")
}
