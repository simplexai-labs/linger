package permission

import (
	"context"
	"encoding/json"
	"errors"
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

	// Already-approved bundle allows immediately without calling TeamHub.
	if verdict := reviewer.Review(context.Background(), Request{Action: Action{Tool: "mcp__computer__click", Input: `{"pid":2}`}}); verdict.Decision != Allow {
		t.Fatalf("approved app verdict = %+v", verdict)
	}
	if len(requester.requests) != 0 {
		t.Fatalf("unexpected review requests: %v", requester.requests)
	}

	// Unapproved bundle triggers TeamHub review carrying bundle_id, app, and window_title.
	verdictCh := review(reviewer, Request{Action: Action{Tool: "mcp__computer__get_window_state", Input: `{"pid":3}`}})
	id := <-requester.sent
	payload := requester.requests[id]
	evidence := payload["evidence"].(map[string]any)
	desktop := evidence["desktop"].(map[string]any)
	if desktop["bundle_id"] != "com.apple.Safari" || desktop["app"] != "Safari" || desktop["window_title"] != "Docs" {
		t.Fatalf("desktop evidence = %v", desktop)
	}
	requester.answer(t, id, `{"decision":"allow"}`)
	if got := <-verdictCh; got.Decision != Allow {
		t.Fatalf("safari allow verdict = %+v", got)
	}

	// Subsequent calls against Safari are cached in ApprovedComputerApps.
	if !reviewer.ComputerAppApproved("com.apple.Safari") {
		t.Fatal("expected Safari to be cached as approved")
	}
	if verdict := reviewer.Review(context.Background(), Request{Action: Action{Tool: "mcp__computer__click", Input: `{"pid":3}`}}); verdict.Decision != Allow {
		t.Fatalf("cached safari verdict = %+v", verdict)
	}
	if len(requester.requests) != 1 {
		t.Fatalf("expected 1 total review request, got %d", len(requester.requests))
	}
}
