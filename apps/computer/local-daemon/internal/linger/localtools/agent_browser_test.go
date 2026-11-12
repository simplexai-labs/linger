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
		want := map[string]string{"chrome": "Close", "edge": "Close tab", "firefox": "Close tab"}[name]
		if got, close := tabStrip(tree); got != 2 || close != want {
			t.Errorf("%s: %d tabs closed by %q, want 2 closed by %q", name, got, close, want)
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

func TestEverydayChromeProcessFindsChromeInAnyFolder(t *testing.T) {
	for _, tc := range []struct {
		path, args string
		want       bool
	}{
		{"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", true},
		{"/Users/a/Applications/Work - Apps/Google Chrome.app/Contents/MacOS/Google Chrome", "/Users/a/Applications/Work - Apps/Google Chrome.app/Contents/MacOS/Google Chrome --disable-backgrounding-occluded-windows", true},
		{"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/test", false},
		{"/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper", "Google Chrome Helper --type=renderer", false},
		{"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary", "", false},
		{"/usr/bin/tail", "/usr/bin/tail -f /Applications/Google Chrome.app/Contents/MacOS/Google Chrome", false},
	} {
		if got := everydayChromeProcess(tc.path, tc.args); got != tc.want {
			t.Errorf("%q %q: %v, want %v", tc.path, tc.args, got, tc.want)
		}
	}
}

func TestSharedWindowsKeepEveryWindowOfTheBrowser(t *testing.T) {
	m := &Manager{}
	m.setSharedWindow("com.google.Chrome", 42, 11)
	m.setSharedWindow("com.google.Chrome", 42, 12)
	m.setSharedWindow("com.apple.Safari", 7, 3)
	shared, ok := m.sharedWindowOf(42)
	if !ok || len(shared.Windows) != 2 || shared.latest() != 12 {
		t.Fatalf("shared=%+v ok=%v, want windows 11 and 12 with 12 latest", shared, ok)
	}
	// A restarted Chrome has a new pid, and none of the old windows.
	m.setSharedWindow("com.google.Chrome", 43, 20)
	if shared, _ := m.sharedWindowOf(43); len(shared.Windows) != 1 || shared.latest() != 20 {
		t.Fatalf("shared=%+v, want only window 20 after the restart", shared)
	}
	if safari, ok := m.sharedWindowOf(7); !ok || safari.latest() != 3 {
		t.Fatalf("safari=%+v ok=%v, want Safari's window kept apart", safari, ok)
	}
}
