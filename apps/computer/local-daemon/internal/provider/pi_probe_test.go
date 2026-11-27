package provider

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestPiAuthenticationBoundsUnresponsiveModelCatalog(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell")
	}
	root := t.TempDir()
	executable := filepath.Join(root, "pi")
	// Priming runs without HOME and exits at once.
	if err := os.WriteFile(executable, []byte("#!/bin/sh\n[ -n \"$HOME\" ] || exit 0\necho \"$$\" > \"$HOME/pi-probe.pid\"\nexec /bin/sleep 60\n"), 0700); err != nil {
		t.Fatal(err)
	}
	// macOS scans a new executable on its first run, which can outlast the
	// probe's one second budget.
	primeTestExecutable(t, executable, "PATH=/usr/bin:/bin")
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	result := make(chan runtimeProbeOutcome, 1)
	go func() {
		result <- probePiAuthentication(ctx, executable, map[string]string{"HOME": root, "PATH": root}, time.Second, "")
	}()
	select {
	case outcome := <-result:
		if outcome.Status != "error" || outcome.Code != "RUNTIME_DIAGNOSTIC_FAILED" {
			t.Fatalf("unresponsive model catalog: %+v", outcome)
		}
		if ctx.Err() != nil {
			t.Fatalf("probe canceled the resident context: %v", ctx.Err())
		}
	case <-time.After(20 * time.Second):
		cancel()
		<-result
		t.Fatal("authentication refresh blocked on an unresponsive model catalog")
	}
	pidBytes, err := os.ReadFile(filepath.Join(root, "pi-probe.pid"))
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(pidBytes)))
	if err != nil {
		t.Fatal(err)
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		t.Fatal(err)
	}
	defer process.Release()
	if err := process.Signal(syscall.Signal(0)); err == nil {
		t.Fatalf("model catalog process %d survived the probe deadline", pid)
	}
}

func TestPiDiscoveryAndAuthenticationRecovery(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell")
	}
	root := t.TempDir()
	executable := filepath.Join(root, "pi")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then echo '1.2.0'; exit 0; fi
if [ "$1" = "auth" ]; then
 [ "$2 $3 $4 $5" = "check --model fixture/model --json" ] || exit 41
 [ "$PI_CODING_AGENT_DIR" = "$HOME/.pi/agent" ] || exit 42
 if [ -f "$HOME/logged-in" ]; then echo '{"status":"ready"}'; else echo '{"status":"not_ready"}'; exit 1; fi
 exit 0
fi
case " $* " in *" --no-extensions "*) ;; *) exit 43 ;; esac
case " $* " in *" --no-mcp "*) ;; *) exit 44 ;; esac
while IFS= read -r line; do
 case "$line" in
 *linger-probe*) echo '{"type":"response","id":"linger-probe","command":"get_state","success":true,"data":{"isStreaming":false}}' ;;
 *linger-state*) echo '{"type":"response","id":"linger-state","command":"get_state","success":true,"data":{"model":{"provider":"fixture","id":"model"},"thinkingLevel":"off"}}' ;;
 *linger-models*)
   if [ -f "$HOME/broken" ]; then echo '{"type":"response","id":"linger-models","command":"get_available_models","success":false}';
   elif [ -f "$HOME/logged-in" ]; then echo '{"type":"response","id":"linger-models","command":"get_available_models","success":true,"data":{"models":[{"provider":"fixture","id":"model","reasoning":true,"thinkingLevelMap":{"xhigh":null,"max":null}}]}}';
   else echo '{"type":"response","id":"linger-models","command":"get_available_models","success":true,"data":{"models":[]}}'; fi ;;
 esac
