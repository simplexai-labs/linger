package native

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
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

	inline := newAgyHarness(t, "inline-error", nil)
	run, err = inline.runtime.Start(t.Context(), "hi", RunSpec{Dir: inline.dir})
	if err != nil {
		t.Fatal(err)
	}
	if _, outcome := drainAgy(t, run); outcome.Status != statusFailed || outcome.Output != "" ||
		outcome.Error != "\u26a0 FAILED_PRECONDITION (code 400): User location is not supported for the API use." ||
		!outcome.ExitConfirmed || !outcome.Diagnostics.empty() {
		t.Fatalf("inline error outcome=%+v", outcome)
	}

	empty := newAgyHarness(t, "empty-end-turn", nil)
	run, err = empty.runtime.Start(t.Context(), "hi", RunSpec{Dir: empty.dir})
	if err != nil {
		t.Fatal(err)
	}
	if _, outcome := drainAgy(t, run); outcome.Status != statusFailed || outcome.Output != "" ||
		outcome.Error != "Antigravity ended the turn without a model response" ||
		!outcome.ExitConfirmed || !outcome.Diagnostics.empty() {
		t.Fatalf("empty end_turn outcome=%+v", outcome)
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
	probe, err := ProbeAntigravity(t.Context(), h.inv, "")
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
	if probe, err := ProbeAntigravity(t.Context(), signedOut.inv, ""); err != nil || !probe.AuthenticationRequired {
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

	probe, err := ProbeAntigravity(t.Context(), h.inv, "")
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
	probe, err := ProbeAntigravity(t.Context(), h.inv, "")
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

func TestAntigravityProbeUsesTempBaseAndCleansUp(t *testing.T) {
	if _, _, err := PrepareAntigravityProtocolProbe("relative-temp-base"); !errors.Is(err, ErrAntigravityProbePrepare) {
		t.Fatalf("PrepareAntigravityProtocolProbe(relative) err = %v, want ErrAntigravityProbePrepare", err)
	}

	tempBase := t.TempDir()
	unrelatedFile := filepath.Join(tempBase, "keep-me")
	if err := os.WriteFile(unrelatedFile, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}

	args1, release1, err := PrepareAntigravityProtocolProbe(tempBase)
	if err != nil {
		t.Fatalf("PrepareAntigravityProtocolProbe(%q) #1: %v", tempBase, err)
	}
	args2, release2, err := PrepareAntigravityProtocolProbe(tempBase)
	if err != nil {
		release1()
		t.Fatalf("PrepareAntigravityProtocolProbe(%q) #2: %v", tempBase, err)
	}
	if len(args1) != 4 || args1[0] != "--gemini-dir" || args1[2] != "--log-file" {
		release1()
		release2()
		t.Fatalf("unexpected args1 = %v", args1)
	}
	if len(args2) != 4 || args2[0] != "--gemini-dir" || args2[2] != "--log-file" {
		release1()
		release2()
		t.Fatalf("unexpected args2 = %v", args2)
	}
	probeDir1 := filepath.Dir(args1[1])
	probeDir2 := filepath.Dir(args2[1])
	if probeDir1 == probeDir2 {
		release1()
		release2()
		t.Fatalf("concurrent probes in the same tempBase collided on %q", probeDir1)
	}
	for _, probeDir := range []string{probeDir1, probeDir2} {
		if filepath.Dir(probeDir) != tempBase || !strings.HasPrefix(filepath.Base(probeDir), localworkspace.TaskTempDirPrefix) {
			release1()
			release2()
			t.Fatalf("probeDir = %q, want unique %s* child under %q", probeDir, localworkspace.TaskTempDirPrefix, tempBase)
		}
		for _, dir := range []string{tempBase, probeDir, filepath.Join(probeDir, "gemini"), filepath.Join(probeDir, "workspace")} {
			if err := privatefs.CheckPath(dir, "directory", true); err != nil {
				release1()
				release2()
				t.Fatalf("privatefs check failed for %q: %v", dir, err)
			}
		}
	}
	if args1[3] != filepath.Join(probeDir1, "acp.log") || args2[3] != filepath.Join(probeDir2, "acp.log") {
		release1()
		release2()
		t.Fatalf("unexpected log files: args1=%v args2=%v", args1, args2)
	}

	release1()
	release1() // idempotent
	if _, err := os.Stat(probeDir1); !os.IsNotExist(err) {
		release2()
		t.Fatalf("probeDir1 survived release: %v", err)
	}
	if _, err := os.Stat(probeDir2); err != nil {
		release2()
		t.Fatalf("releasing probeDir1 disturbed active probeDir2: %v", err)
	}
	release2()
	if _, err := os.Stat(probeDir2); !os.IsNotExist(err) {
		t.Fatalf("probeDir2 survived release: %v", err)
	}
	if _, err := os.Stat(unrelatedFile); err != nil {
		t.Fatalf("release removed unrelated file %q in tempBase: %v", unrelatedFile, err)
	}

	metaFile := filepath.Join(t.TempDir(), "probe-in-meta.json")
	h := newAgyHarness(t, "turn", map[string]string{agyFakeMetaEnv: metaFile})
	models, err := DiscoverAntigravityModels(t.Context(), h.inv, tempBase)
	if err != nil {
		t.Fatalf("DiscoverAntigravityModels: %v", err)
	}
	if len(models.Models) != 2 {
		t.Fatalf("models = %+v, want 2 models", models)
	}
	rawMeta, err := os.ReadFile(metaFile)
	if err != nil {
		t.Fatal(err)
	}
	var meta struct {
		GeminiDir string `json:"geminiDir"`
		LogFile   string `json:"logFile"`
	}
	if err := json.Unmarshal(rawMeta, &meta); err != nil {
		t.Fatal(err)
	}
	usedProbeDir := filepath.Dir(meta.GeminiDir)
	if filepath.Dir(usedProbeDir) != tempBase || !strings.HasPrefix(filepath.Base(usedProbeDir), localworkspace.TaskTempDirPrefix) ||
		meta.GeminiDir != filepath.Join(usedProbeDir, "gemini") || meta.LogFile != filepath.Join(usedProbeDir, "acp.log") {
		t.Fatalf("probe paths = %+v, want unique %s* subdir under %q", meta, localworkspace.TaskTempDirPrefix, tempBase)
	}
	if _, err := os.Stat(usedProbeDir); !os.IsNotExist(err) {
		t.Fatalf("probe subdir survived DiscoverAntigravityModels: %v", err)
	}
	if _, err := os.Stat(unrelatedFile); err != nil {
		t.Fatalf("DiscoverAntigravityModels removed unrelated file %q in tempBase: %v", unrelatedFile, err)
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
		AddDir    string   `json:"addDir"`
	}
	if err := json.Unmarshal(rawMeta, &meta); err != nil {
		t.Fatal(err)
	}
	ep, epErr := AntigravitySharedHookEndpoint()
	if epErr != nil {
		t.Fatal(epErr)
	}
	if !reflect.DeepEqual(meta.Args, []string{"acp", "--add-dir", ep.Dir()}) || meta.GeminiDir != "" || meta.LogFile != "" || meta.AddDir != ep.Dir() {
		t.Fatalf("real turns must keep default agy store with only managed --add-dir: %+v", meta)
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

func TestAntigravitySteersMidTurnViaPreInvocationHook(t *testing.T) {
	h := newAgyHarness(t, "steer-hook", nil)
	run, err := h.runtime.Start(t.Context(), "start task", RunSpec{Dir: h.dir, ExposeTurnStarted: true})
	if err != nil {
		t.Fatal(err)
	}
	if run.Steer == nil {
		t.Fatal("Run.Steer is nil for Antigravity")
	}

	var turnID string
	var events []Event
	steerStarted := false
	steerRes := make(chan error, 1)
	var steerAck SteerAck

	timeout := time.After(15 * time.Second)
drain:
	for {
		select {
		case event, ok := <-run.Events:
			if !ok {
				break drain
			}
			events = append(events, event)
			if event.Kind == EventStatus && event.TurnID != "" {
				turnID = event.TurnID
			}
			if event.Kind == EventToolCall && !steerStarted {
				steerStarted = true
				go func() {
					var steerErr error
					steerAck, steerErr = run.Steer(t.Context(), SteerRequest{ExpectedTurnID: turnID, Input: "BANANA_STEER"})
					steerRes <- steerErr
				}()
			}
		case <-timeout:
			t.Fatal("steer-hook run did not finish")
		}
	}
	outcome := <-run.Outcome
	if err := <-steerRes; err != nil || steerAck.TurnID != turnID {
		t.Fatalf("steer ack=%+v err=%v want turnID=%q", steerAck, err, turnID)
	}
	if outcome.Status != statusCompleted || outcome.Output != "STEERED:BANANA_STEER" {
		t.Fatalf("outcome=%+v events=%+v", outcome, events)
	}
}

func TestAntigravityWaitingBackgroundStopHookAndPathBWake(t *testing.T) {
	h := newAgyHarness(t, "waiting-background-v2", nil)
	run, err := h.runtime.Start(t.Context(), "schedule work", RunSpec{Dir: h.dir, ExposeTurnStarted: true})
	if err != nil {
		t.Fatal(err)
	}

	var turnID string
	var events []Event
	woken := make(chan error, 1)
	var wakeAck SteerAck

	timeout := time.After(15 * time.Second)
drain:
	for {
		select {
		case event, ok := <-run.Events:
			if !ok {
				break drain
			}
			events = append(events, event)
			if event.Kind == EventStatus && event.TurnID != "" {
				turnID = event.TurnID
			}
			if event.Kind == EventBackgroundWaiting {
				if len(event.BackgroundTools) != 1 || event.BackgroundTools[0].ToolName != "schedule" {
					t.Fatalf("unexpected background tools: %+v", event.BackgroundTools)
				}
				go func() {
					var steerErr error
					wakeAck, steerErr = run.Steer(t.Context(), SteerRequest{ExpectedTurnID: turnID, Input: "check now"})
					woken <- steerErr
				}()
			}
		case <-timeout:
			t.Fatal("waiting-background-v2 run did not finish")
		}
	}
	outcome := <-run.Outcome
	if err := <-woken; err != nil || wakeAck.TurnID != turnID {
		t.Fatalf("wake steer ack=%+v err=%v", wakeAck, err)
	}
	if outcome.Status != statusCompleted || outcome.Output != "Woken:check now" {
		t.Fatalf("outcome=%+v", outcome)
	}
	if usage := outcome.Usage[antigravityDefaultModel]; usage.Input != 30 || usage.Output != 7 {
		t.Fatalf("aggregated usage=%+v, want input=30 output=7", usage)
	}
	var resumed []Event
	for _, ev := range events {
		if ev.Kind == EventBackgroundResumed {
			resumed = append(resumed, ev)
		}
	}
	if len(resumed) != 1 || resumed[0].BackgroundTrigger != "user_input" {
		t.Fatalf("resumed=%+v", resumed)
	}
}

func TestAntigravityLegacyAwaitBackgroundWakesOnSteer(t *testing.T) {
	quiet := antigravityQuietWindow
	antigravityQuietWindow = 250 * time.Millisecond
	t.Cleanup(func() { antigravityQuietWindow = quiet })

	h := newAgyHarness(t, "background-wake", nil)
	run, err := h.runtime.Start(t.Context(), "start bg", RunSpec{Dir: h.dir, ExposeTurnStarted: true})
	if err != nil {
		t.Fatal(err)
	}

	var turnID string
	var sawWaiting bool
	var sawResumed bool
	woken := make(chan error, 1)
	timeout := time.After(15 * time.Second)
drain:
	for {
		select {
		case event, ok := <-run.Events:
			if !ok {
				break drain
			}
			if event.Kind == EventStatus && event.TurnID != "" {
				turnID = event.TurnID
			}
			if event.Kind == EventBackgroundWaiting {
				sawWaiting = true
				go func() {
					_, steerErr := run.Steer(t.Context(), SteerRequest{ExpectedTurnID: turnID, Input: "wake legacy"})
					woken <- steerErr
				}()
			}
			if event.Kind == EventBackgroundResumed && event.BackgroundTrigger == "user_input" {
				sawResumed = true
			}
		case <-timeout:
			t.Fatal("background-wake run did not finish")
		}
	}
	outcome := <-run.Outcome
	if err := <-woken; err != nil {
		t.Fatalf("wake steer err=%v", err)
	}
	if !sawWaiting || !sawResumed || outcome.Status != statusCompleted || !strings.Contains(outcome.Output, "WokenLegacy:wake legacy") {
		t.Fatalf("sawWaiting=%v sawResumed=%v outcome=%+v", sawWaiting, sawResumed, outcome)
	}
}

func TestAntigravitySteerRefusalsAndCancellation(t *testing.T) {
	h := newAgyHarness(t, "hang", nil)
	ctx, cancelRun := context.WithCancel(t.Context())
	run, err := h.runtime.Start(ctx, "hang", RunSpec{Dir: h.dir, ExposeTurnStarted: true})
	if err != nil {
		t.Fatal(err)
	}
	started := <-run.Events
	turnID := started.TurnID
	if turnID == "" {
		t.Fatal("expected TurnID on started event")
	}

	// Mismatched turn ID is rejected with target_mismatch.
	var steerErr *SteerError
	if _, err := run.Steer(t.Context(), SteerRequest{ExpectedTurnID: "wrong-turn", Input: "x"}); !errors.As(err, &steerErr) || steerErr.Effect != "definitely_not_applied" || steerErr.Reason != "target_mismatch" || steerErr.ActualTurnID != turnID {
		t.Fatalf("mismatch err=%v steerErr=%+v", err, steerErr)
	}

	// Cancelling the steer context withdraws unconsumed steer cleanly.
	steerCtx, cancelSteer := context.WithCancel(t.Context())
	steerDone := make(chan error, 1)
	go func() {
		_, err := run.Steer(steerCtx, SteerRequest{ExpectedTurnID: turnID, Input: "withdrawn"})
		steerDone <- err
	}()
	time.Sleep(30 * time.Millisecond)
	cancelSteer()
	steerErr = nil
	if err := <-steerDone; !errors.As(err, &steerErr) || steerErr.Effect != "definitely_not_applied" {
		t.Fatalf("withdrawn steer err=%v steerErr=%+v", err, steerErr)
	}

	// Ending the turn while a steer is queued rejects it with definitely_not_applied.
	pendingErr := make(chan error, 1)
	go func() {
		_, err := run.Steer(t.Context(), SteerRequest{ExpectedTurnID: turnID, Input: "too late"})
		pendingErr <- err
	}()
	time.Sleep(30 * time.Millisecond)
	cancelRun()
	drainAgy(t, run)
	steerErr = nil
	if err := <-pendingErr; !errors.As(err, &steerErr) || steerErr.Effect != "definitely_not_applied" || steerErr.Reason != "no_active_turn" {
		t.Fatalf("ended steer err=%v steerErr=%+v", err, steerErr)
	}

	// Steering after turn completion is also rejected.
	steerErr = nil
	if _, err := run.Steer(t.Context(), SteerRequest{ExpectedTurnID: turnID, Input: "after"}); !errors.As(err, &steerErr) || steerErr.Effect != "definitely_not_applied" || steerErr.Reason != "no_active_turn" {
		t.Fatalf("post-end steer err=%v steerErr=%+v", err, steerErr)
	}
}

func TestAntigravityEmptyWakeDoesNotWedgeTurn(t *testing.T) {
	t.Run("finishes_after_withdrawn_steer", func(t *testing.T) {
		quiet := antigravityQuietWindow
		antigravityQuietWindow = 600 * time.Millisecond
		t.Cleanup(func() { antigravityQuietWindow = quiet })
		t.Cleanup(func() { antigravityBeforeWakePrompt = nil })

		h := newAgyHarness(t, "background", nil)
		run, err := h.runtime.Start(t.Context(), "run bg", RunSpec{Dir: h.dir, ExposeTurnStarted: true})
		if err != nil {
			t.Fatal(err)
		}

		steerCtx, cancelSteer := context.WithCancel(t.Context())
		defer cancelSteer()
		steerDone := make(chan error, 1)
		var steerErrResult error
		intercepted := make(chan struct{})
		var interceptOnce sync.Once
		antigravityBeforeWakePrompt = func() {
			interceptOnce.Do(func() {
				cancelSteer()
				select {
				case steerErrResult = <-steerDone:
				case <-time.After(5 * time.Second):
				}
				close(intercepted)
			})
		}

		var turnID string
		var steerStarted bool
		timeout := time.After(15 * time.Second)
	drain:
		for {
			select {
			case event, ok := <-run.Events:
				if !ok {
					break drain
				}
				if event.Kind == EventStatus && event.TurnID != "" {
					turnID = event.TurnID
				}
				if event.Kind == EventBackgroundWaiting && !steerStarted {
					steerStarted = true
					id := turnID
					go func() {
						_, steerErr := run.Steer(steerCtx, SteerRequest{ExpectedTurnID: id, Input: "withdrawn wake"})
						steerDone <- steerErr
					}()
				}
			case <-timeout:
				t.Fatal("background run wedged after empty wake")
			}
		}
		select {
		case <-intercepted:
		case <-time.After(5 * time.Second):
			t.Fatal("expected empty wake interception")
		}
		var steerErr *SteerError
		if !errors.As(steerErrResult, &steerErr) || steerErr.Effect != "definitely_not_applied" {
			t.Fatalf("steerErr=%v", steerErrResult)
		}
		outcome := <-run.Outcome
		if outcome.Status != statusCompleted || !strings.Contains(outcome.Output, "Found a.txt") {
			t.Fatalf("outcome=%+v", outcome)
		}
	})

	t.Run("cancels_after_withdrawn_steer", func(t *testing.T) {
		t.Cleanup(func() { antigravityBeforeWakePrompt = nil })

		h := newAgyHarness(t, "background-stuck", nil)
		runCtx, cancelRun := context.WithCancel(t.Context())
		defer cancelRun()
		run, err := h.runtime.Start(runCtx, "stuck bg", RunSpec{Dir: h.dir, ExposeTurnStarted: true})
		if err != nil {
			t.Fatal(err)
		}

		steerCtx, cancelSteer := context.WithCancel(t.Context())
		defer cancelSteer()
		steerDone := make(chan error, 1)
		intercepted := make(chan struct{})
		var interceptOnce sync.Once
		antigravityBeforeWakePrompt = func() {
			interceptOnce.Do(func() {
				cancelSteer()
				select {
				case <-steerDone:
				case <-time.After(5 * time.Second):
				}
				close(intercepted)
			})
		}

		var turnID string
		var steerStarted bool
		timeout := time.After(15 * time.Second)
	waitIntercept:
		for {
			select {
			case event, ok := <-run.Events:
				if !ok {
					t.Fatal("run ended unexpectedly before cancellation")
				}
				if event.Kind == EventStatus && event.TurnID != "" {
					turnID = event.TurnID
				}
				if event.Kind == EventBackgroundWaiting && !steerStarted {
					steerStarted = true
					id := turnID
					go func() {
						_, steerErr := run.Steer(steerCtx, SteerRequest{ExpectedTurnID: id, Input: "withdrawn wake"})
						steerDone <- steerErr
					}()
				}
			case <-intercepted:
				break waitIntercept
			case <-timeout:
				t.Fatal("timed out waiting for empty wake interception")
			}
		}
		cancelRun()
		_, outcome := drainAgy(t, run)
		if outcome.Status != statusAborted {
			t.Fatalf("outcome=%+v, want aborted", outcome)
		}
	})
}

func TestAntigravityStopHookBlocksOnceAndGuardsReentry(t *testing.T) {
	t.Run("blocks_once_even_when_continuation_active_is_false", func(t *testing.T) {
		h := newAgyHarness(t, "stop-hook", nil)
		var calls []StopHookRequest
		run, err := h.runtime.Start(t.Context(), "say hi", RunSpec{
			Dir: h.dir,
			StopHook: func(_ context.Context, req StopHookRequest) StopHookDecision {
				calls = append(calls, req)
				if !req.StopHookActive {
					return StopHookDecision{Action: "block", Reason: "Send the Room message first."}
				}
				return StopHookDecision{Action: "allow"}
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		_, outcome := drainAgy(t, run)
		if outcome.Status != statusCompleted {
			t.Fatalf("outcome=%+v", outcome)
		}
		if len(calls) != 2 {
			t.Fatalf("stop hook calls=%+v, want 2", calls)
		}
		if calls[0].Runtime != "antigravity" || calls[0].StopHookActive {
			t.Fatalf("call[0]=%+v, want antigravity StopHookActive=false", calls[0])
		}
		if calls[1].Runtime != "antigravity" || !calls[1].StopHookActive {
			t.Fatalf("call[1]=%+v, want antigravity StopHookActive=true", calls[1])
		}
		if outcome.Output != "Continued:Send the Room message first." {
			t.Fatalf("output=%q, want continuation text only", outcome.Output)
		}
	})

	t.Run("skips_on_error_termination", func(t *testing.T) {
		h := newAgyHarness(t, "stop-hook-error", nil)
		called := false
		run, err := h.runtime.Start(t.Context(), "say hi", RunSpec{
			Dir: h.dir,
			StopHook: func(_ context.Context, _ StopHookRequest) StopHookDecision {
				called = true
				return StopHookDecision{Action: "block", Reason: "should not fire"}
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		_, outcome := drainAgy(t, run)
		if outcome.Status != statusCompleted || called {
			t.Fatalf("outcome=%+v called=%v, want completed with stop hook skipped", outcome, called)
		}
	})

	t.Run("cancellation_unblocks_stop_hook", func(t *testing.T) {
		h := newAgyHarness(t, "stop-hook", nil)
		runCtx, cancelRun := context.WithCancel(t.Context())
		defer cancelRun()
		inHook := make(chan struct{})
		hookExited := make(chan struct{})
		run, err := h.runtime.Start(runCtx, "say hi", RunSpec{
			Dir: h.dir,
			StopHook: func(ctx context.Context, _ StopHookRequest) StopHookDecision {
				close(inHook)
				<-ctx.Done()
				close(hookExited)
				return StopHookDecision{Action: "allow"}
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		select {
		case <-inHook:
		case <-time.After(10 * time.Second):
			t.Fatal("stop hook was not invoked")
		}
		cancelRun()
		select {
		case <-hookExited:
		case <-time.After(5 * time.Second):
			t.Fatal("stop hook context was not cancelled on turn cancellation")
		}
		_, outcome := drainAgy(t, run)
		if outcome.Status != statusAborted {
			t.Fatalf("outcome=%+v, want aborted", outcome)
		}
	})
}

func TestAntigravityPreToolUseShellTextHook(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell text check is disabled on Windows PowerShell")
	}

	t.Run("denies_rewritten_teamhub_command_before_permission_review", func(t *testing.T) {
		h := newAgyHarness(t, "pretooluse-shell", map[string]string{
			agyFakeCommandEnv: `teamhub message send --content "$180"`,
		})
		requester := agyDenyingRequester{asked: make(chan string, 1)}
		reviewer := &permission.Reviewer{Requester: requester, Timeout: time.Minute}
		run, err := h.runtime.Start(t.Context(), "send", RunSpec{
			Dir:                h.dir,
			ShellTextHook:      "/opt/linger/linger-computer-daemon",
			PermissionReviewer: reviewer,
		})
		if err != nil {
			t.Fatal(err)
		}
		_, outcome := drainAgy(t, run)
		if outcome.Status != statusCompleted {
			t.Fatalf("outcome=%+v", outcome)
		}
		select {
		case id := <-requester.asked:
			t.Fatalf("permission reviewer should not be called when PreToolUse denies shell text (got %q)", id)
		default:
		}
		if outcome.Output != "DENIED:"+permission.ShellTextMessage {
			t.Fatalf("output=%q, want DENIED with ShellTextMessage", outcome.Output)
		}
	})

	t.Run("allows_safe_teamhub_command_and_still_runs_permission_reviewer", func(t *testing.T) {
		h := newAgyHarness(t, "pretooluse-shell", map[string]string{
			agyFakeCommandEnv: `teamhub message send --content 'hello $180'`,
		})
		requester := agyDenyingRequester{asked: make(chan string, 1)}
		reviewer := &permission.Reviewer{Requester: requester, Timeout: time.Minute}
		run, err := h.runtime.Start(t.Context(), "send", RunSpec{
			Dir:                h.dir,
			ShellTextHook:      "/opt/linger/linger-computer-daemon",
			PermissionReviewer: reviewer,
		})
		if err != nil {
			t.Fatal(err)
		}
		_, outcome := drainAgy(t, run)
		if outcome.Status != statusCompleted {
			t.Fatalf("outcome=%+v", outcome)
		}
		select {
		case <-requester.asked:
		default:
			t.Fatal("expected permission reviewer to run after PreToolUse allow")
		}
		if outcome.Output != "ALLOWED:deny" {
			t.Fatalf("output=%q, want ALLOWED:deny", outcome.Output)
		}
	})

	t.Run("skips_check_when_shell_text_hook_disabled", func(t *testing.T) {
		h := newAgyHarness(t, "pretooluse-shell", map[string]string{
			agyFakeCommandEnv: `teamhub message send --content "$180"`,
		})
		run, err := h.runtime.Start(t.Context(), "send", RunSpec{
			Dir:           h.dir,
			ShellTextHook: "",
		})
		if err != nil {
			t.Fatal(err)
		}
		_, outcome := drainAgy(t, run)
		if outcome.Status != statusCompleted || outcome.Output != "ALLOWED:allow" {
			t.Fatalf("outcome=%+v, want ALLOWED:allow when ShellTextHook is empty", outcome)
		}
	})
}

func TestAntigravityStartPassesRuntimeHomeGeminiDirAndLogFile(t *testing.T) {
	metaFile := filepath.Join(t.TempDir(), "runtime-home-meta.json")
	runtimeHome := filepath.Join(t.TempDir(), "isolated-home")
	if err := os.MkdirAll(filepath.Join(runtimeHome, "gemini", "antigravity-cli"), 0o700); err != nil {
		t.Fatal(err)
	}
	h := newAgyHarness(t, "turn", map[string]string{agyFakeMetaEnv: metaFile})
	run, err := h.runtime.Start(t.Context(), "hi", RunSpec{Dir: h.dir, RuntimeHome: runtimeHome})
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
		AddDir    string   `json:"addDir"`
	}
	if err := json.Unmarshal(rawMeta, &meta); err != nil {
		t.Fatal(err)
	}
	wantGemini := filepath.Join(runtimeHome, "gemini")
	wantLog := filepath.Join(runtimeHome, "acp.log")
	if meta.GeminiDir != wantGemini || meta.LogFile != wantLog {
		t.Fatalf("meta=%+v, want geminiDir=%q logFile=%q", meta, wantGemini, wantLog)
	}
	if _, err := h.runtime.Start(t.Context(), "hi", RunSpec{Dir: h.dir, RuntimeHome: "relative-home"}); err == nil {
		t.Fatal("Start accepted relative RuntimeHome")
	}
}

func TestAntigravityProbeContextWindowsFromUsageUpdates(t *testing.T) {
	shortenForTest(t, &antigravityProbeUsageWait, 120*time.Millisecond)
	shortenForTest(t, &antigravityProbeUsageSettle, 25*time.Millisecond)

	t.Run("distinct_deduplicated_and_failed_models", func(t *testing.T) {
		h := newAgyHarness(t, "turn", map[string]string{
			agyFakeExtraModelsEnv: "gemini-same,gemini-broken,gemini-small",
			agyFakeFailModelEnv:   "gemini-broken",
			agyFakeUsageWindowsEnv: `{
				"gemini-pro": 1048576,
				"gemini-flash": 200000,
				"gemini-same": 200000,
				"gemini-small": 128000
			}`,
		})
		probe, err := ProbeAntigravity(t.Context(), h.inv, "")
		if err != nil {
			t.Fatal(err)
		}
		if probe.AuthenticationRequired {
			t.Fatalf("unexpected authentication required: %+v", probe)
		}
		got := map[string]int{}
		for _, m := range probe.Models.Models {
			got[m.ID] = m.ContextWindow
		}
		want := map[string]int{
			"gemini-pro":    1048576,
			"gemini-flash":  200000,
			"gemini-same":   200000,
			"gemini-broken": 0,
			"gemini-small":  128000,
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("context windows = %v, want %v", got, want)
		}
	})

	t.Run("ignores_invalid_usage_sizes", func(t *testing.T) {
		for name, rawSize := range map[string]string{
			"zero":     `0`,
			"negative": `-1024`,
			"overflow": `100000001`,
			"string":   `"1048576"`,
			"float":    `1048576.5`,
		} {
			t.Run(name, func(t *testing.T) {
				h := newAgyHarness(t, "turn", map[string]string{
					agyFakeUsageWindowsEnv: `{"gemini-pro": ` + rawSize + `}`,
				})
				probe, err := ProbeAntigravity(t.Context(), h.inv, "")
				if err != nil {
					t.Fatal(err)
				}
				for _, m := range probe.Models.Models {
					if m.ContextWindow != 0 {
						t.Fatalf("%s: model %s got ContextWindow=%d, want 0", name, m.ID, m.ContextWindow)
					}
				}
				if got := len(h.requests(t)["session/set_config_option"]); got != 0 {
					t.Fatalf("%s: expected zero set_config_option calls when initial usage is invalid, got %d", name, got)
				}
			})
		}
	})

	t.Run("no_usage_update_skips_model_switching", func(t *testing.T) {
		h := newAgyHarness(t, "turn", nil)
		probe, err := ProbeAntigravity(t.Context(), h.inv, "")
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range probe.Models.Models {
			if m.ContextWindow != 0 {
				t.Fatalf("model %s got ContextWindow=%d, want 0", m.ID, m.ContextWindow)
			}
		}
		if got := len(h.requests(t)["session/set_config_option"]); got != 0 {
			t.Fatalf("expected zero set_config_option calls when session/new emits no usage_update, got %d", got)
		}
	})

	t.Run("silent_switch_timeout_leaves_window_unknown", func(t *testing.T) {
		h := newAgyHarness(t, "turn", map[string]string{
			agyFakeExtraModelsEnv: "gemini-silent,gemini-small",
			agyFakeSilentModelEnv: "gemini-silent",
			agyFakeUsageWindowsEnv: `{
				"gemini-pro": 1048576,
				"gemini-flash": 200000,
				"gemini-small": 128000
			}`,
		})
		probe, err := ProbeAntigravity(t.Context(), h.inv, "")
		if err != nil {
			t.Fatal(err)
		}
		got := map[string]int{}
		for _, m := range probe.Models.Models {
			got[m.ID] = m.ContextWindow
		}
		want := map[string]int{
			"gemini-pro":    1048576,
			"gemini-flash":  200000,
			"gemini-silent": 0,
			"gemini-small":  128000,
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("context windows = %v, want %v", got, want)
		}
	})

	t.Run("invalid_usage_size_on_switched_model_does_not_inherit_previous", func(t *testing.T) {
		for name, rawInvalid := range map[string]string{
			"zero":     `0`,
			"overflow": `100000001`,
			"string":   `"bad"`,
		} {
			t.Run(name, func(t *testing.T) {
				h := newAgyHarness(t, "turn", map[string]string{
					agyFakeExtraModelsEnv: "gemini-invalid,gemini-after-invalid,gemini-valid",
					agyFakeUsageWindowsEnv: `{
						"gemini-pro": 1048576,
						"gemini-flash": 200000,
						"gemini-invalid": ` + rawInvalid + `,
						"gemini-after-invalid": ` + rawInvalid + `,
						"gemini-valid": 128000
					}`,
				})
				probe, err := ProbeAntigravity(t.Context(), h.inv, "")
				if err != nil {
					t.Fatal(err)
				}
				got := map[string]int{}
				for _, m := range probe.Models.Models {
					got[m.ID] = m.ContextWindow
				}
				want := map[string]int{
					"gemini-pro":           1048576,
					"gemini-flash":         200000,
					"gemini-invalid":       0,
					"gemini-after-invalid": 0,
					"gemini-valid":         128000,
				}
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("%s: context windows = %v, want %v", name, got, want)
				}
			})
		}
	})

	t.Run("silent_switch_timeout_invalidates_carry_forward_baseline", func(t *testing.T) {
		h := newAgyHarness(t, "turn", map[string]string{
			agyFakeExtraModelsEnv: "gemini-silent,gemini-after-silent,gemini-small",
			agyFakeSilentModelEnv: "gemini-silent",
			agyFakeUsageWindowsEnv: `{
				"gemini-pro": 1048576,
				"gemini-flash": 200000,
				"gemini-silent": 300000,
				"gemini-after-silent": 300000,
				"gemini-small": 128000
			}`,
		})
		probe, err := ProbeAntigravity(t.Context(), h.inv, "")
		if err != nil {
			t.Fatal(err)
		}
		got := map[string]int{}
		for _, m := range probe.Models.Models {
			got[m.ID] = m.ContextWindow
		}
		// gemini-silent never emits usage_update so it stays unknown (0), while
		// clean-session anchor verification recovers gemini-after-silent's real
		// 300000 window instead of inheriting gemini-flash's 200000 baseline.
		want := map[string]int{
			"gemini-pro":          1048576,
			"gemini-flash":        200000,
			"gemini-silent":       0,
			"gemini-after-silent": 300000,
			"gemini-small":        128000,
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("context windows = %v, want %v", got, want)
		}
	})

	t.Run("initial_usage_update_after_settle_window_is_still_captured", func(t *testing.T) {
		shortenForTest(t, &antigravityProbeUsageWait, 300*time.Millisecond)
		shortenForTest(t, &antigravityProbeUsageSettle, 25*time.Millisecond)
		h := newAgyHarness(t, "turn", map[string]string{
			agyFakeInitialUsageDelayEnv: "60",
			agyFakeUsageWindowsEnv: `{
				"gemini-pro": 1048576,
				"gemini-flash": 200000
			}`,
		})
		probe, err := ProbeAntigravity(t.Context(), h.inv, "")
		if err != nil {
			t.Fatal(err)
		}
		got := map[string]int{}
		for _, m := range probe.Models.Models {
			got[m.ID] = m.ContextWindow
		}
		want := map[string]int{
			"gemini-pro":   1048576,
			"gemini-flash": 200000,
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("context windows = %v, want %v", got, want)
		}
	})

	t.Run("delayed_usage_update_does_not_misattribute_or_poison_next_model", func(t *testing.T) {
		t.Run("delayed_flash", func(t *testing.T) {
			shortenForTest(t, &antigravityProbeUsageWait, 1200*time.Millisecond)
			shortenForTest(t, &antigravityProbeUsageSettle, 25*time.Millisecond)
			h := newAgyHarness(t, "turn", map[string]string{
				agyFakeExtraModelsEnv:  "gemini-small,gemini-same-as-pro",
				agyFakeDelayedUsageEnv: "gemini-flash:120",
				agyFakeUsageWindowsEnv: `{
					"gemini-pro": 1048576,
					"gemini-flash": 200000,
					"gemini-small": 128000,
					"gemini-same-as-pro": 1048576
				}`,
			})
			probe, err := ProbeAntigravity(t.Context(), h.inv, "")
			if err != nil {
				t.Fatal(err)
			}
			got := map[string]int{}
			for _, m := range probe.Models.Models {
				got[m.ID] = m.ContextWindow
			}
			want := map[string]int{
				"gemini-pro":         1048576,
				"gemini-flash":       200000,
				"gemini-small":       128000,
				"gemini-same-as-pro": 1048576,
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("context windows = %v, want %v", got, want)
			}
		})

		t.Run("late_frame_during_next_switch", func(t *testing.T) {
			shortenForTest(t, &antigravityProbeUsageWait, 1200*time.Millisecond)
			shortenForTest(t, &antigravityProbeUsageSettle, 25*time.Millisecond)
			h := newAgyHarness(t, "turn", map[string]string{
				agyFakeExtraModelsEnv:  "gemini-small,gemini-same-as-pro",
				agyFakeDelayedUsageEnv: "gemini-flash:100,gemini-small:180,gemini-same-as-pro:120",
				agyFakeUsageWindowsEnv: `{
					"gemini-pro": 1048576,
					"gemini-flash": 200000,
					"gemini-small": 128000,
					"gemini-same-as-pro": 1048576
				}`,
			})
			probe, err := ProbeAntigravity(t.Context(), h.inv, "")
			if err != nil {
				t.Fatal(err)
			}
			got := map[string]int{}
			for _, m := range probe.Models.Models {
				got[m.ID] = m.ContextWindow
			}
			want := map[string]int{
				"gemini-pro":         1048576,
				"gemini-flash":       200000,
				"gemini-small":       128000,
				"gemini-same-as-pro": 1048576,
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("context windows = %v, want %v", got, want)
			}
		})
	})

	t.Run("identical_windows_without_alternate_anchor_stay_unknown", func(t *testing.T) {
		h := newAgyHarness(t, "turn", map[string]string{
			agyFakeUsageWindowsEnv: `{
				"gemini-pro": 1048576,
				"gemini-flash": 1048576
			}`,
		})
		probe, err := ProbeAntigravity(t.Context(), h.inv, "")
		if err != nil {
			t.Fatal(err)
		}
		got := map[string]int{}
		for _, m := range probe.Models.Models {
			got[m.ID] = m.ContextWindow
		}
		want := map[string]int{
			"gemini-pro":   1048576,
			"gemini-flash": 0,
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("context windows = %v, want %v", got, want)
		}
	})
}

func TestAntigravityOutcomeCompactionCount(t *testing.T) {
	t.Run("zero_when_no_checkpoints", func(t *testing.T) {
		runtimeHome := t.TempDir()
		h := newAgyHarness(t, "turn", nil)
		run, err := h.runtime.Start(t.Context(), "hi", RunSpec{Dir: h.dir, RuntimeHome: runtimeHome})
		if err != nil {
			t.Fatal(err)
		}
		_, outcome := drainAgy(t, run)
		if outcome.Status != statusCompleted || outcome.CompactionCount == nil || *outcome.CompactionCount != 0 {
			t.Fatalf("outcome=%+v, want CompactionCount=0", outcome)
		}
	})

	t.Run("counts_done_checkpoints_and_excludes_prior_turn_and_non_done", func(t *testing.T) {
		runtimeHome := t.TempDir()
		sessionID := "compact-session-1"
		transcriptPath := filepath.Join(runtimeHome, "gemini", "antigravity-cli", "brain", sessionID, ".system_generated", "logs", "transcript.jsonl")
		if err := os.MkdirAll(filepath.Dir(transcriptPath), 0o700); err != nil {
			t.Fatal(err)
		}
		// Earlier turn already recorded a CHECKPOINT that must not be double-counted.
		prior := `{"type":"CHECKPOINT","status":"DONE"}` + "\n" +
			`{"type":"USER_INPUT","status":"DONE"}` + "\n"
		if err := os.WriteFile(transcriptPath, []byte(prior), 0o600); err != nil {
			t.Fatal(err)
		}

		turnLines := strings.Join([]string{
			`{"type":"CHECKPOINT","status":"DONE"}`,
			`{"type":"CHECKPOINT","status":"ERROR"}`,
			`{"type":"CHECKPOINT","status":"CANCELED"}`,
			`{"type":"CHECKPOINT","status":"CORTEX_STEP_STATUS_DONE"}`,
			`{"type":"PLANNER_RESPONSE","status":"DONE"}`,
			`not-json`,
		}, "\n") + "\n"
		h := newAgyHarness(t, "turn", map[string]string{
			agyFakeSessionIDEnv:        sessionID,
			agyFakeTranscriptAppendEnv: turnLines,
		})
		run, err := h.runtime.Start(t.Context(), "work", RunSpec{Dir: h.dir, RuntimeHome: runtimeHome})
		if err != nil {
			t.Fatal(err)
		}
		_, outcome := drainAgy(t, run)
		if outcome.Status != statusCompleted || outcome.CompactionCount == nil || *outcome.CompactionCount != 2 {
			t.Fatalf("outcome=%+v CompactionCount=%v, want 2", outcome, outcome.CompactionCount)
		}

		// A subsequent turn on the same session without new checkpoints reports 0.
		h2 := newAgyHarness(t, "turn", map[string]string{agyFakeSessionIDEnv: sessionID})
		run2, err := h2.runtime.Start(t.Context(), "follow up", RunSpec{Dir: h2.dir, RuntimeHome: runtimeHome, ResumeID: sessionID})
		if err != nil {
			t.Fatal(err)
		}
		_, outcome2 := drainAgy(t, run2)
		if outcome2.Status != statusCompleted || outcome2.CompactionCount == nil || *outcome2.CompactionCount != 0 {
			t.Fatalf("second turn outcome=%+v CompactionCount=%v, want 0", outcome2, outcome2.CompactionCount)
		}
	})

	t.Run("rejects_hostile_session_ids_and_symlinks", func(t *testing.T) {
		appDataDir := filepath.Join(t.TempDir(), "antigravity-cli")
		if err := os.MkdirAll(filepath.Join(appDataDir, "brain"), 0o700); err != nil {
			t.Fatal(err)
		}
		outside := t.TempDir()
		outsideTranscript := filepath.Join(outside, "transcript.jsonl")
		if err := os.WriteFile(outsideTranscript, []byte(`{"type":"CHECKPOINT","status":"DONE"}`+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}

		for _, hostile := range []string{"", ".", "..", "../escape", "a/b", `a\b`, "bad space"} {
			if got := countAntigravityTurnCheckpoints(appDataDir, hostile, 0); got != 0 {
				t.Fatalf("hostile sessionID %q returned %d, want 0", hostile, got)
			}
		}

		// Symlinked transcript.jsonl must return 0.
		logsDir := filepath.Join(appDataDir, "brain", "sym-file", ".system_generated", "logs")
		if err := os.MkdirAll(logsDir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outsideTranscript, filepath.Join(logsDir, "transcript.jsonl")); err == nil {
			if got := countAntigravityTurnCheckpoints(appDataDir, "sym-file", 0); got != 0 {
				t.Fatalf("symlinked transcript returned %d, want 0", got)
			}
		}

		// Symlinked parent directory must return 0.
		outsideLogs := filepath.Join(outside, "logs")
		if err := os.MkdirAll(outsideLogs, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(outsideLogs, "transcript.jsonl"), []byte(`{"type":"CHECKPOINT","status":"DONE"}`+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		sysDir := filepath.Join(appDataDir, "brain", "sym-dir", ".system_generated")
		if err := os.MkdirAll(sysDir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outsideLogs, filepath.Join(sysDir, "logs")); err == nil {
			if got := countAntigravityTurnCheckpoints(appDataDir, "sym-dir", 0); got != 0 {
				t.Fatalf("symlinked logs dir returned %d, want 0", got)
			}
		}
	})
}
