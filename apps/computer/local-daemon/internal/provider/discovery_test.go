package provider

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

func TestDiscoverUsesConfiguredExecutableAndReportsAllRuntimes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	root := t.TempDir()
	codex := filepath.Join(root, "codex")
	script := `#!/bin/sh
case "$1 $2" in
  "--version ") echo "codex-cli 0.171.0" ;;
  "app-server --disable")
    [ "$3 $4 $5 $6 $7" = "plugins --disable goals --listen stdio://" ] || exit 2
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
	result, err := Discover(context.Background(), DiscoveryOptions{ConfiguredPaths: map[string]string{"codex": codex}, Environment: map[string]string{"PATH": root, "HOME": t.TempDir()}})
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := filepath.EvalSymlinks(codex)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Diagnostics) != 4 || result.Diagnostics[0].Status != "ready" || result.Installations["codex"].ExecutablePath != canonical {
		t.Fatalf("result=%+v", result)
	}
}

func TestDiscoverFindsCLIsInsideMacApplicationBundles(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("application bundles are a macOS install location")
	}
	writeExe := func(target string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte("#!/bin/sh\n"), 0o700); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("Codex.app and ChatGPT.app", func(t *testing.T) {
		sysRoot := t.TempDir()
		home := t.TempDir()
		if got := resolveMacApplicationBundleCandidatesIn("codex", sysRoot, home); len(got) != 0 {
			t.Fatalf("unexpected codex without bundle: %q", got)
		}
		chatgptCodex := filepath.Join(sysRoot, "Applications", "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex")
		writeExe(chatgptCodex)
		if got, want := resolveMacApplicationBundleCandidatesIn("codex", sysRoot, home), []string{chatgptCodex}; !slices.Equal(got, want) {
			t.Fatalf("chatgpt codex = %q; want %q", got, want)
		}
		codexApp := filepath.Join(home, "Applications", "Codex.app", "Contents", "Resources", "codex")
		writeExe(codexApp)
		if got, want := resolveMacApplicationBundleCandidatesIn("codex", sysRoot, home), []string{codexApp, chatgptCodex}; !slices.Equal(got, want) {
			t.Fatalf("Codex.app should take precedence over ChatGPT.app: got %q; want %q", got, want)
		}
	})

	t.Run("Claude.app and Claude Desktop managed claude-code", func(t *testing.T) {
		sysRoot := t.TempDir()
		home := t.TempDir()
		if got := resolveMacApplicationBundleCandidatesIn("claude", sysRoot, home); len(got) != 0 {
			t.Fatalf("unexpected claude without bundle: %q", got)
		}
		older := filepath.Join(home, "Library", "Application Support", "Claude", "claude-code", "2.1.99", "aaa", "claude.app", "Contents", "MacOS", "claude")
		newer := filepath.Join(home, "Library", "Application Support", "Claude", "claude-code", "2.1.309", "bbb", "claude.app", "Contents", "MacOS", "claude")
		writeExe(older)
		writeExe(newer)
		if err := os.WriteFile(filepath.Join(filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(newer)))), ".verified"), nil, 0o600); err != nil {
			t.Fatal(err)
		}
		if got, want := resolveMacApplicationBundleCandidatesIn("claude", sysRoot, home), []string{newer, older}; !slices.Equal(got, want) {
			t.Fatalf("claude desktop managed = %q; want %q", got, want)
		}
		claudeApp := filepath.Join(home, "Applications", "Claude.app", "Contents", "Resources", "claude")
		writeExe(claudeApp)
		if got, want := resolveMacApplicationBundleCandidatesIn("claude", sysRoot, home), []string{claudeApp, newer, older}; !slices.Equal(got, want) {
			t.Fatalf("Claude.app = %q; want %q", got, want)
		}
	})
}

func TestResolveWindowsDesktopCLIFindsNewestClaudeCode(t *testing.T) {
	appData := t.TempDir()
	writeExe := func(target string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte("exe"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	older := filepath.Join(appData, "Claude", "claude-code", "2.1.99", "claude.exe")
	newer := filepath.Join(appData, "Claude", "claude-code", "2.1.309", "claude.exe")
	writeExe(older)
	writeExe(newer)
	if got, want := resolveWindowsDesktopCLICandidates("claude", appData), []string{newer, older}; !slices.Equal(got, want) {
		t.Fatalf("windows claude desktop = %q; want %q", got, want)
	}
	if got := resolveWindowsDesktopCLICandidates("codex", appData); len(got) != 0 {
		t.Fatalf("unexpected codex match: %q", got)
	}
}

func TestDiscoverPublishesRuntimeModelCatalog(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	root := t.TempDir()
	codex := filepath.Join(root, "codex")
	script := `#!/bin/sh
