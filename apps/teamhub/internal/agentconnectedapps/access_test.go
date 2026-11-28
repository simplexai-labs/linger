package agentconnectedapps

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/permissionreview"
)

// recordingProvider serves one tool and records every execution.
type recordingProvider struct {
	fakeToolProvider
	tool     composio.Tool
	executed []string
}

func (provider *recordingProvider) GetTool(context.Context, string, string) (composio.Tool, error) {
	return provider.tool, nil
}

func (provider *recordingProvider) ExecuteTool(_ context.Context, _, _, slug, _ string, _ map[string]any) (composio.ToolExecution, error) {
	provider.executed = append(provider.executed, slug)
	return composio.ToolExecution{Successful: true, Data: map[string]any{"id": "sent"}}, nil
}

func executeForTestWithPolicy(t *testing.T, tTool composio.Tool, policy string, arguments map[string]any) (*recordingProvider, Result, error) {
	t.Helper()
	provider := &recordingProvider{tool: tTool}
	connection := externalsource.AgentToolConnection{
		ID: "connection-1", AppKey: tTool.Toolkit.Slug, ToolkitSlug: tTool.Toolkit.Slug, DisplayName: "Work",
		IdentityLabel: "alice@example.test", UpstreamConnectionID: "ca-1", UserID: "owner",
		WritePolicy: policy,
	}
	result, err := (&Service{provider: provider}).execute(t.Context(), ExecuteInput{
		ConnectionID: connection.ID, ToolSlug: tTool.Slug, ToolVersion: provider.tool.Version, Arguments: arguments,
	}, func(context.Context) (externalsource.AgentToolConnection, error) { return connection, nil })
	return provider, result, err
}

func executeForTest(t *testing.T, slug, toolkit string, arguments map[string]any) (*recordingProvider, Result, error) {
	t.Helper()
	return executeForTestWithPolicy(t, tool(slug, toolkit), externalsource.WritePolicyAuto, arguments)
}

// The host hook judges `teamhub apps execute` before the call reaches
// TeamHub. With the permission reviewer configured (as in .env.example) its
// model may allow a send; without one the hook allows every call. In both
// configurations the generic execute used to send the mail at once, without
// the card `teamhub gmail send` needs, so Execute must hold it either way.
func TestExecuteHoldsAGenericSendWhateverTheHostReviewerAllowed(t *testing.T) {
	configurations := map[string]func() (permissionreview.Outcome, error){
		// A stand-in for the judge model's verdict; the real review needs a
		// live Context in the database.
		"reviewer allows": func() (permissionreview.Outcome, error) {
			return permissionreview.Outcome{Decision: permissionreview.DecisionAllow}, nil
		},
		"no reviewer": func() (permissionreview.Outcome, error) {
			return (&permissionreview.Service{}).Review(t.Context(), permissionreview.ReviewInput{
				Action: permissionreview.Action{Tool: "Bash", Command: "teamhub apps execute --toolSlug GMAIL_SEND_EMAIL"},
			})
		},
	}
	for name, review := range configurations {
		outcome, err := review()
		if err != nil || outcome.Decision != permissionreview.DecisionAllow {
			t.Fatalf("%s: host review=%+v err=%v", name, outcome, err)
		}
		provider, held, err := executeForTest(t, "GMAIL_SEND_EMAIL", "gmail", map[string]any{
			"recipient_email": "bob@example.test", "subject": "Hi", "body": "Hello",
		})
		if err != nil || held.Confirmation == nil || len(provider.executed) != 0 {
			t.Fatalf("%s: GMAIL_SEND_EMAIL ran without confirmation: result=%+v err=%v executed=%v", name, held, err, provider.executed)
		}
	}
}

func TestExecuteHoldsAWriteForTheSponsorsCard(t *testing.T) {
	provider, held, err := executeForTest(t, "GMAIL_SEND_EMAIL", "gmail", map[string]any{
		"recipient_email": "bob@example.test", "subject": "Hi", "body": "Hello",
	})
	if err != nil || held.Confirmation == nil || held.Data != nil {
		t.Fatalf("result=%+v err=%v", held, err)
	}
	if card := held.Confirmation.Card; card.Title != "Send an email to bob@example.test" || card.Account != "alice@example.test" ||
		card.Message == nil || card.Message.Subject != "Hi" {
		t.Fatalf("card=%+v", card)
	}
	if held.Confirmation.Connection.ID != "connection-1" || len(held.Confirmation.Action) == 0 || held.Confirmation.Digest == "" {
		t.Fatalf("confirmation=%+v", held.Confirmation)
	}
	if len(provider.executed) != 0 {
		t.Fatalf("executed=%v", provider.executed)
	}
}

