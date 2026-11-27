package localtools

import (
	"bytes"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestOpenWarmupComputerMCP(t *testing.T) {
	configRaw, closeMCP, err := OpenWarmupComputerMCP(t.Context())
	if err != nil {
		t.Fatalf("OpenWarmupComputerMCP: %v", err)
	}
	defer closeMCP()

	var decoded struct {
		MCPServers map[string]struct {
			Type           string `json:"type"`
			URL            string `json:"url"`
			ToolTimeoutSec int    `json:"tool_timeout_sec"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(configRaw, &decoded); err != nil {
		t.Fatalf("decode config: %v", err)
	}
	computer, ok := decoded.MCPServers["computer"]
	if !ok || len(decoded.MCPServers) != 1 {
		t.Fatalf("unexpected mcpServers: %s", configRaw)
	}
	if computer.Type != "http" || !strings.HasPrefix(computer.URL, "http://127.0.0.1:") || computer.ToolTimeoutSec != int(unifiedToolTimeout/time.Second) {
		t.Fatalf("unexpected computer server config: %+v", computer)
	}

	rpc := func(id int, method string, params any) json.RawMessage {
		t.Helper()
		body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
		if err != nil {
			t.Fatal(err)
		}
		resp, err := http.Post(computer.URL, "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatalf("%s request: %v", method, err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s status = %d, want 200", method, resp.StatusCode)
		}
		var envelope struct {
			Result json.RawMessage `json:"result"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
			t.Fatalf("%s decode: %v", method, err)
		}
		return envelope.Result
	}

	initResult := rpc(1, "initialize", map[string]any{"protocolVersion": "2025-03-26"})
	if !strings.Contains(string(initResult), `"linger-local-tools"`) {
		t.Fatalf("unexpected initialize result: %s", initResult)
	}

	pingResult := rpc(2, "ping", map[string]any{})
	if string(pingResult) != "{}" {
		t.Fatalf("unexpected ping result: %s", pingResult)
	}

	listResult := rpc(3, "tools/list", map[string]any{})
	var listed struct {
		Tools []tool `json:"tools"`
	}
	if err := json.Unmarshal(listResult, &listed); err != nil {
		t.Fatalf("decode tools/list: %v", err)
	}
	if !reflect.DeepEqual(listed.Tools, unifiedUITools()) {
		t.Fatalf("tools/list mismatch:\ngot:  %+v\nwant: %+v", listed.Tools, unifiedUITools())
	}

	for i, name := range []string{"ui_exec", "ui_reset"} {
		callResult := rpc(4+i, "tools/call", map[string]any{"name": name, "arguments": map[string]any{}})
		var callEnvelope struct {
			IsError bool `json:"isError"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		}
		if err := json.Unmarshal(callResult, &callEnvelope); err != nil {
			t.Fatalf("decode tools/call (%s): %v", name, err)
		}
		if !callEnvelope.IsError || len(callEnvelope.Content) == 0 || !strings.Contains(callEnvelope.Content[0].Text, "does not execute tools") {
			t.Fatalf("tools/call (%s) = %s, expected refusal error", name, callResult)
		}
	}

	// Close must be idempotent and shut down the HTTP listener.
	closeMCP()
	closeMCP()
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 99, "method": "ping", "params": map[string]any{}})
	if resp, err := http.Post(computer.URL, "application/json", bytes.NewReader(body)); err == nil {
		_ = resp.Body.Close()
		t.Fatal("expected HTTP request to fail after Close()")
	}
}
