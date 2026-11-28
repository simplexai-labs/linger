package permission

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeRequester struct {
	mu        sync.Mutex
	requests  map[string]map[string]any
	responds  map[string]func(json.RawMessage) error
	forgotten []string
	sent      chan string
	err       error
}

func newFakeRequester() *fakeRequester {
	return &fakeRequester{requests: map[string]map[string]any{}, responds: map[string]func(json.RawMessage) error{}, sent: make(chan string, 1)}
}

func (f *fakeRequester) Request(id string, request map[string]any, respond func(json.RawMessage) error) error {
	if f.err != nil {
		return f.err
	}
	f.mu.Lock()
	f.requests[id], f.responds[id] = request, respond
	f.mu.Unlock()
	f.sent <- id
	return nil
}

func (f *fakeRequester) Forget(id string) {
	f.mu.Lock()
	f.forgotten = append(f.forgotten, id)
	f.mu.Unlock()
}

func (f *fakeRequester) answer(t *testing.T, id, raw string) {
	t.Helper()
	f.mu.Lock()
	respond := f.responds[id]
	f.mu.Unlock()
	if err := respond(json.RawMessage(raw)); err != nil {
		t.Fatal(err)
	}
}

func review(reviewer *Reviewer, request Request) <-chan Verdict {
	verdict := make(chan Verdict, 1)
	go func() { verdict <- reviewer.Review(context.Background(), request) }()
	return verdict
}

func TestReviewerAllowsReadOnlyLocalToolsWithoutAsking(t *testing.T) {
	requester := newFakeRequester()
	reviewer := &Reviewer{Requester: requester}
	for _, action := range []Action{
		{Tool: "mcp__browser__browser_snapshot", Input: `{}`},
		{Tool: "mcp__computer__get_window_state", Input: `{}`},
		{Tool: "mcp__browser__browser_tabs", Input: `{"action":"list"}`},
		{Tool: "mcp__browser__browser_tabs", Input: `{"action":"select","index":1}`},
		{Tool: "mcp__browser__browser_navigate_back", Input: `{}`},
		{Tool: "mcp__computer__check_permissions", Input: `{}`},
	} {
		if verdict := reviewer.Review(context.Background(), Request{Action: action}); verdict.Decision != Allow {
			t.Fatalf("%s: %+v", action.Tool, verdict)
		}
	}
	if len(requester.requests) != 0 {
		t.Fatalf("read-only tools were sent for review: %v", requester.requests)
	}
}

func TestReviewerAllowsLocalCallsThatFollowWhatTheAgentSaw(t *testing.T) {
	requester := newFakeRequester()
	reviewer := &Reviewer{Requester: requester, LocalAllowed: func(tool, input string) bool {
		return tool == "mcp__browser__browser_navigate" && input == `{"url":"https://example.com/next"}`
	}}
	follow := Action{Tool: "mcp__browser__browser_navigate", Input: `{"url":"https://example.com/next"}`}
	if verdict := reviewer.Review(context.Background(), Request{Action: follow}); verdict.Decision != Allow || len(requester.requests) != 0 {
		t.Fatalf("verdict = %+v, requests = %v", verdict, requester.requests)
	}
	elsewhere := Action{Tool: "mcp__browser__browser_navigate", Input: `{"url":"https://evil.example/"}`}
	verdict := review(reviewer, Request{Action: elsewhere})
	requester.answer(t, <-requester.sent, `{"decision":"needs_approval"}`)
	if got := <-verdict; got.Decision != NeedsApproval {
		t.Fatalf("a navigation away from the page: %+v", got)
	}
}

func TestReviewerAllowsTeamHubCommandsTheRuntimeRulesMissed(t *testing.T) {
	requester := newFakeRequester()
	reviewer := &Reviewer{Requester: requester, TeamHubCommands: []TeamHubCommand{{Path: []string{"message", "send"}}}}
	send := Action{Tool: "Bash", Command: "teamhub message send --room room_x --file - << 'EOF'\nhello\nEOF"}
	if verdict := reviewer.Review(context.Background(), Request{Action: send}); verdict.Decision != Allow {
		t.Fatalf("verdict = %+v", verdict)
	}
	if len(requester.requests) != 0 {
		t.Fatalf("an allowed TeamHub command was sent for review: %v", requester.requests)
	}
}