case "$1 $2" in
  "--version ") echo "codex-cli 0.171.0" ;;
  "app-server --disable")
    [ "$3 $4 $5 $6 $7" = "plugins --disable goals --listen stdio://" ] || exit 2
    read line
    echo '{"jsonrpc":"2.0","id":1,"result":{"userAgent":"codex-test"}}'
    if read initialized && read account; then
  case "$account" in
    *'"method":"model/list"'*)
      echo '{"models":[{"slug":"gpt-runtime","context_window":272000}]}' > "$CODEX_HOME/models_cache.json"
      echo '{"id":2,"result":{"data":[{"id":"gpt-runtime","model":"gpt-runtime","displayName":"GPT Runtime","isDefault":true,"defaultReasoningEffort":"high","supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"},{"reasoningEffort":"future"},{"reasoningEffort":"bad effort"}]}]}}'
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
	result, err := Discover(context.Background(), DiscoveryOptions{
		ConfiguredPaths: map[string]string{"codex": codex},
		Environment:     map[string]string{"PATH": root, "HOME": root},
		Timeout:         5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	diagnostic := result.Diagnostics[0]
	if len(diagnostic.Models) != 1 || diagnostic.Models[0].ID != "gpt-runtime" ||
		diagnostic.Models[0].DefaultReasoningEffort != "high" ||
		!reflect.DeepEqual(diagnostic.Models[0].AllowedReasoningEffort, []string{"low", "high", "future"}) ||
		!diagnostic.Models[0].IsDefault || diagnostic.Models[0].Link != linkSubscription ||
		diagnostic.Models[0].ContextWindow != 272000 {
		t.Fatalf("Codex diagnostic = %+v", diagnostic)
	}
}

// The CLI fixture resolves its configured model source and serves it through
// model/list; discovery must leave configuration interpretation to the CLI.
const fakeCodexCatalogPath = `catalog="${CODEX_HOME:-$HOME/.codex}/catalog.json"
if [ -f "$CODEX_HOME/config.toml" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      'model_catalog_json = '*)
        catalog=${line#*= }
        catalog=${catalog#\"}; catalog=${catalog%\"}
        catalog=${catalog#\'}; catalog=${catalog%\'} ;;
    esac
  done < "$CODEX_HOME/config.toml"
  case "$catalog" in
    /*) ;;
    '~/'*) catalog="$HOME/${catalog#\~/}" ;;
    *) catalog="$CODEX_HOME/$catalog" ;;
  esac
fi
`

const fakeCodexModelCatalog = fakeCodexCatalogPath + `read initialize
echo '{"id":1,"result":{"userAgent":"test"}}'
read initialized
read request
case "$request" in
 *'"method":"model/list"'*)
  if [ ! -f "$catalog" ]; then echo '{"id":2,"error":{"code":-32000,"message":"catalog unavailable"}}'; exit 0; fi
  printf '{"id":2,"result":'
  while IFS= read -r line || [ -n "$line" ]; do printf '%s' "$line"; done < "$catalog"
  echo '}' ;;
 *) echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":false}}' ;;
esac
`

func TestDiscoverRejectsInvalidConfiguredCatalogAndRecovers(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	root := t.TempDir()
	t.Setenv("CODEX_HOME", root)
	codex := filepath.Join(root, "codex")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'codex-cli 0.171.0'; exit 0; fi
` + fakeCodexModelCatalog
	if err := os.WriteFile(codex, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte("model_catalog_json = \"catalog.json\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	options := DiscoveryOptions{ConfiguredPaths: map[string]string{"codex": codex}, Environment: map[string]string{"PATH": root, "HOME": root, "CODEX_HOME": root}, Timeout: 10 * time.Second}
	result, err := Discover(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	diagnostic := result.Diagnostics[0]
	if diagnostic.Status != "error" || diagnostic.Error == nil || diagnostic.Error.Code != "RUNTIME_DIAGNOSTIC_FAILED" || len(diagnostic.Models) != 0 {
		t.Fatalf("missing Provider catalog allowed creation: %+v", diagnostic)
	}
	refreshed, err := RefreshRuntimeAuthentication(context.Background(), result, options)
	if err != nil || refreshed.Diagnostics[0].Status != "error" || len(refreshed.Diagnostics[0].Models) != 0 {
		t.Fatalf("authentication refresh reopened invalid catalog: result=%+v err=%v", refreshed, err)
	}
	if err := os.WriteFile(filepath.Join(root, "catalog.json"), []byte(`{"data":[{"id":"deepseek-v4.1-flash","supportedReasoningEfforts":[{"reasoningEffort":"max"}],"defaultReasoningEffort":"max"}],"nextCursor":null}`), 0o600); err != nil {
		t.Fatal(err)
	}
	refreshed, err = refreshRuntimeAuthentication(context.Background(), result, options, true)
	if err != nil || refreshed.Diagnostics[0].Status != "error" || len(refreshed.Diagnostics[0].Models) != 0 {
		t.Fatalf("authentication retry reopened catalog before full discovery: result=%+v err=%v", refreshed, err)
	}
	result, err = Discover(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	diagnostic = result.Diagnostics[0]
	if diagnostic.Status != "ready" || diagnostic.Error != nil || len(diagnostic.Models) != 1 || diagnostic.Models[0].ID != "deepseek-v4.1-flash" || len(diagnostic.Models[0].AllowedReasoningEffort) != 1 || diagnostic.Models[0].AllowedReasoningEffort[0] != "max" {
		t.Fatalf("repaired Provider catalog did not recover exact allowed model: %+v", diagnostic)
	}
}

func TestDiscoverUsesCodexRuntimeEnvironmentForModelCatalog(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	ambient := t.TempDir()
	t.Setenv("CODEX_HOME", ambient)
	t.Setenv("HOME", ambient)
	if err := os.WriteFile(filepath.Join(ambient, "config.toml"), []byte("model_catalog_json = \"catalog.json\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ambient, "catalog.json"), []byte(`{"data":[{"id":"grok-4.7"}],"nextCursor":null}`), 0o600); err != nil {
		t.Fatal(err)
	}
	// Every mode runs one shared executable: macOS scans each new executable
	// on its first launch.
	codex := filepath.Join(t.TempDir(), "codex")
	script := `#!/bin/sh
[ "$HOME" = "$EXPECTED_HOME" ] && [ "$CODEX_HOME" != "$AMBIENT_CODEX_HOME" ] || exit 2
if [ "$1" = "--version" ]; then echo 'codex-cli 0.171.0'; exit 0; fi
[ "$CODEX_HOME" != "$EXPECTED_CODEX_HOME" ] || exit 2
` + fakeCodexModelCatalog
	if err := os.WriteFile(codex, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"CODEX_HOME", "HOME", "tilde"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			home := root
			environment := map[string]string{"PATH": root, "HOME": root, "EXPECTED_HOME": root, "AMBIENT_CODEX_HOME": ambient}
			if mode == "HOME" {
				home = filepath.Join(root, ".codex")
			} else {
				environment["CODEX_HOME"] = home
			}
			environment["EXPECTED_CODEX_HOME"] = environment["CODEX_HOME"]
			if err := os.MkdirAll(home, 0o700); err != nil {
				t.Fatal(err)
			}
			catalogReference := "catalog.json"
			if mode == "tilde" {
				catalogReference = "~/catalog.json"
			}
			if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte("model_catalog_json = \""+catalogReference+"\"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			catalogPath := filepath.Join(home, "catalog.json")
			if err := os.WriteFile(catalogPath, []byte(`{"data":[{"id":"deepseek-v4.1-flash","supportedReasoningEfforts":[{"reasoningEffort":"max"}],"defaultReasoningEffort":"max"}],"nextCursor":null}`), 0o600); err != nil {
				t.Fatal(err)
			}
			options := DiscoveryOptions{ConfiguredPaths: map[string]string{"codex": codex}, Environment: environment, Timeout: 10 * time.Second}
			result, err := Discover(context.Background(), options)
			if err != nil {
				t.Fatal(err)
			}
			diagnostic := result.Diagnostics[0]
			if diagnostic.Status != "ready" || len(diagnostic.Models) != 1 || diagnostic.Models[0].ID != "deepseek-v4.1-flash" {
				t.Fatalf("Runtime catalog was replaced by the ambient Provider catalog: %+v", diagnostic)
			}
			if err := os.Remove(catalogPath); err != nil {
				t.Fatal(err)
			}
			result, err = Discover(context.Background(), options)
			if err != nil {
				t.Fatal(err)
			}
			diagnostic = result.Diagnostics[0]
			if diagnostic.Status != "error" || diagnostic.Error == nil || diagnostic.Error.Code != "RUNTIME_DIAGNOSTIC_FAILED" || len(diagnostic.Models) != 0 {
				t.Fatalf("Missing Runtime catalog reopened the ambient Provider catalog: %+v", diagnostic)
			}
		})
	}
}

func TestDiscoverRejectsUnknownCodexVersion(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	for _, versionProbe := range []string{"exit 1", "echo unknown-version"} {
		t.Run(versionProbe, func(t *testing.T) {
			codex := filepath.Join(t.TempDir(), "codex")
			if err := os.WriteFile(codex, []byte("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then "+versionProbe+"; exit; fi\ntouch \"$0.started\"\nexit 1\n"), 0o700); err != nil {
				t.Fatal(err)
			}
			diagnostic := diagnose(t.Context(), "codex", "codex", "app-server", DiscoveryOptions{ConfiguredPaths: map[string]string{"codex": codex}}, time.Second)
			if diagnostic.Status != "error" || diagnostic.Error == nil || diagnostic.Error.Code != "RUNTIME_DIAGNOSTIC_FAILED" {
				t.Fatalf("unknown version must fail admission: %+v", diagnostic)
			}
			if len(InstallationsFromDiagnostics([]RuntimeDiagnostic{diagnostic})) != 0 {
				t.Fatal("unknown version entered executable installations")
			}
			if _, err := os.Stat(codex + ".started"); !os.IsNotExist(err) {
				t.Fatalf("app-server started before version verification: %v", err)
			}
		})
	}
}

func TestDiscoverRejectsBelowMinimumRuntime(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	root := t.TempDir()
	codex := filepath.Join(root, "codex")
	if err := os.WriteFile(codex, []byte("#!/bin/sh\necho codex-cli 0.99.0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	result, err := Discover(context.Background(), DiscoveryOptions{ConfiguredPaths: map[string]string{"codex": codex}, Environment: map[string]string{"PATH": root, "HOME": root}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Diagnostics[0].Status != "incompatible" {
		t.Fatalf("diagnostic=%+v", result.Diagnostics[0])
	}
}

func TestDiscoverReportsCodexAuthenticationRequiredAfterProtocolHandshake(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	root := t.TempDir()
	codex := filepath.Join(root, "codex")
	script := `#!/bin/sh
case "$1 $2" in
  "--version ") echo "codex-cli 0.171.0" ;;
  "app-server --disable")
    [ "$3 $4 $5 $6 $7" = "plugins --disable goals --listen stdio://" ] || exit 2
    read line
    echo '{"jsonrpc":"2.0","id":1,"result":{"userAgent":"codex-test"}}'
    if read initialized && read account; then
  case "$account" in
    *'"method":"model/list"'*)
      echo '{"id":2,"result":{"data":[{"id":"fixture-model","model":"fixture-model","displayName":"Fixture model","isDefault":true,"supportedReasoningEfforts":[]}]}}'
      exit 0 ;;
  esac
      echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":true}}'
    fi
    ;;
  *) exit 2 ;;
