package agentconnectedapps

import (
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/custommcp"
)

func TestRankCustomMCPToolsFindsMultiWordAndLateExactMatches(t *testing.T) {
	tools := make([]custommcp.Tool, 0, 200)
	for range 199 {
		tools = append(tools, custommcp.Tool{Name: "list_issues", Description: "List project issues"})
	}
	tools = append(tools, custommcp.Tool{Name: "create_issue", Description: "Creates a new issue"})
	for _, query := range []string{"create an issue", "create_issue"} {
		found := rankCustomMCPTools(tools, "Example", query)
		if len(found) == 0 || found[0].Name != "create_issue" {
			t.Fatalf("search for %q did not prioritize the last tool", query)
		}
	}
}
