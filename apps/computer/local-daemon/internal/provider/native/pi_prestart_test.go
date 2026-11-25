package native

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func piMCPFixture(name, target string) json.RawMessage {
	return json.RawMessage(`{"mcpServers":{"` + name + `":{"type":"http","url":"` + target + `"}}}`)
}

func (h *piResidentHome) prestart(spec RunSpec) Outcome {
	h.t.Helper()
	spec.PrepareOnly = true
	events, outcome := h.turn("", spec)
	if len(events) != 0 {
		h.t.Fatalf("pre-start events = %+v", events)
	}
	return outcome
}

func (h *piResidentHome) withExtension() string {
	h.t.Helper()
	extension := filepath.Join(h.t.TempDir(), "pi-mcp.mjs")
	if err := os.WriteFile(extension, []byte("export default {}\n"), 0o600); err != nil {
		h.t.Fatal(err)
	}
	h.profile.ManagedMCPExtension = extension
	return extension
}

func TestPiPrestartAdoptedByCreateRunAndAttachesMCP(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "attached") }))
	t.Cleanup(upstream.Close)
	argvPath := filepath.Join(t.TempDir(), "argv")
	h := piNewResidentHome(t, map[string]string{piFakeArgvEnv: argvPath, piResidentSyncMCPEnv: "ok"})
	extension := h.withExtension()
	var logs piSyncBuffer
	h.profile.Logger = slog.New(slog.NewTextHandler(&logs, nil))

	out := h.prestart(RunSpec{AssignSessionID: "prestart-new"})
	if out.Status != statusCompleted || !out.Parked || out.SessionID != "prestart-new" || !holdsPrestart() {
		t.Fatalf("pre-start = %+v holdsPrestart=%v", out, holdsPrestart())
	}
	// A new Pi session does not flush a transcript file until its first message.
	if err := piValidateSession(h.sessionDir("prestart-new"), "prestart-new", h.dir); err == nil {
		t.Fatal("unused pre-start unexpectedly wrote a transcript")
	}
	if repeat := h.prestart(RunSpec{AssignSessionID: "prestart-new"}); repeat.Status != statusCompleted || repeat.Parked {
		t.Fatalf("repeated pre-start = %+v, want Parked=false (already_ready)", repeat)
	}
	argvData, err := os.ReadFile(argvPath)
	if err != nil {
		t.Fatal(err)
	}
	argv := strings.Split(strings.TrimSpace(string(argvData)), "\n")
	if !slices.Contains(argv, "--extension") || !slices.Contains(argv, extension) || !slices.Contains(argv, piBaseTools+",tool_search,mcp__*") {
		t.Fatalf("pre-start argv = %q", argv)
	}

	events, run := h.turn("hello", RunSpec{AssignSessionID: "prestart-new", MCPServers: piMCPFixture("computer", upstream.URL)})
	if run.Status != statusCompleted || run.Output != "done" || run.SessionID != "prestart-new" || holdsPrestart() {
		t.Fatalf("adopted run = %+v holdsPrestart=%v", run, holdsPrestart())
	}
	if h.lines("spawn") != 1 || h.lines("sync_mcp") != 1 || h.lines("prompt") != 1 {
		t.Fatalf("spawns=%d syncs=%d prompts=%d", h.lines("spawn"), h.lines("sync_mcp"), h.lines("prompt"))
	}
	if !strings.Contains(logs.String(), "pi resident adopted") || strings.Contains(logs.String(), "pi resident recycled") {
		t.Fatalf("logs:\n%s", logs.String())
	}
	if !slices.ContainsFunc(events, func(ev Event) bool { return ev.Kind == EventStatus && ev.ProcessReused != nil && *ev.ProcessReused }) {
		t.Fatalf("adopted run did not report process_reused=true: %+v", events)
	}
	mcpData, err := os.ReadFile(filepath.Join(h.sessionDir("prestart-new"), piMCPConfigName))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(mcpData), "/mcp/") || strings.Contains(string(mcpData), upstream.URL) {
		t.Fatalf("rewritten MCP config = %s", mcpData)
	}
}

func TestPiPrestartAdoptedByResumeRun(t *testing.T) {
	h := piNewResidentHome(t, map[string]string{piResidentSyncMCPEnv: "ok"})
	h.withExtension()
	mcp := piMCPFixture("computer", "http://127.0.0.1:9/target")
	if _, first := h.turn("seed", RunSpec{AssignSessionID: "prestart-resume", MCPServers: mcp}); first.Status != statusCompleted {
		t.Fatalf("seed = %+v", first)
	}
	if _, err := StopAllParkedResidents(); err != nil {
		t.Fatal(err)
	}
	if pre := h.prestart(RunSpec{ResumeID: "prestart-resume", ResumeRequired: true}); !pre.Parked || pre.Status != statusCompleted {
		t.Fatalf("pre-start = %+v", pre)
	}
	if _, resumed := h.turn("again", RunSpec{ResumeID: "prestart-resume", ResumeRequired: true, MCPServers: mcp}); resumed.Status != statusCompleted {
		t.Fatalf("resumed = %+v", resumed)
	}
	if h.lines("spawn") != 2 || h.lines("sync_mcp") != 1 {
		t.Fatalf("spawns=%d syncs=%d, want 2 spawns and 1 attach sync", h.lines("spawn"), h.lines("sync_mcp"))
	}
}

