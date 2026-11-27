package uiruntime

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func nodeRuntime(t *testing.T, dispatch func(context.Context, Call) (json.RawMessage, error), limits Limits) *Runtime {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("bundled-compatible Node is unavailable")
	}
	node, err = filepath.Abs(node)
	if err != nil {
		t.Fatal(err)
	}
	engineDir, err := filepath.Abs("../../../node_modules/quickjs-wasi")
	if err != nil {
		t.Fatal(err)
	}
	r, err := New(t.Context(), Options{NodePath: node, QuickJSDirectory: engineDir, Dispatch: dispatch, Limits: limits})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := r.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	return r
}
func noCalls(t *testing.T) func(context.Context, Call) (json.RawMessage, error) {
	return func(context.Context, Call) (json.RawMessage, error) {
		t.Error("unexpected dispatch")
		return nil, errors.New("unexpected dispatch")
	}
}
func execute(t *testing.T, r *Runtime, code string) Result {
	t.Helper()
	result, err := r.Exec(t.Context(), t.Context(), code)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
func TestPersistentStateOpaqueOutputAndMethodDispatch(t *testing.T) {
	var calls []Call
	r := nodeRuntime(t, func(_ context.Context, c Call) (json.RawMessage, error) {
		calls = append(calls, c)
		return json.RawMessage(`{"image":{"handle":"opaque"},"answer":7}`), nil
	}, Limits{})
	first := execute(t, r, `const local = 9; state.answer = await ui.computer.inspect({app:"test"}); ui.emit(state.answer.image); return local;`)
	if string(first.Value) != "9" || len(first.Output) != 1 || string(first.Output[0]) != `{"handle":"opaque"}` {
		t.Fatalf("result=%+v", first)
	}
	second := execute(t, r, `return [state.answer.answer, typeof local];`)
	if string(second.Value) != `[7,"undefined"]` || second.Generation != first.Generation {
		t.Fatalf("result=%+v", second)
	}
	execute(t, r, `await ui.browser.click({ref:"node"}); await ui.help("browser");`)
	if len(calls) != 3 || calls[0].Namespace != "computer" || calls[1].Namespace != "browser" || calls[2].Namespace != "help" || calls[2].Method != "browser" || calls[0].Generation != first.Generation || calls[0].ExecutionID == calls[1].ExecutionID {
		t.Fatalf("calls=%+v", calls)
	}
	if err := r.Reset(t.Context()); err != nil {
		t.Fatal(err)
	}
	reset := execute(t, r, `return typeof state.answer;`)
	if string(reset.Value) != `"undefined"` || reset.Generation <= first.Generation {
		t.Fatalf("reset=%+v", reset)
	}
}
func TestSerialAwaitedCallsAndGuestErrorHandling(t *testing.T) {
	var calls atomic.Int32
	r := nodeRuntime(t, func(_ context.Context, c Call) (json.RawMessage, error) {
		calls.Add(1)
		if c.Method == "fail" {
			return nil, errors.New("fixture rejected")
		}
		return c.Arguments, nil
	}, Limits{})
	result := execute(t, r, `const a = await Promise.all([ui.browser.read({id:1}), ui.browser.read({id:2})]); let message; try {await ui.computer.fail({});} catch (error) {message = error.message;} return {a,message};`)
	if calls.Load() != 3 || !strings.Contains(string(result.Value), "fixture rejected") {
		t.Fatalf("result=%s calls=%d", result.Value, calls.Load())
	}
}
func TestGuestHasNoHostAuthorityOrDynamicCode(t *testing.T) {
	t.Setenv("NODE_OPTIONS", "--invalid-option-must-not-be-inherited")
	t.Setenv("UI_SECRET_FIXTURE", "not-for-the-child")
	r := nodeRuntime(t, noCalls(t), Limits{})
	result := execute(t, r, `const results = [typeof process, typeof require, typeof Buffer, typeof fetch, typeof setTimeout];
 for (const fn of [() => Function("return 1")(), () => ui.emit.constructor("return process")(), () => state.constructor.constructor("return process")()]) {
  try {fn(); results.push("escaped");} catch {results.push("denied");}
 }
 try {await import("node:fs"); results.push("imported");} catch {results.push("denied");}
 return results;`)
	if strings.Contains(string(result.Value), "escaped") || strings.Contains(string(result.Value), "imported") || string(result.Value) != `["undefined","undefined","undefined","undefined","undefined","denied","denied","denied","denied"]` {
		t.Fatal(string(result.Value))
	}
}
func TestUnawaitedCallsCannotReachAnotherExecution(t *testing.T) {
	var calls atomic.Int32
	r := nodeRuntime(t, func(_ context.Context, c Call) (json.RawMessage, error) {
		calls.Add(1)
		return json.RawMessage(`{}`), nil
	}, Limits{})
	generation := r.Generation()
	_, err := r.Exec(t.Context(), t.Context(), `ui.browser.write({}); return "done";`)
	if err == nil || !strings.Contains(err.Error(), "awaited") || calls.Load() != 0 || r.Generation() <= generation {
		t.Fatalf("err=%v calls=%d", err, calls.Load())
	}
	execute(t, r, `return "fresh";`)
	if calls.Load() != 0 {
		t.Fatal("detached call leaked")
	}
	_, err = r.Exec(t.Context(), t.Context(), `await ui.browser.read({}); ui.browser.write({});`)
	if err == nil || calls.Load() != 1 {
		t.Fatalf("err=%v calls=%d", err, calls.Load())
	}
}
func TestSchedulingCancellationDrainsOneDispatch(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	r := nodeRuntime(t, func(ctx context.Context, c Call) (json.RawMessage, error) {
		calls.Add(1)
		close(entered)
		select {
		case <-ctx.Done():
			return nil, errors.New("scheduling cancellation reached dispatch")
		case <-release:
		}
		return json.RawMessage(`{"completed":true}`), nil
	}, Limits{})
	scheduling, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := r.Exec(t.Context(), scheduling, `await ui.browser.write({}); await ui.browser.write({});`)
		done <- err
	}()
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("no callback")
	}
	before := r.Generation()
	cancel()
	deadline := time.After(3 * time.Second)
	for r.Generation() == before {
		select {
		case <-deadline:
			t.Fatal("guest not invalidated while dispatch drained")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	if _, err := r.Exec(t.Context(), t.Context(), `return 1;`); !errors.Is(err, ErrBusy) {
		t.Fatalf("exec while draining: %v", err)
	}
	if err := r.Reset(t.Context()); !errors.Is(err, ErrBusy) {
		t.Fatalf("reset while draining: %v", err)
	}
	select {
	case err := <-done:
		t.Fatalf("returned before dispatch receipt: %v", err)
	default:
	}
	close(release)
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("did not finish")
	}
	if calls.Load() != 1 {
		t.Fatal("scheduled after cancellation")
	}
	execute(t, r, `return 2;`)
}
func TestHardCancellationReachesDispatchedCallback(t *testing.T) {
	entered := make(chan struct{})
	r := nodeRuntime(t, func(ctx context.Context, c Call) (json.RawMessage, error) {
		close(entered)
		<-ctx.Done()
		return nil, context.Cause(ctx)
	}, Limits{})
	hard, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := r.Exec(hard, t.Context(), `await ui.computer.write({});`); done <- err }()
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("no dispatch")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("hard cancellation hung")
	}
}
func TestResourceFailuresInvalidateAndRecover(t *testing.T) {
	cases := []struct {
		name, code string
		limits     Limits
	}{
		{"sync-loop", `for (;;) {}`, Limits{PumpTimeout: 20 * time.Millisecond}},
		{"microtask-loop", `await Promise.resolve(); for (;;) {}`, Limits{PumpTimeout: 20 * time.Millisecond}},
		{"pending-promise", `await new Promise(() => {});`, Limits{MaxWallTime: 200 * time.Millisecond}},
		{"output", `ui.emit("x".repeat(300));`, Limits{MaxOutputBytes: 128}},
		{"unicode-output", `ui.emit("\u2603".repeat(60));`, Limits{MaxOutputBytes: 128}},
		{"calls", `await ui.browser.read({}); await ui.browser.read({});`, Limits{MaxCalls: 1}},
		{"serialization-getter", `return { get value() { for (;;) {} } };`, Limits{PumpTimeout: 20 * time.Millisecond}},
		{"protocol-frame", `await ui.browser.read({text:"x".repeat(2000)});`, Limits{MaxProtocolBytes: 1024, MaxOutputBytes: 128}},
		{"cyclic-output", `const value = {}; value.self = value; ui.emit(value);`, Limits{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := nodeRuntime(t, func(context.Context, Call) (json.RawMessage, error) { return json.RawMessage(`{}`), nil }, tc.limits)
			generation := r.Generation()
			_, err := r.Exec(t.Context(), t.Context(), tc.code)
			if err == nil || r.Generation() <= generation {
				t.Fatalf("error=%v generation=%d", err, r.Generation())
			}
			execute(t, r, `return 1;`)
		})
	}
}
func TestCodeBoundAndPrecancelDoNotDispatch(t *testing.T) {
	r := nodeRuntime(t, noCalls(t), Limits{MaxCodeBytes: 16})
	if _, err := r.Exec(t.Context(), t.Context(), strings.Repeat(" ", 17)); err == nil {
		t.Fatal("large code accepted")
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := r.Exec(t.Context(), cancelled, `return 1;`); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	execute(t, r, `return 1;`)
}
func TestConfigurationValidation(t *testing.T) {
	for _, opts := range []Options{
		{NodePath: "node", QuickJSDirectory: "/engine", Dispatch: noCalls(t)},
		{NodePath: "/node", QuickJSDirectory: "engine", Dispatch: noCalls(t)},
		{NodePath: "/node", QuickJSDirectory: "/engine"},
		{NodePath: "/node", QuickJSDirectory: "/engine", Dispatch: noCalls(t), Limits: Limits{MaxCalls: -1}},
	} {
		if _, err := New(t.Context(), opts); err == nil {
			t.Fatal("invalid configuration accepted")
		}
	}
}

func TestOldContinuationCannotDispatchInNewExecution(t *testing.T) {
	r := nodeRuntime(t, noCalls(t), Limits{})
	execute(t, r, `state.later = new Promise(resolve => {state.resolve = resolve;}); state.task = (async () => {await state.later; try {await ui.browser.click({});} catch {state.staleDenied = true;}})();`)
	result := execute(t, r, `state.resolve(); await state.task; return state.staleDenied;`)
	if string(result.Value) != "true" {
		t.Fatalf("stale continuation not denied: %s", result.Value)
	}
}

func TestHelpOverviewAndStaleHelper(t *testing.T) {
	r := nodeRuntime(t, func(_ context.Context, c Call) (json.RawMessage, error) {
		if c.Namespace != "help" || c.Method != "" {
			t.Errorf("unexpected call: %+v", c)
		}
		return json.RawMessage(`"overview"`), nil
	}, Limits{})
	execute(t, r, `state.data = 7; state.helper = () => ui.browser.click({}); return await ui.help();`)
	result := execute(t, r, `try {await state.helper(); return "bad";} catch {return state.data;}`)
	if string(result.Value) != "7" {
		t.Fatalf("result=%s", result.Value)
	}
}

func TestCloseRevokesActiveCallbackAndPreventsReuse(t *testing.T) {
	entered := make(chan struct{})
	r := nodeRuntime(t, func(ctx context.Context, _ Call) (json.RawMessage, error) {
		close(entered)
		<-ctx.Done()
		return nil, context.Cause(ctx)
	}, Limits{})
	done := make(chan error, 1)
	go func() { _, err := r.Exec(t.Context(), t.Context(), `await ui.browser.click({});`); done <- err }()
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("no callback")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	if err := r.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("execution error=%v", err)
	}
	if _, err := r.Exec(t.Context(), t.Context(), `return 1;`); !errors.Is(err, ErrClosed) {
		t.Fatalf("reuse error=%v", err)
	}
}

