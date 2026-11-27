package lingercontext

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/registration"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

func TestAuthorizedClaudeSkillsUseOnlyPublishedSkillRoots(t *testing.T) {
	names := authorizedClaudeSkillNames([]Mapping{
		{Kind: "skills", TargetPath: ".agents/skills", Access: "read_only", Files: []FileInput{{RelativePath: "approved/SKILL.md"}, {RelativePath: "approved/helper.sh"}, {RelativePath: "approved/nested/SKILL.md"}}},
		{Kind: "documents", TargetPath: ".agents/skills", Access: "read_only", Files: []FileInput{{RelativePath: "document/SKILL.md"}}},
		{Kind: "skills", TargetPath: "playground", Access: "read_only", Files: []FileInput{{RelativePath: "other/SKILL.md"}}},
		{Kind: "skills", TargetPath: ".agents/skills", Access: "read_write", Files: []FileInput{{RelativePath: "local/SKILL.md"}}},
	})
	if !reflect.DeepEqual(names, []string{"approved"}) {
		t.Fatalf("unexpected authorized skills: %v", names)
	}
}

// testContextViews resolves every Context to one workspace and authorizes no
// Claude Skills.
type testContextViews struct{ root string }

func (v testContextViews) ValidatedView(context.Context, string, json.RawMessage) (ViewRecord, error) {
	return ViewRecord{WorkspacePath: v.root}, nil
}

func TestExecutionResolverUsesOnlyLocalPathsAndEnvironment(t *testing.T) {
	resolver := ExecutionResolver{
		Providers: map[string]ProviderInstallation{
			"codex": {
				Type: "codex", ExecutablePath: "/local/bin/codex", Environment: map[string]string{"PATH": "/local/bin"},
				ContextWindows: map[string]int{"gpt-5": 272000, "local-small": 64896},
			},
		},
		WorkspaceGrants: map[string]WorkspaceGrant{
			"grant-local": {GrantID: "grant-local", TenantID: "tenant-acme", Path: "/local/workspace"},
		},
		Views: testContextViews{root: "/local/workspace"},
		Registrations: map[string]RegistrationBinding{
			"registration-codex": {RegistrationID: "registration-codex", TenantID: "tenant-acme", OwnerActorID: "actor-alice", ProviderType: "codex", Status: registration.StatusOnline},
		},
	}
	request := json.RawMessage(`{
		"kind":"run.start",
		"runtime":{"type":"codex","model":"gpt-5","reasoning_effort":"xhigh"},
		"session_options":{"thread_name":"Reviewer","base_instructions":"Base","developer_instructions":"Developer"},
		"session":{"thread_id":"thread-1"},
		"input":{"type":"text","text":"Review this"},
		"run_context":{"execution_run_ref":"run-123"},
		"run_resources":{"mcp_servers":[{"name":"teamhub","relay_url":"https://relay.test/mcp","relay_token":"secret","tool_names":[],"expires_at":"2026-09-02T10:00:00Z"}]},
		"executable_path":"/remote/evil",
		"working_directory":"/remote/evil",
		"environment":{"TOKEN":"secret"}
	}`)
	spec, err := resolver.Resolve(context.Background(), protocol.Command{
		TenantID: "tenant-acme", RegistrationID: "registration-codex", AssignmentRevision: 2,
		WorkspaceGrantID: "grant-local", RuntimeType: "codex", HostAccess: "trusted", OperationID: "operation-456",
		ContextViewRef: json.RawMessage(`{"receipt_ref":"receipt-1"}`),
	}, request)
	if err != nil {
		t.Fatal(err)
	}
	if spec.ExecutablePath != "/local/bin/codex" || spec.WorkingDirectory != "/local/workspace" || spec.Environment["TOKEN"] != "" {
		t.Fatalf("resolver accepted remote execution authority: %+v", spec)
	}
	if spec.Prompt != "Review this" || spec.ResumeSessionID != "thread-1" || spec.ThinkingLevel != "xhigh" ||
		spec.ContextWindow != 272000 || spec.ExecutionRunRef != "run-123" ||
		spec.SystemPrompt != "Base\n\nDeveloper\n\n"+trustedHostServiceInstructions+"\n\n"+boundServiceInstructions(nil) ||
		string(spec.MCPRelays) == "" {
		t.Fatalf("semantic request was not preserved: %+v", spec)
	}
}

