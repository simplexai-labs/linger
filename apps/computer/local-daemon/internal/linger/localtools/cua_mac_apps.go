package localtools

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// macLookupTimeout bounds the short system lookups below, which only add
// detail to a result and must never hold a call.
const macLookupTimeout = 3 * time.Second

// modalPanelLayer is NSModalPanelWindowLevel. A window at this level is a
// modal dialog: it stays above the app's ordinary windows and takes the
// app's input until it closes.
const modalPanelLayer = 8

// modalPanel is one open modal dialog of an app.
type modalPanel struct {
	WindowID float64 `json:"window_id"`
	Title    string  `json:"title"`
}

const modalPanelScript = `ObjC.import('CoreGraphics');
function run(argv) {
	const pid = Number(argv[0]), layer = Number(argv[1]);
	const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0)));
	const out = [];
	for (const w of list) {
		if (w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === layer) out.push({window_id: w.kCGWindowNumber, title: w.kCGWindowName || ''});
	}
	return JSON.stringify(out);
}`

// modalPanels lists an app's open modal dialogs. Cua list_windows lists only
// layer-0 windows and a window's screenshot shows only that window, so a
// dialog an input opened is in neither: Bambu Studio's Send print job dialog
// was open while the Agent, seeing the main window unchanged, clicked the
// button that opens it again. A failed lookup lists none.
var modalPanels = func(ctx context.Context, pid int) []modalPanel {
	if runtime.GOOS != "darwin" || pid <= 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, macLookupTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/bin/osascript", "-l", "JavaScript", "-e", modalPanelScript, strconv.Itoa(pid), strconv.Itoa(modalPanelLayer)).Output()
	if err != nil {
		return nil
	}
	var panels []modalPanel
	if json.Unmarshal(out, &panels) != nil {
		return nil
	}
	return panels
}

// isModalPanel reports whether window is an open modal dialog of the app.
func isModalPanel(ctx context.Context, pid, window any) bool {
	number, ok := pid.(float64)
	id, named := window.(float64)
	if !ok || !named {
		return false
	}
	for _, panel := range modalPanels(ctx, int(number)) {
		if panel.WindowID == id {
			return true
		}
	}
	return false
}

// modalPanelNote names the app's open modal dialogs other than the window a
// call addressed, or is empty when there is none.
func modalPanelNote(ctx context.Context, pid, window any) string {
	number, ok := pid.(float64)
	if !ok {
		return ""
	}
	var open []string
	for _, panel := range modalPanels(ctx, int(number)) {
		if panel.WindowID != window {
			open = append(open, fmt.Sprintf("window_id %v %q", panel.WindowID, panel.Title))
		}
	}
	if len(open) == 0 {
		return ""
	}
	return "This app has an open dialog that holds its input: " + strings.Join(open, ", ") +
		". list_windows and a screenshot of another window do not show it. Read it with get_window_state and that window_id, and act on it or close it before using the app's other windows."
}

// lsappListPID finds a running app in `lsappinfo list` output by its bundle
// path, or by the bundle's file name with or without ".app". open -a takes
// that file name while lsappinfo resolves only the display name, so an app
// whose two names differ, as BambuStudio.app "Bambu Studio" does, started
// and was then reported as not started.
func lsappListPID(list, app string) int {
	path := ""
	for line := range strings.SplitSeq(list, "\n") {
		line = strings.TrimSpace(line)
		if value, ok := strings.CutPrefix(line, `bundle path="`); ok {
			path = strings.TrimSuffix(value, `"`)
			continue
		}
		value, ok := strings.CutPrefix(line, "pid = ")
		if !ok || path == "" {
			continue
		}
		base := filepath.Base(path)
		matches := path == app || strings.EqualFold(base, app) || strings.EqualFold(strings.TrimSuffix(base, ".app"), app)
		field, _, _ := strings.Cut(value, " ")
		path = ""
		if pid, err := strconv.Atoi(field); matches && err == nil && pid > 0 {
			return pid
		}
	}
	return 0
}

const appPathScript = `ObjC.import('Foundation');
function run(argv) {
	const want = argv[0].toLowerCase();
	const fm = $.NSFileManager.defaultManager;
	const home = ObjC.unwrap($.NSHomeDirectory());
	for (const dir of ['/Applications', home + '/Applications', '/System/Applications', '/Applications/Utilities', '/System/Applications/Utilities']) {
		const items = ObjC.deepUnwrap(fm.contentsOfDirectoryAtPathError(dir, null)) || [];
		for (const item of items) {
			if (!item.endsWith('.app')) continue;
			const bundle = $.NSBundle.bundleWithPath(dir + '/' + item);
			if (bundle.isNil()) continue;
			for (const key of ['CFBundleDisplayName', 'CFBundleName']) {
				const value = bundle.objectForInfoDictionaryKey(key);
				if (!value.isNil() && ObjC.unwrap(value).toLowerCase() === want) return dir + '/' + item;
			}
		}
	}
	return '';
}`

// appPathByName finds an installed app by the name its bundle declares, for a
// name open -a does not know. It is empty when no app declares the name.
var appPathByName = func(ctx context.Context, name string) string {
	ctx, cancel := context.WithTimeout(ctx, macLookupTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/bin/osascript", "-l", "JavaScript", "-e", appPathScript, name).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
