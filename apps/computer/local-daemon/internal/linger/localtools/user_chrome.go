package localtools

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// childEnvironmentKeys are the only variables browser and desktop children
// inherit. Windows needs its folder variables: Playwright locates chrome.exe
// and Node resolves system paths through them.
var childEnvironmentKeys = []string{"HOME", "USER", "PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ", "XDG_RUNTIME_DIR",
	"DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_SESSION_TYPE",
	"USERPROFILE", "USERNAME", "LOCALAPPDATA", "APPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "PROGRAMDATA",
	"SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "HOMEDRIVE", "HOMEPATH"}

func childEnvironment(source map[string]string) []string {
	var result []string
	for _, key := range childEnvironmentKeys {
		for name, value := range source {
			// Windows variable names are case-insensitive: ProgramFiles, Path.
			if value != "" && (name == key || (runtime.GOOS == "windows" && strings.EqualFold(name, key))) {
				result = append(result, name+"="+value)
				break
			}
		}
	}
	return result
}

func environmentValue(env []string, key string) string {
	for _, entry := range env {
		name, value, _ := strings.Cut(entry, "=")
		if name == key || (runtime.GOOS == "windows" && strings.EqualFold(name, key)) {
			return value
		}
	}
	return ""
}

// chromeExecutable returns the installed Google Chrome. The Agent profile and
// the extension connection both use it; neither downloads a browser.
func chromeExecutable(env []string) string {
	chrome, _ := BrowserCandidates(runtime.GOOS, env)
	return firstFile(chrome)
}

// managedBrowserExecutable returns the browser the Agent profile runs in:
// Google Chrome, or on macOS and Windows Microsoft Edge when Chrome is not
// installed. Edge is Chromium, so it takes the same flags and CDP.
func managedBrowserExecutable(env []string) string {
	if chrome := chromeExecutable(env); chrome != "" {
		return chrome
	}
	return edgeExecutable(env)
}

// edgeExecutable returns the installed Microsoft Edge on macOS and Windows.
func edgeExecutable(env []string) string {
	_, edge := BrowserCandidates(runtime.GOOS, env)
	return firstFile(edge)
}

// BrowserCandidates returns, in lookup order, where Google Chrome and
// Microsoft Edge may be installed on goos. Edge has no Linux candidates
// because the Agent profile falls back to it only on macOS and Windows.
// doctor and the browser launch share these lists so they agree on whether
// a browser is installed.
func BrowserCandidates(goos string, env []string) (chrome, edge []string) {
	switch goos {
	case "linux":
		// Snap Chromium comes before /usr/bin/chromium-browser, which on Ubuntu
		// is a script that runs it, so its confined profile folder is chosen.
		chrome = []string{"/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome", "/snap/bin/chromium", "/usr/bin/chromium", "/usr/bin/chromium-browser"}
		for _, folder := range filepath.SplitList(environmentValue(env, "PATH")) {
			for _, name := range []string{"google-chrome-stable", "google-chrome", "chromium", "chromium-browser"} {
				if filepath.IsAbs(folder) {
					chrome = append(chrome, filepath.Join(folder, name))
				}
			}
		}
	case "darwin":
		chrome = []string{"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
		edge = []string{"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"}
		if home := environmentValue(env, "HOME"); home != "" {
			chrome = append(chrome, filepath.Join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"))
			edge = append(edge, filepath.Join(home, "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"))
		}
	case "windows":
		for _, root := range []string{"LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432"} {
			if base := environmentValue(env, root); base != "" {
				chrome = append(chrome, filepath.Join(base, "Google", "Chrome", "Application", "chrome.exe"))
			}
		}
		for _, root := range []string{"PROGRAMFILES(X86)", "PROGRAMFILES", "PROGRAMW6432", "LOCALAPPDATA"} {
			if base := environmentValue(env, root); base != "" {
				edge = append(edge, filepath.Join(base, "Microsoft", "Edge", "Application", "msedge.exe"))
			}
		}
	}
	return chrome, edge
}

func firstFile(candidates []string) string {
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
			return candidate
		}
	}
	return ""
}

func chromeUserDataDirectory(env []string) string {
	switch runtime.GOOS {
	case "darwin":
		if home := environmentValue(env, "HOME"); home != "" {
			return filepath.Join(home, "Library", "Application Support", "Google", "Chrome")
		}
	case "windows":
		if local := environmentValue(env, "LOCALAPPDATA"); local != "" {
			return filepath.Join(local, "Google", "Chrome", "User Data")
		}
	}
	return ""
}

type userChromeInstall struct{ executable, profile string }

// manyClientsExtension is the first Playwright Extension version that keeps
// several Playwright clients connected at once, each in its own tab group.
// An earlier version may drop one client when the next connects.
var manyClientsExtension = [3]int{0, 5, 0}

// extensionTakesManyClients reports whether every installed version of the
// Playwright Extension in profile is at least manyClientsExtension. Chrome may
// keep an old version folder until it restarts, so any older or unreadable
// folder counts against it.
func extensionTakesManyClients(env []string, profile string) bool {
	data := chromeUserDataDirectory(env)
	if data == "" {
		return false
	}
	entries, err := os.ReadDir(filepath.Join(data, profile, "Extensions", playwrightExtensionID))
	if err != nil {
		return false
	}
	found := false
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		version, _, _ := strings.Cut(entry.Name(), "_")
		if !versionAtLeast(version, manyClientsExtension) {
			return false
		}
		found = true
	}
	return found
}

