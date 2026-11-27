package daemon

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	lingercontext "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/context"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/localmodels"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

func TestPrefixWarmupRunnerPrerequisitesAndUnsupported(t *testing.T) {
	var fetches atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token-a/static-prefixes/v1" {
			fetches.Add(1)
			http.NotFound(w, r)
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	contentURL := ""
	piInstall := lingercontext.ProviderInstallation{}
	piReady := false
	var invoked atomic.Int32

	runner := &PrefixWarmupRunner{
		ContentURL: func() string { return contentURL },
		PiInstallation: func() (lingercontext.ProviderInstallation, bool) {
			return piInstall, piReady
		},
		ManagedMCPExtension: "/opt/tools/pi-mcp.mjs",
		HTTPClient:          server.Client(),
		RunWarmup: func(context.Context, native.Profile, string, string, string, native.StrataPinSpec, json.RawMessage) error {
			invoked.Add(1)
			return nil
		},
	}

	target := localmodels.PrefixWarmupTarget{
		ModelID:       "qwen3-4b",
		PiModel:       "localmodels/qwen3-4b",
		Engine:        "polystrata",
		ContextTokens: 65536,
	}

	done, err := runner.Warmup(t.Context(), target)
	if err != nil || done {
		t.Fatalf("missing ContentURL: Warmup = (%t, %v), want (false, nil)", done, err)
	}

	contentURL = server.URL + "/token-a"
	done, err = runner.Warmup(t.Context(), target)
	if err != nil || done {
		t.Fatalf("missing Pi: Warmup = (%t, %v), want (false, nil)", done, err)
	}

	piReady = true
	piInstall = lingercontext.ProviderInstallation{ExecutablePath: "/usr/local/bin/pi"}
	done, err = runner.Warmup(t.Context(), target)
	if err != nil || !done {
		t.Fatalf("404 bundle: Warmup = (%t, %v), want (true, nil)", done, err)
	}
	done, err = runner.Warmup(t.Context(), target)
	if err != nil || !done {
		t.Fatalf("second 404 bundle: Warmup = (%t, %v), want (true, nil)", done, err)
	}
	if fetches.Load() != 2 {
		t.Fatalf("404 fetch count = %d, want 2 (uncached)", fetches.Load())
	}
	if invoked.Load() != 0 {
		t.Fatalf("invoked = %d, want 0 when unsupported", invoked.Load())
	}
}

func TestPrefixWarmupRunnerRejectsInvalidV1Bundle(t *testing.T) {
	for _, tc := range []struct {
		name    string
		payload map[string]any
	}{
		{
			name: "non_positive_compact_threshold",
			payload: map[string]any{
				"version":                    1,
				"marker":                     lingercontext.StaticPrefixEndMarker,
				"compact_max_context_tokens": 0,
				"prefixes": map[string]any{
					"meta":      map[string]any{"full": "META", "compact": "META"},
					"alter_ego": map[string]any{"full": "ALTER", "compact": "ALTER"},
				},
			},
		},
		{
			name: "empty_marker",
			payload: map[string]any{
				"version":                    1,
				"marker":                     "   ",
				"compact_max_context_tokens": 128 * 1024,
				"prefixes": map[string]any{
					"meta":      map[string]any{"full": "META", "compact": "META"},
					"alter_ego": map[string]any{"full": "ALTER", "compact": "ALTER"},
				},
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/conn/static-prefixes/v1" {
					http.NotFound(w, r)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(tc.payload)
			}))
			defer server.Close()

			var invoked atomic.Int32
			runner := &PrefixWarmupRunner{
				ContentURL: func() string { return server.URL + "/conn" },
				PiInstallation: func() (lingercontext.ProviderInstallation, bool) {
					return lingercontext.ProviderInstallation{ExecutablePath: "/usr/local/bin/pi"}, true
				},
				ManagedMCPExtension: "/opt/tools/pi-mcp.mjs",
				HTTPClient:          server.Client(),
				RunWarmup: func(context.Context, native.Profile, string, string, string, native.StrataPinSpec, json.RawMessage) error {
					invoked.Add(1)
					return nil
				},
			}

			done, err := runner.Warmup(t.Context(), localmodels.PrefixWarmupTarget{
				ModelID:       "qwen3-4b",
				PiModel:       "localmodels/qwen3-4b",
				Engine:        "polystrata",
				ContextTokens: 65536,
			})
			if err == nil || done {
				t.Fatalf("Warmup = (%t, %v), want (false, non-nil error)", done, err)
			}
			if invoked.Load() != 0 {
				t.Fatalf("invoked = %d, want 0 for invalid bundle", invoked.Load())
			}
		})
	}
}