esac
`
	if err := os.WriteFile(codex, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	result, err := Discover(context.Background(), DiscoveryOptions{
		ConfiguredPaths: map[string]string{"codex": codex},
		Environment:     map[string]string{"PATH": root, "HOME": root},
		Timeout:         5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	diagnostic := result.Diagnostics[0]
	if diagnostic.Status != "authentication_required" || diagnostic.Error == nil || diagnostic.Error.Code != "RUNTIME_AUTHENTICATION_REQUIRED" {
		t.Fatalf("Codex diagnostic = %+v", diagnostic)
	}
	if _, ok := result.Installations["codex"]; !ok {
		t.Fatal("authentication-required Codex installation was discarded")
	}
}

func TestDiscoverReportsClaudeAuthenticationRequiredWithoutPromptProbe(t *testing.T) {
	isolateClaudeKeychain(t)
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	root := t.TempDir()
	claude := filepath.Join(root, "claude")
	promptMarker := filepath.Join(root, "prompt-called")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then echo "claude 2.1.282"; exit 0; fi
if [ "$1 $2 $3" = "auth status --json" ]; then echo '{"loggedIn":false}'; exit 1; fi
if [ "$1" = "--help" ]; then echo "--effort <level> (low, medium, high)"; exit 0; fi
echo called > "$PROMPT_MARKER"
exit 2
`
	if err := os.WriteFile(claude, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	result, err := Discover(context.Background(), DiscoveryOptions{
		ConfiguredPaths: map[string]string{"claude": claude},
		Environment: map[string]string{
			"PATH": root, "HOME": root, "PROMPT_MARKER": promptMarker,
		},
		Timeout: 3 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	diagnostic := result.Diagnostics[1]
	if diagnostic.Status != "authentication_required" || diagnostic.Error == nil || diagnostic.Error.Code != "RUNTIME_AUTHENTICATION_REQUIRED" {
		t.Fatalf("Claude diagnostic = %+v", diagnostic)
	}
	if len(diagnostic.Models) != 0 {
		t.Fatalf("logged-out Claude must not offer unverified models, got %+v", diagnostic.Models)
	}
	if _, err := os.Stat(promptMarker); !os.IsNotExist(err) {
		t.Fatal("Claude prompt protocol probe ran before authentication")
	}
}

func TestDiscoverProbesClaudeStreamProtocolAfterAuthentication(t *testing.T) {
	isolateClaudeKeychain(t)
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	root := t.TempDir()
	claude := filepath.Join(root, "claude")
	promptMarker := filepath.Join(root, "prompt-called")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then echo "claude 2.1.282"; exit 0; fi
if [ "$1 $2 $3" = "auth status --json" ]; then echo '{"loggedIn":true}'; exit 0; fi
if [ "$1 $2" = "-p --input-format" ]; then
  IFS= read -r request
  printf '%s\n' '{"type":"control_response","response":{"subtype":"success","request_id":"linger-catalog","response":{"models":[{"value":"claude-fixture","displayName":"Claude fixture"}]}}}'
  if IFS= read -r unexpected; then exit 4; fi
  exit 0
fi
[ "$1 $2" = "-p --output-format" ] || exit 2
IFS= read -r request
[ "$request" = '{"type":"control_request","request_id":"linger-computer-doctor","request":{"subtype":"initialize"}}' ] || exit 3
echo called > "$PROMPT_MARKER"
printf '%s' '{"type":"control_response","response":'
printf '%s\n' '{"subtype":"success","request_id":"linger-computer-doctor"}}'
if IFS= read -r unexpected; then exit 4; fi
exit 0
`
	if err := os.WriteFile(claude, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	result, err := Discover(context.Background(), DiscoveryOptions{
		ConfiguredPaths: map[string]string{"claude": claude},
		Environment: map[string]string{
			"PATH": root, "HOME": root, "PROMPT_MARKER": promptMarker,
		},
		Timeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if diagnostic := result.Diagnostics[1]; diagnostic.Status != "ready" {
		t.Fatalf("Claude diagnostic = %+v", diagnostic)
	}
	if _, err := os.Stat(promptMarker); err != nil {
		t.Fatal("Claude stream protocol probe did not run")
	}
}

func TestGatewayDiagnosticsLeaveOutAnAntigravityThatIsNotInstalled(t *testing.T) {
	codex := RuntimeDiagnostic{Type: "codex", Status: "ready"}
	missing := RuntimeDiagnostic{Type: "antigravity", Status: "not_installed"}
	signedOut := RuntimeDiagnostic{Type: "antigravity", Status: "authentication_required"}
	if got := GatewayDiagnostics([]RuntimeDiagnostic{codex, missing}); len(got) != 1 || got[0].Type != "codex" {
		t.Fatalf("missing Antigravity was sent: %+v", got)
	}
	if got := GatewayDiagnostics([]RuntimeDiagnostic{codex, signedOut}); len(got) != 2 {
		t.Fatalf("installed Antigravity was dropped: %+v", got)
	}
	if got := GatewayDiagnostics([]RuntimeDiagnostic{missing}); len(got) != 1 {
		t.Fatalf("the only diagnostic was dropped: %+v", got)
	}
}

func TestNormalizeRuntimeModelsRetainsDefaultBeyondWireCap(t *testing.T) {
	catalog := make([]native.ModelOption, 0, 500)
	for i := range 500 {
		entry := native.ModelOption{
			ID:    fmt.Sprintf("provider/model-%03d", i+1),
			Label: fmt.Sprintf("Model %03d", i+1),
		}
		if i == 465 {
			entry = native.ModelOption{
				ID:            "localmodels/localmodels-byok",
				Label:         "localmodels-byok",
				Default:       true,
				ContextWindow: 1_048_576,
				Effort: &native.EffortSupport{
					Options: []native.EffortOption{{Value: "low"}, {Value: "high"}},
					Default: "high",
				},
			}
		}
		catalog = append(catalog, entry)
	}
	snapshot := append([]native.ModelOption(nil), catalog...)

	models := normalizeRuntimeModels(catalog)
	if !reflect.DeepEqual(catalog, snapshot) {
		t.Fatal("input catalog was mutated")
	}
	if len(models) != 100 {
		t.Fatalf("normalized model count = %d, want 100", len(models))
	}
	gotDefault := models[0]
	if gotDefault.ID != "localmodels/localmodels-byok" ||
		gotDefault.Label != "localmodels-byok" ||
		!gotDefault.IsDefault ||
		gotDefault.ContextWindow != 1_048_576 ||
		gotDefault.DefaultReasoningEffort != "high" ||
		!reflect.DeepEqual(gotDefault.AllowedReasoningEffort, []string{"low", "high"}) {
		t.Fatalf("default model = %+v", gotDefault)
	}
	for i := 1; i < len(models); i++ {
		wantID := fmt.Sprintf("provider/model-%03d", i)
		if models[i].ID != wantID || models[i].IsDefault {
			t.Fatalf("models[%d] = %+v, want non-default %s", i, models[i], wantID)
		}
	}
}

func TestNormalizeRuntimeModelsPreservesOrderWithoutDefault(t *testing.T) {
	catalog := make([]native.ModelOption, 0, 120)
	for i := range 120 {
		catalog = append(catalog, native.ModelOption{
			ID:    fmt.Sprintf("provider/model-%03d", i+1),
			Label: fmt.Sprintf("Model %03d", i+1),
		})
	}
	snapshot := append([]native.ModelOption(nil), catalog...)

	models := normalizeRuntimeModels(catalog)
	if !reflect.DeepEqual(catalog, snapshot) {
		t.Fatal("input catalog was mutated")
	}
	if len(models) != 100 {
		t.Fatalf("normalized model count = %d, want 100", len(models))
	}
	for i, model := range models {
		wantID := fmt.Sprintf("provider/model-%03d", i+1)
		if model.ID != wantID || model.IsDefault {
			t.Fatalf("models[%d] = %+v, want %s", i, model, wantID)
		}
	}
}

func TestNormalizeRuntimeModelsSkipsInvalidAndDuplicateDefaults(t *testing.T) {
	tooLong := strings.Repeat("a", 161)
	catalog := []native.ModelOption{
		{ID: "non-default-1", Label: "First"},
		{ID: "gw/model", Label: "Shadowed non-default"},
		{ID: "   ", Label: "Blank default", Default: true},
		{ID: tooLong, Label: "Overlong default", Default: true},
		{ID: "gw/model", Label: "Primary default", Default: true, ContextWindow: 1_048_576},
		{ID: " gw/model ", Label: "Duplicate default", Default: true, ContextWindow: 200_000},
		{ID: "non-default-2", Label: "Second"},
		{ID: "non-default-1", Label: "Duplicate non-default"},
	}
	snapshot := append([]native.ModelOption(nil), catalog...)

	models := normalizeRuntimeModels(catalog)
	if !reflect.DeepEqual(catalog, snapshot) {
		t.Fatal("input catalog was mutated")
	}
	want := []RuntimeModel{
		{ID: "gw/model", Label: "Primary default", AllowedReasoningEffort: []string{}, ContextWindow: 1_048_576, IsDefault: true},
		{ID: "non-default-1", Label: "First", AllowedReasoningEffort: []string{}},
		{ID: "non-default-2", Label: "Second", AllowedReasoningEffort: []string{}},
	}
	if !reflect.DeepEqual(models, want) {
		t.Fatalf("models = %+v, want %+v", models, want)
	}
}

func TestDiscoverClaudeVersionProbeDisablesNonessentialTraffic(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	root := t.TempDir()
	claude := filepath.Join(root, "claude")
	script := `#!/bin/sh
if [ "$CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" != "1" ]; then
  echo "missing CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" >&2
  exit 11
fi
case "$1" in
  --version) echo "2.1.309 (Claude Code)" ;;
  auth) echo '{"loggedIn":false}'; exit 1 ;;
  *) exit 2 ;;
