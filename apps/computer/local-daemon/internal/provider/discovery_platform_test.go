package provider

import (
	"path/filepath"
	"runtime"
	"slices"
	"testing"
)

func TestExecutableCandidatesSearchTheDefaultInstallFolders(t *testing.T) {
	home, bin := t.TempDir(), t.TempDir()
	environment := map[string]string{"PATH": bin + string(filepath.ListSeparator) + "relative", "HOME": home, "USERPROFILE": home}
	if runtime.GOOS == "windows" {
		environment["APPDATA"] = filepath.Join(home, "AppData", "Roaming")
	}
	candidates := ExecutableCandidates("lark-cli", environment)
	want := []string{filepath.Join(bin, "lark-cli"), filepath.Join(home, ".local", "bin", "lark-cli")}
	if runtime.GOOS == "windows" {
		// A Daemon started before Node was installed has no PATH entry for
		// npm's global folder, where lark-cli.cmd lands.
		want = []string{filepath.Join(bin, "lark-cli.cmd"), filepath.Join(home, "AppData", "Roaming", "npm", "lark-cli.cmd")}
	}
	for _, path := range want {
		if !slices.Contains(candidates, path) {
			t.Errorf("candidates %v miss %s", candidates, path)
		}
	}
	for _, path := range candidates {
		if !filepath.IsAbs(path) {
			t.Errorf("relative PATH entry searched: %s", path)
		}
	}
}
