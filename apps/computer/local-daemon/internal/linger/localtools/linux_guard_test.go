package localtools

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

type fakeDriverCall struct {
	Command string
	Args    []string
}

type fakeLinuxDriver struct {
	mu           sync.Mutex
	activeWindow string
	windowTitle  string
	windowState  string
	onAction     func(command string, args []string) (output []byte, errMsg string)
	calls        []fakeDriverCall
}

func (f *fakeLinuxDriver) setActive(windowID, title string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.activeWindow = windowID
	f.windowTitle = title
}

func (f *fakeLinuxDriver) inputCalls() []fakeDriverCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	var inputs []fakeDriverCall
	for _, call := range f.calls {
		switch call.Command {
		case "active-window", "window-title", "screenshot", "accessibility":
			continue
		case "semantic-ui":
			if len(call.Args) == 1 && (strings.Contains(call.Args[0], `"kind":"state"`) || strings.Contains(call.Args[0], `"kind":"observe"`)) {
				continue
			}
		}
		inputs = append(inputs, call)
	}
	return inputs
}

func (f *fakeLinuxDriver) resetCalls() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = nil
}

func (f *fakeLinuxDriver) handle(command string, args []string) (status string, output []byte, errMsg string) {
	f.mu.Lock()
	f.calls = append(f.calls, fakeDriverCall{Command: command, Args: slices.Clone(args)})
	active := f.activeWindow
	title := f.windowTitle
	state := f.windowState
	hook := f.onAction
	f.mu.Unlock()

	if hook != nil {
		if out, errText := hook(command, args); out != nil || errText != "" {
			if errText != "" {
				return "unsupported", nil, errText
			}
			return "confirmed", out, ""
		}
	}

	switch command {
	case "active-window":
		return "confirmed", []byte(active), ""
	case "window-title":
		if strings.TrimSpace(active) == "" || strings.TrimSpace(active) == "0" {
			return "confirmed", nil, ""
		}
		return "confirmed", []byte(title), ""
	case "accessibility":
		return "confirmed", nil, ""
	case "screenshot":
		// Minimal fake image bytes; tests do not decode screenshots.
		return "confirmed", []byte("png"), ""
	case "semantic-ui":
		if state != "" {
			return "confirmed", []byte(state), ""
		}
		if strings.TrimSpace(active) == "" || strings.TrimSpace(active) == "0" {
			return "unsupported", nil, "No single active desktop window"
		}
		payload, _ := json.Marshal(map[string]any{
			"window":   title,
			"app":      "gnome-terminal",
			"elements": []map[string]any{{"ref": map[string]any{"path": "/1"}, "role": "terminal", "name": "Terminal"}},
		})
		return "confirmed", payload, ""
	default:
		return "confirmed", nil, ""
	}
}

func newFakeLinuxHarness(t *testing.T, initialWindow, initialTitle string) (*operation, *fakeLinuxDriver, *Manager) {
	t.Helper()
	prevHost := linuxHost
	linuxHost = func() bool { return true }
	t.Cleanup(func() { linuxHost = prevHost })

	shortenForTest(t, &batchPause, time.Millisecond)
	shortenForTest(t, &overviewSettle, time.Millisecond)
	shortenForTest(t, &inputPause, time.Millisecond)

	manager, err := New(Options{StateDirectory: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if manager.journal == nil {
		manager.journal, err = openJournal(t.TempDir() + "/action.json")
		if err != nil {
			t.Fatal(err)
		}
	}

	driver := &fakeLinuxDriver{activeWindow: initialWindow, windowTitle: initialTitle}
	clientToServerR, clientToServerW := io.Pipe()
	serverToClientR, serverToClientW := io.Pipe()
	exited := make(chan struct{})

	go func() {
		defer close(exited)
		defer serverToClientW.Close()
		scanner := bufio.NewScanner(clientToServerR)
		scanner.Buffer(make([]byte, 64*1024), maxMCPBytes)
		for scanner.Scan() {
			var req struct {
				ID     uint64 `json:"id"`
				Method string `json:"method"`
				Params struct {
					Name      string `json:"name"`
					Arguments struct {
						Command string   `json:"command"`
						Args    []string `json:"args"`
					} `json:"arguments"`
				} `json:"params"`
			}
			if json.Unmarshal(scanner.Bytes(), &req) != nil {
				return
			}
			cmd := req.Params.Arguments.Command
			status, output, errMsg := driver.handle(cmd, req.Params.Arguments.Args)
			var receipt map[string]any
			if cmd == "semantic-ui" {
				if errMsg != "" {
					receipt = map[string]any{"status": status, "error": errMsg}
				} else {
					var parsed map[string]any
					_ = json.Unmarshal(output, &parsed)
					receipt = parsed
				}
			} else {
				receipt = map[string]any{
					"status":        status,
					"output_base64": base64.StdEncoding.EncodeToString(output),
				}
				if errMsg != "" {
					receipt["error"] = errMsg
				}
			}
			receiptJSON, _ := json.Marshal(receipt)
			resp, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]any{
					"content": []map[string]string{{"type": "text", "text": string(receiptJSON)}},
				},
			})
			if _, err := serverToClientW.Write(append(resp, '\n')); err != nil {
				return
			}
		}
	}()

	client := &mcpClient{
		pending:   map[uint64]chan rpcReply{},
		stdin:     clientToServerW,
		stdout:    serverToClientR,
		writeSlot: make(chan struct{}, 1),
		done:      make(chan struct{}),
		exited:    exited,
		stop:      func() { _ = clientToServerW.Close() },
	}
	go client.read()

	t.Cleanup(func() {
		_ = client.close()
		_ = clientToServerR.Close()
		_ = serverToClientR.Close()
	})

	op := &operation{
		manager:  manager,
		ctx:      context.Background(),
		label:    "linux-guard-test",
		spec:     provider.OperationSpec{AgentID: "agent-1", WorkingDirectory: t.TempDir()},
		identity: mcpproxy.OperationIdentity{OperationID: "op-1"},
		linux:    client,
	}
	return op, driver, manager
}

