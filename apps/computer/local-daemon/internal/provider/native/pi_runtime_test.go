package native

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
)

type piHarness struct {
	t       *testing.T
	root    string
	dir     string
	runtime Runtime
	env     map[string]string
}

func piNewHarness(t *testing.T, mode string, extra map[string]string) *piHarness {
	t.Helper()
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	h := &piHarness{t: t, root: filepath.Join(base, "sessions"), dir: filepath.Join(base, "context")}
	if err := os.MkdirAll(h.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	h.env = map[string]string{piFakeEnv: mode, piSessionRootKey: h.root}
	for key, value := range extra {
		h.env[key] = value
	}
	h.runtime, err = Open("pi", Profile{Program: program, Env: h.env})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func (h *piHarness) start(ctx context.Context, prompt string, spec RunSpec) *Run {
	h.t.Helper()
	if spec.Dir == "" {
		spec.Dir = h.dir
	}
	run, err := h.runtime.Start(ctx, prompt, spec)
	if err != nil {
		h.t.Fatalf("start: %v", err)
	}
	return run
}

// piCollect drains a run and returns its events and outcome.
func piCollect(t *testing.T, run *Run) ([]Event, Outcome) {
	t.Helper()
	var events []Event
	timeout := time.After(30 * time.Second)
	for {
		select {
		case event, ok := <-run.Events:
			if !ok {
				select {
				case outcome := <-run.Outcome:
					return events, outcome
				case <-timeout:
					t.Fatal("no outcome")
				}
			}
			events = append(events, event)
		case <-timeout:
			t.Fatal("run did not finish")
		}
	}
}

func TestPiSessionLifecycle(t *testing.T) {
	h := piNewHarness(t, "finish", nil)
	if _, err := h.runtime.Start(t.Context(), "", RunSpec{PrepareOnly: true, Dir: h.dir}); err == nil {
		t.Fatal("a blank prepare-only prompt started")
	}
	id, err := piSessionIdentity(RunSpec{})
	if err != nil || len(id) != 26 {
		t.Fatalf("fresh identity = %q, %v", id, err)
	}
	events, first := piCollect(t, h.start(t.Context(), "first", RunSpec{AssignSessionID: id}))
	if first.Status != statusCompleted || first.Output != "done" || !first.ExitConfirmed || first.ExitUnconfirmed || first.SessionID != id {
		t.Fatalf("first = %+v", first)
	}
	if first.Usage["fixture/model"].Output != 3 || first.LastUsage["fixture/model"].Input != 2 || first.CompactionCount == nil || first.TurnID == "" {
		t.Fatalf("usage = %+v", first)
	}
	if len(events) < 2 || events[0].Kind != EventStatus || events[0].TurnID != first.TurnID || events[1].Kind != EventText || events[1].ID == "" || events[1].Body != "done" {
		t.Fatalf("events = %+v", events)
	}
	if _, err := os.Stat(filepath.Join(h.root, id, piLockFileName)); err != nil {
		t.Fatalf("lock file: %v", err)
	}
	_, resumed := piCollect(t, h.start(t.Context(), "again", RunSpec{ResumeID: id}))
	if resumed.Status != statusCompleted || resumed.SessionID != id {
		t.Fatalf("resumed = %+v", resumed)
	}
	other := t.TempDir()
	if _, err := h.runtime.Start(t.Context(), "elsewhere", RunSpec{ResumeID: id, Dir: other}); err == nil {
		t.Fatal("resume from a different Context started")
	}
	if _, err := h.runtime.Start(t.Context(), "escape", RunSpec{ResumeID: "../outside", Dir: h.dir}); err == nil {
		t.Fatal("path-like session identity accepted")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(h.root), "outside")); !os.IsNotExist(err) {
		t.Fatalf("escape touched the filesystem: %v", err)
	}
}

func TestPiSessionIdentityFormat(t *testing.T) {
	for id, want := range map[string]bool{
		"ab": true, "A.b_c-9": true, "a": false, "-ab": false, "ab-": false, "a/b": false,
		"/abs": false, "../outside": false, strings.Repeat("a", 128): true, strings.Repeat("a", 129): false, "a b": false,
	} {
		if got := piValidSessionID(id); got != want {
			t.Errorf("piValidSessionID(%q) = %v", id, got)
		}
	}
}

func TestPiStartPreconditions(t *testing.T) {
	h := piNewHarness(t, "finish", nil)
	cases := map[string]struct {
		prompt string
		spec   RunSpec
	}{
		"blank prompt":             {"  \n", RunSpec{}},
		"computer args":            {"x", RunSpec{ComputerArgs: []string{"--x"}}},
		"agent args":               {"x", RunSpec{AgentArgs: []string{"--x"}}},
		"bad effort":               {"x", RunSpec{Effort: "ultra"}},
		"invalid mcp":              {"x", RunSpec{MCPServers: json.RawMessage(`[1]`)}},
		"missing session":          {"x", RunSpec{ResumeID: "never-created"}},
		"extension absent":         {"x", RunSpec{MCPServers: json.RawMessage(`{"mcpServers":{"computer":{"type":"http","url":"http://127.0.0.1:1/"}}}`)}},
		"review without extension": {"x", RunSpec{PermissionReviewer: &permission.Reviewer{}}},
	}
	for name, tc := range cases {
		tc.spec.Dir = h.dir
		if _, err := h.runtime.Start(t.Context(), tc.prompt, tc.spec); err == nil {
			t.Errorf("%s: start succeeded", name)
		}
	}
	relative, _ := Open("pi", Profile{Env: map[string]string{piSessionRootKey: "sessions"}})
	if _, err := relative.Start(t.Context(), "x", RunSpec{Dir: h.dir}); err == nil || !strings.Contains(err.Error(), "Context session directory") {
		t.Fatalf("relative root: %v", err)
	}
	missing, _ := Open("pi", Profile{Program: filepath.Join(t.TempDir(), "absent-pi"), Env: map[string]string{piSessionRootKey: h.root}})
	if _, err := missing.Start(t.Context(), "x", RunSpec{Dir: h.dir, AssignSessionID: "missing-program"}); err == nil {
		t.Fatal("absent program started")
	}
	// Every failure above released its lock.
	_, outcome := piCollect(t, h.start(t.Context(), "x", RunSpec{AssignSessionID: "missing-program"}))
	if outcome.Status != statusCompleted {
		t.Fatalf("lock leaked: %+v", outcome)
	}
}

func TestPiSessionLockRefusesConcurrentRun(t *testing.T) {
	h := piNewHarness(t, "steer", nil)
	run := h.start(t.Context(), "hold", RunSpec{AssignSessionID: "busy-session"})
	turn := piWaitRunning(t, run).TurnID
	if _, err := h.runtime.Start(t.Context(), "again", RunSpec{AssignSessionID: "busy-session", Dir: h.dir}); !errors.Is(err, errPiSessionInUse) {
		t.Fatalf("second start = %v", err)
	}
	if _, err := run.Steer(t.Context(), SteerRequest{ExpectedTurnID: turn, Input: "finish"}); err != nil {
		t.Fatal(err)
	}
	piCollect(t, run)
}

// piWaitRunning reads the single running status and records its TurnID.
func piWaitRunning(t *testing.T, run *Run) Event {
	t.Helper()
	select {
	case event := <-run.Events:
		if event.Kind != EventStatus || event.Status != "running" || event.TurnID == "" {
			t.Fatalf("first event = %+v", event)
		}
		return event
	case <-time.After(20 * time.Second):
		t.Fatal("no running status")
	}
	return Event{}
}

func TestPiRetryWaitsForSettle(t *testing.T) {
	h := piNewHarness(t, "retry", nil)
	events, outcome := piCollect(t, h.start(t.Context(), "go", RunSpec{}))
	running := 0
	for _, event := range events {
		if event.Kind == EventStatus {
			running++
			if event.TurnID == "" || event.Status != "running" {
				t.Fatalf("status = %+v", event)
			}
		}
	}
	if running != 1 || outcome.Status != statusCompleted || outcome.Error != "" {
		t.Fatalf("running=%d outcome=%+v", running, outcome)
	}
	if outcome.Usage["fixture/model"].Input != 4 || outcome.LastUsage["fixture/model"].Input != 2 {
		t.Fatalf("usage totals = %+v", outcome)
	}
}

func TestPiSteer(t *testing.T) {
	h := piNewHarness(t, "steer", nil)
	run := h.start(t.Context(), "go", RunSpec{})
	turn := piWaitRunning(t, run).TurnID
	var refused *SteerError
	if _, err := run.Steer(t.Context(), SteerRequest{ExpectedTurnID: "other", Input: "x"}); !errors.As(err, &refused) || refused.Effect != "definitely_not_applied" || refused.ActualTurnID != turn {
		t.Fatalf("mismatched steer = %v", err)
	}
	ack, err := run.Steer(t.Context(), SteerRequest{ExpectedTurnID: turn, Input: "more"})
	if err != nil || ack.TurnID != turn {
		t.Fatalf("steer = %+v, %v", ack, err)
	}
	_, outcome := piCollect(t, run)
	if outcome.Status != statusCompleted {
		t.Fatalf("outcome = %+v", outcome)
	}
	if _, err := run.Steer(t.Context(), SteerRequest{ExpectedTurnID: turn, Input: "late"}); !errors.As(err, &refused) || refused.Effect != "definitely_not_applied" || refused.Reason != "no_active_turn" {
		t.Fatalf("late steer = %v", err)
	}
}

// Pi queues a steer whatever the turn does next; only the user message it
// shows proves the steer was applied. A turn that settles without it did not
// apply it, so the caller may run it again.
func TestPiSteerCompletionRace(t *testing.T) {
	for _, mode := range []string{"steer-race", "steer-unconsumed"} {
		t.Run(mode, func(t *testing.T) {
			h := piNewHarness(t, mode, nil)
			run := h.start(t.Context(), "go", RunSpec{})
			turn := piWaitRunning(t, run).TurnID
			var steerErr *SteerError
			if _, err := run.Steer(t.Context(), SteerRequest{ExpectedTurnID: turn, Input: "more"}); !errors.As(err, &steerErr) || steerErr.Effect != "definitely_not_applied" || steerErr.Reason != "no_active_turn" {
				t.Fatalf("racing steer = %v", err)
			}
			_, outcome := piCollect(t, run)
			if outcome.Status != statusCompleted {
				t.Fatalf("outcome = %+v", outcome)
			}
		})
	}
	h := piNewHarness(t, "steer-race", nil)
	run := h.start(t.Context(), "go", RunSpec{})
	turn := piWaitRunning(t, run).TurnID
	var steerErr *SteerError
	if _, err := run.Steer(t.Context(), SteerRequest{ExpectedTurnID: turn, Input: "more"}); !errors.As(err, &steerErr) || steerErr.Effect != "definitely_not_applied" {
		t.Fatalf("racing steer = %v", err)
	}
	_, outcome := piCollect(t, run)
	if outcome.Status != statusCompleted {
		t.Fatalf("outcome = %+v", outcome)
	}
	if _, err := run.Steer(t.Context(), SteerRequest{ExpectedTurnID: turn, Input: "late"}); !errors.As(err, &steerErr) || steerErr.Effect != "definitely_not_applied" {
		t.Fatalf("late steer = %v", err)
	}
}

func TestPiCompletionRacingAbort(t *testing.T) {
	h := piNewHarness(t, "complete-on-abort", nil)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	run := h.start(ctx, "go", RunSpec{})
	piWaitRunning(t, run)
	cancel()
	_, out := piCollect(t, run)
	if out.Status != statusCompleted || out.Output != "done" || !out.ExitConfirmed || out.ExitUnconfirmed {
		t.Fatalf("outcome = %+v", out)
	}
}

func TestPiCancelClearsQueueAndReapsChildren(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "child.pid")
	commands := filepath.Join(t.TempDir(), "commands")
	h := piNewHarness(t, "cancel", map[string]string{piFakeChildEnv: pidFile, piFakeLogEnv: commands})
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	run := h.start(ctx, "go", RunSpec{})
	piWaitRunning(t, run)
	piWaitFile(t, pidFile)
	cancel()
	_, outcome := piCollect(t, run)
	if outcome.Status != piStatusCancelled || !outcome.ExitConfirmed || outcome.ExitUnconfirmed {
		t.Fatalf("outcome = %+v", outcome)
	}
	if outcome.Diagnostics.ExitCode != nil {
		t.Fatalf("cancelled run carried exit diagnostics: %+v", outcome.Diagnostics)
	}
	if log, _ := os.ReadFile(commands); string(log) != "get_state\nprompt\nclear_queue\nabort\n" {
		t.Fatalf("commands = %q", log)
	}
	data, _ := os.ReadFile(pidFile)
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	if !piProcessGone(pid) {
		t.Fatalf("child %d survived cleanup", pid)
	}
}

func piWaitFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(path); err == nil && strings.HasSuffix(string(data), "\n") {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no file at %s", path)
}

func TestPiPrematureExit(t *testing.T) {
	h := piNewHarness(t, "exit-early", nil)
	_, outcome := piCollect(t, h.start(t.Context(), "go", RunSpec{}))
	if outcome.Status != statusFailed || !strings.Contains(outcome.Error, "settled") {
		t.Fatalf("outcome = %+v", outcome)
	}
	if outcome.Diagnostics.ExitCode == nil || *outcome.Diagnostics.ExitCode != 0 {
		t.Fatalf("diagnostics = %+v", outcome.Diagnostics)
	}
}

func TestPiHandledPromptDoesNotWaitForSettle(t *testing.T) {
	h := piNewHarness(t, "handled", nil)
	began := time.Now()
	_, outcome := piCollect(t, h.start(t.Context(), "/command", RunSpec{}))
	if outcome.Status != statusFailed || !strings.Contains(outcome.Error, "did not start") || !outcome.ExitConfirmed {
		t.Fatalf("outcome = %+v", outcome)
	}
	if elapsed := time.Since(began); elapsed > 10*time.Second {
		t.Fatalf("handled prompt waited %s", elapsed)
	}
}

func TestPiRecoverableToolFailure(t *testing.T) {
	h := piNewHarness(t, "tool-failure", nil)
	events, outcome := piCollect(t, h.start(t.Context(), "go", RunSpec{}))
	found := false
	for _, event := range events {
		if event.Kind == EventToolOutput && event.ToolName == "bash" && event.Status == "failed" && event.Output == "output of call_bash" {
			found = true
		}
	}
	if !found || outcome.Status != statusCompleted {
		t.Fatalf("events=%+v outcome=%+v", events, outcome)
	}
}