done
`
	if err := os.WriteFile(executable, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	options := DiscoveryOptions{Environment: map[string]string{"HOME": root, "PATH": root}, ConfiguredPaths: map[string]string{"pi": executable}, Timeout: 5 * time.Second}
	initial, err := Discover(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	if d := initial.Diagnostics[2]; d.Status != "authentication_required" || len(d.Models) != 0 {
		t.Fatalf("signed-out Pi: %+v", d)
	}
	if err := os.WriteFile(filepath.Join(root, "logged-in"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	refreshed, err := RefreshRuntimeAuthentication(context.Background(), initial, options)
	if err != nil {
		t.Fatal(err)
	}
	d := refreshed.Diagnostics[2]
	if d.Status != "ready" || len(d.Models) != 1 || d.Models[0].ID != "fixture/model" || d.Models[0].DefaultReasoningEffort != "none" ||
		!slices.Equal(d.Models[0].AllowedReasoningEffort, []string{"none", "minimal", "low", "medium", "high"}) {
		t.Fatalf("login did not refresh exact model capabilities: %+v", d)
	}
	if err := os.WriteFile(filepath.Join(root, "broken"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	broken, err := Discover(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	if d := broken.Diagnostics[2]; d.Status != "error" || len(d.Models) != 0 {
		t.Fatalf("broken model catalog invented a usable fallback: %+v", d)
	}
}

func TestPiDiscoveryUsesSingleRPCSessionAndReusesCatalog(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell")
	}
	for _, tc := range []struct {
		name            string
		probeReply      string
		wantLegacyState bool
	}{
		{
			name:            "real_pi_get_state",
			probeReply:      `{"type":"response","id":"linger-probe","command":"get_state","success":true,"data":{"isStreaming":false,"model":{"provider":"fixture","id":"model"},"thinkingLevel":"high"}}`,
			wantLegacyState: false,
		},
		{
			name:            "legacy_fixture_get_state",
			probeReply:      `{"type":"response","id":"linger-probe","command":"get_state","success":true,"data":{"isStreaming":false}}`,
			wantLegacyState: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			executable := filepath.Join(root, "pi")
			invocationsFile := filepath.Join(root, "invocations.log")
			rpcIDsFile := filepath.Join(root, "rpc-ids.log")
			script := `#!/bin/sh
printf '%s %s\n' "$1" "$2" >> "$INVOCATIONS_FILE"
if [ "$1" = "--version" ]; then echo '1.5.2'; exit 0; fi
if [ "$1" = "auth" ]; then
  [ "$2 $3 $4 $5" = "check --model fixture/model --json" ] || exit 41
  [ "$PI_CODING_AGENT_DIR" = "$HOME/.pi/agent" ] || exit 42
  echo '{"status":"ready"}'
  exit 0
fi
while IFS= read -r line; do
  case "$line" in
  *linger-probe*)
    echo "linger-probe" >> "$RPC_IDS_FILE"
    printf '%s\n' "$PROBE_REPLY" ;;
  *linger-state*)
    echo "linger-state" >> "$RPC_IDS_FILE"
    echo '{"type":"response","id":"linger-state","command":"get_state","success":true,"data":{"model":{"provider":"fixture","id":"model"},"thinkingLevel":"high"}}' ;;
  *linger-models*)
    echo "linger-models" >> "$RPC_IDS_FILE"
    echo '{"type":"response","id":"linger-models","command":"get_available_models","success":true,"data":{"models":[{"provider":"fixture","id":"model","name":"Fixture Model","reasoning":true,"contextWindow":128000,"thinkingLevelMap":{"xhigh":null,"max":null}}]}}' ;;
  esac
