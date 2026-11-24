package provider

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

func TestRuntimeMonitorBoundsTransientAuthenticationProbeFailures(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	// Every scenario runs one shared executable: macOS scans each new
	// executable on its first launch.
	fixtures := t.TempDir()
	codex := filepath.Join(fixtures, "codex")
	script := `#!/bin/sh
attempt=0
if [ -f "$ATTEMPT_FILE" ]; then read attempt < "$ATTEMPT_FILE"; fi
attempt=$((attempt + 1))
echo "$attempt" > "$ATTEMPT_FILE"
if [ "$attempt" -le "$FAILURES" ] && [ "$PROBE_EXIT" != "1" ]; then echo "$PROBE_OUTPUT"; exit "$PROBE_EXIT"; fi
read initialize
echo '{"id":1,"result":{"userAgent":"test"}}'
read initialized
read account
if [ "$attempt" -le "$FAILURES" ]; then
  echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":true}}'
else
  echo '{"id":2,"result":{"account":{"type":"chatgpt"},"requiresOpenaiAuth":true}}'
fi
`
	if err := os.WriteFile(codex, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	primeTestExecutable(t, codex, "ATTEMPT_FILE="+filepath.Join(fixtures, "prime-attempt"))
	for _, scenario := range []struct {
		name     string
		failures string
		exitCode string
		output   string
		busy     bool
		want     []string
	}{
		{name: "one transient failure", failures: "1", exitCode: "2", output: "probe unavailable", want: nil},
		{name: "sustained probe failure", failures: "9", exitCode: "2", output: "probe unavailable", want: []string{"error", "ready"}},
		{name: "actual logout", failures: "9", exitCode: "1", output: "Not logged in", want: []string{"authentication_required", "ready"}},
		{name: "sustained probe failure while busy", failures: "9", exitCode: "2", output: "probe unavailable", busy: true, want: nil},
		{name: "actual logout while busy", failures: "9", exitCode: "1", output: "Not logged in", busy: true, want: []string{"authentication_required", "ready"}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			root := t.TempDir()
			initial := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{
				Type: "codex", Status: "ready", Protocol: "app-server", ExecutablePath: codex,
			}}}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var states []string
			err := MonitorRuntimeDiagnostics(ctx, RuntimeMonitorOptions{
				Initial: initial, RefreshInterval: 10 * time.Millisecond, FullRefreshEveryTicks: 4,
				Discovery: DiscoveryOptions{Timeout: 10 * time.Second, Environment: map[string]string{
					"HOME": root, "ATTEMPT_FILE": filepath.Join(root, "attempt"), "FAILURES": scenario.failures,
					"PROBE_EXIT": scenario.exitCode, "PROBE_OUTPUT": scenario.output,
				}},
				Discover: func(context.Context, DiscoveryOptions) (DiscoveryResult, error) {
					cancel()
					return initial, nil
				},
				RuntimeBusy: func() bool { return scenario.busy },
				OnChanged: func(result DiscoveryResult) error {
					states = append(states, result.Diagnostics[0].Status)
					return nil
				},
			})
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("monitor did not complete the refresh cycle: %v", err)
			}
			if !reflect.DeepEqual(states, scenario.want) {
				t.Fatalf("published states = %v, want %v", states, scenario.want)
			}
		})
	}
}

func TestRuntimeMonitorRecoversCodexAuthenticationWithoutRestart(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	root := t.TempDir()
	codex := filepath.Join(root, "codex")
	loginMarker := filepath.Join(root, "logged-in")
	protocolCount := filepath.Join(root, "protocol-count")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.171.0"; exit 0; fi
echo called >> "$PROTOCOL_COUNT"
read line
echo '{"jsonrpc":"2.0","id":1,"result":{"userAgent":"codex-test"}}'
if read initialized && read account; then
  case "$account" in
    *'"method":"model/list"'*)
      echo '{"id":2,"result":{"data":[{"id":"fixture-model","model":"fixture-model","displayName":"Fixture model","isDefault":true,"supportedReasoningEfforts":[]}]}}'
      exit 0 ;;
  esac
  if [ -f "$LOGIN_MARKER" ]; then
    echo '{"id":2,"result":{"account":{"type":"chatgpt"},"requiresOpenaiAuth":true}}'
  else
    echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":true}}'
  fi
