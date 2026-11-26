package uiruntime

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
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
	r, err := New(t.Context(), Options{NodePath: "/fixture/node", QuickJSDirectory: "/fixture/quickjs", Dispatch: noCalls(t)})
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
const doubleQuoted = '- ' + JSON.stringify('button "Details" [ref=e6]');
const plain = '- link "Next" [ref=e7]';
const crlf = snap([button, doubleQuoted, plain, ''].join('\r\n'));
matched.push(ui.ref(crlf,'button',"Order #42: Jo's"), ui.ref(crlf,'button','Details'), ui.ref(crlf,'link','Next'));
return matched;`)
	if string(result.Value) != `["e4","e3","ambiguous","e4","e6","e7"]` {
		t.Fatalf("quoted lookup: %s", result.Value)
	}
}

func TestBrowserSnapshotDiffWithPlaywrightObservations(t *testing.T) {
	fixtures, err := os.ReadFile("testdata/browser-snapshots.json")
	if err != nil {
		t.Fatal(err)
	}
	r := nodeRuntime(t, noCalls(t), Limits{})
	result := execute(t, r, "const {initial, opened, edited, closed, frameEdited} = "+string(fixtures)+";\n"+`
const diffText = (before, after) => ui.text(ui.diff(before, after)).split('### Snapshot diff\n')[1] ?? '';
const first = diffText(initial, opened);
const net = diffText(initial, edited);
const last = diffText(edited, closed);
const frame = diffText(closed, frameEdited);
const roundTrip = diffText(initial, closed);
const mixed = ui.text(initial).replaceAll('\n','\r\n').replace('\r\n  -','\n  -');
return {
  opened: first.includes('+ - dialog "Editor"') && first.includes("It''s a test: Save"),
  edited: net.includes('+ - dialog "Editor"') && net.includes('Title: updated') && net.includes('/url: /after'),
  closed: last.includes('- - dialog "Editor"') && !last.includes('Close editor'),
  net: roundTrip.includes('/url: /after') && !roundTrip.includes('dialog "Editor"'),
  iframe: frame.includes('~ - iframe [active] [ref=e5]:') &&
    frame.includes('+ - button "Frame updated" [active] [ref=f1e4]') &&
    frame.includes('- - button "Frame action" [ref=f1e3]') &&
    !frame.split('\n').some(line => line.trimStart() === '- main [ref=f1e2]:'),
  unchanged: diffText(initial, initial) === 'no_change: the accessibility tree matches the previous snapshot.',
  mixed: diffText(initial, mixed) === 'no_change: the accessibility tree matches the previous snapshot.',
  guide: net.endsWith('Unchanged elements omitted; call ui.browser.snapshot({}) for the full tree.'),
};
`)
	if string(result.Value) != `{"opened":true,"edited":true,"closed":true,"net":true,"iframe":true,"unchanged":true,"mixed":true,"guide":true}` {
		t.Fatalf("Playwright diff check: %s", result.Value)
	}
}

func TestBrowserSnapshotDiffPreservesMCPPartsAndUsesViewText(t *testing.T) {
	fixtures, err := os.ReadFile("testdata/browser-snapshots.json")
	if err != nil {
		t.Fatal(err)
	}
	r := nodeRuntime(t, noCalls(t), Limits{})
	result := execute(t, r, "const {initial, edited} = "+string(fixtures)+";\n"+`