func TestExecutionResolverAddsCodexLocalDefaults(t *testing.T) {
	resolver := ExecutionResolver{
		Providers:       map[string]ProviderInstallation{"codex": {Type: "codex", ExecutablePath: "/local/bin/codex"}, "claude": {Type: "claude", ExecutablePath: "/local/bin/claude"}},
		WorkspaceGrants: map[string]WorkspaceGrant{"grant-local": {GrantID: "grant-local", TenantID: "tenant-acme", Path: "/local/workspace"}},
		Views:           testContextViews{root: "/local/workspace"},
		Registrations: map[string]RegistrationBinding{
			"registration-codex":  {RegistrationID: "registration-codex", TenantID: "tenant-acme", OwnerActorID: "actor-alice", ProviderType: "codex", Status: registration.StatusOnline},
			"registration-claude": {RegistrationID: "registration-claude", TenantID: "tenant-acme", OwnerActorID: "actor-alice", ProviderType: "claude", Status: registration.StatusOnline},
		},
	}
	codex, err := resolver.Resolve(context.Background(), protocol.Command{
		TenantID: "tenant-acme", RegistrationID: "registration-codex", AssignmentRevision: 1,
		WorkspaceGrantID: "grant-local", RuntimeType: "codex", ContextViewRef: json.RawMessage(`{"receipt_ref":"receipt-1"}`),
	}, json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex","model":"gpt-5"},"session":{"threadId":"thread-1"},"input":{"type":"text","text":"Go"}}`))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--config", `model_reasoning_summary="auto"`, "--config", "hide_agent_reasoning=false"}
	if !reflect.DeepEqual(codex.ExtraArgs, want) {
		t.Fatalf("codex ExtraArgs = %v, want %v", codex.ExtraArgs, want)
	}

	claude, err := resolver.Resolve(context.Background(), protocol.Command{
		TenantID: "tenant-acme", RegistrationID: "registration-claude", AssignmentRevision: 1,
		WorkspaceGrantID: "grant-local", RuntimeType: "claude",
		ExecutionContextKey: "context-1", ContextViewRef: json.RawMessage(`{"receipt_ref":"receipt-1"}`),
	}, json.RawMessage(`{"kind":"run.start","runtime":{"type":"claude","model":"claude-sonnet-5"},"session":{},"input":{"type":"text","text":"Go"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(claude.ExtraArgs) != 0 {
		t.Fatalf("Codex-only defaults leaked into %s: %v", claude.Provider, claude.ExtraArgs)
	}
}

func TestExecutionResolverRejectsAssignmentAndScopeMismatch(t *testing.T) {
	resolver := ExecutionResolver{}
	if _, err := resolver.Resolve(context.Background(), protocol.Command{}, json.RawMessage(`{}`)); err == nil {
		t.Fatal("Operation without Assignment was accepted")
	}
}

func TestExecutionResolverRequiresExplicitCodexFirstRunMarker(t *testing.T) {
	resolver := ExecutionResolver{
		Providers:       map[string]ProviderInstallation{"codex": {Type: "codex", ExecutablePath: "/local/bin/codex"}},
		WorkspaceGrants: map[string]WorkspaceGrant{"grant-local": {GrantID: "grant-local", TenantID: "tenant-acme", Path: "/local/workspace"}},
		Views:           testContextViews{root: "/local/workspace"},
		Registrations:   map[string]RegistrationBinding{"registration-codex": {RegistrationID: "registration-codex", TenantID: "tenant-acme", OwnerActorID: "actor-alice", ProviderType: "codex", Status: registration.StatusOnline}},
	}
	command := protocol.Command{TenantID: "tenant-acme", RegistrationID: "registration-codex", AssignmentRevision: 1, WorkspaceGrantID: "grant-local", RuntimeType: "codex",
		ContextViewRef: json.RawMessage(`{"receipt_ref":"receipt-1"}`)}
	for _, session := range []string{`{}`, `{"threadId":null}`, `{"threadId":""}`, `{"threadId":"retained"}`} {
		request := json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"session":` + session + `,"input":{"text":"Run"}}`)
		spec, err := resolver.Resolve(context.Background(), command, request)
		accepted := session == `{"threadId":""}` || session == `{"threadId":"retained"}`
		if (err == nil) != accepted {
			t.Fatalf("Session %s admission=%v", session, err)
		}
		if session == `{"threadId":"retained"}` && spec.ResumeSessionID != "retained" {
			t.Fatal("retained Session became a create")
		}
	}
}

func TestExecutionResolverRejectsInactiveRegistration(t *testing.T) {
	for _, status := range []registration.Status{
		registration.StatusOffline, registration.StatusUnavailable,
	} {
		resolver := ExecutionResolver{
			Providers: map[string]ProviderInstallation{
				"codex": {Type: "codex", ExecutablePath: "/local/bin/codex"},
			},
			WorkspaceGrants: map[string]WorkspaceGrant{
				"grant-local": {GrantID: "grant-local", TenantID: "tenant-acme", Path: "/local/workspace"},
			},
			Views: testContextViews{root: "/local/workspace"},
			Registrations: map[string]RegistrationBinding{
				"registration-codex": {
					RegistrationID: "registration-codex", TenantID: "tenant-acme",
					OwnerActorID: "actor-alice", ProviderType: "codex", Status: status,
				},
			},
		}
		_, err := resolver.Resolve(context.Background(), protocol.Command{
			TenantID: "tenant-acme", RegistrationID: "registration-codex", AssignmentRevision: 2,
			WorkspaceGrantID: "grant-local", RuntimeType: "codex",
		}, json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"input":{"text":"Run"}}`))
		if err == nil {
			t.Fatalf("inactive Registration status %q was accepted", status)
		}
	}
}

func TestExecutionResolverRejectsUnknownReasoningEffort(t *testing.T) {
	resolver := ExecutionResolver{
		Providers: map[string]ProviderInstallation{
			"codex": {Type: "codex", ExecutablePath: "/local/bin/codex"},
		},
		WorkspaceGrants: map[string]WorkspaceGrant{
			"grant-local": {GrantID: "grant-local", TenantID: "tenant-acme", Path: "/local/workspace"},
		},
		Views: testContextViews{root: "/local/workspace"},
		Registrations: map[string]RegistrationBinding{
			"registration-codex": {RegistrationID: "registration-codex", TenantID: "tenant-acme", OwnerActorID: "actor-alice", ProviderType: "codex", Status: registration.StatusOnline},
		},
	}
	_, err := resolver.Resolve(context.Background(), protocol.Command{
		TenantID: "tenant-acme", RegistrationID: "registration-codex", AssignmentRevision: 2,
		WorkspaceGrantID: "grant-local", RuntimeType: "codex", ContextViewRef: json.RawMessage(`{"receipt_ref":"receipt-1"}`),
	}, json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex","reasoning_effort":"future"},"input":{"text":"Run"}}`))
	if err == nil {
		t.Fatal("unknown Runtime reasoning effort was accepted")
	}
}