fi
`
	if err := os.WriteFile(codex, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	discovery := DiscoveryOptions{
		ConfiguredPaths: map[string]string{"codex": codex},
		Environment: map[string]string{
			"PATH": root, "HOME": root, "LOGIN_MARKER": loginMarker, "PROTOCOL_COUNT": protocolCount,
		},
		Timeout: 10 * time.Second,
	}
	initial, err := Discover(context.Background(), discovery)
	if err != nil || initial.Diagnostics[0].Status != "authentication_required" {
		t.Fatalf("initial discovery = %+v err=%v", initial, err)
	}
	if err := os.WriteFile(loginMarker, []byte("ready"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	changed := make(chan DiscoveryResult, 1)
	err = MonitorRuntimeDiagnostics(ctx, RuntimeMonitorOptions{
		Initial: initial, Discovery: discovery, RefreshInterval: 10 * time.Millisecond,
		FullRefreshEveryTicks: 100,
		OnChanged: func(result DiscoveryResult) error {
			changed <- result
			cancel()
			return nil
		},
	})
	if err != nil && !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	select {
	case result := <-changed:
		if result.Diagnostics[0].Status != "ready" {
			t.Fatalf("refreshed discovery = %+v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("Runtime authentication recovery was not published")
	}
	data, err := os.ReadFile(protocolCount)
	if err != nil || string(data) != "called\ncalled\ncalled\ncalled\n" {
		t.Fatalf("protocol probes = %q err=%v, want initial handshake, account, catalog, and refreshed account", data, err)
	}
}

func TestRuntimeMonitorPublishesCatalogFailureImmediately(t *testing.T) {
	initial := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{Type: "codex", Status: "ready", Models: []RuntimeModel{{ID: "deepseek-v4.1-flash"}}}}}
	invalid := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{Type: "codex", Status: "error", Models: []RuntimeModel{}, ModelCatalogError: "Configured Codex model catalog is missing or unreadable", Error: &DiagnosticError{Code: "RUNTIME_DIAGNOSTIC_FAILED"}}}}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	calls := 0
	var published DiscoveryResult
	err := MonitorRuntimeDiagnostics(ctx, RuntimeMonitorOptions{
		Initial: initial, RefreshInterval: time.Millisecond, FullRefreshEveryTicks: 1,
		Discover: func(context.Context, DiscoveryOptions) (DiscoveryResult, error) {
			calls++
			return invalid, nil
		},
		OnChanged: func(result DiscoveryResult) error {
			published = result
			cancel()
			return nil
		},
	})
	if !errors.Is(err, context.Canceled) || calls != 1 || len(published.Diagnostics) != 1 || published.Diagnostics[0].Status != "error" || len(published.Diagnostics[0].Models) != 0 {
		t.Fatalf("catalog failure retained stale ready models: calls=%d result=%+v err=%v", calls, published, err)
	}
}

func TestRuntimeMonitorSkipsFullRefreshWhileOperationsAreActive(t *testing.T) {
	initial := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{
		Type: "codex", Status: "ready", Protocol: "app-server", Version: "codex-test",
	}}}
	fullRefreshes := 0
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	err := MonitorRuntimeDiagnostics(ctx, RuntimeMonitorOptions{
		Initial: initial, RefreshInterval: 5 * time.Millisecond, FullRefreshEveryTicks: 1,
		FullRefreshAllowed: func() bool { return false },
		Discover: func(context.Context, DiscoveryOptions) (DiscoveryResult, error) {
			fullRefreshes++
			return initial, nil
		},
		OnChanged: func(DiscoveryResult) error { return nil },
	})
	if err != nil && !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	if fullRefreshes != 0 {
		t.Fatalf("full refreshes = %d, want none while operations are active", fullRefreshes)
	}
}

// A long-running provider blocks full discovery; an authentication transport
// failure must still recover from its cached, previously verified executable.
func TestRuntimeMonitorRecoversFailedAuthenticationWhileOperationIsActive(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	root := t.TempDir()
	codex := filepath.Join(root, "codex")
	attemptFile := filepath.Join(root, "attempt")
	script := `#!/bin/sh
