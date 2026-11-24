package provider

import (
	"context"
	"path/filepath"
	"slices"
	"testing"
)

func endpointStrings(t *testing.T, runtimeType string, environment map[string]string, defaultModel string) []string {
	t.Helper()
	var got []string
	for _, endpoint := range modelEndpoints(runtimeType, environment, defaultModel) {
		got = append(got, endpoint.String())
	}
	return got
}

// A model call's endpoints come from the Runtime's own configuration: a
// custom provider's or gateway's base URL when one is set, otherwise the
// vendor's built-in hosts with any override config.toml names for them.
func TestModelEndpointsFollowTheRuntimeConfiguration(t *testing.T) {
	builtIn := []string{"https://chatgpt.com", "https://api.openai.com"}

	codexHome := func(config string) map[string]string {
		home := t.TempDir()
		if config != "" {
			writeGatewayFile(t, filepath.Join(home, "config.toml"), config)
		}
		return map[string]string{"CODEX_HOME": home}
	}
	claudeHome := func(settings string, extra map[string]string) map[string]string {
		config := t.TempDir()
		if settings != "" {
			writeGatewayFile(t, filepath.Join(config, "settings.json"), settings)
		}
		environment := map[string]string{"CLAUDE_CONFIG_DIR": config}
		for key, value := range extra {
			environment[key] = value
		}
		return environment
	}
	piHome := func(models string) map[string]string {
		agentDir := t.TempDir()
		writeGatewayFile(t, filepath.Join(agentDir, "models.json"), models)
		return map[string]string{"PI_CODING_AGENT_DIR": agentDir, "HOME": t.TempDir()}
	}

	piProviders := piHome(`{"providers":{
		"zhipu":{"baseUrl":"https://open.bigmodel.cn/api/paas/v4"},
		"lan":{"baseUrl":"http://192.168.1.50:11434/v1"},
		"anthropic":{"apiKey":"ANTHROPIC_KEY"}
	}}`)

	for _, tc := range []struct {
		name, runtime string
		environment   map[string]string
		defaultModel  string
		want          []string
	}{
		{"codex built in", "codex", codexHome(""), "", builtIn},
		{"codex without a home", "codex", map[string]string{}, "", builtIn},
		{"codex custom provider through its profile", "codex", codexHome(`
model_provider = "unused"
profile = "cn"
[profiles.cn]
model_provider = "deepseek"
[model_providers.deepseek]
base_url = "https://api.deepseek.com/v1"
[model_providers.unused]
base_url = "https://unused.example/v1"
`), "", []string{"https://api.deepseek.com"}},
		{"codex built-in URL overrides", "codex", codexHome(`
chatgpt_base_url = "https://chatgpt.proxy.example/backend-api/"
openai_base_url = "https://openai.proxy.example:8443/v1"
`), "", []string{"https://chatgpt.proxy.example", "https://openai.proxy.example:8443"}},
		{"claude built in", "claude", claudeHome("", nil), "", []string{"https://api.anthropic.com"}},
		{"claude base URL in settings without a key", "claude",
			claudeHome(`{"env":{"ANTHROPIC_BASE_URL":"https://open.bigmodel.cn/api/anthropic"}}`, nil), "",
			[]string{"https://open.bigmodel.cn"}},
		{"claude base URL in the environment", "claude",
			claudeHome("", map[string]string{"ANTHROPIC_BASE_URL": "http://127.0.0.1:4000"}), "",
			[]string{"http://127.0.0.1:4000"}},
		{"pi default on a custom provider", "pi", piProviders, "zhipu/glm-4.6", []string{"https://open.bigmodel.cn"}},
		{"pi default on a built-in provider beside an unused custom one", "pi", piProviders, "anthropic/claude-sonnet-4-5", nil},
		{"pi without a known default", "pi", piProviders, "", nil},
		{"another runtime", "antigravity", map[string]string{}, "", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := endpointStrings(t, tc.runtime, tc.environment, tc.defaultModel); !slices.Equal(got, tc.want) {
				t.Fatalf("endpoints = %v, want %v", got, tc.want)
			}
		})
	}
}

// The invoker reads the endpoints from the installed Runtime's environment
// and names none for a Runtime it cannot find.
func TestModelInvokerNamesTheInstalledRuntimesEndpoints(t *testing.T) {
	home := t.TempDir()
	writeGatewayFile(t, filepath.Join(home, "config.toml"), `
model_provider = "lab"
[model_providers.lab]
base_url = "https://lab.example/v1"
`)
	invoker := ModelInvoker{Lookup: func(_ context.Context, runtimeType string) (ModelInvokeRuntime, bool, error) {
		if runtimeType != "codex" {
			return ModelInvokeRuntime{}, false, nil
		}
		return ModelInvokeRuntime{ExecutablePath: "/bin/codex", Environment: map[string]string{"CODEX_HOME": home}}, true, nil
	}}
	got := invoker.ModelEndpoints(context.Background(), "codex", "")
	if len(got) != 1 || got[0].String() != "https://lab.example" {
		t.Fatalf("endpoints = %v", got)
	}
	if got := invoker.ModelEndpoints(context.Background(), "claude", ""); got != nil {
		t.Fatalf("missing Runtime endpoints = %v, want none", got)
	}
	if got := (ModelInvoker{}).ModelEndpoints(context.Background(), "codex", ""); got != nil {
		t.Fatalf("endpoints without a lookup = %v, want none", got)
	}
}
