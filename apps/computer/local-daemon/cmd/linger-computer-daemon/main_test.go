package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/computerconfig"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/assignment"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/localmodels"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
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
if [ "$1" = "--version" ]; then echo 'codex-cli 0.144.1'; exit 0; fi
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
				if err != nil || strings.TrimSpace(string(output)) != "codex-cli 0.144.1" {
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

// Discovery keeps at most 100 models, so a BYOK route a Runtime lists late can
// fall outside the catalog. The Computer still serves that route.
func TestByokRuntimeCatalogsKeepTheEnteredModelOutsideTheCatalog(t *testing.T) {
	truncated := []provider.RuntimeDiagnostic{
		{Type: "pi", Models: []provider.RuntimeModel{{ID: "anthropic/claude-1", Label: "claude-1", IsDefault: true}}},
	}
	source := &localmodels.OverlayState{Mode: "byok", Runtime: "pi", RuntimeModel: "localmodels/localmodels-byok", ModelLabel: "vendor/model"}

	shaped := byokRuntimeCatalogs(truncated, source)
	want := []provider.RuntimeModel{{ID: "localmodels/localmodels-byok", Label: "vendor/model", AllowedReasoningEffort: []string{}, IsDefault: true}}
	if !reflect.DeepEqual(shaped[0].Models, want) {
		t.Fatalf("Pi models = %+v, want %+v", shaped[0].Models, want)
	}
	if len(truncated[0].Models) != 1 || truncated[0].Models[0].Label != "claude-1" {
		t.Fatalf("input diagnostics were modified: %+v", truncated[0].Models)
	}
	// Only the source's Runtime takes the entered model.
	mixed := byokRuntimeCatalogs([]provider.RuntimeDiagnostic{
		{Type: "pi", Models: []provider.RuntimeModel{}},
		{Type: "claude", Models: []provider.RuntimeModel{{ID: "default", Label: "Default", IsDefault: true}}},
	}, source)
	if len(mixed[1].Models) != 1 || mixed[1].Models[0].ID != "default" {
		t.Fatalf("another Runtime's catalog changed: %+v", mixed[1].Models)
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
