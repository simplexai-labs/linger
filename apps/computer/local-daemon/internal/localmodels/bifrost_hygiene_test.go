package localmodels

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPruneStaleLocalModelsLLMProvider(t *testing.T) {
	t.Run("prunes duplicate localmodels-llm once and writes backup", func(t *testing.T) {
		dir := t.TempDir()
		cfgPath := filepath.Join(dir, "config.json")
		initial := `{
  "providers": {
    "localmodels-llm": {
      "network_config": {"base_url": "http://localhost:18100/v1"},
      "keys": [{"value": "old-key"}]
    },
    "localmodels-lib-qwen3": {
      "network_config": {"base_url": "http://127.0.0.1:18100/v1/"},
      "keys": [{"value": "new-key"}]
    }
  },
  "mcp": {"keep": true}
}
`
		if err := os.WriteFile(cfgPath, []byte(initial), 0o600); err != nil {
			t.Fatal(err)
		}

		pruned, err := pruneStaleLocalModelsLLMProvider(dir)
		if err != nil {
			t.Fatalf("first prune error = %v", err)
		}
		if !pruned {
			t.Fatal("expected first prune to remove stale localmodels-llm")
		}

		bak, err := os.ReadFile(filepath.Join(dir, "config.json.bak"))
		if err != nil {
			t.Fatalf("read backup: %v", err)
		}
		if string(bak) != initial {
			t.Fatalf("backup content mismatch")
		}
		updated, err := os.ReadFile(cfgPath)
		if err != nil {
			t.Fatalf("read updated config: %v", err)
		}
		text := string(updated)
		if strings.Contains(text, "localmodels-llm") {
			t.Fatalf("stale localmodels-llm still present: %s", text)
		}
		if !strings.Contains(text, "localmodels-lib-qwen3") || !strings.Contains(text, `"keep": true`) {
			t.Fatalf("preserved keys missing after prune: %s", text)
		}

		// Idempotent on second run and preserves original .bak.
		prunedAgain, err := pruneStaleLocalModelsLLMProvider(dir)
		if err != nil || prunedAgain {
			t.Fatalf("second prune = (%v, %v), want (false, nil)", prunedAgain, err)
		}
	})

	t.Run("does not prune when base URL or keys do not indicate stale duplicate", func(t *testing.T) {
		dir := t.TempDir()
		cfgPath := filepath.Join(dir, "config.json")
		initial := `{
  "providers": {
    "localmodels-llm": {
      "network_config": {"base_url": "http://127.0.0.1:18100/v1"},
      "keys": ["same-key"]
    },
    "localmodels-lib-qwen3": {
      "network_config": {"base_url": "http://127.0.0.1:18100/v1"},
      "keys": ["same-key"]
    }
  }
}`
		if err := os.WriteFile(cfgPath, []byte(initial), 0o600); err != nil {
			t.Fatal(err)
		}
		pruned, err := pruneStaleLocalModelsLLMProvider(dir)
		if err != nil || pruned {
			t.Fatalf("prune = (%v, %v), want (false, nil)", pruned, err)
		}
		if _, err := os.Stat(filepath.Join(dir, "config.json.bak")); !os.IsNotExist(err) {
			t.Fatalf("unexpected backup created when nothing was pruned")
		}
	})

	t.Run("ignores non-loopback endpoints", func(t *testing.T) {
		dir := t.TempDir()
		cfgPath := filepath.Join(dir, "config.json")
		initial := `{
  "providers": {
    "localmodels-llm": {
      "network_config": {"base_url": "https://api.example.com/v1"},
      "keys": ["k1"]
    },
    "localmodels-lib-qwen3": {
      "network_config": {"base_url": "https://api.example.com/v1"},
      "keys": ["k2"]
    }
  }
}`
		if err := os.WriteFile(cfgPath, []byte(initial), 0o600); err != nil {
			t.Fatal(err)
		}
		pruned, err := pruneStaleLocalModelsLLMProvider(dir)
		if err != nil || pruned {
			t.Fatalf("prune = (%v, %v), want (false, nil)", pruned, err)
		}
	})
}

func TestLogStorageSummary(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "runtime", "localmodels", "state")
	baseDir := filepath.Join(root, "models")
	for _, p := range []struct {
		file string
		size int
	}{
		{filepath.Join(baseDir, "weights.gguf"), 128},
		{filepath.Join(ToolsDirectory(stateDir), "owned.json"), 64},
		{filepath.Join(BifrostDirectory(stateDir), "config.json"), 32},
		{filepath.Join(stateDir, "status.json"), 16},
	} {
		if err := os.MkdirAll(filepath.Dir(p.file), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p.file, make([]byte, p.size), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// Should walk and log cleanly without panic or blocking.
	logStorageSummary(t.Context(), stateDir, baseDir)
}
