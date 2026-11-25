package agentregistry

import "testing"

func TestShouldClearAnotherMeBackgroundFailures(t *testing.T) {
	tests := []struct {
		name               string
		agentType          string
		currentComputerID  string
		currentRuntimeType string
		currentModel       string
		nextComputerID     string
		nextRuntimeType    string
		nextModel          string
		want               bool
	}{
		{
			name:               "non-anotherme never clears",
			agentType:          "general",
			currentComputerID:  "comp-1",
			currentRuntimeType: "antigravity",
			currentModel:       "gemini-4-neon",
			nextComputerID:     "comp-1",
			nextRuntimeType:    "codex",
			nextModel:          "gpt-5",
			want:               false,
		},
		{
			name:               "unchanged target keeps failure streak",
			agentType:          "anotherme",
			currentComputerID:  "comp-1",
			currentRuntimeType: "codex",
			currentModel:       "gpt-5",
			nextComputerID:     "comp-1",
			nextRuntimeType:    "codex",
			nextModel:          "gpt-5",
			want:               false,
		},
		{
			name:               "runtime switch clears failure streak",
			agentType:          "anotherme",
			currentComputerID:  "comp-1",
			currentRuntimeType: "antigravity",
			currentModel:       "gemini-4-neon",
			nextComputerID:     "comp-1",
			nextRuntimeType:    "codex",
			nextModel:          "gpt-5",
			want:               true,
		},
		{
			name:               "model change on same runtime clears failure streak",
			agentType:          "anotherme",
			currentComputerID:  "comp-1",
			currentRuntimeType: "codex",
			currentModel:       "gpt-5-old",
			nextComputerID:     "comp-1",
			nextRuntimeType:    "codex",
			nextModel:          "gpt-5-new",
			want:               true,
		},
		{
			name:               "computer move clears failure streak",
			agentType:          "anotherme",
			currentComputerID:  "comp-1",
			currentRuntimeType: "codex",
			currentModel:       "gpt-5",
			nextComputerID:     "comp-2",
			nextRuntimeType:    "codex",
			nextModel:          "gpt-5",
			want:               true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := shouldClearAnotherMeBackgroundFailures(
				tc.agentType,
				tc.currentComputerID, tc.currentRuntimeType, tc.currentModel,
				tc.nextComputerID, tc.nextRuntimeType, tc.nextModel,
			)
			if got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}
