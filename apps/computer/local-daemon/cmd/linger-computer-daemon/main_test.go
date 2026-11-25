package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/computerconfig"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/daemon"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/assignment"
	lingercontext "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/context"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/registration"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/localmodels"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

// Extend the transient protocol failure regression through the real discovery
// and registration projection used by the daemon, including auth failures.
func TestRuntimeMonitorPreservesCodexRegistrationUntilFailureThreshold(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses POSIX scripts and symlinks")
	}
	for _, failure := range []struct{ probe, status string }{{"protocol", "incompatible"}, {"auth", "error"}} {
		t.Run(failure.probe, func(t *testing.T) {
			root := t.TempDir()
			entry, original, replacement := filepath.Join(root, "codex"), filepath.Join(root, "codex-old"), filepath.Join(root, "codex-new")
			stateFile := filepath.Join(root, "probe-state")
			script := `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'codex-cli 0.171.0'; exit 0; fi
read probe_state < "$PROBE_STATE"
if [ "$probe_state" = "protocol" ]; then exit 2; fi
read initialize
echo '{"id":1,"result":{"userAgent":"test"}}'
if read initialized && read account; then
  case "$account" in
    *'"method":"model/list"'*) echo '{"id":2,"result":{"data":[{"id":"gpt-test"}],"nextCursor":null}}'; exit 0 ;;
  esac
  if [ "$probe_state" = "auth" ]; then exit 2; fi
  echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":false}}'
fi
`
			for _, executable := range []string{original, replacement} {
				if err := os.WriteFile(executable, []byte(script), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Symlink(original, entry); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(stateFile, []byte("ready\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			environment := map[string]string{"PATH": root, "HOME": root, "CODEX_HOME": root, "PROBE_STATE": stateFile}
			// The first shell fixture launch can include serialized process
			// startup under the full multi-package Computer gate. Warm both
			// candidate executables outside the one-second discovery budget;
			// this is fixture setup, not a retry or a production timeout change.
			for _, executable := range []string{original, replacement} {
				ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
				command := exec.CommandContext(ctx, executable, "--version")
				command.Env = make([]string, 0, len(environment))
				for key, value := range environment {
					command.Env = append(command.Env, key+"="+value)
				}
				output, err := command.CombinedOutput()
				cancel()
				if err != nil || strings.TrimSpace(string(output)) != "codex-cli 0.171.0" {
					t.Fatalf("prepare Codex fixture %s: %v, output=%q", executable, err, output)
				}
			}
			options := provider.DiscoveryOptions{
				ConfiguredPaths: map[string]string{"codex": entry}, Timeout: time.Second,
				Environment: environment,
			}
			published, err := provider.Discover(t.Context(), options)
			if err != nil || published.Diagnostics[0].Status != "ready" || published.Diagnostics[0].Error != nil {
				t.Fatalf("initial discovery was not verified ready: %+v, %v", published, err)
			}
			computer := computerconfig.Config{Owners: []computerconfig.Owner{{TenantID: "tenant", OwnerActorID: "owner"}}}
			revision := uint64(1)
			observations := runtimeObservations(computer, published.Diagnostics, revision)
			assertPublished := func(want string) {
				t.Helper()
				wantRegistration := "unavailable"
				if want == "ready" {
					wantRegistration = "online"
				}
				if published.Diagnostics[0].Status != want || observations[0].Status != wantRegistration || observations[0].Revision != revision {
					t.Fatalf("diagnostics/registration = %+v / %+v, want %s / %s at revision %d", published.Diagnostics[0], observations[0], want, wantRegistration, revision)
				}
				_, installed := published.Installations["codex"]
				if installed != (want == "ready") {
					t.Fatalf("Codex installation retained across %s: %+v", want, published.Installations)
				}
			}
			assertPublished("ready")
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			completed := errors.New("sequence complete")
			calls := 0
			err = provider.MonitorRuntimeDiagnostics(ctx, provider.RuntimeMonitorOptions{
				Initial: published, Discovery: options, RefreshInterval: time.Millisecond, FullRefreshEveryTicks: 1,
				Discover: func(ctx context.Context, options provider.DiscoveryOptions) (provider.DiscoveryResult, error) {
					calls++
					if calls > 6 {
						t.Fatalf("replacement failure was not published: %+v", published)
					}
					// Failure, success, failure, failure proves success resets the
					// counter. Recovery then executable replacement must fail at once.
					assertPublished([]string{"ready", "ready", "ready", "ready", failure.status, "ready"}[calls-1])
					state := failure.probe
					if calls == 2 || calls == 5 {
						state = "ready"
					}
					if calls == 6 {
						if err := os.Remove(entry); err != nil {
							t.Fatal(err)
						}
						if err := os.Symlink(replacement, entry); err != nil {
							t.Fatal(err)
						}
					}
					if err := os.WriteFile(stateFile, []byte(state+"\n"), 0o600); err != nil {
						t.Fatal(err)
					}
					return provider.Discover(ctx, options)
				},
				OnChanged: func(next provider.DiscoveryResult) error {
					if calls < 4 {
						t.Fatalf("single failure revoked online registration at refresh %d: %+v", calls, next)
					}
					published = next
					revision++
					observations = runtimeObservations(computer, next.Diagnostics, revision)
					if calls == 6 {
						assertPublished(failure.status)
						expected, err := filepath.EvalSymlinks(replacement)
						if err != nil || published.Diagnostics[0].ExecutablePath != expected {
							t.Fatalf("replacement borrowed old ready: %+v, %v", published, err)
						}
						return completed
					}
					return nil
				},
			})
			if !errors.Is(err, completed) || calls != 6 || revision != 4 {
				t.Fatalf("monitor sequence incomplete: calls=%d revision=%d err=%v", calls, revision, err)
			}
		})
	}
}

func TestPausedRunnerResultUsesLifecycleState(t *testing.T) {
	result := pausedRunnerResult(assignment.Record{
		RunnerID: "computer-1", TenantID: "tenant-1", AgentID: "agent-1", RunnerRevision: 3,
	})
	if result["state"] != "paused" || result["agent_id"] != "agent-1" || result["runner_revision"] != uint64(3) {
		t.Fatalf("paused Runner result = %#v", result)
	}
}

func TestRuntimeProviderEnvironmentUsesConfiguredCodexAuthHome(t *testing.T) {
	authHome := filepath.Join(t.TempDir(), ".codex")
	got := runtimeProviderEnvironment(map[string]string{
		"CODEX_HOME":           "/ambient/.codex",
		"LINGER_GATEWAY_TOKEN": "gateway-token",
	}, "gateway-token", filepath.Join(authHome, "auth.json"))
	if got["CODEX_HOME"] != authHome {
		t.Fatalf("CODEX_HOME = %q, want configured auth parent", got["CODEX_HOME"])
	}
	if _, exists := got["LINGER_GATEWAY_TOKEN"]; exists {
		t.Fatal("Gateway token reached Provider environment")
	}
}

func TestBoundComputerServiceCommandCannotSelectAnotherConfig(t *testing.T) {
	config := filepath.Join(t.TempDir(), "computer.json")
	bundle := t.TempDir()
	daemon := filepath.Join(bundle, "daemon", "linger-computer-daemon")
	cli := filepath.Join(bundle, "cli", "linger-computer")
	if runtime.GOOS == "windows" {
		cli += ".exe"
	}
	for _, file := range []string{daemon, cli} {
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, nil, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	stable := []string{cli, "--config", config}
	stableEncoded, _ := json.Marshal(stable)
	if got, err := boundServiceCommand(string(stableEncoded), config, daemon); err != nil || !slices.Equal(got, stable) {
		t.Fatalf("bound CLI: %v %v", got, err)
	}
	if _, err := boundServiceCommand(string(stableEncoded), config+".other", daemon); err == nil {
		t.Fatal("bound CLI accepted another Computer config")
	}
	// A handoff from an older release names a CLI this bundle does not ship.
	stale, _ := json.Marshal([]string{filepath.Join(bundle, "runtime", "bin", "node"), filepath.Join(bundle, "cli", "linger-computer.js"), "--config", config})
	if got, err := boundServiceCommand(string(stale), config, daemon); err != nil || !slices.Equal(got, stable) {
		t.Fatalf("stale handoff command was not rebound to the bundle CLI: %v %v", got, err)
	}
	if _, err := boundServiceCommand(string(stale), config, filepath.Join(t.TempDir(), "linger-computer-daemon")); err == nil {
		t.Fatal("missing program accepted outside an installed bundle")
	}
	if _, err := boundServiceCommand(`{"command":"evil"}`, config, daemon); err == nil {
		t.Fatal("invalid command accepted")
	}
}

func TestProviderInstallationsPreserveTerminalExecutionPath(t *testing.T) {
	environment := map[string]string{"PATH": "daemon-path", "HOME": "/home/user"}
	discovered := provider.DiscoveryResult{Installations: map[string]provider.RuntimeDiagnostic{"pi": {Type: "pi", ExecutablePath: "/mise/pi", EntryPath: "/mise/latest/pi", ExecutionPath: "terminal-node:daemon-path"}}}
	installations, _ := providerInstallations(discovered, environment, "")
	if installations["pi"].Environment["PATH"] != "terminal-node:daemon-path" || environment["PATH"] != "daemon-path" {
		t.Fatalf("terminal execution environment was lost or caller mutated: %+v", installations["pi"])
	}
}

func TestProviderInstallationsKeepDiscoveredContextWindows(t *testing.T) {
	discovered := provider.DiscoveryResult{Installations: map[string]provider.RuntimeDiagnostic{"codex": {
		Type: "codex", ExecutablePath: "/bin/codex",
		Models: []provider.RuntimeModel{{ID: "local", ContextWindow: 64896}, {ID: "unknown"}},
	}}}
	installations, _ := providerInstallations(discovered, nil, "")
	if windows := installations["codex"].ContextWindows; len(windows) != 1 || windows["local"] != 64896 {
		t.Fatalf("context windows = %v", windows)
	}
	if installations["codex"].DefaultModel != "" {
		t.Fatalf("default model = %q from a catalog that marks none", installations["codex"].DefaultModel)
	}
}

func TestProviderInstallationsKeepTheCatalogDefaultModel(t *testing.T) {
	discovered := provider.DiscoveryResult{Installations: map[string]provider.RuntimeDiagnostic{"codex": {
		Type: "codex", ExecutablePath: "/bin/codex",
		Models: []provider.RuntimeModel{{ID: "gpt-other"}, {ID: "gpt-account-default", IsDefault: true}},
	}}}
	installations, _ := providerInstallations(discovered, nil, "")
	if model := installations["codex"].DefaultModel; model != "gpt-account-default" {
		t.Fatalf("default model = %q", model)
	}
}

func TestProviderInstallationsMarkTheAPILink(t *testing.T) {
	discovered := provider.DiscoveryResult{Installations: map[string]provider.RuntimeDiagnostic{
		"codex":  {Type: "codex", ExecutablePath: "/bin/codex", Models: []provider.RuntimeModel{{ID: "gpt", Link: "api"}}},
		"claude": {Type: "claude", ExecutablePath: "/bin/claude", Models: []provider.RuntimeModel{{ID: "opus", Link: "subscription"}}},
	}}
	installations, _ := providerInstallations(discovered, nil, "")
	if !installations["codex"].APILink || installations["claude"].APILink {
		t.Fatalf("API links = codex %v, claude %v", installations["codex"].APILink, installations["claude"].APILink)
	}
	state := t.TempDir()
	gateway := map[string]string{"CLAUDE_CONFIG_DIR": filepath.Join(state, "byok-home", ".claude")}
	installations, _ = providerInstallations(discovered, gateway, state)
	if claude := installations["claude"]; !claude.ModelGateway || !claude.APILink {
		t.Fatalf("gateway Claude = %+v", claude)
	}
}

func TestByokRuntimeCatalogsShowTheEnteredModel(t *testing.T) {
	diagnostics := []provider.RuntimeDiagnostic{
		{Type: "claude", Models: []provider.RuntimeModel{
			{ID: "default", Label: "Default", IsDefault: true},
			{ID: "localmodels-byok", Label: "localmodels-byok"},
		}},
		{Type: "codex", Models: []provider.RuntimeModel{{ID: "gpt-5", Label: "gpt-5", IsDefault: true}}},
	}
	byok := &localmodels.OverlayState{Mode: "byok", RuntimeModel: "localmodels-byok", ModelLabel: "vendor/model"}

	shaped := byokRuntimeCatalogs(diagnostics, byok)
	if want := []provider.RuntimeModel{{ID: "localmodels-byok", Label: "vendor/model", IsDefault: true}}; !reflect.DeepEqual(shaped[0].Models, want) {
		t.Fatalf("Claude models = %+v, want %+v", shaped[0].Models, want)
	}
	if !reflect.DeepEqual(shaped[1].Models, diagnostics[1].Models) {
		t.Fatalf("a Runtime without the BYOK route changed: %+v", shaped[1].Models)
	}
	if len(diagnostics[0].Models) != 2 || diagnostics[0].Models[1].Label != "localmodels-byok" {
		t.Fatalf("input diagnostics were modified: %+v", diagnostics[0].Models)
	}
	for _, source := range []*localmodels.OverlayState{nil, {Mode: "local", RuntimeModel: "localmodels-byok", ModelLabel: "x"}} {
		if got := byokRuntimeCatalogs(diagnostics, source); len(got[0].Models) != 2 {
			t.Fatalf("source %+v reshaped the catalog: %+v", source, got[0].Models)
		}
	}
}

func TestWithManagedPiPathRespectsConfiguredPiAndClonesSafely(t *testing.T) {
	if got := withManagedPiPath(nil, ""); got != nil {
		t.Fatalf("empty managed path returned %v", got)
	}
	configured := map[string]string{"codex": "/bin/codex", "pi": "/custom/pi"}
	if got := withManagedPiPath(configured, "/managed/pi"); got["pi"] != "/custom/pi" {
		t.Fatalf("managed Pi overwrote configured path: %v", got)
	}
	original := map[string]string{"codex": "/bin/codex"}
	merged := withManagedPiPath(original, "/managed/pi")
	if merged["pi"] != "/managed/pi" || original["pi"] != "" {
		t.Fatalf("merged=%v original=%v", merged, original)
	}
}

func TestWithPiProvisionStatusMarksNotInstalledPiAsErrorWhenFailed(t *testing.T) {
	original := []provider.RuntimeDiagnostic{
		{Type: "codex", Status: "not_installed", Error: &provider.DiagnosticError{Code: "RUNTIME_NOT_INSTALLED", Message: "missing"}},
		{Type: "pi", Status: "not_installed", Error: &provider.DiagnosticError{Code: "RUNTIME_NOT_INSTALLED", Message: "missing"}},
		{Type: "claude", Status: "ready"},
	}
	unchanged := withPiProvisionStatus(original, false)
	if unchanged[1].Status != "not_installed" {
		t.Fatalf("expected not_installed when failed=false, got %+v", unchanged[1])
	}

	marked := withPiProvisionStatus(original, true)
	if marked[1].Status != "error" || marked[1].Error == nil || marked[1].Error.Code != "RUNTIME_DIAGNOSTIC_FAILED" {
		t.Fatalf("expected Pi error status when failed=true, got %+v", marked[1])
	}
	if marked[0].Status != "not_installed" || marked[2].Status != "ready" {
		t.Fatalf("non-Pi diagnostics changed unexpectedly: %+v", marked)
	}
	if original[1].Status != "not_installed" {
		t.Fatalf("input diagnostics mutated in place: %+v", original[1])
	}

	readyPi := []provider.RuntimeDiagnostic{{Type: "pi", Status: "ready"}}
	if got := withPiProvisionStatus(readyPi, true); got[0].Status != "ready" {
		t.Fatalf("ready Pi overwritten: %+v", got[0])
	}
}

func TestByokRuntimeCatalogsRepeatedShapingPreservesRouteAndDoesNotMutate(t *testing.T) {
	input := []provider.RuntimeDiagnostic{
		{
			Type: "pi", Status: "ready", ExecutablePath: "/bin/pi",
			Models: []provider.RuntimeModel{
				{ID: "localmodels/localmodels-byok", Label: "localmodels-byok", AllowedReasoningEffort: []string{"low", "high"}, DefaultReasoningEffort: "high", ContextWindow: 1_048_576, Link: "api", IsDefault: true},
				{ID: "builtin/model-001", Label: "Built-in 001", AllowedReasoningEffort: []string{}, Link: "subscription"},
			},
		},
		{
			Type: "codex", Status: "ready", ExecutablePath: "/bin/codex",
			Models: []provider.RuntimeModel{{ID: "gpt-5", Label: "gpt-5", AllowedReasoningEffort: []string{}, IsDefault: true}},
		},
	}
	snapshot := []provider.RuntimeDiagnostic{
		{
			Type: "pi", Status: "ready", ExecutablePath: "/bin/pi",
			Models: append([]provider.RuntimeModel(nil), input[0].Models...),
		},
		{
			Type: "codex", Status: "ready", ExecutablePath: "/bin/codex",
			Models: append([]provider.RuntimeModel(nil), input[1].Models...),
		},
	}
	overlay := &localmodels.OverlayState{
		Mode:         "byok",
		Runtime:      "pi",
		RuntimeModel: "localmodels/localmodels-byok",
		ModelLabel:   "vendor/custom-gateway-model",
	}
	wantPiModels := []provider.RuntimeModel{{
		ID:                     "localmodels/localmodels-byok",
		Label:                  "vendor/custom-gateway-model",
		AllowedReasoningEffort: []string{"low", "high"},
		DefaultReasoningEffort: "high",
		ContextWindow:          1_048_576,
		Link:                   "api",
		IsDefault:              true,
	}}

	current := input
	for pass := range 3 {
		current = byokRuntimeCatalogs(current, overlay)
		if !reflect.DeepEqual(current[0].Models, wantPiModels) {
			t.Fatalf("pass %d Pi models = %+v, want %+v", pass+1, current[0].Models, wantPiModels)
		}
		if !reflect.DeepEqual(current[1].Models, snapshot[1].Models) {
			t.Fatalf("pass %d non-BYOK runtime changed: %+v", pass+1, current[1].Models)
		}
		if !reflect.DeepEqual(input, snapshot) {
			t.Fatalf("pass %d mutated input diagnostics: %+v", pass+1, input)
		}
	}
}

func TestShapeDiscoveredResultReappliesByokOverlayAcrossPeriodicRefreshes(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "localmodels")
	piAgentDir := filepath.Join(stateDir, "byok-home", ".pi", "agent")
	if err := os.MkdirAll(piAgentDir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeByokOverlayFile(t, stateDir, "pi", "localmodels/localmodels-byok", "vendor/custom-gateway-model", "http://127.0.0.1:18080", piAgentDir)

	providerCatalog := lingercontext.NewProviderCatalog(nil)
	controller := &controlController{}
	inventory := &runtimeInventory{}
	env := localmodels.OverlayEnvironment(map[string]string{"HOME": root}, stateDir)

	wantModels := []provider.RuntimeModel{{
		ID:                     "localmodels/localmodels-byok",
		Label:                  "vendor/custom-gateway-model",
		AllowedReasoningEffort: []string{},
		ContextWindow:          1_048_576,
		Link:                   "api",
		IsDefault:              true,
	}}
	for refresh := range 3 {
		nativeModels := make([]provider.RuntimeModel, 0, 100)
		nativeModels = append(nativeModels, provider.RuntimeModel{
			ID:                     "localmodels/localmodels-byok",
			Label:                  "localmodels-byok",
			AllowedReasoningEffort: []string{},
			ContextWindow:          1_048_576,
			Link:                   "api",
			IsDefault:              true,
		})
		for i := 1; i < 100; i++ {
			nativeModels = append(nativeModels, provider.RuntimeModel{
				ID:                     fmt.Sprintf("builtin/model-%03d", i),
				Label:                  fmt.Sprintf("Built-in %03d", i),
				AllowedReasoningEffort: []string{},
				Link:                   "subscription",
			})
		}
		nativeSnapshot := append([]provider.RuntimeModel(nil), nativeModels...)
		unshaped := provider.DiscoveryResult{
			Diagnostics: []provider.RuntimeDiagnostic{{
				Type:           "pi",
				Status:         "ready",
				Protocol:       "rpc",
				ExecutablePath: filepath.Join(root, "pi"),
				Models:         nativeModels,
			}},
		}
		unshaped.Installations = provider.InstallationsFromDiagnostics(unshaped.Diagnostics)

		shaped := shapeDiscoveredResult(unshaped, stateDir, false, nil, nil)
		nextProviders, nextRuntimes := providerInstallations(shaped, env, stateDir)
		providerCatalog.Replace(nextProviders)
		controller.UpdateDiagnostics(shaped.Diagnostics)
		if _, err := inventory.publishIfChanged(t.Context(), nextRuntimes, shaped.Diagnostics); err != nil {
			t.Fatalf("refresh %d publish failed: %v", refresh+1, err)
		}
		if !reflect.DeepEqual(unshaped.Diagnostics[0].Models, nativeSnapshot) {
			t.Fatalf("refresh %d mutated caller diagnostics", refresh+1)
		}
		published, err := controller.Runtimes(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		controllerDiagnostics := published.([]provider.RuntimeDiagnostic)
		if !reflect.DeepEqual(controllerDiagnostics[0].Models, wantModels) {
			t.Fatalf("refresh %d controller models = %+v, want %+v", refresh+1, controllerDiagnostics[0].Models, wantModels)
		}
		if !reflect.DeepEqual(inventory.diagnostics[0].Models, wantModels) {
			t.Fatalf("refresh %d inventory models = %+v, want %+v", refresh+1, inventory.diagnostics[0].Models, wantModels)
		}
		installed, ok, err := providerCatalog.Lookup(t.Context(), "pi")
		if err != nil || !ok {
			t.Fatalf("refresh %d provider catalog lookup failed: ok=%v err=%v", refresh+1, ok, err)
		}
		if installed.DefaultModel != "localmodels/localmodels-byok" ||
			!installed.ModelGateway ||
			!installed.APILink ||
			!reflect.DeepEqual(installed.ContextWindows, map[string]int{"localmodels/localmodels-byok": 1_048_576}) {
			t.Fatalf("refresh %d provider installation = %+v", refresh+1, installed)
		}
	}
}

func TestPeriodicMonitorPreservesPersistedByokOverlayAfterRestart(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell")
	}
	root := t.TempDir()
	stateDir := filepath.Join(root, "localmodels")
	piAgentDir := filepath.Join(stateDir, "byok-home", ".pi", "agent")
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
		_, _ = w.Write([]byte(`{"data":[{"id":"localmodels-byok","context_window":1048576}]}`))
	}))
	defer gateway.Close()
	if err := os.WriteFile(filepath.Join(piAgentDir, "models.json"), []byte(fmt.Sprintf(`{"providers":{"localmodels":{"baseUrl":"%s/v1","apiKey":"test-key"}}}`, gateway.URL)), 0o600); err != nil {
		t.Fatal(err)
	}
	writeByokOverlayFile(t, stateDir, "pi", "localmodels/localmodels-byok", "vendor/custom-gateway-model", gateway.URL, piAgentDir)

	var modelsJSON strings.Builder
	modelsJSON.WriteString("[")
	for i := range 470 {
		if i > 0 {
			modelsJSON.WriteByte(',')
		}
		if i == 465 {
			modelsJSON.WriteString(`{"provider":"localmodels","id":"localmodels-byok","name":"localmodels-byok","contextWindow":1048576}`)
		} else {
			fmt.Fprintf(&modelsJSON, `{"provider":"builtin","id":"model-%03d","name":"Built-in %03d"}`, i+1, i+1)
		}
	}
	modelsJSON.WriteString("]")
	catalogFile := filepath.Join(root, "pi-models.json")
	if err := os.WriteFile(catalogFile, []byte(modelsJSON.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	authFile := filepath.Join(root, "pi-auth-status")
	authCountFile := filepath.Join(root, "pi-auth-count")
	piExecutable := filepath.Join(root, "pi")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then echo '1.2.0'; exit 0; fi
if [ "$1" = "auth" ]; then
  echo call >> "$PI_AUTH_COUNT_FILE"
  IFS= read -r status < "$PI_AUTH_STATUS_FILE"
  if [ "$status" = "ready" ]; then
    echo '{"status":"ready"}'
    exit 0
  fi
  echo '{"status":"not_ready"}'
  exit 1
fi
while IFS= read -r line; do
  case "$line" in
  *linger-probe*) echo '{"type":"response","id":"linger-probe","command":"get_state","success":true,"data":{"isStreaming":false}}' ;;
  *linger-state*) echo '{"type":"response","id":"linger-state","command":"get_state","success":true,"data":{"model":{"provider":"localmodels","id":"localmodels-byok"},"thinkingLevel":"off"}}' ;;
  *linger-models*)
    IFS= read -r models < "$PI_CATALOG_FILE"
    printf '{"type":"response","id":"linger-models","command":"get_available_models","success":true,"data":{"models":%s}}\n' "$models" ;;
  esac
done
`
	if err := os.WriteFile(piExecutable, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.CommandContext(t.Context(), piExecutable, "--version").CombinedOutput(); err != nil || strings.TrimSpace(string(out)) != "1.2.0" {
		t.Fatalf("warm Pi fixture: err=%v output=%q", err, out)
	}
	baseEnv := map[string]string{
		"HOME": root, "PATH": root,
		"PI_CATALOG_FILE":     catalogFile,
		"PI_AUTH_STATUS_FILE": authFile,
		"PI_AUTH_COUNT_FILE":  authCountFile,
	}
	currentEnv := func() map[string]string {
		return localmodels.OverlayEnvironment(baseEnv, stateDir)
	}
	currentOptions := func() provider.DiscoveryOptions {
		return provider.DiscoveryOptions{
			ConfiguredPaths: map[string]string{"pi": piExecutable},
			Runtimes:        []string{"pi"},
			Environment:     currentEnv(),
			Timeout:         10 * time.Second,
		}
	}
	shape := func(result provider.DiscoveryResult) provider.DiscoveryResult {
		return shapeDiscoveredResult(result, stateDir, false, nil, nil)
	}
	wantModels := []provider.RuntimeModel{{
		ID:                     "localmodels/localmodels-byok",
		Label:                  "vendor/custom-gateway-model",
		AllowedReasoningEffort: []string{},
		ContextWindow:          1_048_576,
		Link:                   "api",
		IsDefault:              true,
	}}

	t.Run("steady ready stays shaped across auth and full refreshes", func(t *testing.T) {
		gatewayRequests.Store(0)
		if err := os.WriteFile(authFile, []byte("ready\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		_ = os.Remove(authCountFile)
		initial, err := provider.Discover(t.Context(), currentOptions())
		if err != nil {
			t.Fatal(err)
		}
		initial = shape(initial)
		if !reflect.DeepEqual(initial.Diagnostics[0].Models, wantModels) {
			t.Fatalf("initial shaped models = %+v, want %+v", initial.Diagnostics[0].Models, wantModels)
		}
		if !reflect.DeepEqual(initial.Installations["pi"].Models, wantModels) {
			t.Fatalf("initial installation models = %+v, want %+v", initial.Installations["pi"].Models, wantModels)
		}

		ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
		defer cancel()
		fullRefreshes := 0
		onChangedCalls := 0
		err = provider.MonitorRuntimeDiagnostics(ctx, provider.RuntimeMonitorOptions{
			Initial:               initial,
			Discovery:             currentOptions(),
			ResolveDiscovery:      currentOptions,
			RefreshInterval:       5 * time.Millisecond,
			FullRefreshEveryTicks: 2,
			Discover: func(ctx context.Context, options provider.DiscoveryOptions) (provider.DiscoveryResult, error) {
				fullRefreshes++
				result, discoverErr := provider.Discover(ctx, options)
				if fullRefreshes >= 2 {
					cancel()
				}
				return result, discoverErr
			},
			Shape: shape,
			OnChanged: func(next provider.DiscoveryResult) error {
				onChangedCalls++
				t.Errorf("unexpected OnChanged during steady BYOK refresh: %+v", next.Diagnostics)
				return nil
			},
		})
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("monitor exited with %v, want context.Canceled", err)
		}
		if fullRefreshes < 2 || onChangedCalls != 0 {
			t.Fatalf("fullRefreshes=%d onChangedCalls=%d", fullRefreshes, onChangedCalls)
		}
		// Auth-only ticks ran between full refreshes; verify at least 4 total
		// auth checks happened (1 initial + auth tick 1 + full tick 2 + auth tick 3 + full tick 4).
		rawCount, err := os.ReadFile(authCountFile)
		if err != nil || strings.Count(string(rawCount), "call\n") < 4 {
			t.Fatalf("auth probes = %q err=%v, want at least 4 across initial, auth, and full ticks", rawCount, err)
		}
		if got := int(gatewayRequests.Load()); got != 1+fullRefreshes {
			t.Fatalf("gateway /v1/models requests = %d, want %d (1 initial + %d full refreshes)", got, 1+fullRefreshes, fullRefreshes)
		}
	})

	t.Run("recovers on periodic auth refresh without user intervention", func(t *testing.T) {
		if err := os.WriteFile(authFile, []byte("not_ready\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		initial, err := provider.Discover(t.Context(), currentOptions())
		if err != nil {
			t.Fatal(err)
		}
		initial = shape(initial)
		if initial.Diagnostics[0].Status != "authentication_required" {
			t.Fatalf("initial status = %+v, want authentication_required", initial.Diagnostics[0])
		}
		if err := os.WriteFile(authFile, []byte("ready\n"), 0o600); err != nil {
			t.Fatal(err)
		}

		providerCatalog := lingercontext.NewProviderCatalog(nil)
		controller := &controlController{}
		inventory := &runtimeInventory{}

		ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
		defer cancel()
		recovered := errors.New("recovered")
		err = provider.MonitorRuntimeDiagnostics(ctx, provider.RuntimeMonitorOptions{
			Initial:               initial,
			Discovery:             currentOptions(),
			ResolveDiscovery:      currentOptions,
			RefreshInterval:       5 * time.Millisecond,
			FullRefreshEveryTicks: 100,
			Shape:                 shape,
			OnChanged: func(next provider.DiscoveryResult) error {
				nextProviders, nextRuntimes := providerInstallations(next, currentEnv(), stateDir)
				providerCatalog.Replace(nextProviders)
				controller.UpdateDiagnostics(next.Diagnostics)
				if _, pubErr := inventory.publishIfChanged(ctx, nextRuntimes, next.Diagnostics); pubErr != nil {
					return pubErr
				}
				return recovered
			},
		})
		if !errors.Is(err, recovered) {
			t.Fatalf("monitor exited with %v, want recovered", err)
		}
		published, err := controller.Runtimes(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		controllerDiagnostics := published.([]provider.RuntimeDiagnostic)
		if controllerDiagnostics[0].Status != "ready" || !reflect.DeepEqual(controllerDiagnostics[0].Models, wantModels) {
			t.Fatalf("recovered controller diagnostic = %+v, want ready with %+v", controllerDiagnostics[0], wantModels)
		}
		if !reflect.DeepEqual(inventory.diagnostics[0].Models, wantModels) {
			t.Fatalf("recovered inventory models = %+v, want %+v", inventory.diagnostics[0].Models, wantModels)
		}
		installed, ok, err := providerCatalog.Lookup(t.Context(), "pi")
		if err != nil || !ok {
			t.Fatalf("recovered provider catalog lookup failed: ok=%v err=%v", ok, err)
		}
		if installed.DefaultModel != "localmodels/localmodels-byok" ||
			!installed.ModelGateway ||
			!installed.APILink ||
			!reflect.DeepEqual(installed.ContextWindows, map[string]int{"localmodels/localmodels-byok": 1_048_576}) {
			t.Fatalf("recovered provider installation = %+v", installed)
		}
	})
}

func writeByokOverlayFile(t *testing.T, stateDir, runtimeType, runtimeModel, modelLabel, gatewayURL, piAgentDir string) {
	t.Helper()
	overlayDoc := map[string]any{
		"schema":        "localmodels.model-source/v1",
		"mode":          "byok",
		"runtime":       runtimeType,
		"runtime_model": runtimeModel,
		"model_label":   modelLabel,
		"gateway_url":   gatewayURL,
		"environment":   map[string]string{"PI_CODING_AGENT_DIR": piAgentDir},
	}
	encodedOverlay, err := json.Marshal(overlayDoc)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "model-source.json"), encodedOverlay, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestRuntimeRefreshAllowedPausesInTerminalGatewayStates(t *testing.T) {
	for _, tc := range []struct {
		state string
		want  bool
	}{
		{state: "connecting", want: true},
		{state: "connected", want: true},
		{state: "upgrade-required", want: false},
		{state: "authentication-failed", want: false},
		{state: "identity-conflict", want: false},
	} {
		if got := runtimeRefreshAllowed(tc.state); got != tc.want {
			t.Fatalf("runtimeRefreshAllowed(%q) = %v, want %v", tc.state, got, tc.want)
		}
	}
}

// The first discovery runs before the Library exists; the hello it feeds
// still lists the local model a quit unloaded, from the remembered entries.
func TestTheFirstDiscoveryListsRememberedLocalModels(t *testing.T) {
	directory := t.TempDir()
	piModel := "localmodels-library/localmodels-lib-qwen3-4b-q4-k-m/Qwen3-4B-Q4_K_M"
	remembered := fmt.Sprintf(`{"schema":"linger.local-models-pi-catalog/v1","models":{%q:{"id":%q,"label":"Qwen3 4B","allowed_reasoning_effort":["high"],"default_reasoning_effort":"high"}}}`, piModel, piModel)
	if err := os.WriteFile(filepath.Join(directory, "pi-catalog.json"), []byte(remembered), 0o600); err != nil {
		t.Fatal(err)
	}
	raw := provider.DiscoveryResult{Diagnostics: []provider.RuntimeDiagnostic{{
		Type: "pi", Status: "authentication_required", Protocol: "rpc", ExecutablePath: filepath.Join(directory, "pi"),
		Models: []provider.RuntimeModel{}, Error: &provider.DiagnosticError{Code: "RUNTIME_AUTHENTICATION_REQUIRED", Message: "sign in"},
	}}}
	shaped := shapeDiscoveredResult(raw, t.TempDir(), false, localmodels.NewPiCatalog(directory), nil)
	pi := shaped.Diagnostics[0]
	if pi.Status != "ready" || pi.Error != nil || len(pi.Models) != 1 || pi.Models[0].ID != piModel || pi.Models[0].DefaultReasoningEffort != "high" {
		t.Fatalf("pi = %+v", pi)
	}
	if _, ok := shaped.Installations["pi"]; !ok {
		t.Fatalf("installations = %+v", shaped.Installations)
	}
	if raw.Diagnostics[0].Status != "authentication_required" {
		t.Fatal("shaping changed the raw result")
	}
}

func TestRuntimeCredentialFilesIncludesAntigravity(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	files := runtimeCredentialFiles(map[string]string{"HOME": home})
	want := filepath.Join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token")
	if files["antigravity"] != want {
		t.Fatalf("antigravity credential file = %q, want %q", files["antigravity"], want)
	}

	userProfile := filepath.Join(t.TempDir(), "profile")
	winFiles := runtimeCredentialFiles(map[string]string{"USERPROFILE": userProfile})
	wantWin := filepath.Join(userProfile, ".gemini", "antigravity-cli", "antigravity-oauth-token")
	if winFiles["antigravity"] != wantWin {
		t.Fatalf("antigravity USERPROFILE credential file = %q, want %q", winFiles["antigravity"], wantWin)
	}

	emptyFiles := runtimeCredentialFiles(map[string]string{})
	if _, ok := emptyFiles["antigravity"]; ok {
		t.Fatalf("unexpected antigravity credential file when home is empty: %+v", emptyFiles)
	}
}

func TestAntigravityExecutableTrackerDetectsPathChanges(t *testing.T) {
	discovery := func(path string) provider.DiscoveryResult {
		if path == "" {
			return provider.DiscoveryResult{}
		}
		return provider.DiscoveryResult{
			Installations: map[string]provider.RuntimeDiagnostic{
				"antigravity": {Type: "antigravity", ExecutablePath: path},
			},
		}
	}
	tracker := &antigravityExecutableTracker{path: "/usr/local/bin/agy"}
	if tracker.changed(discovery("/usr/local/bin/agy")) {
		t.Fatal("unchanged path reported changed")
	}
	if !tracker.changed(discovery("/opt/homebrew/bin/agy")) {
		t.Fatal("swapped path did not report changed")
	}
	if tracker.changed(discovery("/opt/homebrew/bin/agy")) {
		t.Fatal("repeated swapped path reported changed")
	}
	if !tracker.changed(discovery("")) {
		t.Fatal("removed executable did not report changed")
	}
	if tracker.changed(discovery("")) {
		t.Fatal("steady absent executable reported changed")
	}
	if !tracker.changed(discovery("/usr/local/bin/agy")) {
		t.Fatal("reinstalled executable did not report changed")
	}
}

type mainTestIdentityStore struct{ value transport.Identity }

func (s mainTestIdentityStore) LoadOrCreate(context.Context) (transport.Identity, error) {
	return s.value, nil
}

type mainTestResolver struct{}

func (mainTestResolver) Resolve(context.Context, protocol.Command, json.RawMessage) (provider.OperationSpec, error) {
	return provider.OperationSpec{}, errors.New("not implemented")
}

type mainTestStream struct {
	mu       sync.Mutex
	commands []protocol.Command
	events   []protocol.Event
	sendErr  error
	wait     <-chan struct{}
}

func (s *mainTestStream) Receive(ctx context.Context) (protocol.Command, error) {
	s.mu.Lock()
	if len(s.commands) > 0 {
		cmd := s.commands[0]
		s.commands = s.commands[1:]
		s.mu.Unlock()
		return cmd, nil
	}
	s.mu.Unlock()
	if s.wait != nil {
		select {
		case <-s.wait:
		case <-ctx.Done():
			return protocol.Command{}, ctx.Err()
		}
	}
	return protocol.Command{}, io.EOF
}

func (s *mainTestStream) Send(_ context.Context, event protocol.Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sendErr != nil {
		return s.sendErr
	}
	s.events = append(s.events, event)
	return nil
}

func (s *mainTestStream) setSendErr(err error) {
	s.mu.Lock()
	s.sendErr = err
	s.mu.Unlock()
}

func (s *mainTestStream) Close() error { return nil }

func (s *mainTestStream) eventCount(eventType string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	count := 0
	for _, event := range s.events {
		if event.Type == eventType {
			count++
		}
	}
	return count
}

type mainTestControlPlane struct{ stream transport.Stream }

func (p mainTestControlPlane) Connect(context.Context, transport.Hello) (transport.Stream, error) {
	return p.stream, nil
}

type syncLogBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncLogBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncLogBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func inventoryRevision(inventory *runtimeInventory) uint64 {
	inventory.mu.Lock()
	defer inventory.mu.Unlock()
	return inventory.revision
}

func TestApplyRuntimeDiscoverySkipsGatewayPublishWhenOnlyExecutionPathOrCheckedAtChanges(t *testing.T) {
	var logBuf syncLogBuffer
	prevLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logBuf, nil)))
	t.Cleanup(func() { slog.SetDefault(prevLogger) })

	identity, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	release := make(chan struct{})
	var closeReleaseOnce sync.Once
	closeRelease := func() { closeReleaseOnce.Do(func() { close(release) }) }
	defer closeRelease()
	stream := &mainTestStream{
		commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 1}},
		wait:     release,
	}

	codexBin := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(codexBin, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	codexCanonical, err := filepath.EvalSymlinks(codexBin)
	if err != nil {
		t.Fatal(err)
	}

	t0 := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
	initialResult := provider.DiscoveryResult{
		Diagnostics: []provider.RuntimeDiagnostic{
			{
				Type:           "codex",
				Status:         "ready",
				Protocol:       "app-server",
				CheckedAt:      t0,
				Version:        "codex-cli 0.171.0",
				Models:         []provider.RuntimeModel{{ID: "gpt-5", Label: "GPT-5", Link: "subscription", IsDefault: true}},
				ExecutablePath: codexCanonical,
				EntryPath:      codexBin,
				ExecutionPath:  "/v1/bin:/usr/bin",
			},
			{
				Type:   "antigravity",
				Status: "not_installed",
			},
		},
	}
	initialResult.Installations = provider.InstallationsFromDiagnostics(initialResult.Diagnostics)

	env := map[string]string{"HOME": t.TempDir(), "PATH": "/usr/bin"}
	initialProviders, initialRuntimes := providerInstallations(initialResult, env, "")
	providerCatalog := lingercontext.NewProviderCatalog(initialProviders)
	computer := computerconfig.Config{
		ComputerID: "comp-1",
		Owners:     []computerconfig.Owner{{TenantID: "tenant-1", OwnerActorID: "owner-1"}},
	}
	rejected := provider.NewRejectedModels(nil)
	initialDiagnosticsJSON, err := provider.DiagnosticsJSON(provider.GatewayDiagnostics(initialResult.Diagnostics))
	if err != nil {
		t.Fatal(err)
	}
	localDaemon, err := daemon.New(daemon.Options{
		ComputerID:          computer.ComputerID,
		ControlPlane:        mainTestControlPlane{stream: stream},
		IdentityStore:       mainTestIdentityStore{value: identity},
		OperationResolver:   mainTestResolver{},
		Ledger:              daemon.NewMemoryLedger(),
		Registrations:       registration.NewMemoryStore(),
		Assignments:         assignment.NewMemoryStore(),
		Runtimes:            initialRuntimes,
		RuntimeDiagnostics:  initialDiagnosticsJSON,
		RuntimeObservations: runtimeObservations(computer, provider.GatewayDiagnostics(initialResult.Diagnostics), 10),
	})
	if err != nil {
		t.Fatal(err)
	}

	runCtx, cancelRun := context.WithCancel(t.Context())
	defer cancelRun()
	runDone := make(chan error, 1)
	go func() { runDone <- localDaemon.Run(runCtx) }()
	deadline := time.Now().Add(5 * time.Second)
	for localDaemon.GatewayState() != "connected" {
		if time.Now().After(deadline) {
			t.Fatal("daemon did not reach connected state")
		}
		time.Sleep(10 * time.Millisecond)
	}

	controller := &controlController{daemon: localDaemon, diagnostics: initialResult.Diagnostics}
	inventory, err := newRuntimeInventory(computer, rejected, initialRuntimes, initialResult.Diagnostics, 10)
	if err != nil {
		t.Fatal(err)
	}
	inventory.start(runCtx, localDaemon)

	// Changing only ExecutionPath and CheckedAt must update providerCatalog and
	// controller, while skipping logRuntimeDiagnostics and gateway publish.
	pathOnly := provider.DiscoveryResult{
		Diagnostics: []provider.RuntimeDiagnostic{
			{
				Type:           "codex",
				Status:         "ready",
				Protocol:       "app-server",
				CheckedAt:      t0.Add(time.Minute),
				Version:        "codex-cli 0.171.0",
				Models:         []provider.RuntimeModel{{ID: "gpt-5", Label: "GPT-5", Link: "subscription", IsDefault: true}},
				ExecutablePath: codexCanonical,
				EntryPath:      codexBin,
				ExecutionPath:  "/v2/bin:/usr/bin",
			},
			{
				Type:   "antigravity",
				Status: "not_installed",
			},
		},
	}
	pathOnly.Installations = provider.InstallationsFromDiagnostics(pathOnly.Diagnostics)
	if err := applyRuntimeDiscovery(runCtx, pathOnly, env, "", providerCatalog, controller, inventory); err != nil {
		t.Fatalf("path-only discovery err=%v, want nil", err)
	}
	if got, ok, lookupErr := providerCatalog.Lookup(runCtx, "codex"); lookupErr != nil || !ok || got.Environment["PATH"] != "/v2/bin:/usr/bin" {
		t.Fatalf("providerCatalog PATH was not updated: ok=%v err=%v env=%v", ok, lookupErr, got.Environment)
	}
	ctrlDiagRaw, _ := controller.Runtimes(runCtx)
	ctrlDiags := ctrlDiagRaw.([]provider.RuntimeDiagnostic)
	if ctrlDiags[0].ExecutionPath != "/v2/bin:/usr/bin" || !ctrlDiags[0].CheckedAt.Equal(t0.Add(time.Minute)) {
		t.Fatalf("controller diagnostics were not updated: %+v", ctrlDiags[0])
	}
	if rev := inventoryRevision(inventory); rev != 10 || stream.eventCount(protocol.EventRuntimeDiagnostics) != 0 {
		t.Fatalf("unexpected gateway publish: revision=%d events=%d", rev, stream.eventCount(protocol.EventRuntimeDiagnostics))
	}
	if strings.Contains(logBuf.String(), "runtime.diagnostic") {
		t.Fatalf("unexpected runtime.diagnostic log on path-only update:\n%s", logBuf.String())
	}

	// Changing a Gateway-visible field (Models) must log and publish.
	modelsChanged := provider.DiscoveryResult{
		Diagnostics: []provider.RuntimeDiagnostic{
			{
				Type:           "codex",
				Status:         "ready",
				Protocol:       "app-server",
				CheckedAt:      t0.Add(2 * time.Minute),
				Version:        "codex-cli 0.171.0",
				Models:         []provider.RuntimeModel{{ID: "gpt-6", Label: "GPT-6", Link: "subscription", IsDefault: true}},
				ExecutablePath: codexCanonical,
				EntryPath:      codexBin,
				ExecutionPath:  "/v2/bin:/usr/bin",
			},
		},
	}
	modelsChanged.Installations = provider.InstallationsFromDiagnostics(modelsChanged.Diagnostics)
	if err := applyRuntimeDiscovery(runCtx, modelsChanged, env, "", providerCatalog, controller, inventory); err != nil {
		t.Fatalf("models-changed discovery err=%v, want nil", err)
	}
	if rev := inventoryRevision(inventory); rev != 11 || stream.eventCount(protocol.EventRuntimeDiagnostics) != 1 {
		t.Fatalf("gateway publish did not run: revision=%d events=%d", rev, stream.eventCount(protocol.EventRuntimeDiagnostics))
	}
	if !strings.Contains(logBuf.String(), "runtime.diagnostic") {
		t.Fatalf("expected runtime.diagnostic log on model change")
	}

	// Model rejection still republishes.
	inventory.reject("codex", "gpt-6")
	deadline = time.Now().Add(5 * time.Second)
	for stream.eventCount(protocol.EventRuntimeDiagnostics) < 2 {
		if time.Now().After(deadline) {
			t.Fatalf("reject did not republish runtime inventory; revision=%d", inventoryRevision(inventory))
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancelRun()
	closeRelease()
	<-runDone
}

func TestApplyRuntimeDiscoveryCommitsOnlyAfterGatewayPublishSucceeds(t *testing.T) {
	var logBuf syncLogBuffer
	prevLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logBuf, nil)))
	t.Cleanup(func() { slog.SetDefault(prevLogger) })

	identity, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	release := make(chan struct{})
	var closeReleaseOnce sync.Once
	closeRelease := func() { closeReleaseOnce.Do(func() { close(release) }) }
	defer closeRelease()
	stream := &mainTestStream{
		commands: []protocol.Command{{Type: "runner.welcome", ConnectionEpoch: 1}},
		wait:     release,
	}

	codexBin := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(codexBin, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	codexCanonical, err := filepath.EvalSymlinks(codexBin)
	if err != nil {
		t.Fatal(err)
	}

	t0 := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
	initialResult := provider.DiscoveryResult{
		Diagnostics: []provider.RuntimeDiagnostic{{
			Type:           "codex",
			Status:         "ready",
			Protocol:       "app-server",
			CheckedAt:      t0,
			Version:        "codex-cli 0.171.0",
			Models:         []provider.RuntimeModel{{ID: "gpt-5", Label: "GPT-5", Link: "subscription", IsDefault: true}},
			ExecutablePath: codexCanonical,
			EntryPath:      codexBin,
			ExecutionPath:  "/v1/bin:/usr/bin",
		}},
	}
	initialResult.Installations = provider.InstallationsFromDiagnostics(initialResult.Diagnostics)

	env := map[string]string{"HOME": t.TempDir(), "PATH": "/usr/bin"}
	initialProviders, initialRuntimes := providerInstallations(initialResult, env, "")
	providerCatalog := lingercontext.NewProviderCatalog(initialProviders)
	computer := computerconfig.Config{
		ComputerID: "comp-1",
		Owners:     []computerconfig.Owner{{TenantID: "tenant-1", OwnerActorID: "owner-1"}},
	}
	initialDiagnosticsJSON, err := provider.DiagnosticsJSON(provider.GatewayDiagnostics(initialResult.Diagnostics))
	if err != nil {
		t.Fatal(err)
	}
	localDaemon, err := daemon.New(daemon.Options{
		ComputerID:          computer.ComputerID,
		ControlPlane:        mainTestControlPlane{stream: stream},
		IdentityStore:       mainTestIdentityStore{value: identity},
		OperationResolver:   mainTestResolver{},
		Ledger:              daemon.NewMemoryLedger(),
		Registrations:       registration.NewMemoryStore(),
		Assignments:         assignment.NewMemoryStore(),
		Runtimes:            initialRuntimes,
		RuntimeDiagnostics:  initialDiagnosticsJSON,
		RuntimeObservations: runtimeObservations(computer, provider.GatewayDiagnostics(initialResult.Diagnostics), 10),
	})
	if err != nil {
		t.Fatal(err)
	}

	runCtx, cancelRun := context.WithCancel(t.Context())
	defer cancelRun()
	runDone := make(chan error, 1)
	go func() { runDone <- localDaemon.Run(runCtx) }()
	deadline := time.Now().Add(5 * time.Second)
	for localDaemon.GatewayState() != "connected" {
		if time.Now().After(deadline) {
			t.Fatal("daemon did not reach connected state")
		}
		time.Sleep(10 * time.Millisecond)
	}

	controller := &controlController{daemon: localDaemon, diagnostics: initialResult.Diagnostics}
	inventory, err := newRuntimeInventory(computer, provider.NewRejectedModels(nil), initialRuntimes, initialResult.Diagnostics, 10)
	if err != nil {
		t.Fatal(err)
	}
	inventory.start(runCtx, localDaemon)

	modelsChanged := provider.DiscoveryResult{
		Diagnostics: []provider.RuntimeDiagnostic{{
			Type:           "codex",
			Status:         "ready",
			Protocol:       "app-server",
			CheckedAt:      t0.Add(time.Minute),
			Version:        "codex-cli 0.171.0",
			Models:         []provider.RuntimeModel{{ID: "gpt-6", Label: "GPT-6", Link: "subscription", IsDefault: true}},
			ExecutablePath: codexCanonical,
			EntryPath:      codexBin,
			ExecutionPath:  "/v2/bin:/usr/bin",
		}},
	}
	modelsChanged.Installations = provider.InstallationsFromDiagnostics(modelsChanged.Diagnostics)

	// Inject a transient Gateway send error: must return error, suppress
	// runtime.diagnostic log, and leave publishedGateway uncommitted.
	stream.setSendErr(errors.New("transient gateway send error"))
	if err := applyRuntimeDiscovery(runCtx, modelsChanged, env, "", providerCatalog, controller, inventory); err == nil {
		t.Fatal("expected failed publish on transient stream error")
	}
	if stream.eventCount(protocol.EventRuntimeDiagnostics) != 0 {
		t.Fatalf("unexpected gateway event on failed publish: events=%d", stream.eventCount(protocol.EventRuntimeDiagnostics))
	}
	if strings.Contains(logBuf.String(), "runtime.diagnostic") {
		t.Fatalf("logged runtime.diagnostic on failed gateway publish:\n%s", logBuf.String())
	}

	// Clear the transient error and retry: must commit and emit runtime.diagnostic once.
	stream.setSendErr(nil)
	if err := applyRuntimeDiscovery(runCtx, modelsChanged, env, "", providerCatalog, controller, inventory); err != nil {
		t.Fatalf("retry after transient error failed: err=%v", err)
	}
	if stream.eventCount(protocol.EventRuntimeDiagnostics) != 1 {
		t.Fatalf("gateway events = %d, want 1", stream.eventCount(protocol.EventRuntimeDiagnostics))
	}
	if got := strings.Count(logBuf.String(), "runtime.diagnostic"); got != 1 {
		t.Fatalf("runtime.diagnostic log count = %d, want 1:\n%s", got, logBuf.String())
	}

	cancelRun()
	closeRelease()
	<-runDone
}

func TestResidentProcessesRemainReusableAcrossMonitorTicksWithFnmAndShellTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX terminal and resident fixture")
	}
	root := t.TempDir()
	// Isolate macOS keychain lookups during Claude discovery/probes.
	if runtime.GOOS == "darwin" {
		secDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(secDir, "security"), []byte("#!/bin/sh\nexit 44\n"), 0o700); err != nil {
			t.Fatal(err)
		}
		t.Setenv("PATH", secDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	}
	t.Cleanup(func() {
		_, _ = native.StopAllParkedResidents()
		native.FlushTimings()
	})

	fnmInstall := filepath.Join(root, "fnm", "node-versions", "v22.0.0", "installation")
	nodeBin := filepath.Join(fnmInstall, "bin")
	multishellsDir := filepath.Join(root, "state", "fnm_multishells")
	workDir := filepath.Join(root, "workspace")
	runtimeHomeRoot := filepath.Join(root, "runtime-homes")
	tempBase := filepath.Join(root, "op-tmp")
	for _, dir := range []string{nodeBin, multishellsDir, workDir, runtimeHomeRoot, tempBase} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(nodeBin, "fixture-node"), []byte("#!/bin/sh\nexec /bin/sh \"$@\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}

	sed, err := exec.LookPath("sed")
	if err != nil {
		t.Fatal(err)
	}
	codexTurnLog := filepath.Join(root, "codex-turns.log")
	claudeTurnLog := filepath.Join(root, "claude-turns.log")
	piTurnLog := filepath.Join(root, "pi-turns.log")

	codexScript := `#!/usr/bin/env fixture-node
if [ "$1" = "--version" ]; then echo "codex-cli 0.171.0"; exit 0; fi
while IFS= read -r line; do
  id=$(printf '%s' "$line" | "$LINGER_TEST_SED" -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  method=$(printf '%s' "$line" | "$LINGER_TEST_SED" -n 's/.*"method":"\([^"]*\)".*/\1/p')
  [ -n "$id" ] || continue
  case "$method" in
  config/read) result='{"config":{"features":{"memories":false,"memory_tool":false}}}' ;;
  account/read) result='{"account":{"type":"chatgpt"},"requiresOpenaiAuth":true}' ;;
  model/list) result='{"data":[{"id":"gpt-test","isDefault":true}],"nextCursor":null}' ;;
  thread/start|thread/resume)
    result='{"thread":{"id":"thread-1"}}' ;;
  turn/start)
    echo "$$" >> "$CODEX_TURN_LOG"
    printf '{"jsonrpc":"2.0","id":%s,"result":{"turn":{"id":"turn-1"}}}\n' "$id"
    printf '{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}\n'
    printf '{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed"}}}\n'
    continue ;;
  *) result='{}' ;;
  esac
  printf '{"jsonrpc":"2.0","id":%s,"result":%s}\n' "$id" "$result"