esac
`
	if err := os.WriteFile(claude, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	callerEnv := map[string]string{"PATH": root, "HOME": root}
	result, err := Discover(context.Background(), DiscoveryOptions{
		ConfiguredPaths: map[string]string{"claude": claude},
		Runtimes:        []string{"claude"},
		Environment:     callerEnv,
		Timeout:         5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Diagnostics) != 1 || result.Diagnostics[0].Version != "2.1.309 (Claude Code)" {
		t.Fatalf("Claude diagnostic = %+v, want version 2.1.309 (Claude Code)", result.Diagnostics)
	}
	if _, mutated := callerEnv["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]; mutated {
		t.Fatal("Discover mutated caller environment map")
	}
}

// firstCandidateEntry is the entry discovery probes first, or "" when none.
func firstCandidateEntry(t *testing.T, kind, name string, options DiscoveryOptions) string {
	t.Helper()
	candidates := resolveExecutableCandidates(t.Context(), kind, name, options)
	if len(candidates) == 0 {
		return ""
	}
	return candidates[0].entry
}

func TestResolveExecutableCandidatesBundledPathsPrecedenceAndFallback(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses POSIX executable permissions")
	}
	root := t.TempDir()
	home := filepath.Join(root, "home")
	userBin := filepath.Join(root, "user-bin")
	emptyBin := filepath.Join(root, "empty-bin")
	bundledBin := filepath.Join(root, "bundled-bin")
	for _, dir := range []string{home, userBin, emptyBin, bundledBin} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	userPi := filepath.Join(userBin, "pi")
	bundledPi := filepath.Join(bundledBin, "pi")
	configuredPi := filepath.Join(root, "configured-pi")
	for _, file := range []string{userPi, bundledPi, configuredPi} {
		if err := os.WriteFile(file, []byte("#!/bin/sh\n"), 0o700); err != nil {
			t.Fatal(err)
		}
	}

	// User PATH beats BundledPaths.
	got := firstCandidateEntry(t, "pi", "pi", DiscoveryOptions{
		BundledPaths: map[string]string{"pi": bundledPi},
		Environment:  map[string]string{"PATH": userBin, "HOME": home},
	})
	if got != userPi {
		t.Fatalf("user PATH vs bundled: got %q; want %q", got, userPi)
	}

	// BundledPaths is used when PATH has no pi.
	got = firstCandidateEntry(t, "pi", "pi", DiscoveryOptions{
		BundledPaths: map[string]string{"pi": bundledPi},
		Environment:  map[string]string{"PATH": emptyBin, "HOME": home},
	})
	if got != bundledPi {
		t.Fatalf("empty PATH fallback to bundled: got %q; want %q", got, bundledPi)
	}

	// Valid ConfiguredPaths without managed or bundled paths is exclusive.
	if all := resolveExecutableCandidates(t.Context(), "pi", "pi", DiscoveryOptions{
		ConfiguredPaths: map[string]string{"pi": configuredPi},
		Environment:     map[string]string{"PATH": userBin, "HOME": home},
	}); len(all) != 1 || all[0].entry != configuredPi || all[0].source != "configured" {
		t.Fatalf("exclusive configured path: got %+v; want only %q", all, configuredPi)
	}

	// Valid ConfiguredPaths beats both PATH and BundledPaths.
	got = firstCandidateEntry(t, "pi", "pi", DiscoveryOptions{
		ConfiguredPaths: map[string]string{"pi": configuredPi},
		BundledPaths:    map[string]string{"pi": bundledPi},
		Environment:     map[string]string{"PATH": userBin, "HOME": home},
	})
	if got != configuredPi {
		t.Fatalf("valid configured vs PATH/bundled: got %q; want %q", got, configuredPi)
	}

	// Stale ConfiguredPaths["pi"] falls back to PATH first, then BundledPaths.
	stalePi := filepath.Join(root, "moved-app", "pi")
	got = firstCandidateEntry(t, "pi", "pi", DiscoveryOptions{
		ConfiguredPaths: map[string]string{"pi": stalePi},
		BundledPaths:    map[string]string{"pi": bundledPi},
		Environment:     map[string]string{"PATH": userBin, "HOME": home},
	})
	if got != userPi {
		t.Fatalf("stale configured fallback to PATH: got %q; want %q", got, userPi)
	}
	got = firstCandidateEntry(t, "pi", "pi", DiscoveryOptions{
		ConfiguredPaths: map[string]string{"pi": stalePi},
		BundledPaths:    map[string]string{"pi": bundledPi},
		Environment:     map[string]string{"PATH": emptyBin, "HOME": home},
	})
	if got != bundledPi {
		t.Fatalf("stale configured fallback to bundled: got %q; want %q", got, bundledPi)
	}

	// Dangling symlink in ConfiguredPaths["pi"] also falls back to PATH first, then BundledPaths.
	danglingPi := filepath.Join(root, "dangling-pi")
	if err := os.Symlink(stalePi, danglingPi); err != nil {
		t.Fatal(err)
	}
	got = firstCandidateEntry(t, "pi", "pi", DiscoveryOptions{
		ConfiguredPaths: map[string]string{"pi": danglingPi},
		BundledPaths:    map[string]string{"pi": bundledPi},
		Environment:     map[string]string{"PATH": userBin, "HOME": home},
	})
	if got != userPi {
		t.Fatalf("dangling symlink configured fallback to PATH: got %q; want %q", got, userPi)
	}
	got = firstCandidateEntry(t, "pi", "pi", DiscoveryOptions{
		ConfiguredPaths: map[string]string{"pi": danglingPi},
		BundledPaths:    map[string]string{"pi": bundledPi},
		Environment:     map[string]string{"PATH": emptyBin, "HOME": home},
	})
	if got != bundledPi {
		t.Fatalf("dangling symlink configured fallback to bundled: got %q; want %q", got, bundledPi)
	}

	// Missing ConfiguredPaths for a non-bundled runtime stays exclusive: no
	// candidate, so diagnose reports not_installed instead of silently using PATH.
	staleCodex := filepath.Join(root, "missing-codex")
	userCodex := filepath.Join(userBin, "codex")
	if err := os.WriteFile(userCodex, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	got = firstCandidateEntry(t, "codex", "codex", DiscoveryOptions{
		ConfiguredPaths: map[string]string{"codex": staleCodex},
		BundledPaths:    map[string]string{"pi": bundledPi},
		Environment:     map[string]string{"PATH": userBin, "HOME": home},
	})
	if got != "" {
		t.Fatalf("missing non-bundled configured path fell back to %q", got)
	}
}

func TestResolveExecutableCandidatesManagedPathsPrecedenceAndFallback(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses POSIX executable permissions")
	}
	root := t.TempDir()
	home := filepath.Join(root, "home")
	userBin := filepath.Join(root, "user-bin")
	emptyBin := filepath.Join(root, "empty-bin")
	managedBin := filepath.Join(root, "managed-bin")
	bundledBin := filepath.Join(root, "bundled-bin")
	for _, dir := range []string{home, userBin, emptyBin, managedBin, bundledBin} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	userPi := filepath.Join(userBin, "pi")
	managedPi := filepath.Join(managedBin, "pi")
	bundledPi := filepath.Join(bundledBin, "pi")
	configuredPi := filepath.Join(root, "configured-pi")
	for _, file := range []string{userPi, managedPi, bundledPi, configuredPi} {
		if err := os.WriteFile(file, []byte("#!/bin/sh\n"), 0o700); err != nil {
			t.Fatal(err)
		}
	}

	// Valid ConfiguredPaths leads PATH, ManagedPaths, and BundledPaths, which
	// stay behind it as fallbacks.
	all := resolveExecutableCandidates(t.Context(), "pi", "pi", DiscoveryOptions{
		ConfiguredPaths: map[string]string{"pi": configuredPi},
		ManagedPaths:    map[string]string{"pi": managedPi},
		BundledPaths:    map[string]string{"pi": bundledPi},
		Environment:     map[string]string{"PATH": userBin, "HOME": home},
	})
	var entries, sources []string
	for _, candidate := range all {
		entries = append(entries, candidate.entry)
		sources = append(sources, candidate.source)
	}
	if want := []string{configuredPi, userPi, managedPi, bundledPi}; !slices.Equal(entries, want) {
		t.Fatalf("configured vs PATH/managed/bundled: got %q; want %q", entries, want)
	}
	if want := []string{"configured", "path", "managed", "bundled"}; !slices.Equal(sources, want) {
		t.Fatalf("candidate sources = %q; want %q", sources, want)
	}

	// The same file reached twice is probed once, at its higher priority.
	if err := os.Symlink(managedPi, filepath.Join(emptyBin, "pi")); err != nil {
		t.Fatal(err)
	}
	all = resolveExecutableCandidates(t.Context(), "pi", "pi", DiscoveryOptions{
		ManagedPaths: map[string]string{"pi": managedPi},
		Environment:  map[string]string{"PATH": emptyBin, "HOME": home},
	})
	if len(all) != 1 || all[0].entry != filepath.Join(emptyBin, "pi") || all[0].source != "path" {
		t.Fatalf("duplicate canonical candidates = %+v; want one PATH entry", all)
	}
	if err := os.Remove(filepath.Join(emptyBin, "pi")); err != nil {
		t.Fatal(err)
	}

	// User PATH beats ManagedPaths and BundledPaths.
	got := firstCandidateEntry(t, "pi", "pi", DiscoveryOptions{
		ManagedPaths: map[string]string{"pi": managedPi},
		BundledPaths: map[string]string{"pi": bundledPi},
		Environment:  map[string]string{"PATH": userBin, "HOME": home},
	})
	if got != userPi {
		t.Fatalf("user PATH vs managed/bundled: got %q; want %q", got, userPi)
	}

	// ManagedPaths beats BundledPaths when user PATH has no pi.
	got = firstCandidateEntry(t, "pi", "pi", DiscoveryOptions{
		ManagedPaths: map[string]string{"pi": managedPi},
		BundledPaths: map[string]string{"pi": bundledPi},
		Environment:  map[string]string{"PATH": emptyBin, "HOME": home},
	})
	if got != managedPi {
		t.Fatalf("managed vs bundled on empty PATH: got %q; want %q", got, managedPi)
	}

	// Stale ManagedPaths falls through to BundledPaths.
	staleManagedPi := filepath.Join(root, "missing-managed", "pi")
	got = firstCandidateEntry(t, "pi", "pi", DiscoveryOptions{
		ManagedPaths: map[string]string{"pi": staleManagedPi},
		BundledPaths: map[string]string{"pi": bundledPi},
		Environment:  map[string]string{"PATH": emptyBin, "HOME": home},
	})
	if got != bundledPi {
		t.Fatalf("stale managed fallback to bundled: got %q; want %q", got, bundledPi)
	}

	// Stale ConfiguredPaths falls back through PATH -> ManagedPaths -> BundledPaths.
	staleConfiguredPi := filepath.Join(root, "missing-configured", "pi")
	got = firstCandidateEntry(t, "pi", "pi", DiscoveryOptions{
		ConfiguredPaths: map[string]string{"pi": staleConfiguredPi},
		ManagedPaths:    map[string]string{"pi": managedPi},
		BundledPaths:    map[string]string{"pi": bundledPi},
		Environment:     map[string]string{"PATH": userBin, "HOME": home},
	})
	if got != userPi {
		t.Fatalf("stale configured fallback to PATH: got %q; want %q", got, userPi)
	}
	got = firstCandidateEntry(t, "pi", "pi", DiscoveryOptions{
		ConfiguredPaths: map[string]string{"pi": staleConfiguredPi},
		ManagedPaths:    map[string]string{"pi": managedPi},
		BundledPaths:    map[string]string{"pi": bundledPi},
		Environment:     map[string]string{"PATH": emptyBin, "HOME": home},
	})
	if got != managedPi {
		t.Fatalf("stale configured fallback to managed: got %q; want %q", got, managedPi)
	}
	got = firstCandidateEntry(t, "pi", "pi", DiscoveryOptions{
		ConfiguredPaths: map[string]string{"pi": staleConfiguredPi},
		ManagedPaths:    map[string]string{"pi": managedPi},
		Environment:     map[string]string{"PATH": emptyBin, "HOME": home},
	})
	if got != managedPi {
		t.Fatalf("stale configured fallback to managed without bundled: got %q; want %q", got, managedPi)
	}
	got = firstCandidateEntry(t, "pi", "pi", DiscoveryOptions{
		ConfiguredPaths: map[string]string{"pi": staleConfiguredPi},
		ManagedPaths:    map[string]string{"pi": staleManagedPi},
		BundledPaths:    map[string]string{"pi": bundledPi},
		Environment:     map[string]string{"PATH": emptyBin, "HOME": home},
	})
	if got != bundledPi {
		t.Fatalf("stale configured and managed fallback to bundled: got %q; want %q", got, bundledPi)
	}
}

func TestValidRuntimeReasoningEffortAndLegacyFilter(t *testing.T) {
	for _, valid := range []string{"none", "minimal", "off", "low", "medium", "high", "xhigh", "max", "ultra", "custom_2", "tier-1", "a1234567890123456789"} {
		if !ValidRuntimeReasoningEffort(valid) {
			t.Fatalf("ValidRuntimeReasoningEffort(%q) = false, want true", valid)
		}
	}
	for _, invalid := range []string{"", "-minimal", "_minimal", "bad effort", "high!", "a12345678901234567890"} {
		if ValidRuntimeReasoningEffort(invalid) {
			t.Fatalf("ValidRuntimeReasoningEffort(%q) = true, want false", invalid)
		}
	}

	legacyOnly := []RuntimeDiagnostic{{
		Type: "codex", Status: "ready",
		Models: []RuntimeModel{{
			ID:                     "gpt-5",
			Label:                  "GPT-5",
			AllowedReasoningEffort: []string{"low", "medium", "high"},
			DefaultReasoningEffort: "medium",
		}},
	}}
	if _, changed := FilterLegacyReasoningEfforts(legacyOnly); changed {
		t.Fatal("legacy-only diagnostics reported changed")
	}

	dynamic := []RuntimeDiagnostic{{
		Type: "codex", Status: "ready",
		Models: []RuntimeModel{{
			ID:                     "gpt-5",
			Label:                  "GPT-5",
			AllowedReasoningEffort: []string{"minimal", "low", "high", "custom_2"},
			DefaultReasoningEffort: "minimal",
		}},
	}}
	filtered, changed := FilterLegacyReasoningEfforts(dynamic)
	if !changed {
		t.Fatal("dynamic diagnostics were not filtered")
	}
	if !reflect.DeepEqual(filtered[0].Models[0].AllowedReasoningEffort, []string{"low", "high"}) {
		t.Fatalf("filtered allowed = %v, want [low high]", filtered[0].Models[0].AllowedReasoningEffort)
	}
	if filtered[0].Models[0].DefaultReasoningEffort != "" {
		t.Fatalf("filtered default = %q, want empty", filtered[0].Models[0].DefaultReasoningEffort)
	}
	if !reflect.DeepEqual(dynamic[0].Models[0].AllowedReasoningEffort, []string{"minimal", "low", "high", "custom_2"}) {
		t.Fatalf("FilterLegacyReasoningEfforts mutated input: %v", dynamic[0].Models[0].AllowedReasoningEffort)
	}
}

func TestNormalizeRuntimeModelsCapsReasoningEffortsAt32(t *testing.T) {
	options := make([]native.EffortOption, 0, 40)
	for i := range 40 {
		options = append(options, native.EffortOption{Value: fmt.Sprintf("tier_%02d", i)})
	}
	models := normalizeRuntimeModels([]native.ModelOption{{
		ID:      "gpt-many-efforts",
		Label:   "GPT Many Efforts",
		Default: true,
		Effort: &native.EffortSupport{
			Options: options,
			Default: "tier_35",
		},
	}})
	if len(models) != 1 {
		t.Fatalf("models count = %d, want 1", len(models))
	}
	if len(models[0].AllowedReasoningEffort) != MaxRuntimeModelReasoningEfforts {
		t.Fatalf("allowed efforts len = %d, want %d", len(models[0].AllowedReasoningEffort), MaxRuntimeModelReasoningEfforts)
	}
	if models[0].DefaultReasoningEffort != "" {
		t.Fatalf("default effort outside capped 32 = %q, want empty", models[0].DefaultReasoningEffort)
	}
	if !ValidRuntimeModel(models[0]) {
		t.Fatalf("normalized capped model failed ValidRuntimeModel: %+v", models[0])
	}

	overLimit := models[0]
	overLimit.AllowedReasoningEffort = append(append([]string(nil), models[0].AllowedReasoningEffort...), "tier_32")
	if ValidRuntimeModel(overLimit) {
		t.Fatal("ValidRuntimeModel accepted 33 allowed reasoning efforts")
	}
}

func writeFakePiScript(t *testing.T, target, version string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		t.Fatal(err)
	}
	script := fmt.Sprintf(`#!/bin/sh
