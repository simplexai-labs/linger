package integration_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/custommcp"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
)

const customMCPFixtureToken = "fixture" + "-mcp-token"

type customMCPFixture struct {
	calls atomic.Int32
}

func (*customMCPFixture) Discover(_ context.Context, endpoint, token string) ([]custommcp.Tool, error) {
	if endpoint != "https://mcp.example.test/echo" || token != customMCPFixtureToken {
		return nil, custommcp.ErrUnauthorized
	}
	return []custommcp.Tool{{
		Name: "echo", Description: "Echo a test value",
		InputSchema: json.RawMessage(`{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}`),
	}}, nil
}

func (f *customMCPFixture) Call(_ context.Context, endpoint, token, tool string, arguments map[string]any) (json.RawMessage, error) {
	f.calls.Add(1)
	if endpoint != "https://mcp.example.test/echo" || token != customMCPFixtureToken || tool != "echo" {
		return nil, custommcp.ErrUnauthorized
	}
	if arguments["text"] == "tool error" {
		return json.RawMessage(`{"isError":true,"content":[{"type":"text","text":"Echo limit reached"}]}`), nil
	}
	return json.Marshal(map[string]any{"structuredContent": map[string]any{"echo": arguments["text"]}})
}

func TestCustomMCPConnectorFromSetupThroughAgentApproval(t *testing.T) {
	allowParallelIntegrationTest(t)
	provider := &customMCPFixture{}
	env, alice, issued, roomID := newAgentCLIIdentity(t,
		withDeps(func(deps *app.Deps) { deps.CustomMCP = provider }),
		withConfig(func(cfg *config.Config) {
			cfg.ExternalApps.ComposioAPIKey = ""
			cfg.ExternalApps.SecretEncryptionKey = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))
		}),
		starting(app.JobQueue),
	)
	const base = "/v0/custom-mcp-connections"
	if evidence := os.Getenv("LINGER_CUSTOM_MCP_BROWSER_EVIDENCE"); evidence != "" {
		if connectAnotherMeComputer(t, env, acmeTenant, "actor_acme_alice") == "" {
			t.Fatal("the browser fixture could not provision Alice's Another Me")
		}
		ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, "node", "../../../../.agents/skills/verify-linger/custom-mcp-browser.mjs", env.server.URL, evidence)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("browser connector flow: %v\n%s", err, output)
		}
		t.Log("browser created the connector through the production Web assets")
	} else {
		input := map[string]any{"name": "Example MCP", "endpoint": "https://mcp.example.test/echo", "token": customMCPFixtureToken}
		code, _, body := env.request(alice, http.MethodPost, base+"/test", map[string]any{"endpoint": input["endpoint"], "token": input["token"]}, "")
		if code != http.StatusOK || !bytes.Contains(body, []byte(`"name":"echo"`)) {
			t.Fatalf("test connection: %d %s", code, body)
		}
		code, _, body = env.request(alice, http.MethodPost, base, input, "")
		if code != http.StatusOK || bytes.Contains(body, []byte(customMCPFixtureToken)) {
			t.Fatalf("save status=%d or token was echoed", code)
		}
	}
	code, _, body := env.request(alice, http.MethodGet, base, nil, "")
	if code != http.StatusOK || bytes.Contains(body, []byte(customMCPFixtureToken)) {
		t.Fatalf("list status=%d, expected the saved connector with no token", code)
	}
	var listed struct {
		Connections []externalsource.CustomMCPConnection `json:"connections"`
	}
	decode(t, body, &listed)
	if len(listed.Connections) != 1 {
		t.Fatalf("listed %d custom connectors", len(listed.Connections))
	}
	connector := listed.Connections[0]
	if connector.ID == "" || !connector.HasToken || len(connector.Tools) != 1 {
		t.Fatal("saved connector has an incomplete catalog")
	}
	var sealed []byte
	if err := env.pool.QueryRow(t.Context(), "SELECT encrypted_token FROM custom_mcp_connections WHERE connection_id=$1", connector.ID).Scan(&sealed); err != nil ||
		len(sealed) == 0 || bytes.Contains(sealed, []byte(customMCPFixtureToken)) {
		t.Fatal("token was not stored encrypted")
	}
	const agentTools = "/api/agent/v1/apps/tools/"
	search := func() (int, []byte) {
		return postAgentInRoom(t, env, issued.AccessToken, roomID, agentTools+"search", map[string]any{
			"query": "echo a value", "app_key": "custom_mcp", "connection_id": connector.ID,
		})
	}
	if code, body := search(); code != http.StatusConflict {
		t.Fatalf("search without grant: %d %s", code, body)
	}
	grant := func(granted bool) {
		t.Helper()
		path := "/v0/external-connections/" + connector.ID + "/agent-grants/actor_acme_official"
		if code, _, body := env.request(alice, http.MethodPut, path, map[string]any{"granted": granted}, ""); code != http.StatusOK {
			t.Fatalf("set grant to %t: %d %s", granted, code, body)
		}
	}
	grant(true)
	code, body = search()
	if code != http.StatusOK {
		t.Fatalf("search with grant: %d %s", code, body)
	}
	var discovered struct {
		Tools []struct {
			Slug    string `json:"tool_slug"`
			Version string `json:"tool_version"`
		} `json:"tools"`
	}
	decode(t, body, &discovered)
	if len(discovered.Tools) != 1 {
		t.Fatalf("discovered %d tools", len(discovered.Tools))
	}
	tool := discovered.Tools[0]
	submit := func(text string) string {
		t.Helper()
		code, body := postAgentInRoom(t, env, issued.AccessToken, roomID, agentTools+"execute", map[string]any{
			"connection_id": connector.ID, "tool_slug": tool.Slug, "tool_version": tool.Version,
			"arguments": map[string]any{"text": text},
		})
		var receipt struct {
			Status string `json:"status"`
			ID     string `json:"interaction_id"`
		}
		decode(t, body, &receipt)
		if code != http.StatusOK || receipt.Status != "confirmation_pending" || receipt.ID == "" {
			t.Fatalf("request confirmation: %d %s", code, body)
		}
		return receipt.ID
	}
	approve := func(id, want string) {
		t.Helper()
		code, _, body := env.request(alice, http.MethodPost, "/v0/decisions/"+id, map[string]any{
			"expected_version": 1, "decision": "approve",
		}, "approve-"+id)
		if code != http.StatusOK {
			t.Fatalf("approve: %d %s", code, body)
		}
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			var status string
			if err := env.pool.QueryRow(t.Context(), "SELECT status FROM decisions WHERE id=$1", id).Scan(&status); err != nil {
				t.Fatal(err)
			}
			if status == want {
				return
			}
			if status == "failed" || status == "unknown" || status == "succeeded" {
				t.Fatalf("approval reached %s, wanted %s", status, want)
			}
			time.Sleep(25 * time.Millisecond)
		}
		t.Fatalf("approval did not reach %s", want)
	}
	first := submit("approved echo")
	if provider.calls.Load() != 0 {
		t.Fatal("the provider was called before approval")
	}
	approve(first, "succeeded")
	if provider.calls.Load() != 1 {
		t.Fatal("approval must dispatch exactly once")
	}
	var echo string
	if err := env.pool.QueryRow(t.Context(),
		`SELECT result->'data'->'structuredContent'->>'echo' FROM decisions WHERE id=$1`, first).Scan(&echo); err != nil || echo != "approved echo" {
		t.Fatalf("approval result did not preserve the MCP response: %v", err)
	}
	rejected := submit("tool error")
	approve(rejected, "failed")
	var detail string
	if err := env.pool.QueryRow(t.Context(),
		`SELECT result->'data'->'content'->0->>'text' FROM decisions WHERE id=$1`, rejected).Scan(&detail); err != nil || detail != "Echo limit reached" {
		t.Fatalf("approval result did not preserve the tool error: %v", err)
	}
	second := submit("revoked echo")
	grant(false)
	grant(true)
	approve(second, "failed")
	if provider.calls.Load() != 2 {
		t.Fatal("revoked grant still dispatched a tool")
	}
	code, body = search()
	if code != http.StatusOK {
		t.Fatalf("search after regrant: %d %s", code, body)
	}
	decode(t, body, &discovered)
	if len(discovered.Tools) != 1 || discovered.Tools[0].Slug == tool.Slug {
		t.Fatal("regrant did not invalidate the old tool")
	}
	tool = discovered.Tools[0]
	third := submit("disconnected echo")
	if code, _, body := env.request(alice, http.MethodDelete, base+"/"+connector.ID, nil, ""); code != http.StatusNoContent {
		t.Fatalf("disconnect: %d %s", code, body)
	}
	approve(third, "failed")
	if provider.calls.Load() != 2 {
		t.Fatal("disconnected connector still dispatched a tool")
	}
	if code, body := search(); code != http.StatusConflict || !strings.Contains(string(body), "app_not_connected") {
		t.Fatalf("search after disconnect: %d %s", code, body)
	}
}