func TestUnconfirmedCleanupPreventsReplacement(t *testing.T) {
	root := t.TempDir()
	r, err := New(t.Context(), Options{NodePath: filepath.Join(root, "node"), QuickJSDirectory: filepath.Join(root, "quickjs"), Dispatch: noCalls(t)})
	if err != nil {
		t.Fatal(err)
	}
	defer r.cancel()
	c := &child{exited: make(chan struct{}), ctx: context.Background()}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := r.reapContext(ctx, c); !errors.Is(err, ErrCleanupUnconfirmed) {
		t.Fatal(err)
	}
	if _, err := r.Exec(t.Context(), t.Context(), `return 1;`); !errors.Is(err, ErrCleanupUnconfirmed) {
		t.Fatalf("reopened after unknown cleanup: %v", err)
	}
	close(c.exited)
	if err := r.reapContext(t.Context(), c); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Exec(t.Context(), t.Context(), `return 1;`); !errors.Is(err, ErrCleanupUnconfirmed) {
		t.Fatalf("poison was cleared: %v", err)
	}
}

func TestReferenceRequiresOneExactNamedControl(t *testing.T) {
	r := nodeRuntime(t, noCalls(t), Limits{})
	result := execute(t, r, `const snap = text => ({content:[{type:"text",text}]});
const row = '- button "Save" [active] [ref=e5]';
const found = ui.ref(snap('- button "Save draft" [ref=e6]\n'+row), 'button','Save');
let rejected = 0;
for(const text of [row+'\n'+row, '- heading "Save" [ref=e2]']){
  try { ui.ref(snap(text),'button','Save') } catch { rejected++ }
}
return [found,rejected];`)
	if string(result.Value) != `["e5",2]` {
		t.Fatalf("lookup: %s", result.Value)
	}
}

