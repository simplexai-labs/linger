package localmodels

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

func runFakeSourceTool(state string, args []string) int {
	verb := args[0]
	stdinBytes, _ := io.ReadAll(os.Stdin)
	_ = os.WriteFile(filepath.Join(state, "source-args.txt"), []byte(strings.Join(args, " ")), 0o600)
	_ = os.WriteFile(filepath.Join(state, "source-stdin.json"), stdinBytes, 0o600)
	out, err := os.ReadFile(filepath.Join(state, "source-"+verb+".json"))
	if err != nil {
		return 1
	}
	_, _ = os.Stdout.Write(out)
	if codeBytes, err := os.ReadFile(filepath.Join(state, "source-"+verb+"-exit")); err == nil {
		if strings.TrimSpace(string(codeBytes)) == "2" {
			return 2
		}
	}
	return 0
}

func TestOverlayEnvironmentSwitchesCleanlyBetweenByokLocalAndSubscription(t *testing.T) {
	stateDir := t.TempDir()
	byokClaude := filepath.Join(stateDir, "byok-home", ".claude")
	byokCodex := filepath.Join(stateDir, "byok-home", ".codex")
	gatewayPi := filepath.Join(stateDir, "gateway-home", ".pi", "agent")
	if err := os.MkdirAll(gatewayPi, 0o700); err != nil {
		t.Fatal(err)
	}

	base := map[string]string{
		"HOME":                 "/Users/test",
		"CLAUDE_CONFIG_DIR":    filepath.Join(stateDir, "gateway-home", ".claude"),
		"PI_CODING_AGENT_DIR":  gatewayPi,
		"ANTHROPIC_BASE_URL":   "http://shell-gateway.example",
		"ANTHROPIC_AUTH_TOKEN": "shell-token",
	}

	// Without model-source.json, base environment is preserved unchanged.
	unchanged := OverlayEnvironment(base, stateDir)
	if unchanged["PI_CODING_AGENT_DIR"] != gatewayPi {
		t.Fatalf("expected initial gateway Pi profile preserved, got %v", unchanged)
	}

	// Switching to BYOK replaces gateway-home overrides with byok-home profiles.
	writeModelSourceJSON(t, stateDir, map[string]any{
		"schema":        modelSourceSchema,
		"mode":          "byok",
		"runtime":       "claude",
		"runtime_model": "localmodels-byok",
		"gateway_url":   "http://127.0.0.1:43120",
		"environment": map[string]string{
			"CLAUDE_CONFIG_DIR": byokClaude,
			"CODEX_HOME":        byokCodex,
		},
	})
	byokEnv := OverlayEnvironment(base, stateDir)
	if byokEnv["CLAUDE_CONFIG_DIR"] != byokClaude || byokEnv["CODEX_HOME"] != byokCodex {
		t.Fatalf("expected byok-home environment overrides, got %v", byokEnv)
	}
	if _, hasStalePi := byokEnv["PI_CODING_AGENT_DIR"]; hasStalePi {
		t.Fatalf("expected stale gateway-home PI_CODING_AGENT_DIR removed, got %v", byokEnv)
	}
	if _, inherited := byokEnv["ANTHROPIC_BASE_URL"]; inherited || byokEnv["ANTHROPIC_AUTH_TOKEN"] != "" {
		t.Fatalf("expected the shell's Claude endpoint dropped under the BYOK profile, got %v", byokEnv)
	}

	// Switching to Subscription strips both gateway-home and byok-home overrides
	// so native ~/.claude and ~/.codex credentials take effect without restart.
	baseWithByok := map[string]string{
		"HOME":               "/Users/test",
		"CLAUDE_CONFIG_DIR":  byokClaude,
		"CODEX_HOME":         byokCodex,
		"ANTHROPIC_BASE_URL": "http://shell-gateway.example",
	}
	writeModelSourceJSON(t, stateDir, map[string]any{
		"schema":        modelSourceSchema,
		"mode":          "subscription",
		"runtime":       "claude",
		"runtime_model": "",
		"gateway_url":   nil,
		"environment":   map[string]string{},
	})
	subEnv := OverlayEnvironment(baseWithByok, stateDir)
	if _, ok := subEnv["CLAUDE_CONFIG_DIR"]; ok {
		t.Fatalf("expected CLAUDE_CONFIG_DIR stripped in subscription mode, got %v", subEnv)
	}
	if _, ok := subEnv["CODEX_HOME"]; ok {
		t.Fatalf("expected CODEX_HOME stripped in subscription mode, got %v", subEnv)
	}
	if subEnv["ANTHROPIC_BASE_URL"] != "http://shell-gateway.example" {
		t.Fatalf("expected the user's own Claude endpoint kept for subscriptions, got %v", subEnv)
	}
}