attempt=0
if [ -f "$ATTEMPT_FILE" ]; then read attempt < "$ATTEMPT_FILE"; fi
attempt=$((attempt + 1))
echo "$attempt" > "$ATTEMPT_FILE"
if [ "$attempt" -le 2 ]; then exit 2; fi
read initialize
echo '{"id":1,"result":{"userAgent":"test"}}'
read initialized
read account
echo '{"id":2,"result":{"account":{"type":"chatgpt"},"requiresOpenaiAuth":true}}'
`
	if err := os.WriteFile(codex, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	primeTestExecutable(t, codex, "ATTEMPT_FILE="+filepath.Join(root, "prime-attempt"))
	initial := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{Type: "codex", Status: "ready", Protocol: "app-server", Version: "0.100.0", ExecutablePath: codex}}}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	fullRefreshes := 0
	var states []string
	err := MonitorRuntimeDiagnostics(ctx, RuntimeMonitorOptions{
		Initial: initial, RefreshInterval: 10 * time.Millisecond, FullRefreshEveryTicks: 4,
		FullRefreshAllowed: func() bool { return false },
		Discovery:          DiscoveryOptions{Timeout: 10 * time.Second, Environment: map[string]string{"HOME": root, "ATTEMPT_FILE": attemptFile}},
		Discover:           func(context.Context, DiscoveryOptions) (DiscoveryResult, error) { fullRefreshes++; return initial, nil },
		OnChanged: func(result DiscoveryResult) error {
			states = append(states, result.Diagnostics[0].Status)
			if result.Diagnostics[0].Status == "ready" {
				cancel()
			}
			return nil
		},
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("monitor: %v", err)
	}
	if !reflect.DeepEqual(states, []string{"error", "ready"}) {
		t.Fatalf("states=%v", states)
	}
	if fullRefreshes != 0 {
		t.Fatalf("full refresh during operation: %d", fullRefreshes)
	}
	data, err := os.ReadFile(attemptFile)
	if err != nil || string(data) != "3\n" {
		t.Fatalf("attempts=%q err=%v", data, err)
	}
}

func TestAuthenticationRecoveryDoesNotReprobeIncompatibleRuntime(t *testing.T) {
	initial := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{Type: "codex", Status: "incompatible", ExecutablePath: "/absent", Error: &DiagnosticError{Code: "RUNTIME_INCOMPATIBLE"}}}}
	result, err := refreshRuntimeAuthentication(context.Background(), initial, DiscoveryOptions{}, true)
	if err != nil || result.Diagnostics[0].Status != "incompatible" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

func TestAuthenticationRecoveryDoesNotSkipFailedVersionProbe(t *testing.T) {
	initial := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{Type: "codex", Status: "error", Version: "0.100.0", ExecutablePath: "/absent", Error: &DiagnosticError{Code: "RUNTIME_DIAGNOSTIC_FAILED"}}}}
	result, err := refreshRuntimeAuthentication(context.Background(), initial, DiscoveryOptions{}, true)
	if err != nil || result.Diagnostics[0].Status != "error" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

// macOS assesses a newly written executable on its first exec, which can take
// seconds under load. Pay that once outside the budget under test; the env
// keeps the fixture's side effects away from the files it asserts on.
func primeTestExecutable(t *testing.T, path string, env ...string) {
	t.Helper()
	command := exec.Command(path)
	command.Env = env
	_ = command.Run()
}

func TestRuntimeMonitorRunsARequestedFullRefreshBeforeItsSchedule(t *testing.T) {
	initial := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{
		Type: "pi", Status: "ready", Protocol: "rpc", Version: "pi-test", Models: []RuntimeModel{},
	}}}
	loaded := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{
		Type: "pi", Status: "ready", Protocol: "rpc", Version: "pi-test", Models: []RuntimeModel{{ID: "local/qwen3-4b"}},
	}}}
	refresh := make(chan struct{}, 1)
	refresh <- struct{}{}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var published []DiscoveryResult
	err := MonitorRuntimeDiagnostics(ctx, RuntimeMonitorOptions{
		Initial: initial, RefreshInterval: time.Hour, FullRefreshEveryTicks: 4, Refresh: refresh,
		Discover: func(context.Context, DiscoveryOptions) (DiscoveryResult, error) { return loaded, nil },
		OnChanged: func(next DiscoveryResult) error {
			published = append(published, next)
			cancel()
			return nil
		},
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("monitor ended with %v before the requested refresh", err)
	}
	if len(published) != 1 || len(published[0].Diagnostics[0].Models) != 1 {
		t.Fatalf("published = %+v, want the refreshed Pi model list", published)
	}
}

func TestRuntimeMonitorAppliesShapeOnAuthAndFullRefreshes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell")
	}
	root := t.TempDir()
	piAgentDir := filepath.Join(root, ".pi", "agent")
	if err := os.MkdirAll(piAgentDir, 0o700); err != nil {
		t.Fatal(err)
	}
	var gatewayRequests atomic.Int32
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			http.NotFound(w, r)
			return
		}
		gatewayRequests.Add(1)
		_, _ = w.Write([]byte(`{"data":[{"id":"gw","context_window":1048576}]}`))
	}))
	defer gateway.Close()
	if err := os.WriteFile(filepath.Join(piAgentDir, "models.json"), []byte(fmt.Sprintf(`{"providers":{"localmodels":{"baseUrl":"%s/v1","apiKey":"test-key"}}}`, gateway.URL)), 0o600); err != nil {
		t.Fatal(err)
	}
	piExecutable := filepath.Join(root, "pi")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then echo '1.2.0'; exit 0; fi
if [ "$1" = "auth" ]; then echo '{"status":"ready"}'; exit 0; fi
while IFS= read -r line; do
  case "$line" in
  *linger-probe*) echo '{"type":"response","id":"linger-probe","command":"get_state","success":true,"data":{"isStreaming":false}}' ;;
  *linger-state*) echo '{"type":"response","id":"linger-state","command":"get_state","success":true,"data":{"model":{"provider":"localmodels","id":"gw"},"thinkingLevel":"off"}}' ;;
  *linger-models*) echo '{"type":"response","id":"linger-models","command":"get_available_models","success":true,"data":{"models":[{"provider":"builtin","id":"other"},{"provider":"localmodels","id":"gw"}]}}' ;;
  esac
done
`
	if err := os.WriteFile(piExecutable, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	primeTestExecutable(t, piExecutable)
	options := DiscoveryOptions{
		ConfiguredPaths: map[string]string{"pi": piExecutable},
		Runtimes:        []string{"pi"},
		Environment:     map[string]string{"HOME": root, "PATH": root, "PI_CODING_AGENT_DIR": piAgentDir},
		Timeout:         10 * time.Second,
	}
	shape := func(result DiscoveryResult) DiscoveryResult {
		diagnostics := append([]RuntimeDiagnostic(nil), result.Diagnostics...)
		for i := range diagnostics {
			for _, model := range diagnostics[i].Models {
				if model.ID == "localmodels/gw" {
					model.Label = "custom/gw"
					model.IsDefault = true
					diagnostics[i].Models = []RuntimeModel{model}
					break
				}
			}
		}
		return DiscoveryResult{Diagnostics: diagnostics, Installations: InstallationsFromDiagnostics(diagnostics)}
	}
	initial, err := Discover(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	initial = shape(initial)
	if len(initial.Diagnostics[0].Models) != 1 || initial.Diagnostics[0].Models[0].Link != linkAPI || initial.Diagnostics[0].Models[0].ContextWindow != 1_048_576 {
		t.Fatalf("initial = %+v", initial.Diagnostics[0])
	}
	if got := gatewayRequests.Load(); got != 1 {
		t.Fatalf("initial discovery gateway requests = %d, want 1", got)
	}
	// Steady-state auth refresh carries Link and ContextWindow forward without
	// querying the gateway's /models endpoint again.
	refreshed, err := RefreshRuntimeAuthentication(t.Context(), initial, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(refreshed.Diagnostics[0].Models) != 2 ||
		refreshed.Diagnostics[0].Models[0].ID != "localmodels/gw" ||
		refreshed.Diagnostics[0].Models[0].Link != linkAPI ||
		refreshed.Diagnostics[0].Models[0].ContextWindow != 1_048_576 ||
		refreshed.Diagnostics[0].Models[1].Link != linkSubscription {
		t.Fatalf("auth refresh models = %+v", refreshed.Diagnostics[0].Models)
	}
	if got := gatewayRequests.Load(); got != 1 {
		t.Fatalf("steady auth refresh hit gateway /models: requests = %d, want 1", got)
	}
	// When the previous diagnostic had no models (for example, Pi logged in
	// after starting signed out), auth refresh resolves Link and ContextWindow
	// for the newly observed gateway model.
	emptyPrev := initial
	emptyPrev.Diagnostics = []RuntimeDiagnostic{initial.Diagnostics[0]}
	emptyPrev.Diagnostics[0].Models = []RuntimeModel{}
	recovered, err := RefreshRuntimeAuthentication(t.Context(), emptyPrev, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(recovered.Diagnostics[0].Models) != 2 ||
		recovered.Diagnostics[0].Models[0].Link != linkAPI ||
		recovered.Diagnostics[0].Models[0].ContextWindow != 1_048_576 {
		t.Fatalf("newly observed model on auth refresh = %+v", recovered.Diagnostics[0].Models)
	}
	if got := gatewayRequests.Load(); got != 2 {
		t.Fatalf("auth refresh for newly observed gateway model requests = %d, want 2", got)
	}
	gatewayRequests.Store(1)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	shapeCalls := 0
	fullRefreshes := 0
	err = MonitorRuntimeDiagnostics(ctx, RuntimeMonitorOptions{
		Initial:               initial,
		Discovery:             options,
		RefreshInterval:       5 * time.Millisecond,
		FullRefreshEveryTicks: 2,
		Discover: func(ctx context.Context, opts DiscoveryOptions) (DiscoveryResult, error) {
			fullRefreshes++
			result, discoverErr := Discover(ctx, opts)
			if fullRefreshes >= 2 {
				cancel()
			}
			return result, discoverErr
		},
		Shape: func(result DiscoveryResult) DiscoveryResult {
			shapeCalls++
			return shape(result)
		},
		OnChanged: func(next DiscoveryResult) error {
			t.Fatalf("unexpected OnChanged when shaped diagnostics did not change: %+v", next.Diagnostics)
			return nil
		},
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("monitor exited with %v, want context.Canceled", err)
	}
	if shapeCalls < 3 {
		t.Fatalf("shapeCalls = %d, want at least 3 across auth and full refresh ticks", shapeCalls)
	}
	// Only initial discovery plus the full refreshes should query /v1/models;
	// auth-only ticks carry the gateway link and window forward.
	if got := int(gatewayRequests.Load()); got != 1+fullRefreshes {
		t.Fatalf("gateway /v1/models requests = %d, want %d (1 initial + %d full refreshes)", got, 1+fullRefreshes, fullRefreshes)
	}
}

func TestRuntimeMonitorSkipsAllRefreshesWhenRefreshDisallowed(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	root := t.TempDir()
	claude := filepath.Join(root, "claude")
	authTrace := filepath.Join(root, "auth-trace")
	script := `#!/bin/sh
echo called >> "$AUTH_TRACE"
echo '{"loggedIn":true}'
`
	if err := os.WriteFile(claude, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	primeTestExecutable(t, claude, "AUTH_TRACE="+os.DevNull)
	initial := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{
		Type: "claude", Status: "ready", Protocol: "stream-json", Version: "2.1.284", ExecutablePath: claude,
	}}}
	var allowed atomic.Bool
	var fullRefreshes atomic.Int32
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	err := MonitorRuntimeDiagnostics(ctx, RuntimeMonitorOptions{
		Initial: initial, RefreshInterval: 5 * time.Millisecond, FullRefreshEveryTicks: 2,
		RefreshAllowed: func() bool { return allowed.Load() },
		Discovery: DiscoveryOptions{
			Timeout: 5 * time.Second,
			Environment: map[string]string{
				"HOME": root, "CLAUDE_CONFIG_DIR": root, "ANTHROPIC_API_KEY": "fixture", "AUTH_TRACE": authTrace,
			},
		},
		Discover: func(context.Context, DiscoveryOptions) (DiscoveryResult, error) {
			fullRefreshes.Add(1)
			return initial, nil
		},
		OnChanged: func(DiscoveryResult) error { return nil },
	})
	if err != nil && !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	if fullRefreshes.Load() != 0 {
		t.Fatalf("full refreshes = %d, want 0 while refresh is disallowed", fullRefreshes.Load())
	}
	if data, readErr := os.ReadFile(authTrace); !errors.Is(readErr, os.ErrNotExist) {
		t.Fatalf("auth probe ran while refresh was disallowed: err=%v data=%q", readErr, data)
	}
}

// A Shape that fills a signed-out Pi's empty catalog with models no probe
// reports, as the Daemon does with local models, must not feed back into the
// authentication refreshes: Pi stays ready while the Shape adds a model, and
// returns to signed out on the next refresh once it stops.
func TestRuntimeMonitorProbesFromTheUnshapedResult(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell")
	}
	root := t.TempDir()
	piAgentDir := filepath.Join(root, ".pi", "agent")
	if err := os.MkdirAll(piAgentDir, 0o700); err != nil {
		t.Fatal(err)
	}
	piExecutable := filepath.Join(root, "pi")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then echo '1.2.0'; exit 0; fi
while IFS= read -r line; do
  case "$line" in
  *linger-probe*) echo '{"type":"response","id":"linger-probe","command":"get_state","success":true,"data":{"isStreaming":false}}' ;;
  *linger-state*) echo '{"type":"response","id":"linger-state","command":"get_state","success":true,"data":{"thinkingLevel":"off"}}' ;;
  *linger-models*) echo '{"type":"response","id":"linger-models","command":"get_available_models","success":true,"data":{"models":[]}}' ;;
  esac
