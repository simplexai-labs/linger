package provider

import (
	"cmp"
	"context"
	"net/url"
	"strings"

	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

// The vendors' own hosts, which a Runtime calls when its configuration names
// no other endpoint. Codex signed in with ChatGPT calls chatgpt.com and with
// an API key api.openai.com, so both count as its built-in endpoints.
const (
	codexChatGPTEndpoint = "https://chatgpt.com"
	codexOpenAIEndpoint  = "https://api.openai.com"
	claudeEndpoint       = "https://api.anthropic.com"
)

// ModelEndpoints names the endpoints a model call on runtimeType connects to,
// read from the installed Runtime's own configuration: the base URL of a
// custom provider or gateway it is set up with, otherwise the vendor's
// built-in hosts. It is empty when they are unknown, as for Pi whose default
// model is on a built-in provider.
func (m ModelInvoker) ModelEndpoints(ctx context.Context, runtimeType, model string) []*url.URL {
	if m.Lookup == nil {
		return nil
	}
	installed, ok, err := m.Lookup(ctx, runtimeType)
	if err != nil || !ok {
		return nil
	}
	return modelEndpoints(runtimeType, installed.Environment, cmp.Or(model, installed.DefaultModel))
}

func modelEndpoints(runtimeType string, environment map[string]string, defaultModel string) []*url.URL {
	var endpoints []string
	switch runtimeType {
	case "codex":
		endpoints = codexEndpoints(environment)
	case "claude":
		endpoints = []string{claudeEndpoint}
		if source, err := localworkspace.ClaudeSourceEnvironment(environment); err == nil {
			// Claude calls a base URL set here whether it signs in with a
			// key or with the subscription.
			if base := strings.TrimSpace(source["ANTHROPIC_BASE_URL"]); base != "" {
				endpoints = []string{base}
			}
		}
	case "pi":
		// A Pi call runs Pi's default model, named provider/model. Only a
		// custom provider in models.json names its endpoint; a built-in one
		// or an unknown default leaves the endpoints unknown.
		if provider, _, ok := strings.Cut(defaultModel, "/"); ok {
			if endpoint, custom := piGatewayProviders(environment)[provider]; custom {
				endpoints = []string{endpoint.baseURL}
			}
		}
	}
	return parseModelEndpoints(endpoints)
}

// codexEndpoints reads the source Codex home a model call copies its provider
// settings from: the active custom provider's base URL, or the built-in
// provider's two hosts with any override config.toml sets for them.
func codexEndpoints(environment map[string]string) []string {
	chatGPT, openAI := codexChatGPTEndpoint, codexOpenAIEndpoint
	home, err := localworkspace.CodexSourceHome(environment)
	if err != nil {
		return []string{chatGPT, openAI}
	}
	config, ok := readCodexConfig(home)
	if !ok {
		return []string{chatGPT, openAI}
	}
	if provider, ok := config.activeCustomProvider(); ok {
		return []string{provider.BaseURL}
	}
	if base := strings.TrimSpace(config.ChatGPTBaseURL); base != "" {
		chatGPT = base
	}
	if base := strings.TrimSpace(config.OpenAIBaseURL); base != "" {
		openAI = base
	}
	return []string{chatGPT, openAI}
}

// parseModelEndpoints keeps each HTTP(S) endpoint's scheme and host once.
func parseModelEndpoints(endpoints []string) []*url.URL {
	var parsed []*url.URL
	seen := map[string]bool{}
	for _, endpoint := range endpoints {
		value, err := url.Parse(strings.TrimSpace(endpoint))
		if err != nil || (value.Scheme != "http" && value.Scheme != "https") || value.Hostname() == "" {
			continue
		}
		key := value.Scheme + "://" + value.Host
		if seen[key] {
			continue
		}
		seen[key] = true
		parsed = append(parsed, &url.URL{Scheme: value.Scheme, Host: value.Host})
	}
	return parsed
}