if [ "$1" = "--version" ]; then echo '%s'; exit 0; fi
if [ "$1" = "auth" ]; then
  echo '{"status":"ready"}'
  exit 0
fi
if [ "$1" = "--mode" ] && [ "$2" = "rpc" ]; then
  while IFS= read -r line; do
    case "$line" in
    *linger-probe*)
      echo '{"type":"response","id":"linger-probe","command":"get_state","success":true,"data":{"isStreaming":false,"model":{"provider":"fixture","id":"model"},"thinkingLevel":"high"}}' ;;
    *linger-models*)
      echo '{"type":"response","id":"linger-models","command":"get_available_models","success":true,"data":{"models":[{"provider":"fixture","id":"model","name":"Fixture Model","reasoning":true,"contextWindow":128000}]}}' ;;
    esac
  done
  exit 0
fi
exit 2
`, version)
	if err := os.WriteFile(target, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
}

func writeMiseShimPi(t *testing.T, shimPath, targetPath string) {
	t.Helper()
	for _, dir := range []string{filepath.Dir(shimPath), filepath.Dir(targetPath)} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "2026.1.0 macos-arm64 (2026-01-01)"
  exit 0
fi
echo "Usage: mise [OPTIONS] [COMMAND]" >&2
echo "error: unexpected argument '--mode' found" >&2
exit 2
`
	if err := os.WriteFile(targetPath, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(targetPath, shimPath); err != nil {
		t.Fatal(err)
	}
}