type parsedToolResult struct {
	IsError bool `json:"isError"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	StructuredContent struct {
		Outcome string `json:"outcome"`
	} `json:"structuredContent"`
}

func parseToolResult(t *testing.T, raw json.RawMessage) parsedToolResult {
	t.Helper()
	var parsed parsedToolResult
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("unmarshal tool result %q: %v", string(raw), err)
	}
	return parsed
}

func parseReportMap(t *testing.T, parsed parsedToolResult) map[string]any {
	t.Helper()
	for _, item := range parsed.Content {
		if item.Type == "text" && strings.HasPrefix(strings.TrimSpace(item.Text), "{") {
			var report map[string]any
			if err := json.Unmarshal([]byte(item.Text), &report); err == nil {
				return report
			}
		}
	}
	t.Fatalf("no JSON report found in tool result content: %+v", parsed.Content)
	return nil
}

func assertNoActiveWindowError(t *testing.T, raw json.RawMessage, err error) {
	t.Helper()
	if raw != nil {
		t.Fatalf("expected nil result with error, got result=%s err=%v", raw, err)
	}
	if !errors.Is(err, errNoActiveWindow) || !errors.Is(err, errNotSent) {
		t.Fatalf("err = %v, want errNoActiveWindow wrapping errNotSent", err)
	}
	if !strings.Contains(err.Error(), "NO_ACTIVE_WINDOW") {
		t.Fatalf("err text missing NO_ACTIVE_WINDOW: %v", err)
	}
	// Verify server.go's toolError maps errNoActiveWindow to isError=true and outcome=not_dispatched.
	wire := parseToolResult(t, toolError(err, true))
	if !wire.IsError || wire.StructuredContent.Outcome != "not_dispatched" {
		t.Fatalf("toolError = %+v, want isError=true outcome=not_dispatched", wire)
	}
}

func TestLinuxNoActiveWindowRefusesTypeText(t *testing.T) {
	for _, tc := range []struct {
		name          string
		activeReply   string
		priorObserved bool
	}{
		{name: "empty-no-prior-observation", activeReply: "", priorObserved: false},
		{name: "empty-after-screenshot-observation", activeReply: "", priorObserved: true},
		{name: "whitespace-active-window", activeReply: "  \n", priorObserved: false},
		{name: "x11-none-zero-window", activeReply: "0", priorObserved: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			op, driver, manager := newFakeLinuxHarness(t, tc.activeReply, "")
			if tc.priorObserved {
				if _, err := op.linuxComputerCall(context.Background(), "screenshot", json.RawMessage(`{}`)); err != nil {
					t.Fatalf("screenshot: %v", err)
				}
				driver.resetCalls()
			}
			raw, err := op.linuxComputerCall(context.Background(), "type_text", json.RawMessage(`{"text":"hello overview"}`))
			assertNoActiveWindowError(t, raw, err)
			if got := driver.inputCalls(); len(got) != 0 {
				t.Fatalf("expected 0 driver input calls, got %+v", got)
			}
			if manager.journal.blocked() {
				t.Fatal("refused input left the action journal blocked")
			}
		})
	}
}

func TestLinuxNoActiveWindowRefusesUnsafePressKey(t *testing.T) {
	unsafeKeys := []string{
		"Return", "Enter", "return", "ctrl+a", "a", "Super+l", "Super_L+l",
		"super+tab", "alt+F4", "Escape+a", "shift+Escape", "space", "Tab", "",
	}
	for _, key := range unsafeKeys {
		t.Run("key="+key, func(t *testing.T) {
			op, driver, manager := newFakeLinuxHarness(t, "", "")
			// Simulate prior screenshot observation in Overview (empty == empty).
			op.linuxWindow = []byte{}
			args, _ := json.Marshal(map[string]string{"key": key})
			raw, err := op.linuxComputerCall(context.Background(), "press_key", args)
			assertNoActiveWindowError(t, raw, err)
			if got := driver.inputCalls(); len(got) != 0 {
				t.Fatalf("key %q: expected 0 driver input calls, got %+v", key, got)
			}
			if manager.journal.blocked() {
				t.Fatalf("key %q: refused input left journal blocked", key)
			}
		})
	}
}

func TestLinuxNoActiveWindowAllowsOverviewDismissKeys(t *testing.T) {
	allowedKeys := []string{"Escape", "Esc", "escape", "Super", "super", "Super_L", "Super_R", "win", "meta"}
	for _, key := range allowedKeys {
		t.Run("key="+key, func(t *testing.T) {
			op, driver, _ := newFakeLinuxHarness(t, "", "")
			op.linuxWindow = []byte{}
			args, _ := json.Marshal(map[string]string{"key": key})
			raw, err := op.linuxComputerCall(context.Background(), "press_key", args)
			if err != nil {
				t.Fatalf("key %q failed: %v", key, err)
			}
			res := parseToolResult(t, raw)
			if res.IsError {
				t.Fatalf("key %q unexpectedly errored: %s", key, raw)
			}
			report := parseReportMap(t, res)
			if completed, ok := report["completed"].(bool); !ok || !completed {
				t.Fatalf("key %q: expected completed=true, got %v", key, report)
			}
			inputs := driver.inputCalls()
			if len(inputs) != 1 || inputs[0].Command != "key" || !slices.Equal(inputs[0].Args, []string{key}) {
				t.Fatalf("key %q: driver inputs = %+v, want [key %s]", key, inputs, key)
			}
		})
	}
}

func TestLinuxNoActiveWindowAllowsPointerActions(t *testing.T) {
	for _, tc := range []struct {
		tool    string
		args    string
		wantCmd string
	}{
		{tool: "click", args: `{"x":100,"y":200}`, wantCmd: "click"},
		{tool: "click", args: `{"x":100,"y":200,"button":"right"}`, wantCmd: "click"},
		{tool: "move", args: `{"x":50,"y":60}`, wantCmd: "move"},
		{tool: "drag", args: `{"x":10,"y":20,"to_x":30,"to_y":40}`, wantCmd: "drag"},
		{tool: "scroll", args: `{"direction":"down","steps":3}`, wantCmd: "scroll"},
	} {
		t.Run(tc.tool, func(t *testing.T) {
			op, driver, _ := newFakeLinuxHarness(t, "", "")
			op.linuxWindow = []byte{}
			raw, err := op.linuxComputerCall(context.Background(), tc.tool, json.RawMessage(tc.args))
			if err != nil {
				t.Fatalf("%s failed: %v", tc.tool, err)
			}
			res := parseToolResult(t, raw)
			if res.IsError {
				t.Fatalf("%s unexpectedly errored: %s", tc.tool, raw)
			}
			report := parseReportMap(t, res)
			if completed, ok := report["completed"].(bool); !ok || !completed {
				t.Fatalf("%s: expected completed=true, got %v", tc.tool, report)
			}
			inputs := driver.inputCalls()
			if len(inputs) != 1 || inputs[0].Command != tc.wantCmd {
				t.Fatalf("%s: driver inputs = %+v, want command %s", tc.tool, inputs, tc.wantCmd)
			}
		})
	}
}

func TestLinuxNoActiveWindowAfterFocusedWindowAllowsImmediateRecovery(t *testing.T) {
	op, driver, _ := newFakeLinuxHarness(t, "12345", "Terminal")
	op.linuxWindow = []byte("12345")

	// Desktop transitions to GNOME Overview (no active window).
	driver.setActive("", "")
	raw, err := op.linuxComputerCall(context.Background(), "type_text", json.RawMessage(`{"text":"oops"}`))
	assertNoActiveWindowError(t, raw, err)
	if len(driver.inputCalls()) != 0 {
		t.Fatalf("expected 0 driver inputs, got %+v", driver.inputCalls())
	}

	// Immediate Escape recovery succeeds without hitting a stale WINDOW_CHANGED.
	raw, err = op.linuxComputerCall(context.Background(), "press_key", json.RawMessage(`{"key":"Escape"}`))
	if err != nil {
		t.Fatalf("Escape recovery failed: %v", err)
	}
	res := parseToolResult(t, raw)
	if res.IsError {
		t.Fatalf("Escape recovery errored: %s", raw)
	}
	inputs := driver.inputCalls()
	if len(inputs) != 1 || inputs[0].Command != "key" || !slices.Equal(inputs[0].Args, []string{"Escape"}) {
		t.Fatalf("expected [key Escape], got %+v", inputs)
	}
}

func TestLinuxRunActionsRefusesTypeAndUnsafeKeyWhenEmpty(t *testing.T) {
	for _, tc := range []struct {
		name    string
		actions string
	}{
		{
			name:    "type-step-0",
			actions: `{"actions":[{"tool":"type_text","text":"hello"}]}`,
		},
		{
			name:    "return-then-type",
			actions: `{"actions":[{"tool":"press_key","key":"Return"},{"tool":"type_text","text":"hello"}]}`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			op, driver, manager := newFakeLinuxHarness(t, "", "")
			op.linuxWindow = []byte{}
			raw, err := op.linuxComputerCall(context.Background(), "run_actions", json.RawMessage(tc.actions))
			assertNoActiveWindowError(t, raw, err)
			if got := driver.inputCalls(); len(got) != 0 {
				t.Fatalf("expected 0 driver inputs, got %+v", got)
			}
			if manager.journal.blocked() {
				t.Fatal("refused run_actions left journal blocked")
			}
		})
	}
}

func assertMidBatchNoActiveWindowStopped(t *testing.T, raw json.RawMessage, err error, wantDone, wantTotal int) {
	t.Helper()
	if err != nil {
		t.Fatalf("expected mid-batch stopped result (not raw error / not_dispatched), got err=%v", err)
	}
	res := parseToolResult(t, raw)
	if res.IsError {
		t.Fatalf("expected non-error mid-batch stopped result, got %s", raw)
	}
	if res.StructuredContent.Outcome == "not_dispatched" {
		t.Fatalf("mid-batch stop after %d step(s) must not report outcome=not_dispatched: %s", wantDone, raw)
	}
	report := parseReportMap(t, res)
	if report["completed_steps"] != float64(wantDone) || report["total_steps"] != float64(wantTotal) {
		t.Fatalf("unexpected step counts: got %v, want completed_steps=%d total_steps=%d", report, wantDone, wantTotal)
	}
	stopped, _ := report["stopped"].(string)
	if !strings.Contains(stopped, "NO_ACTIVE_WINDOW") {
		t.Fatalf("expected NO_ACTIVE_WINDOW in stopped reason, got %v", report)
	}
}

func TestLinuxRunActionsEscapeStillEmptyStopsBeforeType(t *testing.T) {
	op, driver, manager := newFakeLinuxHarness(t, "", "")
	op.linuxWindow = []byte{}

	raw, err := op.linuxComputerCall(context.Background(), "run_actions", json.RawMessage(`{
		"actions": [
			{"tool": "press_key", "key": "Escape"},
			{"tool": "type_text", "text": "must not type"}
		]
	}`))
	assertMidBatchNoActiveWindowStopped(t, raw, err, 1, 2)
	inputs := driver.inputCalls()
	if len(inputs) != 1 || inputs[0].Command != "key" || !slices.Equal(inputs[0].Args, []string{"Escape"}) {
		t.Fatalf("expected only [key Escape] dispatched, got %+v", inputs)
	}
	if manager.journal.blocked() {
		t.Fatal("run_actions mid-batch stop left journal blocked")
	}
}

func TestLinuxRunActionsEscapeRestoresWindowStopsToObserve(t *testing.T) {
	op, driver, _ := newFakeLinuxHarness(t, "", "")
	op.linuxWindow = []byte{}
	driver.onAction = func(command string, args []string) ([]byte, string) {
		if command == "key" && slices.Equal(args, []string{"Escape"}) {
			driver.setActive("55555", "Terminal")
		}
		return nil, ""
	}

	raw, err := op.linuxComputerCall(context.Background(), "run_actions", json.RawMessage(`{
		"actions": [
			{"tool": "press_key", "key": "Escape"},
			{"tool": "type_text", "text": "wait for observation"}
		]
	}`))
	if err != nil {
		t.Fatalf("run_actions failed: %v", err)
	}
	res := parseToolResult(t, raw)
	if res.IsError {
		t.Fatalf("expected clean early stop with observed window, got error: %s", raw)
	}
	report := parseReportMap(t, res)
	if report["completed_steps"] != float64(1) || report["total_steps"] != float64(2) {
		t.Fatalf("unexpected step counts: %v", report)
	}
	stopped, _ := report["stopped"].(string)
	if !strings.Contains(stopped, "active window changed after step 1") {
		t.Fatalf("expected window-change stop note, got %v", report)
	}
	inputs := driver.inputCalls()
	if len(inputs) != 1 || inputs[0].Command != "key" {
		t.Fatalf("expected only Escape dispatched before observing new window, got %+v", inputs)
	}
	// Now that op.linuxWindow recorded 55555 from observation, type_text succeeds.
	driver.resetCalls()
	raw, err = op.linuxComputerCall(context.Background(), "type_text", json.RawMessage(`{"text":"hello"}`))
	if err != nil {
		t.Fatalf("follow-up type_text failed: %v", err)
	}
	if parseToolResult(t, raw).IsError {
		t.Fatalf("follow-up type_text errored: %s", raw)
	}
	inputs = driver.inputCalls()
	if len(inputs) != 1 || inputs[0].Command != "type" || !slices.Equal(inputs[0].Args, []string{"hello"}) {
		t.Fatalf("expected [type hello], got %+v", inputs)
	}
}

func TestLinuxRunActionsFocusedToEmptyStopsBeforeSubsequentTypeAndKey(t *testing.T) {
	for _, tc := range []struct {
		name      string
		step1Key  string
		step2JSON string
	}{
		{
			name:      "super-then-type",
			step1Key:  "Super",
			step2JSON: `{"tool": "type_text", "text": "must not reach overview"}`,
		},
		{
			name:      "alt-f4-then-return",
			step1Key:  "alt+F4",
			step2JSON: `{"tool": "press_key", "key": "Return"}`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			op, driver, manager := newFakeLinuxHarness(t, "12345", "Editor")
			op.linuxWindow = []byte("12345")
			// Even if AT-SPI fallback would still expose a background window behind
			// Overview, the mid-batch stop must preserve op.linuxWindow.
			driver.windowState = `{"window":"Editor","app":"gedit","elements":[{"ref":{"path":"/1"},"role":"text","name":"body"}]}`
			driver.onAction = func(command string, args []string) ([]byte, string) {
				if command == "key" && slices.Equal(args, []string{tc.step1Key}) {
					driver.setActive("", "")
				}
				return nil, ""
			}

			raw, err := op.linuxComputerCall(context.Background(), "run_actions", json.RawMessage(`{
				"actions": [
					{"tool": "press_key", "key": "`+tc.step1Key+`"},
					`+tc.step2JSON+`
				]
			}`))
			assertMidBatchNoActiveWindowStopped(t, raw, err, 1, 2)
			if string(op.linuxWindow) != "12345" {
				t.Fatalf("op.linuxWindow = %q, want preserved 12345", string(op.linuxWindow))
			}
			inputs := driver.inputCalls()
			if len(inputs) != 1 || inputs[0].Command != "key" || !slices.Equal(inputs[0].Args, []string{tc.step1Key}) {
				t.Fatalf("expected only step 1 dispatched, got %+v", inputs)
			}
			if manager.journal.blocked() {
				t.Fatal("mid-batch stop left journal blocked")
			}

			// Returning to the original window must not trigger WINDOW_CHANGED.
			driver.setActive("12345", "Editor")
			driver.resetCalls()
			raw, err = op.linuxComputerCall(context.Background(), "click", json.RawMessage(`{"x":100,"y":200}`))
			if err != nil || parseToolResult(t, raw).IsError {
				t.Fatalf("click after returning to original window failed: %s %v", raw, err)
			}
		})
	}
}

func TestLinuxFocusedWindowHappyPathAndWindowChanged(t *testing.T) {
	op, driver, _ := newFakeLinuxHarness(t, "12345", "Terminal")

	// Single-step type_text and press_key succeed on focused window.
	raw, err := op.linuxComputerCall(context.Background(), "type_text", json.RawMessage(`{"text":"echo hi"}`))
	if err != nil || parseToolResult(t, raw).IsError {
		t.Fatalf("type_text failed: %s %v", raw, err)
	}
	raw, err = op.linuxComputerCall(context.Background(), "press_key", json.RawMessage(`{"key":"Return"}`))
	if err != nil || parseToolResult(t, raw).IsError {
		t.Fatalf("press_key failed: %s %v", raw, err)
	}
	// Multi-step run_actions succeeds on focused window.
	driver.resetCalls()
	raw, err = op.linuxComputerCall(context.Background(), "run_actions", json.RawMessage(`{
		"actions": [
			{"tool": "press_key", "key": "ctrl+a"},
			{"tool": "type_text", "text": "hello"},
			{"tool": "press_key", "key": "Return"}
		]
	}`))
	if err != nil {
		t.Fatalf("run_actions failed: %v", err)
	}
	res := parseToolResult(t, raw)
	if res.IsError {
		t.Fatalf("run_actions errored: %s", raw)
	}
	report := parseReportMap(t, res)
	if report["completed_steps"] != float64(3) || report["total_steps"] != float64(3) {
		t.Fatalf("unexpected report: %v", report)
	}
	if len(driver.inputCalls()) != 3 {
		t.Fatalf("expected 3 input calls, got %+v", driver.inputCalls())
	}

	// Switching to another focused window still triggers WINDOW_CHANGED.
	driver.setActive("67890", "Browser")
	driver.resetCalls()
	raw, err = op.linuxComputerCall(context.Background(), "type_text", json.RawMessage(`{"text":"wrong window"}`))
	if err != nil {
		t.Fatalf("WINDOW_CHANGED raw err: %v", err)
	}
	res = parseToolResult(t, raw)
	if !res.IsError || !strings.Contains(res.Content[0].Text, "WINDOW_CHANGED") {
		t.Fatalf("expected WINDOW_CHANGED, got %s", raw)
	}
	if len(driver.inputCalls()) != 0 {
		t.Fatalf("WINDOW_CHANGED dispatched inputs: %+v", driver.inputCalls())
	}
}

// TestLinuxOverviewActiveMasksRestoredX11Window verifies that when the driver
// reports active-window="" due to GNOME OverviewActive=true (such as after a
// single Escape clears search text and restores _NET_ACTIVE_WINDOW to gedit),
// type_text and unsafe press_key are blocked while preserving op.linuxWindow.
func TestLinuxOverviewActiveMasksRestoredX11Window(t *testing.T) {
	op, driver, manager := newFakeLinuxHarness(t, "16777348", "gedit")
	op.linuxWindow = []byte("16777348")

	// Driver masks _NET_ACTIVE_WINDOW to "" while OverviewActive=true.
	driver.setActive("", "")
	for _, call := range []struct {
		tool string
		args string
	}{
		{tool: "type_text", args: `{"text":"must not search overview"}`},
		{tool: "press_key", args: `{"key":"Return"}`},
	} {
		raw, err := op.linuxComputerCall(context.Background(), call.tool, json.RawMessage(call.args))
		assertNoActiveWindowError(t, raw, err)
	}
	if len(driver.inputCalls()) != 0 {
		t.Fatalf("expected 0 driver inputs, got %+v", driver.inputCalls())
	}
	if string(op.linuxWindow) != "16777348" {
		t.Fatalf("op.linuxWindow = %q, want preserved 16777348", string(op.linuxWindow))
	}
	if manager.journal.blocked() {
		t.Fatal("refusal left journal blocked")
	}
}

// TestLinuxRunActionsSuperWaitsOverviewSettleBeforeType verifies
// deterministically via the linuxSleep hook (no wall-clock races) that
// run_actions waits overviewSettle after a bare Super key before checking
// active-window, while ordinary keys wait only batchPause.
func TestLinuxRunActionsSuperWaitsOverviewSettleBeforeType(t *testing.T) {
	op, driver, manager := newFakeLinuxHarness(t, "16777348", "gedit")
	op.linuxWindow = []byte("16777348")

	// Keep distinct durations to verify overviewSettle vs batchPause selection.
	shortenForTest(t, &batchPause, 150*time.Millisecond)
	shortenForTest(t, &overviewSettle, 250*time.Millisecond)

	var slept []time.Duration
	prevSleep := linuxSleep
	linuxSleep = func(_ context.Context, d time.Duration) error {
		slept = append(slept, d)
		// Overview finishes toggling during the settle pause, before the next
		// active-window check runs.
		if d == overviewSettle {
			driver.setActive("", "")
		}
		return nil
	}
	t.Cleanup(func() { linuxSleep = prevSleep })

	raw, err := op.linuxComputerCall(context.Background(), "run_actions", json.RawMessage(`{
		"actions": [
			{"tool": "press_key", "key": "Super"},
			{"tool": "type_text", "text": "must not reach overview search"}
		]
	}`))
	assertMidBatchNoActiveWindowStopped(t, raw, err, 1, 2)
	if string(op.linuxWindow) != "16777348" {
		t.Fatalf("op.linuxWindow = %q, want preserved 16777348", string(op.linuxWindow))
	}
	if !slices.Equal(slept, []time.Duration{overviewSettle}) {
		t.Fatalf("inter-step sleeps = %v, want [%v]", slept, overviewSettle)
	}
	inputs := driver.inputCalls()
	if len(inputs) != 1 || inputs[0].Command != "key" || !slices.Equal(inputs[0].Args, []string{"Super"}) {
		t.Fatalf("expected only [key Super] dispatched, got %+v", inputs)
	}
	if manager.journal.blocked() {
		t.Fatal("mid-batch stop left journal blocked")
	}

	// Returning to gedit must not trigger a spurious WINDOW_CHANGED, and
	// ordinary keys still use batchPause rather than overviewSettle.
	driver.setActive("16777348", "gedit")
	driver.resetCalls()
	slept = nil
	raw, err = op.linuxComputerCall(context.Background(), "run_actions", json.RawMessage(`{
		"actions": [
			{"tool": "press_key", "key": "ctrl+a"},
			{"tool": "type_text", "text": "hello"}
		]
	}`))
	if err != nil || parseToolResult(t, raw).IsError {
		t.Fatalf("ordinary run_actions failed: %s %v", raw, err)
	}
	if !slices.Equal(slept, []time.Duration{batchPause}) {
		t.Fatalf("ordinary key sleeps = %v, want [%v]", slept, batchPause)
	}
}

// TestLinuxRunActionsBareSuperAlwaysStopsEvenIfActiveWindowLags verifies that
// run_actions unconditionally stops after a bare Super/Meta/Win key before any
// subsequent keyboard/text step, even when the compositor has not flipped
// active-window yet after overviewSettle under extreme load.
func TestLinuxRunActionsBareSuperAlwaysStopsEvenIfActiveWindowLags(t *testing.T) {
	for _, key := range []string{"Super", "Super_L", "Super_R", "win", "meta"} {
		t.Run("key="+key, func(t *testing.T) {
			op, driver, manager := newFakeLinuxHarness(t, "16777348", "gedit")
			op.linuxWindow = []byte("16777348")
			// Simulate extreme load: active-window still reports gedit even after
			// overviewSettle completes.
			raw, err := op.linuxComputerCall(context.Background(), "run_actions", json.RawMessage(`{
				"actions": [
					{"tool": "type_text", "text": "hello"},
					{"tool": "press_key", "key": "`+key+`"},
					{"tool": "type_text", "text": "x"}
				]
			}`))
			assertMidBatchNoActiveWindowStopped(t, raw, err, 2, 3)
			if string(op.linuxWindow) != "16777348" {
				t.Fatalf("op.linuxWindow = %q, want preserved 16777348", string(op.linuxWindow))
			}
			inputs := driver.inputCalls()
			if len(inputs) != 2 ||
				inputs[0].Command != "type" || !slices.Equal(inputs[0].Args, []string{"hello"}) ||
				inputs[1].Command != "key" || !slices.Equal(inputs[1].Args, []string{key}) {
				t.Fatalf("expected only [type hello, key %s] dispatched, got %+v", key, inputs)
			}
			if manager.journal.blocked() {
				t.Fatal("mid-batch stop left journal blocked")
			}

			// Returning to gedit must not trigger WINDOW_CHANGED.
			driver.resetCalls()
			raw, err = op.linuxComputerCall(context.Background(), "click", json.RawMessage(`{"x":100,"y":200}`))
			if err != nil || parseToolResult(t, raw).IsError {
				t.Fatalf("click after returning to gedit failed: %s %v", raw, err)
			}
		})
	}
}

// TestLinuxRunActionsFocusedEscapeContinuesToNextType verifies that a bare
// Escape inside a focused window (such as Vim or a dialog) is not treated as an
// unconditional overview toggle when the active window remains focused.
func TestLinuxRunActionsFocusedEscapeContinuesToNextType(t *testing.T) {
	op, driver, _ := newFakeLinuxHarness(t, "16777348", "Terminal")
	op.linuxWindow = []byte("16777348")

	raw, err := op.linuxComputerCall(context.Background(), "run_actions", json.RawMessage(`{
		"actions": [
			{"tool": "press_key", "key": "Escape"},
			{"tool": "type_text", "text": "ok"}
		]
	}`))
	if err != nil {
		t.Fatalf("focused Escape + type_text failed: %v", err)
	}
	res := parseToolResult(t, raw)
	if res.IsError {
		t.Fatalf("focused Escape + type_text errored: %s", raw)
	}
	report := parseReportMap(t, res)
	if report["completed_steps"] != float64(2) || report["total_steps"] != float64(2) {
		t.Fatalf("unexpected step counts: %v", report)
	}
	if _, stopped := report["stopped"]; stopped {
		t.Fatalf("expected no stopped reason, got %v", report)
	}
	inputs := driver.inputCalls()
	if len(inputs) != 2 ||
		inputs[0].Command != "key" || !slices.Equal(inputs[0].Args, []string{"Escape"}) ||
		inputs[1].Command != "type" || !slices.Equal(inputs[1].Args, []string{"ok"}) {
		t.Fatalf("expected [key Escape, type ok], got %+v", inputs)
	}
}

// TestLinuxPreservesObservedWindowAcrossOverview verifies cross-window safety
// when Overview opens and closes around a previously observed window:
//   - returning to the previously observed window does not trigger WINDOW_CHANGED
//   - immediate Escape/Super recovery while still in Overview bypasses WINDOW_CHANGED
//   - clicking a thumbnail after observing Overview (op.linuxWindow=="") succeeds
//   - switching to a different window still triggers WINDOW_CHANGED
//   - clicking coordinates planned for gedit while Overview is unobserved triggers WINDOW_CHANGED
func TestLinuxPreservesObservedWindowAcrossOverview(t *testing.T) {
	t.Run("external-escape-back-to-gedit-no-window-changed", func(t *testing.T) {
		op, driver, _ := newFakeLinuxHarness(t, "16777348", "gedit")
		op.linuxWindow = []byte("16777348")

		// External Super opens Overview -> type_text rejected with NO_ACTIVE_WINDOW.
		driver.setActive("", "")
		raw, err := op.linuxComputerCall(context.Background(), "type_text", json.RawMessage(`{"text":"blocked"}`))
		assertNoActiveWindowError(t, raw, err)
		if string(op.linuxWindow) != "16777348" {
			t.Fatalf("op.linuxWindow = %q, want 16777348", string(op.linuxWindow))
		}

		// External Escape restores gedit.
		driver.setActive("16777348", "gedit")
		driver.resetCalls()
		for _, tc := range []struct {
			tool string
			args string
		}{
			{tool: "click", args: `{"x":100,"y":200}`},
			{tool: "type_text", args: `{"text":"hello gedit"}`},
			{tool: "press_key", args: `{"key":"Super"}`},
		} {
			raw, err := op.linuxComputerCall(context.Background(), tc.tool, json.RawMessage(tc.args))
			if err != nil {
				t.Fatalf("%s failed: %v", tc.tool, err)
			}
			res := parseToolResult(t, raw)
			if res.IsError {
				t.Fatalf("%s hit unexpected error: %s", tc.tool, raw)
			}
		}
		if len(driver.inputCalls()) != 3 {
			t.Fatalf("expected all 3 inputs dispatched, got %+v", driver.inputCalls())
		}
	})

	t.Run("immediate-escape-and-super-recovery-from-overview", func(t *testing.T) {
		for _, key := range []string{"Escape", "Super"} {
			t.Run(key, func(t *testing.T) {
				op, driver, _ := newFakeLinuxHarness(t, "16777348", "gedit")
				op.linuxWindow = []byte("16777348")

				driver.setActive("", "")
				raw, err := op.linuxComputerCall(context.Background(), "type_text", json.RawMessage(`{"text":"blocked"}`))
				assertNoActiveWindowError(t, raw, err)

				// Immediately dismiss Overview with Escape/Super while still in Overview.
				raw, err = op.linuxComputerCall(context.Background(), "press_key", json.RawMessage(`{"key":"`+key+`"}`))
				if err != nil {
					t.Fatalf("%s failed: %v", key, err)
				}
				if parseToolResult(t, raw).IsError {
					t.Fatalf("%s errored: %s", key, raw)
				}
				inputs := driver.inputCalls()
				if len(inputs) != 1 || inputs[0].Command != "key" || !slices.Equal(inputs[0].Args, []string{key}) {
					t.Fatalf("expected [key %s], got %+v", key, inputs)
				}
			})
		}
	})

	t.Run("click-thumbnail-after-observing-overview", func(t *testing.T) {
		op, driver, _ := newFakeLinuxHarness(t, "", "")
		if _, err := op.linuxComputerCall(context.Background(), "screenshot", json.RawMessage(`{}`)); err != nil {
			t.Fatalf("screenshot: %v", err)
		}
		driver.resetCalls()
		raw, err := op.linuxComputerCall(context.Background(), "type_text", json.RawMessage(`{"text":"blocked"}`))
		assertNoActiveWindowError(t, raw, err)
		raw, err = op.linuxComputerCall(context.Background(), "click", json.RawMessage(`{"x":320,"y":240}`))
		if err != nil || parseToolResult(t, raw).IsError {
			t.Fatalf("thumbnail click failed: %s %v", raw, err)
		}
		inputs := driver.inputCalls()
		if len(inputs) != 1 || inputs[0].Command != "click" {
			t.Fatalf("expected [click], got %+v", inputs)
		}
	})

	t.Run("different-app-still-triggers-window-changed", func(t *testing.T) {
		op, driver, _ := newFakeLinuxHarness(t, "16777348", "gedit")
		op.linuxWindow = []byte("16777348")

		// Overview opens, type_text refused, then user switches to Firefox.
		driver.setActive("", "")
		raw, err := op.linuxComputerCall(context.Background(), "type_text", json.RawMessage(`{"text":"blocked"}`))
		assertNoActiveWindowError(t, raw, err)

		driver.setActive("33554433", "Mozilla Firefox")
		driver.resetCalls()
		for _, tc := range []struct {
			tool string
			args string
		}{
			{tool: "type_text", args: `{"text":"must not reach firefox"}`},
			{tool: "click", args: `{"x":100,"y":200}`},
		} {
			// Reset op.linuxWindow back to gedit for each subcheck since WINDOW_CHANGED
			// updates op.linuxWindow to the newly shown Firefox window.
			op.linuxWindow = []byte("16777348")
			raw, err := op.linuxComputerCall(context.Background(), tc.tool, json.RawMessage(tc.args))
			if err != nil {
				t.Fatalf("%s raw err: %v", tc.tool, err)
			}
			res := parseToolResult(t, raw)
			if !res.IsError || !strings.Contains(res.Content[0].Text, "WINDOW_CHANGED") {
				t.Fatalf("%s: expected WINDOW_CHANGED against Firefox, got %s", tc.tool, raw)
			}
		}
		if len(driver.inputCalls()) != 0 {
			t.Fatalf("expected 0 driver inputs against Firefox, got %+v", driver.inputCalls())
		}
	})

	t.Run("unobserved-overview-blocks-gedit-coordinates-click", func(t *testing.T) {
		op, driver, _ := newFakeLinuxHarness(t, "16777348", "gedit")
		op.linuxWindow = []byte("16777348")

		// Overview opens without observation; click planned for gedit must not click Overview.
		driver.setActive("", "")
		raw, err := op.linuxComputerCall(context.Background(), "click", json.RawMessage(`{"x":100,"y":200}`))
		if raw != nil || !errors.Is(err, errWindowChanged) {
			t.Fatalf("expected errWindowChanged for click in unobserved Overview, got raw=%s err=%v", raw, err)
		}
		if len(driver.inputCalls()) != 0 {
			t.Fatalf("expected 0 driver inputs, got %+v", driver.inputCalls())
		}
	})
}
