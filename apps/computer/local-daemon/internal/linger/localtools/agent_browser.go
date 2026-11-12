package localtools

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

// agentBrowser is one browser the Computer can run as its own: a separate
// instance on a profile of its own, with no remote debugging, so sites see a
// person's browser and the user's everyday browser stays untouched.
type agentBrowser struct {
	// Name is how messages and the model name the browser.
	Name string
	// Bundle is its macOS bundle id, and App the app folder in Applications.
	Bundle, App string
	// Directory is the profile's folder under computer-tools.
	Directory string
	// Args start the browser on profile, after open's --args.
	Args func(profile string) []string
	// Settings are what a running instance's command line must carry for
	// the tools to rely on it; one without them is restarted.
	Settings []string
	// AddressRole and AddressLabel find the address bar; an empty label
	// takes the first element with that role, which in the browser's
	// toolbar comes before the page.
	AddressRole, AddressLabel string
	// AddressID finds the address bar by its accessibility identifier
	// instead, where the name follows the user's language.
	AddressID string
	// Prepare writes the profile's own settings before a start.
	Prepare func(profile string) error
	// Shared marks a browser that runs only as the user's own instance, as
	// Safari does: it has no separate profile, so the Computer works in a
	// window of its own there, with the user's sign-ins.
	Shared bool
	// Everyday marks the user's everyday Chrome: the Computer opens each
	// site in a window of its own there, by command line, and the running
	// instance must carry Settings, so a covered window keeps working. One
	// started without them restarts only after the user agreed.
	Everyday bool
}

