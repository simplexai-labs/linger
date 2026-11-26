package localtools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

type uiRuntimeFixture struct {
	set      *mcpproxy.Set
	url      string
	sequence atomic.Uint64
}

func newUIRuntimeFixture(t *testing.T, required bool, callback func(context.Context, string, json.RawMessage) (json.RawMessage, error)) *uiRuntimeFixture {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	identity := mcpproxy.OperationIdentity{OperationID: t.Name(), ExecutionLeaseID: "lease", RuntimeType: "codex"}
	set, err := mcpproxy.Open(t.Context(), nil, identity)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := set.Close(); err != nil {
			t.Error(err)
		}
	})
	methods := []tool{
		{Name: "browser_type", InputSchema: schema(map[string]any{})},
		{Name: "browser_snapshot", InputSchema: schema(map[string]any{})},
		{Name: "browser_click", InputSchema: schema(map[string]any{})},
		{Name: "browser_take_screenshot", InputSchema: schema(map[string]any{})},
	}
	original, err := openToolServer(t.Context(), identity, methods, callback, mcpproxy.LocalToolTimeout)
	if err != nil {
		t.Fatal(err)
	}
	err = set.AddLocal(mcpproxy.LocalBinding{Name: "browser", URL: original.url, ToolNames: []string{"browser_type", "browser_snapshot", "browser_click", "browser_take_screenshot"}, WaitReady: original.waitReady, Close: original.server.Close})
	if err != nil {
		t.Fatal(err)
	}
	entry, err := filepath.Abs("../../../../node_modules/@playwright/mcp/cli.js")
	if err != nil {
		t.Fatal(err)
	}
	m := &Manager{options: Options{NodePath: node, PlaywrightEntry: entry}}
	if err = m.BindUI(t.Context(), provider.OperationSpec{PermissionReview: required}, identity, set); err != nil {
		t.Fatal(err)
	}
	var config struct {
		Servers map[string]struct {
			URL string `json:"url"`
		} `json:"mcpServers"`
	}
	if err = json.Unmarshal(set.Config(), &config); err != nil {
		t.Fatal(err)
	}
	if len(config.Servers) != 1 || config.Servers["computer"].URL == "" {
		t.Fatalf("public tools were not unified: %s", set.Config())
	}
	if got := strings.Join(set.LocalToolNames(), ","); got != "mcp__computer__ui_exec,mcp__computer__ui_reset" {
		t.Fatal(got)
	}
	f := &uiRuntimeFixture{set: set, url: config.Servers["computer"].URL}
	f.rpc(t, t.Context(), "tools/list", nil)
	ready, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if err = set.WaitReady(ready); err != nil {
		t.Fatalf("private drivers incorrectly block readiness: %v", err)
	}
	return f
}

func (f *uiRuntimeFixture) rpc(t *testing.T, ctx context.Context, method string, params any) json.RawMessage {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": f.sequence.Add(1), "method": method, "params": params})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.url, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Result json.RawMessage `json:"result"`
	}
	if json.Unmarshal(data, &envelope) != nil || len(envelope.Result) == 0 {
		t.Fatalf("invalid response: %s", data)
	}
	return envelope.Result
}

func (f *uiRuntimeFixture) execute(t *testing.T, code string) json.RawMessage {
	t.Helper()
	return f.rpc(t, t.Context(), "tools/call", map[string]any{"name": "ui_exec", "arguments": map[string]any{"code": code, "timeout_ms": 30000}})
}

