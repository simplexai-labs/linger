package native

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
)

type agyHarness struct {
	dir     string
	record  string
	runtime Runtime
	inv     Invocation
}

func newAgyHarness(t *testing.T, mode string, extra map[string]string) agyHarness {
	t.Helper()
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	record := filepath.Join(t.TempDir(), "requests.jsonl")
	env := map[string]string{agyFakeEnv: mode, agyFakeRecordEnv: record, "HOME": dir}
	for key, value := range extra {
		env[key] = value
	}
	return agyHarness{
		dir: dir, record: record,
		runtime: newAntigravityRuntime(Profile{Program: program, Env: env}),
		inv:     NewInvocation(program, nil).WithEnvironment(env),
	}
}

// requests returns the recorded client requests by method, in order.
func (h agyHarness) requests(t *testing.T) map[string][]map[string]any {
	t.Helper()
	file, err := os.Open(h.record)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	out := map[string][]map[string]any{}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		var frame map[string]any
		if json.Unmarshal(scanner.Bytes(), &frame) != nil {
			t.Fatalf("recorded frame is not JSON: %s", scanner.Text())
		}
		method, _ := frame["method"].(string)
		out[method] = append(out[method], frame)
	}
	return out
}

func drainAgy(t *testing.T, run *Run) ([]Event, Outcome) {
	t.Helper()
	var events []Event
	timeout := time.After(30 * time.Second)
	for {
		select {
		case event, ok := <-run.Events:
			if !ok {
				outcome, ok := <-run.Outcome
				if !ok {
					t.Fatal("outcome closed without a value")
				}
				return events, outcome
			}
			events = append(events, event)
		case <-timeout:
			t.Fatal("Antigravity run did not finish")
		}
	}
}