const previous = ui.text(initial);
const text = ui.text(edited) + '\n### Events\n- Browser event as originally reported';
const part = Object.freeze({type:'text', text, annotations:{audience:['assistant']}});
const image = Object.freeze({type:'image', handle:'opaque'});
const original = Object.freeze({content:Object.freeze([{type:'text',text:'receipt'},image,part]), _meta:Object.freeze({source:'browser'})});
const view = Object.freeze({text, content:[{type:'text',text:'action delivered'}]});
const rawDiff = ui.diff(initial, original);
const viewDiff = ui.diff(previous, view);
const stringDiff = ui.diff(previous, text);
ui.emit(viewDiff);
const header = '### Snapshot diff\n';
const tag = 'linger/browserSnapshotDiff';
const note = '\n### Events\n- Browser event as originally reported';
return {
  shape: rawDiff !== original && rawDiff.content !== original.content && rawDiff.content[2] !== part &&
    rawDiff.content[0] === original.content[0] && rawDiff.content[1] === image && rawDiff.content[2].annotations === part.annotations,
  metadata: rawDiff._meta.source === 'browser' && rawDiff._meta[tag] === true && original._meta[tag] === undefined,
  text: ui.text(viewDiff) === ui.text(stringDiff) && rawDiff.content[2].text === ui.text(viewDiff) &&
    ui.text(viewDiff).startsWith(text.split('### Snapshot\n')[0] + header) && ui.text(viewDiff).endsWith(note),
  input: ui.text(initial) === previous && original.content[2].text === text && view.text === text && view.content[0].text === 'action delivered',
};
`)
	if string(result.Value) != `{"shape":true,"metadata":true,"text":true,"input":true}` || len(result.Output) != 1 ||
		!strings.Contains(string(result.Output[0]), "### Snapshot diff") {
		t.Fatalf("MCP diff check: %s, output: %s", result.Value, result.Output)
	}
}

func TestBrowserSnapshotDiffFallbacks(t *testing.T) {
	r := nodeRuntime(t, noCalls(t), Limits{})
	result := execute(t, r, `
const fence = '\x60'.repeat(3);
const wrap = (rows, url = 'https://fixture.example/', tabs = '') =>
  tabs + '### Page\n- Page URL: ' + url + '\n### Snapshot\n' + fence + 'yaml\n' + rows.join('\n') + '\n' + fence;
const stable = '- button "Save" [ref=e1]';
const link = '- link "Inventory" [ref=e2]';
const original = wrap([stable,link]);
const newRole = wrap([stable,link.replace('link','menuitem')]);
const newParent = wrap([stable,'- group [ref=e3]:','  '+link]);
const newOrder = wrap([link,stable]);
const newURL = wrap([stable,link],'https://other.example/');
const otherTab = wrap([stable,link], 'https://fixture.example/', '### Open tabs\n- 1: (current) [](https://fixture.example/)\n');
const unparseable = [
  wrap([stable,'- button "Other" [ref=e1]']),
  wrap([stable,'- text: |','  invalid']),
  wrap([stable,'- generic:', '   - text: bad indent']),
  wrap([stable,'- generic: &anchor value']),
  wrap([stable,'- generic: {key: value}']),
  wrap([stable,'- generic:', '  - text: "bad" junk']),
  wrap([stable,'- button "Unclosed:']),
  wrap([stable,'- button "Unclosed']),
  ...['@',String.fromCharCode(96),'%',','].flatMap(indicator => [
    wrap([stable,'- text: '+indicator+'invalid']),
    wrap([stable,'- textbox "Field" [ref=e3]: '+indicator+'invalid']),
  ]),
];
const checks = [
  ['missing_snapshot','done',original],
  ['page_changed',original,newURL], ['page_changed',original,otherTab],
  ['layout_changed',original,newRole], ['layout_changed',original,newParent], ['layout_changed',original,newOrder],
  ['layout_changed',original,wrap([stable.replace('ref=e1','ref=e9')])],
  ...unparseable.map(next => ['unparseable_snapshot',original,next]),
];
for (const [reason,before,after] of checks) {
  const result = ui.diff(before,after);
  const note = 'Note: full snapshot returned instead of diff (reason: ' + reason + ').\n\n';
  const text = ui.text(result);
  if (result._meta?.['linger/browserSnapshotDiff'] || !text.includes(note+'### Snapshot') || text.replace(note,'') !== after)
    throw Error('fallback mismatch: ' + reason + ' ' + text);
  const [role,name,ref] = after.includes('ref=e9') ? ['button','Save','e9'] :
    after.includes('button "Other" [ref=e1]') ? ['button','Other','e1'] : ['button','Save','e1'];
  if (ui.ref(result,role,name) !== ref) throw Error('lost full snapshot');
}
const missing = ui.diff(original,{content:[{type:'text',text:'delivery only'}]});
if (ui.text(missing) !== 'Note: the newer result has no full snapshot (reason: missing_snapshot).\n\ndelivery only') throw Error('lost action receipt');
const quoted = wrap([stable,'- text: "@valid"','- textbox "Field" [ref=e3]: ",valid"']);
if (!ui.text(ui.diff(original,quoted)).includes('### Snapshot diff')) throw Error('rejected quoted indicators');
const diff = ui.diff(original,original);
const message = 'ui.ref requires a full snapshot. Pass the result of ui.browser.snapshot({}).';
for (const snapshot of [diff,ui.text(diff),{content:diff.content}]) {
  let caught;
  try { ui.ref(snapshot,'button','Save'); } catch (err) { caught = err.message; }
  if (caught !== message) throw Error('diff accepted as full snapshot');
}
return true;
`)
	if string(result.Value) != "true" {
		t.Fatalf("fallback checks: %s", result.Value)
	}
}

func TestBrowserSnapshotDiffOmitsEqualAnonymousRowsBetweenChanges(t *testing.T) {
	r := nodeRuntime(t, noCalls(t), Limits{})
	result := execute(t, r, `