func TestReferenceHandlesPlaywrightQuotedKeys(t *testing.T) {
	r := nodeRuntime(t, noCalls(t), Limits{})
	result := execute(t, r, `const snap = text => ({content:[{type:'text',text}]});
const button = "- 'button \"Order #42: Jo''s\" [active] [ref=e4]'";
const field = "- 'textbox \"Menu: title\" [ref=e3]': Value";
const matched = [ui.ref(snap(button),'button',"Order #42: Jo's"), ui.ref(snap(field),'textbox','Menu: title')];
try { ui.ref(snap(button+'\n'+button),'button',"Order #42: Jo's"); } catch { matched.push('ambiguous'); }
return matched;`)
	if string(result.Value) != `["e4","e3","ambiguous"]` {
		t.Fatalf("quoted lookup: %s", result.Value)
	}
}

func TestWindowObservationRevalidatesBeforeClick(t *testing.T) {
	var clicks int
	r := nodeRuntime(t, func(_ context.Context, c Call) (json.RawMessage, error) {
		if c.Method == "get_window_state" {
			return json.RawMessage(`{"content":[{"type":"text","text":"window_id=8 pid=42 snapshot_id=s17\n  - [4] AXButton \"Save\""}]}`), nil
		}
		if c.Method != "click" || !strings.Contains(string(c.Arguments), `"element_token":"s17:4"`) {
			t.Fatalf("unexpected call %s %s", c.Method, c.Arguments)
		}
		clicks++
		return json.RawMessage(`{}`), nil
	}, Limits{})
	result := execute(t, r, `const w=ui.window(42,8);const first=await w.observe(), second=await w.observe();try{await first.click("AXButton","Save");return false}catch{}await second.click("AXButton","Save");return true`)
	if string(result.Value) != "true" || clicks != 1 {
		t.Fatal(result, clicks)
	}
}

