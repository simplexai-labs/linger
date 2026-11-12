package provider

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestDiscoverMarksOnlyThePreferredRuntime(t *testing.T) {
	home := t.TempDir()
	discovered, err := Discover(context.Background(), DiscoveryOptions{
		Runtimes:         []string{"codex", "pi"},
		PreferredRuntime: "pi",
		Environment:      map[string]string{"HOME": home, "PATH": filepath.Join(home, "empty")},
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := DiagnosticsJSON(discovered.Diagnostics)
	if err != nil {
		t.Fatal(err)
	}
	var wire []map[string]any
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	marked := map[string]any{}
	for _, item := range wire {
		marked[item["type"].(string)] = item["preferred"]
	}
	if len(marked) != 2 || marked["pi"] != true || marked["codex"] != nil {
		t.Fatalf("preferred marks = %v, want only pi", marked)
	}
}