done
`
	claudeScript := `#!/usr/bin/env fixture-node
if [ "$1" = "--version" ]; then echo "claude 2.1.284"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--effort <level> (low, medium, high)"; exit 0; fi
if [ "$1 $2 $3" = "auth status --json" ]; then echo '{"loggedIn":true}'; exit 0; fi
while IFS= read -r line; do
  case "$line" in
  *'"request_id":"linger-catalog"'*)
    printf '%s\n' '{"type":"control_response","response":{"subtype":"success","request_id":"linger-catalog","response":{"models":[{"value":"claude-test","displayName":"Claude test"}]}}}' ;;
  *'"type":"control_request"'*)
    rid=$(printf '%s' "$line" | "$LINGER_TEST_SED" -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
    printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{}}}\n' "$rid" ;;
  *'"type":"user"'*)
    echo "$$" >> "$CLAUDE_TURN_LOG"
    uuid=$(printf '%s' "$line" | "$LINGER_TEST_SED" -n 's/.*"uuid":"\([^"]*\)".*/\1/p')
    printf '{"type":"system","subtype":"init","session_id":"12345678-4321-4321-8321-123456789012"}\n'
    printf '{"type":"user","isReplay":true,"uuid":"%s","session_id":"12345678-4321-4321-8321-123456789012"}\n' "$uuid"
    printf '{"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed","result":"done","session_id":"12345678-4321-4321-8321-123456789012","user_message_uuid":"%s"}\n' "$uuid" ;;
  esac
