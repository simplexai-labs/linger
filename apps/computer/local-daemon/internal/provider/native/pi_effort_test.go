package native

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestNormalizeReasoningEffort(t *testing.T) {
	tests := []struct {
		name          string
		requested     string
		allowed       []string
		defaultEffort string
		want          string
	}{
		{
			name:          "spark medium clamps to declared high default",
			requested:     "medium",
			allowed:       []string{"low", "high"},
			defaultEffort: "high",
			want:          "high",
		},
		{
			name:          "spark medium clamps to declared low default on tie",
			requested:     "medium",
			allowed:       []string{"low", "high"},
			defaultEffort: "low",
			want:          "low",
		},
		{
			name:          "spark medium without default clamps upward to high",
			requested:     "medium",
			allowed:       []string{"low", "high"},
			defaultEffort: "",
			want:          "high",
		},
		{
			name:          "spark preserves allowed low",
			requested:     "low",
			allowed:       []string{"low", "high"},
			defaultEffort: "high",
			want:          "low",
		},
		{
			name:          "spark preserves allowed high",
			requested:     "high",
			allowed:       []string{"low", "high"},
			defaultEffort: "low",
			want:          "high",
		},
		{
			name:          "spark clamps minimal to nearest low",
			requested:     "minimal",
			allowed:       []string{"low", "high"},
			defaultEffort: "high",
			want:          "low",
		},
		{
			name:          "spark clamps xhigh to nearest high",
			requested:     "xhigh",
			allowed:       []string{"low", "high"},
			defaultEffort: "low",
			want:          "high",
		},
		{
			name:          "none alias matches off in allowed",
			requested:     "none",
			allowed:       []string{"off", "low", "high"},
			defaultEffort: "high",
			want:          "off",
		},
		{
			name:          "off alias matches none in allowed",
			requested:     "off",
			allowed:       []string{"none", "low", "high"},
			defaultEffort: "high",
			want:          "none",
		},
		{
			name:          "single allowed option wins",
			requested:     "low",
			allowed:       []string{"high"},
			defaultEffort: "",
			want:          "high",
		},
		{
			name:          "empty allowed leaves requested unchanged",
			requested:     "medium",
			allowed:       nil,
			defaultEffort: "",
			want:          "medium",
		},
		{
			name:          "empty requested stays empty",
			requested:     "",
			allowed:       []string{"low", "high"},
			defaultEffort: "high",
			want:          "",
		},
		{
			name:          "unknown requested falls back to default",
			requested:     "custom",
			allowed:       []string{"low", "high"},
			defaultEffort: "high",
			want:          "high",
		},
		{
			name:          "case insensitive and trimmed matching",
			requested:     " Medium ",
			allowed:       []string{"none", "low", "high"},
			defaultEffort: " LOW ",
			want:          "low",
		},
		{
			name:          "case insensitive direct match",
			requested:     "HIGH",
			allowed:       []string{"none", "low", "high"},
			defaultEffort: "low",
			want:          "high",
		},
		{
			name:          "case insensitive off alias",
			requested:     " OFF ",
			allowed:       []string{"none", "low", "high"},
			defaultEffort: "high",
			want:          "none",
		},
		{
			name:          "none-only model clamps medium to none",
			requested:     "medium",
			allowed:       []string{"none"},
			defaultEffort: "",
			want:          "none",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := NormalizeReasoningEffort(tc.requested, tc.allowed, tc.defaultEffort)
			if got != tc.want {
				t.Fatalf("NormalizeReasoningEffort(%q, %v, %q) = %q; want %q",
					tc.requested, tc.allowed, tc.defaultEffort, got, tc.want)
			}
		})
	}
}