func TestModelSourceStatusTestAndApplyKeepSecretsOnStdin(t *testing.T) {
	ft := newFakeTool(t)
	if err := os.WriteFile(filepath.Join(ft.state, "model-source.json"), []byte(`{"schema":"localmodels.model-source/v1","mode":"subscription","runtime":"claude","runtime_model":"","gateway_url":null,"environment":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	appliedCalls := 0
	ms := NewModelSource(ModelSourceOptions{
		Tool:         &ft.tool,
		Environment:  map[string]string{"LOCALMODELS_FAKE_TOOL": "1"},
		JobDirectory: filepath.Join(t.TempDir(), "jobs"),
		NodePath:     "/usr/local/bin/node",
		OnApplied: func(context.Context) map[string][]RuntimeModelOption {
			appliedCalls++
			return map[string][]RuntimeModelOption{"codex": {
				{ID: "gpt-5.5", IsDefault: true},
				{ID: "localmodels-byok", AllowedReasoningEffort: []string{"low", "high"}, DefaultReasoningEffort: "high"},
			}}
		},
	})

	_ = os.WriteFile(filepath.Join(ft.state, "source-check.json"), []byte(`{
		"schema": "localmodels.byok-check/v1",
		"ok": true,
		"protocol": "openai-responses",
		"url": "https://api.example.com/v1/responses",
		"model_id": "gpt-5.4",
		"context_window": 200000
	}`), 0o600)

	testRes, err := ms.TestByok(t.Context(), wire.ByokConfigInput{
		BaseURL:  "https://api.example.com",
		Path:     "/v1",
		Endpoint: "/responses",
		Protocol: "openai-responses",
		APIKey:   "sk-never-in-argv",
		ModelID:  "gpt-5.4",
	})
	if err != nil {
		t.Fatalf("TestByok error: %v", err)
	}
	if !testRes.Ok || testRes.ContextWindow != 200000 || testRes.ModelID != "gpt-5.4" ||
		testRes.URL != "https://api.example.com/v1/responses" {
		t.Fatalf("unexpected TestByok result: %+v", testRes)
	}
	recordedArgs, _ := os.ReadFile(filepath.Join(ft.state, "source-args.txt"))
	if strings.Contains(string(recordedArgs), "sk-never-in-argv") || strings.Contains(string(recordedArgs), "--runtime") {
		t.Fatalf("check argv = %s, want neither a Runtime nor the API key", string(recordedArgs))
	}
	recordedStdin, _ := os.ReadFile(filepath.Join(ft.state, "source-stdin.json"))
	for _, want := range []string{`"apiKey":"sk-never-in-argv"`, `"path":"/v1"`, `"endpoint":"/responses"`, `"protocol":"openai-responses"`} {
		if !strings.Contains(string(recordedStdin), want) {
			t.Fatalf("stdin JSON %s lacks %s", recordedStdin, want)
		}
	}

	_ = os.WriteFile(filepath.Join(ft.state, "source-apply.json"), []byte(`{
		"schema": "localmodels.model-source-status/v1",
		"mode": "byok",
		"runtime": "codex",
		"runtime_model": "localmodels-byok",
		"gateway_url": "http://127.0.0.1:43120",
		"environment": {"CODEX_HOME": "/tmp/byok/.codex"},
		"runtime_paths": {"codex": "/tmp/codex"},
		"byok": {
			"configured": true,
			"protocol": "openai-responses",
			"base_url": "https://api.example.com",
			"path": "/v1",
			"endpoint": "/responses",
			"model_id": "gpt-5.4",
			"context_window": 200000,
			"key_saved": true
		}
	}`), 0o600)

	status, err := ms.Apply(t.Context(), ModelSourceApply{
		Mode:    "byok",
		Runtime: "codex",
		Byok: &wire.ByokConfigInput{
			BaseURL:  "https://api.example.com",
			Path:     "/v1",
			Endpoint: "/responses",
			Protocol: "openai-responses",
			APIKey:   "sk-never-in-argv",
			ModelID:  "gpt-5.4",
		},
	})
	if err != nil {
		t.Fatalf("Apply error: %v", err)
	}
	if status.Mode != "byok" || status.Runtime != "codex" || status.RuntimeModel != "localmodels-byok" ||
		status.ReasoningEffort != "high" || !status.Byok.KeySaved ||
		status.Byok.Path != "/v1" || status.Byok.Endpoint != "/responses" {
		t.Fatalf("unexpected Apply status: %+v", status)
	}
	if appliedCalls != 1 {
		t.Fatalf("expected OnApplied called synchronously once, got %d", appliedCalls)
	}

	// Verify structured error propagation on failure.
	_ = os.WriteFile(filepath.Join(ft.state, "source-check.json"), []byte(`{
		"schema": "localmodels.byok-check/v1",
		"ok": false,
		"code": "BYOK_UPSTREAM_REJECTED",
		"message": "Upstream endpoint returned HTTP 401."
	}`), 0o600)
	_ = os.WriteFile(filepath.Join(ft.state, "source-check-exit"), []byte("2"), 0o600)
	_, err = ms.TestByok(t.Context(), wire.ByokConfigInput{
		BaseURL:  "https://api.example.com",
		Path:     "/v1",
		Endpoint: "/chat/completions",
		Protocol: "openai-chat",
		ModelID:  "gpt-5.4",
	})
	var sourceErr *ModelSourceError
	if !errors.As(err, &sourceErr) || sourceErr.Code != "BYOK_UPSTREAM_REJECTED" {
		t.Fatalf("expected BYOK_UPSTREAM_REJECTED error, got %v", err)
	}

	_ = os.WriteFile(filepath.Join(ft.state, "source-models.json"), []byte(`{
		"schema": "localmodels.byok-models/v1",
		"ok": true,
		"url": "https://gw.example.com/full/models",
		"models": [{"id": "alpha", "name": null, "context_window": null}, {"id": "zeta", "name": "Zeta", "context_window": 200000}]
	}`), 0o600)
	list, err := ms.ListByokModels(t.Context(), wire.ByokConfigInput{
		BaseURL: "https://gw.example.com/full", Protocol: "anthropic", APIKey: "sk-list",
	})
	if err != nil || list.URL != "https://gw.example.com/full/models" || len(list.Models) != 2 ||
		list.Models[1].Name != "Zeta" || list.Models[1].ContextWindow == nil || *list.Models[1].ContextWindow != 200000 {
		t.Fatalf("ListByokModels = %+v, %v", list, err)
	}
	recordedArgs, _ = os.ReadFile(filepath.Join(ft.state, "source-args.txt"))
	if !strings.HasPrefix(string(recordedArgs), "models --config-stdin") || strings.Contains(string(recordedArgs), "sk-list") {
		t.Fatalf("models argv = %s", recordedArgs)
	}
	// An empty path or endpoint appends nothing, which localmodels tells apart
	// from a missing field, so both are sent.
	recordedStdin, _ = os.ReadFile(filepath.Join(ft.state, "source-stdin.json"))
	if !strings.Contains(string(recordedStdin), `"path":""`) || !strings.Contains(string(recordedStdin), `"endpoint":""`) {
		t.Fatalf("models stdin JSON %s lacks the empty path and endpoint", recordedStdin)
	}
}

func writeModelSourceJSON(t *testing.T, stateDir string, payload map[string]any) {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "model-source.json"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestAgentRuntimeModelPrefersTargetThenCatalogDefault(t *testing.T) {
	catalog := []RuntimeModelOption{
		{ID: "opus", AllowedReasoningEffort: []string{"low", "max"}},
		{ID: "spark", AllowedReasoningEffort: []string{"none", "low", "high"}},
		{ID: "qwen", AllowedReasoningEffort: []string{"none", "low", "medium", "high"}},
		{ID: "default", IsDefault: true, AllowedReasoningEffort: []string{"medium"}, DefaultReasoningEffort: "medium"},
		{ID: "localmodels-byok"},
	}
	for _, test := range []struct {
		name, runtime, target string
		catalog               []RuntimeModelOption
		model, effort         string
	}{
		{name: "target offered", runtime: "claude", target: "localmodels-byok", catalog: catalog, model: "localmodels-byok"},
		{name: "target missing", runtime: "claude", target: "gone", catalog: catalog, model: "default", effort: "medium"},
		{name: "no target", runtime: "claude", catalog: catalog, model: "default", effort: "medium"},
		{name: "first allowed effort", runtime: "claude", target: "opus", catalog: catalog, model: "opus", effort: "low"},
		{name: "local model skips none when medium absent", runtime: "pi", target: "spark", catalog: catalog, model: "spark", effort: "low"},
		{name: "local model prefers medium over none", runtime: "pi", target: "qwen", catalog: catalog, model: "qwen", effort: "medium"},
		{name: "no default", runtime: "codex", catalog: catalog[4:], model: "localmodels-byok"},
		{name: "no catalog keeps target", runtime: "pi", target: "localmodels/qwen", model: "localmodels/qwen"},
		{name: "no catalog no target", runtime: "codex", model: "codex-default"},
	} {
		t.Run(test.name, func(t *testing.T) {
			model, effort := agentRuntimeModel(test.runtime, test.target, test.catalog)
			if model != test.model || effort != test.effort {
				t.Fatalf("agentRuntimeModel = %q, %q; want %q, %q", model, effort, test.model, test.effort)
			}
		})
	}
}

func TestModelSourceReportsUnsupportedWhenToolLacksSourceCommand(t *testing.T) {
	ft := newFakeTool(t)
	for _, verb := range []string{"status", "apply", "check", "models"} {
		if err := os.WriteFile(filepath.Join(ft.state, "source-"+verb+".json"), nil, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(ft.state, "source-"+verb+"-exit"), []byte("2"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	ms := NewModelSource(ModelSourceOptions{Tool: &ft.tool})

	assertUnsupported := func(name string, err error) {
		t.Helper()
		var sourceErr *ModelSourceError
		if !errors.As(err, &sourceErr) {
			t.Fatalf("%s: expected *ModelSourceError, got %v", name, err)
		}
		if sourceErr.Code != CodeModelSourceUnsupported || sourceErr.Retryable {
			t.Fatalf("%s: got %+v, want non-retryable %s", name, sourceErr, CodeModelSourceUnsupported)
		}
	}

	_, err := ms.Status(t.Context())
	assertUnsupported("Status", err)

	_, err = ms.Apply(t.Context(), ModelSourceApply{Mode: "subscription", Runtime: "claude"})
	assertUnsupported("Apply", err)

	_, err = ms.TestByok(t.Context(), wire.ByokConfigInput{
		BaseURL: "https://api.example.com", Path: "/v1", Endpoint: "/messages", Protocol: "anthropic",
		APIKey: "sk-unused", ModelID: "gpt-5.4",
	})
	assertUnsupported("TestByok", err)

	_, err = ms.ListByokModels(t.Context(), wire.ByokConfigInput{
		BaseURL: "https://api.example.com", Path: "/v1", Protocol: "openai-chat", APIKey: "sk-unused",
	})
	assertUnsupported("ListByokModels", err)
}