func TestExecuteRunsReadsAndDirectWritesAtOnce(t *testing.T) {
	for _, slug := range []string{"GMAIL_FETCH_EMAILS", "GMAIL_CREATE_EMAIL_DRAFT"} {
		provider, ran, err := executeForTest(t, slug, "gmail", map[string]any{})
		if err != nil || ran.Confirmation != nil || len(provider.executed) != 1 || provider.executed[0] != slug {
			t.Fatalf("%s: result=%+v err=%v executed=%v", slug, ran, err, provider.executed)
		}
		if data, _ := ran.Data.(map[string]any); data["id"] != "sent" {
			t.Fatalf("%s: data=%+v", slug, ran.Data)
		}
	}
}

// Finding recent direct messages has no wrapped command; the generic execute
// lists them without a card for each read.
func TestExecuteRunsSlackDirectMessageReadsAtOnce(t *testing.T) {
	for _, slug := range []string{
		"SLACK_LIST_CONVERSATIONS", "SLACK_LIST_ALL_USERS", "SLACK_FIND_USERS",
		"SLACK_GET_UNREAD_MESSAGES_FROM_USER", "SLACK_LIST_UNREAD_CHANNEL_MESSAGES",
	} {
		provider, ran, err := executeForTest(t, slug, "slack", map[string]any{})
		if err != nil || ran.Confirmation != nil || len(provider.executed) != 1 {
			t.Fatalf("%s: result=%+v err=%v executed=%v", slug, ran, err, provider.executed)
		}
	}
}

func TestExecuteHoldsAToolTeamHubDoesNotKnow(t *testing.T) {
	provider, held, err := executeForTest(t, "GITHUB_STAR_A_REPOSITORY_FOR_THE_AUTHENTICATED_USER", "github", map[string]any{"owner": "acme", "repo": "api"})
	if err != nil || held.Confirmation == nil || len(provider.executed) != 0 {
		t.Fatalf("result=%+v err=%v executed=%v", held, err, provider.executed)
	}
	if card := held.Confirmation.Card; card.Title != "Run GITHUB_STAR_A_REPOSITORY_FOR_THE_AUTHENTICATED_USER" || card.Kind != "change" || card.Input == "" {
		t.Fatalf("card=%+v", card)
	}
}

// The reads `teamhub github` makes run at once; before they were listed, a
// profile Task reading the delegated account got a card for every read.
func TestExecuteRunsGitHubReadsAtOnce(t *testing.T) {
	for _, slug := range []string{
		"GITHUB_GET_THE_AUTHENTICATED_USER", "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
		"GITHUB_GET_A_REPOSITORY", "GITHUB_GET_A_REPOSITORY_README", "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS",
		"GITHUB_GET_AN_ISSUE", "GITHUB_LIST_ISSUE_COMMENTS", "GITHUB_GET_A_PULL_REQUEST", "GITHUB_LIST_PULL_REQUESTS_FILES",
	} {
		provider, ran, err := executeForTest(t, slug, "github", map[string]any{})
		if err != nil || ran.Confirmation != nil || len(provider.executed) != 1 {
			t.Fatalf("%s: result=%+v err=%v executed=%v", slug, ran, err, provider.executed)
		}
	}
}

// Linear has no wrapped command, so Agents read it through the generic
// execute; each listed read runs without a card.
func TestExecuteRunsLinearReadsAtOnce(t *testing.T) {
	for _, slug := range []string{
		"LINEAR_LIST_LINEAR_PROJECTS", "LINEAR_LIST_LINEAR_ISSUES", "LINEAR_LIST_LINEAR_USERS",
		"LINEAR_GET_LINEAR_ISSUE", "LINEAR_SEARCH_ISSUES", "LINEAR_LIST_LINEAR_TEAMS",
	} {
		provider, ran, err := executeForTest(t, slug, "linear", map[string]any{})
		if err != nil || ran.Confirmation != nil || len(provider.executed) != 1 {
			t.Fatalf("%s: result=%+v err=%v executed=%v", slug, ran, err, provider.executed)
		}
	}
}

