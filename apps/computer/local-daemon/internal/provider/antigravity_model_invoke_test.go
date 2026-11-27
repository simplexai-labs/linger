package provider

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

func buildAntigravityFakeBinary(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "agy-fake")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	cmd := exec.CommandContext(t.Context(), "go", "test", "-c", "-o", bin, "./native")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("compile native test binary: %v\n%s", err, out)
	}
	return bin
}

func TestModelInvokerAntigravity(t *testing.T) {
	fakeBin := buildAntigravityFakeBinary(t)
	userHome := t.TempDir()
	userAppData := filepath.Join(userHome, ".gemini", "antigravity-cli")
	if err := os.MkdirAll(userAppData, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userAppData, "antigravity-oauth-token"), []byte("tok"), 0o600); err != nil {
		t.Fatal(err)
	}

	makeInvoker := func(mode string, extraEnv map[string]string) ModelInvoker {
		env := map[string]string{"HOME": userHome, "NATIVE_AGY_FAKE": mode}
		for k, v := range extraEnv {
			env[k] = v
		}
		return ModelInvoker{
			TempBase: t.TempDir(),
			Lookup: func(_ context.Context, runtimeType string) (ModelInvokeRuntime, bool, error) {
				return ModelInvokeRuntime{
					ExecutablePath: fakeBin,
					Environment:    env,
					Version:        "1.5.18",
				}, runtimeType == "antigravity", nil
			},
		}
	}

	t.Run("text", func(t *testing.T) {
		res := makeInvoker("model-invoke", nil).Invoke(t.Context(), ModelInvokeRequest{
			RuntimeType:     "antigravity",
			Mode:            ModelInvokeText,
			Model:           "gemini-flash",
			ReasoningEffort: "high",
			Instructions:    "Be concise.",
			Input:           "hello",
			Timeout:         15 * time.Second,
		})
		if res.Outcome != ModelInvokeCompleted || res.Text != "Antigravity answer: hello" || res.Model != "gemini-flash" || res.RuntimeVersion != "1.5.18" {
			t.Fatalf("text result = %+v", res)
		}
		if res.Usage == nil || res.Usage.InputTokens != 20 || res.Usage.CachedInputTokens != 5 || res.Usage.OutputTokens != 8 {
			t.Fatalf("usage = %+v", res.Usage)
		}
	})

	t.Run("structured_appends_schema", func(t *testing.T) {
		recordPath := filepath.Join(t.TempDir(), "reqs.jsonl")
		res := makeInvoker("model-invoke", map[string]string{"AGY_FAKE_RECORD": recordPath}).Invoke(t.Context(), ModelInvokeRequest{
			RuntimeType:     "antigravity",
			Mode:            ModelInvokeStructured,
			ReasoningEffort: "low",
			Instructions:    "Return JSON.",
			Input:           "json please",
			OutputSchema:    json.RawMessage(`{"type":"object","properties":{"ok":{"type":"boolean"}}}`),
			Timeout:         15 * time.Second,
		})
		if res.Outcome != ModelInvokeCompleted || res.Text != `{"ok":true}` || res.Model != "gemini-pro" {
			t.Fatalf("structured result = %+v", res)
		}
		raw, err := os.ReadFile(recordPath)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(raw), "Return only a JSON object matching this schema:") {
			t.Fatalf("expected schema appended to systemPrompt: %s", raw)
		}
	})

	t.Run("workspace_unsupported", func(t *testing.T) {
		res := makeInvoker("model-invoke", nil).Invoke(t.Context(), ModelInvokeRequest{
			RuntimeType:     "antigravity",
			Mode:            ModelInvokeWorkspace,
			ReasoningEffort: "low",
			Input:           "edit file",
			Timeout:         15 * time.Second,
		})
		if res.Outcome != ModelInvokeUnsupported || !strings.Contains(res.Reason, "file tools") {
			t.Fatalf("workspace result = %+v", res)
		}
	})

	t.Run("signed_out_auth_required", func(t *testing.T) {
		res := makeInvoker("signed-out", nil).Invoke(t.Context(), ModelInvokeRequest{
			RuntimeType:     "antigravity",
			Mode:            ModelInvokeText,
			ReasoningEffort: "low",
			Input:           "hello",
			Timeout:         15 * time.Second,
		})
		if res.Outcome != ModelInvokeAuthRequired {
			t.Fatalf("signed_out result = %+v", res)
		}
	})

	t.Run("unknown_model_incompatible", func(t *testing.T) {
		res := makeInvoker("model-invoke", nil).Invoke(t.Context(), ModelInvokeRequest{
			RuntimeType:     "antigravity",
			Mode:            ModelInvokeText,
			Model:           "unknown-model",
			ReasoningEffort: "low",
			Input:           "hello",
			Timeout:         15 * time.Second,
		})
		if res.Outcome != ModelInvokeRuntimeIncompatible {
			t.Fatalf("unknown_model result = %+v", res)
		}
	})

	t.Run("overflow_output_limited", func(t *testing.T) {
		res := makeInvoker("model-invoke-overflow", nil).Invoke(t.Context(), ModelInvokeRequest{
			RuntimeType:     "antigravity",
			Mode:            ModelInvokeText,
			ReasoningEffort: "low",
			Input:           "lots of text",
			Timeout:         15 * time.Second,
		})
		if res.Outcome != ModelInvokeOutputLimited {
			t.Fatalf("overflow result = %+v", res)
		}
	})

	t.Run("timeout", func(t *testing.T) {
		res := makeInvoker("model-invoke-hang", nil).Invoke(t.Context(), ModelInvokeRequest{
			RuntimeType:     "antigravity",
			Mode:            ModelInvokeText,
			ReasoningEffort: "low",
			Input:           "hang",
			Timeout:         200 * time.Millisecond,
		})
		if res.Outcome != ModelInvokeTimedOut {
			t.Fatalf("timeout result = %+v", res)
		}
	})

	// Verify zero pollution in user ~/.gemini/antigravity-cli after all calls.
	entries, err := os.ReadDir(userAppData)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "antigravity-oauth-token" {
		t.Fatalf("unexpected files in user antigravity dir: %v", entries)
	}
}