func versionAtLeast(version string, minimum [3]int) bool {
	parts := strings.Split(version, ".")
	for i, want := range minimum {
		got := 0
		if i < len(parts) {
			var err error
			if got, err = strconv.Atoi(parts[i]); err != nil {
				return false
			}
		}
		if got != want {
			return got > want
		}
	}
	return true
}

// extensionFileAccessOff reports whether the preferences in the Chrome
// profile directory show the Playwright Extension without file access. Chrome
// rejects the extension's DOM.setFileInputFiles without it, and only the user
// can turn it on. Chrome keeps the switch, off by default, in Secure
// Preferences or Preferences. Unreadable preferences report false so that
// Chrome decides.
func extensionFileAccessOff(profileDirectory string) bool {
	read := false
	for _, name := range []string{"Secure Preferences", "Preferences"} {
		encoded, err := os.ReadFile(filepath.Join(profileDirectory, name))
		if err != nil {
			continue
		}
		var prefs struct {
			Extensions struct {
				Settings map[string]struct {
					AllowFileAccess *bool `json:"newAllowFileAccess"`
				} `json:"settings"`
			} `json:"extensions"`
		}
		if json.Unmarshal(encoded, &prefs) != nil {
			continue
		}
		read = true
		if setting := prefs.Extensions.Settings[playwrightExtensionID].AllowFileAccess; setting != nil && *setting {
			return false
		}
	}
	return read
}

// userChromeSeat names what one task holds in the owner's everyday Chrome:
// its Agent's own tabs when the extension keeps several clients, or else the
// whole profile. Tasks of one seat take turns; seats of one profile do not.
func userChromeSeat(env []string, profile, agentID string) string {
	if extensionTakesManyClients(env, profile) {
		return profile + "\x00" + agentID
	}
	return profile
}

// findUserChrome resolves the Chrome profile with the Playwright Extension.
// The extension token belongs to one profile; Chrome opens the connect page
// in exactly that profile.
func findUserChrome(env []string, requested string) (userChromeInstall, error) {
	executable := chromeExecutable(env)
	if executable == "" {
		return userChromeInstall{}, &BrowserCommandError{"BROWSER_UNAVAILABLE", "install Google Chrome to connect the everyday browser", false}
	}
	data := chromeUserDataDirectory(env)
	installed := func(profile string) bool {
		info, err := os.Stat(filepath.Join(data, profile, "Extensions", playwrightExtensionID))
		return err == nil && info.IsDir()
	}
	if requested != "" {
		if !installed(requested) {
			return userChromeInstall{}, &BrowserCommandError{"BROWSER_EXTENSION_UNAVAILABLE", "install the Playwright Extension in the Chrome profile " + requested, false}
		}
		return userChromeInstall{executable, requested}, nil
	}
	var state struct {
		Profile struct {
			LastUsed string `json:"last_used"`
		} `json:"profile"`
	}
	if encoded, err := os.ReadFile(filepath.Join(data, "Local State")); err == nil {
		_ = json.Unmarshal(encoded, &state)
	}
	candidates := []string{state.Profile.LastUsed, "Default"}
	if entries, err := os.ReadDir(data); err == nil {
		for _, entry := range entries {
			candidates = append(candidates, entry.Name())
		}
	}
	for _, profile := range candidates {
		if chromeProfilePattern.MatchString(profile) && installed(profile) {
			return userChromeInstall{executable, profile}, nil
		}
	}
	return userChromeInstall{}, &BrowserCommandError{"BROWSER_EXTENSION_UNAVAILABLE", "install the Playwright Extension in Chrome, then copy its token", false}
}

// defaultBrowserNote names a non-Chromium default browser. Its sign-ins cannot
// be reused; browser tools keep the dedicated Agent Chrome.
func defaultBrowserNote(env []string) string {
	name := defaultBrowserName(env)
	if name == "" || name == "chrome" || name == "chromium" {
		return ""
	}
	return "The default browser (" + name + ") cannot be connected; Agents use their own Chrome, which does not have the user's sign-ins."
}

func defaultBrowserName(env []string) string {
	switch runtime.GOOS {
	case "darwin":
		home := environmentValue(env, "HOME")
		if home == "" {
			return ""
		}
		output, err := exec.Command("/usr/bin/plutil", "-convert", "json", "-o", "-", filepath.Join(home, "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist")).Output()
		if err != nil {
			return ""
		}
		var handlers struct {
			LSHandlers []struct {
				Scheme string `json:"LSHandlerURLScheme"`
				Role   string `json:"LSHandlerRoleAll"`
			} `json:"LSHandlers"`
		}
		if json.Unmarshal(output, &handlers) != nil {
			return ""
		}
		for _, handler := range handlers.LSHandlers {
			if handler.Scheme == "https" {
				return browserFamily(handler.Role)
			}
		}
	case "windows":
		return browserFamily(windowsDefaultBrowserProgID())
	}
	return ""
}

func browserFamily(identifier string) string {
	value := strings.ToLower(identifier)
	switch {
	case value == "":
		return ""
	case strings.Contains(value, "chrome"):
		return "chrome"
	case strings.Contains(value, "chromium"):
		return "chromium"
	case strings.Contains(value, "safari"):
		return "Safari"
	case strings.Contains(value, "firefox"):
		return "Firefox"
	case strings.Contains(value, "edge"), strings.HasPrefix(value, "msedge"):
		return "Microsoft Edge"
	case strings.Contains(value, "brave"):
		return "Brave"
	case strings.Contains(value, "arc"):
		return "Arc"
	}
	return identifier
}