done
`
			if err := os.WriteFile(executable, []byte(script), 0o700); err != nil {
				t.Fatal(err)
			}
			options := DiscoveryOptions{
				ConfiguredPaths: map[string]string{"pi": executable},
				Runtimes:        []string{"pi"},
				Timeout:         5 * time.Second,
				Environment: map[string]string{
					"HOME":             root,
					"PATH":             root,
					"INVOCATIONS_FILE": invocationsFile,
					"RPC_IDS_FILE":     rpcIDsFile,
					"PROBE_REPLY":      tc.probeReply,
				},
			}
			discovered, err := Discover(t.Context(), options)
			if err != nil {
				t.Fatal(err)
			}
			if len(discovered.Diagnostics) != 1 {
				t.Fatalf("diagnostics = %+v, want 1 entry", discovered.Diagnostics)
			}
			d := discovered.Diagnostics[0]
			if d.Status != "ready" || len(d.Models) != 1 {
				t.Fatalf("discovered pi = %+v, want ready with 1 model", d)
			}
			model := d.Models[0]
			if model.ID != "fixture/model" || model.Label != "Fixture Model" || !model.IsDefault || model.DefaultReasoningEffort != "high" || model.ContextWindow != 128000 {
				t.Fatalf("discovered model = %+v", model)
			}
			rawInvocations, err := os.ReadFile(invocationsFile)
			if err != nil {
				t.Fatal(err)
			}
			invocations := strings.Split(strings.TrimSpace(string(rawInvocations)), "\n")
			for i := range invocations {
				invocations[i] = strings.TrimSpace(invocations[i])
			}
			wantDiscoverInvocations := []string{"--version", "--mode rpc", "auth check"}
			if len(invocations) != len(wantDiscoverInvocations) {
				t.Fatalf("discover invocations = %q (count=%d), want %q (count=%d)", invocations, len(invocations), wantDiscoverInvocations, len(wantDiscoverInvocations))
			}
			for i, want := range wantDiscoverInvocations {
				if invocations[i] != want {
					t.Fatalf("discover invocation[%d] = %q, want %q (all=%q)", i, invocations[i], want, invocations)
				}
			}
			rawRPCIDs, err := os.ReadFile(rpcIDsFile)
			if err != nil {
				t.Fatal(err)
			}
			sawLegacyState := strings.Contains(string(rawRPCIDs), "linger-state")
			if sawLegacyState != tc.wantLegacyState {
				t.Fatalf("saw linger-state = %v, want %v (rpc ids=%q)", sawLegacyState, tc.wantLegacyState, string(rawRPCIDs))
			}

			// RefreshRuntimeAuthentication must invoke pi only twice (one RPC + auth check)
			// and reuse the catalog returned by the authentication probe.
			if err := os.WriteFile(invocationsFile, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			refreshed, err := RefreshRuntimeAuthentication(t.Context(), discovered, options)
			if err != nil {
				t.Fatal(err)
			}
			rd := refreshed.Diagnostics[0]
			if rd.Status != "ready" || len(rd.Models) != 1 || rd.Models[0].ID != "fixture/model" || !rd.Models[0].IsDefault {
				t.Fatalf("refreshed pi = %+v, want ready with refreshed model", rd)
			}
			rawRefreshInvocations, err := os.ReadFile(invocationsFile)
			if err != nil {
				t.Fatal(err)
			}
			refreshInvocations := strings.Split(strings.TrimSpace(string(rawRefreshInvocations)), "\n")
			wantRefreshInvocations := []string{"--mode rpc", "auth check"}
			if len(refreshInvocations) != len(wantRefreshInvocations) {
				t.Fatalf("refresh invocations = %q (count=%d), want %q (count=%d)", refreshInvocations, len(refreshInvocations), wantRefreshInvocations, len(wantRefreshInvocations))
			}
			for i, want := range wantRefreshInvocations {
				if refreshInvocations[i] != want {
					t.Fatalf("refresh invocation[%d] = %q, want %q (all=%q)", i, refreshInvocations[i], want, refreshInvocations)
				}
			}
		})
	}
}

func TestPiRuntimeProbeFailureModes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell")
	}
	root := t.TempDir()
	executable := filepath.Join(root, "pi")
	script := `#!/bin/sh
[ -n "$FIXTURE_MODE" ] || exit 0
if [ "$FIXTURE_MODE" = "incompatible" ]; then
  while IFS= read -r line; do
    case "$line" in
    *linger-probe*) echo '{"type":"response","id":"linger-probe","command":"get_state","success":false}'; exit 0 ;;
    esac
  done
  exit 2