func TestPageObservationInvalidatedByRawBrowserCall(t *testing.T) {
	writes := 0
	r := nodeRuntime(t, func(_ context.Context, c Call) (json.RawMessage, error) {
		switch c.Method {
		case "snapshot":
			return json.RawMessage(`{"content":[{"type":"text","text":"- button \"Save\" [ref=e7]"}]}`), nil
		case "click":
			writes++
			if string(c.Arguments) != `{"target":"e7"}` {
				t.Fatal(string(c.Arguments))
			}
		default:
			t.Fatal(c.Method)
		}
		return json.RawMessage(`{}`), nil
	}, Limits{})
	result := execute(t, r, `const p=await ui.page(), old=await p.observe();await ui.browser.snapshot({});try{await old.click("button","Save");return false}catch{}await (await p.observe()).click("button","Save");return true`)
	if string(result.Value) != "true" || writes != 1 {
		t.Fatal(result, writes)
	}
}

func TestPageActionContinuesFromReceiptAndReadsMissingSnapshotOnce(t *testing.T) {
	var calls []string
	r := nodeRuntime(t, func(_ context.Context, c Call) (json.RawMessage, error) {
		calls = append(calls, c.Method)
		var text string
		switch len(calls) {
		case 1:
			text = "- textbox \"Reference\" [ref=e1]"
		case 2:
			if c.Method != "type" || string(c.Arguments) != `{"target":"e1","text":"AB"}` {
				return nil, errors.New("incorrect field")
			}
			text = "Input delivered"
		case 3:
			text = "- button \"Save\" [ref=e4]"
		case 4:
			if c.Method != "click" || string(c.Arguments) != `{"target":"e4"}` {
				return nil, errors.New("incorrect control")
			}
			text = "### Snapshot\n```yaml\n- heading \"Saved\"\n```"
		default:
			return nil, errors.New("unexpected driver call")
		}
		return json.Marshal(map[string]any{"content": []map[string]string{{"type": "text", "text": text}}})
	}, Limits{})
	result := execute(t, r, `const first=await ui.page();
const typed=await first.type("textbox","Reference","AB");
try { await first.type("textbox","Reference","AB"); return false; } catch {}
const saved=await typed.click("button","Save");
return saved.text.includes('heading "Saved"') && typed.content[0].text === "Input delivered";`)
	if string(result.Value) != "true" || strings.Join(calls, ",") != "snapshot,type,snapshot,click" {
		t.Fatalf("calls=%v result=%+v", calls, result)
	}
}