done
`
	piScript := `#!/usr/bin/env fixture-node
if [ "$1" = "--version" ]; then echo "1.2.0"; exit 0; fi
if [ "$1" = "auth" ]; then echo '{"status":"ready"}'; exit 0; fi
session_dir=""
session_id=""
while [ $# -gt 0 ]; do
  case "$1" in
  --session-dir) session_dir="$2"; shift 2 ;;
  --session-id) session_id="$2"; shift 2 ;;
  *) shift ;;
  esac
done
while IFS= read -r line; do
  rid=$(printf '%s' "$line" | "$LINGER_TEST_SED" -n 's/.*"id":"\([^"]*\)".*/\1/p')
  case "$line" in
  *linger-probe*) printf '{"type":"response","id":"linger-probe","command":"get_state","success":true,"data":{"isStreaming":false}}\n' ;;
  *linger-state*) printf '{"type":"response","id":"linger-state","command":"get_state","success":true,"data":{"thinkingLevel":"off"}}\n' ;;
  *linger-models*) printf '{"type":"response","id":"linger-models","command":"get_available_models","success":true,"data":{"models":[{"provider":"builtin","id":"pi-test","name":"Pi test"}]}}\n' ;;
  *'"type":"get_state"'*)
    printf '{"type":"response","id":"%s","command":"get_state","success":true,"data":{"sessionId":"%s","isStreaming":false,"isCompacting":false,"pendingMessageCount":0}}\n' "$rid" "$session_id" ;;
  *'"type":"prompt"'*)
    echo "$$" >> "$PI_TURN_LOG"
    printf '{"type":"session","id":"%s","cwd":"%s"}\n' "$session_id" "$PWD" > "$session_dir/fixture_${session_id}.jsonl"
    printf '{"type":"response","id":"%s","command":"prompt","success":true,"data":{"disposition":"started"}}\n' "$rid"
    printf '{"type":"agent_start"}\n'
    printf '{"type":"message_start","message":{"role":"assistant"}}\n'
    printf '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"done"}}\n'
    printf '{"type":"message_end","message":{"role":"assistant","model":"fixture/model","stopReason":"stop","content":[{"type":"text","text":"done"}]}}\n'
    printf '{"type":"agent_end"}\n'
    printf '{"type":"agent_settled","aborted":false}\n' ;;
  esac
