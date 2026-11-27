package computerconfig

import (
	"path/filepath"
	"testing"
	"time"
)

func TestRuntimeDiscoveryOptionsScrubsEnvAndResolvesPaths(t *testing.T) {
	absCodex := filepath.Join(t.TempDir(), "codex")
	absClaude := filepath.Join(t.TempDir(), "claude")
	options, err := RuntimeDiscoveryOptions(RuntimeDiscoveryRequest{
		ConfiguredPaths: map[string]string{
			"codex": absCodex,
		},
		Environment: map[string]string{
			"HOME":                 "/Users/me",
			"PATH":                 "/usr/bin:/bin",
			"CODEX_HOME":           "/Users/me/.codex",
			"CLAUDE_CONFIG_DIR":    "/Users/me/.claude",
			"LINGER_CODEX_PATH":    filepath.Join(t.TempDir(), "env-codex"),
			"LINGER_CLAUDE_PATH":   absClaude,
			"LINGER_PI_PATH":       "relative/pi",
			"LINGER_SECRET":        "secret",
			"TEAMHUB_TOKEN":        "th-token",
			"RUNNER_GATEWAY_TOKEN": "gw-token",
			"SERVICE_TOKEN":        "svc-token",
		},
		Runtimes:             []string{"codex", "claude", "pi"},
		SkipModelCatalog:     true,
		Timeout:              5 * time.Second,
		RequireAbsolutePaths: true,
	})
	if err != nil {
		t.Fatalf("RuntimeDiscoveryOptions failed: %v", err)
	}
	if options.ConfiguredPaths["codex"] != absCodex {
		t.Fatalf("codex path = %q, want explicit %q", options.ConfiguredPaths["codex"], absCodex)
	}
	if options.ConfiguredPaths["claude"] != absClaude {
		t.Fatalf("claude path = %q, want env %q", options.ConfiguredPaths["claude"], absClaude)
	}
	if _, exists := options.ConfiguredPaths["pi"]; exists {
		t.Fatalf("relative LINGER_PI_PATH should be ignored, got %q", options.ConfiguredPaths["pi"])
	}
	if !options.SkipModelCatalog || options.Timeout != 5*time.Second {
		t.Fatalf("unexpected discovery options: %+v", options)
	}
	for _, forbidden := range []string{"LINGER_CODEX_PATH", "LINGER_CLAUDE_PATH", "LINGER_SECRET", "TEAMHUB_TOKEN", "RUNNER_GATEWAY_TOKEN", "SERVICE_TOKEN"} {
		if _, leaked := options.Environment[forbidden]; leaked {
			t.Fatalf("sensitive variable %s leaked into RuntimeEnvironment", forbidden)
		}
	}
	for _, kept := range []string{"HOME", "PATH", "CODEX_HOME", "CLAUDE_CONFIG_DIR"} {
		if options.Environment[kept] == "" {
			t.Fatalf("user variable %s was dropped", kept)
		}
	}
}

func TestRuntimeDiscoveryOptionsRejectsInvalidInputs(t *testing.T) {
	if _, err := RuntimeDiscoveryOptions(RuntimeDiscoveryRequest{
		Runtimes: []string{"unknown"},
	}); err == nil {
		t.Fatal("expected error for unknown runtime")
	}
	if _, err := RuntimeDiscoveryOptions(RuntimeDiscoveryRequest{
		ConfiguredPaths:      map[string]string{"codex": "relative/codex"},
		RequireAbsolutePaths: true,
	}); err == nil {
		t.Fatal("expected error for relative configured path when RequireAbsolutePaths is true")
	}
	if _, err := RuntimeDiscoveryOptions(RuntimeDiscoveryRequest{
		TempBase: "relative/tmp",
	}); err == nil {
		t.Fatal("expected error for relative TempBase")
	}
}

func TestRuntimeDiscoveryOptionsForwardsTempBase(t *testing.T) {
	tempBase := filepath.Join(t.TempDir(), "operation-tmp")
	options, err := RuntimeDiscoveryOptions(RuntimeDiscoveryRequest{
		TempBase: tempBase,
	})
	if err != nil {
		t.Fatalf("RuntimeDiscoveryOptions failed: %v", err)
	}
	if options.TempBase != tempBase {
		t.Fatalf("TempBase = %q, want %q", options.TempBase, tempBase)
	}
}

func TestRuntimeDiscoveryOptionsForwardsBundledPaths(t *testing.T) {
	bundledPi := filepath.Join(t.TempDir(), "bin", "pi")
	options, err := RuntimeDiscoveryOptions(RuntimeDiscoveryRequest{
		BundledPaths: map[string]string{"pi": bundledPi},
		Runtimes:     []string{"pi"},
	})
	if err != nil {
		t.Fatalf("RuntimeDiscoveryOptions failed: %v", err)
	}
	if options.BundledPaths["pi"] != bundledPi {
		t.Fatalf("BundledPaths[pi] = %q, want %q", options.BundledPaths["pi"], bundledPi)
	}

	defaultOptions, err := RuntimeDiscoveryOptions(RuntimeDiscoveryRequest{
		Runtimes: []string{"pi"},
	})
	if err != nil {
		t.Fatalf("RuntimeDiscoveryOptions without bundled paths failed: %v", err)
	}
	if len(defaultOptions.BundledPaths) != 0 {
		t.Fatalf("BundledPaths = %v, want empty", defaultOptions.BundledPaths)
	}
}
