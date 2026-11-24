package localmodels

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

func runFakeSourceTool(state string, args []string) int {
	verb := args[0]
	stdinBytes, _ := io.ReadAll(os.Stdin)
	_ = os.WriteFile(filepath.Join(state, "source-args.txt"), []byte(strings.Join(args, " ")), 0o600)
	if calls, err := os.OpenFile(filepath.Join(state, "source-calls.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
		_, _ = calls.WriteString(strings.Join(args, " ") + "\n")
		_ = calls.Close()
	}
	_ = os.WriteFile(filepath.Join(state, "source-stdin.json"), stdinBytes, 0o600)
	if piDir, ok := os.LookupEnv("PI_CODING_AGENT_DIR"); ok {
		_ = os.WriteFile(filepath.Join(state, "source-pi-dir.txt"), []byte("SET:"+piDir), 0o600)
	} else {
		_ = os.WriteFile(filepath.Join(state, "source-pi-dir.txt"), []byte("UNSET"), 0o600)
	}
	if waitBytes, err := os.ReadFile(filepath.Join(state, "source-"+verb+"-wait")); err == nil {
		if ms, parseErr := strconv.Atoi(strings.TrimSpace(string(waitBytes))); parseErr == nil && ms > 0 {
			time.Sleep(time.Duration(ms) * time.Millisecond)
		}
	}
	if delayBytes, err := os.ReadFile(filepath.Join(state, "source-"+verb+"-sleep")); err == nil {
		if d, parseErr := time.ParseDuration(strings.TrimSpace(string(delayBytes))); parseErr == nil {
			time.Sleep(d)
		}
	}
	if msBytes, err := os.ReadFile(filepath.Join(state, "source-"+verb+"-model-source.json")); err == nil {
		_ = os.WriteFile(filepath.Join(state, "model-source.json"), msBytes, 0o600)
	}
	out, err := os.ReadFile(filepath.Join(state, "source-"+verb+".json"))
	if err != nil {
		return 1
	}
	_, _ = os.Stdout.Write(out)
	if codeBytes, err := os.ReadFile(filepath.Join(state, "source-"+verb+"-exit")); err == nil {
		if code, parseErr := strconv.Atoi(strings.TrimSpace(string(codeBytes))); parseErr == nil {
			return code
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
		{ID: "default", IsDefault: true, AllowedReasoningEffort: []string{"medium"}, DefaultReasoningEffort: "medium"},
		{ID: "localmodels-byok"},
	}
	localCatalog := []RuntimeModelOption{
		{ID: "anthropic/claude-fable-5", IsDefault: true},
		{ID: "localmodels/localmodels-byok", IsDefault: true},
		{ID: "localmodels-library/localmodels-lib-qwen3-8-27b/Qwen3.8-27B-UD-Q4_K_M"},
	}
	for _, test := range []struct {
		name, mode, runtime, target string
		catalog                     []RuntimeModelOption
		model, effort               string
	}{
		{name: "target offered", mode: "byok", runtime: "claude", target: "localmodels-byok", catalog: catalog, model: "localmodels-byok"},
		{name: "target missing", mode: "byok", runtime: "claude", target: "gone", catalog: catalog, model: "default", effort: "medium"},
		{name: "no target", mode: "byok", runtime: "claude", catalog: catalog, model: "default", effort: "medium"},
		{name: "first allowed effort", mode: "byok", runtime: "claude", target: "opus", catalog: catalog, model: "opus", effort: "low"},
		{name: "no default", mode: "byok", runtime: "codex", catalog: catalog[2:], model: "localmodels-byok"},
		{name: "no catalog keeps target", mode: "local", runtime: "pi", target: "localmodels/qwen", model: "localmodels/qwen"},
		{name: "no catalog no target", mode: "subscription", runtime: "codex", model: "codex-default"},
		{name: "local mode rejects stale byok target and picks local model", mode: "local", runtime: "pi", target: "localmodels/localmodels-byok", catalog: localCatalog, model: "localmodels-library/localmodels-lib-qwen3-8-27b/Qwen3.8-27B-UD-Q4_K_M"},
		{name: "local mode prefers local model over cloud default", mode: "local", runtime: "pi", target: "", catalog: localCatalog, model: "localmodels-library/localmodels-lib-qwen3-8-27b/Qwen3.8-27B-UD-Q4_K_M"},
		{name: "local mode never falls back to cloud model when no local candidate exists", mode: "local", runtime: "pi", target: "", catalog: []RuntimeModelOption{{ID: "anthropic/claude-fable-5", IsDefault: true}}, model: ""},
		{name: "local mode returns empty instead of pi-default when catalog and target are empty", mode: "local", runtime: "pi", target: "", catalog: nil, model: ""},
		{name: "local mode keeps non-byok local target when catalog only has cloud models", mode: "local", runtime: "pi", target: "localmodels/qwen", catalog: []RuntimeModelOption{{ID: "anthropic/claude-fable-5", IsDefault: true}}, model: "localmodels/qwen"},
		{name: "local mode drops non-local cloud target when catalog has no local model", mode: "local", runtime: "pi", target: "anthropic/claude-fable-5", catalog: []RuntimeModelOption{{ID: "anthropic/claude-fable-5", IsDefault: true}}, model: ""},
		{name: "subscription mode ignores stale byok entry", mode: "subscription", runtime: "claude", target: "localmodels-byok", catalog: catalog, model: "default", effort: "medium"},
	} {
		t.Run(test.name, func(t *testing.T) {
			model, effort := agentRuntimeModel(test.mode, test.runtime, test.target, test.catalog)
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

func TestGatewayRuntimeFollowsTheManagedProfile(t *testing.T) {
	root := t.TempDir()
	state := filepath.Join(root, "runtime", "localmodels", "state")
	byok := map[string]string{
		"CODEX_HOME":          filepath.Join(state, "byok-home", ".codex"),
		"CLAUDE_CONFIG_DIR":   "/home/user/.claude",
		"PI_CODING_AGENT_DIR": filepath.Join(state, "gateway-home", ".pi", "agent"),
	}
	for runtimeType, want := range map[string]bool{"codex": true, "claude": false, "pi": true, "antigravity": false} {
		if got := GatewayRuntime(byok, state, runtimeType); got != want {
			t.Fatalf("GatewayRuntime(%s) = %v", runtimeType, got)
		}
	}
	toolsPi := map[string]string{
		"PI_CODING_AGENT_DIR": filepath.Join(ToolsDirectory(state), "gateway-home", ".pi", "agent"),
	}
	if !GatewayRuntime(toolsPi, state, "pi") {
		t.Fatalf("GatewayRuntime did not recognize per-home tools/gateway-home: %v", toolsPi)
	}
	legacyPi := map[string]string{
		"PI_CODING_AGENT_DIR": filepath.Join(root, "user-home", ".local", "share", "localmodels", "tools", "gateway-home", ".pi", "agent"),
	}
	if !GatewayRuntime(legacyPi, state, "pi") {
		t.Fatalf("GatewayRuntime did not recognize legacy localmodels/tools/gateway-home: %v", legacyPi)
	}
	if GatewayRuntime(byok, "", "codex") {
		t.Fatal("a Computer without localmodels has no gateway Runtime")
	}
}

func TestOverlayEnvironmentDiscoversToolsGatewayHomeAndIsolatesByokInLocalMode(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "runtime", "localmodels", "state")
	toolsGatewayPi := filepath.Join(ToolsDirectory(stateDir), "gateway-home", ".pi", "agent")
	byokPi := filepath.Join(stateDir, "byok-home", ".pi", "agent")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}

	// Without model-source.json, base environment is preserved unchanged even
	// after ToolsDirectory(stateDir)/gateway-home/.pi/agent exists, so users
	// with a personal ~/.pi/agent profile are not switched off it until they
	// select local mode; a stale byok-home entry is still stripped to match
	// Tool.commandArgs.
	base := map[string]string{"HOME": filepath.Join(root, "home")}
	if got := OverlayEnvironment(base, stateDir); got["PI_CODING_AGENT_DIR"] != "" {
		t.Fatalf("expected no PI_CODING_AGENT_DIR before gateway-home exists, got %v", got)
	}
	if got := OverlayEnvironment(map[string]string{
		"HOME":                filepath.Join(root, "home"),
		"PI_CODING_AGENT_DIR": byokPi,
	}, stateDir); got["PI_CODING_AGENT_DIR"] != "" {
		t.Fatalf("expected stale byok-home stripped without model-source.json, got %v", got)
	}
	if err := os.MkdirAll(toolsGatewayPi, 0o700); err != nil {
		t.Fatal(err)
	}
	if got := OverlayEnvironment(base, stateDir); got["PI_CODING_AGENT_DIR"] != "" {
		t.Fatalf("expected personal Pi profile preserved when model-source.json is absent, got %v", got)
	}

	// In local mode with empty overlay environment, OverlayEnvironment resolves
	// ToolsDirectory(stateDir)/gateway-home/.pi/agent.
	writeModelSourceJSON(t, stateDir, map[string]any{
		"schema":      modelSourceSchema,
		"mode":        "local",
		"runtime":     "pi",
		"environment": map[string]string{},
	})
	if got := OverlayEnvironment(base, stateDir); got["PI_CODING_AGENT_DIR"] != toolsGatewayPi {
		t.Fatalf("expected tools gateway-home %q in local mode, got %v", toolsGatewayPi, got)
	}

	// Switching to subscription strips ToolsDirectory(stateDir)/gateway-home.
	writeModelSourceJSON(t, stateDir, map[string]any{
		"schema":      modelSourceSchema,
		"mode":        "subscription",
		"runtime":     "claude",
		"environment": map[string]string{},
	})
	if got := OverlayEnvironment(map[string]string{
		"HOME":                filepath.Join(root, "home"),
		"PI_CODING_AGENT_DIR": toolsGatewayPi,
	}, stateDir); got["PI_CODING_AGENT_DIR"] != "" {
		t.Fatalf("expected tools gateway-home stripped in subscription mode, got %v", got)
	}

	// Local mode rejects a stale byok-home Pi path in model-source.json and
	// resolves ToolsDirectory(stateDir)/gateway-home/.pi/agent instead.
	writeModelSourceJSON(t, stateDir, map[string]any{
		"schema":      modelSourceSchema,
		"mode":        "local",
		"runtime":     "pi",
		"environment": map[string]string{"PI_CODING_AGENT_DIR": byokPi},
	})
	if got := OverlayEnvironment(map[string]string{
		"HOME":                filepath.Join(root, "home"),
		"PI_CODING_AGENT_DIR": byokPi,
	}, stateDir); got["PI_CODING_AGENT_DIR"] != toolsGatewayPi {
		t.Fatalf("expected local mode to replace stale byok-home with %q, got %v", toolsGatewayPi, got)
	}

	// Even before gateway-home exists, local mode never keeps a stale byok-home Pi dir.
	if err := os.RemoveAll(filepath.Join(ToolsDirectory(stateDir), "gateway-home")); err != nil {
		t.Fatal(err)
	}
	if got := OverlayEnvironment(map[string]string{
		"HOME":                filepath.Join(root, "home"),
		"PI_CODING_AGENT_DIR": byokPi,
	}, stateDir); got["PI_CODING_AGENT_DIR"] != "" {
		t.Fatalf("expected stale byok-home dropped in local mode when no gateway-home exists, got %v", got)
	}
}

func TestModelSourceApplyPropagatesByokGatewayFailedRedactsKeyAndMapsTimeout(t *testing.T) {
	ft := newFakeTool(t)
	ms := NewModelSource(ModelSourceOptions{
		Tool:         &ft.tool,
		Environment:  map[string]string{"LOCALMODELS_FAKE_TOOL": "1"},
		JobDirectory: filepath.Join(t.TempDir(), "jobs"),
		ApplyTimeout: 5 * time.Second,
	})

	const gatewayMsg = "cannot record Bifrost process identity ([Errno 1] Operation not permitted: '/bin/ps'); stopped it"
	if err := os.WriteFile(filepath.Join(ft.state, "source-apply.json"), []byte(`{
		"schema": "localmodels.model-source-status/v1",
		"ok": false,
		"code": "BYOK_GATEWAY_FAILED",
		"message": "`+gatewayMsg+`"
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ft.state, "source-apply-exit"), []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := ms.Apply(t.Context(), ModelSourceApply{
		Mode:    "byok",
		Runtime: "pi",
		Byok: &wire.ByokConfigInput{
			BaseURL:  "https://api.kimi.com/coding",
			Path:     "/v1",
			Endpoint: "/chat/completions",
			Protocol: "openai-chat",
			APIKey:   "sk-secret-key-must-never-leak",
			ModelID:  "k3",
		},
	})
	var sourceErr *ModelSourceError
	if !errors.As(err, &sourceErr) || sourceErr.Code != "BYOK_GATEWAY_FAILED" || sourceErr.Message != gatewayMsg {
		t.Fatalf("BYOK_GATEWAY_FAILED apply = %+v (%v)", sourceErr, err)
	}

	// Defense in depth: an API key echoed in a tool error message is scrubbed
	// before leaving the Computer.
	if err := os.WriteFile(filepath.Join(ft.state, "source-apply.json"), []byte(`{
		"schema": "localmodels.model-source-status/v1",
		"ok": false,
		"code": "BYOK_GATEWAY_FAILED",
		"message": "failed using sk-secret-key-must-never-leak on gateway"
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = ms.Apply(t.Context(), ModelSourceApply{
		Mode:    "byok",
		Runtime: "pi",
		Byok: &wire.ByokConfigInput{
			BaseURL:  "https://api.kimi.com/coding",
			Path:     "/v1",
			Endpoint: "/chat/completions",
			Protocol: "openai-chat",
			APIKey:   "sk-secret-key-must-never-leak",
			ModelID:  "k3",
		},
	})
	if !errors.As(err, &sourceErr) || strings.Contains(sourceErr.Message, "sk-secret-key-must-never-leak") {
		t.Fatalf("API key leaked into ModelSourceError.Message: %+v", sourceErr)
	}

	// Hitting Apply's timeout maps to MODEL_SOURCE_TIMEOUT (not TOOL_FAILED).
	if err := os.WriteFile(filepath.Join(ft.state, "source-apply-wait"), []byte("5000"), 0o600); err != nil {
		t.Fatal(err)
	}
	fastTimeout := NewModelSource(ModelSourceOptions{
		Tool:         &ft.tool,
		Environment:  map[string]string{"LOCALMODELS_FAKE_TOOL": "1"},
		JobDirectory: filepath.Join(t.TempDir(), "jobs"),
		ApplyTimeout: 100 * time.Millisecond,
	})
	_, err = fastTimeout.Apply(t.Context(), ModelSourceApply{Mode: "byok", Runtime: "pi"})
	if !errors.As(err, &sourceErr) || sourceErr.Code != "MODEL_SOURCE_TIMEOUT" || !sourceErr.Retryable {
		t.Fatalf("timed-out apply = %+v (%v), want retryable MODEL_SOURCE_TIMEOUT", sourceErr, err)
	}
}

func TestModelSourceApplyRotatesUnownedBifrostAddrOnGatewayFailure(t *testing.T) {
	for _, tc := range []struct {
		mode    string
		code    string
		rotates bool
	}{
		{mode: "local", code: "GATEWAY_REGISTRATION_FAILED", rotates: true},
		{mode: "byok", code: "BYOK_GATEWAY_FAILED", rotates: true},
		{mode: "local", code: "MODEL_UNKNOWN"},
	} {
		t.Run(tc.code, func(t *testing.T) {
			fake := newFakeTool(t)
			addr := seedFreeBifrostAddr(t, fake.state)
			fake.write("source-apply.json", map[string]any{
				"schema": "localmodels.model-source-status/v1",
				"ok":     false,
				"code":   tc.code,
			})
			fake.write("source-apply-exit", 1)
			source := NewModelSource(ModelSourceOptions{
				Tool:         &fake.tool,
				Environment:  map[string]string{"LOCALMODELS_FAKE_TOOL": "1"},
				JobDirectory: filepath.Join(t.TempDir(), "jobs"),
			})
			_, err := source.Apply(t.Context(), ModelSourceApply{Mode: tc.mode, Runtime: "pi"})
			var sourceErr *ModelSourceError
			if !errors.As(err, &sourceErr) || sourceErr.Code != tc.code {
				t.Fatalf("Apply error = %v, want %s", err, tc.code)
			}
			assertBifrostAddrRotation(t, fake.state, addr, tc.rotates)
		})
	}
}

func TestModelSourceParsesJsonlProgressAndClassifiesTimeouts(t *testing.T) {
	ft := newFakeTool(t)
	writeModelSourceJSON(t, ft.state, map[string]any{
		"schema":        modelSourceSchema,
		"mode":          "byok",
		"runtime":       "pi",
		"runtime_model": "localmodels/localmodels-byok",
		"gateway_url":   "http://127.0.0.1:18480",
		"environment":   map[string]string{},
	})

	// 1. Progress JSONL lines preceding the final status JSON succeed instead of TOOL_FAILED.
	jsonlSuccess := strings.Join([]string{
		`{"kind":"stage","stage":"download","state":"connecting"}`,
		`{"kind":"progress","unit":"bytes","completed":1024,"total":2048}`,
		`{"schema":"localmodels.model-source-status/v1","mode":"local","runtime":"pi","runtime_model":"localmodels-library/qwen3.8","gateway_url":"http://127.0.0.1:18480","environment":{},"byok":{"configured":false,"key_saved":false}}`,
	}, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(ft.state, "source-apply.json"), []byte(jsonlSuccess), 0o600); err != nil {
		t.Fatal(err)
	}
	var refreshCtxErr error
	ms := NewModelSource(ModelSourceOptions{
		Tool:          &ft.tool,
		Environment:   map[string]string{"LOCALMODELS_FAKE_TOOL": "1"},
		JobDirectory:  filepath.Join(t.TempDir(), "jobs"),
		StatusTimeout: 5 * time.Second,
		ApplyTimeout:  5 * time.Second,
		TestTimeout:   80 * time.Millisecond,
		OnApplied: func(ctx context.Context) map[string][]RuntimeModelOption {
			refreshCtxErr = ctx.Err()
			return map[string][]RuntimeModelOption{
				"pi": {
					{ID: "localmodels/localmodels-byok", IsDefault: true},
					{ID: "localmodels-library/qwen3.8"},
				},
			}
		},
	})
	status, err := ms.Apply(t.Context(), ModelSourceApply{Mode: "local", Runtime: "pi"})
	if err != nil {
		t.Fatalf("Apply with JSONL progress failed: %v", err)
	}
	if refreshCtxErr != nil {
		t.Fatalf("OnApplied received canceled context: %v", refreshCtxErr)
	}
	if status.Mode != "local" || status.RuntimeModel != "localmodels-library/qwen3.8" {
		t.Fatalf("unexpected Apply status after JSONL progress: %+v", status)
	}

	// 2. Structured error JSON after JSONL progress preserves the structured code/message.
	jsonlFailure := strings.Join([]string{
		`{"kind":"stage","stage":"download","state":"connecting"}`,
		`{"code":"BYOK_UNREACHABLE","message":"Upstream gateway refused connection."}`,
	}, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(ft.state, "source-apply.json"), []byte(jsonlFailure), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ft.state, "source-apply-exit"), []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = ms.Apply(t.Context(), ModelSourceApply{Mode: "local", Runtime: "pi"})
	var sourceErr *ModelSourceError
	if !errors.As(err, &sourceErr) || sourceErr.Code != "BYOK_UNREACHABLE" || !strings.Contains(sourceErr.Message, "refused connection") {
		t.Fatalf("expected BYOK_UNREACHABLE from JSONL error, got %v", err)
	}
	_ = os.Remove(filepath.Join(ft.state, "source-apply-exit"))

	// 3. Apply timeout returns MODEL_SOURCE_TIMEOUT instead of TOOL_FAILED.
	if err := os.WriteFile(filepath.Join(ft.state, "source-apply-sleep"), []byte("300ms"), 0o600); err != nil {
		t.Fatal(err)
	}
	timeoutMS := NewModelSource(ModelSourceOptions{
		Tool:         &ft.tool,
		Environment:  map[string]string{"LOCALMODELS_FAKE_TOOL": "1"},
		JobDirectory: filepath.Join(t.TempDir(), "jobs"),
		ApplyTimeout: 50 * time.Millisecond,
	})
	_, err = timeoutMS.Apply(t.Context(), ModelSourceApply{Mode: "local", Runtime: "pi"})
	if !errors.As(err, &sourceErr) || sourceErr.Code != "MODEL_SOURCE_TIMEOUT" {
		t.Fatalf("expected MODEL_SOURCE_TIMEOUT on apply deadline, got %v", err)
	}
	_ = os.Remove(filepath.Join(ft.state, "source-apply-sleep"))

	// 4. BYOK models timeout returns BYOK_CHECK_TIMEOUT, while canceled probe returns TOOL_FAILED.
	if err := os.WriteFile(filepath.Join(ft.state, "source-models-sleep"), []byte("300ms"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = ms.ListByokModels(t.Context(), wire.ByokConfigInput{
		BaseURL: "https://api.example.com", Path: "/v1", Protocol: "openai-chat",
	})
	if !errors.As(err, &sourceErr) || sourceErr.Code != "BYOK_CHECK_TIMEOUT" {
		t.Fatalf("expected BYOK_CHECK_TIMEOUT on models deadline, got %v", err)
	}
	canceledCtx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err = ms.ListByokModels(canceledCtx, wire.ByokConfigInput{
		BaseURL: "https://api.example.com", Path: "/v1", Protocol: "openai-chat",
	})
	if !errors.As(err, &sourceErr) || sourceErr.Code != CodeToolFailed {
		t.Fatalf("expected TOOL_FAILED on canceled models probe, got %v", err)
	}
	_ = os.Remove(filepath.Join(ft.state, "source-models-sleep"))

	// 5. Status timeout returns MODEL_SOURCE_TIMEOUT.
	if err := os.WriteFile(filepath.Join(ft.state, "source-status-sleep"), []byte("300ms"), 0o600); err != nil {
		t.Fatal(err)
	}
	statusTimeoutMS := NewModelSource(ModelSourceOptions{
		Tool:          &ft.tool,
		Environment:   map[string]string{"LOCALMODELS_FAKE_TOOL": "1"},
		JobDirectory:  filepath.Join(t.TempDir(), "jobs"),
		StatusTimeout: 50 * time.Millisecond,
	})
	_, err = statusTimeoutMS.Status(t.Context())
	if !errors.As(err, &sourceErr) || sourceErr.Code != "MODEL_SOURCE_TIMEOUT" {
		t.Fatalf("expected MODEL_SOURCE_TIMEOUT on status deadline, got %v", err)
	}
	_ = os.Remove(filepath.Join(ft.state, "source-status-sleep"))
}

func TestByokAndSubscriptionToLocalNeverInjectByokOrPersonalPiDir(t *testing.T) {
	homeDir := t.TempDir()
	personalPi := filepath.Join(homeDir, ".pi", "agent")
	if err := os.MkdirAll(personalPi, 0o700); err != nil {
		t.Fatal(err)
	}
	// Another home's legacy ~/.local/share/localmodels/tools/gateway-home must
	// not leak into a fresh isolated home's tool invocations.
	legacyHomeGatewayPi := filepath.Join(homeDir, ".local", "share", "localmodels", "tools", "gateway-home", ".pi", "agent")
	if err := os.MkdirAll(legacyHomeGatewayPi, 0o700); err != nil {
		t.Fatal(err)
	}

	// 1. Switching subscription -> local when this home's gateway-home does not
	// exist yet must omit PI_CODING_AGENT_DIR so localmodels never writes to
	// ~/.pi/agent or another home's tools dir.
	ft := newFakeTool(t)
	homeToolsDir := ToolsDirectory(ft.state)
	gatewayPi := filepath.Join(homeToolsDir, "gateway-home", ".pi", "agent")
	byokPi := filepath.Join(homeToolsDir, "byok-home", ".pi", "agent")
	if err := os.MkdirAll(byokPi, 0o700); err != nil {
		t.Fatal(err)
	}
	writeModelSourceJSON(t, ft.state, map[string]any{
		"schema":      modelSourceSchema,
		"mode":        "subscription",
		"runtime":     "claude",
		"environment": map[string]string{},
	})
	if err := os.WriteFile(filepath.Join(ft.state, "source-apply.json"), []byte(`{
		"schema": "localmodels.model-source-status/v1",
		"mode": "local",
		"runtime": "pi",
		"runtime_model": "localmodels-library/qwen3.8",
		"gateway_url": "http://127.0.0.1:18480",
		"environment": {},
		"byok": {"configured": false, "key_saved": false}
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	ms := NewModelSource(ModelSourceOptions{
		Tool:         &ft.tool,
		Environment:  map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "HOME": homeDir},
		JobDirectory: filepath.Join(t.TempDir(), "jobs"),
	})
	if _, err := ms.Apply(t.Context(), ModelSourceApply{Mode: "local", Runtime: "pi"}); err != nil {
		t.Fatalf("subscription -> local Apply failed: %v", err)
	}
	seenPi, err := os.ReadFile(filepath.Join(ft.state, "source-pi-dir.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(seenPi) != "UNSET" {
		t.Fatalf("subscription -> local passed PI_CODING_AGENT_DIR=%q, want UNSET (never %s or %s)", string(seenPi), personalPi, legacyHomeGatewayPi)
	}

	// 2. Switching BYOK -> local with a pre-existing byok-home/.pi/agent in
	// model-source.json must NOT pass byok-home to localmodels and must pass
	// this home's tools/gateway-home/.pi/agent when it exists.
	if err := os.MkdirAll(gatewayPi, 0o700); err != nil {
		t.Fatal(err)
	}
	writeModelSourceJSON(t, ft.state, map[string]any{
		"schema":        modelSourceSchema,
		"mode":          "byok",
		"runtime":       "pi",
		"runtime_model": "localmodels/localmodels-byok",
		"environment":   map[string]string{"PI_CODING_AGENT_DIR": byokPi},
	})
	msWithByokBase := NewModelSource(ModelSourceOptions{
		Tool:         &ft.tool,
		Environment:  map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "HOME": homeDir, "PI_CODING_AGENT_DIR": byokPi},
		JobDirectory: filepath.Join(t.TempDir(), "jobs"),
	})
	if _, err := msWithByokBase.Apply(t.Context(), ModelSourceApply{Mode: "local", Runtime: "pi"}); err != nil {
		t.Fatalf("byok -> local Apply failed: %v", err)
	}
	seenPi, err = os.ReadFile(filepath.Join(ft.state, "source-pi-dir.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(seenPi) != "SET:"+gatewayPi {
		t.Fatalf("byok -> local passed PI_CODING_AGENT_DIR=%q, want SET:%s", string(seenPi), gatewayPi)
	}

	// 3. Even if model-source.json in local mode still has a stale byok-home
	// PI_CODING_AGENT_DIR entry, OverlayEnvironment drops it and falls through
	// to this home's tools/gateway-home/.pi/agent.
	writeModelSourceJSON(t, ft.state, map[string]any{
		"schema":        modelSourceSchema,
		"mode":          "local",
		"runtime":       "pi",
		"runtime_model": "localmodels-library/qwen3.8",
		"environment":   map[string]string{"PI_CODING_AGENT_DIR": byokPi},
	})
	overlaid := OverlayEnvironment(map[string]string{"HOME": homeDir, "PI_CODING_AGENT_DIR": byokPi}, ft.state)
	if overlaid["PI_CODING_AGENT_DIR"] != gatewayPi {
		t.Fatalf("OverlayEnvironment in local mode with stale byok-home = %q, want %q", overlaid["PI_CODING_AGENT_DIR"], gatewayPi)
	}
}

func TestLastJSONDocumentHandlesJsonlFollowedByIndentedMultilineJSON(t *testing.T) {
	prettyStatus, err := json.MarshalIndent(map[string]any{
		"schema":        modelSourceStatusSchema,
		"mode":          "local",
		"runtime":       "pi",
		"runtime_model": "localmodels-library/qwen3.8",
		"gateway_url":   "http://127.0.0.1:18480",
		"environment":   map[string]string{},
		"byok":          map[string]any{"configured": false, "key_saved": false},
	}, "", " ")
	if err != nil {
		t.Fatal(err)
	}
	stdout := []byte(strings.Join([]string{
		`{"kind":"stage","stage":"download","state":"connecting"}`,
		`{"kind":"progress","unit":"bytes","completed":512,"total":1024}`,
		string(prettyStatus),
	}, "\n") + "\n")
	status, parseErr := parseSourceStatus(stdout)
	if parseErr != nil {
		t.Fatalf("parseSourceStatus failed on indent=1 JSON after JSONL: %v", parseErr)
	}
	if status.Mode != "local" || status.RuntimeModel != "localmodels-library/qwen3.8" {
		t.Fatalf("unexpected status: %+v", status)
	}

	prettyErr, err := json.MarshalIndent(map[string]any{
		"code":  "BYOK_UNREACHABLE",
		"error": "Connection refused after retries.",
	}, "", " ")
	if err != nil {
		t.Fatal(err)
	}
	errStdout := []byte("Warning: retrying connection\n{\"kind\":\"stage\"}\n" + string(prettyErr) + "\n")
	toolErr := parseToolFailure(errStdout, CodeToolFailed, "fallback", "")
	var sourceErr *ModelSourceError
	if !errors.As(toolErr, &sourceErr) || sourceErr.Code != "BYOK_UNREACHABLE" || sourceErr.Message != "Connection refused after retries." {
		t.Fatalf("parseToolFailure on indent=1 JSON = %v", toolErr)
	}
}

func TestModelSourceRedactsSecretsAndCredentialsWhileKeepingSystemBinaries(t *testing.T) {
	rawMessage := `Operation not permitted: '/bin/ps' calling https://user:pass@api.example.com/v1/models with custom-api-secret, Bearer supersecrettoken, api_key=inline_secret, and sk-1234567890abcdef12345678`

	err := parseToolFailure([]byte(`{"code":"BYOK_GATEWAY_FAILED","message":`+strconvQuote(rawMessage)+`}`), CodeToolFailed, "fallback", "custom-api-secret")
	var sourceErr *ModelSourceError
	if !errors.As(err, &sourceErr) {
		t.Fatalf("expected *ModelSourceError, got %v", err)
	}
	for _, leaked := range []string{
		"custom-api-secret",
		"user:pass",
		"inline_secret",
		"supersecrettoken",
		"sk-1234567890abcdef12345678",
	} {
		if strings.Contains(sourceErr.Message, leaked) {
			t.Fatalf("parseToolFailure leaked %q in %q", leaked, sourceErr.Message)
		}
	}
	if !strings.Contains(sourceErr.Message, "'/bin/ps'") {
		t.Fatalf("expected benign system binary '/bin/ps' preserved, got %q", sourceErr.Message)
	}

	// Also verify runEndpointCommand scrubs BYOK endpoint check failures and submitted API key.
	ft := newFakeTool(t)
	_ = os.WriteFile(filepath.Join(ft.state, "source-check.json"), []byte(`{
		"schema": "localmodels.byok-check/v1",
		"ok": false,
		"code": "BYOK_UPSTREAM_REJECTED",
		"message": `+strconvQuote(`HTTP 401 from https://api.example.com/v1/chat using my-inline-key with Bearer tok_secret_value`)+`
	}`), 0o600)
	_ = os.WriteFile(filepath.Join(ft.state, "source-check-exit"), []byte("1"), 0o600)
	ms := NewModelSource(ModelSourceOptions{
		Tool:         &ft.tool,
		Environment:  map[string]string{"LOCALMODELS_FAKE_TOOL": "1"},
		JobDirectory: filepath.Join(t.TempDir(), "jobs"),
	})
	_, checkErr := ms.TestByok(t.Context(), wire.ByokConfigInput{
		BaseURL: "https://api.example.com", Path: "/v1", Endpoint: "/chat", Protocol: "openai-chat", APIKey: "my-inline-key", ModelID: "m",
	})
	if !errors.As(checkErr, &sourceErr) || sourceErr.Code != "BYOK_UPSTREAM_REJECTED" {
		t.Fatalf("expected BYOK_UPSTREAM_REJECTED, got %v", checkErr)
	}
	for _, leaked := range []string{"my-inline-key", "tok_secret_value"} {
		if strings.Contains(sourceErr.Message, leaked) {
			t.Fatalf("TestByok leaked %q in %q", leaked, sourceErr.Message)
		}
	}
}

func strconvQuote(s string) string {
	encoded, _ := json.Marshal(s)
	return string(encoded)
}

func TestModelSourceDefaultTimeoutsLeaveGatewayHeadroom(t *testing.T) {
	ms := NewModelSource(ModelSourceOptions{})
	if ms.statusTimeout >= 45*time.Second {
		t.Fatalf("statusTimeout=%v must leave headroom inside 45s Gateway timeout", ms.statusTimeout)
	}
	if ms.testTimeout >= 45*time.Second {
		t.Fatalf("testTimeout=%v must leave headroom inside 45s Gateway timeout", ms.testTimeout)
	}
	if ms.applyTimeout >= 180*time.Second {
		t.Fatalf("applyTimeout=%v must leave headroom inside 180s Gateway timeout", ms.applyTimeout)
	}

	// Verify onApplied context deadline is bounded inside Apply's total budget.
	ft := newFakeTool(t)
	_ = os.WriteFile(filepath.Join(ft.state, "source-apply.json"), []byte(`{
		"schema": "localmodels.model-source-status/v1",
		"mode": "local",
		"runtime": "pi",
		"runtime_model": "localmodels-library/qwen3.8",
		"gateway_url": "http://127.0.0.1:18480",
		"environment": {},
		"byok": {"configured": false, "key_saved": false}
	}`), 0o600)
	var onAppliedDeadline time.Time
	started := time.Now()
	bounded := NewModelSource(ModelSourceOptions{
		Tool:          &ft.tool,
		Environment:   map[string]string{"LOCALMODELS_FAKE_TOOL": "1"},
		JobDirectory:  filepath.Join(t.TempDir(), "jobs"),
		StatusTimeout: 40 * time.Second,
		ApplyTimeout:  2 * time.Second,
		OnApplied: func(ctx context.Context) map[string][]RuntimeModelOption {
			onAppliedDeadline, _ = ctx.Deadline()
			return map[string][]RuntimeModelOption{"pi": {{ID: "localmodels-library/qwen3.8"}}}
		},
	})
	if _, err := bounded.Apply(t.Context(), ModelSourceApply{Mode: "local", Runtime: "pi"}); err != nil {
		t.Fatalf("bounded Apply failed: %v", err)
	}
	if onAppliedDeadline.IsZero() || onAppliedDeadline.After(started.Add(2500*time.Millisecond)) {
		t.Fatalf("onApplied deadline %v exceeded ApplyTimeout bound from %v", onAppliedDeadline, started)
	}
}

func writeTestExecutable(t *testing.T, path string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestOverlayRuntimePathsDiscoversHarnessToolsAndVersionOrder(t *testing.T) {
	home := t.TempDir()
	stateDir := filepath.Join(home, "runtime", "localmodels", "state")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	harness := HarnessRoot(stateDir)
	piName := executableNames("pi")[0]

	// Version selection picks 0.10.0 over 0.9.0 and 1.0.0-rc.1 over 0.10.0,
	// ignores non-version directories like staging, and ignores directories
	// without an executable file.
	writeTestExecutable(t, filepath.Join(harness, "tools", "pi", "0.9.0", piName))
	piTen := writeTestExecutable(t, filepath.Join(harness, "tools", "pi", "0.10.0", piName))
	writeTestExecutable(t, filepath.Join(harness, "tools", "pi", "staging", piName))
	if err := os.MkdirAll(filepath.Join(harness, "tools", "pi", "99.0.0"), 0o700); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		nonExecDir := filepath.Join(harness, "tools", "pi", "1.0.0")
		if err := os.MkdirAll(nonExecDir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(nonExecDir, piName), []byte("data"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	got := OverlayRuntimePaths(nil, stateDir)
	if got["pi"] != piTen {
		t.Fatalf("OverlayRuntimePaths tools/pi = %q, want %q", got["pi"], piTen)
	}

	// Higher semver release beats prerelease of the same version.
	piOneOneRC := writeTestExecutable(t, filepath.Join(harness, "tools", "pi", "1.1.0-rc.1", piName))
	if got := OverlayRuntimePaths(nil, stateDir); got["pi"] != piOneOneRC {
		t.Fatalf("OverlayRuntimePaths prerelease = %q, want %q", got["pi"], piOneOneRC)
	}
	piOneOne := writeTestExecutable(t, filepath.Join(harness, "tools", "pi", "1.1.0", piName))
	if got := OverlayRuntimePaths(nil, stateDir); got["pi"] != piOneOne {
		t.Fatalf("OverlayRuntimePaths release = %q, want %q", got["pi"], piOneOne)
	}

	// <harness>/bin/<rt> takes precedence over <harness>/tools/<rt>/<version>/<rt>.
	codexName := executableNames("codex")[0]
	writeTestExecutable(t, filepath.Join(harness, "tools", "codex", "2.0.0", codexName))
	binCodex := writeTestExecutable(t, filepath.Join(harness, "bin", codexName))
	if got := OverlayRuntimePaths(nil, stateDir); got["codex"] != binCodex {
		t.Fatalf("OverlayRuntimePaths bin/codex = %q, want %q", got["codex"], binCodex)
	}

	// Existing executable configured path is kept; missing configured path is replaced.
	customPi := writeTestExecutable(t, filepath.Join(t.TempDir(), piName))
	if got := OverlayRuntimePaths(map[string]string{"pi": customPi}, stateDir); got["pi"] != customPi {
		t.Fatalf("OverlayRuntimePaths overwrote existing configured pi: %q", got["pi"])
	}
	if got := OverlayRuntimePaths(map[string]string{"pi": filepath.Join(t.TempDir(), "missing", piName)}, stateDir); got["pi"] != piOneOne {
		t.Fatalf("OverlayRuntimePaths did not replace missing configured pi: %q, want %q", got["pi"], piOneOne)
	}

	// Stale overlay path in model-source.json is skipped in favor of harness tools.
	writeModelSourceJSON(t, stateDir, map[string]any{
		"schema":        modelSourceSchema,
		"mode":          "local",
		"runtime":       "pi",
		"runtime_paths": map[string]string{"pi": filepath.Join(t.TempDir(), "gone", piName)},
	})
	if got := OverlayRuntimePaths(nil, stateDir); got["pi"] != piOneOne {
		t.Fatalf("OverlayRuntimePaths kept stale overlay path: %q, want %q", got["pi"], piOneOne)
	}
}

func TestModelSourceApplyPreservesPreviousAndHarnessRuntimePaths(t *testing.T) {
	ft := newFakeTool(t)
	root := filepath.Dir(ft.state)
	stateDir := filepath.Join(root, "runtime", "localmodels", "state")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	ft.tool.StateDirectory = stateDir
	ft.state = stateDir
	harness := HarnessRoot(stateDir)
	piName := executableNames("pi")[0]
	codexName := executableNames("codex")[0]
	customCodex := writeTestExecutable(t, filepath.Join(root, "custom", codexName))
	oldHarnessPi := writeTestExecutable(t, filepath.Join(harness, "tools", "pi", "0.9.0", piName))
	newHarnessPi := writeTestExecutable(t, filepath.Join(harness, "tools", "pi", "0.10.0", piName))

	writeModelSourceJSON(t, ft.state, map[string]any{
		"schema":        modelSourceSchema,
		"mode":          "byok",
		"runtime":       "codex",
		"runtime_paths": map[string]string{"codex": customCodex, "pi": oldHarnessPi},
	})
	// Simulate localmodels source apply rewriting model-source.json without
	// runtime_paths and emitting a status document that omits runtime_paths.
	if err := os.WriteFile(filepath.Join(ft.state, "source-apply-model-source.json"), []byte(`{
		"schema": "localmodels.model-source/v1",
		"mode": "local",
		"runtime": "pi",
		"runtime_model": "localmodels-library/qwen3.8",
		"gateway_url": "http://127.0.0.1:18480",
		"environment": {}
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ft.state, "source-apply.json"), []byte(`{
		"schema": "localmodels.model-source-status/v1",
		"mode": "local",
		"runtime": "pi",
		"runtime_model": "localmodels-library/qwen3.8",
		"gateway_url": "http://127.0.0.1:18480",
		"environment": {},
		"byok": {"configured": false, "key_saved": false}
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	ms := NewModelSource(ModelSourceOptions{
		Tool:         &ft.tool,
		Environment:  map[string]string{"LOCALMODELS_FAKE_TOOL": "1"},
		JobDirectory: filepath.Join(t.TempDir(), "jobs"),
		HarnessRoot:  harness,
	})
	if _, err := ms.Apply(t.Context(), ModelSourceApply{Mode: "local", Runtime: "pi"}); err != nil {
		t.Fatalf("Apply error: %v", err)
	}
	overlay := ReadOverlay(ft.state)
	if overlay == nil || overlay.RuntimePaths["codex"] != customCodex {
		t.Fatalf("overlay runtime_paths = %+v, want codex=%q", overlay, customCodex)
	}
	if _, pinnedPi := overlay.RuntimePaths["pi"]; pinnedPi {
		t.Fatalf("overlay unexpectedly pinned harness pi path: %+v", overlay.RuntimePaths)
	}
	resolved := OverlayRuntimePaths(nil, ft.state)
	if resolved["codex"] != customCodex || resolved["pi"] != newHarnessPi {
		t.Fatalf("OverlayRuntimePaths = %+v, want codex=%q pi=%q", resolved, customCodex, newHarnessPi)
	}
}
