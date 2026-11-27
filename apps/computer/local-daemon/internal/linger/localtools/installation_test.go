package localtools

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestInstalledToolsRejectCorruptOrRedirectedAssets(t *testing.T) {
	root := t.TempDir()
	toolRoot := filepath.Join(root, "cli", "computer-tools")
	entries := append([]string{"node_modules/@playwright/mcp/cli.js", "extensions/pi-mcp.mjs", "bin/pi"}, quickJSAssets...)
	assets := []map[string]any{}
	for _, name := range entries {
		p := filepath.Join(toolRoot, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		body := []byte("fixture")
		if err := os.WriteFile(p, body, 0o600); err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(body)
		assets = append(assets, map[string]any{"path": name, "size_bytes": len(body), "sha256": hex.EncodeToString(sum[:])})
	}
	node := filepath.Join(root, "runtime", "bin", "node")
	_ = os.MkdirAll(filepath.Dir(node), 0o700)
	_ = os.WriteFile(node, []byte("fixture"), 0o700)
	manifest := map[string]any{"schema_version": 1, "versions": map[string]string{"playwright": "0.0.83", "pi": "1.5.2", "cua": "0.35.4", "quickjs": "3.6.2"}, "playwright_entry": entries[0], "pi_extension": entries[1], "pi_entry": entries[2], "assets": assets}
	write := func() {
		t.Helper()
		data, _ := json.Marshal(manifest)
		if err := os.WriteFile(filepath.Join(toolRoot, "manifest.json"), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write()
	executable := filepath.Join(root, "daemon", "linger-computer-daemon")
	resolvedTools, err := filepath.EvalSymlinks(toolRoot)
	if err != nil {
		t.Fatal(err)
	}
	result, err := Installed(executable)
	if err != nil || result == nil || result.NodePath != node || result.PiEntry != filepath.Join(resolvedTools, "bin", "pi") || result.PiVersion != "1.5.2" {
		t.Fatalf("valid installation: %+v %v", result, err)
	}
	manifest["pi_entry"] = ""
	write()
	if _, err := Installed(executable); err == nil {
		t.Fatal("missing pi_entry accepted")
	}
	manifest["pi_entry"] = "bin/pi.exe"
	write()
	if _, err := Installed(executable); err == nil {
		t.Fatal("wrong-target pi_entry accepted")
	}
	manifest["pi_entry"] = entries[2]
	write()
	asset := filepath.Join(toolRoot, entries[0])
	_ = os.WriteFile(asset, []byte("truncated or replaced"), 0o600)
	if _, err := Installed(executable); err == nil {
		t.Fatal("corrupt tool accepted")
	}
	_ = os.Remove(asset)
	if err := os.Symlink(node, asset); err == nil {
		if _, err := Installed(executable); err == nil {
			t.Fatal("redirected tool accepted")
		}
		_ = os.Remove(asset)
	}
	_ = os.WriteFile(asset, []byte("fixture"), 0o600)
	extra := filepath.Join(toolRoot, "node_modules", "unexpected.js")
	_ = os.WriteFile(extra, []byte("unlisted"), 0o600)
	if _, err := Installed(executable); err == nil || !strings.HasSuffix(err.Error(), ": node_modules/unexpected.js") {
		t.Fatalf("unlisted tool asset: %v", err)
	}
	_ = os.Remove(extra)
	assets[0]["path"] = "../escape"
	write()
	if _, err := Installed(executable); err == nil {
		t.Fatal("asset escaped its release directory")
	}
}

// File managers write metadata such as Finder's .DS_Store into any directory a
// user opens; only those regular files are tolerated beside the manifest.
func TestInstalledToolsIgnoreFileManagerMetadata(t *testing.T) {
	root := t.TempDir()
	tools := filepath.Join(root, "cli", "computer-tools")
	executable := filepath.Join(root, "daemon", "linger-computer-daemon")
	node := filepath.Join(root, "runtime", "bin", "node")
	if runtime.GOOS == "windows" {
		executable += ".exe"
		node += ".exe"
	}
	piBin := piEntry(executable)
	entries := append([]string{"node_modules/@playwright/mcp/cli.js", "extensions/pi-mcp.mjs", piBin}, quickJSAssets...)
	assets := make([]map[string]any, 0, len(entries))
	for _, name := range entries {
		file := filepath.Join(tools, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte("fixture"), 0o600); err != nil {
			t.Fatal(err)
		}
		assets = append(assets, map[string]any{"path": name, "size_bytes": 7})
	}
	manifest, err := json.Marshal(map[string]any{"schema_version": 1, "versions": map[string]string{"playwright": "0.0.83", "pi": "1.5.2", "cua": "0.35.4", "quickjs": "3.6.2"}, "playwright_entry": entries[0], "pi_extension": entries[1], "pi_entry": piBin, "assets": assets})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tools, "manifest.json"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(node), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(node, []byte("fixture"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{".DS_Store", "node_modules/.DS_Store", "extensions/._pi-mcp.mjs", "Thumbs.db", "node_modules/@playwright/Desktop.ini"} {
		if err := os.WriteFile(filepath.Join(tools, filepath.FromSlash(name)), []byte("metadata"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if result, err := Installed(executable); err != nil || result == nil {
		t.Fatalf("installation with file manager metadata: %+v %v", result, err)
	}
	for _, name := range []string{"node_modules/._", "extensions/DS_Store"} {
		extra := filepath.Join(tools, filepath.FromSlash(name))
		if err := os.WriteFile(extra, []byte("unlisted"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := Installed(executable); err == nil || !strings.HasSuffix(err.Error(), ": "+name) {
			t.Fatalf("unlisted %s: %v", name, err)
		}
		_ = os.Remove(extra)
	}
	link := filepath.Join(tools, "extensions", ".DS_Store")
	if err := os.Symlink(node, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := Installed(executable); err == nil || !strings.HasSuffix(err.Error(), ": extensions/.DS_Store") {
		t.Fatalf("linked .DS_Store: %v", err)
	}
}

// The installer links the bundle's runtime and cli/computer-tools to its
// deps-<sha16> directory; those links are the installed layout, not redirects.
func TestInstalledToolsFollowTheBundleDepsLinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the Windows installer extracts dependencies into the bundle")
	}
	root := t.TempDir()
	deps := filepath.Join(root, "deps-0123456789abcdef")
	bundle := filepath.Join(root, "lib-fedcba9876543210-1")
	entries := append([]string{"node_modules/@playwright/mcp/cli.js", "extensions/pi-mcp.mjs", "bin/pi"}, quickJSAssets...)
	assets := []map[string]any{}
	for _, name := range entries {
		p := filepath.Join(deps, "computer-tools", name)
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("fixture"), 0o600); err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256([]byte("fixture"))
		assets = append(assets, map[string]any{"path": name, "size_bytes": 7, "sha256": hex.EncodeToString(sum[:])})
	}
	data, _ := json.Marshal(map[string]any{"schema_version": 1, "versions": map[string]string{"playwright": "0.0.83", "pi": "1.5.2", "cua": "0.35.4", "quickjs": "3.6.2"}, "playwright_entry": entries[0], "pi_extension": entries[1], "pi_entry": entries[2], "assets": assets})
	if err := os.WriteFile(filepath.Join(deps, "computer-tools", "manifest.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	node := filepath.Join(deps, "runtime", "bin", "node")
	if err := os.MkdirAll(filepath.Dir(node), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(node, []byte("fixture"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(bundle, "cli"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../deps-0123456789abcdef/runtime", filepath.Join(bundle, "runtime")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../../deps-0123456789abcdef/computer-tools", filepath.Join(bundle, "cli", "computer-tools")); err != nil {
		t.Fatal(err)
	}
	result, err := Installed(filepath.Join(bundle, "daemon", "linger-computer-daemon"))
	if err != nil || result == nil {
		t.Fatalf("linked installation: %+v %v", result, err)
	}
}

func TestWindowsInstalledToolsUseExtractedBundle(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows bundle layout")
	}
	root := t.TempDir()
	tools := filepath.Join(root, "cli", "computer-tools")
	entries := append([]string{"node_modules/@playwright/mcp/cli.js", "extensions/pi-mcp.mjs", "bin/pi.exe"}, quickJSAssets...)
	assets := make([]map[string]any, 0, len(entries))
	for _, name := range entries {
		file := filepath.Join(tools, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte("fixture"), 0o600); err != nil {
			t.Fatal(err)
		}
		assets = append(assets, map[string]any{"path": name, "size_bytes": 7})
	}
	manifest, err := json.Marshal(map[string]any{"schema_version": 1, "versions": map[string]string{"playwright": "0.0.83", "pi": "1.5.2", "cua": "0.35.4", "quickjs": "3.6.2"}, "playwright_entry": entries[0], "pi_extension": entries[1], "pi_entry": entries[2], "assets": assets})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tools, "manifest.json"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	node := filepath.Join(root, "runtime", "bin", "node.exe")
	if err := os.MkdirAll(filepath.Dir(node), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(node, []byte("fixture"), 0o700); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(root, "daemon", "linger-computer-daemon.exe")
	result, err := Installed(executable)
	if err != nil || result == nil || result.NodePath != node || result.PiEntry != filepath.Join(tools, "bin", "pi.exe") || result.PiVersion != "1.5.2" {
		t.Fatalf("extracted installation: %+v %v", result, err)
	}
	if err := os.WriteFile(filepath.Join(tools, "unexpected.js"), []byte("unlisted"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Installed(executable); err == nil {
		t.Fatal("unlisted tool asset accepted")
	}
}

// The Desktop app runs the daemon from resources/computer/ and packages the
// tools as resources/cli/computer-tools and resources/runtime.
func TestInstalledToolsInTheDesktopLayout(t *testing.T) {
	// Installed resolves symlinks, and on macOS the temporary directory sits
	// behind the /var symlink.
	resources, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(resources, "computer", "linger-computer-daemon")
	if got := ToolsDirectory(executable); got != filepath.Join(resources, "cli", "computer-tools") {
		t.Fatalf("tools directory = %s", got)
	}
	if result, err := Installed(executable); result != nil || err != nil {
		t.Fatalf("desktop without tools: %+v %v", result, err)
	}
	tools := ToolsDirectory(executable)
	entries := append([]string{"node_modules/@playwright/mcp/cli.js", "extensions/pi-mcp.mjs", "bin/pi"}, quickJSAssets...)
	assets := make([]map[string]any, 0, len(entries))
	for _, name := range entries {
		file := filepath.Join(tools, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte("fixture"), 0o600); err != nil {
			t.Fatal(err)
		}
		assets = append(assets, map[string]any{"path": name, "size_bytes": 7})
	}
	manifest, err := json.Marshal(map[string]any{"schema_version": 1, "versions": map[string]string{"playwright": "0.0.83", "pi": "1.5.2", "cua": "0.35.4", "quickjs": "3.6.2"}, "playwright_entry": entries[0], "pi_extension": entries[1], "pi_entry": entries[2], "assets": assets})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tools, "manifest.json"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	node := filepath.Join(resources, "runtime", "bin", "node")
	if err := os.MkdirAll(filepath.Dir(node), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(node, []byte("fixture"), 0o700); err != nil {
		t.Fatal(err)
	}
	result, err := Installed(executable)
	if err != nil || result == nil || result.NodePath != node || result.PlaywrightEntry != filepath.Join(tools, filepath.FromSlash(entries[0])) || result.PiEntry != filepath.Join(tools, "bin", "pi") || result.PiVersion != "1.5.2" {
		t.Fatalf("desktop installation: %+v %v", result, err)
	}
}

func TestInstalledToolsDetectsBundledWindowsPowerShell(t *testing.T) {
	resources, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	stageFixture := func(daemonName, piName, nodeName string) string {
		tools := filepath.Join(resources, daemonName+"-root", "cli", "computer-tools")
		entries := append([]string{"node_modules/@playwright/mcp/cli.js", "extensions/pi-mcp.mjs", piName}, quickJSAssets...)
		assets := make([]map[string]any, 0, len(entries))
		for _, name := range entries {
			file := filepath.Join(tools, filepath.FromSlash(name))
			if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(file, []byte("fixture"), 0o600); err != nil {
				t.Fatal(err)
			}
			assets = append(assets, map[string]any{"path": name, "size_bytes": 7})
		}
		manifest, err := json.Marshal(map[string]any{
			"schema_version":   1,
			"versions":         map[string]string{"playwright": "0.0.83", "pi": "1.5.2", "cua": "0.35.4", "quickjs": "3.6.2"},
			"playwright_entry": entries[0], "pi_extension": entries[1], "pi_entry": entries[2], "assets": assets,
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(tools, "manifest.json"), manifest, 0o600); err != nil {
			t.Fatal(err)
		}
		node := filepath.Join(resources, daemonName+"-root", "runtime", "bin", nodeName)
		if err := os.MkdirAll(filepath.Dir(node), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(node, []byte("fixture"), 0o700); err != nil {
			t.Fatal(err)
		}
		return filepath.Join(resources, daemonName+"-root", "computer", daemonName)
	}

	winExecutable := stageFixture("linger-computer-daemon.exe", "bin/pi.exe", "node.exe")
	result, err := Installed(winExecutable)
	if err != nil || result == nil || result.PowerShellPath != "" {
		t.Fatalf("without bundled pwsh = %+v, err=%v", result, err)
	}
	pwsh := filepath.Join(filepath.Dir(filepath.Dir(winExecutable)), "runtime", "pwsh", "pwsh.exe")
	if err := os.MkdirAll(filepath.Dir(pwsh), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pwsh, []byte("MZ"), 0o700); err != nil {
		t.Fatal(err)
	}
	result, err = Installed(winExecutable)
	if err != nil || result == nil || result.PowerShellPath != pwsh {
		t.Fatalf("with bundled pwsh = %+v, want %q, err=%v", result, pwsh, err)
	}

	posixExecutable := stageFixture("linger-computer-daemon", "bin/pi", "node")
	posixPwsh := filepath.Join(filepath.Dir(filepath.Dir(posixExecutable)), "runtime", "pwsh", "pwsh.exe")
	if err := os.MkdirAll(filepath.Dir(posixPwsh), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(posixPwsh, []byte("MZ"), 0o700); err != nil {
		t.Fatal(err)
	}
	result, err = Installed(posixExecutable)
	if err != nil || result == nil || result.PowerShellPath != "" {
		t.Fatalf("non-Windows daemon unexpectedly set PowerShellPath: %+v, err=%v", result, err)
	}
}