// chromiumArgs start a Chromium browser as the Computer's own. Without
// --disable-backgrounding-occluded-windows Chromium stops painting and
// updating the accessibility tree of a window that is covered or on another
// Space, so a page loaded there reads as empty. With it, the window keeps
// working wherever the user puts it.
// Translate is off so its prompt does not open as an extra window, and the
// audio is muted, so a video page read in the background stays silent.
// --use-mock-keychain keeps sign-ins: Chromium encrypts cookies with a key
// from the login keychain, and when that keychain is locked, as it can be
// for a daemon, it keeps cookies in memory only and every restart signs the
// user out. The profile directory is private to the user instead.
// Chromium takes its interface language from macOS, and the tools find the
// address bar and tab buttons by their English names, so the command pins
// English. Chromium also opens that setting's value, "(en-US)", as the first
// tab: it stays as the window's spare tab, so closing the last opened page
// with its tab keeps the window and the next URL does not start it again.
var chromiumArgs = []string{"--disable-backgrounding-occluded-windows", "--disable-features=Translate", "--mute-audio", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain"}

func chromium(profile string) []string {
	return append(append([]string{"--user-data-dir=" + profile}, chromiumArgs...), "-AppleLanguages", "(en-US)")
}

// firefoxPrefs skip Firefox's first-run pages and prompts, which would open
// as extra tabs or bars, pin the English interface the tools read, and keep
// pages silent.
const firefoxPrefs = `user_pref("browser.aboutwelcome.enabled", false);
user_pref("trailhead.firstrun.didSeeAboutWelcome", true);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("termsofuse.bypassNotification", true);
user_pref("intl.locale.requested", "en-US");
user_pref("browser.tabs.warnOnClose", false);
user_pref("browser.translations.automaticallyPopup", false);
user_pref("media.autoplay.default", 5);
`

// everydayChromeArgs are what the user's everyday Chrome needs for the
// Computer's window in it: see chromiumArgs for why a covered window stops
// working without it. Sites see no other difference.
var everydayChromeArgs = []string{"--disable-backgrounding-occluded-windows"}

var agentBrowsers = []agentBrowser{
	// Chrome is the user's everyday Chrome, with their sign-ins, history and
	// device trust: sites that watch for automated browsing trust that
	// browser most, and the user signs in only once.
	{Name: "Chrome", Bundle: "com.google.Chrome", App: "Google Chrome.app", Settings: everydayChromeArgs,
		AddressRole: "AXTextField", AddressLabel: "Address and search bar", Shared: true, Everyday: true},
	{Name: "Edge", Bundle: "com.microsoft.edgemac", App: "Microsoft Edge.app", Directory: "agent-edge", Args: chromium,
		Settings: append(slices.Clone(chromiumArgs), "-AppleLanguages"), AddressRole: "AXTextField", AddressLabel: "Address and search bar"},
	// Firefox keeps its window working while covered without a flag. Its
	// address bar is the toolbar's only combo box, and its name follows the
	// search engine, so the role alone finds it.
	{Name: "Firefox", Bundle: "org.mozilla.firefox", App: "Firefox.app", Directory: "agent-firefox",
		Args:     func(profile string) []string { return []string{"-profile", profile, "-no-remote"} },
		Settings: []string{"-no-remote"}, AddressRole: "AXComboBox",
		Prepare: func(profile string) error {
			return privatefs.WriteFile(filepath.Join(profile, "user.js"), []byte(firefoxPrefs), false)
		}},
	// Safari keeps one instance with the user's data, so it comes last: the
	// Computer opens a window of its own in it.
	{Name: "Safari", Bundle: "com.apple.Safari", App: "Safari.app", AddressRole: "AXTextField", AddressID: "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD", Shared: true},
}

// agentBrowserInstalled reports whether the app of b is in Applications.
var agentBrowserInstalled = func(b agentBrowser) bool {
	folders := []string{"/Applications", "/System/Cryptexes/App/System/Applications"}
	if home, err := os.UserHomeDir(); err == nil {
		folders = append(folders, filepath.Join(home, "Applications"))
	}
	for _, folder := range folders {
		if _, err := os.Stat(filepath.Join(folder, b.App)); err == nil {
			return true
		}
	}
	return false
}

// pickAgentBrowser returns the browser launch_app named by bundle id, or
// with none the first installed one, so a user without Chrome is served by
// the browser they have.
func pickAgentBrowser(bundle string) (agentBrowser, error) {
	names := make([]string, 0, len(agentBrowsers))
	for _, b := range agentBrowsers {
		names = append(names, b.Bundle)
		if bundle == b.Bundle || bundle == "" && agentBrowserInstalled(b) {
			return b, nil
		}
	}
	if bundle != "" {
		return agentBrowser{}, errors.New("launch_app agent_browser takes bundle_id " + strings.Join(names, ", ") + ", or none to use the first one installed")
	}
	return agentBrowser{}, errors.New("COMPUTER_BROWSER_UNAVAILABLE: none of Google Chrome, Microsoft Edge, Firefox or Safari was found; ask the user to install one of them")
}

// agentBrowserApp reports whether a launch_app call names an app that runs
// as one of the Computer's own browsers.
func agentBrowserApp(bundle, name string) bool {
	for _, b := range agentBrowsers {
		if bundle == b.Bundle || name != "" && strings.Contains(strings.ToLower(b.App), strings.ToLower(name)) {
			return true
		}
	}
	return false
}

// startedWith reports whether a running instance's command line carries
// every setting the Computer starts b with.
func (b agentBrowser) startedWith(command string) bool {
	for _, setting := range b.Settings {
		if !strings.Contains(command, setting) {
			return false
		}
	}
	return true
}

// launchAgentSafari opens urls in the Computer's own window of the user's
// Safari: the window this task or an earlier one opened there, or a new one.
// Each URL opens in a new tab of that window, as in the other browsers, and
// the window's first tab stays as its spare tab.
// agentSafariWindowWait bounds the wait for a new Safari window to become
// readable.
var agentSafariWindowWait = 30 * time.Second

func (c *cuaSession) launchAgentSafari(ctx context.Context, b agentBrowser, urls []string) (json.RawMessage, error) {
	m := c.op.manager
	pid, _ := lsappPID(ctx, b.Bundle)
	started := pid == 0
	if started {
		if output, err := exec.CommandContext(ctx, "/usr/bin/open", "-g", "-b", b.Bundle).CombinedOutput(); err != nil {
			return nil, fmt.Errorf("launch_app: %s: %w", strings.TrimSpace(string(output)), err)
		}
	}
	windows, pid, err := c.waitSafariWindows(ctx, b, pid, func([]listedWindow) bool { return true })
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	own := m.sharedBrowserWindow
	if m.sharedBrowserPID != pid {
		own = 0
	}
	m.mu.Unlock()
	index := slices.IndexFunc(windows, func(w listedWindow) bool { return w.WindowID == own })
	if index < 0 {
		before := map[float64]bool{}
		for _, w := range windows {
			before[w.WindowID] = true
		}
		if len(windows) == 0 {
			// Opening the app again makes Safari show a window.
			if output, err := exec.CommandContext(ctx, "/usr/bin/open", "-g", "-b", b.Bundle).CombinedOutput(); err != nil {
				return nil, fmt.Errorf("launch_app: %s: %w", strings.TrimSpace(string(output)), err)
			}
		} else {
			largest := slices.MaxFunc(windows, func(a, b listedWindow) int {
				return cmp.Compare(a.Bounds.Width*a.Bounds.Height, b.Bounds.Width*b.Bounds.Height)
			})
			if result, err := c.agentChromeKey(ctx, pid, largest.WindowID, "hotkey", map[string]any{"keys": []string{"cmd", "n"}}); err != nil || failed(result) {
				return nil, fmt.Errorf("COMPUTER_INPUT_NOT_SENT: Safari refused the key for a new window: %w", errors.Join(err, errNotSent))
			}
		}
		if windows, pid, err = c.waitSafariWindows(ctx, b, pid, func(listed []listedWindow) bool {
			return slices.ContainsFunc(listed, func(w listedWindow) bool { return !before[w.WindowID] })
		}); err != nil {
			return nil, err
		}
		index = slices.IndexFunc(windows, func(w listedWindow) bool { return !before[w.WindowID] })
		started = true
		// A window Safari opened in the background has no accessibility
		// window until Safari is shown once, so Cua cannot read or key it.
		// Activating Safari brings the new window forward this one time.
		if output, err := exec.CommandContext(ctx, "/usr/bin/open", "-b", b.Bundle).CombinedOutput(); err != nil {
			return nil, fmt.Errorf("launch_app: %s: %w", strings.TrimSpace(string(output)), err)
		}
	}
	window := windows[index]
	if started {
		// Safari can take longer than a Chromium start before the new
		// window's accessibility tree resolves; opening a tab waits for it.
		c.agentChromeTabsUntil(ctx, pid, window.WindowID, agentSafariWindowWait, func(n int) bool { return n > 0 })
	}
	m.mu.Lock()
	m.sharedBrowserBundle, m.sharedBrowserPID, m.sharedBrowserWindow = b.Bundle, pid, window.WindowID
	m.mu.Unlock()
	for _, url := range urls {
		if err := c.agentChromeOpenTab(ctx, b, pid, window.WindowID, offSpace(window), url); err != nil {
			return nil, err
		}
	}
	tabs := c.agentChromeTabs(ctx, pid, window.WindowID)
	c.op.mu.Lock()
	c.op.chromeTabs, c.op.chromePID, c.op.chromeWindow = tabs, pid, window.WindowID
	c.op.mu.Unlock()
	note := "This is the Computer's own window in the user's Safari. Safari has no separate profile, so this window has the user's Safari sign-ins; work only in this window, never in the user's other Safari windows. It works while other windows cover it, but only on the desktop (Space) the user is on. Keys without an element go to this window in the background. Type into a page field with type_text and the field's element_token. Move between pages as a person does: through the page's search box, menus and links, back with cmd+[; never type an address into the address bar. Close a tab with its tab's close action, not cmd+w."
	if started {
		note = "Opened a new Safari window for the Computer. " + note
	}
	opened := "No URL was opened, so no tab is this task's."
	if len(urls) > 0 {
		opened = "The last one is this task's and in front."
	}
	text := fmt.Sprintf("Opened %d URL(s) in the Computer's own Safari window (pid %d), window %q [window_id: %v]. The window has %d tab(s). %s\n%s", len(urls), pid, window.Title, window.WindowID, tabs, opened, note)
	return json.Marshal(map[string]any{"content": []any{map[string]string{"type": "text", "text": text}},
		"structuredContent": map[string]any{"browser": b.Name, "pid": pid, "windows": []map[string]any{{"window_id": window.WindowID, "title": window.Title, "on_screen": window.IsOnScreen}}, "tabs": tabs, "note": note}})
}

// waitSafariWindows reads Safari's windows until done accepts them, for
// agentChromeWait at most, and returns them with Safari's pid.
func (c *cuaSession) waitSafariWindows(ctx context.Context, b agentBrowser, pid int, done func([]listedWindow) bool) ([]listedWindow, int, error) {
	deadline := time.Now().Add(agentChromeWait)
	for {
		if pid == 0 {
			pid, _ = lsappPID(ctx, b.Bundle)
		}
		if pid > 0 {
			windows, err := c.appWindows(ctx, pid)
			if err != nil {
				return nil, 0, err
			}
			if done(windows) {
				return windows, pid, nil
			}
		}
		if time.Now().After(deadline) {
			return nil, 0, errors.New("launch_app: Safari did not open a window for the Computer")
		}
		if err := sleepContext(ctx, 200*time.Millisecond); err != nil {
			return nil, 0, err
		}
	}
}

// everydayChromePID finds the user's everyday Chrome: the main process of
// Google Chrome on its default profile, wherever the app is installed. Chrome
// instances on a profile of their own, such as a test browser, name
// --user-data-dir and are not it. It returns the pid and command line, or 0
// when that Chrome is not running.
var everydayChromePID = func(ctx context.Context) (int, string, error) {
	output, err := exec.CommandContext(ctx, "/bin/ps", "-axww", "-o", "pid=,args=").Output()
	if err != nil {
		return 0, "", err
	}
	for _, line := range strings.Split(string(output), "\n") {
		pidText, args, _ := strings.Cut(strings.TrimSpace(line), " ")
		if !everydayChromeCommand(args) {
			continue
		}
		if pid, err := strconv.Atoi(pidText); err == nil {
			return pid, args, nil
		}
	}
	return 0, "", nil
}

// everydayChromeCommand reports whether args starts Google Chrome's own
// executable on the default profile. The executable path has spaces, so it
// ends where the first argument starts.
func everydayChromeCommand(args string) bool {
	index := strings.Index(args, everydayChromeExecutable)
	if !strings.HasPrefix(args, "/") || index < 0 {
		return false
	}
	rest := args[index+len(everydayChromeExecutable):]
	return (rest == "" || rest[0] == ' ') && !strings.Contains(args, "--type=") && !strings.Contains(args, "--user-data-dir=")
}

const everydayChromeExecutable = "/Google Chrome.app/Contents/MacOS/Google Chrome"

// sharedBrowserRunning returns the pid of the user's own browser named by
// bundle, or 0.
func sharedBrowserRunning(ctx context.Context, bundle string) (int, error) {
	if bundle == "com.google.Chrome" {
		pid, _, err := everydayChromePID(ctx)
		return pid, err
	}
	return lsappPID(ctx, bundle)
}

// everydayChromeQuit asks the user to quit their Chrome. Only the user
// quits it: a quit loses text typed into a page and not yet sent, and no
// tool call can prove the user agreed to that.
const everydayChromeQuit = "COMPUTER_BROWSER_RESTART_REQUIRED: the user's Chrome runs without the setting that keeps the Computer's window working while other windows cover it, and Chrome takes it only when it starts; nothing was opened. Ask the user with a question card to quit Chrome from its menu (Google Chrome > Quit Google Chrome) and leave it closed, then end your turn. When they answer that Chrome is closed, call launch_app again: the Computer starts Chrome with that setting and brings back their windows and tabs. If they decline, end the task"

// launchEverydayChrome opens url in a new window of the user's everyday
// Chrome, the Computer's own window there, which the task then works in. The
// window opens through Chrome's command line, as a link from another app
// does, so no key reaches the user's other Chrome windows. A Chrome that is
// not running starts with the setting the window needs; one running without
// it is never quit by the Computer: the user quits it.
func (c *cuaSession) launchEverydayChrome(ctx context.Context, b agentBrowser, urls []string) (json.RawMessage, error) {
	if len(urls) != 1 {
		return nil, fmt.Errorf("launch_app opens one site at a time in the user's Chrome; call it once for each site: %w", errNotSent)
	}
	site := siteOf(urls[0])
	if site == "" {
		return nil, fmt.Errorf("launch_app opens a web address in the user's Chrome: %w", errNotSent)
	}
	m := c.op.manager
	pid, command, err := everydayChromePID(ctx)
	if err != nil {
		return nil, err
	}
	if pid > 0 && !b.startedWith(command) {
		m.mu.Lock()
		m.everydayChromeQuitAsked = true
		m.mu.Unlock()
		return nil, fmt.Errorf("%s: %w", everydayChromeQuit, errNotSent)
	}
	restored := false
	if pid == 0 {
		// After the user quit Chrome for the Computer, it reopens their
		// windows and tabs, as the question to quit promised.
		m.mu.Lock()
		restored, m.everydayChromeQuitAsked = m.everydayChromeQuitAsked, false
		m.mu.Unlock()
		args := append([]string{"-g", "-b", b.Bundle, "--args"}, b.Settings...)
		if restored {
			args = append(args, "--restore-last-session")
		}
		if output, err := agentChromeOpen(ctx, args); err != nil {
			return nil, fmt.Errorf("launch_app: %s: %w", strings.TrimSpace(string(output)), err)
		}
		if pid, err = c.waitEverydayChrome(ctx); err != nil {
			return nil, err
		}
	}
	windows, err := c.appWindows(ctx, pid)
	if err != nil {
		return nil, err
	}
	before := map[float64]bool{}
	for _, w := range windows {
		before[w.WindowID] = true
	}
	// Naming the profile Chrome last used keeps a profile picker, which
	// Chrome may show for a user with several profiles, from taking the
	// command instead of a window.
	open := []string{"-n", "-g", "-b", b.Bundle, "--args", "--profile-directory=" + everydayChromeProfile(), "--new-window", urls[0]}
	if output, err := agentChromeOpen(ctx, open); err != nil {
		return nil, fmt.Errorf("launch_app: %s: %w", strings.TrimSpace(string(output)), err)
	}
	// The Computer's window is a new window with one tab whose address bar
	// shows the site just opened. A window the user opens meanwhile, or one
	// Chrome restores late, fails that test, so it is never taken for it.
	var window listedWindow
	tabs := 0
	for deadline := time.Now().Add(agentSafariWindowWait); window.WindowID == 0; {
		windows, err := c.appWindows(ctx, pid)
		if err != nil {
			return nil, err
		}
		for _, w := range windows {
			if before[w.WindowID] || siteOf(c.windowAddress(ctx, b, pid, w.WindowID)) != site {
				continue
			}
			if n := c.agentChromeTabs(ctx, pid, w.WindowID); n == 1 {
				window, tabs = w, n
				break
			}
		}
		if window.WindowID != 0 {
			break
		}
		if time.Now().After(deadline) {
			return nil, errors.New("launch_app: the user's Chrome did not open a window for the Computer")
		}
		if err := sleepContext(ctx, 200*time.Millisecond); err != nil {
			return nil, err
		}
	}
	m.mu.Lock()
	m.sharedBrowserBundle, m.sharedBrowserPID, m.sharedBrowserWindow = b.Bundle, pid, window.WindowID
	m.mu.Unlock()
	c.op.mu.Lock()
	c.op.chromeTabs, c.op.chromePID, c.op.chromeWindow = tabs, pid, window.WindowID
	c.op.mu.Unlock()
	note := "This is the Computer's own window in the user's everyday Chrome, with the user's sign-ins; work only in this window, never in the user's other Chrome windows. It works while other windows cover it, but only on the desktop (Space) the user is on. The user's Chrome takes no keys from the Computer, because a key could reach the window the user is typing in: fill a field with set_value, press the page's own buttons, such as its search button, and go back through the page's links. Close a tab with the Close button of its tab; closing the window's last tab closes the window. If a site asks to sign in, ask the user to sign in once in this window."
	if restored {
		note = "Started the user's Chrome again with their windows and tabs. " + note
	}
	text := fmt.Sprintf("Opened %s in a new window of the user's Chrome (pid %d), window %q [window_id: %v]. The window has %d tab(s).\n%s", urls[0], pid, window.Title, window.WindowID, tabs, note)
	return json.Marshal(map[string]any{"content": []any{map[string]string{"type": "text", "text": text}},
		"structuredContent": map[string]any{"browser": b.Name, "pid": pid, "windows": []map[string]any{{"window_id": window.WindowID, "title": window.Title, "on_screen": window.IsOnScreen}}, "tabs": tabs, "note": note}})
}

// windowAddress returns the web address the address bar of window shows,
// with https:// added when the bar leaves out the scheme, or "" when the
// bar cannot be read.
func (c *cuaSession) windowAddress(ctx context.Context, b agentBrowser, pid int, window float64) string {
	read, err := c.client.request(ctx, "tools/call", map[string]any{"name": "get_window_state", "arguments": map[string]any{
		"pid": pid, "window_id": window, "tree_format": "elements", "include_screenshot": false, "max_elements": 3000, "timeout_ms": 4000, "session": c.label}})
	if err != nil {
		return ""
	}
	var state struct {
		Structured struct {
			Elements []struct {
				Role  string `json:"role"`
				Label string `json:"label"`
				Value any    `json:"value"`
			} `json:"elements"`
		} `json:"structuredContent"`
	}
	_ = json.Unmarshal(read, &state)
	for _, element := range state.Structured.Elements {
		value, ok := element.Value.(string)
		if !ok || element.Role != b.AddressRole || element.Label != b.AddressLabel {
			continue
		}
		if !strings.Contains(value, "://") {
			value = "https://" + value
		}
		return value
	}
	return ""
}

// waitEverydayChrome waits until the user's Chrome that just started runs
// and shows a window, and returns its pid.
func (c *cuaSession) waitEverydayChrome(ctx context.Context) (int, error) {
	for deadline := time.Now().Add(agentSafariWindowWait); ; {
		pid, _, err := everydayChromePID(ctx)
		if err != nil {
			return 0, err
		}
		if pid > 0 {
			if windows, err := c.appWindows(ctx, pid); err != nil {
				return 0, err
			} else if len(windows) > 0 {
				return pid, nil
			}
		}
		if time.Now().After(deadline) {
			return 0, errors.New("launch_app: the user's Chrome did not start")
		}
		if err := sleepContext(ctx, 200*time.Millisecond); err != nil {
			return 0, err
		}
	}
}

// userChrome reports whether pid is the user's everyday Chrome, whichever of
// its windows an input names: a key reaches the Chrome window that has the
// keyboard, not the one named. The pid the Computer opened its window in is
// known; any other pid is looked up, so the rule holds before the Computer
// opened a window too.
func (c *cuaSession) userChrome(ctx context.Context, pid any) (bool, error) {
	number, ok := pid.(float64)
	if !ok || runtime.GOOS != "darwin" {
		return false, nil
	}
	m := c.op.manager
	m.mu.Lock()
	shared := m.sharedBrowserBundle == "com.google.Chrome" && m.sharedBrowserPID > 0 && int(number) == m.sharedBrowserPID
	m.mu.Unlock()
	if shared {
		return true, nil
	}
	running, _, err := everydayChromePID(ctx)
	if err != nil {
		return false, fmt.Errorf("COMPUTER_INPUT_NOT_SENT: could not tell whether the input goes to the user's Chrome: %w: %w", err, errNotSent)
	}
	return running > 0 && running == int(number), nil
}

// everydayChromeKeysRefused tells the Agent how to work without keys in the
// user's everyday Chrome.
const everydayChromeKeysRefused = "COMPUTER_KEYS_REFUSED: the user's everyday Chrome takes no keys from the Computer: a key or shortcut goes to the Chrome window that has the keyboard, which may be the one the user is typing in; nothing was sent. Fill a field with set_value, press the page's own buttons, such as its search button, and go back through the page's links"

// everydayChromeKeys refuses keys to the user's everyday Chrome. Only one
// plain key bound to an element, such as Return in a search box, may go:
// Cua delivers it only when no other Chrome window could receive it.
// Shortcuts are menu commands, which Chrome runs in the window that has the
// keyboard, and typed text arrives as keys that all read as the A key. own
// says the key names the Computer's window; one of the user's windows takes
// none. The script guard (keyed in guardedScript) applies the same rule.
func everydayChromeKeys(name string, arguments map[string]any, own bool) error {
	if name != "hotkey" && name != "type_text" && name != "press_key" {
		return nil
	}
	_, bound := arguments["element_token"].(string)
	_, modified := arguments["modifiers"]
	key, plain := arguments["key"].(string)
	if own && name == "press_key" && bound && !modified && plain && !strings.Contains(key, "+") {
		return nil
	}
	return fmt.Errorf("%s: %w", everydayChromeKeysRefused, errNotSent)
}

// everydayChromeData is the user's Chrome data folder, whose Local State
// names the profile Chrome last used.
var everydayChromeData = func() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "Application Support", "Google", "Chrome")
}

// everydayChromeProfile returns the folder name of the profile the user's
// Chrome last used, or Default when Local State does not say.
func everydayChromeProfile() string {
	var state struct {
		Profile struct {
			LastUsed string `json:"last_used"`
		} `json:"profile"`
	}
	data, err := os.ReadFile(filepath.Join(everydayChromeData(), "Local State"))
	if err == nil && json.Unmarshal(data, &state) == nil && chromeProfilePattern.MatchString(state.Profile.LastUsed) {
		return state.Profile.LastUsed
	}
	return "Default"
}
