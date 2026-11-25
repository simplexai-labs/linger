package localmodels

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// A BYOK gateway that does not answer is mounted again from the saved
// configuration before a Runtime on it runs; one that answers, a Runtime on
// its own provider, and a source that is not BYOK cost no tool call.
func TestEnsureGatewayMountsTheSavedByokSourceOnlyWhenItsGatewayIsDown(t *testing.T) {
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer healthy.Close()
	stopped := httptest.NewServer(http.NotFoundHandler())
	stoppedURL := stopped.URL
	stopped.Close()

	ft := newFakeTool(t)
	piProfile := filepath.Join(ft.state, "byok-home", ".pi", "agent")
	ms := NewModelSource(ModelSourceOptions{
		Tool:         &ft.tool,
		Environment:  map[string]string{"LOCALMODELS_FAKE_TOOL": "1"},
		JobDirectory: filepath.Join(t.TempDir(), "jobs"),
		NodePath:     "/usr/local/bin/node",
	})
	source := func(mode, gatewayURL string) {
		writeModelSourceJSON(t, ft.state, map[string]any{
			"schema": modelSourceSchema, "mode": mode, "runtime": "pi",
			"runtime_model": "localmodels/localmodels-byok", "gateway_url": gatewayURL,
			"environment": map[string]string{"PI_CODING_AGENT_DIR": piProfile},
		})
	}
	argsFile := filepath.Join(ft.state, "source-args.txt")
	ran := func() string {
		raw, err := os.ReadFile(argsFile)
		if errors.Is(err, os.ErrNotExist) {
			return ""
		}
		if err != nil {
			t.Fatal(err)
		}
		_ = os.Remove(argsFile)
		return string(raw)
	}

	for _, tc := range []struct {
		name, mode, gatewayURL, runtime string
	}{
		{"gateway answers", "byok", healthy.URL, "pi"},
		{"runtime on its own provider", "byok", stoppedURL, "claude"},
		{"local source", "local", stoppedURL, "pi"},
		{"gateway off loopback", "byok", "http://192.0.2.1:18480", "pi"},
	} {
		source(tc.mode, tc.gatewayURL)
		if err := ms.EnsureGateway(t.Context(), tc.runtime); err != nil {
			t.Fatalf("%s: EnsureGateway error = %v", tc.name, err)
		}
		if args := ran(); args != "" {
			t.Fatalf("%s: ran localmodels %s, want no call", tc.name, args)
		}
	}

	source("byok", stoppedURL)
	ft.write("source-apply.json", map[string]any{
		"schema": modelSourceStatusSchema, "ok": false, "code": "BYOK_UNREACHABLE",
		"message": "Could not reach http://127.0.0.1:8090/v1/chat/completions (URLError).",
	})
	if err := os.WriteFile(filepath.Join(ft.state, "source-apply-exit"), []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}
	var sourceErr *ModelSourceError
	if err := ms.EnsureGateway(t.Context(), "pi"); !errors.As(err, &sourceErr) || sourceErr.Code != "BYOK_UNREACHABLE" || !sourceErr.Retryable {
		t.Fatalf("EnsureGateway error = %v, want retryable BYOK_UNREACHABLE", err)
	}
	args := ran()
	for _, want := range []string{"apply --mode byok", "--runtime pi", "--base-dir " + ft.tool.BaseDirectory} {
		if !strings.Contains(args, want) {
			t.Fatalf("remount argv = %q, want %q", args, want)
		}
	}
	if strings.Contains(args, "--config-stdin") {
		t.Fatalf("remount argv = %q, want the saved configuration", args)
	}

	// The endpoint is back: the next Run mounts the gateway, and the Runtime
	// paths the tool drops from model-source.json are kept.
	_ = os.Remove(filepath.Join(ft.state, "source-apply-exit"))
	// ReadOverlay keeps only host-absolute Runtime paths, so a POSIX literal
	// would be dropped on Windows.
	piPath := filepath.Join(t.TempDir(), "harness", "bin", "pi")
	ft.write("source-apply.json", map[string]any{
		"schema": modelSourceStatusSchema, "mode": "byok", "runtime": "pi",
		"runtime_model": "localmodels/localmodels-byok", "gateway_url": stoppedURL,
		"environment":   map[string]string{"PI_CODING_AGENT_DIR": piProfile},
		"runtime_paths": map[string]string{"pi": piPath},
		"byok":          map[string]any{"configured": true, "key_saved": false},
	})
	if err := ms.EnsureGateway(t.Context(), "pi"); err != nil {
		t.Fatalf("EnsureGateway error = %v", err)
	}
	if ran() == "" {
		t.Fatal("EnsureGateway did not mount the gateway again")
	}
	if overlay := ReadOverlay(ft.state); overlay == nil || overlay.RuntimePaths["pi"] != piPath {
		t.Fatalf("overlay = %+v, want the Runtime paths kept", overlay)
	}
}