func TestExecuteRunsAReadOnlyLinearGraphQLDocumentAtOnce(t *testing.T) {
	for name, document := range map[string]string{
		"introspection": `query { __type(name: "Team") { fields { name } } }`,
		"shorthand":     `{ viewer { id name } }`,
		"named with variables and a fragment": `
			query Members($team: String!) { team(id: $team) { members { nodes { ...person } } } }
			fragment person on User { id displayName active }`,
		"mutation only inside a string": `query { searchIssues(term: "mutation { issueDelete }") { nodes { id } } }`,
		"two queries":                   `query A { viewer { id } } query B { teams { nodes { id } } }`,
	} {
		provider, ran, err := executeForTest(t, linearGraphQLTool, "linear", map[string]any{"query_or_mutation": document, "variables": map[string]any{}})
		if err != nil || ran.Confirmation != nil || len(provider.executed) != 1 {
			t.Fatalf("%s: result=%+v err=%v executed=%v", name, ran, err, provider.executed)
		}
	}
}

func TestExecuteHoldsALinearGraphQLDocumentThatMayWrite(t *testing.T) {
	for name, arguments := range map[string]map[string]any{
		"mutation":           {"query_or_mutation": `mutation { commentCreate(input: {issueId: "WHI-1", body: "hi"}) { success } }`},
		"query and mutation": {"query_or_mutation": `query A { viewer { id } } mutation B { issueArchive(id: "WHI-1") { success } }`},
		"subscription":       {"query_or_mutation": `subscription { issueUpdated { id } }`},
		"commented keyword":  {"query_or_mutation": "# query\nmutation { issueArchive(id: \"WHI-1\") { success } }"},
		"unparseable":        {"query_or_mutation": `query { viewer { id }`},
		"fragment only":      {"query_or_mutation": `fragment person on User { id }`},
		"not a string":       {"query_or_mutation": map[string]any{"query": "{ viewer { id } }"}},
		"missing document":   {"query": `{ viewer { id } }`},
	} {
		provider, held, err := executeForTest(t, linearGraphQLTool, "linear", arguments)
		if err != nil || held.Confirmation == nil || len(provider.executed) != 0 {
			t.Fatalf("%s: result=%+v err=%v executed=%v", name, held, err, provider.executed)
		}
	}
}

func TestExecuteHoldsLinearWritesForTheSponsorsCard(t *testing.T) {
	for _, slug := range []string{"LINEAR_CREATE_LINEAR_ISSUE", "LINEAR_CREATE_LINEAR_COMMENT", "LINEAR_UPDATE_ISSUE"} {
		provider, held, err := executeForTest(t, slug, "linear", map[string]any{"issue_id": "WHI-1", "body": "hi"})
		if err != nil || held.Confirmation == nil || len(provider.executed) != 0 {
			t.Fatalf("%s: result=%+v err=%v executed=%v", slug, held, err, provider.executed)
		}
	}
}

// cardTools are the final writes of the CLI's "confirm" commands. The
// generic execute and the wrapped commands must both hold them.
var cardTools = []string{
	"GMAIL_SEND_EMAIL", "GMAIL_SEND_DRAFT", "GMAIL_REPLY_TO_THREAD",
	"OUTLOOK_SEND_EMAIL", "OUTLOOK_SEND_DRAFT",
	"SLACK_SEND_MESSAGE", "SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK",
	"NOTION_UPDATE_PAGE_MARKDOWN",
	"GITHUB_CREATE_AN_ISSUE", "GITHUB_CREATE_AN_ISSUE_COMMENT",
}

// Creating or appending to a Notion page adds content that page history can
// undo, so it runs at once on auto; an edit replaces content and still waits
// for the card.
func TestAccessRunsAdditiveNotionWritesAtOnce(t *testing.T) {
	for _, slug := range []string{"NOTION_CREATE_NOTION_PAGE", "NOTION_ADD_MULTIPLE_PAGE_CONTENT"} {
		if classifyTool(tool(slug, "notion"), nil) != tierDirectWrite {
			t.Errorf("%s must classify as tierDirectWrite", slug)
		}
	}
	if classifyTool(tool("NOTION_UPDATE_PAGE_MARKDOWN", "notion"), nil) != tierWorkspaceWrite {
		t.Error("NOTION_UPDATE_PAGE_MARKDOWN replaces content and must classify as tierWorkspaceWrite")
	}
}

func TestAccessListsKeepConfirmedWritesHeld(t *testing.T) {
	for _, slug := range cardTools {
		tier := classifyTool(tool(slug, "gmail"), nil)
		if tier != tierConfirmStrict && tier != tierWorkspaceWrite {
			t.Errorf("%s must wait for confirmation, got tier=%v", slug, tier)
		}
	}
	for slug := range readTools {
		if directWriteTools[slug] {
			t.Errorf("%s is both a read and a direct write", slug)
		}
	}
	for _, slug := range []string{"GMAIL_GET_DRAFT", "OUTLOOK_GET_MESSAGE", "OUTLOOK_LIST_OUTLOOK_ATTACHMENTS"} {
		if classifyTool(tool(slug, "gmail"), nil) != tierReadOnly {
			t.Errorf("%s reads a draft for its card and must run at once", slug)
		}
	}
}