func TestClassifyAntigravityModelInvokeFailure(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		answer native.Outcome
		want   string
	}{
		{
			name: "start error",
			err:  errors.New("exec failed"),
			want: ModelInvokeRuntimeUnavailable,
		},
		{
			name:   "context too long failure code",
			answer: native.Outcome{Status: "failed", FailureCode: "context_too_long", ExitConfirmed: true},
			want:   ModelInvokeContextTooLong,
		},
		{
			name:   "structured context length exceeded",
			answer: native.Outcome{Status: "failed", Error: `{"error":{"code":"context_length_exceeded"}}`, ExitConfirmed: true},
			want:   ModelInvokeContextTooLong,
		},
		{
			name:   "structured model not found",
			answer: native.Outcome{Status: "failed", Error: `{"error":{"code":"model_not_found"}}`, ExitConfirmed: true},
			want:   ModelInvokeRuntimeIncompatible,
		},
		{
			name:   "structured auth error",
			answer: native.Outcome{Status: "failed", Error: `{"error":{"type":"authentication_error"}}`, ExitConfirmed: true},
			want:   ModelInvokeAuthRequired,
		},
		{
			name:   "network errno",
			answer: native.Outcome{Status: "failed", Error: "dial tcp: ECONNREFUSED", ExitConfirmed: true},
			want:   ModelInvokeRuntimeUnavailable,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyAntigravityModelInvokeFailure(tc.err, tc.answer)
			if got.Outcome != tc.want {
				t.Fatalf("got %+v, want %q", got, tc.want)
			}
		})
	}
}