func TestPrefixWarmupRunnerSelectsVariantAndCleansTempDir(t *testing.T) {
	var fetchesA atomic.Int32
	var fetchesB atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/conn-a/static-prefixes/v1":
			fetchesA.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"version":                    1,
				"marker":                     lingercontext.StaticPrefixEndMarker,
				"compact_max_context_tokens": 128 * 1024,
				"prefixes": map[string]any{
					"meta":      map[string]any{"full": "META-FULL-A", "compact": "META-COMPACT-A"},
					"alter_ego": map[string]any{"full": "ALTER-FULL-A", "compact": "ALTER-COMPACT-A"},
				},
			})
		case "/conn-b/static-prefixes/v1":
			fetchesB.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"version":                    1,
				"marker":                     lingercontext.StaticPrefixEndMarker,
				"compact_max_context_tokens": 128 * 1024,
				"prefixes": map[string]any{
					"meta":      map[string]any{"full": "META-FULL-B", "compact": "META-COMPACT-B"},
					"alter_ego": map[string]any{"full": "ALTER-FULL-B", "compact": "ALTER-COMPACT-B"},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	type recordedCall struct {
		profile      native.Profile
		dir          string
		instructions string
		model        string
		pin          native.StrataPinSpec
		mcpConfig    json.RawMessage
	}
	var calls []recordedCall
	tempBase := filepath.Join(t.TempDir(), "op-tmp")
	contentURL := server.URL + "/conn-a"
	serviceCommand := []string{"/opt/bin/linger-computer", "--config", "/etc/c.json"}
	const toolGuide = "ToolGuide"
	const hostGuide = "HostEnvironmentGuide"

	runner := &PrefixWarmupRunner{
		ContentURL: func() string { return contentURL },
		PiInstallation: func() (lingercontext.ProviderInstallation, bool) {
			return lingercontext.ProviderInstallation{
				ExecutablePath: "/usr/local/bin/pi",
				Environment:    map[string]string{"FOO": "bar"},
			}, true
		},
		ManagedMCPExtension:  "/opt/tools/pi-mcp.mjs",
		ServiceCommand:       serviceCommand,
		ToolGuide:            toolGuide,
		HostEnvironmentGuide: hostGuide,
		TeamHubCLI:           true,
		TempBase:             tempBase,
		HTTPClient:           server.Client(),
		RunWarmup: func(_ context.Context, profile native.Profile, dir, instructionsFile, model string, pin native.StrataPinSpec, mcpConfig json.RawMessage) error {
			content, err := os.ReadFile(instructionsFile)
			if err != nil {
				t.Fatal(err)
			}
			calls = append(calls, recordedCall{
				profile:      profile,
				dir:          dir,
				instructions: string(content),
				model:        model,
				pin:          pin,
				mcpConfig:    append(json.RawMessage(nil), mcpConfig...),
			})
			return nil
		},
	}

	guides := lingercontext.PiDaemonStaticGuides(serviceCommand, toolGuide, hostGuide, true, true, true)

	// <= 128K selects compact variants.
	done, err := runner.Warmup(t.Context(), localmodels.PrefixWarmupTarget{
		ModelID:       "model-compact",
		PiModel:       "localmodels/model-compact",
		Engine:        "polystrata",
		ContextTokens: 128 * 1024,
	})
	if err != nil || !done {
		t.Fatalf("compact Warmup = (%t, %v)", done, err)
	}
	if len(calls) != 2 {
		t.Fatalf("compact calls = %d, want 2", len(calls))
	}
	if calls[0].pin != (native.StrataPinSpec{Name: "linger-meta", PrefillOnly: true, Resident: "ram", Anchor: lingercontext.StaticPrefixEndMarker}) {
		t.Fatalf("unexpected meta pin: %+v", calls[0].pin)
	}
	if calls[1].pin != (native.StrataPinSpec{Name: "linger-alter-ego", PrefillOnly: true, Resident: "ram", Anchor: lingercontext.StaticPrefixEndMarker}) {
		t.Fatalf("unexpected alter-ego pin: %+v", calls[1].pin)
	}
	wantMetaCompact := lingercontext.AssembleWarmupSystemPrompt("META-COMPACT-A", guides)
	wantAlterCompact := lingercontext.AssembleWarmupSystemPrompt("ALTER-COMPACT-A", guides)
	if calls[0].instructions != wantMetaCompact || calls[1].instructions != wantAlterCompact {
		t.Fatalf("compact instructions mismatch:\ngot[0]=%q\nwant[0]=%q\ngot[1]=%q\nwant[1]=%q",
			calls[0].instructions, wantMetaCompact, calls[1].instructions, wantAlterCompact)
	}
	if calls[0].profile.Env["FOO"] != "bar" || calls[0].profile.ManagedMCPExtension != "/opt/tools/pi-mcp.mjs" {
		t.Fatalf("unexpected profile: %+v", calls[0].profile)
	}
	// Temp workDir must be removed once Warmup finishes.
	if _, err := os.Stat(calls[0].dir); !os.IsNotExist(err) {
		t.Fatalf("expected temp dir %s removed, stat err = %v", calls[0].dir, err)
	}

	// Second call fetches fresh bundle; > 128K uses full variants.
	calls = nil
	done, err = runner.Warmup(t.Context(), localmodels.PrefixWarmupTarget{
		ModelID:       "model-full",
		PiModel:       "localmodels/model-full",
		Engine:        "strata",
		ContextTokens: 256 * 1024,
	})
	if err != nil || !done {
		t.Fatalf("full Warmup = (%t, %v)", done, err)
	}
	if fetchesA.Load() != 2 {
		t.Fatalf("fetchesA = %d, want 2 (uncached)", fetchesA.Load())
	}
	if calls[0].instructions != lingercontext.AssembleWarmupSystemPrompt("META-FULL-A", guides) ||
		calls[1].instructions != lingercontext.AssembleWarmupSystemPrompt("ALTER-FULL-A", guides) {
		t.Fatalf("full instructions mismatch: %#v", calls)
	}

	// New ContentURL fetches fresh bundle.
	contentURL = server.URL + "/conn-b"
	calls = nil
	done, err = runner.Warmup(t.Context(), localmodels.PrefixWarmupTarget{
		ModelID:       "model-b",
		PiModel:       "localmodels/model-b",
		Engine:        "polystrata",
		ContextTokens: 0,
	})
	if err != nil || !done || fetchesB.Load() != 1 {
		t.Fatalf("reconnect Warmup = (%t, %v, fetchesB=%d)", done, err, fetchesB.Load())
	}
	if !strings.HasPrefix(calls[0].instructions, "META-FULL-B") {
		t.Fatalf("expected conn-b bundle after URL change, got %q", calls[0].instructions)
	}
}

