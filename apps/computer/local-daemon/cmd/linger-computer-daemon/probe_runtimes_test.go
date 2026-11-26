package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestRunProbeRuntimesCCSwitchCodexAndClaude(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX script fixture")
	}
	home := t.TempDir()
	binDir := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		t.Fatal(err)
	}

	// CC Switch Codex: custom provider with requires_openai_auth = false + stale auth.json.
	codexDir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(codexDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(codexDir, "config.toml"), []byte(
		"model_provider = \"ccswitch\"\n\n[model_providers.ccswitch]\nbase_url = \"https://proxy.example/v1\"\nrequires_openai_auth = false\n",
	), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(codexDir, "auth.json"), []byte(`{"auth_mode":"chatgpt","tokens":{"access_token":"expired"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	codexExe := filepath.Join(binDir, "codex")
	codexScript := `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'codex-cli 0.171.0'; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo 'Not logged in' >&2; exit 1; fi
if [ -e "$CODEX_HOME/auth.json" ]; then echo 'stale auth.json leaked' >&2; exit 2; fi
read initialize
echo '{"id":1,"result":{"userAgent":"fake-codex"}}'
if read initialized && read account; then
  echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":false}}'
fi
`
	if err := os.WriteFile(codexExe, []byte(codexScript), 0o700); err != nil {
		t.Fatal(err)
	}

	// CC Switch Claude: ~/.claude/settings.json carries ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL.
	claudeDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claudeDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(claudeDir, "settings.json"), []byte(
		`{"env":{"ANTHROPIC_AUTH_TOKEN":"ccswitch-token","ANTHROPIC_BASE_URL":"https://relay.example"}}`,
	), 0o600); err != nil {
		t.Fatal(err)
	}
	claudeExe := filepath.Join(binDir, "claude")
	claudeScript := `#!/bin/sh
if [ "$1" = "--version" ]; then echo '2.1.310 (Claude Code)'; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ] && [ "$3" = "--json" ]; then
  if [ "$ANTHROPIC_AUTH_TOKEN" = "ccswitch-token" ] && [ "$ANTHROPIC_BASE_URL" = "https://relay.example" ] && [ "$CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" = "1" ]; then
    echo '{"loggedIn":true,"authMethod":"apiKey"}'
    exit 0
  fi
  echo '{"loggedIn":false}'
  exit 1
fi
read req
echo '{"type":"control_response","response":{"subtype":"success","request_id":"linger-computer-doctor"}}'
`
	if err := os.WriteFile(claudeExe, []byte(claudeScript), 0o700); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	env := map[string]string{
		"HOME": home,
		"PATH": "/usr/bin:/bin",
	}
	if err := runProbeRuntimes(t.Context(), []string{"--json", "--runtime", "codex", "--runtime", "claude"}, env, &out); err != nil {
		t.Fatalf("runProbeRuntimes failed: %v", err)
	}

	var report runtimeProbeReport
	if err := json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatalf("decode report: %v (raw=%q)", err, out.String())
	}
	if report.Schema != runtimeProbeSchema {
		t.Fatalf("schema = %q, want %q", report.Schema, runtimeProbeSchema)
	}
	byType := map[string]runtimeProbeEntry{}
	for _, entry := range report.Runtimes {
		byType[entry.Type] = entry
	}
	codex := byType["codex"]
	if codex.Status != "ready" || !codex.Installed || !codex.Authenticated || codex.RequiredVersion != "0.166.0" || codex.Executable != codexExe {
		t.Fatalf("unexpected codex probe entry: %+v", codex)
	}
	claude := byType["claude"]
	if claude.Status != "ready" || !claude.Installed || !claude.Authenticated || claude.RequiredVersion != "2.1.282" || claude.Executable != claudeExe {
		t.Fatalf("unexpected claude probe entry: %+v", claude)
	}
}

func TestRunProbeRuntimesDistinguishesUnauthenticatedAndIncompatible(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX script fixture")
	}
	home := t.TempDir()
	binDir := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		t.Fatal(err)
	}
	codexExe := filepath.Join(binDir, "codex")
	codexScript := `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'codex-cli 0.171.0'; exit 0; fi
read initialize
echo '{"id":1,"result":{"userAgent":"fake-codex"}}'
if read initialized && read account; then
  echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":true}}'
fi
`
	if err := os.WriteFile(codexExe, []byte(codexScript), 0o700); err != nil {
		t.Fatal(err)
	}
	claudeExe := filepath.Join(binDir, "claude")
	claudeScript := `#!/bin/sh
echo '2.1.100 (Claude Code)'
`
	if err := os.WriteFile(claudeExe, []byte(claudeScript), 0o700); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	env := map[string]string{
		"HOME": home,
		"PATH": "/usr/bin:/bin",
	}
	if err := runProbeRuntimes(t.Context(), []string{"--json", "--runtime", "codex", "--runtime", "claude"}, env, &out); err != nil {
		t.Fatalf("runProbeRuntimes failed: %v", err)
	}

	var report runtimeProbeReport
	if err := json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatalf("decode report: %v", err)
	}
	byType := map[string]runtimeProbeEntry{}
	for _, entry := range report.Runtimes {
		byType[entry.Type] = entry
	}
	codex := byType["codex"]
	if codex.Status != "authentication_required" || !codex.Installed || codex.Authenticated {
		t.Fatalf("unexpected codex probe entry: %+v", codex)
	}
	claude := byType["claude"]
	if claude.Status != "incompatible" || !claude.Installed || claude.Authenticated || claude.RequiredVersion != "2.1.282" {
		t.Fatalf("unexpected claude probe entry: %+v", claude)
	}
	if claude.Error == nil || claude.Error.Code != "RUNTIME_INCOMPATIBLE" {
		t.Fatalf("expected RUNTIME_INCOMPATIBLE error, got %+v", claude.Error)
	}
}

func TestRunProbeRuntimesScrubsSensitiveEnvironmentAndPreservesUserEnv(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX script fixture")
	}
	home := t.TempDir()
	customBin := filepath.Join(home, "custom-bin")
	if err := os.MkdirAll(customBin, 0o700); err != nil {
		t.Fatal(err)
	}
	codexHome := filepath.Join(home, "user-codex-home")
	if err := os.MkdirAll(codexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte(
		"model_provider = \"ccswitch\"\n\n[model_providers.ccswitch]\nbase_url = \"https://proxy.example/v1\"\nrequires_openai_auth = false\n",
	), 0o600); err != nil {
		t.Fatal(err)
	}
	claudeConfigDir := filepath.Join(home, "user-claude-config")
	if err := os.MkdirAll(claudeConfigDir, 0o700); err != nil {
		t.Fatal(err)
	}

	codexExe := filepath.Join(customBin, "codex")
	// Fail immediately if any Linger/TeamHub/Gateway/Service secret leaks into
	// the probed subprocess or if standard user environment variables are lost.
	codexScript := `#!/bin/sh
for forbidden in LINGER_CODEX_PATH LINGER_SECRET TEAMHUB_TOKEN RUNNER_GATEWAY_TOKEN SERVICE_TOKEN MIRROR_TOKEN; do
  eval "val=\${$forbidden:-}"
  if [ -n "$val" ]; then
    echo "leaked $forbidden" >&2
    exit 9
  fi
done
if [ "$CLAUDE_CONFIG_DIR" != "` + claudeConfigDir + `" ] || [ "$USER_CUSTOM_VAR" != "preserved" ]; then
  echo "missing user env" >&2
  exit 10
fi
if [ "$1" = "--version" ]; then echo 'codex-cli 0.171.0'; exit 0; fi
read initialize
echo '{"id":1,"result":{"userAgent":"fake-codex"}}'
if read initialized && read account; then
  echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":false}}'
fi
`
	if err := os.WriteFile(codexExe, []byte(codexScript), 0o700); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	env := map[string]string{
		"HOME":                 home,
		"PATH":                 "/usr/bin:/bin",
		"CODEX_HOME":           codexHome,
		"CLAUDE_CONFIG_DIR":    claudeConfigDir,
		"USER_CUSTOM_VAR":      "preserved",
		"LINGER_CODEX_PATH":    codexExe,
		"LINGER_SECRET":        "top-secret",
		"TEAMHUB_TOKEN":        "th-secret",
		"RUNNER_GATEWAY_TOKEN": "gw-secret",
		"SERVICE_TOKEN":        "svc-secret",
		"MIRROR_TOKEN":         "mirror-secret",
	}
	if err := runProbeRuntimes(t.Context(), []string{"--json", "--runtime", "codex"}, env, &out); err != nil {
		t.Fatalf("runProbeRuntimes failed: %v", err)
	}

	var report runtimeProbeReport
	if err := json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatalf("decode report: %v (raw=%q)", err, out.String())
	}
	if len(report.Runtimes) != 1 {
		t.Fatalf("runtimes count = %d, want 1", len(report.Runtimes))
	}
	got := report.Runtimes[0]
	if got.Status != "ready" || !got.Installed || !got.Authenticated || got.Executable != codexExe {
		t.Fatalf("unexpected codex probe entry: %+v", got)
	}
}

func TestRunProbeRuntimesRejectsInvalidFlags(t *testing.T) {
	var out bytes.Buffer
	if err := runProbeRuntimes(t.Context(), []string{"--runtime", "unknown"}, map[string]string{}, &out); err == nil {
		t.Fatal("expected error for unknown runtime")
	}
	if err := runProbeRuntimes(t.Context(), []string{"--codex-path", "relative/codex"}, map[string]string{}, &out); err == nil {
		t.Fatal("expected error for non-absolute --codex-path")
	}
	if err := runProbeRuntimes(t.Context(), []string{"--claude-path", "relative/claude"}, map[string]string{}, &out); err == nil {
		t.Fatal("expected error for non-absolute --claude-path")
	}
}

func TestRunProbeRuntimesBundledPiOptIn(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX script fixture")
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
	piScript := `#!/bin/sh
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
	if err := os.WriteFile(bundledPi, []byte(piScript), 0o700); err != nil {
		t.Fatal(err)
	}

	previous := resolveProbeBundledPaths
	t.Cleanup(func() { resolveProbeBundledPaths = previous })
	resolveProbeBundledPaths = func() map[string]string {
		return map[string]string{"pi": bundledPi}
	}

	env := map[string]string{
		"HOME":  home,
		"PATH":  emptyPath,
		"SHELL": filepath.Join(root, "no-shell"),
	}

	// Default (--include-bundled omitted) must ignore bundled Pi so setup
	// inspection never treats bundled Pi as a user-installed runtime.
	var defaultOut bytes.Buffer
	if err := runProbeRuntimes(t.Context(), []string{"--json", "--runtime", "pi"}, env, &defaultOut); err != nil {
		t.Fatalf("default runProbeRuntimes failed: %v", err)
	}
	var defaultReport runtimeProbeReport
	if err := json.Unmarshal(defaultOut.Bytes(), &defaultReport); err != nil {
		t.Fatalf("decode default report: %v (raw=%q)", err, defaultOut.String())
	}
	if len(defaultReport.Runtimes) != 1 {
		t.Fatalf("default runtimes count = %d, want 1", len(defaultReport.Runtimes))
	}
	if got := defaultReport.Runtimes[0]; got.Type != "pi" || got.Status != "not_installed" || got.Installed {
		t.Fatalf("default probe should not discover bundled Pi, got %+v", got)
	}

	// With --include-bundled, bundled Pi is discovered on an empty PATH.
	var bundledOut bytes.Buffer
	if err := runProbeRuntimes(t.Context(), []string{"--json", "--include-bundled", "--runtime", "pi"}, env, &bundledOut); err != nil {
		t.Fatalf("--include-bundled runProbeRuntimes failed: %v", err)
	}
	var bundledReport runtimeProbeReport
	if err := json.Unmarshal(bundledOut.Bytes(), &bundledReport); err != nil {
		t.Fatalf("decode bundled report: %v (raw=%q)", err, bundledOut.String())
	}
	if len(bundledReport.Runtimes) != 1 {
		t.Fatalf("bundled runtimes count = %d, want 1", len(bundledReport.Runtimes))
	}
	got := bundledReport.Runtimes[0]
	if got.Type != "pi" || !got.Installed || got.Version != "1.5.2" || got.Executable != bundledPi {
		t.Fatalf("--include-bundled probe entry = %+v, want installed pi 1.5.2 at %q", got, bundledPi)
	}

	// A dangling --pi-path (e.g., stale stable symlink after app move) falls
	// back to bundled Pi when --include-bundled is enabled.
	danglingLink := filepath.Join(home, "runtime", "bundled-pi", "bin", "pi")
	if err := os.MkdirAll(filepath.Dir(danglingLink), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "deleted-app", "pi"), danglingLink); err != nil {
		t.Fatal(err)
	}
	var fallbackOut bytes.Buffer
	if err := runProbeRuntimes(t.Context(), []string{"--json", "--include-bundled", "--runtime", "pi", "--pi-path", danglingLink}, env, &fallbackOut); err != nil {
		t.Fatalf("dangling --pi-path runProbeRuntimes failed: %v", err)
	}
	var fallbackReport runtimeProbeReport
	if err := json.Unmarshal(fallbackOut.Bytes(), &fallbackReport); err != nil {
		t.Fatalf("decode fallback report: %v (raw=%q)", err, fallbackOut.String())
	}
	if got := fallbackReport.Runtimes[0]; got.Type != "pi" || !got.Installed || got.Executable != bundledPi {
		t.Fatalf("dangling --pi-path fallback entry = %+v, want installed pi at %q", got, bundledPi)
	}
}
