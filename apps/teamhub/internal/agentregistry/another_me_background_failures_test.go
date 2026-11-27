package agentregistry

import "testing"

func TestShouldClearAnotherMeBackgroundFailures(t *testing.T) {
	base := anotherMeRuntimeTarget{
		computerID:       "comp-1",
		runtimeType:      "codex",
		workspaceGrantID: "grant-1",
		model:            "gpt-5",
		reasoningEffort:  "medium",
	}
	tests := []struct {
		name      string
		agentType string
		current   anotherMeRuntimeTarget
		next      anotherMeRuntimeTarget
		want      bool
	}{
		{
			name:      "non-anotherme never clears",
			agentType: "general",
			current: anotherMeRuntimeTarget{
				computerID:       "comp-1",
				runtimeType:      "antigravity",
				workspaceGrantID: "grant-1",
				model:            "gemini-4-neon",
				reasoningEffort:  "medium",
			},
			next: base,
			want: false,
		},
		{
			name:      "unchanged target keeps failure streak",
			agentType: "anotherme",
			current:   base,
			next:      base,
			want:      false,
		},
		{
			name:      "runtime switch clears failure streak",
			agentType: "anotherme",
			current: anotherMeRuntimeTarget{
				computerID:       "comp-1",
				runtimeType:      "antigravity",
				workspaceGrantID: "grant-1",
				model:            "gemini-4-neon",
				reasoningEffort:  "medium",
			},
			next: base,
			want: true,
		},
		{
			name:      "model change on same runtime clears failure streak",
			agentType: "anotherme",
			current:   base,
			next: anotherMeRuntimeTarget{
				computerID:       "comp-1",
				runtimeType:      "codex",
				workspaceGrantID: "grant-1",
				model:            "gpt-5-new",
				reasoningEffort:  "medium",
			},
			want: true,
		},
		{
			name:      "computer move clears failure streak",
			agentType: "anotherme",
			current:   base,
			next: anotherMeRuntimeTarget{
				computerID:       "comp-2",
				runtimeType:      "codex",
				workspaceGrantID: "grant-1",
				model:            "gpt-5",
				reasoningEffort:  "medium",
			},
			want: true,
		},
		{
			name:      "workspace grant change clears failure streak",
			agentType: "anotherme",
			current:   base,
			next: anotherMeRuntimeTarget{
				computerID:       "comp-1",
				runtimeType:      "codex",
				workspaceGrantID: "grant-2",
				model:            "gpt-5",
				reasoningEffort:  "medium",
			},
			want: true,
		},
		{
			name:      "reasoning effort change clears failure streak",
			agentType: "anotherme",
			current:   base,
			next: anotherMeRuntimeTarget{
				computerID:       "comp-1",
				runtimeType:      "codex",
				workspaceGrantID: "grant-1",
				model:            "gpt-5",
				reasoningEffort:  "high",
			},
			want: true,
		},
		{
			name:      "clearing reasoning effort clears failure streak",
			agentType: "anotherme",
			current: anotherMeRuntimeTarget{
				computerID:       "comp-1",
				runtimeType:      "codex",
				workspaceGrantID: "grant-1",
				model:            "gpt-5",
				reasoningEffort:  "high",
			},
			next: anotherMeRuntimeTarget{
				computerID:       "comp-1",
				runtimeType:      "codex",
				workspaceGrantID: "grant-1",
				model:            "gpt-5",
				reasoningEffort:  "",
			},
			want: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := shouldClearAnotherMeBackgroundFailures(tc.agentType, tc.current, tc.next)
			if got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}
