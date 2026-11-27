package native

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestWarmupPiPrefix(t *testing.T) {
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	temp := t.TempDir()
	extDir := filepath.Join(temp, "tools", "ext")
	if err := os.MkdirAll(extDir, 0o700); err != nil {
		t.Fatal(err)
	}
	extPath := filepath.Join(extDir, "pi-mcp.mjs")
	if err := os.WriteFile(extPath, []byte("// fake extension\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	instructionsPath := filepath.Join(temp, "meta.md")
	if err := os.WriteFile(instructionsPath, []byte("Static prefix\n\n<!-- LINGER_STATIC_PREFIX_END -->"), 0o600); err != nil {
		t.Fatal(err)
	}
	pin := StrataPinSpec{
		Name:        "linger-meta",
		PrefillOnly: true,
		Resident:    "ram",
		Anchor:      "<!-- LINGER_STATIC_PREFIX_END -->",
	}

	baseTools := piBaseToolsFor(runtime.GOOS)
	for _, tc := range []struct {
		name      string
		mcpConfig json.RawMessage
		wantTools string
		wantMCP   bool
	}{
		{
			name:      "without_mcp",
			mcpConfig: nil,
			wantTools: baseTools,
			wantMCP:   false,
		},
		{
			name:      "with_mcp",
			mcpConfig: json.RawMessage(`{"mcpServers":{"computer":{"type":"http","url":"http://127.0.0.1:4321/mcp/warmup","tool_timeout_sec":600}}}`),
			wantTools: baseTools + ",mcp__*",
			wantMCP:   true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			workDir := filepath.Join(temp, "work-"+tc.name)
			if err := os.MkdirAll(workDir, 0o700); err != nil {
				t.Fatal(err)
			}
			argvPath := filepath.Join(temp, "argv-"+tc.name+".txt")
			recordPath := filepath.Join(temp, "record-"+tc.name+".json")
			profile := Profile{
				Program:             program,
				ManagedMCPExtension: extPath,
				Env: map[string]string{
					piFakeEnv:       "prefix-warmup",
					piFakeArgvEnv:   argvPath,
					piFakeRecordEnv: recordPath,
					"NODE_PATH":     "/existing/node_modules",
				},
			}
			if err := WarmupPiPrefix(t.Context(), profile, workDir, instructionsPath, "localmodels/test-qwen", pin, tc.mcpConfig); err != nil {
				t.Fatalf("WarmupPiPrefix: %v", err)
			}

			rawArgv, err := os.ReadFile(argvPath)
			if err != nil {
				t.Fatal(err)
			}
			argv := strings.Split(strings.TrimSpace(string(rawArgv)), "\n")
			for _, flag := range []string{"--mode", "--no-session", "--system-prompt", "--model", "--extension", "--tools"} {
				if !slices.Contains(argv, flag) {
					t.Fatalf("missing flag %s in argv %q", flag, argv)
				}
			}
			toolsIdx := slices.Index(argv, "--tools")
			if toolsIdx < 0 || toolsIdx+1 >= len(argv) || argv[toolsIdx+1] != tc.wantTools {
				t.Fatalf("tools argv = %q, want %q", argv, tc.wantTools)
			}
			sysIdx := slices.Index(argv, "--system-prompt")
			if sysIdx < 0 || sysIdx+1 >= len(argv) || argv[sysIdx+1] != instructionsPath {
				t.Fatalf("system-prompt argv = %q, want %q", argv, instructionsPath)
			}
			extIdx := slices.Index(argv, "--extension")
			if extIdx < 0 || extIdx+1 >= len(argv) || argv[extIdx+1] != extPath {
				t.Fatalf("extension argv = %q, want %q", argv, extPath)
			}

			rawRecord, err := os.ReadFile(recordPath)
			if err != nil {
				t.Fatal(err)
			}
			var record struct {
				StrataPin         string `json:"strata_pin"`
				NodePath          string `json:"node_path"`
				InheritedNodePath string `json:"inherited_node_path"`
				Prompt            string `json:"prompt"`
				MCPConfigPath     string `json:"mcp_config_path"`
				MCPConfig         string `json:"mcp_config"`
				MCPConfigMode     uint32 `json:"mcp_config_mode"`
			}
			if err := json.Unmarshal(rawRecord, &record); err != nil {
				t.Fatal(err)
			}
			if record.Prompt != "." {
				t.Fatalf("prompt = %q, want \".\"", record.Prompt)
			}
			expectedModules := filepath.Join(filepath.Dir(extDir), "node_modules")
			if !strings.HasPrefix(record.NodePath, expectedModules) {
				t.Fatalf("NODE_PATH = %q, want prefix %q", record.NodePath, expectedModules)
			}
			if record.InheritedNodePath != "/existing/node_modules" {
				t.Fatalf("inherited NODE_PATH = %q", record.InheritedNodePath)
			}

			if !tc.wantMCP {
				if record.MCPConfigPath != "" || record.MCPConfig != "" {
					t.Fatalf("unexpected MCP env without config: path=%q config=%q", record.MCPConfigPath, record.MCPConfig)
				}
			} else {
				wantPath := filepath.Join(workDir, piMCPConfigName)
				if record.MCPConfigPath != wantPath {
					t.Fatalf("LINGER_PI_MANAGED_MCP_CONFIG = %q, want %q", record.MCPConfigPath, wantPath)
				}
				if record.MCPConfig != string(tc.mcpConfig) {
					t.Fatalf("written MCP config = %q, want %q", record.MCPConfig, tc.mcpConfig)
				}
				if record.MCPConfigMode != 0o600 {
					t.Fatalf("MCP config mode = %#o, want 0o600", record.MCPConfigMode)
				}
				if _, err := os.Stat(wantPath); !os.IsNotExist(err) {
					t.Fatalf("expected MCP config %s to be cleaned up, stat err = %v", wantPath, err)
				}
			}

			var decodedPin map[string]any
			if err := json.Unmarshal([]byte(record.StrataPin), &decodedPin); err != nil {
				t.Fatal(err)
			}
			if _, hasPersist := decodedPin["persist"]; hasPersist {
				t.Fatalf("strata_pin unexpectedly carried persist field: %s", record.StrataPin)
			}
			if decodedPin["name"] != "linger-meta" || decodedPin["prefill_only"] != true ||
				decodedPin["resident"] != "ram" || decodedPin["anchor"] != "<!-- LINGER_STATIC_PREFIX_END -->" {
				t.Fatalf("unexpected strata_pin payload: %#v", decodedPin)
			}
		})
	}
}

func TestWarmupPiPrefixCancelsCleanly(t *testing.T) {
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	temp := t.TempDir()
	extPath := filepath.Join(temp, "pi-mcp.mjs")
	if err := os.WriteFile(extPath, []byte("// fake extension\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	instructionsPath := filepath.Join(temp, "meta.md")
	if err := os.WriteFile(instructionsPath, []byte("Static"), 0o600); err != nil {
		t.Fatal(err)
	}
	promptedPath := filepath.Join(temp, "prompted")

	profile := Profile{
		Program:             program,
		ManagedMCPExtension: extPath,
		Env: map[string]string{
			piFakeEnv:    "prefix-warmup-cancel",
			piFakeLogEnv: promptedPath,
		},
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		errCh <- WarmupPiPrefix(ctx, profile, temp, instructionsPath, "localmodels/test", StrataPinSpec{
			Name:        "linger-meta",
			PrefillOnly: true,
			Resident:    "ram",
		}, nil)
	}()

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(promptedPath); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("expected cancellation error")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("WarmupPiPrefix did not unwind after context cancellation")
	}
}