const fence = '\x60'.repeat(3);
const wrap = rows => ['### Page','- Page URL: https://fixture.example/','### Snapshot',fence+'yaml','- main [ref=e1]:',
  ...rows.map(text => '  - text: '+text),'  - button "Save" [ref=e2]',fence].join('\n');
for (const same of [['Unchanged'], Array.from({length:300},(_,i) => 'Unchanged '+i)]) {
  const diff = ui.text(ui.diff(wrap(['Ready',...same,'Pending']),wrap(['Updated',...same,'Finished'])));
  for (const row of ['- - text: Ready','- - text: Pending','+ - text: Updated','+ - text: Finished']) {
    if (!diff.includes(row)) throw Error('missing '+row+' in '+diff);
  }
  if (diff.includes('- text: Unchanged') || diff.includes('button "Save"')) throw Error('unchanged row emitted');
}
const old = Array.from({length:67},(_,i) => i === 33 ? 'Shared' : 'Old '+i);
const next = Array.from({length:67},(_,i) => i === 33 ? 'Shared' : 'New '+i);
const range = ui.text(ui.diff(wrap(old),wrap(next)));
if (!range.includes('~ anonymous range replaced (67 old rows, 67 new rows)') ||
  !range.includes('- text: Shared') || range.includes('+ - text: Shared') ||
  range.includes('Unchanged elements omitted') || range.includes('button "Save"'))
  throw Error('misleading range replacement');
return true;`)
	if string(result.Value) != "true" {
		t.Fatalf("anonymous edit script: %s", result.Value)
	}
}

func TestBrowserSnapshotDiffHasNoLengthFallback(t *testing.T) {
	r := nodeRuntime(t, noCalls(t), Limits{})
	result := execute(t, r, `
const fence = '\x60'.repeat(3);
const header = '### Page\n- Page URL: https://fixture.example/\n### Snapshot\n' + fence + 'yaml\n';
const parent = '- main [ref=e1]:\n  - button "Open" [ref=e2]\n';
const choices = Array.from({length:55}, (_,i) => '    - button "Choice ' + i + '" [ref=item' + i + ']\n').join('');
const big = header + parent + '  - dialog "Large" [ref=e4]:\n' + choices + fence;
const small = header + parent + fence;
const smaller = ui.text(ui.diff(big,small));
const larger = ui.text(ui.diff(small,big));
const focused = ui.text(ui.diff(big,big.replace('dialog "Large" [ref=e4]', 'dialog "Large" [active] [ref=e4]')));
const peers = header + parent + Array.from({length:55}, (_,i) => '  - text "Peer ' + i + '" [ref=item' + i + ']\n').join('') + fence;
const removed = ui.text(ui.diff(peers,small));
return larger.includes('### Snapshot diff') && larger.includes('Choice 54') &&
  smaller.includes('- - dialog "Large"') && !smaller.includes('Choice 0') && !smaller.includes('reason:') &&
  focused.includes('~ - dialog "Large" [active] [ref=e4]:') && !focused.includes('Choice ') &&
  removed.includes('... 45 more removed') && removed.includes('Peer 9') && !removed.includes('Peer 10');
`)
	if string(result.Value) != "true" {
		t.Fatalf("length checks: %s", result.Value)
	}
}

func TestBrowserSnapshotDiffTracksAnonymousRowsAndEscapedKeys(t *testing.T) {
	r := nodeRuntime(t, noCalls(t), Limits{})
	result := execute(t, r, `
