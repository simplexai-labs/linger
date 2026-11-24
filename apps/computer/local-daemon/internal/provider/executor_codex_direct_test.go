package provider

import (
	"encoding/json"
	"testing"
)

func TestCodexDirectLocalToolsKeepsDaemonToolsOutOfCodeMode(t *testing.T) {
	config := json.RawMessage(`{"mcpServers":{"computer":{"url":"http://127.0.0.1:1/c"},"browser":{"url":"http://127.0.0.1:1/b"},"wiki":{"url":"https://example.com/mcp"}}}`)
	got, err := codexDirectLocalTools(config, []string{"mcp__computer__click", "mcp__browser__browser_snapshot"})
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Servers map[string]map[string]any `json:"mcpServers"`
	}
	if err := json.Unmarshal(got, &parsed); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"computer", "browser"} {
		if omit, _ := json.Marshal(parsed.Servers[name]["omit_tools_from"]); string(omit) != `["code_mode","deferred"]` {
			t.Fatalf("%s: %v", name, parsed.Servers[name])
		}
	}
	if _, found := parsed.Servers["wiki"]["omit_tools_from"]; found {
		t.Fatalf("a remote server left code mode: %v", parsed.Servers["wiki"])
	}
}
