package localtools

import (
	"encoding/json"
	"fmt"
)

// Windows input stays in the background. Cua's foreground and desktop routes
// send real input through the system queue, where it lands on whatever window
// is in front or under the pointer when it arrives. A user who switches apps
// while the Agent scrolls or types would receive that input, so the Computer
// never sends it on Windows.

// windowsHiddenTools are the Cua tools the Agent does not get on Windows:
// bring_to_front keeps another app in front of the user, and move_cursor
// moves the user's own pointer.
var windowsHiddenTools = map[string]bool{"bring_to_front": true, "move_cursor": true}

// windowsForegroundFields are the Cua arguments that select foreground or
// whole-desktop delivery; they are hidden from the Windows schemas.
var windowsForegroundFields = []string{"delivery_mode", "scope"}

// windowsChromiumPointerTools are the background inputs Cua 0.35.4 sends to a
// Chromium window as real system-queue mouse events.
var windowsChromiumPointerTools = map[string]bool{"double_click": true, "right_click": true}

// windowsRefusedResultCodes are the Cua refusal codes whose text tells the
// Agent to retry in the foreground or to bring the window to the front.
var windowsRefusedResultCodes = map[string]bool{"background_unavailable": true, "background_occluded": true, "background_uipi_blocked": true, "window_minimized": true}

// windowsInputRefusal refuses, before anything is sent, a Windows call that
// would take the user's foreground, pointer or keyboard. chromium reports
// whether the call's window belongs to a Chromium browser or Electron app.
func windowsInputRefusal(name string, arguments map[string]any, chromium func() bool) error {
	if windowsHiddenTools[name] {
		return fmt.Errorf("COMPUTER_INPUT_NOT_SENT: %s takes the user's foreground or pointer and is not available on Windows: %w", name, errNotSent)
	}
	if !inputTools[name] {
		return nil
	}
	if mode, ok := arguments["delivery_mode"]; ok && mode != "background" {
		return fmt.Errorf("COMPUTER_INPUT_NOT_SENT: on Windows the Computer sends input only in the background, because foreground input reaches whichever app the user brings forward. Do not retry with foreground delivery; omit delivery_mode, try another control or route, or tell the user what you could not do: %w", errNotSent)
	}
	if scope, ok := arguments["scope"]; ok && scope != "window" {
		return fmt.Errorf("COMPUTER_INPUT_NOT_SENT: on Windows input goes to one window named by pid and window_id, never to a desktop point. Omit scope and target a window with pid and window_id from list_windows, or tell the user what you could not do: %w", errNotSent)
	}
	if windowsChromiumPointerTools[name] && chromium() {
		return fmt.Errorf("COMPUTER_INPUT_NOT_SENT: %s in a Chrome, Edge or Electron window uses the user's real mouse on Windows; click the element, or use the page's own buttons and menus: %w", name, errNotSent)
	}
	return nil
}

// windowsRestore restores the minimized window that a Windows read or input
// names, behind the window in front, so the Agent never needs the user to
// restore it. An input to a window it restored is not sent: the element
// positions of an earlier read were those of the minimized window.
func windowsRestore(name string, pid, window int64, restore func(pid, window int64) (bool, error)) error {
	if window <= 0 || !inputTools[name] && name != "get_window_state" {
		return nil
	}
	restored, err := restore(pid, window)
	if err != nil && inputTools[name] {
		return fmt.Errorf("COMPUTER_INPUT_NOT_SENT: %w; tell the user what you could not do: %w", err, errNotSent)
	}
	if err != nil {
		return err
	}
	if restored && inputTools[name] {
		return fmt.Errorf("COMPUTER_INPUT_NOT_SENT: window %d was minimized; the Computer restored it behind the window in front without taking the user's focus. Read it with get_window_state, then send the input again: %w", window, errNotSent)
	}
	return nil
}