func TestWindowActionUsesBoundReadbackAndRefusesAnotherWindow(t *testing.T) {
	var calls []string
	r := nodeRuntime(t, func(_ context.Context, c Call) (json.RawMessage, error) {
		calls = append(calls, c.Method)
		var args struct {
			PID    int    `json:"pid"`
			Window int    `json:"window_id"`
			Token  string `json:"element_token"`
		}
		if json.Unmarshal(c.Arguments, &args) != nil || args.PID != 42 || args.Window != 8 {
			return nil, errors.New("incorrect window")
		}
		var view string
		switch len(calls) {
		case 1:
			view = "window_id=8 pid=42 snapshot_id=s01\n- [3] AXButton \"Open\""
		case 2:
			if args.Token != "s01:3" {
				return nil, errors.New("incorrect first token")
			}
			view = "window_id=8 pid=42 snapshot_id=s02\n- [7] AXButton \"Save\""
		case 3:
			if args.Token != "s02:7" {
				return nil, errors.New("incorrect second token")
			}
			view = "window_id=9 pid=42 snapshot_id=s03\n- [7] AXButton \"Save\""
		default:
			return nil, errors.New("unexpected driver call")
		}
		return json.Marshal(map[string]any{"content": []map[string]string{{"type": "text", "text": view}}})
	}, Limits{})
	result := execute(t, r, `const w=ui.window(42,8), first=await w.observe(), second=await first.click("AXButton","Open");
try {await first.click("AXButton","Open"); return false;} catch {}
const other=await second.click("AXButton","Save");
try {await other.click("AXButton","Save"); return false;} catch {return true;}`)
	if string(result.Value) != "true" || strings.Join(calls, ",") != "get_window_state,click,click" {
		t.Fatalf("calls=%v result=%+v", calls, result)
	}
}

