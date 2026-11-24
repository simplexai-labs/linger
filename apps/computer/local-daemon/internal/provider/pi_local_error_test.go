package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

// TestPiLocalGatewayCapacityAndContextErrors exercises the real pinned Pi
// runtime against a controlled local OpenAI-compatible gateway returning
// realistic llama.cpp / Bifrost context-limit and shared KV pool full errors.
func TestPiLocalGatewayCapacityAndContextErrors(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture launches the POSIX pnpm Pi shim")
	}
	pi, err := filepath.Abs("../../../node_modules/.bin/pi")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(pi); err != nil {
		t.Skip("install Computer's pinned Pi with pnpm install to run the local endpoint fixture")
	}

	cases := []struct {
		name               string
		statusCode         int
		contentType        string
		body               string
		maxRequests        int32
		wantFailureCode    string
		wantDiagnosticCode string
		wantHTTPStatus     int
		wantErrorSubstring string
		wantInvokeOutcome  string
	}{
		{
			name:               "llama-server numeric code 400 exceed_context_size_error",
			statusCode:         http.StatusBadRequest,
			contentType:        "application/json",
			body:               `{"error":{"code":400,"message":"request (70000 tokens) exceeds the available context size (65536 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":70000,"n_ctx":65536}}`,
			maxRequests:        2,
			wantFailureCode:    "context_too_long",
			wantDiagnosticCode: "exceed_context_size_error",
			wantHTTPStatus:     http.StatusBadRequest,
			wantErrorSubstring: "exceed_context_size_error",
			wantInvokeOutcome:  ModelInvokeContextTooLong,
		},
		{
			name:               "llama-server 503 shared KV pool full unavailable_error",
			statusCode:         http.StatusServiceUnavailable,
			contentType:        "application/json",
			body:               `{"error":{"code":503,"message":"shared KV pool full: no available slot for request","type":"unavailable_error"}}`,
			maxRequests:        3,
			wantFailureCode:    "model_service_error",
			wantDiagnosticCode: "unavailable_error",
			wantHTTPStatus:     http.StatusServiceUnavailable,
			wantErrorSubstring: "shared KV pool full",
			wantInvokeOutcome:  ModelInvokeRuntimeUnavailable,
		},
		{
			name:               "llama-server 500 shared KV pool full server_error",
			statusCode:         http.StatusInternalServerError,
			contentType:        "application/json",
			body:               `{"error":{"code":500,"message":"shared KV pool full: no available slot for request","type":"server_error"}}`,
			maxRequests:        3,
			wantFailureCode:    "model_service_error",
			wantDiagnosticCode: "server_error",
			wantHTTPStatus:     http.StatusInternalServerError,
			wantErrorSubstring: "shared KV pool full",
			wantInvokeOutcome:  ModelInvokeRuntimeUnavailable,
		},
		{
			// Upstream openai SDK throws APIError(undefined, data.error, ...) for
			// mid-stream HTTP 200 SSE error chunks, and @earendil-works/pi-ai's
			// formatProviderError drops norm.body when norm.status is undefined.
			// Because the Daemon never classifies raw error prose, mid-stream SSE
			// errors stay execution_failed / ModelInvokeFailed and settle boundedly.
			name:               "mid-stream HTTP 200 SSE error without structured payload stays execution_failed and settles boundedly",
			statusCode:         http.StatusOK,
			contentType:        "text/event-stream",
			body:               "data: {\"error\":{\"code\":500,\"type\":\"server_error\",\"message\":\"shared KV pool full during decode\"}}\n\n",
			maxRequests:        3,
			wantFailureCode:    "execution_failed",
			wantErrorSubstring: "shared KV pool full during decode",
			wantInvokeOutcome:  ModelInvokeFailed,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if req.URL.Path != "/v1/chat/completions" {
					w.WriteHeader(http.StatusNotFound)
					return
				}
				requests.Add(1)
				w.Header().Set("Content-Type", tc.contentType)
				w.WriteHeader(tc.statusCode)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()

			root := t.TempDir()
			agentDir := filepath.Join(root, "agent")
			sessionRoot := filepath.Join(root, "sessions")
			workDir := filepath.Join(root, "work")
			for _, dir := range []string{agentDir, sessionRoot, workDir} {
				if err := os.MkdirAll(dir, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			writeFile := func(path, content string) {
				t.Helper()
				if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			writeFile(filepath.Join(agentDir, "models.json"), fmt.Sprintf(
				`{"providers":{"local-fixture":{"baseUrl":%q,"api":"openai-completions","apiKey":"fixture","models":[{"id":"fixture","contextWindow":65536}]}}}`,
				server.URL+"/v1",
			))
			// Keep retry backoff short in tests while preserving bounded retry semantics.
			writeFile(filepath.Join(agentDir, "settings.json"),
				`{"defaultProvider":"local-fixture","defaultModel":"fixture","retry":{"enabled":true,"maxRetries":2,"baseDelayMs":10,"maxAgentDelayMs":20}}`,
			)

			t.Run("interactive_run", func(t *testing.T) {
				requests.Store(0)
				env := map[string]string{
					"HOME":                   root,
					"PI_CODING_AGENT_DIR":    agentDir,
					"LINGER_PI_SESSION_ROOT": sessionRoot,
					"PATH":                   os.Getenv("PATH"),
				}
				rt, err := native.Open("pi", native.Profile{Program: pi, Env: env})
				if err != nil {
					t.Fatal(err)
				}
				run, err := rt.Start(t.Context(), "Trigger local model capacity failure.", native.RunSpec{
					Dir:             workDir,
					Model:           "local-fixture/fixture",
					AssignSessionID: "kv-pool-session",
					Budget:          20 * time.Second,
				})
				if err != nil {
					t.Fatal(err)
				}
				for range run.Events {
				}
				outcome := <-run.Outcome
				if outcome.Status != "failed" {
					t.Fatalf("outcome.Status = %q, want failed (outcome=%+v)", outcome.Status, outcome)
				}
				if got := requests.Load(); got < 1 || got > tc.maxRequests {
					t.Fatalf("gateway request count = %d, want in [1, %d]", got, tc.maxRequests)
				}
				if !strings.Contains(outcome.Error, tc.wantErrorSubstring) {
					t.Fatalf("outcome.Error = %q, want substring %q", outcome.Error, tc.wantErrorSubstring)
				}
				if outcome.Diagnostics.Code != tc.wantDiagnosticCode {
					t.Fatalf("outcome.Diagnostics.Code = %q, want %q (error=%q, diagnostics=%+v)",
						outcome.Diagnostics.Code, tc.wantDiagnosticCode, outcome.Error, outcome.Diagnostics)
				}
				if tc.wantHTTPStatus != 0 {
					if outcome.Diagnostics.StatusCode == nil || *outcome.Diagnostics.StatusCode != tc.wantHTTPStatus {
						t.Fatalf("outcome.Diagnostics.StatusCode = %v, want %d (error=%q)",
							outcome.Diagnostics.StatusCode, tc.wantHTTPStatus, outcome.Error)
					}
				}
				classified := ClassifyExecutionFailure("pi", "1.2.0", outcome.Status, outcome.FailureCode, outcome.Diagnostics)
				if classified.Code != tc.wantFailureCode {
					t.Fatalf("classified.Code = %q, want %q (diagnostics=%+v, error=%q)",
						classified.Code, tc.wantFailureCode, outcome.Diagnostics, outcome.Error)
				}
			})

			t.Run("background_model_invoke", func(t *testing.T) {
				requests.Store(0)
				invoker := ModelInvoker{
					TempBase: root,
					Lookup: func(_ context.Context, runtimeName string) (ModelInvokeRuntime, bool, error) {
						return ModelInvokeRuntime{
							ExecutablePath: pi,
							Environment: map[string]string{
								"HOME":                root,
								"PI_CODING_AGENT_DIR": agentDir,
								"PATH":                os.Getenv("PATH"),
							},
						}, runtimeName == "pi", nil
					},
				}
				result := invoker.Invoke(t.Context(), ModelInvokeRequest{
					RuntimeType:     "pi",
					Mode:            ModelInvokeText,
					ReasoningEffort: "low",
					Input:           "Background prompt.",
					Timeout:         20 * time.Second,
				})
				if result.Outcome != tc.wantInvokeOutcome {
					t.Fatalf("result.Outcome = %q, want %q (reason=%q)", result.Outcome, tc.wantInvokeOutcome, result.Reason)
				}
				if got := requests.Load(); got < 1 || got > tc.maxRequests {
					t.Fatalf("background request count = %d, want in [1, %d]", got, tc.maxRequests)
				}
				if strings.Contains(result.Reason, server.URL) {
					t.Fatalf("background reason leaked local URL: %q", result.Reason)
				}
				if encoded, err := json.Marshal(result); err != nil || len(encoded) == 0 {
					t.Fatalf("marshal result failed: %v", err)
				}
			})
		})
	}
}
