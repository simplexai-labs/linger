package mcpproxy

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
)

func TestSetHasComputerTargetResolver(t *testing.T) {
	var nilSet *Set
	if nilSet.HasComputerTargetResolver() {
		t.Fatal("nil set must report false")
	}

	set := &Set{config: []byte(`{"mcpServers":{}}`)}
	if err := set.AddLocal(LocalBinding{
		Name:      "computer",
		URL:       "http://127.0.0.1:1/mcp",
		WaitReady: func(context.Context) error { return nil },
		Close:     func() error { return nil },
	}); err != nil {
		t.Fatal(err)
	}
	if set.HasComputerTargetResolver() {
		t.Fatal("binding without ResolveTarget must report false (non-macOS behavior)")
	}

	if err := set.AddLocal(LocalBinding{
		Name:      "mac",
		URL:       "http://127.0.0.1:2/mcp",
		WaitReady: func(context.Context) error { return nil },
		Close:     func() error { return nil },
		ResolveTarget: func(context.Context, string, json.RawMessage) *permission.Desktop {
			return &permission.Desktop{BundleID: "com.apple.Safari"}
		},
	}); err != nil {
		t.Fatal(err)
	}
	if !set.HasComputerTargetResolver() {
		t.Fatal("binding with ResolveTarget must report true")
	}
}