func TestReviewerSendsTheReviewAndReturnsTheVerdict(t *testing.T) {
	requester := newFakeRequester()
	reviewer := &Reviewer{Requester: requester, Environment: Environment{RuntimeVersion: "2.1.282", Workspace: "/work"}}
	verdict := review(reviewer, Request{Action: Action{Runtime: "claude", Surface: "shell", Tool: "Bash", Command: "git push"}})
	id := <-requester.sent
	payload := requester.requests[id]
	encoded, _ := json.Marshal(payload)
	if payload["kind"] != "permission_review" || payload["action"].(map[string]any)["command"] != "git push" ||
		payload["environment"].(map[string]any)["workspace"] != "/work" {
		t.Fatalf("review payload: %s", encoded)
	}
	requester.answer(t, id, `{"decision":"needs_approval","message":"Approval card sent","interaction_id":"card-1"}`)
	if got := <-verdict; got != (Verdict{Decision: NeedsApproval, Message: "Approval card sent", InteractionID: "card-1"}) {
		t.Fatalf("verdict: %+v", got)
	}
}

func TestReviewerFailsClosed(t *testing.T) {
	bash := Request{Action: Action{Tool: "Bash", Command: "git push"}}
	t.Run("invalid answer", func(t *testing.T) {
		requester := newFakeRequester()
		verdict := review(&Reviewer{Requester: requester}, bash)
		requester.answer(t, <-requester.sent, `{"decision":"maybe"}`)
		if got := <-verdict; got.Decision != Unavailable || got.Message == "" {
			t.Fatalf("verdict: %+v", got)
		}
	})
	t.Run("deny without a message", func(t *testing.T) {
		requester := newFakeRequester()
		verdict := review(&Reviewer{Requester: requester}, bash)
		requester.answer(t, <-requester.sent, `{"decision":"deny"}`)
		if got := <-verdict; got.Decision != Deny || got.Message == "" {
			t.Fatalf("verdict: %+v", got)
		}
	})
	t.Run("request fails", func(t *testing.T) {
		requester := newFakeRequester()
		requester.err = errors.New("bridge closed")
		if got := (&Reviewer{Requester: requester}).Review(context.Background(), bash); got.Decision != Unavailable {
			t.Fatalf("verdict: %+v", got)
		}
	})
	t.Run("timeout", func(t *testing.T) {
		requester := newFakeRequester()
		got := (&Reviewer{Requester: requester, Timeout: 10 * time.Millisecond}).Review(context.Background(), bash)
		id := <-requester.sent
		if got.Decision != Unavailable || len(requester.forgotten) != 1 || requester.forgotten[0] != id {
			t.Fatalf("verdict %+v forgotten %v", got, requester.forgotten)
		}
	})
	t.Run("cancelled", func(t *testing.T) {
		requester := newFakeRequester()
		ctx, cancel := context.WithCancel(context.Background())
		verdict := make(chan Verdict, 1)
		go func() { verdict <- (&Reviewer{Requester: requester}).Review(ctx, bash) }()
		<-requester.sent
		cancel()
		if got := <-verdict; got.Decision != Unavailable || len(requester.forgotten) != 1 {
			t.Fatalf("verdict %+v forgotten %v", got, requester.forgotten)
		}
	})
}

