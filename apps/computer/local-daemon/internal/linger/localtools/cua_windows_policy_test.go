package localtools

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestWindowsInputRefusal(t *testing.T) {
	chromium := func() bool { return true }
	native := func() bool { return false }
	foregroundGuidance := []string{
		"Do not retry with foreground delivery",
		"omit delivery_mode, try another control or route, or tell the user what you could not do",
	}
	cases := []struct {
		name         string
		tool         string
		arguments    map[string]any
		chromium     func() bool
		refused      bool
		wantContains []string
	}{
		{"background scroll", "scroll", map[string]any{"pid": 1.0, "direction": "down"}, chromium, false, nil},
		{"explicit background", "click", map[string]any{"pid": 1.0, "delivery_mode": "background"}, chromium, false, nil},
		{"foreground scroll", "scroll", map[string]any{"pid": 1.0, "delivery_mode": "foreground"}, native, true, foregroundGuidance},
		{"foreground keys", "type_text", map[string]any{"pid": 1.0, "delivery_mode": "foreground"}, native, true, foregroundGuidance},
		{"desktop point", "scroll", map[string]any{"x": 1.0, "y": 1.0, "scope": "desktop"}, native, true, []string{"Omit scope and target a window with pid and window_id from list_windows, or tell the user what you could not do"}},
		{"window scope", "click", map[string]any{"pid": 1.0, "scope": "window"}, native, false, nil},
		{"chromium double click", "double_click", map[string]any{"pid": 1.0}, chromium, true, nil},
		{"chromium right click", "right_click", map[string]any{"pid": 1.0}, chromium, true, nil},
		{"native right click", "right_click", map[string]any{"pid": 1.0}, native, false, nil},
		{"chromium click", "click", map[string]any{"pid": 1.0}, chromium, false, nil},
		{"bring to front", "bring_to_front", map[string]any{"pid": 1.0}, native, true, nil},
		{"move cursor", "move_cursor", map[string]any{"x": 1.0, "y": 1.0}, native, true, nil},
		{"read", "get_window_state", map[string]any{"pid": 1.0, "scope": "desktop"}, native, false, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := windowsInputRefusal(tc.tool, tc.arguments, tc.chromium)
			if tc.refused != (err != nil) {
				t.Fatalf("refused = %v, want %v (%v)", err != nil, tc.refused, err)
			}
			if err != nil && (!errors.Is(err, errNotSent) || !strings.HasPrefix(err.Error(), "COMPUTER_INPUT_NOT_SENT")) {
				t.Fatalf("refusal is not a not-sent error: %v", err)
			}
			for _, phrase := range tc.wantContains {
				if !strings.Contains(err.Error(), phrase) {
					t.Fatalf("refusal %q missing guidance %q", err.Error(), phrase)
				}
			}
		})
	}
}

func TestWindowsRefusedResult(t *testing.T) {
	refusal := func(code string) json.RawMessage {
		return json.RawMessage(`{"isError":true,"content":[{"type":"text","text":"Retry this action with delivery_mode:\"foreground\""}],"structuredContent":{"code":"` + code + `"}}`)
	}
	text := func(result json.RawMessage) string {
		var reply struct {
			Content []struct{ Text string } `json:"content"`
		}
		if err := json.Unmarshal(result, &reply); err != nil || len(reply.Content) != 1 {
			t.Fatalf("result content: %s", result)
		}
		return reply.Content[0].Text
	}
	if got := text(windowsRefusedResult("scroll", refusal("background_unavailable"))); strings.Contains(got, "foreground\"") || !strings.Contains(got, "element_token") {
		t.Fatalf("scroll refusal text = %q", got)
	}
	if got := text(windowsRefusedResult("click", refusal("window_minimized"))); !strings.Contains(got, "restore") {
		t.Fatalf("minimized refusal text = %q", got)
	}
	other := refusal("element_not_found")
	if got := windowsRefusedResult("click", other); string(got) != string(other) {
		t.Fatalf("other refusal changed: %s", got)
	}
	success := json.RawMessage(`{"content":[{"type":"text","text":"ok"}],"structuredContent":{"code":"background_unavailable"}}`)
	if got := windowsRefusedResult("click", success); string(got) != string(success) {
		t.Fatalf("success changed: %s", got)
	}
}

func TestWindowsSchemaHidesForegroundFields(t *testing.T) {
	input := map[string]any{"properties": map[string]any{"pid": map[string]any{}, "delivery_mode": map[string]any{}, "scope": map[string]any{}}}
	windowsSchema(input)
	props := input["properties"].(map[string]any)
	if _, ok := props["delivery_mode"]; ok {
		t.Fatal("delivery_mode kept")
	}
	if _, ok := props["scope"]; ok {
		t.Fatal("scope kept")
	}
	if _, ok := props["pid"]; !ok {
		t.Fatal("pid dropped")
	}
}

func TestWindowsTargetWindowFromElementToken(t *testing.T) {
	c := &cuaSession{op: &operation{}}
	c.op.reads.observe(cuaRead(t, "window_id=9 pid=42 snapshot_id=s1\n- [3] AXButton \"Send\"", map[string]string{"snapshot_id": "s1"}))
	cases := []struct {
		name        string
		arguments   map[string]any
		pid, window int64
	}{
		{"token only", map[string]any{"element_token": "s1:3"}, 42, 9},
		{"token and pid", map[string]any{"pid": 42.0, "element_token": "s1:3"}, 42, 9},
		{"named window", map[string]any{"pid": 42.0, "window_id": 7.0, "element_token": "s1:3"}, 42, 7},
		{"token of another app", map[string]any{"pid": 5.0, "element_token": "s1:3"}, 5, 0},
		{"unknown token", map[string]any{"element_token": "s9:1"}, 0, 0},
	}
	for _, tc := range cases {
		pid, window := c.targetWindow(tc.arguments)
		if pid != tc.pid || window != tc.window {
			t.Fatalf("%s: got pid %d window %d, want %d %d", tc.name, pid, window, tc.pid, tc.window)
		}
	}
}

func TestWindowsRestore(t *testing.T) {
	restored := func(int64, int64) (bool, error) { return true, nil }
	open := func(int64, int64) (bool, error) { return false, nil }
	stuck := func(int64, int64) (bool, error) { return false, errors.New("window 9 stayed minimized") }
	called := false
	never := func(int64, int64) (bool, error) { called = true; return true, nil }

	if err := windowsRestore("get_window_state", 42, 9, restored); err != nil {
		t.Fatalf("restored read refused: %v", err)
	}
	if err := windowsRestore("click", 42, 9, open); err != nil {
		t.Fatalf("input to an open window refused: %v", err)
	}
	if err := windowsRestore("click", 42, 9, restored); !errors.Is(err, errNotSent) || !strings.Contains(err.Error(), "get_window_state") {
		t.Fatalf("input to a restored window = %v", err)
	}
	if err := windowsRestore("type_text", 42, 9, stuck); !errors.Is(err, errNotSent) {
		t.Fatalf("input to a stuck window = %v", err)
	}
	if err := windowsRestore("get_window_state", 42, 9, stuck); err == nil || errors.Is(err, errNotSent) {
		t.Fatalf("read of a stuck window = %v", err)
	}
	if err := windowsRestore("click", 42, 0, never); err != nil || called {
		t.Fatalf("input without a window: err %v, restore called %v", err, called)
	}
	if err := windowsRestore("list_windows", 42, 9, never); err != nil || called {
		t.Fatalf("list_windows: err %v, restore called %v", err, called)
	}
}