func TestAccessRunsDiscordReadsAndHoldsDiscordSends(t *testing.T) {
	for _, slug := range []string{"DISCORDBOT_GET_CONNECTED_GUILD", "DISCORDBOT_LIST_MESSAGES", "DISCORDBOT_LIST_PINNED_MESSAGES"} {
		if classifyTool(tool(slug, "discordbot"), nil) != tierReadOnly {
			t.Errorf("%s only reads the connected guild and must run at once", slug)
		}
	}
	if classifyTool(tool("DISCORDBOT_CREATE_MESSAGE", "discordbot"), nil) != tierConfirmStrict {
		t.Error("DISCORDBOT_CREATE_MESSAGE posts to Discord and must be tierConfirmStrict")
	}
}

func TestExecuteRunsOutlookCalendarReadsAndDirectWritesAtOnce(t *testing.T) {
	readSlugs := []string{
		"OUTLOOK_LIST_CALENDARS",
		"OUTLOOK_GET_MAILBOX_SETTINGS",
		"OUTLOOK_GET_CALENDAR_VIEW",
		"OUTLOOK_LIST_EVENTS",
		"OUTLOOK_GET_EVENT",
		"OUTLOOK_GET_CALENDAR_EVENT",
		"OUTLOOK_GET_CALENDAR_SCHEDULE",
	}
	for _, slug := range readSlugs {
		if classifyTool(tool(slug, "outlook"), nil) != tierReadOnly {
			t.Errorf("%s must be classified as tierReadOnly", slug)
		}
		provider, ran, err := executeForTest(t, slug, "outlook", map[string]any{})
		if err != nil || ran.Confirmation != nil || len(provider.executed) != 1 {
			t.Fatalf("%s: result=%+v err=%v executed=%v", slug, ran, err, provider.executed)
		}
	}
	writeSlugs := []string{
		"OUTLOOK_CALENDAR_CREATE_EVENT",
		"OUTLOOK_UPDATE_CALENDAR_EVENT",
		"OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR",
		"OUTLOOK_CANCEL_EVENT",
		"OUTLOOK_CANCEL_CALENDAR_EVENT",
		"OUTLOOK_DELETE_CALENDAR_EVENT",
		"OUTLOOK_DELETE_CALENDAR_EVENT_FROM_SPECIFIC_CALENDAR",
	}
	for _, slug := range writeSlugs {
		if classifyTool(tool(slug, "outlook"), nil) != tierDirectWrite {
			t.Errorf("%s must be classified as tierDirectWrite", slug)
		}
		provider, ran, err := executeForTest(t, slug, "outlook", map[string]any{})
		if err != nil || ran.Confirmation != nil || len(provider.executed) != 1 {
			t.Fatalf("%s: result=%+v err=%v executed=%v", slug, ran, err, provider.executed)
		}
	}
}