func TestReviewerAttachesLocalEvidenceToBrowserAndDesktopActions(t *testing.T) {
	requester := newFakeRequester()
	var asked []string
	reviewer := &Reviewer{Requester: requester, LocalEvidence: func(_ context.Context, tool, input string) *Evidence {
		asked = append(asked, tool)
		return &Evidence{Desktop: &Desktop{App: "Mail", Targets: []DesktopTarget{{Token: "s1:3", Role: "AXButton", Name: "Send"}}},
			Screenshot: &Screenshot{MediaType: "image/jpeg", Data: "AA==", Width: 1, Height: 1}}
	}}
	review(reviewer, Request{Action: Action{Tool: "mcp__computer__get_window_state", Input: `{}`}})
	verdict := review(reviewer, Request{Action: Action{Tool: "mcp__computer__click", Input: `{"pid":1,"element_token":"s1:3"}`}})
	id := <-requester.sent
	payload := requester.requests[id]
	evidence, _ := payload["evidence"].(map[string]any)
	desktop, _ := evidence["desktop"].(map[string]any)
	if desktop["app"] != "Mail" || evidence["screenshot"] == nil {
		t.Fatalf("evidence: %v", evidence)
	}
	if len(asked) != 1 || asked[0] != "mcp__computer__click" {
		t.Fatalf("evidence asked for %v", asked)
	}
	requester.answer(t, id, `{"decision":"allow","message":""}`)
	<-verdict
}

func TestReviewerDeniesSystemPrivacyUICommands(t *testing.T) {
	requester := newFakeRequester()
	reviewer := &Reviewer{Requester: requester}
	for _, command := range []string{
		"tccutil reset ScreenCapture",
		"/usr/bin/tccutil reset All com.linger.desktop",
		`osascript -e 'tell application "System Settings" to activate'`,
		"osascript <<'EOF'\ntell application \"System Preferences\"\nreveal anchor \"Privacy_ScreenCapture\" of pane id \"com.apple.preference.security\"\nend tell\nEOF",
	} {
		verdict := reviewer.Review(context.Background(), Request{Action: Action{Tool: "Bash", Command: command}})
		if verdict.Decision != Deny || verdict.Message != SystemPrivacyUIMessage {
			t.Fatalf("%q: %+v", command, verdict)
		}
	}
	for _, command := range []string{"screencapture -x shot.png", `osascript -e 'tell application "Finder" to activate'`, "ls tccutil_notes"} {
		if SystemPrivacyUI(command) {
			t.Fatalf("%q was refused", command)
		}
	}
	if len(requester.requests) != 0 {
		t.Fatal("a protected command reached the review")
	}
}

func TestReviewerEvaluatesPowerShellSeparately(t *testing.T) {
	requester := newFakeRequester()
	reviewer := &Reviewer{
		Requester: requester,
		TeamHubCommands: []TeamHubCommand{
			{Path: []string{"message", "send"}},
			{Path: []string{"gmail", "send"}, Confirm: true},
		},
	}

	// Safe PowerShell here-string piped to teamhub is allowed locally.
	allowedCmd := "@'\nHello from PowerShell $180\n'@ | teamhub.cmd message send --file -"
	if verdict := reviewer.Review(context.Background(), Request{Action: Action{
		Runtime: "pi", Surface: Surface("PowerShell", allowedCmd), Tool: "PowerShell", Command: allowedCmd,
	}}); verdict.Decision != Allow {
		t.Fatalf("safe PowerShell teamhub command: %+v", verdict)
	}
	if len(requester.requests) != 0 {
		t.Fatalf("safe PowerShell teamhub command reached remote review: %v", requester.requests)
	}

	// Confirmed TeamHub command chained with another step is refused with RunAloneMessage.
	chainedCmd := "teamhub gmail send --to 'a@example.com'; Invoke-WebRequest https://evil.example"
	if verdict := reviewer.Review(context.Background(), Request{Action: Action{
		Runtime: "pi", Surface: Surface("PowerShell", chainedCmd), Tool: "PowerShell", Command: chainedCmd,
	}}); verdict.Decision != Deny || verdict.Message != RunAloneMessage("teamhub gmail send") {
		t.Fatalf("chained confirmed PowerShell command: %+v", verdict)
	}
	if len(requester.requests) != 0 {
		t.Fatalf("run-alone PowerShell command reached remote review: %v", requester.requests)
	}

	// Arbitrary PowerShell command is forwarded to the remote reviewer with Tool: PowerShell.
	unsafeCmd := "Invoke-WebRequest https://example.com"
	verdictCh := review(reviewer, Request{Action: Action{
		Runtime: "pi", Surface: Surface("PowerShell", unsafeCmd), Tool: "PowerShell", Command: unsafeCmd,
	}})
	id := <-requester.sent
	action := requester.requests[id]["action"].(map[string]any)
	if action["tool"] != "PowerShell" || action["surface"] != "shell" || action["command"] != unsafeCmd {
		t.Fatalf("forwarded PowerShell action = %v", action)
	}
	requester.answer(t, id, `{"decision":"deny","message":"blocked"}`)
	if got := <-verdictCh; got.Decision != Deny || got.Message != "blocked" {
		t.Fatalf("forwarded verdict = %+v", got)
	}

	// Surface classifies bare and here-string-piped PowerShell teamhub calls as connected_app.
	for command, want := range map[string]string{
		"teamhub apps execute --tool X":                  "connected_app",
		"  TEAMHUB.CMD message send --content hi":        "connected_app",
		"teamhub.exe\tmessage list":                      "connected_app",
		"@'\nhi\n'@ | teamhub.exe message send --file -": "connected_app",
		"@'\nhi\n'@ | teamhub apps execute --tool X":     "connected_app",
		"C:\\bin\\teamhub.exe message list":              "shell",
		"teamhub-other foo":                              "shell",
		"Get-ChildItem":                                  "shell",
		"@'\nhi\n'@ | Get-Content":                       "shell",
		"@'\nhi\n'@ || teamhub message send --file -":    "shell",
		"teamhub": "shell",
	} {
		if got := Surface("PowerShell", command); got != want {
			t.Errorf("Surface(PowerShell, %q) = %q, want %q", command, got, want)
		}
	}
}