func TestExecutionResolverUsesSessionMarkerState(t *testing.T) {
	for _, runtimeType := range []string{"claude", "pi"} {
		t.Run(runtimeType, func(t *testing.T) {
			resolver := ExecutionResolver{
				Providers: map[string]ProviderInstallation{
					runtimeType: {Type: runtimeType, ExecutablePath: "/local/bin/" + runtimeType},
				},
				WorkspaceGrants: map[string]WorkspaceGrant{
					"grant-local": {GrantID: "grant-local", TenantID: "tenant-acme", Path: "/local/workspace"},
				},
				Views: testContextViews{root: "/local/workspace"},
				Registrations: map[string]RegistrationBinding{
					"registration-claude": {RegistrationID: "registration-claude", TenantID: "tenant-acme", OwnerActorID: "actor-alice", ProviderType: runtimeType, Status: registration.StatusOnline},
				},
			}
			command := protocol.Command{
				TenantID: "tenant-acme", RegistrationID: "registration-claude", AssignmentRevision: 2,
				WorkspaceGrantID: "grant-local", RuntimeType: runtimeType,
				ExecutionContextKey: "context-1", ContextViewRef: json.RawMessage(`{"receipt_ref":"receipt-1"}`),
			}
			request := func(materialized, resumeAfterYield bool) json.RawMessage {
				return json.RawMessage(fmt.Sprintf(`{
			"kind":"run.start","runtime":{"type":%q},
			"session_options":{"thread_name":"Claude"},
			"session":{"provider":%q,"sessionId":"123e4567-e89b-12d3-a456-426614174000","lingerMaterialized":%t},
			"run_context":{"resume_after_yield":%t},
			"input":{"type":"text","text":"Run"},"run_resources":{"mcp_servers":[]}
		}`, runtimeType, runtimeType, materialized, resumeAfterYield))
			}
			first, err := resolver.Resolve(context.Background(), command, request(false, false))
			if err != nil || first.CreateProviderSessionID == "" || first.ResumeSessionID != "" {
				t.Fatalf("unmaterialized Runtime spec=%+v err=%v", first, err)
			}
			resumed, err := resolver.Resolve(context.Background(), command, request(true, false))
			if err != nil || resumed.CreateProviderSessionID != "" || resumed.ResumeSessionID != "123e4567-e89b-12d3-a456-426614174000" {
				t.Fatalf("materialized Runtime spec=%+v err=%v", resumed, err)
			}

			yielded, err := resolver.Resolve(t.Context(), command, request(false, true))
			if err != nil || !yielded.ResumeAfterYield || yielded.CreateProviderSessionID != "" || yielded.ResumeSessionID != resumed.ResumeSessionID {
				t.Fatalf("yielded first turn must resume its assigned identity: %+v, %v", yielded, err)
			}
			_, err = resolver.Resolve(t.Context(), command, json.RawMessage(fmt.Sprintf(`{"kind":"run.start","runtime":{"type":%q},"run_context":{"resume_after_yield":true}}`, runtimeType)))
			if err == nil {
				t.Fatal("scheduler continuation accepted an empty session")
			}
		})
	}
}

func TestExecutionResolverAppendsToolGuide(t *testing.T) {
	resolver := ExecutionResolver{
		Providers:       map[string]ProviderInstallation{"codex": {Type: "codex", ExecutablePath: "/local/bin/codex"}},
		WorkspaceGrants: map[string]WorkspaceGrant{"grant-local": {GrantID: "grant-local", TenantID: "tenant-acme", Path: "/local/workspace"}},
		Views:           testContextViews{root: "/local/workspace"},
		Registrations: map[string]RegistrationBinding{
			"registration-codex": {RegistrationID: "registration-codex", TenantID: "tenant-acme", OwnerActorID: "actor-alice", ProviderType: "codex", Status: registration.StatusOnline},
		},
		ToolGuide: "Guide",
	}
	spec, err := resolver.Resolve(context.Background(), protocol.Command{
		TenantID: "tenant-acme", RegistrationID: "registration-codex", AssignmentRevision: 1,
		WorkspaceGrantID: "grant-local", RuntimeType: "codex", ContextViewRef: json.RawMessage(`{"receipt_ref":"receipt-1"}`),
	}, json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex","model":"gpt-5"},"session_options":{"base_instructions":"Base","developer_instructions":"Developer"},"session":{"threadId":"thread-1"},"input":{"type":"text","text":"Go"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if spec.DeveloperInstructions == nil || *spec.DeveloperInstructions != "Developer\n\nGuide" || spec.SystemPrompt != "Base\n\nDeveloper\n\nGuide" {
		t.Fatalf("tool guide missing: %+v", spec)
	}
}