func TestUnifiedUIStateImagesAndPrivateCapabilities(t *testing.T) {
	var calls atomic.Int32
	f := newUIRuntimeFixture(t, false, func(_ context.Context, name string, _ json.RawMessage) (json.RawMessage, error) {
		calls.Add(1)
		if name == "browser_take_screenshot" {
			return json.RawMessage(`{"content":[{"type":"image","mimeType":"image/png","data":"aW1hZ2U="}]}`), nil
		}
		return uiTextResult(map[string]any{"page": "Ready"}), nil
	})
	if got := f.execute(t, `return 1`); !strings.Contains(string(got), "not ready") {
		t.Fatalf("unregistered reviewer accepted: %s", got)
	}
	clear, err := f.set.RegisterToolReviewer(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer clear()
	got := f.execute(t, `const help=await ui.help('browser'); state.count=1; const picture=await ui.browser.take_screenshot({}); if(picture.content[0].data!==undefined) throw new Error('image data entered guest'); state.picture=picture; ui.emit(picture); return help.methods.map(m=>m.name);`)
	if strings.Contains(string(got), `"isError":true`) || !strings.Contains(string(got), `"type":"image"`) || !strings.Contains(string(got), "take_screenshot") || !strings.Contains(string(got), "aW1hZ2U=") {
		t.Fatalf("image/capability result: %s", got)
	}
	got = f.execute(t, `state.count++; ui.emit(state.picture); ui.emit([1,2]); ui.emit(3); return state.count;`)
	if strings.Contains(string(got), `"isError":true`) || !strings.Contains(string(got), `"value":2`) {
		t.Fatalf("state did not persist: %s", got)
	}
	reset := f.rpc(t, t.Context(), "tools/call", map[string]any{"name": "ui_reset", "arguments": map[string]any{}})
	if !strings.Contains(string(reset), `"reset":true`) {
		t.Fatal(string(reset))
	}
	got = f.execute(t, `return Object.keys(state);`)
	if strings.Contains(string(got), `"isError":true`) || !strings.Contains(string(got), `"value":[]`) {
		t.Fatalf("state survived reset: %s", got)
	}
	if calls.Load() != 1 {
		t.Fatalf("reset or state reads called driver: %d", calls.Load())
	}
}

func TestUnifiedUIEmitsExplicitBrowserDiffFromViewsAndAcrossCalls(t *testing.T) {
	data, err := os.ReadFile("../../uiruntime/testdata/browser-snapshots.json")
	if err != nil {
		t.Fatal(err)
	}
	var snapshots map[string]json.RawMessage
	if err := json.Unmarshal(data, &snapshots); err != nil {
		t.Fatal(err)
	}
	var step atomic.Int32
	f := newUIRuntimeFixture(t, false, func(_ context.Context, name string, args json.RawMessage) (json.RawMessage, error) {
		switch n := step.Add(1); {
		case n == 1 && name == "browser_snapshot":
			return snapshots["initial"], nil
		case n == 2 && name == "browser_click" && strings.Contains(string(args), `"target":"e3"`):
			return json.RawMessage(`{"content":[{"type":"text","text":"Click delivered"}]}`), nil
		case n == 3 && name == "browser_snapshot":
			return snapshots["opened"], nil
		case n == 4 && name == "browser_type" && strings.Contains(string(args), `"target":"e8"`):
			return snapshots["edited"], nil
		case n == 5 && name == "browser_snapshot":
			return snapshots["edited"], nil
		default:
			return nil, errors.New("unexpected browser call: " + name + " " + string(args))
		}
	})
	clear, err := f.set.RegisterToolReviewer(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer clear()
	if catalog := f.rpc(t, t.Context(), "tools/list", nil); !strings.Contains(string(catalog), "ui.diff(before, after)") {
		t.Fatalf("ui_exec catalog omitted diff discovery: %s", catalog)
	}
	readText := func(result json.RawMessage) []string {
		t.Helper()
		var outer struct {
			IsError bool `json:"isError"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		}
		if err := json.Unmarshal(result, &outer); err != nil || outer.IsError {
			t.Fatalf("ui_exec result: %s (decode error: %v)", result, err)
		}
		texts := make([]string, 0, len(outer.Content))
		for _, part := range outer.Content {
			texts = append(texts, part.Text)
		}
		return texts
	}
	texts := readText(f.execute(t, `
const help = await ui.help('browser');
if (!help.helpers['ui.diff(prev, next)'] || help.methods.some(m => m.name.includes('diff'))) throw Error('diff help is misplaced');
const page = await ui.page();
const start = await page.observe();
state.before = start.text;
const opened = await start.click('button', "It's a test: Save");
if (opened.content[0].text !== 'Click delivered' || !opened.text.includes('### Snapshot')) throw Error('missing view readback');
const filled = await opened.type('textbox', 'Menu: title', 'Title: updated');
ui.emit(ui.diff(start, opened));
ui.emit(ui.diff(start, filled));
if (start.text !== state.before || !filled.text.includes('### Snapshot\n') || filled.text.includes('### Snapshot diff')) throw Error('source observation changed');
`))
	if len(texts) != 3 || !strings.HasPrefix(texts[0], "### Open tabs\n") ||
		!strings.Contains(texts[0], "### Snapshot diff\n") || !strings.Contains(texts[0], `+ - dialog "Editor"`) ||
		!strings.Contains(texts[1], `+ - dialog "Editor"`) || !strings.Contains(texts[1], "Title: updated") ||
		!strings.Contains(texts[1], "/url: /after") {
		t.Fatalf("emitted diffs: %q", texts)
	}
	later := readText(f.execute(t, `
const view = await (await ui.page()).observe();
ui.emit(ui.diff(state.before, view));
`))
	if len(later) != 2 || later[0] != texts[1] || step.Load() != 5 {
		t.Fatalf("cross-execution diff: %q, calls: %d", later, step.Load())
	}
}

type denyUIRequester struct {
	tool  string
	calls int
}

func (d *denyUIRequester) Request(_ string, request map[string]any, respond func(json.RawMessage) error) error {
	d.calls++
	action := request["action"].(map[string]any)
	d.tool, _ = action["tool"].(string)
	return respond(json.RawMessage(`{"decision":"deny","message":"fixture denied"}`))
}
func (*denyUIRequester) Forget(string) {}

func TestUnifiedUIReviewsOriginalActionBeforeDispatch(t *testing.T) {
	var dispatched atomic.Int32
	f := newUIRuntimeFixture(t, true, func(context.Context, string, json.RawMessage) (json.RawMessage, error) {
		dispatched.Add(1)
		return uiTextResult("ready"), nil
	})
	if _, err := f.set.RegisterToolReviewer(nil); err == nil {
		t.Fatal("required reviewer accepted nil")
	}
	requester := &denyUIRequester{}
	clear, err := f.set.RegisterToolReviewer(&permission.Reviewer{Requester: requester, LocalAllowed: f.set.LocalAllowed, LocalEvidence: f.set.LocalEvidence})
	if err != nil {
		t.Fatal(err)
	}
	defer clear()
	got := f.execute(t, `await ui.browser.click({});`)
	if !strings.Contains(string(got), "fixture denied") || dispatched.Load() != 0 || requester.tool != "mcp__browser__browser_click" {
		t.Fatalf("review bypass: %s %+v %d", got, requester, dispatched.Load())
	}
	got = f.execute(t, `return await ui.browser.snapshot({});`)
	if strings.Contains(string(got), `"isError":true`) || dispatched.Load() != 1 || requester.calls != 1 {
		t.Fatalf("read review changed: %s", got)
	}
	clear()
	if got = f.execute(t, `return await ui.browser.snapshot({});`); !strings.Contains(string(got), "not ready") {
		t.Fatalf("closed authority remained usable: %s", got)
	}
}

func TestUnifiedUIResetDoesNotClearUnknownWrites(t *testing.T) {
	var writes atomic.Int32
	f := newUIRuntimeFixture(t, false, func(_ context.Context, name string, _ json.RawMessage) (json.RawMessage, error) {
		if name == "browser_click" {
			writes.Add(1)
			return nil, errOutcomeUnknown
		}
		return uiTextResult("visible"), nil
	})
	clear, err := f.set.RegisterToolReviewer(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer clear()
	first := f.execute(t, `await ui.browser.click({});`)
	if !strings.Contains(string(first), `"status":"unknown"`) {
		t.Fatalf("unknown not retained: %s", first)
	}
	reset := f.rpc(t, t.Context(), "tools/call", map[string]any{"name": "ui_reset", "arguments": map[string]any{}})
	if !strings.Contains(string(reset), `\"unknown_actions\":[{\"server\":\"browser\",\"method\":\"browser_click\",\"status\":\"unknown\"}]`) {
		t.Fatalf("reset hid the unknown action: %s", reset)
	}
	second := f.execute(t, `await ui.browser.click({});`)
	if !strings.Contains(string(second), "cannot send further writes") || !strings.Contains(string(second), `"unknown_actions"`) || writes.Load() != 1 {
		t.Fatalf("unknown replayed: %s %d", second, writes.Load())
	}
	read := f.execute(t, `return await ui.browser.snapshot({});`)
	if strings.Contains(string(read), `"isError":true`) {
		t.Fatalf("unknown blocked observation: %s", read)
	}
}

func TestUnifiedUILocalOutcomeReceipts(t *testing.T) {
	var writes atomic.Int32
	f := newUIRuntimeFixture(t, false, func(_ context.Context, name string, _ json.RawMessage) (json.RawMessage, error) {
		switch name {
		case "browser_snapshot":
			return nil, errOutcomeUnknown
		case "browser_click":
			switch writes.Add(1) {
			case 1:
				return nil, errNotSent
			case 2:
				return nil, errors.New(errOutcomeUnknown.Error()) // Same display text, different outcome.
			default:
				return uiTextResult("clicked"), nil
			}
		case "browser_type":
			return uiTextResult(map[string]string{"outcome": "unknown"}), nil
		default:
			t.Fatalf("unexpected tool %s", name)
			return nil, nil
		}
	})
	_, err := f.set.RegisterToolReviewer(nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range []struct {
		script string
		status string
	}{
		{"await ui.browser.snapshot({})", "unknown"},
		{"await ui.browser.click({})", "not_dispatched"},
		{"await ui.browser.click({})", "failed"},
		{"await ui.browser.click({})", "confirmed"},
		{"await ui.browser.type({})", "unknown"},
	} {
		result := cancellationSummary(t, f.execute(t, step.script))
		receipts := result.Structured.Receipts
		if len(receipts) != 1 || receipts[0].Status != step.status {
			t.Fatalf("%s: receipts=%v, want %s", step.script, receipts, step.status)
		}
	}
	if final := f.execute(t, "await ui.browser.click({})"); !strings.Contains(string(final), "cannot send further writes") || writes.Load() != 3 {
		t.Fatalf("write after unknown write outcome: %s", final)
	}
}

func TestUnifiedUIAdvertisedMinimumBudgetCanRead(t *testing.T) {
	f := newUIRuntimeFixture(t, false, func(context.Context, string, json.RawMessage) (json.RawMessage, error) {
		return uiTextResult("page"), nil
	})
	_, err := f.set.RegisterToolReviewer(nil)
	if err != nil {
		t.Fatal(err)
	}
	var spec struct {
		Properties struct {
			Timeout struct {
				Minimum int64 `json:"minimum"`
			} `json:"timeout_ms"`
		} `json:"properties"`
	}
	if err = json.Unmarshal(unifiedUITools()[0].InputSchema, &spec); err != nil {
		t.Fatal(err)
	}
	for _, duration := range []int64{0, spec.Properties.Timeout.Minimum - 1, spec.Properties.Timeout.Minimum} {
		result := f.rpc(t, t.Context(), "tools/call", map[string]any{"name": "ui_exec", "arguments": map[string]any{"code": "return await ui.browser.snapshot({})", "timeout_ms": duration}})
		if duration == spec.Properties.Timeout.Minimum {
			summary := cancellationSummary(t, result)
			if summary.IsError || len(summary.Structured.Receipts) != 1 || summary.Structured.Receipts[0].Status != "confirmed" {
				t.Fatalf("minimum budget rejected read: %s", result)
			}
		} else if !strings.Contains(string(result), `"isError":true`) {
			t.Fatalf("accepted duration %d: %s", duration, result)
		}
	}
}

func TestUnifiedUIOperationStateIsolation(t *testing.T) {
	callback := func(context.Context, string, json.RawMessage) (json.RawMessage, error) {
		return uiTextResult("ok"), nil
	}
	first, second := newUIRuntimeFixture(t, false, callback), newUIRuntimeFixture(t, false, callback)
	for _, f := range []*uiRuntimeFixture{first, second} {
		clear, err := f.set.RegisterToolReviewer(nil)
		if err != nil {
			t.Fatal(err)
		}
		defer clear()
	}
	if got := first.execute(t, `state.secret='first'; return state.secret;`); strings.Contains(string(got), `"isError":true`) {
		t.Fatal(string(got))
	}
	if got := second.execute(t, `return Object.keys(state);`); !strings.Contains(string(got), `"value":[]`) {
		t.Fatalf("state crossed Operation boundary: %s", got)
	}
}

func TestUnifiedUIImageHandleExpiresAfterScriptFailure(t *testing.T) {
	f := newUIRuntimeFixture(t, false, func(context.Context, string, json.RawMessage) (json.RawMessage, error) {
		return json.RawMessage(`{"content":[{"type":"image","mimeType":"image/png","data":"aW1hZ2U="}]}`), nil
	})
	clear, err := f.set.RegisterToolReviewer(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer clear()
	first := f.execute(t, `return (await ui.browser.take_screenshot({})).content[0];`)
	var reply struct {
		Structured struct {
			Value json.RawMessage `json:"value"`
		} `json:"structuredContent"`
	}
	if json.Unmarshal(first, &reply) != nil || len(reply.Structured.Value) == 0 {
		t.Fatal(string(first))
	}
	failure := f.execute(t, `throw new Error('discard this state');`)
	if !strings.Contains(string(failure), `"state_reset":true`) {
		t.Fatal(string(failure))
	}
	reused := f.execute(t, `ui.emit(`+string(reply.Structured.Value)+`);`)
	if !strings.Contains(string(reused), "image handle is stale") {
		t.Fatalf("prior generation image escaped invalidation: %s", reused)
	}
}

func TestUnifiedUIExpandedImagesStayBounded(t *testing.T) {
	picture, _ := json.Marshal(map[string]any{"content": []any{map[string]string{"type": "image", "mimeType": "image/png", "data": strings.Repeat("a", 4*1024*1024)}}})
	f := newUIRuntimeFixture(t, false, func(context.Context, string, json.RawMessage) (json.RawMessage, error) { return picture, nil })
	clear, err := f.set.RegisterToolReviewer(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer clear()
	got := f.execute(t, `const picture=await ui.browser.take_screenshot({}); for(let i=0;i<8;i++) ui.emit(picture);`)
	if len(got) >= maxMCPBytes || !bytes.Contains(got, []byte("expanded output exceeds")) {
		t.Fatalf("image amplification was not bounded: bytes=%d", len(got))
	}
	nested := f.execute(t, `ui.emit({content:[{content:[{type:'text',text:'nested'}]}]});`)
	if !strings.Contains(string(nested), "cannot be nested") {
		t.Fatal(string(nested))
	}
}

func TestUIImageBudgetNeverFailsACompletedAction(t *testing.T) {
	u := &uiExecution{images: map[string]json.RawMessage{}, imageBytes: uiImageBudget}
	got, err := u.retainImages(json.RawMessage(`{"content":[{"type":"image","data":"AAAA","mimeType":"image/png"},{"type":"text","text":"clicked"}]}`))
	if err != nil || len(u.images) != 0 || !strings.Contains(string(got), "Image omitted") || !strings.Contains(string(got), "clicked") {
		t.Fatalf("got=%s err=%v", got, err)
	}
}

func TestUIUnreachableDriverIsNotDispatched(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()
	u := &uiExecution{}
	_, err = u.rpc(t.Context(), mcpproxy.ToolEndpoint{Name: "browser", URL: "http://" + address + "/mcp"}, "tools/call", map[string]any{})
	if !errors.Is(err, errNotSent) {
		t.Fatalf("err=%v", err)
	}
}
