//go:build !windows

package provider

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestDiscoveryRecoversTransientVersionTimeout(t *testing.T) {
	root := t.TempDir()
	executable := filepath.Join(root, "pi")
	script := `#!/bin/sh
if [ "$1" = "--fixture-warmup" ]; then exit 0; fi
if [ "$1" = "--version" ]; then
 echo version >> "$HOME/attempts"
 if [ ! -f "$HOME/first.pid" ]; then
  /bin/sleep 30 &
  echo "$!" > "$HOME/first.pid"
  wait
 fi
 echo '1.3.0'; exit 0
fi
if [ "$1" = "auth" ]; then echo '{"status":"ready"}'; exit 0; fi
while IFS= read -r line; do
 case "$line" in
 *linger-probe*) echo '{"type":"response","id":"linger-probe","command":"get_state","success":true,"data":{"isStreaming":false}}' ;;
 *linger-state*) echo '{"type":"response","id":"linger-state","command":"get_state","success":true,"data":{"model":{"provider":"fixture","id":"model"},"thinkingLevel":"off"}}' ;;
 *linger-models*) echo '{"type":"response","id":"linger-models","command":"get_available_models","success":true,"data":{"models":[{"provider":"fixture","id":"model"}]}}' ;;
 esac
done
`
	if err := os.WriteFile(executable, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	warmVersionFixture(t, executable)
	result, err := Discover(t.Context(), DiscoveryOptions{
		Environment:     map[string]string{"HOME": root, "PATH": root},
		ConfiguredPaths: map[string]string{"pi": executable}, Timeout: 500 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	// The timed-out attempt's whole child tree must be gone, even on failure.
	data, err := os.ReadFile(filepath.Join(root, "first.pid"))
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		t.Fatal(err)
	}
	defer process.Release()
	if err := process.Signal(syscall.Signal(0)); err == nil {
		t.Fatalf("timed-out version child %d survived", pid)
	}
	if d := result.Diagnostics[2]; d.Status != "ready" || d.Version != "1.3.0" || len(d.Models) != 1 {
		t.Fatalf("Pi did not recover in one discovery: %+v", d)
	}
	attempts, err := os.ReadFile(filepath.Join(root, "attempts"))
	if err != nil {
		t.Fatal(err)
	}
	if string(attempts) != "version\nversion\n" {
		t.Fatalf("version attempts: %q", attempts)
	}
}

func TestDiscoveryVersionFailuresRemainBounded(t *testing.T) {
	// Every case runs one shared executable that takes its body from the
	// environment, so only the first launch pays the macOS executable scan.
	executable := filepath.Join(t.TempDir(), "pi")
	script := "#!/bin/sh\nif [ \"$1\" = \"--fixture-warmup\" ]; then exit 0; fi\nif [ \"$1\" = \"--version\" ]; then\necho version >> \"$HOME/attempts\"\neval \"$FIXTURE_BODY\"\nexit\nfi\nexit 7\n"
	if err := os.WriteFile(executable, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	warmVersionFixture(t, executable)
	for _, tc := range []struct {
		name, body, status string
		attempts           int
		// cancelAfter cancels the caller once that many attempts have
		// started, so the caller cases do not race a wall-clock deadline.
		cancelAfter int
	}{
		{name: "persistent timeout", body: "/bin/sleep 30", status: "error", attempts: 2},
		{name: "caller canceled", body: "/bin/sleep 30", status: "error", attempts: 1, cancelAfter: 1},
		{name: "caller canceled during retry", body: "/bin/sleep 30", status: "error", attempts: 2, cancelAfter: 2},
		{name: "execution error", body: "exit 7", status: "error", attempts: 1},
		{name: "empty version", body: "exit 0", status: "error", attempts: 1},
		{name: "unparseable version", body: "echo starting", status: "error", attempts: 1},
		{name: "incompatible version", body: "echo 1.0.0", status: "incompatible", attempts: 1},
		{name: "protocol failure", body: "echo 1.3.0", status: "incompatible", attempts: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if tc.cancelAfter > 0 {
				go cancelAfterAttempts(ctx, cancel, filepath.Join(root, "attempts"), tc.cancelAfter)
			}
			started := time.Now()
			// A fast failure never waits on the budget, so a generous one keeps
			// a loaded host from turning it into a timeout and a retry.
			result, err := Discover(ctx, DiscoveryOptions{Environment: map[string]string{"HOME": root, "PATH": root, "FIXTURE_BODY": tc.body}, ConfiguredPaths: map[string]string{"pi": executable}, Timeout: 2 * time.Second})
			if err != nil {
				t.Fatal(err)
			}
			if d := result.Diagnostics[2]; d.Status != tc.status {
				t.Fatalf("diagnostic=%+v", d)
			}
			attempts, err := os.ReadFile(filepath.Join(root, "attempts"))
			if err != nil {
				t.Fatal(err)
			}
			if got := strings.Count(string(attempts), "version\n"); got != tc.attempts {
				t.Fatalf("attempts=%d, want %d", got, tc.attempts)
			}
			// Two 2s attempts at most; a leaked wait on the 30s child would
			// blow far past this.
			if elapsed := time.Since(started); elapsed > 20*time.Second {
				t.Fatalf("discovery exceeded bound: %s", elapsed)
			}
		})
	}
}

// cancelAfterAttempts cancels once the fixture has recorded want attempts.
func cancelAfterAttempts(ctx context.Context, cancel context.CancelFunc, path string, want int) {
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if data, err := os.ReadFile(path); err == nil && strings.Count(string(data), "version\n") >= want {
			cancel()
			return
		}
	}
}

func TestDiscoveryKeepsPreferredCandidateAfterTimeout(t *testing.T) {
	for _, tc := range []struct{ name, version, rpc string }{
		{name: "version timeout", version: "/bin/sleep 30", rpc: "exit 2"},
		{name: "handshake timeout", version: "echo 1.5.2", rpc: "/bin/sleep 30"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			pathDir := filepath.Join(root, "path-bin")
			slow := filepath.Join(pathDir, "pi")
			writeFixtureScript(t, slow, fmt.Sprintf("#!/bin/sh\nif [ \"$1\" = \"--fixture-warmup\" ]; then exit 0; fi\nif [ \"$1\" = \"--version\" ]; then %s; exit; fi\n%s\n", tc.version, tc.rpc))
			warmVersionFixture(t, slow)
			bundled := filepath.Join(root, "bundled", "pi")
			writeFixtureScript(t, bundled, "#!/bin/sh\necho probed >> \"$HOME/bundled-probes\"\nexit 2\n")

			result, err := Discover(t.Context(), DiscoveryOptions{
				Runtimes:     []string{"pi"},
				BundledPaths: map[string]string{"pi": bundled},
				Environment:  map[string]string{"PATH": pathDir, "HOME": root},
				Timeout:      300 * time.Millisecond,
			})
			if err != nil {
				t.Fatal(err)
			}
			canonical, err := filepath.EvalSymlinks(slow)
			if err != nil {
				t.Fatal(err)
			}
			if d := result.Diagnostics[0]; d.Status != "error" || d.ExecutablePath != canonical {
				t.Fatalf("diagnostic = %+v, want the timed-out PATH candidate %s", d, canonical)
			}
			if _, err := os.Stat(filepath.Join(root, "bundled-probes")); !os.IsNotExist(err) {
				t.Fatalf("a timeout fell through to the bundled candidate (stat err=%v)", err)
			}
		})
	}
}