func TestDiscoverSkipsIncompatiblePathShimAndFallsBackToBundledPi(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses POSIX scripts and symlinks")
	}
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	root := t.TempDir()
	home := filepath.Join(root, "users", "person")
	shimDir := filepath.Join(home, ".local", "share", "mise", "shims")
	shimPi := filepath.Join(shimDir, "pi")
	miseTarget := filepath.Join(root, "homebrew", "Cellar", "mise", "2026.1.0", "bin", "mise")
	writeMiseShimPi(t, shimPi, miseTarget)

	bundledPi := filepath.Join(root, "app", "bundled-pi", "pi")
	writeFakePiScript(t, bundledPi, "1.5.2")

	result, err := Discover(context.Background(), DiscoveryOptions{
		Runtimes:     []string{"pi"},
		BundledPaths: map[string]string{"pi": bundledPi},
		Environment:  map[string]string{"PATH": shimDir, "HOME": home},
		Timeout:      5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Diagnostics) != 1 {
		t.Fatalf("diagnostics len = %d, want 1", len(result.Diagnostics))
	}
	got := result.Diagnostics[0]
	canonicalBundled, err := filepath.EvalSymlinks(bundledPi)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "ready" || got.Version != "1.5.2" || got.ExecutablePath != canonicalBundled || got.EntryPath != bundledPi {
		t.Fatalf("pi diagnostic = %+v, want ready 1.5.2 at %s", got, canonicalBundled)
	}
	if inst, ok := result.Installations["pi"]; !ok || inst.ExecutablePath != canonicalBundled {
		t.Fatalf("Installations[pi] = %+v (ok=%v), want %s", inst, ok, canonicalBundled)
	}
	logText := logs.String()
	for _, want := range []string{
		`"msg":"runner.runtime_discovery.candidate_skipped"`,
		`"runtime_type":"pi"`,
		`"source":"path"`,
		`"entry":"~/.local/share/mise/shims/pi"`,
		`"code":"RUNTIME_INCOMPATIBLE"`,
		`"remaining_candidates":1`,
	} {
		if !strings.Contains(logText, want) {
			t.Fatalf("logs missing %s:\n%s", want, logText)
		}
	}
	if strings.Contains(logText, home) {
		t.Fatalf("candidate_skipped log leaked user home path %q:\n%s", home, logText)
	}
}

