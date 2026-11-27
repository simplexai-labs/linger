package agentregistry

import (
	"io/fs"
	"strings"
	"testing"

	builtinskills "github.com/simplexai-labs/linger/skills"
)

func TestStarterAgentsDecodeAndValidate(t *testing.T) {
	agents, err := starterAgents()
	if err != nil {
		t.Fatal(err)
	}
	if len(agents) != 2 || agents[0].Name != "Research Analyst" || agents[1].Name != "Code Reviewer" {
		t.Fatalf("starter Agents=%+v", agents)
	}
	catalog, err := fs.ReadFile(builtinskills.FS, "builtin/catalog.yaml")
	if err != nil {
		t.Fatal(err)
	}
	for _, agent := range agents {
		for _, skillID := range agent.SkillIDs {
			// A Skill missing from the catalog would be dropped silently at creation.
			if !strings.Contains(string(catalog), "skill_id: "+skillID+"\n") {
				t.Fatalf("%s binds %q, which is not a built-in Skill", agent.Name, skillID)
			}
		}
	}
}

func TestDecodeStarterAgentRejectsWhatAgentCreationRejects(t *testing.T) {
	for name, encoded := range map[string]string{
		"unknown field":      `{"name":"A","instructions":"Work.","skill_bindings":[]}`,
		"empty name":         `{"name":" ","instructions":"Work."}`,
		"empty instructions": `{"name":"A","instructions":""}`,
		"long name":          `{"name":"` + strings.Repeat("x", MaxNameRunes+1) + `","instructions":"Work."}`,
		"bad avatar":         `{"name":"A","instructions":"Work.","avatar_key":"has space"}`,
		"repeated Skill":     `{"name":"A","instructions":"Work.","skill_ids":["simplexai_taste","simplexai_taste"]}`,
		"empty Skill":        `{"name":"A","instructions":"Work.","skill_ids":[""]}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeStarterAgent([]byte(encoded)); err == nil {
				t.Fatal("want the definition rejected")
			}
		})
	}
	agent, err := decodeStarterAgent([]byte(`{"name":" A ","instructions":" Work. ","avatar_key":"orb-teal"}`))
	if err != nil || agent.Name != "A" || agent.Instructions != "Work." {
		t.Fatalf("agent=%+v err=%v", agent, err)
	}
}