func TestClassifyToolAnnotationsVerbsAndWritePolicies(t *testing.T) {
	boolPtr := func(v bool) *bool { return &v }

	// Unlisted read-only tools across Linear/GitHub/Notion pass via safe verb fallback.
	for _, tc := range []struct {
		slug, toolkit string
		want          toolTier
	}{
		{"LINEAR_LIST_WORKFLOW_STATES", "linear", tierReadOnly},
		{"GITHUB_LIST_REPOSITORY_BRANCHES", "github", tierReadOnly},
		{"NOTION_QUERY_DATABASE", "notion", tierReadOnly},
		{"GITHUB_GET_REPOSITORY_CONTENT", "github", tierReadOnly},
		{"LINEAR_FIND_OR_CREATE_ISSUE", "linear", tierWorkspaceWrite},
		{"LINEAR_CREATE_ISSUE", "linear", tierWorkspaceWrite},
		{"LINEAR_DELETE_ISSUE", "linear", tierConfirmStrict},
		{"GITHUB_MERGE_A_PULL_REQUEST", "github", tierConfirmStrict},
		{"GITHUB_FORCE_PUSH_BRANCH", "github", tierConfirmStrict},
		{"GMAIL_SEND_EMAIL", "gmail", tierConfirmStrict},
		{"SLACK_SEND_MESSAGE", "slack", tierConfirmStrict},
		{"SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK", "slack", tierConfirmStrict},
	} {
		if got := classifyTool(tool(tc.slug, tc.toolkit), nil); got != tc.want {
			t.Errorf("classifyTool(%s) = %v, want %v", tc.slug, got, tc.want)
		}
	}

	// Composio annotations: readOnlyHint promotes an unknown verb to read-only,
	// while destructiveHint=true always overrides readOnlyHint=true.
	annotatedRead := tool("LINEAR_INTROSPECT_SCHEMA", "linear")
	annotatedRead.Annotations = &composio.ToolAnnotations{ReadOnlyHint: boolPtr(true)}
	if got := classifyTool(annotatedRead, nil); got != tierReadOnly {
		t.Fatalf("readOnlyHint tool = %v, want tierReadOnly", got)
	}
	destructiveOverride := tool("LINEAR_INTROSPECT_SCHEMA", "linear")
	destructiveOverride.Annotations = &composio.ToolAnnotations{
		ReadOnlyHint:    boolPtr(true),
		DestructiveHint: boolPtr(true),
	}
	if got := classifyTool(destructiveOverride, nil); got != tierConfirmStrict {
		t.Fatalf("destructive override = %v, want tierConfirmStrict", got)
	}

	// Policy gating on workspace writes: auto -> card with can_remember=true;
	// always_allow -> runs immediately; always_ask -> card with can_remember=false.
	issueTool := tool("LINEAR_CREATE_ISSUE", "linear")
	issueArgs := map[string]any{"team_id": "ENG", "title": "Fix bug", "description": "Details"}
	pAuto, resAuto, err := executeForTestWithPolicy(t, issueTool, externalsource.WritePolicyAuto, issueArgs)
	if err != nil || resAuto.Confirmation == nil || !resAuto.Confirmation.Card.CanRemember || len(pAuto.executed) != 0 {
		t.Fatalf("auto workspace write: res=%+v err=%v executed=%v", resAuto, err, pAuto.executed)
	}
	if resAuto.Confirmation.Card.Title != "Create Linear issue: Fix bug" {
		t.Fatalf("unexpected Linear card title: %q", resAuto.Confirmation.Card.Title)
	}
	pAllow, resAllow, err := executeForTestWithPolicy(t, issueTool, externalsource.WritePolicyAlwaysAllow, issueArgs)
	if err != nil || resAllow.Confirmation != nil || len(pAllow.executed) != 1 {
		t.Fatalf("always_allow workspace write: res=%+v err=%v executed=%v", resAllow, err, pAllow.executed)
	}
	pAsk, resAsk, err := executeForTestWithPolicy(t, issueTool, externalsource.WritePolicyAlwaysAsk, issueArgs)
	if err != nil || resAsk.Confirmation == nil || resAsk.Confirmation.Card.CanRemember || len(pAsk.executed) != 0 {
		t.Fatalf("always_ask workspace write: res=%+v err=%v executed=%v", resAsk, err, pAsk.executed)
	}

	// Strict confirm tools NEVER run automatically and NEVER offer can_remember,
	// even when write_policy is always_allow.
	sendTool := tool("GMAIL_SEND_EMAIL", "gmail")
	pStrict, resStrict, err := executeForTestWithPolicy(t, sendTool, externalsource.WritePolicyAlwaysAllow, map[string]any{
		"recipient_email": "bob@example.test", "subject": "Hi", "body": "Hello",
	})
	if err != nil || resStrict.Confirmation == nil || resStrict.Confirmation.Card.CanRemember || len(pStrict.executed) != 0 {
		t.Fatalf("strict confirm under always_allow: res=%+v err=%v executed=%v", resStrict, err, pStrict.executed)
	}

	// Direct writes are held under always_ask without remember.
	draftTool := tool("GMAIL_CREATE_EMAIL_DRAFT", "gmail")
	pDraftAsk, resDraftAsk, err := executeForTestWithPolicy(t, draftTool, externalsource.WritePolicyAlwaysAsk, map[string]any{})
	if err != nil || resDraftAsk.Confirmation == nil || resDraftAsk.Confirmation.Card.CanRemember || len(pDraftAsk.executed) != 0 {
		t.Fatalf("direct write under always_ask: res=%+v err=%v executed=%v", resDraftAsk, err, pDraftAsk.executed)
	}
}

func TestExecuteRefusesAnUnknownCallTooLargeForItsCard(t *testing.T) {
	provider, held, err := executeForTest(t, "GITHUB_STAR_A_REPOSITORY_FOR_THE_AUTHENTICATED_USER", "github", map[string]any{"repo": strings.Repeat("x", maxCardInput)})
	var domain *Error
	if !errors.As(err, &domain) || domain.Code != "invalid_input" || held.Confirmation != nil || len(provider.executed) != 0 {
		t.Fatalf("result=%+v err=%v executed=%v", held, err, provider.executed)
	}
}
