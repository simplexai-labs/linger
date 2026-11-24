package provider

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestDiscoverLiveChecksOnlySelectedReadyRuntime(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	// Every case runs one shared executable that takes its exec reply from
	// the environment: macOS scans each new executable on its first launch.
	codex := filepath.Join(t.TempDir(), "codex")
	script := `#!/bin/sh
case "$1 $2" in
  "--version ") echo "codex-cli 0.171.0" ;;
  "exec --skip-git-repo-check")
    [ "$8" = "Reply with exactly: OK" ] || exit 2
    eval "$LIVE_EXEC" ;;
  "app-server --disable")
    read line
    echo '{"jsonrpc":"2.0","id":1,"result":{"userAgent":"codex-test"}}'
    if read initialized && read account; then
  case "$account" in
    *'"method":"model/list"'*)
      echo '{"id":2,"result":{"data":[{"id":"fixture-model","model":"fixture-model","displayName":"Fixture model","isDefault":true,"supportedReasoningEfforts":[]}]}}'
      exit 0 ;;
  esac
      echo '{"id":2,"result":{"account":{"type":"chatgpt"},"requiresOpenaiAuth":true}}'
    fi
    ;;
  *) exit 2 ;;
esac
`
	if err := os.WriteFile(codex, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, exec string
		passed     bool
		reply      string
		message    string
	}{
		{name: "reply", exec: `echo OK`, passed: true, reply: "OK"},
		{name: "failure", exec: `echo "starting" >&2; echo "401 Unauthorized" >&2; exit 1`, message: "401 Unauthorized"},
		{name: "empty", exec: `exit 0`, message: "Runtime exited without a reply"},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			result, checks := DiscoverLive(context.Background(), DiscoveryOptions{
				ConfiguredPaths: map[string]string{"codex": codex},
				Environment:     map[string]string{"PATH": root, "HOME": root, "LIVE_EXEC": test.exec},
				Runtimes:        []string{"codex"},
			}, 10*time.Second)
			if len(result.Diagnostics) != 1 || result.Diagnostics[0].Type != "codex" || result.Diagnostics[0].Status != "ready" {
				t.Fatalf("diagnostics = %+v", result.Diagnostics)
			}
			check, ok := checks["codex"]
			if !ok || check.Passed != test.passed || check.Reply != test.reply || check.Message != test.message {
				t.Fatalf("live check = %+v", check)
			}
		})
	}
}

func TestCheckLiveClaudeDisablesNonessentialTrafficAndPreservesOverride(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	root := t.TempDir()
	claude := filepath.Join(root, "claude")
	script := `#!/bin/sh
want="${EXPECTED_NONESSENTIAL:-1}"
if [ "$CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" != "$want" ]; then
  echo "unexpected CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=$CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" >&2
  exit 11
fi
echo OK
`
	if err := os.WriteFile(claude, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	diagnostic := RuntimeDiagnostic{Type: "claude", ExecutablePath: claude, Status: "ready"}

	callerEnv := map[string]string{"HOME": root, "PATH": root}
	check := checkLive(context.Background(), diagnostic, callerEnv, 5*time.Second)
	if !check.Passed || check.Reply != "OK" {
		t.Fatalf("default checkLive(claude) = %+v, want passed OK", check)
	}
	if _, mutated := callerEnv["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]; mutated {
		t.Fatal("checkLive(claude) mutated caller environment map")
	}

	overrideEnv := map[string]string{
		"HOME": root,
		"PATH": root,
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "0",
		"EXPECTED_NONESSENTIAL":                    "0",
	}
	overrideCheck := checkLive(context.Background(), diagnostic, overrideEnv, 5*time.Second)
	if !overrideCheck.Passed || overrideCheck.Reply != "OK" {
		t.Fatalf("override checkLive(claude) = %+v, want passed OK", overrideCheck)
	}
}
