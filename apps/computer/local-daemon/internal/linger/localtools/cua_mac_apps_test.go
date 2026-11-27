package localtools

import (
	"context"
	"encoding/json"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// Tests name fixture pids, so the real window server has nothing to say.
func init() {
	modalPanels = func(context.Context, int) []modalPanel { return nil }
}

func stubModalPanels(t *testing.T, panels ...modalPanel) {
	t.Helper()
	original := modalPanels
	modalPanels = func(_ context.Context, pid int) []modalPanel {
		if pid != 42 {
			return nil
		}
		return panels
	}
	t.Cleanup(func() { modalPanels = original })
}

func TestLsappListPIDFindsAnAppByItsBundleFileName(t *testing.T) {
	const list = `76) "Finder" ASN:0x0-0x1001:
    bundleID="com.apple.finder"
    bundle path="/System/Library/CoreServices/Finder.app"
    executable path="/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder"
    pid = 501 type="Foreground" flavor=3 Version="15.0" fileType="FNDR" creator="MACS" Arch=ARM64
77) "Bambu Studio" ASN:0x0-0x2614111b:
    bundleID="com.bambulab.bambu-studio"
    bundle path="/Applications/BambuStudio.app"
    executable path="/Applications/BambuStudio.app/Contents/MacOS/BambuStudio"
    pid = 66237 type="Foreground" flavor=3 Version="" fileType="APPL" creator="????" Arch=ARM64
`
	for app, want := range map[string]int{
		"BambuStudio":                   66237,
		"bambustudio.app":               66237,
		"/Applications/BambuStudio.app": 66237,
		"Finder":                        501,
		"Bambu":                         0,
		"Studio":                        0,
	} {
		if got := lsappListPID(list, app); got != want {
			t.Errorf("lsappListPID(%q)=%d, want %d", app, got, want)
		}
	}
}

func TestLocalToolCuaNamesAnOpenDialogTheWindowListOmits(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("modal panels are a macOS window level")
	}
	stubModalPanels(t, modalPanel{WindowID: 31, Title: "Send print job"})
	c := cuaFixtureSession(t, "window-view", "")
	const want = `open dialog that holds its input: window_id 31 "Send print job"`
	for tool, args := range map[string]string{
		"get_window_state": `{"pid":42,"window_id":7}`,
		"list_windows":     `{"pid":42}`,
	} {
		result, err := c.call(t.Context(), tool, json.RawMessage(args))
		if err != nil || !strings.Contains(string(result), strings.ReplaceAll(want, `"`, `\"`)) {
			t.Fatalf("%s: err=%v result=%s", tool, err, result)
		}
	}
	// The dialog itself, and an app without one, carry no note.
	for _, args := range []string{`{"pid":42,"window_id":31}`, `{"pid":43,"window_id":7}`} {
		result, err := c.call(t.Context(), "get_window_state", json.RawMessage(args))
		if err != nil || strings.Contains(string(result), "open dialog") {
			t.Fatalf("%s: err=%v result=%s", args, err, result)
		}
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}

func TestLocalToolCuaSendsForegroundInputToAnOpenDialog(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("key focus routing is macOS only")
	}
	// Window 9 is the front ordinary window; 31 is a dialog above it that the
	// window list does not hold.
	stubModalPanels(t, modalPanel{WindowID: 31, Title: "Send print job"})
	marker := filepath.Join(t.TempDir(), "calls.jsonl")
	c := cuaFixtureSession(t, "window-view", marker)
	stubFront(t, 42)
	if _, err := c.call(t.Context(), "press_key", json.RawMessage(`{"pid":42,"window_id":31,"key":"return"}`)); err != nil {
		t.Fatalf("a key for the open dialog was refused: %v", err)
	}
	// An ordinary window behind the front one is still refused.
	if _, err := c.call(t.Context(), "press_key", json.RawMessage(`{"pid":42,"window_id":7,"key":"a"}`)); err == nil || !strings.Contains(err.Error(), "is not the app's front window") {
		t.Fatalf("err=%v", err)
	}
	result, err := c.call(t.Context(), "bring_to_front", json.RawMessage(`{"pid":42,"window_id":31}`))
	if err != nil || !strings.Contains(string(result), "Window 31 is this app's open dialog") {
		t.Fatalf("bring_to_front: err=%v result=%s", err, result)
	}
	for _, call := range fixtureCalls(t, marker) {
		if call.Name == "bring_to_front" && call.Arguments["window_id"] != nil {
			t.Fatalf("the driver was asked to front the dialog by id: %v", call)
		}
	}
	if err := c.drain(); err != nil {
		t.Fatal(err)
	}
}
