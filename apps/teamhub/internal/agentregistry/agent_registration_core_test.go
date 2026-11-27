package agentregistry

import (
	"testing"

	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func TestWritableWorkspaceGrantExists(t *testing.T) {
	grants := []byte(`[{"grant_id":"grant_write","mode":"workspace-write"},{"grant_id":"grant_read","mode":"read-only"}]`)
	cases := []struct {
		name    string
		raw     []byte
		grantID string
		want    bool
	}{
		{name: "writable grant", raw: grants, grantID: "grant_write", want: true},
		{name: "read-only grant", raw: grants, grantID: "grant_read"},
		{name: "unknown grant", raw: grants, grantID: "grant_other"},
		{name: "empty grant ID", raw: grants},
		{name: "malformed grants", raw: []byte(`{`), grantID: "grant_write"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := writableWorkspaceGrantExists(tc.raw, tc.grantID); got != tc.want {
				t.Fatalf("writableWorkspaceGrantExists=%v want %v", got, tc.want)
			}
		})
	}
}

func TestNormalizeAgentSkillRegistrationsSortsAndRejectsDuplicates(t *testing.T) {
	skills, err := NormalizeAgentSkillRegistrations([]httpapi.AgentSkillRegistration{
		{Name: " taste ", SkillId: "simplexai_taste", ManifestVersion: "1.0.0"},
		{Name: "impeccable", SkillId: "simplexai_impeccable", ManifestVersion: "1.0.0"},
	})
	if err != nil {
		t.Fatalf("normalize Skills: %v", err)
	}
	if skills[0].SkillId != "simplexai_impeccable" || skills[1].Name != "taste" {
		t.Fatalf("unexpected normalization: %+v", skills)
	}
	if _, err := NormalizeAgentSkillRegistrations([]httpapi.AgentSkillRegistration{
		{Name: "a", SkillId: "simplexai_taste", ManifestVersion: "1.0.0"},
		{Name: "b", SkillId: "simplexai_taste", ManifestVersion: "1.0.0"},
	}); err == nil {
		t.Fatal("want duplicate skill_id rejected")
	}
}