// Runs that waited while a remount failed share its error rather than each
// probing the unreachable endpoint again.
func TestEnsureGatewaySharesARemountThatFailedWhileWaiting(t *testing.T) {
	stopped := httptest.NewServer(http.NotFoundHandler())
	stoppedURL := stopped.URL
	stopped.Close()
	ft := newFakeTool(t)
	writeModelSourceJSON(t, ft.state, map[string]any{
		"schema": modelSourceSchema, "mode": "byok", "runtime": "pi", "gateway_url": stoppedURL,
		"environment": map[string]string{"PI_CODING_AGENT_DIR": filepath.Join(ft.state, "byok-home", ".pi", "agent")},
	})
	ft.write("source-apply.json", map[string]any{
		"schema": modelSourceStatusSchema, "ok": false, "code": "BYOK_UNREACHABLE", "message": "Could not reach the endpoint.",
	})
	if err := os.WriteFile(filepath.Join(ft.state, "source-apply-exit"), []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}
	ms := NewModelSource(ModelSourceOptions{
		Tool: &ft.tool, Environment: map[string]string{"LOCALMODELS_FAKE_TOOL": "1"},
		JobDirectory: filepath.Join(t.TempDir(), "jobs"),
	})

	// An Apply holds the lock while three Runs arrive; it ends once all
	// three wait on it.
	waiting := make(chan struct{}, 4)
	ms.waiting = func() { waiting <- struct{}{} }
	ms.mu.Lock()
	var wg sync.WaitGroup
	errs := make([]error, 3)
	for i := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs[i] = ms.EnsureGateway(t.Context(), "pi")
		}()
	}
	for range errs {
		select {
		case <-waiting:
		case <-time.After(10 * time.Second):
			t.Fatal("the Runs did not wait for the lock")
		}
	}
	ms.mu.Unlock()
	wg.Wait()

	for i, err := range errs {
		var sourceErr *ModelSourceError
		if !errors.As(err, &sourceErr) || sourceErr.Code != "BYOK_UNREACHABLE" {
			t.Fatalf("Run %d error = %v, want BYOK_UNREACHABLE", i, err)
		}
	}
	calls, _ := os.ReadFile(filepath.Join(ft.state, "source-calls.log"))
	if n := strings.Count(string(calls), "apply --mode byok"); n != 1 {
		t.Fatalf("remounts = %d, want 1:\n%s", n, calls)
	}

	// A Run that arrives after the failure tries again.
	if err := ms.EnsureGateway(t.Context(), "pi"); err == nil {
		t.Fatal("EnsureGateway succeeded, want the endpoint still unreachable")
	}
	calls, _ = os.ReadFile(filepath.Join(ft.state, "source-calls.log"))
	if n := strings.Count(string(calls), "apply --mode byok"); n != 2 {
		t.Fatalf("remounts = %d, want 2", n)
	}
}

// Hitting the remount deadline maps to MODEL_SOURCE_TIMEOUT instead of generic
// TOOL_FAILED so logs and callers distinguish a slow gateway start from a tool crash.
func TestEnsureGatewayRemountTimeoutReturnsModelSourceTimeout(t *testing.T) {
	stopped := httptest.NewServer(http.NotFoundHandler())
	stoppedURL := stopped.URL
	stopped.Close()
	ft := newFakeTool(t)
	writeModelSourceJSON(t, ft.state, map[string]any{
		"schema": modelSourceSchema, "mode": "byok", "runtime": "pi", "gateway_url": stoppedURL,
		"environment": map[string]string{"PI_CODING_AGENT_DIR": filepath.Join(ft.state, "byok-home", ".pi", "agent")},
	})
	if err := os.WriteFile(filepath.Join(ft.state, "source-apply-wait"), []byte("5000"), 0o600); err != nil {
		t.Fatal(err)
	}
	ms := NewModelSource(ModelSourceOptions{
		Tool:         &ft.tool,
		Environment:  map[string]string{"LOCALMODELS_FAKE_TOOL": "1"},
		JobDirectory: filepath.Join(t.TempDir(), "jobs"),
		ApplyTimeout: 100 * time.Millisecond,
	})
	var sourceErr *ModelSourceError
	err := ms.EnsureGateway(t.Context(), "pi")
	if !errors.As(err, &sourceErr) || sourceErr.Code != "MODEL_SOURCE_TIMEOUT" || !sourceErr.Retryable {
		t.Fatalf("EnsureGateway error = %+v (%v), want retryable MODEL_SOURCE_TIMEOUT", sourceErr, err)
	}
}

// GatewayMode names the managed gateway only for a Runtime whose profile the
// saved local or BYOK source manages; a Runtime on its own provider, or a
// subscription source, reaches no gateway.
func TestGatewayModeNamesTheGatewayARuntimeReaches(t *testing.T) {
	ft := newFakeTool(t)
	ms := NewModelSource(ModelSourceOptions{
		Tool:         &ft.tool,
		Environment:  map[string]string{"LOCALMODELS_FAKE_TOOL": "1"},
		JobDirectory: filepath.Join(t.TempDir(), "jobs"),
		NodePath:     "/usr/local/bin/node",
	})
	if got := ms.GatewayMode("pi"); got != "" {
		t.Fatalf("mode without a saved source = %q, want empty", got)
	}
	for _, tc := range []struct {
		mode, home, runtime, want string
	}{
		{"byok", "byok-home", "pi", "byok"},
		{"local", "gateway-home", "pi", "local"},
		{"byok", "byok-home", "codex", ""},
		{"subscription", "byok-home", "pi", ""},
	} {
		t.Run(tc.mode+"/"+tc.runtime, func(t *testing.T) {
			writeModelSourceJSON(t, ft.state, map[string]any{
				"schema": modelSourceSchema, "mode": tc.mode, "runtime": "pi",
				"runtime_model": "localmodels/localmodels-byok", "gateway_url": "http://127.0.0.1:43120",
				"environment": map[string]string{"PI_CODING_AGENT_DIR": filepath.Join(ft.state, tc.home, ".pi", "agent")},
			})
			if got := ms.GatewayMode(tc.runtime); got != tc.want {
				t.Fatalf("mode = %q, want %q", got, tc.want)
			}
		})
	}
}