func TestFormBatchResolvesEveryTargetBeforeDispatch(t *testing.T) {
	var fills int
	r := nodeRuntime(t, func(_ context.Context, c Call) (json.RawMessage, error) {
		switch c.Method {
		case "snapshot":
			return json.RawMessage(`{"content":[{"type":"text","text":"- textbox \"ID\" [ref=e1]\n- combobox \"Route\" [ref=e2]"}]}`), nil
		case "fill_form":
			fills++
			if string(c.Arguments) != `{"fields":[{"target":"e1","type":"textbox","name":"ID","value":"12"},{"target":"e2","type":"combobox","name":"Route","value":"East"}]}` {
				t.Errorf("batch arguments: %s", c.Arguments)
			}
			return json.RawMessage(`{"content":[{"type":"text","text":"filled"}]}`), nil
		default:
			return nil, errors.New("unexpected method")
		}
	}, Limits{})
	result := execute(t, r, `let v=await ui.page();
const id={type:"textbox",name:"ID",value:"12"},route={type:"combobox",name:"Route",value:"East"};
for (const invalid of [[id,{...route,name:"Missing"}],[id,id]]) {
  try {await v.fill(invalid); return false;} catch {}
}
const after=await v.fill([id,route]);
try {await v.fill([id]);return false;} catch {}
return after.text.includes("Route");`)
	if string(result.Value) != "true" || fills != 1 {
		t.Fatalf("batch count=%d result=%+v", fills, result)
	}
}
func TestPageReturnsObservationAndConsoleJoinsOutput(t *testing.T) {
	r := nodeRuntime(t, func(_ context.Context, c Call) (json.RawMessage, error) {
		if c.Method == "navigate" {
			return json.RawMessage(`{}`), nil
		}
		return json.RawMessage(`{"content":[{"type":"text","text":"- heading \"Example\""}]}`), nil
	}, Limits{MaxOutputBytes: 128})
	result := execute(t, r, `const v=await ui.page("https://example.com");
console.log("title", {n:1}); console.error(new Error("boom")); console.log("x".repeat(100));
const again=await v.observe();
try { ui.window(1,2).text; return false; } catch {}
return v.text.includes("Example") && again.text === v.text;`)
	if string(result.Value) != "true" || len(result.Output) != 2 || string(result.Output[0]) != `"title {\"n\":1}"` || string(result.Output[1]) != `"boom"` {
		t.Fatalf("result=%+v output=%s", result, result.Output)
	}
	failed, err := r.Exec(context.Background(), context.Background(), `console.log("before"); null.x;`)
	if err == nil || !strings.Contains(err.Error(), "TypeError: ") || len(failed.Output) != 1 || string(failed.Output[0]) != `"before"` {
		t.Fatalf("err=%v output=%s", err, failed.Output)
	}
	// Multi-byte logs stay within the console's share, so a return value that
	// fits the rest of the budget still completes the script.
	logged := execute(t, r, `for (let i = 0; i < 20; i++) console.log("\u00e9\u00e9\u00e9\u00e9\u00e9"); return "x".repeat(80);`)
	if len(logged.Output) == 0 || len(logged.Output) >= 20 {
		t.Fatalf("console share was not enforced: %s", logged.Output)
	}
}