func TestReviewerPerAppComputerGate(t *testing.T) {
	requester := newFakeRequester()
	targets := map[string]*Desktop{
		`{"pid":1}`: {BundleID: "com.apple.systempreferences", App: "System Settings"},
		`{"pid":2}`: {BundleID: "com.apple.Notes", App: "Notes", WindowTitle: "Inbox"},
		`{"pid":3}`: {BundleID: "com.apple.Safari", App: "Safari", WindowTitle: "Docs"},
		`{"pid":4}`: {BundleID: "com.apple.TextEdit", App: "TextEdit", WindowTitle: "Draft"},
		`{"pid":5}`: {DenyReason: "COMPUTER_MULTI_APP_BATCH: split batch"},
	}
	reviewer := &Reviewer{
		Requester:            requester,
		ApprovedComputerApps: map[string]bool{"com.apple.notes": true},
		ResolveComputerTarget: func(_ context.Context, _ string, input string) *Desktop {
			return targets[input]
		},
	}

	// App-agnostic reads always allow without review.
	for _, tool := range []string{"mcp__computer__list_windows", "mcp__computer__check_permissions"} {
		if verdict := reviewer.Review(context.Background(), Request{Action: Action{Tool: tool, Input: `{}`}}); verdict.Decision != Allow {
			t.Fatalf("%s: got %+v", tool, verdict)
		}
	}

	// Protected macOS privacy apps are hard-denied locally.
	if verdict := reviewer.Review(context.Background(), Request{Action: Action{Tool: "mcp__computer__click", Input: `{"pid":1}`}}); verdict.Decision != Deny || !strings.Contains(verdict.Message, "com.apple.systempreferences") {
		t.Fatalf("protected app verdict = %+v", verdict)
	}

	// Host-local DenyReason (for example mixed-app batch) is denied immediately.
	if verdict := reviewer.Review(context.Background(), Request{Action: Action{Tool: "mcp__computer__run_actions", Input: `{"pid":5}`}}); verdict.Decision != Deny || !strings.Contains(verdict.Message, "COMPUTER_MULTI_APP_BATCH") {
		t.Fatalf("deny reason verdict = %+v", verdict)
	}

	// Already-approved bundle allows immediately without calling TeamHub.
	if verdict := reviewer.Review(context.Background(), Request{Action: Action{Tool: "mcp__computer__click", Input: `{"pid":2}`}}); verdict.Decision != Allow {
		t.Fatalf("approved app verdict = %+v", verdict)
	}
	if len(requester.requests) != 0 {
		t.Fatalf("unexpected review requests: %v", requester.requests)
	}

	// Unresolved app targets on darwin fail closed to TeamHub review even for
	// tools that would otherwise be read-only (get_window_state, scroll, clipboard_read).
	unresolvedCh := review(reviewer, Request{Action: Action{Tool: "mcp__computer__get_window_state", Input: `{"pid":999}`}})
	unresolvedID := <-requester.sent
	requester.answer(t, unresolvedID, `{"decision":"needs_approval","message":"approval required"}`)
	if got := <-unresolvedCh; got.Decision != NeedsApproval {
		t.Fatalf("unresolved target verdict = %+v, want NeedsApproval", got)
	}

	// Single-use ("once") or legacy empty approval_scope allows this call only
	// and must NOT cache the app in ApprovedComputerApps.
	onceCh := review(reviewer, Request{Action: Action{Tool: "mcp__computer__click", Input: `{"pid":4}`}})
	onceID := <-requester.sent
	requester.answer(t, onceID, `{"decision":"allow","approval_scope":"once"}`)
	if got := <-onceCh; got.Decision != Allow {
		t.Fatalf("once allow verdict = %+v", got)
	}
	if reviewer.ComputerAppApproved("com.apple.TextEdit") {
		t.Fatal("once approval must not cache TextEdit as task-approved")
	}

	legacyCh := review(reviewer, Request{Action: Action{Tool: "mcp__computer__click", Input: `{"pid":4}`}})
	legacyID := <-requester.sent
	requester.answer(t, legacyID, `{"decision":"allow"}`)
	if got := <-legacyCh; got.Decision != Allow {
		t.Fatalf("legacy allow verdict = %+v", got)
	}
	if reviewer.ComputerAppApproved("com.apple.TextEdit") {
		t.Fatal("legacy empty-scope allow must not cache TextEdit as task-approved")
	}

	// Persistent "always" approvals allow this call without caching locally,
	// so revoking the grant in TeamHub takes effect on the very next call.
	alwaysCh := review(reviewer, Request{Action: Action{Tool: "mcp__computer__click", Input: `{"pid":4}`}})
	alwaysID := <-requester.sent
	requester.answer(t, alwaysID, `{"decision":"allow","approval_scope":"always"}`)
	if got := <-alwaysCh; got.Decision != Allow {
		t.Fatalf("always allow verdict = %+v", got)
	}
	if reviewer.ComputerAppApproved("com.apple.TextEdit") {
		t.Fatal("always approval must not cache TextEdit locally so revocation is immediate")
	}

	// Explicit task approval caches bundle_id for subsequent calls.
	verdictCh := review(reviewer, Request{Action: Action{Tool: "mcp__computer__get_window_state", Input: `{"pid":3}`}})
	id := <-requester.sent
	payload := requester.requests[id]
	evidence := payload["evidence"].(map[string]any)
	desktop := evidence["desktop"].(map[string]any)
	if desktop["bundle_id"] != "com.apple.Safari" || desktop["app"] != "Safari" || desktop["window_title"] != "Docs" {
		t.Fatalf("desktop evidence = %v", desktop)
	}
	requester.answer(t, id, `{"decision":"allow","approval_scope":"task"}`)
	if got := <-verdictCh; got.Decision != Allow {
		t.Fatalf("safari allow verdict = %+v", got)
	}

	if !reviewer.ComputerAppApproved("com.apple.Safari") {
		t.Fatal("expected Safari to be cached as approved")
	}
	if verdict := reviewer.Review(context.Background(), Request{Action: Action{Tool: "mcp__computer__click", Input: `{"pid":3}`}}); verdict.Decision != Allow {
		t.Fatalf("cached safari verdict = %+v", verdict)
	}
	if len(requester.requests) != 5 {
		t.Fatalf("expected 5 total review requests, got %d", len(requester.requests))
	}
}