const fence = '\x60'.repeat(3);
const wrap = rows => '### Page\n- Page URL: https://fixture.example/\n### Snapshot\n' + fence + 'yaml\n' + rows.join('\n') + '\n' + fence;
const button = '  - ' + JSON.stringify('button ' + JSON.stringify('He said "Save" \\ [ref=e2]') + ' [ref=e2]');
const anonymous = '  - text: "literal [ref=e2]"';
const looksLikeRef = '  - generic "Example [ref=e2]" [active]';
const root = '- group [ref=e1]:';
const prev = wrap([root,anonymous,button,looksLikeRef]);
const next = wrap([root,button,anonymous,looksLikeRef]);
const data = ui.text(ui.diff(prev,next));
const top = ui.text(ui.diff(wrap(['- text: Ready',button.trimStart()]),wrap(['- text: Updated',button.trimStart()])));
const link = '  - link "Home" [ref=e3] [cursor=pointer]:';
const leaf = wrap([root,link,'    - /url: /before',button]);
const container = wrap([root,link,'    - /url: /after','    - img "Logo" [ref=e4]',button]);
const expanded = ui.text(ui.diff(leaf,container));
const collapsed = ui.text(ui.diff(container,leaf));
return data.includes('### Snapshot diff') && !data.includes('He said') &&
  data.includes('- - text: "literal [ref=e2]"\n    under - group [ref=e1]:\n    before [ref=e2]') &&
  data.includes('+ - text: "literal [ref=e2]"\n    under - group [ref=e1]:\n    after [ref=e2]') &&
  top.includes('- - text: Ready\n    before [ref=e2]') &&
  top.includes('+ - text: Updated\n    before [ref=e2]') && !top.includes('He said') &&
  expanded.includes('+ - img "Logo" [ref=e4]') && expanded.includes('- - /url: /before') &&
  expanded.includes('+ - /url: /after') && collapsed.includes('- - img "Logo" [ref=e4]') &&
  collapsed.includes('- - /url: /after') && collapsed.includes('+ - /url: /before');
`)
	if string(result.Value) != "true" {
		t.Fatalf("anonymous rows and quoted keys: %s", result.Value)
	}
}

func TestBrowserSnapshotDiffKeepsOnlyChanges(t *testing.T) {
	testBrowserSnapshotDiffPages(t, 256, "")
}

var browserDiffCPUStress = flag.Bool("browser-diff-cpu-stress", false, "run browser diff stress tests with a thread CPU clock")

func TestBrowserSnapshotDiffThreadCPUStress(t *testing.T) {
	if !*browserDiffCPUStress {
		t.Skip("enable with -args -browser-diff-cpu-stress")
	}
	// Shadow the wrapper's clock in this child only. The normal tests exercise
	// the production wall clock, while these cases measure compute headroom.
	const threadCPUClock = `