// Claude defers its web tools behind ToolSearch, so every Claude Operation
// names them; Codex has its own web_search and gets nothing.
func TestExecutionResolverNamesClaudeWebTools(t *testing.T) {
	for _, runtimeType := range []string{"claude", "codex"} {
		t.Run(runtimeType, func(t *testing.T) {
			resolver := ExecutionResolver{
				Providers:       map[string]ProviderInstallation{runtimeType: {Type: runtimeType, ExecutablePath: "/local/bin/" + runtimeType}},
				WorkspaceGrants: map[string]WorkspaceGrant{"grant-local": {GrantID: "grant-local", TenantID: "tenant-acme", Path: "/local/workspace"}},
				Views:           testContextViews{root: "/local/workspace"},
				Registrations: map[string]RegistrationBinding{
					"registration-local": {RegistrationID: "registration-local", TenantID: "tenant-acme", OwnerActorID: "actor-alice", ProviderType: runtimeType, Status: registration.StatusOnline},
				},
			}
			spec, err := resolver.Resolve(context.Background(), protocol.Command{
				TenantID: "tenant-acme", RegistrationID: "registration-local", AssignmentRevision: 1,
				WorkspaceGrantID: "grant-local", RuntimeType: runtimeType, ContextViewRef: json.RawMessage(`{"receipt_ref":"receipt-1"}`),
			}, json.RawMessage(`{"kind":"run.start","runtime":{"type":"`+runtimeType+`","model":"m"},"session_options":{"base_instructions":"Base","developer_instructions":"Developer"},"session":{"threadId":"thread-1"},"input":{"type":"text","text":"Go"}}`))
			if err != nil {
				t.Fatal(err)
			}
			if runtimeType == "claude" {
				if spec.SystemPrompt != "Base\n\nDeveloper\n\n"+claudeWebToolGuide {
					t.Fatalf("Claude web tools not named: %+v", spec)
				}
			} else if strings.Contains(spec.SystemPrompt, "select:WebSearch,WebFetch") || spec.DeveloperInstructions == nil || *spec.DeveloperInstructions != "Developer" {
				t.Fatalf("Codex got the Claude web tool guide: %+v", spec)
			}
		})
	}
}

func TestWebToolGuideFollowsTheModelLink(t *testing.T) {
	cases := []struct {
		runtimeType           string
		apiLink, gateway, cli bool
		want, notWant         string
	}{
		{"claude", false, false, true, "select:WebSearch,WebFetch", ""},
		{"claude", false, false, true, "Use them first. If that fails, `teamhub web search <query>`", ""},
		{"codex", false, false, true, "use your built-in web search first. If that fails, `teamhub web search", "select:WebSearch"},
		{"claude", true, false, true, "instead of your built-in web search and fetch tools", "select:WebSearch"},
		{"codex", true, false, true, "Web tools: search the web with `teamhub web search <query>`", "first"},
		{"claude", true, true, true, "Web tools: search the web with `teamhub web search <query>`", "built-in"},
		{"codex", true, true, true, "`teamhub web list`", "built-in"},
		{"pi", false, false, true, "`teamhub web open <url>`", "built-in"},
		{"pi", true, false, true, "`teamhub web open <url>`", "built-in"},
		{"claude", false, false, false, "select:WebSearch,WebFetch", "teamhub"},
		{"claude", true, false, false, "select:WebSearch,WebFetch", "teamhub"},
	}
	for _, c := range cases {
		guide := webToolGuide(c.runtimeType, c.apiLink, c.gateway, c.cli)
		if !strings.Contains(guide, c.want) || (c.notWant != "" && strings.Contains(guide, c.notWant)) {
			t.Fatalf("webToolGuide(%s, api=%v, gateway=%v, cli=%v) = %q", c.runtimeType, c.apiLink, c.gateway, c.cli, guide)
		}
	}
	if webToolGuide("codex", true, true, false) != "" || webToolGuide("pi", false, false, false) != "" {
		t.Fatal("a guide named teamhub without the TeamHub CLI")
	}
}

