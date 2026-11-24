package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

func TestModelInvokerPi(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture launches the POSIX pnpm Pi shim")
	}
	const structuredReply, textReply = `{"answer":"local"}`, "Local model reply."
	pi, err := filepath.Abs("../../../node_modules/.bin/pi")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(pi); err != nil {
		t.Skip("install Computer's pinned Pi with pnpm install to run the local endpoint fixture")
	}
	root := t.TempDir()
	payloads := make(chan string, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var payload json.RawMessage
		if req.URL.Path != "/v1/chat/completions" || json.NewDecoder(req.Body).Decode(&payload) != nil {
			t.Error("unexpected Pi model request")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		select {
		case payloads <- string(payload):
		default:
			t.Error("unexpected additional local model request")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		reply := textReply
		if strings.Contains(string(payload), "matching this schema") {
			reply = structuredReply
		}
		if _, err := fmt.Fprintf(w, `data: {"id":"test","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":%q},"finish_reason":null}]}

data: {"id":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

`, reply); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("models.json", fmt.Sprintf(`{"providers":{"local-fixture":{"baseUrl":%q,"api":"openai-completions","apiKey":"fixture","models":[{"id":"fixture"},{"id":"fixture-alt"}]}}}`, server.URL+"/v1"))
	write("settings.json", `{"defaultProvider":"local-fixture","defaultModel":"fixture"}`)
	invoker := ModelInvoker{
		TempBase: root,
		Lookup: func(_ context.Context, runtime string) (ModelInvokeRuntime, bool, error) {
			return ModelInvokeRuntime{
				ExecutablePath: pi,
				Environment:    map[string]string{"HOME": root, "PI_CODING_AGENT_DIR": root, "PATH": os.Getenv("PATH")},
			}, runtime == "pi", nil
		},
	}
	for _, mode := range []string{ModelInvokeStructured, ModelInvokeText} {
		t.Run(mode, func(t *testing.T) {
			request := ModelInvokeRequest{RuntimeType: "pi", Mode: mode, ReasoningEffort: "low", Instructions: "Fixture instructions.", Input: "Fixture source.", Timeout: 15 * time.Second}
			want := textReply
			if mode == ModelInvokeStructured {
				want = structuredReply
				request.OutputSchema = json.RawMessage(`{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}`)
			}
			result := invoker.Invoke(t.Context(), request)
			if result.Outcome != ModelInvokeCompleted || result.Text != want || result.Model != "local-fixture/fixture" {
				t.Fatalf("Pi invocation = %+v", result)
			}
			payload := <-payloads
			if !strings.Contains(payload, "Fixture source.") || !strings.Contains(payload, "Fixture instructions.") ||
				strings.Contains(payload, `"tools":[{`) ||
				(mode == ModelInvokeStructured) != strings.Contains(payload, "matching this schema") {
				t.Fatalf("unexpected request: %s", payload)
			}
		})
	}
	t.Run("explicit model overrides Pi default", func(t *testing.T) {
		request := ModelInvokeRequest{
			RuntimeType: "pi", Model: "local-fixture/fixture-alt", Mode: ModelInvokeText,
			ReasoningEffort: "low", Instructions: "Fixture instructions.", Input: "Fixture source.", Timeout: 15 * time.Second,
		}
		result := invoker.Invoke(t.Context(), request)
		if result.Outcome != ModelInvokeCompleted || result.Text != textReply || result.Model != "local-fixture/fixture-alt" {
			t.Fatalf("Pi explicit model invocation = %+v", result)
		}
		payload := <-payloads
		if !strings.Contains(payload, `"model":"fixture-alt"`) {
			t.Fatalf("unexpected request payload for explicit model: %s", payload)
		}
	})
	t.Run("file tools are not enabled", func(t *testing.T) {
		result := invoker.Invoke(t.Context(), ModelInvokeRequest{RuntimeType: "pi", Mode: ModelInvokeWorkspace, Input: "Must not be sent.", Timeout: 15 * time.Second})
		if result.Outcome != ModelInvokeUnsupported || !strings.Contains(result.Reason, "file tools") {
			t.Fatalf("Pi invocation = %+v", result)
		}
		select {
		case <-payloads:
			t.Fatal("sent a prompt for a workspace call")
		default:
		}
	})
}

func TestClassifyPiModelInvokeFailureSanitizesAndDistinguishesCauses(t *testing.T) {
	tests := []struct {
		name        string
		err         error
		answerError string
		wantOutcome string
		wantReason  string
	}{
		{
			name:        "llama-server 65K context overflow",
			answerError: `POST http://127.0.0.1:18100/v1/chat/completions Bearer sk-secret: {"error":{"type":"exceed_context_size_error","message":"request (70000 tokens) exceeds the available context size (65536 tokens)"}}`,
			wantOutcome: ModelInvokeContextTooLong,
			wantReason:  "Model invocation prompt exceeds the model context window",
		},
		{
			name:        "local server POSIX ECONNREFUSED",
			answerError: "fetch failed: connect ECONNREFUSED 127.0.0.1:18100",
			wantOutcome: ModelInvokeRuntimeUnavailable,
			wantReason:  "Pi background model service is unavailable",
		},
		{
			name:        "structured JSON invalid_api_key",
			answerError: `POST https://secret.example/v1/chat/completions: {"error":{"code":"invalid_api_key","message":"bad key sk-secret"}}`,
			wantOutcome: ModelInvokeAuthRequired,
			wantReason:  "Pi background authentication is required",
		},
		{
			name:        "structured JSON model_not_loaded",
			answerError: `POST http://127.0.0.1:18100/v1/chat/completions: {"error":{"code":"model_not_loaded","message":"loading"}}`,
			wantOutcome: ModelInvokeRuntimeUnavailable,
			wantReason:  "Pi background model service is unavailable",
		},
		{
			name:        "typed unsupported effort sentinel",
			err:         fmt.Errorf("%w: %q", native.ErrPiUnsupportedEffort, "ultra"),
			wantOutcome: ModelInvokeFailed,
			wantReason:  "Pi background reasoning effort is unsupported",
		},
		{
			name:        "pi process launch failure",
			err:         errors.New("Pi could not be started: executable file not found"),
			wantOutcome: ModelInvokeRuntimeUnavailable,
			wantReason:  "Pi background runtime failed to start",
		},
		{
			name:        "generic per-request model failure stays sanitized",
			answerError: "400 Bad Request: schema mismatch on https://secret.example/v1",
			wantOutcome: ModelInvokeFailed,
			wantReason:  "Pi background call did not complete",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyPiModelInvokeFailure(tc.err, native.Outcome{Status: "failed", Error: tc.answerError})
			if got.Outcome != tc.wantOutcome || got.Reason != tc.wantReason {
				t.Fatalf("got = %+v; want outcome=%q reason=%q", got, tc.wantOutcome, tc.wantReason)
			}
			if strings.Contains(got.Reason, "127.0.0.1") || strings.Contains(got.Reason, "sk-secret") || strings.Contains(got.Reason, "secret.example") {
				t.Fatalf("reason leaked sensitive details: %q", got.Reason)
			}
		})
	}
}