// windowsRefusedResult replaces the text of a Cua background refusal, which
// recommends foreground delivery or bring_to_front, with the Windows route.
func windowsRefusedResult(name string, result json.RawMessage) json.RawMessage {
	var reply cuaResult
	if json.Unmarshal(result, &reply) != nil || !reply.IsError || !windowsRefusedResultCodes[reply.Structured.Code] {
		return result
	}
	text := "COMPUTER_INPUT_NOT_SENT: this window does not take " + name + " in the background, and the Computer sends no foreground input on Windows. Try another element or control, or tell the user what you could not do."
	switch {
	case reply.Structured.Code == "window_minimized":
		text = "COMPUTER_INPUT_NOT_SENT: the window is minimized. Read it with get_window_state and its window_id from list_windows: the Computer restores it behind the window in front, without taking the user's focus. Then send the input with that window_id."
	case name == "scroll":
		text = "COMPUTER_INPUT_NOT_SENT: this window does not scroll in the background. Chrome, Edge and Electron apps never do: read the content you need with get_window_state query instead of scrolling. In another app, pass the element_token of the scrolled list or pane itself from the latest get_window_state read."
	}
	var fields map[string]any
	if json.Unmarshal(result, &fields) != nil {
		return result
	}
	fields["content"] = []any{map[string]any{"type": "text", "text": text}}
	encoded, err := json.Marshal(fields)
	if err != nil {
		return result
	}
	return encoded
}

// windowsSchema removes the foreground and desktop delivery fields from a
// Cua input schema.
func windowsSchema(input map[string]any) {
	props, _ := input["properties"].(map[string]any)
	for _, field := range windowsForegroundFields {
		delete(props, field)
	}
}

// windowsScrollDescription replaces Cua's scroll description, which offers
// foreground and desktop delivery.
const windowsScrollDescription = "Scroll a window in the background by amount steps in direction. A classic window with its own scroll bar scrolls with pid and window_id; a list or pane in a modern app scrolls by its own element_token from the latest get_window_state read. Chrome, Edge and Electron apps do not scroll in the background: read the content you need with get_window_state query instead."

// chromiumTarget reports whether an input's window is a Chromium frame.
func (c *cuaSession) chromiumTarget(arguments map[string]any) bool {
	return chromiumWindow(c.targetWindow(arguments))
}

// targetWindow returns the pid and window an input names. An input named
// only by its element_token takes them from the read that token comes from,
// as the inputs of ui.window(...).observe() are.
func (c *cuaSession) targetWindow(arguments map[string]any) (pid, window int64) {
	p, _ := arguments["pid"].(float64)
	w, _ := arguments["window_id"].(float64)
	if token, ok := arguments["element_token"].(string); ok && (p == 0 || w == 0) && c.op != nil {
		if key, _, found := c.op.reads.row(token); found && (p == 0 || int64(p) == key.pid) {
			return key.pid, key.window
		}
	}
	return int64(p), int64(w)
}

// WindowsToolGuide describes Windows targeting and the background-only rule
// to the Runtime.
const WindowsToolGuide = `Use computer.ui_exec for desktop and browser interaction. Within the script use ui.window(pid, window_id) for a Windows window, ui.page for the managed browser, and ui.computer for native methods; ui.computer.list_windows finds an app's windows. Window actions use the latest observation and return the updated window.
The user keeps working on this PC. Every input goes to the window you name in the background: no input moves the user's mouse, changes the window in front or reaches the app the user is using. Scroll a list or pane with ui.computer.scroll and its own element_token. Chrome, Edge and Electron apps do not scroll in the background, so read their content with ui.computer.get_window_state and a query; in them double_click and right_click are refused, so click the element or use the page's own buttons and menus. An input refused with COMPUTER_INPUT_NOT_SENT was not sent: try another route or tell the user. A minimized window named by window_id is restored behind the window in front, without taking the user's focus, when you read it or send it input; after an input reports that it restored the window, read the window before the next input.
To connect the user's everyday signed-in Chrome, or when a browser call returns BROWSER_CONNECTION_REQUIRED or BROWSER_CONNECTION_INVALID, run ` + "`teamhub browser connect`" + ` to post a browser connection card and end the turn to wait for the result; never ask for the extension token in a message or ask to relaunch Chrome with --remote-debugging-port.`