func TestPrefixWarmupRunnerOpensAndClosesMCPServersOnce(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/conn/static-prefixes/v1" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"version":                    1,
			"marker":                     lingercontext.StaticPrefixEndMarker,
			"compact_max_context_tokens": 128 * 1024,
			"prefixes": map[string]any{
				"meta":      map[string]any{"full": "META", "compact": "META"},
				"alter_ego": map[string]any{"full": "ALTER", "compact": "ALTER"},
			},
		})
	}))
	defer server.Close()

	var opens atomic.Int32
	var closes atomic.Int32
	wantMCP := json.RawMessage(`{"mcpServers":{"computer":{"type":"http","url":"http://127.0.0.1:4321/mcp/warmup","tool_timeout_sec":600}}}`)
	var seenPins []string
	var seenConfigs []string

	runner := &PrefixWarmupRunner{
		ContentURL: func() string { return server.URL + "/conn" },
		PiInstallation: func() (lingercontext.ProviderInstallation, bool) {
			return lingercontext.ProviderInstallation{ExecutablePath: "/usr/local/bin/pi"}, true
		},
		ManagedMCPExtension: "/opt/tools/pi-mcp.mjs",
		HTTPClient:          server.Client(),
		WarmupMCPServers: func(context.Context) (json.RawMessage, func(), error) {
			opens.Add(1)
			return wantMCP, func() { closes.Add(1) }, nil
		},
		RunWarmup: func(_ context.Context, _ native.Profile, _ string, _ string, _ string, pin native.StrataPinSpec, mcpConfig json.RawMessage) error {
			if closes.Load() != 0 {
				t.Fatalf("MCP server closed before warm-up pin %s completed", pin.Name)
			}
			seenPins = append(seenPins, pin.Name)
			seenConfigs = append(seenConfigs, string(mcpConfig))
			return nil
		},
	}

	done, err := runner.Warmup(t.Context(), localmodels.PrefixWarmupTarget{
		ModelID: "qwen3-4b",
		PiModel: "localmodels/qwen3-4b",
		Engine:  "polystrata",
	})
	if err != nil || !done {
		t.Fatalf("Warmup = (%t, %v), want (true, nil)", done, err)
	}
	if opens.Load() != 1 || closes.Load() != 1 {
		t.Fatalf("WarmupMCPServers opens=%d closes=%d, want 1/1", opens.Load(), closes.Load())
	}
	if strings.Join(seenPins, ",") != "linger-meta,linger-alter-ego" {
		t.Fatalf("pins = %v", seenPins)
	}
	if len(seenConfigs) != 2 || seenConfigs[0] != string(wantMCP) || seenConfigs[1] != string(wantMCP) {
		t.Fatalf("mcpConfigs = %q, want %s for both pins", seenConfigs, wantMCP)
	}
}
