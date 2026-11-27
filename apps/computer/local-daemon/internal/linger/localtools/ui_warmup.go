package localtools

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
)

// OpenWarmupComputerMCP starts a lightweight, schema-only local HTTP MCP server
// exposing the same unified UI tool declarations as BindUI without launching
// QuickJS, Playwright, or any CUA driver. Its close callback shuts the server
// down and is safe to call multiple times.
func OpenWarmupComputerMCP(ctx context.Context) (json.RawMessage, func(), error) {
	serverCtx, cancel := context.WithCancel(ctx)
	server, err := openToolServer(serverCtx, mcpproxy.OperationIdentity{}, unifiedUITools(), refuseWarmupCall, unifiedToolTimeout)
	if err != nil {
		cancel()
		return nil, nil, err
	}
	var closeOnce sync.Once
	closeServer := func() {
		closeOnce.Do(func() {
			cancel()
			_ = server.server.Close()
		})
	}
	config, err := json.Marshal(map[string]any{
		"mcpServers": map[string]any{
			"computer": map[string]any{
				"type":             "http",
				"url":              server.url,
				"tool_timeout_sec": int(unifiedToolTimeout / time.Second),
			},
		},
	})
	if err != nil {
		closeServer()
		return nil, nil, err
	}
	return config, closeServer, nil
}

func refuseWarmupCall(context.Context, string, json.RawMessage) (json.RawMessage, error) {
	return nil, errors.New("prefix warmup MCP server does not execute tools")
}