done
`
	if err := os.WriteFile(piExecutable, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	primeTestExecutable(t, piExecutable)
	options := DiscoveryOptions{
		ConfiguredPaths: map[string]string{"pi": piExecutable},
		Runtimes:        []string{"pi"},
		Environment:     map[string]string{"HOME": root, "PATH": root, "PI_CODING_AGENT_DIR": piAgentDir},
		Timeout:         10 * time.Second,
	}
	initial, err := Discover(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	if initial.Diagnostics[0].Status != "authentication_required" || len(initial.Diagnostics[0].Models) != 0 {
		t.Fatalf("initial = %+v", initial.Diagnostics[0])
	}
	var library atomic.Bool
	library.Store(true)
	shapeCalls := 0
	shape := func(result DiscoveryResult) DiscoveryResult {
		shapeCalls++
		diagnostics := append([]RuntimeDiagnostic(nil), result.Diagnostics...)
		pi := &diagnostics[0]
		if library.Load() && pi.Status == "authentication_required" && len(pi.Models) == 0 {
			pi.Models = []RuntimeModel{{ID: "localmodels-library/m", AllowedReasoningEffort: []string{}}}
			pi.Status, pi.Error = "ready", nil
		}
		if shapeCalls == 6 {
			// The model left the library.
			library.Store(false)
		}
		return DiscoveryResult{Diagnostics: diagnostics, Installations: InstallationsFromDiagnostics(diagnostics)}
	}
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	var published []RuntimeDiagnostic
	err = MonitorRuntimeDiagnostics(ctx, RuntimeMonitorOptions{
		Initial:               initial,
		Discovery:             options,
		RefreshInterval:       5 * time.Millisecond,
		FullRefreshEveryTicks: 1_000_000,
		Discover: func(context.Context, DiscoveryOptions) (DiscoveryResult, error) {
			t.Fatal("only authentication refreshes run")
			return DiscoveryResult{}, nil
		},
		Shape: shape,
		OnChanged: func(next DiscoveryResult) error {
			published = append(published, next.Diagnostics[0])
			cancel()
			return nil
		},
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("monitor exited with %v", err)
	}
	if shapeCalls <= 6 {
		t.Fatalf("published before the model left the library: %+v", published)
	}
	if len(published) != 1 || published[0].Status != "authentication_required" || len(published[0].Models) != 0 {
		t.Fatalf("published = %+v", published)
	}
}

// Pi made ready only by a Shape (local models filling its empty catalog) is
// retained across a failed probe just like a natively ready Pi: the retain
// rules decide on what was published and restore the unshaped diagnostic.
func TestRetainRulesFollowThePublishedStatus(t *testing.T) {
	signedOut := RuntimeDiagnostic{Type: "pi", Status: "authentication_required", ExecutablePath: "/pi", Models: []RuntimeModel{},
		Error: &DiagnosticError{Code: "RUNTIME_AUTHENTICATION_REQUIRED"}}
	ready := RuntimeDiagnostic{Type: "pi", Status: "ready", ExecutablePath: "/pi", Models: []RuntimeModel{{ID: "lib/m", AllowedReasoningEffort: []string{}}}}
	failed := RuntimeDiagnostic{Type: "pi", Status: "error", ExecutablePath: "/pi", Models: []RuntimeModel{}, authProbeFailed: true,
		Error: &DiagnosticError{Code: "RUNTIME_DIAGNOSTIC_FAILED"}}
	result := func(diagnostic RuntimeDiagnostic) DiscoveryResult {
		return DiscoveryResult{Diagnostics: []RuntimeDiagnostic{diagnostic}}
	}
	for _, tc := range []struct {
		name               string
		current, published RuntimeDiagnostic
		want               string
	}{
		{"ready only through the Shape", signedOut, ready, "authentication_required"},
		{"natively ready", ready, ready, "ready"},
		{"signed out and published so", signedOut, signedOut, "error"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			busy := retainReadyRuntimesDuringInconclusiveProbes(result(tc.current), result(tc.published), result(failed))
			if got := busy.Diagnostics[0].Status; got != tc.want {
				t.Fatalf("inconclusive probe: status %s, want %s", got, tc.want)
			}
			transient := retainReadyRuntimesDuringTransientFailures(result(tc.current), result(tc.published), result(failed), map[string]int{})
			if got := transient.Diagnostics[0].Status; got != tc.want {
				t.Fatalf("first transient failure: status %s, want %s", got, tc.want)
			}
		})
	}
}

// The monitor's first comparison is against what the caller published, such
// as the hello, not a fresh Shape of the initial result.
func TestRuntimeMonitorComparesAgainstTheInitialPublishedResult(t *testing.T) {
	initial := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{Type: "codex", Status: "not_installed", Models: []RuntimeModel{}}}}
	hello := DiscoveryResult{Diagnostics: []RuntimeDiagnostic{{Type: "codex", Status: "not_installed", Models: []RuntimeModel{{ID: "hello", AllowedReasoningEffort: []string{}}}}}}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	var published []DiscoveryResult
	err := MonitorRuntimeDiagnostics(ctx, RuntimeMonitorOptions{
		Initial:               initial,
		InitialPublished:      &hello,
		RefreshInterval:       5 * time.Millisecond,
		FullRefreshEveryTicks: 1,
		Discover: func(context.Context, DiscoveryOptions) (DiscoveryResult, error) {
			return initial, nil
		},
		OnChanged: func(next DiscoveryResult) error {
			published = append(published, next)
			cancel()
			return nil
		},
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("monitor exited with %v", err)
	}
	// What discovery finds differs from the hello, so it is published.
	if len(published) != 1 || len(published[0].Diagnostics[0].Models) != 0 {
		t.Fatalf("published = %+v", published)
	}
}