func TestDiscoveryCandidateWalkSharesOneDeadline(t *testing.T) {
	// Each candidate is a definitive handshake failure that spends a quarter
	// of a stage first. Unbounded, the walk would take candidates*delay.
	const candidates = 30
	const budget = time.Second
	root := t.TempDir()
	dirs := make([]string, candidates)
	for i := range dirs {
		dirs[i] = filepath.Join(root, fmt.Sprintf("bin-%02d", i))
		executable := filepath.Join(dirs[i], "pi")
		writeFixtureScript(t, executable, "#!/bin/sh\nif [ \"$1\" = \"--fixture-warmup\" ]; then exit 0; fi\nif [ \"$1\" = \"--version\" ]; then echo 1.5.2; exit 0; fi\necho probe >> \"$HOME/probes\"\n/bin/sleep 0.25\nexit 2\n")
		warmVersionFixture(t, executable)
	}
	started := time.Now()
	result, err := Discover(t.Context(), DiscoveryOptions{
		Runtimes:    []string{"pi"},
		Environment: map[string]string{"PATH": strings.Join(dirs, string(os.PathListSeparator)), "HOME": root},
		Timeout:     budget,
	})
	if err != nil {
		t.Fatal(err)
	}
	elapsed := time.Since(started)
	first, err := filepath.EvalSymlinks(filepath.Join(dirs[0], "pi"))
	if err != nil {
		t.Fatal(err)
	}
	if d := result.Diagnostics[0]; d.ExecutablePath != first || d.Error == nil {
		t.Fatalf("diagnostic = %+v, want the first candidate's failure", d)
	}
	probes, err := os.ReadFile(filepath.Join(root, "probes"))
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(string(probes), "probe\n"); got >= candidates {
		t.Fatalf("probed all %d candidates; the walk deadline did not stop it", got)
	}
	if limit := candidateWalkStages*budget + 3*time.Second; elapsed > limit {
		t.Fatalf("walk took %s, want under %s", elapsed, limit)
	}
}

func writeFixtureScript(t *testing.T, target, script string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
}

func warmVersionFixture(t *testing.T, executable string) {
	t.Helper()
	// macOS scans a newly written executable on first launch. Warm that scan
	// outside the lowered probe budget; the measured attempts still run real
	// sleeping children and enforce the production timeout/retry behavior.
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, executable, "--fixture-warmup").Run(); err != nil {
		t.Fatalf("warm version fixture: %v", err)
	}
}