func TestPiCatalogBifrostRealisticThinkingLevelMaps(t *testing.T) {
	// Realistic localmodels bifrost_models.py outputs omit "off" from
	// thinkingLevelMap so Pi keeps "off" -> "none" alongside mapped levels.
	state := piCatalogState{
		Model:         piCatalogModel{Provider: "localmodels", ID: "Spark-X2.6-4B-Q8_0"},
		ThinkingLevel: "medium",
	}
	list, err := piCatalogList(state, []json.RawMessage{
		json.RawMessage(`{
			"provider": "localmodels",
			"id": "Spark-X2.6-4B-Q8_0",
			"reasoning": true,
			"thinkingLevelMap": {"minimal": null, "low": "low", "medium": null, "high": "high"}
		}`),
		json.RawMessage(`{
			"provider": "localmodels",
			"id": "Spark-No-Off",
			"reasoning": true,
			"thinkingLevelMap": {"off": null, "minimal": null, "low": "low", "medium": null, "high": "high"}
		}`),
		json.RawMessage(`{
			"provider": "localmodels",
			"id": "None-Only-Model",
			"reasoning": true,
			"thinkingLevelMap": {"minimal": null, "low": null, "medium": null, "high": null}
		}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Models) != 3 {
		t.Fatalf("models = %+v", list.Models)
	}
	effortValues := func(m ModelOption) []string {
		if m.Effort == nil {
			return nil
		}
		values := make([]string, len(m.Effort.Options))
		for i, opt := range m.Effort.Options {
			values[i] = opt.Value
		}
		return values
	}
	if got := effortValues(list.Models[0]); !slices.Equal(got, []string{"none", "low", "high"}) {
		t.Fatalf("bifrost spark efforts = %v; want [none low high]", got)
	}
	if list.Models[0].Effort.Default != "high" {
		t.Fatalf("bifrost spark default = %q; want high", list.Models[0].Effort.Default)
	}
	if got := effortValues(list.Models[1]); !slices.Equal(got, []string{"low", "high"}) {
		t.Fatalf("no-off spark efforts = %v; want [low high]", got)
	}
	if got := effortValues(list.Models[2]); !slices.Equal(got, []string{"none"}) {
		t.Fatalf("none-only model efforts = %v; want [none]", got)
	}
}

func TestPiRuntimeClampsRegularTurnViaGetState(t *testing.T) {
	t.Run("clamps empty spec effort via set_thinking_level on fresh startup", func(t *testing.T) {
		commandsFile := filepath.Join(t.TempDir(), "commands")
		h := piNewHarness(t, "clamp-state", map[string]string{piFakeLogEnv: commandsFile})
		_, outcome := piCollect(t, h.start(t.Context(), "hello", RunSpec{Effort: ""}))
		if outcome.Status != statusCompleted || outcome.Output != "effort:high" {
			t.Fatalf("outcome = %+v; want completed with effort:high", outcome)
		}
		commands, _ := os.ReadFile(commandsFile)
		if !strings.Contains(string(commands), "set_thinking_level:high\n") {
			t.Fatalf("commands = %q; want set_thinking_level:high", commands)
		}
	})

	t.Run("clamps unsupported medium effort via set_thinking_level", func(t *testing.T) {
		commandsFile := filepath.Join(t.TempDir(), "commands")
		h := piNewHarness(t, "clamp-state", map[string]string{piFakeLogEnv: commandsFile})
		_, outcome := piCollect(t, h.start(t.Context(), "hello", RunSpec{Effort: "medium"}))
		if outcome.Status != statusCompleted || outcome.Output != "effort:high" {
			t.Fatalf("outcome = %+v; want completed with effort:high", outcome)
		}
		commands, _ := os.ReadFile(commandsFile)
		if !strings.Contains(string(commands), "set_thinking_level:high\n") {
			t.Fatalf("commands = %q; want set_thinking_level:high", commands)
		}
	})

	t.Run("skips set_thinking_level on happy path when requested effort is supported", func(t *testing.T) {
		commandsFile := filepath.Join(t.TempDir(), "commands")
		h := piNewHarness(t, "clamp-state", map[string]string{piFakeLogEnv: commandsFile})
		_, outcome := piCollect(t, h.start(t.Context(), "hello", RunSpec{Effort: "low"}))
		if outcome.Status != statusCompleted || outcome.Output != "effort:low" {
			t.Fatalf("outcome = %+v; want completed with effort:low", outcome)
		}
		commands, _ := os.ReadFile(commandsFile)
		if strings.Contains(string(commands), "set_thinking_level") {
			t.Fatalf("unexpected set_thinking_level RPC on happy path: %q", commands)
		}
	})
}

func TestInvokePiModelClampsViaRPCState(t *testing.T) {
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}

	t.Run("clamps unsupported medium via set_thinking_level", func(t *testing.T) {
		commandsFile := filepath.Join(t.TempDir(), "commands")
		outcome, model, err := InvokePiModel(t.Context(), Profile{
			Program: program,
			Env: map[string]string{
				piFakeEnv:    "invoke-clamp",
				piFakeLogEnv: commandsFile,
			},
		}, t.TempDir(), "", "", "hello", "medium")
		if err != nil || outcome.Status != statusCompleted || model != "localmodels/Spark-X2.6-4B-Q8_0" {
			t.Fatalf("InvokePiModel = %+v, %q, %v", outcome, model, err)
		}
		if !strings.Contains(outcome.Output, `"effort":"high"`) {
			t.Fatalf("output = %q; want clamped high effort", outcome.Output)
		}
		commands, _ := os.ReadFile(commandsFile)
		if !strings.Contains(string(commands), "set_thinking_level:high\n") {
			t.Fatalf("commands = %q; want set_thinking_level:high before prompt", commands)
		}
	})

	t.Run("skips set_thinking_level when requested effort is already allowed", func(t *testing.T) {
		commandsFile := filepath.Join(t.TempDir(), "commands")
		outcome, model, err := InvokePiModel(t.Context(), Profile{
			Program: program,
			Env: map[string]string{
				piFakeEnv:    "invoke-clamp",
				piFakeLogEnv: commandsFile,
			},
		}, t.TempDir(), "", "", "hello", "low")
		if err != nil || outcome.Status != statusCompleted || model != "localmodels/Spark-X2.6-4B-Q8_0" {
			t.Fatalf("InvokePiModel = %+v, %q, %v", outcome, model, err)
		}
		if !strings.Contains(outcome.Output, `"effort":"low"`) {
			t.Fatalf("output = %q; want low effort", outcome.Output)
		}
		commands, _ := os.ReadFile(commandsFile)
		if strings.Contains(string(commands), "set_thinking_level") {
			t.Fatalf("unexpected set_thinking_level RPC when effort already allowed: %q", commands)
		}
	})
}