func TestPiAnswersTheManagedExtensionsReview(t *testing.T) {
	extension := filepath.Join(t.TempDir(), "pi-mcp.mjs")
	if err := os.WriteFile(extension, []byte("export default {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name     string
		reviewer bool
		want     piVerdict
	}{
		{name: "without review", want: piVerdict{Allow: true}},
		{name: "denied", reviewer: true, want: piVerdict{Message: "not now"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			dialogs := filepath.Join(t.TempDir(), "dialogs")
			h := piNewHarness(t, "review", map[string]string{piFakeDialogEnv: dialogs})
			h.runtime, _ = Open("pi", Profile{Program: h.runtime.(*piRuntime).profile.Program, Env: h.env, ManagedMCPExtension: extension})
			requester := agyDenyingRequester{asked: make(chan string, 1)}
			spec := RunSpec{}
			if c.reviewer {
				spec.PermissionReviewer = &permission.Reviewer{Requester: requester, Timeout: time.Minute}
			}
			if _, outcome := piCollect(t, h.start(t.Context(), "push it", spec)); outcome.Status != statusCompleted {
				t.Fatalf("outcome = %+v", outcome)
			}
			if asked := len(requester.asked); asked != map[bool]int{true: 1}[c.reviewer] {
				t.Fatalf("reviews asked = %d", asked)
			}
			data, _ := os.ReadFile(dialogs)
			answers := map[string]map[string]any{}
			for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
				var answer map[string]any
				if json.Unmarshal([]byte(line), &answer) != nil {
					t.Fatalf("answer %q", line)
				}
				answers[answer["id"].(string)] = answer
			}
			if len(answers) != 2 || answers["ui-other"]["cancelled"] != true {
				t.Fatalf("answers = %v", answers)
			}
			var verdict piVerdict
			if value, _ := answers["ui-review"]["value"].(string); json.Unmarshal([]byte(value), &verdict) != nil || verdict != c.want {
				t.Fatalf("verdict = %+v, want %+v", verdict, c.want)
			}
		})
	}
}