const performance = {
  now() {
    const {user, system} = process.threadCpuUsage();
    return (user + system) / 1000;
  },
};
`
	testBrowserSnapshotDiffPages(t, 5000, threadCPUClock)
}

func testBrowserSnapshotDiffPages(t *testing.T, controls int, clockPrelude string) {
	t.Helper()
	link := func(name, ref, value string) string {
		return fmt.Sprintf("  - link %q [ref=%s] [cursor=pointer]:\n    - /url: %s\n", name, ref, value)
	}
	quotedLink := func(name, ref, value string) string {
		label := fmt.Sprintf("link %q [ref=%s] [cursor=pointer]", name+`: it's "quoted" \`, ref)
		return fmt.Sprintf("  - '%s':\n    - /url: %s\n", strings.ReplaceAll(label, "'", "''"), value)
	}
	textbox := func(name, ref, value string) string {
		return fmt.Sprintf("  - textbox %q [ref=%s]: %q\n", name, ref, value)
	}
	button := func(name, ref, _ string) string {
		return fmt.Sprintf("  - button %q [ref=%s]\n", name, ref)
	}
	for _, test := range []struct {
		name string
		row  func(name, ref, value string) string
		want []string
	}{
		{"buttons", button, nil},
		{"links", link, []string{"- - /url: /items/before", "+ - /url: /items/after"}},
		{"quoted-links", quotedLink, []string{"- - /url: /items/before", "+ - /url: /items/after"}},
		{"textboxes", textbox, []string{`~ - textbox "Edited item" [ref=e2]: "/items/after"`}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var rows strings.Builder
			for i := 1; i < controls; i++ {
				rows.WriteString(test.row(fmt.Sprint("Inventory row item ", i), fmt.Sprint("e", i+2), fmt.Sprint("/items/", i)))
			}
			const header = "### Page\n- Page URL: https://fixture.example/\n### Snapshot\n```yaml\n- main [ref=e1]:\n"
			const fence = "```"
			controlsText := rows.String()
			oldRow := test.row("Edited item", "e2", "/items/before")
			newRow := test.row("Edited item", "e2", "/items/after")
			added := test.row("New item", "newItem", "/items/new")
			before := header + "  - text: Ready\n" + oldRow + controlsText + fence
			after := header + "  - text: Updated\n" + newRow + added + controlsText + fence
			r := nodeRuntime(t, func(_ context.Context, c Call) (json.RawMessage, error) {
				if c.Namespace != "browser" || c.Method != "snapshot" {
					return nil, errors.New("expected browser snapshot")
				}
				text := before
				if string(c.Arguments) == `{"after":true}` {
					text = after
				}
				return json.Marshal(map[string]any{"content": []map[string]string{{"type": "text", "text": text}}})
			}, Limits{})
			r.program = clockPrelude + r.program
			result := execute(t, r, `
state.before = ui.text(await ui.browser.snapshot({}));
const next = await ui.browser.snapshot({after:true});
ui.emit(ui.diff(state.before,next));`)
			if len(result.Output) != 1 {
				t.Fatalf("expected one diff, got %d outputs", len(result.Output))
			}
			var output struct {
				Content []struct{ Text string }
			}
			if err := json.Unmarshal(result.Output[0], &output); err != nil || len(output.Content) != 1 {
				t.Fatalf("invalid diff result: %v", err)
			}
			diff := output.Content[0].Text
			addedHeader, _, _ := strings.Cut(added, "\n")
			want := append([]string{
				"### Snapshot diff\n",
				"- - text: Ready\n    under - main [ref=e1]:",
				"+ - text: Updated\n    under - main [ref=e1]:",
				"+ " + strings.TrimSpace(addedHeader),
			}, test.want...)
			for _, fragment := range want {
				if !strings.Contains(diff, fragment) {
					t.Fatalf("missing %q in %q", fragment, diff)
				}
			}
			if strings.Contains(diff, "Inventory row item") || strings.Contains(diff, "/items/1") {
				t.Fatalf("unchanged controls leaked into a %d-byte diff", len(diff))
			}
			later := execute(t, r, `return state.before.length;`)
			if later.Generation != result.Generation || string(later.Value) != fmt.Sprint(len(before)) {
				t.Fatalf("persisted snapshot lost: %s", later.Value)
			}
		})
	}
}

func TestBrowserSnapshotDiffHandlesPlaywrightHexEscapes(t *testing.T) {
	r := nodeRuntime(t, noCalls(t), Limits{})
	result := execute(t, r, `
const fence = '\x60'.repeat(3);
const slash = '\\';
const quote = slash + '"';
const key = '- "button ' + quote + 'Control ' + slash + 'x7f' + quote + ' [ref=e2]"';
const literalKey = '- "button ' + quote + 'Literal ' + slash.repeat(4) + 'x7f' + quote + ' [ref=e3]"';
const oldValue = '- textbox "Value" [ref=e4]: "a' + slash + 'x7fb"';
const newValue = '- textbox "Value" [ref=e4]: "' + slash.repeat(2) + 'x7f"';
const wrap = rows => ['### Page','- Page URL: https://fixture.example/','### Snapshot',fence+'yaml',...rows,fence].join('\n');
const before = wrap([key,literalKey,oldValue]);
const next = wrap([key,literalKey,newValue]);
const diff = ui.text(ui.diff(before,next));
if (!diff.includes('### Snapshot diff') || !diff.includes('~ '+newValue)) throw Error(diff);
if (ui.ref(before,'button','Control \x7f') !== 'e2' || ui.ref(next,'button','Literal '+slash+'x7f') !== 'e3')
  throw Error('incorrectly decoded key');
const invalid = next.replace(newValue,oldValue.replace('x7f','xZZ'));
if (!ui.text(ui.diff(before,invalid)).includes('reason: unparseable_snapshot')) throw Error('accepted malformed escape');
return true;`)
	if string(result.Value) != "true" {
		t.Fatalf("hex escapes: %s", result.Value)
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
	result := execute(t, r, `const page=await ui.page(), first=await page.observe();
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
	result := execute(t, r, `let v=await (await ui.page()).observe();
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