func TestExecutionResolverTurnsOffNativeWebToolsOnTheGateway(t *testing.T) {
	resolver := ExecutionResolver{
		Providers:       map[string]ProviderInstallation{"claude": {Type: "claude", ExecutablePath: "/local/bin/claude", ModelGateway: true, APILink: true}},
		WorkspaceGrants: map[string]WorkspaceGrant{"grant-local": {GrantID: "grant-local", TenantID: "tenant-acme", Path: "/local/workspace"}},
		Views:           testContextViews{root: "/local/workspace"},
		Registrations: map[string]RegistrationBinding{
			"registration-local": {RegistrationID: "registration-local", TenantID: "tenant-acme", OwnerActorID: "actor-alice", ProviderType: "claude", Status: registration.StatusOnline},
		},
	}
	spec, err := resolver.Resolve(context.Background(), protocol.Command{
		TenantID: "tenant-acme", RegistrationID: "registration-local", AssignmentRevision: 1,
		WorkspaceGrantID: "grant-local", RuntimeType: "claude", ContextViewRef: json.RawMessage(`{"receipt_ref":"receipt-1"}`),
	}, json.RawMessage(`{"kind":"run.start","runtime":{"type":"claude","model":"m"},"session_options":{"base_instructions":"Base","developer_instructions":"Developer"},"session":{"threadId":"thread-1"},"input":{"type":"text","text":"Go"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if !spec.WithoutNativeWebTools || strings.Contains(spec.SystemPrompt, "WebSearch") {
		t.Fatalf("gateway Claude keeps its web tools: %+v", spec)
	}
}

func TestBoundServiceGuidanceUsesLocalCommandOnly(t *testing.T) {
	command := []string{"/opt/node", "/private install/cli.js", "--config", "/private/current.json"}
	text := boundServiceInstructions(command)
	if !strings.Contains(text, `/private/current.json`) || !strings.Contains(text, "Do not invoke the bare global") {
		t.Fatal("missing bound service command")
	}
	if !strings.Contains(boundServiceInstructions(nil), "unavailable") {
		t.Fatal("unbound service availability was invented")
	}
}

// The Context Skill identity comes from the View's own file digests.
func TestContextSkillDigest(t *testing.T) {
	skills := func(files ...FileInput) Mapping {
		return Mapping{Kind: "skills", TargetPath: ".agents/skills", Access: "read_only", Files: files}
	}
	a := FileInput{RelativePath: "a/SKILL.md", SHA256: "1"}
	b := FileInput{RelativePath: "b/run.sh", SHA256: "2", Executable: true}
	base := contextSkillDigest([]Mapping{skills(a, b)})
	if contextSkillDigest([]Mapping{skills(b, a), {Kind: "documents", TargetPath: "documents", Files: []FileInput{a}}}) != base {
		t.Fatal("order or another mapping changed the digest")
	}
	edited := a
	edited.SHA256 = "3"
	notExecutable := b
	notExecutable.Executable = false
	for _, changed := range [][]FileInput{{edited, b}, {a, notExecutable}, {a}} {
		if contextSkillDigest([]Mapping{skills(changed...)}) == base {
			t.Fatalf("%+v kept the digest", changed)
		}
	}
}

func TestExecutionResolverPlacesStaticGuidesBeforeMarkerAndBaseAfter(t *testing.T) {
	resolver := ExecutionResolver{
		Providers: map[string]ProviderInstallation{
			"pi": {Type: "pi", ExecutablePath: "/local/bin/pi", ModelGateway: true, APILink: true},
		},
		WorkspaceGrants: map[string]WorkspaceGrant{
			"grant-local": {GrantID: "grant-local", TenantID: "tenant-acme", Path: "/local/workspace"},
		},
		Views: testContextViews{root: "/local/workspace"},
		Registrations: map[string]RegistrationBinding{
			"registration-pi": {RegistrationID: "registration-pi", TenantID: "tenant-acme", OwnerActorID: "actor-alice", ProviderType: "pi", Status: registration.StatusOnline},
		},
		ToolGuide: "StaticToolGuide",
	}
	cmd := protocol.Command{
		TenantID: "tenant-acme", RegistrationID: "registration-pi", AssignmentRevision: 1,
		WorkspaceGrantID: "grant-local", RuntimeType: "pi", HostAccess: "trusted",
		ContextViewRef: json.RawMessage(`{"receipt_ref":"receipt-1"}`),
	}
	reqA := json.RawMessage(`{
		"kind":"run.start",
		"runtime":{"type":"pi","model":"localmodels/model-a"},
		"session_options":{"thread_name":"Agent A","base_instructions":"Agent A Prompt","developer_instructions":"StaticCore\n\n` + staticPrefixEndMarker + `\n\nDynamicA\n\n<user-memory version=\"1\">MemA</user-memory>"},
		"session":{},
		"input":{"type":"text","text":"Hi"}
	}`)
	reqB := json.RawMessage(`{
		"kind":"run.start",
		"runtime":{"type":"pi","model":"localmodels/model-a"},
		"session_options":{"thread_name":"Agent B","base_instructions":"Agent B Prompt","developer_instructions":"StaticCore\n\n` + staticPrefixEndMarker + `\n\nDynamicB\n\n<user-memory version=\"2\">MemB</user-memory>"},
		"session":{},
		"input":{"type":"text","text":"Hi"}
	}`)
	specA, err := resolver.Resolve(context.Background(), cmd, reqA)
	if err != nil {
		t.Fatal(err)
	}
	specB, err := resolver.Resolve(context.Background(), cmd, reqB)
	if err != nil {
		t.Fatal(err)
	}

	if strings.Contains(specA.SystemPrompt, staticPrefixEndMarker) || strings.Contains(specB.SystemPrompt, staticPrefixEndMarker) {
		t.Fatalf("internal static prefix marker leaked into SystemPrompt: A=%q B=%q", specA.SystemPrompt, specB.SystemPrompt)
	}
	if specA.DeveloperInstructions == nil || strings.Contains(*specA.DeveloperInstructions, staticPrefixEndMarker) {
		t.Fatalf("internal static prefix marker leaked into DeveloperInstructions: %v", specA.DeveloperInstructions)
	}

	expectedStaticPrefix := strings.Join([]string{
		"StaticCore",
		trustedHostServiceInstructions,
		boundServiceInstructions(nil),
		"StaticToolGuide",
	}, "\n\n")
	if !strings.HasPrefix(specA.SystemPrompt, expectedStaticPrefix+"\n\n") || !strings.HasPrefix(specB.SystemPrompt, expectedStaticPrefix+"\n\n") {
		t.Fatalf("static prefix mismatch across agents:\nwant prefix=%q\nA=%q\nB=%q", expectedStaticPrefix, specA.SystemPrompt, specB.SystemPrompt)
	}
	wantSystemA := expectedStaticPrefix + "\n\nAgent A Prompt\n\nDynamicA\n\n<user-memory version=\"1\">MemA</user-memory>"
	if specA.SystemPrompt != wantSystemA {
		t.Fatalf("specA.SystemPrompt = %q, want %q", specA.SystemPrompt, wantSystemA)
	}
	wantSystemB := expectedStaticPrefix + "\n\nAgent B Prompt\n\nDynamicB\n\n<user-memory version=\"2\">MemB</user-memory>"
	if specB.SystemPrompt != wantSystemB {
		t.Fatalf("specB.SystemPrompt = %q, want %q", specB.SystemPrompt, wantSystemB)
	}
	wantDevA := expectedStaticPrefix + "\n\nDynamicA\n\n<user-memory version=\"1\">MemA</user-memory>"
	if *specA.DeveloperInstructions != wantDevA {
		t.Fatalf("specA.DeveloperInstructions = %q, want %q", *specA.DeveloperInstructions, wantDevA)
	}
	if specA.BaseInstructions == nil || *specA.BaseInstructions != "Agent A Prompt" {
		t.Fatalf("BaseInstructions altered: %v", specA.BaseInstructions)
	}

	// Even when the Daemon adds zero static guides, the internal slot marker is stripped.
	untrustedResolver := ExecutionResolver{
		Providers:       resolver.Providers,
		WorkspaceGrants: resolver.WorkspaceGrants,
		Views:           resolver.Views,
		Registrations:   resolver.Registrations,
	}
	untrustedCmd := cmd
	untrustedCmd.HostAccess = ""
	specNoGuides, err := untrustedResolver.Resolve(context.Background(), untrustedCmd, reqA)
	if err != nil {
		t.Fatal(err)
	}
	wantNoGuidesSystem := "StaticCore\n\nAgent A Prompt\n\nDynamicA\n\n<user-memory version=\"1\">MemA</user-memory>"
	if specNoGuides.SystemPrompt != wantNoGuidesSystem {
		t.Fatalf("specNoGuides.SystemPrompt = %q, want %q", specNoGuides.SystemPrompt, wantNoGuidesSystem)
	}
	wantNoGuidesDev := "StaticCore\n\nDynamicA\n\n<user-memory version=\"1\">MemA</user-memory>"
	if specNoGuides.DeveloperInstructions == nil || *specNoGuides.DeveloperInstructions != wantNoGuidesDev {
		t.Fatalf("specNoGuides.DeveloperInstructions = %v, want %q", specNoGuides.DeveloperInstructions, wantNoGuidesDev)
	}
}

func TestExecutionResolverPlacesStaticGuidesInCodexBaseInstructionsAndStripsMarker(t *testing.T) {
	resolver := ExecutionResolver{
		Providers: map[string]ProviderInstallation{
			"codex": {Type: "codex", ExecutablePath: "/local/bin/codex", ModelGateway: true, APILink: true},
		},
		WorkspaceGrants: map[string]WorkspaceGrant{
			"grant-local": {GrantID: "grant-local", TenantID: "tenant-acme", Path: "/local/workspace"},
		},
		Views: testContextViews{root: "/local/workspace"},
		Registrations: map[string]RegistrationBinding{
			"registration-codex": {RegistrationID: "registration-codex", TenantID: "tenant-acme", OwnerActorID: "actor-alice", ProviderType: "codex", Status: registration.StatusOnline},
		},
		ToolGuide: "StaticToolGuide",
	}
	cmd := protocol.Command{
		TenantID: "tenant-acme", RegistrationID: "registration-codex", AssignmentRevision: 1,
		WorkspaceGrantID: "grant-local", RuntimeType: "codex", HostAccess: "trusted",
		ContextViewRef: json.RawMessage(`{"receipt_ref":"receipt-1"}`),
	}
	reqA := json.RawMessage(`{
		"kind":"run.start",
		"runtime":{"type":"codex","model":"localmodels/model-a"},
		"session_options":{"thread_name":"Agent A","base_instructions":"Responsibility\n\nStaticCore\n\n` + staticPrefixEndMarker + `\n\nAgent A Prompt\n\nDynamicA"},
		"session":{"threadId":""},
		"input":{"type":"text","text":"Hi"}
	}`)
	reqB := json.RawMessage(`{
		"kind":"run.start",
		"runtime":{"type":"codex","model":"localmodels/model-a"},
		"session_options":{"thread_name":"Agent B","base_instructions":"Responsibility\n\nStaticCore\n\n` + staticPrefixEndMarker + `\n\nAgent B Prompt\n\nDynamicB"},
		"session":{"threadId":""},
		"input":{"type":"text","text":"Hi"}
	}`)
	specA, err := resolver.Resolve(context.Background(), cmd, reqA)
	if err != nil {
		t.Fatal(err)
	}
	specB, err := resolver.Resolve(context.Background(), cmd, reqB)
	if err != nil {
		t.Fatal(err)
	}

	for _, spec := range []struct {
		name      string
		base      *string
		developer *string
		system    string
	}{
		{"A", specA.BaseInstructions, specA.DeveloperInstructions, specA.SystemPrompt},
		{"B", specB.BaseInstructions, specB.DeveloperInstructions, specB.SystemPrompt},
	} {
		if spec.base == nil || strings.Contains(*spec.base, staticPrefixEndMarker) {
			t.Fatalf("Codex %s BaseInstructions missing or leaked marker: %v", spec.name, spec.base)
		}
		if spec.developer != nil {
			t.Fatalf("Codex %s DeveloperInstructions should remain nil when guides fit into BaseInstructions: %q", spec.name, *spec.developer)
		}
		if strings.Contains(spec.system, staticPrefixEndMarker) {
			t.Fatalf("Codex %s SystemPrompt leaked marker: %q", spec.name, spec.system)
		}
	}

	expectedStaticPrefix := strings.Join([]string{
		"Responsibility\n\nStaticCore",
		trustedHostServiceInstructions,
		boundServiceInstructions(nil),
		"StaticToolGuide",
	}, "\n\n")
	if !strings.HasPrefix(*specA.BaseInstructions, expectedStaticPrefix+"\n\n") || !strings.HasPrefix(*specB.BaseInstructions, expectedStaticPrefix+"\n\n") {
		t.Fatalf("Codex static prefix mismatch across agents:\nwant prefix=%q\nA=%q\nB=%q", expectedStaticPrefix, *specA.BaseInstructions, *specB.BaseInstructions)
	}
	wantBaseA := expectedStaticPrefix + "\n\nAgent A Prompt\n\nDynamicA"
	if *specA.BaseInstructions != wantBaseA {
		t.Fatalf("specA.BaseInstructions = %q, want %q", *specA.BaseInstructions, wantBaseA)
	}
	wantBaseB := expectedStaticPrefix + "\n\nAgent B Prompt\n\nDynamicB"
	if *specB.BaseInstructions != wantBaseB {
		t.Fatalf("specB.BaseInstructions = %q, want %q", *specB.BaseInstructions, wantBaseB)
	}

	untrustedResolver := ExecutionResolver{
		Providers:       resolver.Providers,
		WorkspaceGrants: resolver.WorkspaceGrants,
		Views:           resolver.Views,
		Registrations:   resolver.Registrations,
	}
	untrustedCmd := cmd
	untrustedCmd.HostAccess = ""
	specNoGuides, err := untrustedResolver.Resolve(context.Background(), untrustedCmd, reqA)
	if err != nil {
		t.Fatal(err)
	}
	wantNoGuidesBase := "Responsibility\n\nStaticCore\n\nAgent A Prompt\n\nDynamicA"
	if specNoGuides.BaseInstructions == nil || *specNoGuides.BaseInstructions != wantNoGuidesBase {
		t.Fatalf("specNoGuides.BaseInstructions = %v, want %q", specNoGuides.BaseInstructions, wantNoGuidesBase)
	}
	if specNoGuides.DeveloperInstructions != nil {
		t.Fatalf("specNoGuides.DeveloperInstructions = %q, want nil", *specNoGuides.DeveloperInstructions)
	}
}

func TestShellToolGuideAndWindowsPiStaticPrefixPlacement(t *testing.T) {
	if got := shellToolGuide("pi", "windows", true); got != piWindowsPowerShellGuide {
		t.Fatalf("shellToolGuide(pi, windows, true) = %q", got)
	}
	for _, tc := range []struct {
		runtimeType, goos string
		cli               bool
	}{
		{"pi", "windows", false},
		{"pi", "linux", true},
		{"pi", "darwin", true},
		{"codex", "windows", true},
		{"claude", "windows", true},
	} {
		if got := shellToolGuide(tc.runtimeType, tc.goos, tc.cli); got != "" {
			t.Errorf("shellToolGuide(%q, %q, %v) = %q, want empty", tc.runtimeType, tc.goos, tc.cli, got)
		}
	}

	root := t.TempDir()
	store := cliTestCredentialStore(t, true)
	resolver := ExecutionResolver{
		TeamHubCLIBin:  "/trusted/release/cli",
		CLICredentials: store,
		ToolGuide:      "StaticToolGuide",
		Providers: map[string]ProviderInstallation{
			"pi": {Type: "pi", ExecutablePath: "/local/bin/pi", ModelGateway: true, APILink: true},
		},
		WorkspaceGrants: map[string]WorkspaceGrant{
			"grant-local": {GrantID: "grant-local", TenantID: "tenant", Path: root},
		},
		Views: testContextViews{root: root},
		Registrations: map[string]RegistrationBinding{
			"registration-pi": {RegistrationID: "registration-pi", TenantID: "tenant", OwnerActorID: "actor-alice", ProviderType: "pi", Status: registration.StatusOnline},
		},
		goos: "windows",
	}
	cmd := protocol.Command{
		TenantID: "tenant", AgentID: "agent", RegistrationID: "registration-pi", AssignmentRevision: 1,
		WorkspaceGrantID: "grant-local", RuntimeType: "pi",
		ContextViewRef: json.RawMessage(`{"receipt_ref":"receipt-1"}`),
	}
	req := json.RawMessage(`{
		"kind":"run.start",
		"runtime":{"type":"pi","model":"localmodels/model-a"},
		"session_options":{"thread_name":"Agent A","base_instructions":"Agent A Prompt","developer_instructions":"StaticCore\n\n` + staticPrefixEndMarker + `\n\nDynamicTail"},
		"session":{},
		"input":{"type":"text","text":"Hi"}
	}`)
	spec, err := resolver.Resolve(context.Background(), cmd, req)
	if err != nil {
		t.Fatal(err)
	}
	wantPrefix := strings.Join([]string{
		"StaticCore",
		"StaticToolGuide",
		teamHubWebToolGuide,
		piWindowsPowerShellGuide,
	}, "\n\n")
	wantSystem := wantPrefix + "\n\nAgent A Prompt\n\nDynamicTail"
	if spec.SystemPrompt != wantSystem {
		t.Fatalf("SystemPrompt =\n%q\nwant:\n%q", spec.SystemPrompt, wantSystem)
	}
	wantDev := wantPrefix + "\n\nDynamicTail"
	if spec.DeveloperInstructions == nil || *spec.DeveloperInstructions != wantDev {
		t.Fatalf("DeveloperInstructions = %v, want %q", spec.DeveloperInstructions, wantDev)
	}
}

func TestValidReasoningEffortAcceptsDynamicTokens(t *testing.T) {
	for _, value := range []string{"minimal", "off", "low", "xhigh", "custom_effort-2"} {
		if !provider.ValidRuntimeReasoningEffort(value) {
			t.Fatalf("provider.ValidRuntimeReasoningEffort(%q) = false, want true", value)
		}
	}
	for _, value := range []string{"", "-minimal", "with space", "too_long_effort_token"} {
		if provider.ValidRuntimeReasoningEffort(value) {
			t.Fatalf("provider.ValidRuntimeReasoningEffort(%q) = true, want false", value)
		}
	}

	resolver := ExecutionResolver{
		Providers:       map[string]ProviderInstallation{"codex": {Type: "codex", ExecutablePath: "/local/bin/codex"}},
		WorkspaceGrants: map[string]WorkspaceGrant{"grant-local": {GrantID: "grant-local", TenantID: "tenant-acme", Path: "/local/workspace"}},
		Views:           testContextViews{root: "/local/workspace"},
		Registrations: map[string]RegistrationBinding{
			"registration-codex": {RegistrationID: "registration-codex", TenantID: "tenant-acme", OwnerActorID: "actor-alice", ProviderType: "codex", Status: registration.StatusOnline},
		},
	}
	command := protocol.Command{
		TenantID: "tenant-acme", RegistrationID: "registration-codex", AssignmentRevision: 1,
		WorkspaceGrantID: "grant-local", RuntimeType: "codex", ContextViewRef: json.RawMessage(`{"receipt_ref":"receipt-1"}`),
	}
	spec, err := resolver.Resolve(context.Background(), command, json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex","model":"gpt-5","reasoning_effort":"minimal"},"session":{"thread_id":"thread-1"},"input":{"type":"text","text":"Go"}}`))
	if err != nil || spec.ThinkingLevel != "minimal" {
		t.Fatalf("Resolve(minimal) = %+v, err=%v", spec, err)
	}
	if _, err := resolver.Resolve(context.Background(), command, json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex","model":"gpt-5","reasoning_effort":"-minimal"},"session":{"thread_id":"thread-1"},"input":{"type":"text","text":"Go"}}`)); err == nil {
		t.Fatal("Resolve(-minimal) succeeded, want error")
	}
}