func TestPiCompositeToolIDs(t *testing.T) {
	h := piNewHarness(t, "composite", nil)
	events, outcome := piCollect(t, h.start(t.Context(), "go", RunSpec{}))
	gateway := regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	starts := map[string]bool{}
	var ends []string
	for _, event := range events {
		switch event.Kind {
		case EventToolCall:
			if !gateway.MatchString(event.InvocationID) || len(event.InvocationID) != 72 || event.Input["command"] != "ls" {
				t.Fatalf("call = %+v", event)
			}
			starts[event.InvocationID] = true
		case EventToolOutput:
			ends = append(ends, event.InvocationID)
		}
	}
	if len(starts) != 2 || len(ends) != 2 || !starts[ends[0]] || !starts[ends[1]] || ends[0] == ends[1] || outcome.Status != statusCompleted {
		t.Fatalf("starts=%v ends=%v outcome=%+v", starts, ends, outcome)
	}
	if piInvocationID("call_shared|fc_first") != ends[0] {
		t.Fatal("identity is not deterministic")
	}
}

func piLargePrompt() string {
	return strings.Repeat("Invite française \"quoted\" --flag \\path\\ ", 20000)
}

func TestPiInputUnderPipePressure(t *testing.T) {
	prompt := piLargePrompt()
	for _, mode := range []string{"finish", "pressure"} {
		t.Run(mode, func(t *testing.T) {
			record := filepath.Join(t.TempDir(), "prompt")
			argv := filepath.Join(t.TempDir(), "argv")
			h := piNewHarness(t, mode, map[string]string{piFakeRecordEnv: record, piFakeArgvEnv: argv})
			_, outcome := piCollect(t, h.start(t.Context(), prompt, RunSpec{}))
			if outcome.Status != statusCompleted {
				t.Fatalf("outcome = %+v", outcome)
			}
			got, err := os.ReadFile(record)
			if err != nil || string(got) != prompt {
				t.Fatalf("recorded prompt differs (%d bytes, %v)", len(got), err)
			}
			args, err := os.ReadFile(argv)
			if err != nil || strings.Contains(string(args), "quoted") {
				t.Fatalf("argv carried prompt text: %v", err)
			}
		})
	}
	t.Run("blocked", func(t *testing.T) {
		// The blocked fake answers neither abort nor stdin close, so both
		// waits expire before the stop escalates to signals.
		shortenForTest(t, &piAbortBudget, 200*time.Millisecond)
		shortenForTest(t, &piExitWait, 200*time.Millisecond)
		h := piNewHarness(t, "blocked", nil)
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		run := h.start(ctx, prompt, RunSpec{})
		time.Sleep(200 * time.Millisecond)
		began := time.Now()
		cancel()
		_, outcome := piCollect(t, run)
		if outcome.Status != piStatusCancelled || time.Since(began) > 15*time.Second {
			t.Fatalf("outcome = %+v after %s", outcome, time.Since(began))
		}
	})
}