func TestDiscoverFallsBackAcrossPathAndManagedCandidatesAndPreservesFirstFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses POSIX scripts and symlinks")
	}

	t.Run("broken first PATH entry falls back to second PATH candidate before bundled", func(t *testing.T) {
		root := t.TempDir()
		home := filepath.Join(root, "home")
		badDir := filepath.Join(root, "bad-bin")
		goodDir := filepath.Join(root, "good-bin")
		for _, dir := range []string{home, badDir} {
			if err := os.MkdirAll(dir, 0o700); err != nil {
				t.Fatal(err)
			}
		}
		if err := os.WriteFile(filepath.Join(badDir, "pi"), []byte("#!/bin/sh\nexit 1\n"), 0o700); err != nil {
			t.Fatal(err)
		}
		secondPathPi := filepath.Join(goodDir, "pi")
		writeFakePiScript(t, secondPathPi, "1.3.0")
		bundledPi := filepath.Join(root, "bundled", "pi")
		writeFakePiScript(t, bundledPi, "1.5.2")

		result, err := Discover(context.Background(), DiscoveryOptions{
			Runtimes:     []string{"pi"},
			BundledPaths: map[string]string{"pi": bundledPi},
			Environment:  map[string]string{"PATH": badDir + string(os.PathListSeparator) + goodDir, "HOME": home},
			Timeout:      5 * time.Second,
		})
		if err != nil {
			t.Fatal(err)
		}
		canonicalSecond, err := filepath.EvalSymlinks(secondPathPi)
		if err != nil {
			t.Fatal(err)
		}
		got := result.Diagnostics[0]
		if got.Status != "ready" || got.Version != "1.3.0" || got.ExecutablePath != canonicalSecond {
			t.Fatalf("pi diagnostic = %+v, want second PATH candidate %s (1.3.0)", got, canonicalSecond)
		}
	})

	t.Run("valid PATH candidate still takes precedence over managed and bundled", func(t *testing.T) {
		root := t.TempDir()
		home := filepath.Join(root, "home")
		if err := os.MkdirAll(home, 0o700); err != nil {
			t.Fatal(err)
		}
		userDir := filepath.Join(root, "user-bin")
		userPi := filepath.Join(userDir, "pi")
		writeFakePiScript(t, userPi, "1.3.0")
		managedPi := filepath.Join(root, "managed", "pi")
		writeFakePiScript(t, managedPi, "1.6.0")
		bundledPi := filepath.Join(root, "bundled", "pi")
		writeFakePiScript(t, bundledPi, "1.5.2")

		result, err := Discover(context.Background(), DiscoveryOptions{
			Runtimes:     []string{"pi"},
			ManagedPaths: map[string]string{"pi": managedPi},
			BundledPaths: map[string]string{"pi": bundledPi},
			Environment:  map[string]string{"PATH": userDir, "HOME": home},
			Timeout:      5 * time.Second,
		})
		if err != nil {
			t.Fatal(err)
		}
		canonicalUser, err := filepath.EvalSymlinks(userPi)
		if err != nil {
			t.Fatal(err)
		}
		got := result.Diagnostics[0]
		if got.Status != "ready" || got.Version != "1.3.0" || got.ExecutablePath != canonicalUser {
			t.Fatalf("pi diagnostic = %+v, want user PATH candidate %s", got, canonicalUser)
		}
	})

	t.Run("incompatible PATH shim falls back to managed Pi before bundled Pi", func(t *testing.T) {
		root := t.TempDir()
		home := filepath.Join(root, "home")
		if err := os.MkdirAll(home, 0o700); err != nil {
			t.Fatal(err)
		}
		shimDir := filepath.Join(root, "shims")
		writeMiseShimPi(t, filepath.Join(shimDir, "pi"), filepath.Join(root, "mise", "bin", "mise"))
		managedPi := filepath.Join(root, "managed", "pi")
		writeFakePiScript(t, managedPi, "1.6.0")
		bundledPi := filepath.Join(root, "bundled", "pi")
		writeFakePiScript(t, bundledPi, "1.5.2")

		result, err := Discover(context.Background(), DiscoveryOptions{
			Runtimes:     []string{"pi"},
			ManagedPaths: map[string]string{"pi": managedPi},
			BundledPaths: map[string]string{"pi": bundledPi},
			Environment:  map[string]string{"PATH": shimDir, "HOME": home},
			Timeout:      5 * time.Second,
		})
		if err != nil {
			t.Fatal(err)
		}
		canonicalManaged, err := filepath.EvalSymlinks(managedPi)
		if err != nil {
			t.Fatal(err)
		}
		got := result.Diagnostics[0]
		if got.Status != "ready" || got.Version != "1.6.0" || got.ExecutablePath != canonicalManaged {
			t.Fatalf("pi diagnostic = %+v, want managed candidate %s", got, canonicalManaged)
		}
	})

	t.Run("all incompatible candidates preserve highest-priority failure diagnostic", func(t *testing.T) {
		root := t.TempDir()
		home := filepath.Join(root, "home")
		if err := os.MkdirAll(home, 0o700); err != nil {
			t.Fatal(err)
		}
		shimDir := filepath.Join(root, "shims")
		miseTarget := filepath.Join(root, "mise", "bin", "mise")
		writeMiseShimPi(t, filepath.Join(shimDir, "pi"), miseTarget)
		oldBundled := filepath.Join(root, "bundled", "pi")
		writeFakePiScript(t, oldBundled, "0.5.0")

		result, err := Discover(context.Background(), DiscoveryOptions{
			Runtimes:     []string{"pi"},
			BundledPaths: map[string]string{"pi": oldBundled},
			Environment:  map[string]string{"PATH": shimDir, "HOME": home},
			Timeout:      5 * time.Second,
		})
		if err != nil {
			t.Fatal(err)
		}
		canonicalMise, err := filepath.EvalSymlinks(miseTarget)
		if err != nil {
			t.Fatal(err)
		}
		got := result.Diagnostics[0]
		if got.Status != "incompatible" || got.Error == nil || got.Error.Code != "RUNTIME_INCOMPATIBLE" || got.ExecutablePath != canonicalMise {
			t.Fatalf("pi diagnostic = %+v, want highest-priority incompatible %s", got, canonicalMise)
		}
	})
}