fi
if [ "$FIXTURE_MODE" = "timeout" ]; then
  exec /bin/sleep 60
fi
if [ "$FIXTURE_MODE" = "models_failed" ]; then
  while IFS= read -r line; do
    case "$line" in
    *linger-probe*) echo '{"type":"response","id":"linger-probe","command":"get_state","success":true,"data":{"isStreaming":false,"model":null,"thinkingLevel":"off"}}' ;;
    *linger-models*) echo '{"type":"response","id":"linger-models","command":"get_available_models","success":false}' ;;
    esac
  done
  exit 0
fi
exit 1
`
	if err := os.WriteFile(executable, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	primeTestExecutable(t, executable, "PATH=/usr/bin:/bin")

	t.Run("incompatible", func(t *testing.T) {
		home := t.TempDir()
		outcome := probeRuntime(t.Context(), "pi", executable, map[string]string{"HOME": home, "PATH": root, "FIXTURE_MODE": "incompatible"}, 5*time.Second, probeOptions{})
		if outcome.Status != "incompatible" || outcome.Code != "RUNTIME_INCOMPATIBLE" || outcome.protocolVerified {
			t.Fatalf("incompatible outcome = %+v", outcome)
		}
	})

	t.Run("timeout", func(t *testing.T) {
		home := t.TempDir()
		outcome := probeRuntime(t.Context(), "pi", executable, map[string]string{"HOME": home, "PATH": root, "FIXTURE_MODE": "timeout"}, 300*time.Millisecond, probeOptions{})
		if outcome.Status != "error" || outcome.Code != "RUNTIME_DIAGNOSTIC_FAILED" || outcome.Message != "Runtime protocol handshake could not be completed within its deadline" || outcome.protocolVerified {
			t.Fatalf("timeout outcome = %+v", outcome)
		}
	})

	t.Run("models_failure", func(t *testing.T) {
		home := t.TempDir()
		outcome := probeRuntime(t.Context(), "pi", executable, map[string]string{"HOME": home, "PATH": root, "FIXTURE_MODE": "models_failed"}, 5*time.Second, probeOptions{})
		if outcome.Status != "error" || outcome.Code != "RUNTIME_DIAGNOSTIC_FAILED" || outcome.Message != "Pi authentication could not be verified" || !outcome.protocolVerified {
			t.Fatalf("models failure outcome = %+v", outcome)
		}
	})
}

func TestPiRuntimeProbeLogsExitCodeAndRedactedStderrOnHandshakeFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX shell")
	}
	var output bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&output, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	root := t.TempDir()
	executable := filepath.Join(root, "pi")
	script := `#!/bin/sh
echo "error: unexpected argument found; api_key=sk-secret-value" >&2
exit 7
`
	if err := os.WriteFile(executable, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	outcome := probePiRuntime(t.Context(), executable, map[string]string{"HOME": root, "PATH": root}, 5*time.Second)
	if outcome.Status != "incompatible" || outcome.Code != "RUNTIME_INCOMPATIBLE" || outcome.protocolVerified {
		t.Fatalf("outcome = %+v, want incompatible", outcome)
	}
	if strings.Contains(outcome.Message, "sk-secret-value") || strings.Contains(outcome.Message, "unexpected argument") {
		t.Fatalf("diagnostic message must stay categorical: %q", outcome.Message)
	}
	logged := output.String()
	for _, want := range []string{"runner.runtime_probe.handshake_failed", "runtime_type=pi", "exit_code=7", "stderr_tail=", "unexpected argument found"} {
		if !strings.Contains(logged, want) {
			t.Fatalf("log lacks %q: %s", want, logged)
		}
	}
	if strings.Contains(logged, "sk-secret-value") {
		t.Fatalf("log kept unredacted credential: %s", logged)
	}
}