func TestReviewerPerAppOrchestrationBatchEvidenceAndScriptBinding(t *testing.T) {
	requester := newFakeRequester()
	skillDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("# Skill\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	scriptPath := filepath.Join(skillDir, "read.js")
	scriptBody := "return 42;"
	if err := os.WriteFile(scriptPath, []byte(scriptBody), 0o600); err != nil {
		t.Fatal(err)
	}
	scope := ScriptScope("agent-1", "ctx-1")
	now := time.Unix(1_700_000_000, 0)
	reviewer := &Reviewer{
		Requester:            requester,
		ScriptScope:          scope,
		Now:                  func() time.Time { return now },
		ApprovedComputerApps: map[string]bool{"com.apple.notes": true},
		LocalAllowed: func(tool, _ string) bool {
			return tool == "mcp__computer__ui_exec" || tool == "mcp__computer__ui_reset"
		},
		LocalEvidence: func(_ context.Context, _ string, _ string) *Evidence {
			return &Evidence{
				Desktop: &Desktop{
					BundleID:    "com.apple.Notes",
					App:         "Notes",
					WindowTitle: "Inbox",
					Targets:     []DesktopTarget{{Token: "s1:1", Role: "AXButton", Name: "Old"}},
				},
			}
		},
		ResolveComputerTarget: func(_ context.Context, tool, _ string) *Desktop {
			if tool == "mcp__computer__run_script" {
				return &Desktop{BundleID: "com.apple.Notes", App: "Notes"}
			}
			return &Desktop{BundleID: "com.apple.Safari", App: "Safari", WindowTitle: "Checkout"}
		},
	}

	// Orchestration wrappers stay locally allowed even under per-app gating.
	for _, tool := range []string{"mcp__computer__ui_exec", "mcp__computer__ui_reset"} {
		if verdict := reviewer.Review(context.Background(), Request{Action: Action{Tool: tool, Input: `{}`}}); verdict.Decision != Allow {
			t.Fatalf("%s verdict = %+v, want Allow", tool, verdict)
		}
	}
	if len(requester.requests) != 0 {
		t.Fatalf("orchestration wrappers reached TeamHub: %v", requester.requests)
	}

	// Cached app approval still binds run_script's script_file so execution
	// passes TakeApprovedScript.
	scriptInput, err := json.Marshal(map[string]any{"script_file": scriptPath, "args": map[string]any{"pid": 2}})
	if err != nil {
		t.Fatal(err)
	}
	if verdict := reviewer.Review(context.Background(), Request{Action: Action{
		Tool:  "mcp__computer__run_script",
		Input: string(scriptInput),
	}}); verdict.Decision != Allow {
		t.Fatalf("cached run_script verdict = %+v, want Allow", verdict)
	}
	if err := TakeApprovedScript(scope, scriptPath, scriptBody, map[string]any{"pid": float64(2)}, now.Add(time.Second)); err != nil {
		t.Fatalf("TakeApprovedScript after cached app allow failed: %v", err)
	}

	// Batch targeting approved Notes + unapproved Safari overwrites stale
	// Notes desktop evidence with Safari so the approval card matches the
	// unapproved target app.
	batchCh := review(reviewer, Request{Action: Action{Tool: "mcp__computer__run_actions", Input: `{"actions":[{"pid":2},{"pid":3}]}`}})
	id := <-requester.sent
	desktop := requester.requests[id]["evidence"].(map[string]any)["desktop"].(map[string]any)
	if desktop["bundle_id"] != "com.apple.Safari" || desktop["app"] != "Safari" || desktop["window_title"] != "Checkout" {
		t.Fatalf("stale desktop evidence leaked into batch review: %v", desktop)
	}
	if _, hasTargets := desktop["targets"]; hasTargets {
		t.Fatalf("stale targets leaked from Notes into Safari review: %v", desktop)
	}
	requester.answer(t, id, `{"decision":"deny","message":"denied"}`)
	if got := <-batchCh; got.Decision != Deny {
		t.Fatalf("batch verdict = %+v", got)
	}
}
