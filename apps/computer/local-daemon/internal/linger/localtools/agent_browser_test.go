package localtools

import (
	"strings"
	"testing"
)

func TestCountTabsReadsChromeEdgeAndFirefoxStrips(t *testing.T) {
	for name, tree := range map[string]string{
		"chrome": "- [2] AXRadioButton \"Feed\"\n- [3] AXButton \"Close\" [actions=[press]]\n- [4] AXRadioButton \"Post\"\n- [5] AXButton \"Close\" [actions=[press]]",
		"edge": "  - AXTabGroup \"Tab bar\"\n    - [23] AXPopUpButton \"Search tabs\" [actions=[press]]\n      - [24] AXRadioButton \"(en-us)\" [actions=[press]]\n        - [25] AXButton \"Close tab\" [actions=[press]]\n" +
			"      - [26] AXRadioButton \"Trail checklist - Pinboard\" [actions=[press]]\n        - [27] AXButton \"Close tab\" [actions=[press]]\n    - [28] AXButton \"New Tab\" [actions=[press]]",
		"firefox": "    - [2] AXTabGroup [actions=[press]]\n      - [3] AXRadioButton \"Feed\" [actions=[press]]\n        - [4] AXStaticText = \"Feed\" [actions=[press]]\n        - [5] AXButton \"Close tab\" [actions=[press]]\n" +
			"      - [6] AXRadioButton \"Post\" [actions=[press]]\n        - [7] AXStaticText = \"Post\" [actions=[press]]\n        - [8] AXButton \"Close tab\" [actions=[press]]\n      - [9] AXButton (Open a new tab) [actions=[press]]",
		"safari": "    - [17] AXRadioButton \"Trail checklist - Pinboard\" [id=TabBarTab?isPinned=false&isNarrow=false&isActive=false actions=[press,name:close tab]]\n" +
			"    - [18] AXRadioButton \"Start Page\" [id=TabBarTab?isPinned=false&isNarrow=false&isActive=true actions=[press,name:close tab]]",
	} {
		if got := countTabs(tree); got != 2 {
			t.Errorf("%s: %d tabs, want 2", name, got)
		}
	}
	// A page's own radio buttons are not tabs.
	if got := countTabs("- [9] AXRadioButton \"Small\"\n- [10] AXRadioButton \"Large\"\n- [11] AXButton \"Close\" [actions=[press]]"); got != 1 {
		t.Errorf("page radios: %d tabs, want 1", got)
	}
}

func TestPickAgentBrowserTakesTheFirstInstalledOrTheNamedOne(t *testing.T) {
	installed := agentBrowserInstalled
	t.Cleanup(func() { agentBrowserInstalled = installed })
	agentBrowserInstalled = func(b agentBrowser) bool { return b.Name == "Firefox" }
	if b, err := pickAgentBrowser(""); err != nil || b.Name != "Firefox" {
		t.Fatalf("got %v %v, want Firefox when only it is installed", b.Name, err)
	}
	if b, err := pickAgentBrowser("com.microsoft.edgemac"); err != nil || b.Name != "Edge" {
		t.Fatalf("got %v %v, want the named Edge", b.Name, err)
	}
	if _, err := pickAgentBrowser("com.apple.TextEdit"); err == nil {
		t.Fatal("a non-browser was accepted")
	}
	agentBrowserInstalled = func(agentBrowser) bool { return false }
	if _, err := pickAgentBrowser(""); err == nil || !strings.Contains(err.Error(), "COMPUTER_BROWSER_UNAVAILABLE") {
		t.Fatalf("got %v, want unavailable", err)
	}
	if !agentBrowserApp("", "Firefox") || !agentBrowserApp("com.google.Chrome", "") || !agentBrowserApp("com.apple.Safari", "Safari") || agentBrowserApp("com.apple.TextEdit", "TextEdit") {
		t.Fatal("agentBrowserApp misread an app")
	}
}

func TestEverydayChromeCommandFindsChromeInAnyFolder(t *testing.T) {
	for args, want := range map[string]bool{
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome":                                                                                                               true,
		"/Users/a/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --disable-backgrounding-occluded-windows":                                                              true,
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/test":                                                                                     false,
		"/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=renderer": false,
		"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary":                                                                                                 false,
		"tail -f /Applications/Google Chrome.app/Contents/MacOS/Google Chrome":                                                                                                       false,
	} {
		if got := everydayChromeCommand(args); got != want {
			t.Errorf("%q: %v, want %v", args, got, want)
		}
	}
}

func TestEverydayChromeKeysAllowOnlyOnePlainBoundKey(t *testing.T) {
	for _, tc := range []struct {
		name      string
		arguments map[string]any
		allowed   bool
	}{
		{"press_key", map[string]any{"key": "return", "element_token": "s1:1"}, true},
		{"set_value", map[string]any{"value": "kettle", "element_token": "s1:1"}, true},
		{"press_key", map[string]any{"key": "return"}, false},
		{"press_key", map[string]any{"key": "return", "element_token": "s1:1", "modifiers": []any{}}, false},
		{"press_key", map[string]any{"key": "return", "element_token": "s1:1", "modifiers": "cmd"}, false},
		{"press_key", map[string]any{"key": "cmd+r", "element_token": "s1:1"}, false},
		{"press_key", map[string]any{"key": 13.0, "element_token": "s1:1"}, false},
		{"hotkey", map[string]any{"keys": []any{"cmd", "["}}, false},
		{"type_text", map[string]any{"text": "kettle", "element_token": "s1:1"}, false},
	} {
		if err := everydayChromeKeys(tc.name, tc.arguments, true); (err == nil) != tc.allowed {
			t.Errorf("%s %v: err=%v, want allowed=%v", tc.name, tc.arguments, err, tc.allowed)
		}
	}
	// One of the user's windows takes no key at all.
	if err := everydayChromeKeys("press_key", map[string]any{"key": "return", "element_token": "s1:1"}, false); err == nil {
		t.Error("a bound Return went to one of the user's windows")
	}
}