func TestLateHandledRejectionKeepsState(t *testing.T) {
	r := nodeRuntime(t, noCalls(t), Limits{})
	first := execute(t, r, `state.kept = 1; const p = Promise.reject(new Error("x")); await null; try { await p } catch {} return "caught";`)
	second := execute(t, r, `return state.kept;`)
	if string(first.Value) != `"caught"` || string(second.Value) != "1" || second.Generation != first.Generation {
		t.Fatalf("first=%+v second=%+v", first, second)
	}
}
func TestUnserializableArgumentsDoNotConsumeCallID(t *testing.T) {
	r := nodeRuntime(t, func(_ context.Context, c Call) (json.RawMessage, error) { return c.Arguments, nil }, Limits{})
	result := execute(t, r, `const cyclic = {}; cyclic.self = cyclic;
for (const bad of [{n: 1n}, cyclic]) { try { await ui.browser.click(bad); return "sent"; } catch {} }
return await ui.browser.click({ok: true});`)
	if string(result.Value) != `{"ok":true}` {
		t.Fatalf("result=%+v", result)
	}
}
func TestOversizedDispatchResultRejectsOnlyTheCall(t *testing.T) {
	large := json.RawMessage(`"` + strings.Repeat("a", 4096) + `"`)
	r := nodeRuntime(t, func(context.Context, Call) (json.RawMessage, error) { return large, nil }, Limits{MaxProtocolBytes: 2048, MaxOutputBytes: 1024})
	first := execute(t, r, `state.kept = 1; try { await ui.browser.snapshot({}); return "delivered"; } catch (error) { return error.message; }`)
	second := execute(t, r, `return state.kept;`)
	if !strings.Contains(string(first.Value), "do not replay") || string(second.Value) != "1" || second.Generation != first.Generation {
		t.Fatalf("first=%+v second=%+v", first, second)
	}
}
func TestInvalidatedIdleChildIsReplaced(t *testing.T) {
	r := nodeRuntime(t, noCalls(t), Limits{})
	first := execute(t, r, `return 1;`)
	r.mu.Lock()
	c := r.child
	r.mu.Unlock()
	// Models a cancellation that lands after Exec has already returned.
	r.invalidate(c)
	second := execute(t, r, `return 2;`)
	if string(second.Value) != "2" || second.Generation <= first.Generation {
		t.Fatalf("second=%+v", second)
	}
}
func TestBridgeSetupIgnoresGuestCPUBudget(t *testing.T) {
	// The smallest budget is shorter than the trusted bridge setup.
	r := nodeRuntime(t, noCalls(t), Limits{PumpTimeout: time.Millisecond})
	if got := execute(t, r, `return 1;`); string(got.Value) != "1" {
		t.Fatalf("result=%+v", got)
	}
}

func TestWindowClickMatchesNonAXAndAXRoles(t *testing.T) {
	var calls []string
	r := nodeRuntime(t, func(_ context.Context, c Call) (json.RawMessage, error) {
		calls = append(calls, c.Method)
		var args struct {
			Token string `json:"element_token"`
		}
		_ = json.Unmarshal(c.Arguments, &args)
		var view string
		switch len(calls) {
		case 1:
			view = "window_id=8 pid=42 snapshot_id=s01\n- [4] AXButton \"Cancel\"\n- [5] Button \"Save\"\n- [6] MenuItem \"Export\""
		case 2:
			if args.Token != "s01:5" {
				return nil, errors.New("unexpected first token: " + args.Token)
			}
			view = "window_id=8 pid=42 snapshot_id=s02\n- [4] AXButton \"Cancel\"\n- [6] MenuItem \"Export\""
		case 3:
			if args.Token != "s02:6" {
				return nil, errors.New("unexpected second token: " + args.Token)
			}
			view = "window_id=8 pid=42 snapshot_id=s03\n- [4] AXButton \"Cancel\"\n- [8] Button \"Done\""
		case 4:
			if args.Token != "s03:4" {
				return nil, errors.New("unexpected third token: " + args.Token)
			}
			view = "window_id=8 pid=42 snapshot_id=s04\n- [8] Button \"Done\""
		default:
			return nil, errors.New("unexpected driver call")
		}
		return json.Marshal(map[string]any{"content": []map[string]string{{"type": "text", "text": view}}})
	}, Limits{})

	result := execute(t, r, `const w = ui.window(42, 8);
const v1 = await w.observe();
const v2 = await v1.click("Button", "Save");
const v3 = await v2.click("MenuItem", "Export");
const v4 = await v3.click("AXButton", "Cancel");
try {
  await v4.click("AXButton", "Done");
  return "unexpected";
} catch (error) {
  return error.message;
}`)
	if strings.Join(calls, ",") != "get_window_state,click,click,click" {
		t.Fatalf("calls=%v", calls)
	}
	var errMsg string
	if err := json.Unmarshal(result.Value, &errMsg); err != nil {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if !strings.Contains(errMsg, "copy the role and the quoted name exactly from v.text") || strings.Contains(errMsg, "copy the AX role") {
		t.Fatalf("unexpected unmatched role error: %q", errMsg)
	}
}
