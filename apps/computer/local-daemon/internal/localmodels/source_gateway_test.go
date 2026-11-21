package localmodels

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	ft.write("source-apply.json", map[string]any{
		"schema": modelSourceStatusSchema, "mode": "byok", "runtime": "pi",
		"runtime_model": "localmodels/localmodels-byok", "gateway_url": stoppedURL,
		"environment":   map[string]string{"PI_CODING_AGENT_DIR": piProfile},
		"runtime_paths": map[string]string{"pi": "/opt/harness/bin/pi"},
		"byok":          map[string]any{"configured": true, "key_saved": false},
	})
	if err := ms.EnsureGateway(t.Context(), "pi"); err != nil {
		t.Fatalf("EnsureGateway error = %v", err)
	}
	if ran() == "" {
		t.Fatal("EnsureGateway did not mount the gateway again")
	}
	if overlay := ReadOverlay(ft.state); overlay == nil || overlay.RuntimePaths["pi"] != "/opt/harness/bin/pi" {
		t.Fatalf("overlay = %+v, want the Runtime paths kept", overlay)
	}
}