func TestAntigravityRunsOneTurnOverACP(t *testing.T) {
	h := newAgyHarness(t, "turn", nil)
	run, err := h.runtime.Start(t.Context(), "list files", RunSpec{
		Dir: h.dir, Model: "gemini-flash", Effort: "medium", SystemPrompt: "Be brief.",
		MCPServers: json.RawMessage(`{"mcpServers":{"teamhub":{"type":"http","url":"http://127.0.0.1:9/mcp","headers":{"Authorization":"Bearer x"}},"local":{"command":"/bin/tool","args":["--stdio"],"env":{"A":"1"}}}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	events, outcome := drainAgy(t, run)
	if outcome.Status != statusCompleted || outcome.SessionID != "fake-session" || outcome.Output != "Found a.txt" || !outcome.ExitConfirmed {
		t.Fatalf("outcome=%+v", outcome)
	}
	if usage := outcome.Usage["gemini-flash"]; usage != (TokenCount{Input: 7, Output: 6, CacheRead: 3, Reasoning: 2}) {
		t.Fatalf("usage=%+v", outcome.Usage)
	}
	var kinds []EventKind
	var call, result Event
	for _, event := range events {
		kinds = append(kinds, event.Kind)
		switch event.Kind {
		case EventToolCall:
			call = event
		case EventToolOutput:
			result = event
		}
	}
	want := []EventKind{EventReasoning, EventText, EventPlan, EventToolCall, EventToolOutput, EventText, EventText, EventModelResponse}
	if !reflect.DeepEqual(kinds, want) {
		t.Fatalf("kinds=%v", kinds)
	}
	if call.ToolName != "run_command" || call.ActivityKind != ActivityCommand || call.InvocationID != result.InvocationID || call.Input["command"] != "ls" || result.Output != "a.txt" || result.Status != "completed" {
		t.Fatalf("call=%+v result=%+v", call, result)
	}
	if events[1].ID == events[5].ID || events[5].ID != events[6].ID {
		t.Fatal("text after a tool call must start a new message")
	}

	requests := h.requests(t)
	open := requests["session/new"][0]["params"].(map[string]any)
	if open["cwd"] != h.dir {
		t.Fatalf("cwd=%v", open["cwd"])
	}
	if appended := open["_meta"].(map[string]any)["antigravity"].(map[string]any)["systemPrompt"].(map[string]any)["append"]; appended != "Be brief." {
		t.Fatalf("append=%v", appended)
	}
	servers, _ := json.Marshal(open["mcpServers"])
	if string(servers) != `[{"args":["--stdio"],"command":"/bin/tool","env":[{"name":"A","value":"1"}],"name":"local"},{"headers":[{"name":"Authorization","value":"Bearer x"}],"name":"teamhub","type":"http","url":"http://127.0.0.1:9/mcp"}]` {
		t.Fatalf("mcpServers=%s", servers)
	}
	var options []string
	for _, frame := range requests["session/set_config_option"] {
		params := frame["params"].(map[string]any)
		options = append(options, params["configId"].(string)+"="+params["value"].(string))
	}
	if !reflect.DeepEqual(options, []string{"model=gemini-flash", "thought_level=medium"}) {
		t.Fatalf("options=%v", options)
	}
	if len(requests["authenticate"]) != 0 {
		t.Fatal("a signed-in Antigravity must not be re-authenticated")
	}
}

func TestAntigravityResumesWithSessionLoadAndDropsTheReplay(t *testing.T) {
	h := newAgyHarness(t, "turn", nil)
	run, err := h.runtime.Start(t.Context(), "again", RunSpec{Dir: h.dir, ResumeID: "earlier-session"})
	if err != nil {
		t.Fatal(err)
	}
	events, outcome := drainAgy(t, run)
	if outcome.Status != statusCompleted || outcome.SessionID != "earlier-session" {
		t.Fatalf("outcome=%+v", outcome)
	}
	for _, event := range events {
		if event.Kind == EventText && event.Body == "earlier reply" {
			t.Fatal("the replayed history reached the turn's events")
		}
	}
	requests := h.requests(t)
	if len(requests["session/load"]) != 1 || len(requests["session/new"]) != 0 || len(requests["session/set_config_option"]) != 0 {
		t.Fatalf("requests=%v", requests)
	}
}

func TestAntigravityAnswersPermissionRequestsWithoutReview(t *testing.T) {
	h := newAgyHarness(t, "permission", nil)
	run, err := h.runtime.Start(t.Context(), "list files", RunSpec{Dir: h.dir})
	if err != nil {
		t.Fatal(err)
	}
	if _, outcome := drainAgy(t, run); outcome.Status != statusCompleted {
		t.Fatalf("outcome=%+v", outcome)
	}
	answers := h.requests(t)[""]
	if len(answers) != 1 {
		t.Fatalf("answers=%v", answers)
	}
	selected := answers[0]["result"].(map[string]any)["outcome"].(map[string]any)
	if selected["outcome"] != "selected" || selected["optionId"] != "allow" {
		t.Fatalf("selected=%v", selected)
	}
}

// agyDenyingRequester answers every permission review with a denial.
type agyDenyingRequester struct{ asked chan string }

func (r agyDenyingRequester) Request(id string, _ map[string]any, respond func(json.RawMessage) error) error {
	r.asked <- id
	return respond(json.RawMessage(`{"decision":"deny","message":"not now"}`))
}

func (agyDenyingRequester) Forget(string) {}

func TestAntigravityAnswersADeniedPermissionReview(t *testing.T) {
	for _, c := range []struct{ mode, outcome, option string }{
		{mode: "permission", outcome: "selected", option: "deny"},
		{mode: "permission-no-reject", outcome: "cancelled"},
	} {
		t.Run(c.mode, func(t *testing.T) {
			h := newAgyHarness(t, c.mode, map[string]string{agyFakeCommandEnv: "git push"})
			requester := agyDenyingRequester{asked: make(chan string, 1)}
			reviewer := &permission.Reviewer{Requester: requester, Timeout: time.Minute}
			run, err := h.runtime.Start(t.Context(), "push it", RunSpec{Dir: h.dir, PermissionReviewer: reviewer})
			if err != nil {
				t.Fatal(err)
			}
			if _, outcome := drainAgy(t, run); outcome.Status != statusCompleted {
				t.Fatalf("outcome=%+v", outcome)
			}
			if len(requester.asked) != 1 {
				t.Fatal("the command was not reviewed")
			}
			answers := h.requests(t)[""]
			if len(answers) != 1 {
				t.Fatalf("answers=%v", answers)
			}
			selected := answers[0]["result"].(map[string]any)["outcome"].(map[string]any)
			if selected["outcome"] != c.outcome || (c.option != "" && selected["optionId"] != c.option) {
				t.Fatalf("selected=%v", selected)
			}
		})
	}
}

func TestAntigravityReportsAnUnknownRetainedSessionAsNotFound(t *testing.T) {
	for _, mode := range []string{"unknown-session", "load-error"} {
		t.Run(mode, func(t *testing.T) {
			h := newAgyHarness(t, mode, nil)
			run, err := h.runtime.Start(t.Context(), "again", RunSpec{Dir: h.dir, ResumeID: "moved-session", ExposeTurnStarted: true})
			if err != nil {
				t.Fatal(err)
			}
			events, outcome := drainAgy(t, run)
			if outcome.Status != statusFailed || outcome.FailureCode != "session_not_found" || !outcome.ResumeRefused || outcome.SessionID != "" {
				t.Fatalf("outcome=%+v", outcome)
			}
			// The Run started on the retained session before agy refused it.
			if len(events) != 1 || events[0].Kind != EventStatus || events[0].SessionID != "moved-session" {
				t.Fatalf("events=%+v", events)
			}
			if requests := h.requests(t); len(requests["session/prompt"]) != 0 {
				t.Fatalf("requests=%v", requests)
			}
		})
	}
}

func TestAntigravityReportsStructuredFailures(t *testing.T) {
	signedOut := newAgyHarness(t, "signed-out", nil)
	run, err := signedOut.runtime.Start(t.Context(), "hi", RunSpec{Dir: signedOut.dir})
	if err != nil {
		t.Fatal(err)
	}
	if _, outcome := drainAgy(t, run); outcome.Status != statusFailed || outcome.FailureCode != "authentication_required" {
		t.Fatalf("signed out outcome=%+v", outcome)
	}

	unknown := newAgyHarness(t, "turn", nil)
	run, err = unknown.runtime.Start(t.Context(), "hi", RunSpec{Dir: unknown.dir, Model: "unknown-model"})
	if err != nil {
		t.Fatal(err)
	}
	if _, outcome := drainAgy(t, run); outcome.Status != statusFailed || outcome.FailureCode != "model_not_offered" {
		t.Fatalf("unknown model outcome=%+v", outcome)
	}
}

func TestAntigravityUsesAGeminiAPIKeyOnlyWhenSignedOut(t *testing.T) {
	h := newAgyHarness(t, "signed-out", map[string]string{"GEMINI_API_KEY": "fixture-key"})
	run, err := h.runtime.Start(t.Context(), "hi", RunSpec{Dir: h.dir})
	if err != nil {
		t.Fatal(err)
	}
	if _, outcome := drainAgy(t, run); outcome.Status != statusCompleted {
		t.Fatalf("outcome=%+v", outcome)
	}
	requests := h.requests(t)
	if len(requests["authenticate"]) != 1 || len(requests["session/new"]) != 2 {
		t.Fatalf("requests=%v", requests)
	}
}

func TestAntigravityTimeoutStopsTheProcess(t *testing.T) {
	h := newAgyHarness(t, "hang", nil)
	run, err := h.runtime.Start(t.Context(), "hi", RunSpec{Dir: h.dir, Budget: 500 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	_, outcome := drainAgy(t, run)
	if outcome.Status != statusTimeout || !outcome.ExitConfirmed {
		t.Fatalf("outcome=%+v", outcome)
	}
	if len(h.requests(t)["session/cancel"]) != 1 {
		t.Fatal("a timed-out prompt must be cancelled")
	}
}

func TestAntigravityProbeListsModelFamiliesWithTheirLevels(t *testing.T) {
	h := newAgyHarness(t, "turn", nil)
	probe, err := ProbeAntigravity(t.Context(), h.inv)
	if err != nil {
		t.Fatal(err)
	}
	if probe.AuthenticationRequired || len(probe.Models.Models) != 2 {
		t.Fatalf("probe=%+v", probe)
	}
	pro, flash := probe.Models.Models[0], probe.Models.Models[1]
	if pro.ID != "gemini-pro" || pro.Label != "Gemini Pro" || !pro.Default || pro.Effort == nil || pro.Effort.Default != "low" || len(pro.Effort.Options) != 2 || pro.Effort.Options[0].Value != "low" {
		t.Fatalf("pro=%+v effort=%+v", pro, pro.Effort)
	}
	if flash.ID != "gemini-flash" || flash.Default || flash.Effort == nil || flash.Effort.Default != "" || flash.Effort.Options[0].Value != "medium" {
		t.Fatalf("flash=%+v effort=%+v", flash, flash.Effort)
	}
	if len(h.requests(t)["session/prompt"]) != 0 {
		t.Fatal("a probe must not send a prompt")
	}

	signedOut := newAgyHarness(t, "signed-out", nil)
	if probe, err := ProbeAntigravity(t.Context(), signedOut.inv); err != nil || !probe.AuthenticationRequired {
		t.Fatalf("signed out probe=%+v err=%v", probe, err)
	}
}

func TestAntigravityProbeIsolatesStateAndSeedsCredentials(t *testing.T) {
	metaFile := filepath.Join(t.TempDir(), "probe-meta.json")
	h := newAgyHarness(t, "token-file", map[string]string{agyFakeMetaEnv: metaFile})
	userAppData := filepath.Join(h.dir, ".gemini", "antigravity-cli")
	userConvs := filepath.Join(userAppData, "conversations")
	if err := os.MkdirAll(userConvs, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userAppData, "antigravity-oauth-token"), []byte("oauth-fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userAppData, "settings.json"), []byte(`{"theme":"dark"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userConvs, "real-session.db"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}

	probe, err := ProbeAntigravity(t.Context(), h.inv)
	if err != nil {
		t.Fatal(err)
	}
	if probe.AuthenticationRequired || len(probe.Models.Models) != 2 {
		t.Fatalf("probe=%+v", probe)
	}

	rawMeta, err := os.ReadFile(metaFile)
	if err != nil {
		t.Fatal(err)
	}
	var meta struct {
		Args      []string `json:"args"`
		GeminiDir string   `json:"geminiDir"`
		LogFile   string   `json:"logFile"`
		Home      string   `json:"home"`
		Token     string   `json:"token"`
		Settings  string   `json:"settings"`
	}
	if err := json.Unmarshal(rawMeta, &meta); err != nil {
		t.Fatal(err)
	}
	if meta.Home != h.dir {
		t.Fatalf("HOME was altered: got %q want %q", meta.Home, h.dir)
	}
	if !filepath.IsAbs(meta.GeminiDir) || meta.GeminiDir == filepath.Join(h.dir, ".gemini") {
		t.Fatalf("unexpected geminiDir: %q", meta.GeminiDir)
	}
	if !filepath.IsAbs(meta.LogFile) || filepath.Dir(meta.LogFile) != filepath.Dir(meta.GeminiDir) {
		t.Fatalf("unexpected logFile: %q (geminiDir=%q)", meta.LogFile, meta.GeminiDir)
	}
	if meta.Token != "oauth-fixture" || meta.Settings != `{"theme":"dark"}` {
		t.Fatalf("seeded files mismatch: token=%q settings=%q", meta.Token, meta.Settings)
	}
	if _, err := os.Stat(filepath.Dir(meta.GeminiDir)); !os.IsNotExist(err) {
		t.Fatalf("temporary probe root was not removed: %q (err=%v)", filepath.Dir(meta.GeminiDir), err)
	}

	entries, err := os.ReadDir(userConvs)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "real-session.db" {
		t.Fatalf("user conversations dir was polluted: %v", entries)
	}
	if _, err := os.Stat(filepath.Join(userAppData, "log")); !os.IsNotExist(err) {
		t.Fatalf("user log dir was created: err=%v", err)
	}
	open := h.requests(t)["session/new"][0]["params"].(map[string]any)
	if open["cwd"] == h.dir {
		t.Fatalf("probe session/new cwd must be isolated from HOME: %v", open["cwd"])
	}
}

func TestAntigravityProbeHandlesMissingUserGeminiDir(t *testing.T) {
	h := newAgyHarness(t, "token-file", nil)
	probe, err := ProbeAntigravity(t.Context(), h.inv)
	if err != nil {
		t.Fatal(err)
	}
	if !probe.AuthenticationRequired {
		t.Fatalf("expected authentication_required when no token file exists, got %+v", probe)
	}
	if _, err := os.Stat(filepath.Join(h.dir, ".gemini")); !os.IsNotExist(err) {
		t.Fatalf("probe created .gemini under HOME: err=%v", err)
	}
}

func TestAntigravityTurnKeepsDefaultGeminiDir(t *testing.T) {
	metaFile := filepath.Join(t.TempDir(), "turn-meta.json")
	h := newAgyHarness(t, "turn", map[string]string{agyFakeMetaEnv: metaFile})
	run, err := h.runtime.Start(t.Context(), "hi", RunSpec{Dir: h.dir})
	if err != nil {
		t.Fatal(err)
	}
	if _, outcome := drainAgy(t, run); outcome.Status != statusCompleted {
		t.Fatalf("outcome=%+v", outcome)
	}
	rawMeta, err := os.ReadFile(metaFile)
	if err != nil {
		t.Fatal(err)
	}
	var meta struct {
		Args      []string `json:"args"`
		GeminiDir string   `json:"geminiDir"`
		LogFile   string   `json:"logFile"`
	}
	if err := json.Unmarshal(rawMeta, &meta); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(meta.Args, []string{"acp"}) || meta.GeminiDir != "" || meta.LogFile != "" {
		t.Fatalf("real turns must keep default agy store: %+v", meta)
	}
}

func TestAntigravityRefusesWhatItCannotRun(t *testing.T) {
	h := newAgyHarness(t, "turn", nil)
	for name, spec := range map[string]RunSpec{
		"prepare":   {Dir: h.dir, PrepareOnly: true},
		"arguments": {Dir: h.dir, AgentArgs: []string{"--sandbox"}},
		"relative":  {Dir: "relative"},
	} {
		if _, err := h.runtime.Start(t.Context(), "hi", spec); err == nil {
			t.Fatalf("%s: Start accepted the spec", name)
		}
	}
	if _, err := h.runtime.Start(t.Context(), " ", RunSpec{Dir: h.dir}); err == nil {
		t.Fatal("Start accepted an empty prompt")
	}
}

func TestAntigravityReportsTheSessionItStartsAsTheTurnCheckpoint(t *testing.T) {
	h := newAgyHarness(t, "turn", nil)
	run, err := h.runtime.Start(t.Context(), "first", RunSpec{Dir: h.dir, ExposeTurnStarted: true})
	if err != nil {
		t.Fatal(err)
	}
	events, outcome := drainAgy(t, run)
	if outcome.Status != statusCompleted || len(events) == 0 {
		t.Fatalf("outcome=%+v", outcome)
	}
	if started := events[0]; started.Kind != EventStatus || started.TurnID == "" || started.SessionID != "fake-session" {
		t.Fatalf("first event=%+v", started)
	}
	if _, err := h.runtime.Start(t.Context(), "first", RunSpec{Dir: h.dir, AssignSessionID: "assigned"}); err == nil {
		t.Fatal("Start accepted an assigned session id")
	}
}

func TestAntigravityRunCommandMapsToSharedCommandShape(t *testing.T) {
	input := antigravityInput(json.RawMessage(`{"CommandLine":"teamhub message send --content hi","WaitMsBeforeAsync":5000}`))
	if input["command"] != "teamhub message send --content hi" {
		t.Fatalf("input = %#v", input)
	}
	review := antigravityReview(acpUpdate{Kind: "execute", RawInput: json.RawMessage(`{"CommandLine":"rm -rf build"}`)}, t.TempDir())
	if review.Action.Command != "rm -rf build" || review.Action.Tool != "Bash" {
		t.Fatalf("review = %#v", review.Action)
	}
	for _, test := range []struct {
		status, output, want string
	}{
		{"completed", `{"output":"","exit_code":1}`, "failed"},
		{"completed", `{"output":"","exit_code":0}`, "completed"},
		{"completed", ``, "completed"},
		{"failed", `{"exit_code":0}`, "failed"},
	} {
		if got := antigravityToolStatus(acpUpdate{Status: test.status, RawOutput: json.RawMessage(test.output)}); got != test.want {
			t.Fatalf("status %s with %s = %s, want %s", test.status, test.output, got, test.want)
		}
	}
}

func TestAntigravityStartsAResumedRunBeforeTheSessionLoads(t *testing.T) {
	h := newAgyHarness(t, "load-hang", nil)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	run, err := h.runtime.Start(ctx, "again", RunSpec{Dir: h.dir, ResumeID: "earlier-session", ExposeTurnStarted: true})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case started := <-run.Events:
		if started.Kind != EventStatus || started.TurnID == "" || started.SessionID != "earlier-session" {
			t.Fatalf("first event=%+v", started)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the Run did not start while its session was loading")
	}
	cancel()
	drainAgy(t, run)
}

func TestAntigravityReturnsSessionNotFoundWhenResumedSessionIsMissing(t *testing.T) {
	h := newAgyHarness(t, "unknown-session", nil)
	run, err := h.runtime.Start(t.Context(), "again", RunSpec{Dir: h.dir, ResumeID: "moved-session", ExposeTurnStarted: true})
	if err != nil {
		t.Fatal(err)
	}
	_, outcome := drainAgy(t, run)
	if outcome.Status != statusFailed || outcome.FailureCode != "session_not_found" {
		t.Fatalf("outcome=%+v, want failed session_not_found", outcome)
	}
	if requests := h.requests(t); len(requests["session/new"]) != 0 || len(requests["session/prompt"]) != 0 {
		t.Fatalf("requests=%v, want no silent session/new or session/prompt", requests)
	}
}

func TestAntigravityWaitsForACommandItMovedToTheBackground(t *testing.T) {
	quiet := antigravityQuietWindow
	antigravityQuietWindow = 300 * time.Millisecond
	t.Cleanup(func() { antigravityQuietWindow = quiet })
	h := newAgyHarness(t, "background", nil)
	run, err := h.runtime.Start(t.Context(), "list files", RunSpec{Dir: h.dir})
	if err != nil {
		t.Fatal(err)
	}
	events, outcome := drainAgy(t, run)
	if outcome.Status != statusCompleted || outcome.Output != "\n\nFound a.txt" {
		t.Fatalf("outcome=%+v", outcome)
	}
	var result Event
	for _, event := range events {
		if event.Kind == EventToolOutput && event.InvocationID == antigravityInvocationID("call-1") {
			result = event
		}
	}
	if result.Output != "a.txt" || result.Status != "completed" {
		t.Fatalf("the background command's result was lost: %+v", result)
	}
}

func TestAntigravityEndsTheBackgroundWaitWhenAgyExits(t *testing.T) {
	h := newAgyHarness(t, "background-exit", nil)
	run, err := h.runtime.Start(t.Context(), "list files", RunSpec{Dir: h.dir})
	if err != nil {
		t.Fatal(err)
	}
	_, outcome := drainAgy(t, run)
	if outcome.Status != statusFailed || outcome.Error != "Antigravity exited before the turn finished" {
		t.Fatalf("outcome=%+v", outcome)
	}
}

func TestAntigravityBoundsTheBackgroundWait(t *testing.T) {
	limit := antigravityBackgroundLimit
	antigravityBackgroundLimit = 300 * time.Millisecond
	t.Cleanup(func() { antigravityBackgroundLimit = limit })
	h := newAgyHarness(t, "background-stuck", nil)
	run, err := h.runtime.Start(t.Context(), "list files", RunSpec{Dir: h.dir})
	if err != nil {
		t.Fatal(err)
	}
	_, outcome := drainAgy(t, run)
	if outcome.Status != statusCompleted || outcome.Output != "Running in the background." {
		t.Fatalf("outcome=%+v", outcome)
	}
}
