package computercli

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestBundledRuntimePathsForExecutableResolvesCLIInstallation(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	cli := filepath.Join(root, "cli", "linger-computer"+ext)
	node := filepath.Join(root, "runtime", "bin", "node"+ext)
	tools := filepath.Join(root, "cli", "computer-tools")
	piRel := "bin/pi" + ext
	entries := []string{
		"node_modules/@playwright/mcp/cli.js",
		"extensions/pi-mcp.mjs",
		piRel,
		"node_modules/quickjs-wasi/quickjs.wasm",
		"node_modules/quickjs-wasi/dist/index.js",
	}
	assets := make([]map[string]any, 0, len(entries))
	for _, rel := range entries {
		file := filepath.Join(tools, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte("fixture"), 0o700); err != nil {
			t.Fatal(err)
		}
		assets = append(assets, map[string]any{"path": rel, "size_bytes": 7})
	}
	manifest, err := json.Marshal(map[string]any{
		"schema_version":   1,
		"versions":         map[string]string{"playwright": "0.0.83", "pi": "1.5.2", "cua": "0.35.4", "quickjs": "3.6.2"},
		"playwright_entry": entries[0],
		"pi_extension":     entries[1],
		"pi_entry":         piRel,
		"assets":           assets,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tools, "manifest.json"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{cli, node} {
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte("fixture"), 0o700); err != nil {
			t.Fatal(err)
		}
	}

	got := bundledRuntimePathsForExecutable(cli)
	want := filepath.Join(tools, filepath.FromSlash(piRel))
	if got["pi"] != want {
		t.Fatalf("bundledRuntimePathsForExecutable(%q) = %v, want pi=%q", cli, got, want)
	}
}

func TestDiagnoseRuntimesDiscoversBundledPiWhenMissingFromPATH(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell script")
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	emptyPath := filepath.Join(root, "empty-path")
	home := filepath.Join(root, "home")
	bundledDir := filepath.Join(root, "bundled-bin")
	for _, dir := range []string{emptyPath, home, bundledDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	bundledPi := filepath.Join(bundledDir, "pi")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then echo '1.5.2'; exit 0; fi
if [ "$1" = "auth" ]; then echo '{"status":"not_ready"}'; exit 1; fi
while IFS= read -r line; do
  case "$line" in
    *linger-probe*) echo '{"type":"response","id":"linger-probe","command":"get_state","success":true,"data":{"isStreaming":false}}' ;;
    *linger-state*) echo '{"type":"response","id":"linger-state","command":"get_state","success":true,"data":{"model":null,"thinkingLevel":"off"}}' ;;
    *linger-models*) echo '{"type":"response","id":"linger-models","command":"get_available_models","success":true,"data":{"models":[]}}' ;;
  esac
done
`
	if err := os.WriteFile(bundledPi, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}

	previous := resolveBundledRuntimePaths
	t.Cleanup(func() { resolveBundledRuntimePaths = previous })
	resolveBundledRuntimePaths = func() map[string]string {
		return map[string]string{"pi": bundledPi}
	}

	diagnostics, err := diagnoseRuntimes(
		context.Background(),
		runtimeRequest{
			environment: map[string]string{
				"PATH":  emptyPath,
				"HOME":  home,
				"SHELL": filepath.Join(root, "no-shell"),
			},
		},
		[]string{"pi"},
	)
	if err != nil {
		t.Fatalf("diagnoseRuntimes failed: %v", err)
	}
	if len(diagnostics) != 1 {
		t.Fatalf("diagnostics = %+v, want 1 entry", diagnostics)
	}
	got := diagnostics[0]
	if got.Type != "pi" || !got.Available || got.Version != "1.5.2" || got.ExecutablePath != bundledPi || got.EntryPath != bundledPi {
		t.Fatalf("bundled Pi diagnostic = %+v, want available pi 1.5.2 at %q", got, bundledPi)
	}
}
