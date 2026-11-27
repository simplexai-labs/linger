package localtools

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// quickJSAssets are the engine files the UI runtime loads directly. The
// bundler owns the engine's complete file list.
var quickJSAssets = []string{
	"node_modules/quickjs-wasi/quickjs.wasm",
	"node_modules/quickjs-wasi/dist/index.js",
}

type Installation struct {
	NodePath, PlaywrightEntry, PiExtension, PiEntry, PiVersion, CuaPath string
	// PowerShellPath holds the bundled PowerShell 7 executable on Windows when
	// present under resources/runtime/pwsh/pwsh.exe.
	PowerShellPath string
}

func cuaEntry(executable string) string {
	if strings.HasSuffix(executable, ".exe") {
		return "cua/cua-driver.exe"
	}
	return "cua/cua-driver"
}

func piEntry(executable string) string {
	if strings.HasSuffix(executable, ".exe") {
		return "bin/pi.exe"
	}
	return "bin/pi"
}

// osMetadataFile reports a file that a file manager writes into any directory it
// opens, such as Finder's .DS_Store. It names no tool, so it is not an asset.
func osMetadataFile(name string) bool {
	return (strings.HasPrefix(name, "._") && len(name) > 2) || strings.EqualFold(name, ".DS_Store") || strings.EqualFold(name, "Thumbs.db") || strings.EqualFold(name, "desktop.ini")
}

// ToolsDirectory is where Installed looks for the tools: cli/computer-tools
// two folders above the executable. The Desktop app's daemon runs from
// resources/computer/, so its tools are resources/cli/computer-tools.
func ToolsDirectory(executable string) string {
	return filepath.Join(filepath.Dir(filepath.Dir(executable)), "cli", "computer-tools")
}

// Installed resolves only sibling release assets and verifies their frozen
// manifest. An unbundled development daemon has no implicit PATH fallback.
func Installed(executable string) (*Installation, error) {
	root := filepath.Dir(filepath.Dir(executable))
	// An installed bundle links cli/computer-tools to its verified deps
	// directory; the checks below apply to the files it points at.
	tools, err := filepath.EvalSymlinks(ToolsDirectory(executable))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(tools, "manifest.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var manifest struct {
		Version    int                                           `json:"schema_version"`
		Versions   struct{ Playwright, Pi, Cua, QuickJS string } `json:"versions"`
		Playwright string                                        `json:"playwright_entry"`
		Pi         string                                        `json:"pi_extension"`
		PiEntry    string                                        `json:"pi_entry"`
		Cua        string                                        `json:"cua_entry"`
		Assets     []struct {
			Path string `json:"path"`
			Size int64  `json:"size_bytes"`
		} `json:"assets"`
	}
	if json.Unmarshal(data, &manifest) != nil || manifest.Version != 1 || manifest.Versions.Playwright != "0.0.83" || manifest.Versions.Pi != "1.5.2" || manifest.Versions.Cua != "0.35.4" || manifest.Versions.QuickJS != "3.6.2" || manifest.Playwright != "node_modules/@playwright/mcp/cli.js" || manifest.Pi != "extensions/pi-mcp.mjs" || manifest.PiEntry != piEntry(executable) || (manifest.Cua != "" && manifest.Cua != cuaEntry(executable)) {
		return nil, errors.New("managed Computer tool manifest is invalid")
	}
	seen := map[string]bool{}
	for _, asset := range manifest.Assets {
		if asset.Path == "" || strings.Contains(asset.Path, "\\") || filepath.IsAbs(asset.Path) || filepath.ToSlash(filepath.Clean(asset.Path)) != asset.Path || strings.HasPrefix(asset.Path, "../") || seen[asset.Path] {
			return nil, errors.New("managed Computer tool asset path is invalid")
		}
		seen[asset.Path] = true
		path := filepath.Join(tools, filepath.FromSlash(asset.Path))
		// Release assets are files, not links to another installation.
		for current := path; current != tools; current = filepath.Dir(current) {
			info, e := os.Lstat(current)
			if e != nil || info.Mode()&os.ModeSymlink != 0 {
				return nil, errors.New("managed Computer tool asset is unavailable")
			}
		}
		// The installer verified every asset digest. Reading thousands of
		// files here made antivirus scan each one before the control socket
		// opened, so first setup on Windows outlasted the start timeout.
		info, e := os.Lstat(path)
		if e != nil || !info.Mode().IsRegular() || info.Size() != asset.Size {
			return nil, errors.New("managed Computer tool asset size mismatch")
		}
	}
	for _, entry := range append([]string{manifest.Playwright, manifest.Pi, manifest.PiEntry}, quickJSAssets...) {
		if !seen[entry] {
			return nil, errors.New("managed Computer tool entrypoint is missing")
		}
	}
	if err := filepath.WalkDir(tools, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(tools, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if entry.Type().IsRegular() && (seen[relative] || relative == "manifest.json" || osMetadataFile(entry.Name())) {
			return nil
		}
		return fmt.Errorf("managed Computer tools contain an unlisted asset: %s", relative)
	}); err != nil {
		return nil, err
	}
	node := filepath.Join(root, "runtime", "bin", "node")
	if strings.HasSuffix(executable, ".exe") {
		node += ".exe"
	}
	if info, e := os.Stat(node); e != nil || !info.Mode().IsRegular() {
		return nil, errors.New("managed Computer tools require the bundled Node runtime")
	}
	installed := &Installation{
		NodePath:        node,
		PlaywrightEntry: filepath.Join(tools, filepath.FromSlash(manifest.Playwright)),
		PiExtension:     filepath.Join(tools, filepath.FromSlash(manifest.Pi)),
		PiEntry:         filepath.Join(tools, filepath.FromSlash(manifest.PiEntry)),
		PiVersion:       manifest.Versions.Pi,
	}
	if strings.HasSuffix(strings.ToLower(executable), ".exe") {
		pwsh := filepath.Join(root, "runtime", "pwsh", "pwsh.exe")
		if info, e := os.Stat(pwsh); e == nil && info.Mode().IsRegular() {
			installed.PowerShellPath = pwsh
		}
	}
	if manifest.Cua != "" {
		// macOS drives the desktop through the signed application.
		if !seen[manifest.Cua] || (manifest.Cua == "cua/cua-driver" && !seen["cua/CuaDriver.app/Contents/MacOS/cua-driver"]) {
			return nil, errors.New("signed Cua application is missing")
		}
		installed.CuaPath = filepath.Join(tools, manifest.Cua)
	}
	return installed, nil
}