func TestExecutionResolverPlacesHostEnvironmentGuideInStaticPrefix(t *testing.T) {
	root := t.TempDir()
	resolver := ExecutionResolver{
		ToolGuide:            "StaticToolGuide",
		HostEnvironmentGuide: WindowsHostEnvironmentGuide,
		Providers: map[string]ProviderInstallation{
			"codex": {Type: "codex", ExecutablePath: "/local/bin/codex"},
		},
		WorkspaceGrants: map[string]WorkspaceGrant{
			"grant-local": {GrantID: "grant-local", TenantID: "tenant", Path: root},
		},
		Views: testContextViews{root: root},
		Registrations: map[string]RegistrationBinding{
			"registration-codex": {RegistrationID: "registration-codex", TenantID: "tenant", OwnerActorID: "actor-alice", ProviderType: "codex", Status: registration.StatusOnline},
		},
	}
	cmd := protocol.Command{
		TenantID: "tenant", AgentID: "agent", RegistrationID: "registration-codex", AssignmentRevision: 1,
		WorkspaceGrantID: "grant-local", RuntimeType: "codex",
		ContextViewRef: json.RawMessage(`{"receipt_ref":"receipt-1"}`),
	}
	req := json.RawMessage(`{
		"kind":"run.start",
		"runtime":{"type":"codex","model":"gpt-5"},
		"session_options":{"thread_name":"Agent A","base_instructions":"StaticCore\n\n` + staticPrefixEndMarker + `\n\nDynamicTail"},
		"session":{"threadId":""},
		"input":{"type":"text","text":"Hi"}
	}`)
	spec, err := resolver.Resolve(context.Background(), cmd, req)
	if err != nil {
		t.Fatal(err)
	}
	wantPrefix := strings.Join([]string{"StaticCore", "StaticToolGuide", WindowsHostEnvironmentGuide}, "\n\n")
	if spec.BaseInstructions == nil || *spec.BaseInstructions != wantPrefix+"\n\nDynamicTail" {
		t.Fatalf("BaseInstructions = %v, want prefix %q", spec.BaseInstructions, wantPrefix)
	}
	if !strings.Contains(spec.SystemPrompt, wantPrefix) {
		t.Fatalf("SystemPrompt missing HostEnvironmentGuide in static prefix: %q", spec.SystemPrompt)
	}

	resolver.HostEnvironmentGuide = ""
	withoutGuide, err := resolver.Resolve(context.Background(), cmd, req)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(withoutGuide.SystemPrompt, WindowsHostEnvironmentGuide) {
		t.Fatalf("empty HostEnvironmentGuide still emitted WindowsHostEnvironmentGuide: %q", withoutGuide.SystemPrompt)
	}
}