done
`
	for name, body := range map[string]string{"codex": codexScript, "claude": claudeScript, "pi": piScript} {
		if err := os.WriteFile(filepath.Join(nodeBin, name), []byte(body), 0o700); err != nil {
			t.Fatal(err)
		}
	}

	zshrc := filepath.Join(root, ".zshrc")
	if err := os.WriteFile(zshrc, []byte("# initial\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	shellSeqFile := filepath.Join(root, "shell-seq")
	shellTimeoutGate := filepath.Join(root, "shell-timeout")
	shellTimeoutStarted := filepath.Join(root, "shell-timeout-started")
	shell := filepath.Join(root, "fnm-login-shell")
	shellScript := `#!/bin/sh
seq=0
if [ -f "$SHELL_SEQ_FILE" ]; then read seq < "$SHELL_SEQ_FILE"; fi
seq=$((seq + 1))
echo "$seq" > "$SHELL_SEQ_FILE"
link="$MULTISHELLS_DIR/shell_${seq}_$$"
ln -s "$FNM_INSTALL_DIR" "$link"
if [ -f "$SHELL_TIMEOUT_GATE" ]; then
  printf 'started\n' > "$SHELL_TIMEOUT_STARTED"
  sleep 8
  exit 0
fi
export FNM_MULTISHELL_PATH="$link"
export PATH="$link/bin:/usr/bin:/bin"
exec /bin/sh -c "$2"
`
	if err := os.WriteFile(shell, []byte(shellScript), 0o700); err != nil {
		t.Fatal(err)
	}

	baseEnv := map[string]string{
		"HOME":                  root,
		"SHELL":                 shell,
		"PATH":                  "/usr/bin:/bin",
		"XDG_STATE_HOME":        filepath.Join(root, "state"),
		"LINGER_TEST_SED":       sed,
		"FNM_INSTALL_DIR":       fnmInstall,
		"MULTISHELLS_DIR":       multishellsDir,
		"SHELL_SEQ_FILE":        shellSeqFile,
		"SHELL_TIMEOUT_GATE":    shellTimeoutGate,
		"SHELL_TIMEOUT_STARTED": shellTimeoutStarted,
		"CODEX_TURN_LOG":        codexTurnLog,
		"CLAUDE_TURN_LOG":       claudeTurnLog,
		"PI_TURN_LOG":           piTurnLog,
	}
	currentOptions := func() provider.DiscoveryOptions {
		return provider.DiscoveryOptions{
			Runtimes:        []string{"codex", "claude", "pi"},
			RuntimeHomeRoot: runtimeHomeRoot,
			Environment:     maps.Clone(baseEnv),
			Timeout:         10 * time.Second,
		}
	}

	termCache := provider.NewTerminalEnvironmentCache()
	initial, err := termCache.Discover(t.Context(), currentOptions())
	if err != nil {
		t.Fatal(err)
	}
	for _, rt := range []string{"codex", "claude", "pi"} {
		if _, ok := initial.Installations[rt]; !ok {
			t.Fatalf("%s was not discovered: %+v", rt, initial.Diagnostics)
		}
		if !strings.HasPrefix(initial.Installations[rt].ExecutionPath, nodeBin+":") {
			t.Fatalf("%s ExecutionPath=%q, want stabilized %q prefix", rt, initial.Installations[rt].ExecutionPath, nodeBin)
		}
	}
	if leftover, err := os.ReadDir(multishellsDir); err != nil || len(leftover) != 0 {
		t.Fatalf("fnm_multishells leaked symlinks after initial discover: entries=%v err=%v", leftover, err)
	}

	initialProviders, initialRuntimes := providerInstallations(initial, baseEnv, "")
	providerCatalog := lingercontext.NewProviderCatalog(initialProviders)
	inventory, err := newRuntimeInventory(computerconfig.Config{ComputerID: "comp-1"}, provider.NewRejectedModels(nil), initialRuntimes, initial.Diagnostics, 1)
	if err != nil {
		t.Fatal(err)
	}
	controller := &controlController{diagnostics: initial.Diagnostics}
	executor := provider.Executor{TempBase: tempBase, RuntimeHomeRoot: runtimeHomeRoot}

	runTurn := func(runtimeType, sessionID, resumeID string) provider.Result {
		t.Helper()
		installed, ok, lookupErr := providerCatalog.Lookup(t.Context(), runtimeType)
		if lookupErr != nil || !ok {
			t.Fatalf("lookup %s: ok=%v err=%v", runtimeType, ok, lookupErr)
		}
		execEnv := maps.Clone(installed.Environment)
		execEnv["TEAMHUB_CONFIG"] = filepath.Join(root, "teamhub.json")
		execEnv["TEAMHUB_PROFILE"] = "runtime"
		spec := provider.OperationSpec{
			OperationKind:    "run.start",
			Provider:         runtimeType,
			ExecutablePath:   installed.ExecutablePath,
			WorkingDirectory: workDir,
			Prompt:           "hello",
			Environment:      execEnv,
			Timeout:          15 * time.Second,
			CodexVersion:     "0.171.0",
			TenantID:         "tenant-1",
			OwnerActorID:     "owner-1",
			AgentID:          "agent-1",
			ScopeID:          "context-1",
		}
		if runtimeType == "codex" {
			spec.ResumeSessionID = resumeID
		} else if resumeID != "" {
			spec.ResumeSessionID = resumeID
		} else {
			spec.CreateProviderSessionID = sessionID
		}
		execution, startErr := executor.Start(t.Context(), spec, func(context.Context, protocol.Event) error { return nil })
		if startErr != nil {
			t.Fatalf("%s Start failed: %v", runtimeType, startErr)
		}
		result := <-execution.Result
		if result.Status != "completed" {
			t.Fatalf("%s turn failed: %+v", runtimeType, result)
		}
		return result
	}

	const claudeSession = "12345678-4321-4321-8321-123456789012"
	const piSession = "87654321-4321-4321-8321-123456789012"
	codexFirst := runTurn("codex", "", "")
	runTurn("claude", claudeSession, "")
	runTurn("pi", piSession, "")

	// Run MonitorRuntimeDiagnostics across:
	// 1) steady full ticks (no shell launch)
	// 2) .zshrc change creating a new fnm_multishells symlink (stabilized + cleaned up)
	// 3) .zshrc change with shell timeout (never degrades cached PATH)
	monitorCtx, cancelMonitor := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancelMonitor()

	var fullRefreshCount atomic.Int32
	var phase atomic.Int32
	modTime := time.Now().Add(2 * time.Second)
	touchZshrc := func() {
		modTime = modTime.Add(time.Second)
		_ = os.WriteFile(zshrc, []byte(fmt.Sprintf("# edit %d\n", modTime.Unix())), 0o600)
		_ = os.Chtimes(zshrc, modTime, modTime)
	}

	concurrentUserTab := filepath.Join(multishellsDir, "concurrent_user_tab")
	concurrentDone := make(chan struct{})
	var concurrentStarted atomic.Bool
	var concurrentErr error
	t.Cleanup(func() {
		if concurrentStarted.Load() {
			<-concurrentDone
		}
	})

	assertPostTimeoutMultishells := func(tb testing.TB) {
		tb.Helper()
		if _, statErr := os.Lstat(concurrentUserTab); statErr != nil {
			tb.Errorf("concurrent fnm_multishells symlink %s was deleted: %v", concurrentUserTab, statErr)
		}
		entries, readErr := os.ReadDir(multishellsDir)
		if readErr != nil {
			tb.Errorf("read fnm_multishells: %v", readErr)
			return
		}
		var names []string
		hasTimeoutLink := false
		hasConcurrent := false
		for _, entry := range entries {
			name := entry.Name()
			names = append(names, name)
			switch {
			case name == "concurrent_user_tab":
				hasConcurrent = true
			case strings.HasPrefix(name, "shell_3_"):
				hasTimeoutLink = true
			case strings.HasPrefix(name, "shell_1_") || strings.HasPrefix(name, "shell_2_"):
				tb.Errorf("healthy tick symlink %s leaked after timeout: entries=%v", name, names)
			default:
				tb.Errorf("unexpected fnm_multishells entry %s after timeout: entries=%v", name, names)
			}
		}
		if !hasConcurrent || !hasTimeoutLink || len(entries) != 2 {
			tb.Errorf("fnm_multishells entries after timeout = %v, want concurrent_user_tab and one shell_3_*", names)
		}
	}

	monitorErr := provider.MonitorRuntimeDiagnostics(monitorCtx, provider.RuntimeMonitorOptions{
		Initial:               initial,
		Discovery:             currentOptions(),
		ResolveDiscovery:      currentOptions,
		TerminalEnvironment:   termCache,
		RefreshInterval:       10 * time.Millisecond,
		FullRefreshEveryTicks: 1,
		RefreshAllowed: func() bool {
			tick := fullRefreshCount.Add(1)
			switch {
			case tick == 3 && phase.CompareAndSwap(0, 1):
				// Verify steady ticks did not re-run the shell.
				seqData, _ := os.ReadFile(shellSeqFile)
				if strings.TrimSpace(string(seqData)) != "1" {
					t.Errorf("steady monitor ticks re-ran shell: seq=%q", string(seqData))
				}
				// Trigger a .zshrc reload with a brand-new fnm_multishells symlink.
				touchZshrc()
			case tick == 5 && phase.CompareAndSwap(1, 2):
				seqData, _ := os.ReadFile(shellSeqFile)
				if strings.TrimSpace(string(seqData)) != "2" {
					t.Errorf(".zshrc edit did not trigger shell re-capture: seq=%q", string(seqData))
				}
				if leftover, readErr := os.ReadDir(multishellsDir); readErr != nil || len(leftover) != 0 {
					t.Errorf("fnm_multishells leaked symlinks after healthy ticks: entries=%v err=%v", leftover, readErr)
				}
				// Trigger a .zshrc reload while the shell times out and a concurrent
				// user session creates a symlink in the shared fnm_multishells dir.
				_ = os.WriteFile(shellTimeoutGate, []byte("1\n"), 0o600)
				concurrentStarted.Store(true)
				go func() {
					defer close(concurrentDone)
					ticker := time.NewTicker(5 * time.Millisecond)
					defer ticker.Stop()
					for {
						if _, statErr := os.Stat(shellTimeoutStarted); statErr == nil {
							concurrentErr = os.Symlink(fnmInstall, concurrentUserTab)
							return
						}
						select {
						case <-monitorCtx.Done():
							concurrentErr = monitorCtx.Err()
							return
						case <-ticker.C:
						}
					}
				}()
				touchZshrc()
			case tick >= 8 && phase.Load() == 2:
				if concurrentStarted.Load() {
					select {
					case <-concurrentDone:
					case <-monitorCtx.Done():
					}
					if concurrentErr != nil {
						t.Errorf("failed to create concurrent fnm_multishells symlink during timeout: %v", concurrentErr)
					}
				}
				seqData, _ := os.ReadFile(shellSeqFile)
				if strings.TrimSpace(string(seqData)) != "3" {
					t.Errorf("shell timeout did not invoke once and back off across monitor ticks: seq=%q, want 3", string(seqData))
				}
				assertPostTimeoutMultishells(t)
				cancelMonitor()
				return false
			}
			return true
		},
		OnChanged: func(next provider.DiscoveryResult) error {
			return applyRuntimeDiscovery(monitorCtx, next, baseEnv, "", providerCatalog, controller, inventory)
		},
	})
	if !errors.Is(monitorErr, context.Canceled) {
		t.Fatalf("monitor exited with %v, want context.Canceled", monitorErr)
	}
	assertPostTimeoutMultishells(t)
	if rev := inventoryRevision(inventory); rev != 1 {
		t.Fatalf("Gateway inventory revision bumped unnecessarily: got %d, want 1", rev)
	}

	// Second turn for all 3 Runtimes must adopt the parked residents without recycling.
	runTurn("codex", "", codexFirst.SessionID)
	runTurn("claude", "", claudeSession)
	runTurn("pi", "", piSession)

	for _, pair := range []struct {
		name string
		log  string
	}{
		{"codex", codexTurnLog},
		{"claude", claudeTurnLog},
		{"pi", piTurnLog},
	} {
		data, readErr := os.ReadFile(pair.log)
		if readErr != nil {
			t.Fatalf("read %s turn log: %v", pair.name, readErr)
		}
		pids := strings.Fields(strings.TrimSpace(string(data)))
		if len(pids) != 2 || pids[0] != pids[1] {
			t.Fatalf("%s did not reuse resident process across monitor ticks: turn pids=%v", pair.name, pids)
		}
	}

	diagLogs, err := filepath.Glob(filepath.Join(runtimeHomeRoot, "*", "*", "runner-diagnostics.log"))
	if err != nil || len(diagLogs) == 0 {
		t.Fatalf("missing runner-diagnostics.log files: %v %v", diagLogs, err)
	}
	var combined strings.Builder
	for _, path := range diagLogs {
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			t.Fatal(readErr)
		}
		combined.Write(data)
	}
	allLogs := combined.String()
	if strings.Contains(allLogs, "resident recycled") {
		t.Fatalf("unexpected resident recycle in diagnostics log:\n%s", allLogs)
	}
	if strings.Contains(allLogs, `"mismatch":"env"`) || strings.Contains(allLogs, `"mismatch":"config_args"`) {
		t.Fatalf("unexpected env/config_args mismatch in diagnostics log:\n%s", allLogs)
	}
	for _, reused := range []string{"codex resident reused", "claude resident reused", "pi resident reused"} {
		if !strings.Contains(allLogs, reused) {
			t.Fatalf("missing %q in diagnostics log:\n%s", reused, allLogs)
		}
	}
}