func TestPiPrestartAppliesClampedThinkingLevel(t *testing.T) {
	h := piNewResidentHome(t, map[string]string{piResidentThinkingEnv: "1", piResidentSyncMCPEnv: "ok"})
	h.withExtension()
	if pre := h.prestart(RunSpec{AssignSessionID: "prestart-think", Effort: "high"}); pre.Status != statusCompleted || !pre.Parked {
		t.Fatalf("pre-start = %+v", pre)
	}
	if got := h.lines("thinking:low"); got != 1 {
		t.Fatalf("clamped set_thinking_level calls = %d, want 1", got)
	}
	if _, out := h.turn("go", RunSpec{AssignSessionID: "prestart-think", Effort: "high"}); out.Status != statusCompleted || h.lines("spawn") != 1 {
		t.Fatalf("adopted run = %+v spawns=%d", out, h.lines("spawn"))
	}
}

func TestPiUnusedPrestartLeavesNoTranscriptAndReleasesLock(t *testing.T) {
	h := piNewResidentHome(t, map[string]string{piResidentSyncMCPEnv: "ok"})
	h.withExtension()
	h.prestart(RunSpec{AssignSessionID: "prestart-unused"})
	proc := h.parked("prestart-unused")
	if proc == nil {
		t.Fatal("pre-start did not park")
	}
	if stopped, err := StopAllParkedResidents(); stopped != 1 || err != nil {
		t.Fatalf("stop = %d %v", stopped, err)
	}
	piAwaitGone(t, proc)
	h.assertLockFree("prestart-unused")
	if err := piValidateSession(h.sessionDir("prestart-unused"), "prestart-unused", h.dir); err == nil {
		t.Fatal("unused pre-start left a materialized transcript")
	}
	if _, out := h.turn("first", RunSpec{AssignSessionID: "prestart-unused"}); out.Status != statusCompleted {
		t.Fatalf("later first run = %+v", out)
	}
}

func TestPiPrestartMCPSyncErrorFallsBackToColdSpawn(t *testing.T) {
	h := piNewResidentHome(t, map[string]string{piResidentSyncMCPEnv: "fail"})
	h.withExtension()
	var logs piSyncBuffer
	h.profile.Logger = slog.New(slog.NewTextHandler(&logs, nil))

	h.prestart(RunSpec{AssignSessionID: "prestart-sync-fail"})
	old := h.parked("prestart-sync-fail")
	if old == nil {
		t.Fatal("pre-start did not park")
	}
	_, out := h.turn("hello", RunSpec{AssignSessionID: "prestart-sync-fail", MCPServers: piMCPFixture("computer", "http://127.0.0.1:9/target")})
	if out.Status != statusCompleted || out.Output != "done" || h.lines("spawn") != 2 {
		t.Fatalf("fallback run = %+v spawns=%d", out, h.lines("spawn"))
	}
	piAwaitGone(t, old)
	if !strings.Contains(logs.String(), "reason=attach_failed") {
		t.Fatalf("logs lack attach_failed:\n%s", logs.String())
	}
}

func TestPiPrestartNotAdoptedForAnotherSession(t *testing.T) {
	for name, run := range map[string]RunSpec{
		"other create": {AssignSessionID: "other-session"},
		"resume":       {ResumeID: "prestart-sess", ResumeRequired: true},
	} {
		t.Run(name, func(t *testing.T) {
			h := piNewResidentHome(t, map[string]string{piResidentSyncMCPEnv: "ok"})
			h.withExtension()
			h.prestart(RunSpec{AssignSessionID: "prestart-sess"})
			if run.ResumeID != "" {
				if _, err := h.runtime().Start(t.Context(), "go", RunSpec{Dir: h.dir, ResumeID: run.ResumeID, ResumeRequired: true}); err == nil {
					t.Fatal("resume adopted an unmaterialized create pre-start")
				}
				return
			}
			if _, out := h.turn("go", run); out.Status != statusCompleted || h.lines("spawn") != 2 {
				t.Fatalf("out=%+v spawns=%d", out, h.lines("spawn"))
			}
		})
	}
}

func TestPiResidentAttachesChangedMCPInPlace(t *testing.T) {
	h := piNewResidentHome(t, map[string]string{piResidentSyncMCPEnv: "ok"})
	h.withExtension()
	proc := h.createParked("dynamic-mcp", RunSpec{MCPServers: piMCPFixture("one", "http://127.0.0.1:9/target")})
	if _, out := h.turn("again", RunSpec{ResumeID: "dynamic-mcp", MCPServers: piMCPFixture("two", "http://127.0.0.1:9/target")}); out.Status != statusCompleted {
		t.Fatalf("second turn = %+v", out)
	}
	if h.parked("dynamic-mcp") != proc || h.lines("spawn") != 1 || h.lines("sync_mcp") != 1 {
		t.Fatalf("spawns=%d syncs=%d, want 1 spawn and 1 in-place sync", h.lines("spawn"), h.lines("sync_mcp"))
	}
}

func TestPiPrestartWithoutExtensionAdoptsEmptyMCPRun(t *testing.T) {
	h := piNewResidentHome(t, nil)
	if pre := h.prestart(RunSpec{AssignSessionID: "prestart-no-ext"}); pre.Status != statusCompleted || !pre.Parked {
		t.Fatalf("pre-start = %+v", pre)
	}
	if _, out := h.turn("go", RunSpec{AssignSessionID: "prestart-no-ext"}); out.Status != statusCompleted || h.lines("spawn") != 1 {
		t.Fatalf("out=%+v spawns=%d", out, h.lines("spawn"))
	}
}
