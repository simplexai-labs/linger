package localtools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
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
	if strings.Contains(string(got), `"isError":true`) || !strings.Contains(string(got), `\"value\":2`) || strings.Contains(string(got), `"structuredContent"`) {
		t.Fatalf("state did not persist: %s", got)
	}
	got = f.execute(t, `return "line one\nsays \"hi\""`)
	if !strings.Contains(string(got), `{"text":"line one\nsays \"hi\"","type":"text"}`) || !strings.Contains(string(got), `\"value\":\"returned text shown above\"`) {
		t.Fatalf("returned text was not shown verbatim: %s", got)
	}
	if got = f.execute(t, `return null`); strings.Contains(string(got), `{"text":"","type":"text"}`) {
		t.Fatalf("a null value added an empty text part: %s", got)
	}
	if got = f.execute(t, `null.x`); !strings.Contains(string(got), `"hint"`) {
		t.Fatalf("a script error has no hint: %s", got)
	}
	if got = f.execute(t, `await ui.browser.no_such_method({})`); strings.Contains(string(got), `"hint"`) {
		t.Fatalf("a driver error got the script hint: %s", got)
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
	// A returned screenshot is delivered as an image part, so the result has
	// no structuredContent for Codex to show in place of it; the summary is
	// the last text part.
	var envelope struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
			Data string `json:"data"`
		} `json:"content"`
		Structured json.RawMessage `json:"structuredContent"`
	}
	if json.Unmarshal(first, &envelope) != nil || len(envelope.Content) != 2 || len(envelope.Structured) != 0 ||
		envelope.Content[0].Type != "image" || envelope.Content[0].Data != "aW1hZ2U=" {
		t.Fatalf("returned screenshot was not delivered as an image: %s", first)
	}
	var reply struct {
		Structured struct {
			Value json.RawMessage `json:"value"`
		}
	}
	if json.Unmarshal([]byte(envelope.Content[1].Text), &reply.Structured) != nil || len(reply.Structured.Value) == 0 {
		t.Fatal(string(first))
	}
	// A whole observation delivers its screenshot, and a note beside it does
	// not take the screenshot's place.
	for _, script := range []string{
		`return await ui.browser.take_screenshot({});`,
		`console.log('clicked'); return await ui.browser.take_screenshot({});`,
	} {
		if got := f.execute(t, script); !strings.Contains(string(got), `"data":"aW1hZ2U="`) || strings.Contains(string(got), `"structuredContent"`) {
			t.Fatalf("%s did not deliver the returned screenshot: %s", script, got)
		}
	}
	if text := f.execute(t, `return 1`); !strings.Contains(string(text), `"structuredContent":{`) {
		t.Fatalf("a result without images lost structuredContent: %s", text)
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

func TestUnifiedUIToolGuidanceAndInvalidHelpTopic(t *testing.T) {
	description := unifiedUITools()[0].Description
	for _, want := range []string{
		"macOS and Windows: when the user names an app and window, discover and read it in one call:",
		"To act, pass the role and name exactly as shown in v.text: v=await v.click(role,name).",
		"and ui.help('computer'), ui.help('browser'), or ui.help() for unfamiliar methods.",
	} {
		if !strings.Contains(description, want) {
			t.Fatalf("ui_exec description missing %q: %s", want, description)
		}
	}
	for _, stale := range []string{
		"macOS: when the user names",
		"Desktop: when the user names",
		"v.click('AXButton',name)",
		"'Button' on Windows",
		"ui.help(namespace)",
	} {
		if strings.Contains(description, stale) {
			t.Fatalf("ui_exec description kept stale text %q: %s", stale, description)
		}
	}

	f := newUIRuntimeFixture(t, false, func(context.Context, string, json.RawMessage) (json.RawMessage, error) {
		return uiTextResult("ok"), nil
	})
	clear, err := f.set.RegisterToolReviewer(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer clear()

	reply := cancellationSummary(t, f.execute(t, `await ui.help('window')`))
	wantErr := `help topic "window" is invalid; call ui.help() or ui.help("browser")`
	if !reply.IsError || !strings.Contains(reply.Structured.Error, wantErr) || strings.Contains(reply.Structured.Error, "computer") {
		t.Fatalf("invalid help topic error = %q (isError=%v), want %q", reply.Structured.Error, reply.IsError, wantErr)
	}

	for _, tc := range []struct {
		name      string
		endpoints map[string]mcpproxy.ToolEndpoint
		want      string
	}{
		{
			name:      "computer only",
			endpoints: map[string]mcpproxy.ToolEndpoint{"computer": {}},
			want:      `help topic "window" is invalid; call ui.help() or ui.help("computer")`,
		},
		{
			name:      "computer and browser",
			endpoints: map[string]mcpproxy.ToolEndpoint{"computer": {}, "browser": {}},
			want:      `help topic "window" is invalid; call ui.help(), ui.help("computer"), or ui.help("browser")`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			u := &uiExecution{endpoints: tc.endpoints}
			_, err := u.help(t.Context(), "window")
			if err == nil || err.Error() != tc.want {
				t.Fatalf("help() error = %v, want %q", err, tc.want)
			}
		})
	}
}