func TestPiBudgetTimeout(t *testing.T) {
	h := piNewHarness(t, "steer", nil)
	_, outcome := piCollect(t, h.start(t.Context(), "go", RunSpec{Budget: 300 * time.Millisecond}))
	if outcome.Status != statusTimeout || outcome.Error == "" || outcome.Diagnostics.ExitCode != nil {
		t.Fatalf("outcome = %+v", outcome)
	}
}

func TestPiLaunchArguments(t *testing.T) {
	argv := filepath.Join(t.TempDir(), "argv")
	extension := filepath.Join(t.TempDir(), "mcp-extension.js")
	if err := os.WriteFile(extension, []byte("export default {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	h := piNewHarness(t, "finish", map[string]string{piFakeArgvEnv: argv})
	h.runtime, _ = Open("pi", Profile{Program: h.runtime.(*piRuntime).profile.Program, Env: h.env, ManagedMCPExtension: extension})
	if err := os.MkdirAll(filepath.Join(h.dir, ".agents", "skills"), 0o700); err != nil {
		t.Fatal(err)
	}
	mcp := json.RawMessage(`{"mcpServers":{"computer":{"type":"http","url":"http://127.0.0.1:9/mcp"}}}`)
	_, outcome := piCollect(t, h.start(t.Context(), "go", RunSpec{AssignSessionID: "args-session", Model: "fixture/model", Effort: "none", Title: "Title", SystemPrompt: "be brief", ContextWindow: 65536, MCPServers: mcp}))
	if outcome.Status != statusCompleted || !outcome.ExitConfirmed {
		t.Fatalf("outcome = %+v", outcome)
	}
	data, _ := os.ReadFile(argv)
	sessionDir := filepath.Join(h.root, "args-session")
	want := append([]string{"--mode", "rpc", "--session-dir", sessionDir, "--session-id", "args-session"}, PiRPCResourceArgs(filepath.Join(sessionDir, piInstructionsName))...)
	want = append(want, "--model", "fixture/model", "--thinking", "off", "--name", "Title",
		"--skill", filepath.Join(h.dir, ".agents", "skills"), "--extension", extension, "--tools", piBaseTools+",tool_search,mcp__*")
	if got := strings.Split(string(data), "\n"); strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("argv\n got %q\nwant %q", got, want)
	}
	if nodePath, _ := os.ReadFile(argv + ".node_path"); string(nodePath) != filepath.Join(filepath.Dir(filepath.Dir(extension)), "node_modules") {
		t.Fatalf("NODE_PATH = %q", nodePath)
	}
	if cw, _ := os.ReadFile(argv + ".context_window"); string(cw) != "65536" {
		t.Fatalf("LINGER_PI_CONTEXT_WINDOW = %q", cw)
	}
	instructions, err := os.ReadFile(filepath.Join(sessionDir, piInstructionsName))
	if err != nil || string(instructions) != "be brief" {
		t.Fatalf("instructions = %q, %v", instructions, err)
	}
	if _, err := os.Stat(filepath.Join(sessionDir, piMCPConfigName)); !os.IsNotExist(err) {
		t.Fatalf("MCP config survived confirmed cleanup: %v", err)
	}

	// Without MCP servers, the installed managed extension still loads for
	// prompt hygiene and compaction capping, without enabling tool_search/mcp.
	_, outcome = piCollect(t, h.start(t.Context(), "go", RunSpec{Model: piDefaultModel}))
	data, _ = os.ReadFile(argv)
	if outcome.Status != statusCompleted || strings.Contains(string(data), "--model") || strings.Contains(string(data), "--thinking") ||
		!strings.Contains(string(data), "--extension\n"+extension) || !strings.HasSuffix(string(data), "--tools\n"+piBaseTools) {
		t.Fatalf("default argv = %q (%+v)", data, outcome)
	}
	if cw, _ := os.ReadFile(argv + ".context_window"); len(cw) != 0 {
		t.Fatalf("context window without value = %q", cw)
	}

	// Without a configured extension, neither --extension nor NODE_PATH is set.
	noExt := piNewHarness(t, "finish", map[string]string{piFakeArgvEnv: argv})
	_, outcome = piCollect(t, noExt.start(t.Context(), "go", RunSpec{Model: piDefaultModel}))
	data, _ = os.ReadFile(argv)
	if outcome.Status != statusCompleted || strings.Contains(string(data), "--extension") || !strings.HasSuffix(string(data), "--tools\n"+piBaseTools) {
		t.Fatalf("no-extension argv = %q (%+v)", data, outcome)
	}
	if nodePath, _ := os.ReadFile(argv + ".node_path"); len(nodePath) != 0 {
		t.Fatalf("NODE_PATH without an extension = %q", nodePath)
	}

	// The managed extension runs the shell-text-hook without MCP servers.
	_, outcome = piCollect(t, h.start(t.Context(), "go", RunSpec{Model: piDefaultModel, ShellTextHook: "/opt/linger/linger-computer-daemon"}))
	data, _ = os.ReadFile(argv)
	if outcome.Status != statusCompleted || !strings.HasSuffix(string(data), "--extension\n"+extension+"\n--tools\n"+piBaseTools) {
		t.Fatalf("shell text argv = %q (%+v)", data, outcome)
	}
	if hook, _ := os.ReadFile(argv + ".shell_text_hook"); string(hook) != "/opt/linger/linger-computer-daemon" {
		t.Fatalf("%s = %q", piShellTextHookEnvKey, hook)
	}
	if nodePath, _ := os.ReadFile(argv + ".node_path"); string(nodePath) != filepath.Join(filepath.Dir(filepath.Dir(extension)), "node_modules") {
		t.Fatalf("NODE_PATH = %q", nodePath)
	}
}

func TestPiExtensionNodePath(t *testing.T) {
	extension := filepath.Join("tools", "extensions", "pi-mcp.mjs")
	modules := filepath.Join("tools", "node_modules")
	env := map[string]string{}
	piExtensionNodePath(env, extension)
	if env[piNodePathKey] != modules || env[piInheritedNodePathKey] != "" || len(env) != 2 {
		t.Fatalf("fresh env = %q", env)
	}
	env = map[string]string{"Node_Path": "own"}
	piExtensionNodePath(env, extension)
	if len(env) != 2 || env["Node_Path"] != modules+string(filepath.ListSeparator)+"own" || env[piInheritedNodePathKey] != "own" {
		t.Fatalf("existing NODE_PATH = %q", env)
	}
}

func TestPiThinkingLevels(t *testing.T) {
	for effort, want := range map[string]string{"": "", "none": "off", "off": "off", "minimal": "minimal", "xhigh": "xhigh", "max": "max"} {
		if got, err := piThinkingLevel(effort); err != nil || got != want {
			t.Errorf("%q -> %q, %v", effort, got, err)
		}
	}
	if _, err := piThinkingLevel("ultra"); err == nil {
		t.Error("ultra accepted")
	}
}

func TestPiMCPPreparation(t *testing.T) {
	dir := t.TempDir()
	servers := json.RawMessage("{\"mcpServers\": {\"computer\": {\"type\":\"http\",\"url\":\"http://127.0.0.1:9/\",\"tool_timeout_sec\": 1.50}}}\n")
	if _, err := piPrepareMCP(servers, "", dir); err == nil || !strings.Contains(err.Error(), "repair") {
		t.Fatalf("no extension: %v", err)
	}
	if _, err := piPrepareMCP(servers, filepath.Join(dir, "absent.js"), dir); err == nil {
		t.Fatal("missing extension accepted")
	}
	extension := filepath.Join(dir, "extension.js")
	if err := os.WriteFile(extension, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	wiring, err := piPrepareMCP(servers, extension, dir)
	if err != nil || !wiring.wired() {
		t.Fatalf("wiring = %+v, %v", wiring, err)
	}
	data, err := os.ReadFile(wiring.configPath)
	if err != nil || string(data) != string(servers) {
		t.Fatalf("config = %q, %v", data, err)
	}
	if info, err := os.Stat(wiring.configPath); err != nil || !privateModeMatches(info, 0o600) {
		t.Fatalf("config mode: %v", err)
	}
	wiring.remove()
	if _, err := os.Stat(wiring.configPath); !os.IsNotExist(err) {
		t.Fatal("config not removed")
	}
	for _, raw := range []json.RawMessage{nil, json.RawMessage(" null "), json.RawMessage(`{"mcpServers":{}}`), json.RawMessage(`{}`)} {
		if wiring, err := piPrepareMCP(raw, "", dir); err != nil || wiring.wired() {
			t.Fatalf("%q: %+v, %v", raw, wiring, err)
		}
	}
	if _, err := piPrepareMCP(json.RawMessage(`{"mcpServers":[]}`), extension, dir); err == nil {
		t.Fatal("non-object mcpServers accepted")
	}
}

func TestPiSessionValidation(t *testing.T) {
	sessionDir, contextDir := t.TempDir(), t.TempDir()
	id := "valid-session"
	write := func(name, header string) {
		if err := os.WriteFile(filepath.Join(sessionDir, name), []byte(header+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if piValidateSession(sessionDir, id, contextDir) == nil {
		t.Fatal("empty session validated")
	}
	cwd, _ := json.Marshal(contextDir)
	write("x_other.jsonl", `{"type":"session","id":"other","cwd":`+string(cwd)+`}`)
	write("y_"+id+".jsonl", `{"type":"session","id":"wrong","cwd":`+string(cwd)+`}`)
	write("z_"+id+".jsonl", `{"type":"session","id":"`+id+`","cwd":"/elsewhere"}`)
	if piValidateSession(sessionDir, id, contextDir) == nil {
		t.Fatal("mismatched headers validated")
	}
	target := filepath.Join(t.TempDir(), "real.jsonl")
	if err := os.WriteFile(target, []byte(`{"type":"session","id":"`+id+`","cwd":`+string(cwd)+`}`), 0o600); err == nil {
		if os.Symlink(target, filepath.Join(sessionDir, "link_"+id+".jsonl")) == nil && piValidateSession(sessionDir, id, contextDir) == nil {
			t.Fatal("symlinked transcript validated")
		}
	}
	write("a_"+id+".jsonl", `{"type":"session","id":"`+id+`","cwd":`+string(cwd)+`}`)
	if err := piValidateSession(sessionDir, id, contextDir); err != nil {
		t.Fatal(err)
	}
}

func TestPiResourceArgsAreFresh(t *testing.T) {
	first := PiRPCResourceArgs("")
	first[0] = "changed"
	_ = append(first, "--extra")
	if got := PiRPCResourceArgs("prompt.md"); len(got) != 10 || got[0] != "--no-extensions" || got[5] != "--no-approve" ||
		got[6] != "--system-prompt" || got[7] != "prompt.md" || got[8] != "--append-system-prompt" || got[9] != "" {
		t.Fatalf("args = %v", got)
	}
}

func TestPiCatalogCorrelationAndCapabilities(t *testing.T) {
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	invocation := NewInvocation(program, nil).WithEnvironment(map[string]string{piFakeEnv: "catalog"})
	list, err := DiscoverModels(t.Context(), "pi", invocation)
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Models) != 2 {
		t.Fatalf("models = %+v", list.Models)
	}
	first, second := list.Models[0], list.Models[1]
	if first.ID != "fixture/reasoner" || first.Label != first.ID || first.Provider != "fixture" || !first.Default || first.Effort == nil || first.Effort.Default != "high" {
		t.Fatalf("first = %+v", first)
	}
	var values, labels []string
	for _, option := range first.Effort.Options {
		values = append(values, option.Value)
		labels = append(labels, option.Label)
	}
	if strings.Join(values, ",") != "none,low,medium,high,max" || labels[0] != "Off" {
		t.Fatalf("efforts = %v %v", values, labels)
	}
	if second.ID != "fixture/fast" || second.Default || second.Effort != nil {
		t.Fatalf("second = %+v", second)
	}
}

func TestPiCatalogFailures(t *testing.T) {
	if _, err := DiscoverPiModels(t.Context(), NewInvocation(filepath.Join(t.TempDir(), "absent"), nil)); err == nil {
		t.Fatal("absent program discovered")
	}
	program, _ := os.Executable()
	silent := NewInvocation(program, nil).WithEnvironment(map[string]string{fixtureEnvKey: "print", "FIXTURE_STDOUT": `{"type":"response","id":"linger-state","command":"get_state","success":false}` + "\n"})
	if _, err := DiscoverPiModels(t.Context(), silent); err == nil || err.Error() != errPiNoModels.Error() {
		t.Fatalf("rejected reply = %v", err)
	}
	state := piCatalogState{}
	list, err := piCatalogList(state, nil)
	if err != nil || list.Models == nil || len(list.Models) != 0 {
		t.Fatalf("empty catalog = %+v, %v", list, err)
	}
}

func TestPiCatalogCarriesTheDeclaredContextWindow(t *testing.T) {
	list, err := piCatalogList(piCatalogState{}, []json.RawMessage{
		json.RawMessage(`{"id":"qwen","provider":"local","contextWindow":131072}`),
		json.RawMessage(`{"id":"half","provider":"local","contextWindow":1.5e5}`),
		json.RawMessage(`{"id":"text","provider":"local","contextWindow":"131072"}`),
		json.RawMessage(`{"id":"none","provider":"local"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	var windows []int
	for _, model := range list.Models {
		windows = append(windows, model.ContextWindow)
	}
	if !slices.Equal(windows, []int{131072, 0, 0, 0}) {
		t.Fatalf("context windows = %v", windows)
	}
}

func TestPiCatalogLabelsAModelByItsName(t *testing.T) {
	list, err := piCatalogList(piCatalogState{}, []json.RawMessage{
		json.RawMessage(`{"id":"localmodels-agent","name":"ling-3.0-tiny","provider":"localmodels"}`),
		json.RawMessage(`{"id":"same","name":"same","provider":"local"}`),
		json.RawMessage(`{"id":"blank","name":" ","provider":"local"}`),
		json.RawMessage(`{"id":"unnamed","provider":"local"}`),
		json.RawMessage(`{"id":"q4","name":"Qwen 27B","provider":"localmodels-library"}`),
		json.RawMessage(`{"id":"q4","name":"Qwen 27B","provider":"other"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	var ids, labels []string
	for _, model := range list.Models {
		ids = append(ids, model.ID)
		labels = append(labels, model.Label)
	}
	if !slices.Equal(ids, []string{"localmodels/localmodels-agent", "local/same", "local/blank", "local/unnamed", "localmodels-library/q4", "other/q4"}) {
		t.Fatalf("ids = %v", ids)
	}
	if !slices.Equal(labels, []string{"ling-3.0-tiny", "local/same", "local/blank", "local/unnamed", "Qwen 27B (localmodels-library/q4)", "Qwen 27B (other/q4)"}) {
		t.Fatalf("labels = %v", labels)
	}
}

func TestPiEffortSupportDefaults(t *testing.T) {
	support := piEffortSupport(map[string]json.RawMessage{"xhigh": json.RawMessage(`"x"`)}, "off")
	var values []string
	for _, option := range support.Options {
		values = append(values, option.Value)
	}
	if strings.Join(values, ",") != "none,minimal,low,medium,high,xhigh" || support.Default != "none" {
		t.Fatalf("support = %+v", support)
	}
	all := map[string]json.RawMessage{}
	for _, level := range []string{"off", "minimal", "low", "medium", "high"} {
		all[level] = json.RawMessage("null")
	}
	if piEffortSupport(all, "") != nil {
		t.Fatal("no permitted level still offered effort")
	}
}
