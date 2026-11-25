package native

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type agyResidentHarness struct {
	t       *testing.T
	dir     string
	home    string
	record  string
	pidFile string
	profile Profile
}

func newAgyResidentHarness(t *testing.T, mode string, extra map[string]string) *agyResidentHarness {
	t.Helper()
	withResidentCap(t, antigravityResidents, DefaultResidentCap)
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	dir := filepath.Join(base, "work")
	home := filepath.Join(base, "home")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	record := filepath.Join(base, "requests.jsonl")
	pidFile := filepath.Join(base, "pids.txt")
	env := map[string]string{
		agyFakeEnv:             mode,
		agyFakeRecordEnv:       record,
		agyFakePIDFileEnv:      pidFile,
		agyFakeCapabilitiesEnv: "full",
		"HOME":                 home,
	}
	for k, v := range extra {
		env[k] = v
	}
	h := &agyResidentHarness{
		t:       t,
		dir:     dir,
		home:    home,
		record:  record,
		pidFile: pidFile,
		profile: Profile{
			Program:    program,
			Env:        env,
			ContextKey: "agy-ctx-" + piRandomHex(6),
			AgentID:    "agy-agent-" + piRandomHex(6),
		},
	}
	t.Cleanup(func() { _, _ = StopParkedResidentsForContext(h.profile.ContextKey) })
	return h
}

func (h *agyResidentHarness) runtime() Runtime {
	rt, err := Open("antigravity", h.profile)
	if err != nil {
		h.t.Fatal(err)
	}
	return rt
}

func (h *agyResidentHarness) pids() []int {
	h.t.Helper()
	data, err := os.ReadFile(h.pidFile)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		h.t.Fatal(err)
	}
	var out []int
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line == "" {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSpace(line))
		if err != nil {
			h.t.Fatalf("bad pid %q: %v", line, err)
		}
		out = append(out, pid)
	}
	return out
}

func (h *agyResidentHarness) requests() map[string][]map[string]any {
	h.t.Helper()
	file, err := os.Open(h.record)
	if os.IsNotExist(err) {
		return map[string][]map[string]any{}
	}
	if err != nil {
		h.t.Fatal(err)
	}
	defer file.Close()
	out := map[string][]map[string]any{}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		var frame map[string]any
		if json.Unmarshal(scanner.Bytes(), &frame) != nil {
			h.t.Fatalf("recorded frame is not JSON: %s", scanner.Text())
		}
		method, _ := frame["method"].(string)
		out[method] = append(out[method], frame)
	}
	return out
}

func agyMCPServer(t *testing.T) (*httptest.Server, func() []map[string]any) {
	t.Helper()
	var mu sync.Mutex
	var calls []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var decoded map[string]any
		_ = json.Unmarshal(body, &decoded)
		mu.Lock()
		calls = append(calls, decoded)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	t.Cleanup(server.Close)
	return server, func() []map[string]any {
		mu.Lock()
		defer mu.Unlock()
		return append([]map[string]any(nil), calls...)
	}
}

func agyMCPConfig(servers map[string]string) json.RawMessage {
	entries := map[string]any{}
	for name, target := range servers {
		entries[name] = map[string]any{"type": "http", "url": target}
	}
	raw, _ := json.Marshal(map[string]any{"mcpServers": entries})
	return raw
}

func TestAntigravityPrestartBlankRoomAndRepeatedPrepare(t *testing.T) {
	for _, capMode := range []string{"full", "snake"} {
		t.Run(capMode, func(t *testing.T) {
			h := newAgyResidentHarness(t, "turn", map[string]string{agyFakeCapabilitiesEnv: capMode})
			counters := &ReadinessCounters{}
			run, err := h.runtime().Start(t.Context(), "", RunSpec{
				Dir: h.dir, PrepareOnly: true, Readiness: counters,
			})
			if err != nil {
				t.Fatal(err)
			}
			events, out := drainAgy(t, run)
			if len(events) != 0 || out.Status != statusCompleted || !out.Parked || out.SessionID != "" {
				t.Fatalf("events=%+v out=%+v", events, out)
			}
			if !holdsPrestart() || !ContextHasParkedResident(h.profile.ContextKey) {
				t.Fatalf("expected parked prestart for %s", h.profile.ContextKey)
			}
			if counters.spawns != 1 || counters.sessionStarts != 0 || counters.sessionResumes != 0 {
				t.Fatalf("readiness=%+v, want spawns=1 sessionStarts=0 sessionResumes=0", counters)
			}
			reqs := h.requests()
			if len(reqs["initialize"]) != 1 || len(reqs["session/list"]) != 1 || len(reqs["session/new"]) != 0 || len(reqs["session/resume"]) != 0 {
				t.Fatalf("unexpected prestart requests: %v", reqs)
			}
			if _, err := os.Stat(filepath.Join(h.home, ".gemini", "antigravity-cli", "conversations")); !os.IsNotExist(err) {
				t.Fatalf("prestart must not create conversation files: err=%v", err)
			}

			repeatCounters := &ReadinessCounters{}
			repeatRun, err := h.runtime().Start(t.Context(), "", RunSpec{
				Dir: h.dir, PrepareOnly: true, Readiness: repeatCounters,
			})
			if err != nil {
				t.Fatal(err)
			}
			_, repeatOut := drainAgy(t, repeatRun)
			if repeatOut.Status != statusCompleted || repeatOut.Parked {
				t.Fatalf("repeat=%+v, want Parked=false (already_ready)", repeatOut)
			}
			if repeatCounters.spawns != 0 {
				t.Fatalf("repeat spawns=%d, want 0", repeatCounters.spawns)
			}
			if pids := h.pids(); len(pids) != 1 {
				t.Fatalf("pids=%v, want 1", pids)
			}
		})
	}
}

func TestAntigravityPrestartAdoptedByBlankAndHistoricalRooms(t *testing.T) {
	t.Run("blank", func(t *testing.T) {
		upstream, calls := agyMCPServer(t)
		h := newAgyResidentHarness(t, "turn", map[string]string{agyFakeMCPCallEnv: "1"})
		preRun, err := h.runtime().Start(t.Context(), "", RunSpec{Dir: h.dir, PrepareOnly: true})
		if err != nil {
			t.Fatal(err)
		}
		if _, preOut := drainAgy(t, preRun); !preOut.Parked {
			t.Fatalf("prestart=%+v", preOut)
		}

		counters := &ReadinessCounters{}
		run, err := h.runtime().Start(t.Context(), "hello blank", RunSpec{
			Dir:               h.dir,
			ExposeTurnStarted: true,
			MCPServers:        agyMCPConfig(map[string]string{"teamhub": upstream.URL}),
			Readiness:         counters,
		})
		if err != nil {
			t.Fatal(err)
		}
		events, out := drainAgy(t, run)
		if out.Status != statusCompleted || out.SessionID != "fake-session" || out.ExitConfirmed || holdsPrestart() {
			t.Fatalf("out=%+v holdsPrestart=%v", out, holdsPrestart())
		}
		if counters.spawns != 0 || counters.sessionStarts != 1 || counters.sessionResumes != 0 {
			t.Fatalf("counters=%+v, want spawns=0 sessionStarts=1", counters)
		}
		if pids := h.pids(); len(pids) != 1 {
			t.Fatalf("pids=%v, want 1", pids)
		}
		if len(events) == 0 || events[0].Kind != EventStatus || events[0].ProcessReused == nil || !*events[0].ProcessReused {
			t.Fatalf("expected ProcessReused=true on turn started: %+v", events)
		}
		reqs := h.requests()
		if len(reqs["initialize"]) != 1 || len(reqs["session/list"]) != 1 || len(reqs["session/new"]) != 1 || len(reqs["session/resume"]) != 0 {
			t.Fatalf("requests=%v", reqs)
		}
		openServers, _ := json.Marshal(reqs["session/new"][0]["params"].(map[string]any)["mcpServers"])
		if !strings.Contains(string(openServers), "/mcp/") || strings.Contains(string(openServers), upstream.URL) {
			t.Fatalf("adopted session/new must rewrite MCP url through mcpFront: %s", openServers)
		}
		if got := calls(); len(got) != 1 || got[0]["prompt"] != "hello blank" {
			t.Fatalf("upstream calls=%+v", got)
		}
	})

	t.Run("historical", func(t *testing.T) {
		upstream, calls := agyMCPServer(t)
		h := newAgyResidentHarness(t, "turn", map[string]string{agyFakeMCPCallEnv: "1"})
		preRun, err := h.runtime().Start(t.Context(), "", RunSpec{Dir: h.dir, ResumeID: "hist-session", PrepareOnly: true})
		if err != nil {
			t.Fatal(err)
		}
		if _, preOut := drainAgy(t, preRun); !preOut.Parked || preOut.SessionID != "hist-session" {
			t.Fatalf("prestart=%+v", preOut)
		}

		counters := &ReadinessCounters{}
		run, err := h.runtime().Start(t.Context(), "hello history", RunSpec{
			Dir:               h.dir,
			ResumeID:          "hist-session",
			ExposeTurnStarted: true,
			MCPServers:        agyMCPConfig(map[string]string{"teamhub": upstream.URL}),
			Readiness:         counters,
		})
		if err != nil {
			t.Fatal(err)
		}
		events, out := drainAgy(t, run)
		if out.Status != statusCompleted || out.SessionID != "hist-session" || out.ExitConfirmed || holdsPrestart() {
			t.Fatalf("out=%+v holdsPrestart=%v", out, holdsPrestart())
		}
		if counters.spawns != 0 || counters.sessionStarts != 0 || counters.sessionResumes != 1 {
			t.Fatalf("counters=%+v, want spawns=0 sessionResumes=1", counters)
		}
		if pids := h.pids(); len(pids) != 1 {
			t.Fatalf("pids=%v, want 1", pids)
		}
		if len(events) == 0 || events[0].Kind != EventStatus || events[0].ProcessReused == nil || !*events[0].ProcessReused {
			t.Fatalf("expected ProcessReused=true on turn started: %+v", events)
		}
		reqs := h.requests()
		if len(reqs["initialize"]) != 1 || len(reqs["session/list"]) != 1 || len(reqs["session/resume"]) != 1 || len(reqs["session/new"]) != 0 {
			t.Fatalf("requests=%v", reqs)
		}
		if got := calls(); len(got) != 1 || got[0]["sessionId"] != "hist-session" {
			t.Fatalf("upstream calls=%+v", got)
		}
	})

	t.Run("stdio_mcp_adopts_without_parking", func(t *testing.T) {
		h := newAgyResidentHarness(t, "turn", nil)
		preRun, err := h.runtime().Start(t.Context(), "", RunSpec{Dir: h.dir, PrepareOnly: true})
		if err != nil {
			t.Fatal(err)
		}
		if _, preOut := drainAgy(t, preRun); !preOut.Parked {
			t.Fatalf("prestart=%+v", preOut)
		}
		run, err := h.runtime().Start(t.Context(), "stdio turn", RunSpec{
			Dir:               h.dir,
			ExposeTurnStarted: true,
			MCPServers:        json.RawMessage(`{"mcpServers":{"local":{"command":"/bin/tool","args":["--stdio"]}}}`),
		})
		if err != nil {
			t.Fatal(err)
		}
		events, out := drainAgy(t, run)
		if out.Status != statusCompleted || !out.ExitConfirmed {
			t.Fatalf("out=%+v, want completed with ExitConfirmed=true", out)
		}
		if len(events) == 0 || events[0].ProcessReused == nil || !*events[0].ProcessReused {
			t.Fatalf("expected stdio turn to adopt prestart: %+v", events)
		}
		if pids := h.pids(); len(pids) != 1 {
			t.Fatalf("pids=%v, want 1", pids)
		}
		if ContextHasParkedResident(h.profile.ContextKey) {
			t.Fatal("stdio MCP turn must not park after completing")
		}
	})
}

func TestAntigravityLegacyServerPrestartNotEligibleAndRunFallsBackToLoad(t *testing.T) {
	for _, capMode := range []string{"", "no-list", "no-resume", "false", "null"} {
		name := capMode
		if name == "" {
			name = "omitted"
		}
		t.Run(name, func(t *testing.T) {
			h := newAgyResidentHarness(t, "turn", map[string]string{agyFakeCapabilitiesEnv: capMode})
			_, err := h.runtime().Start(t.Context(), "", RunSpec{Dir: h.dir, PrepareOnly: true})
			if !errors.Is(err, ErrProviderPrepareNotEligible) {
				t.Fatalf("err=%v, want ErrProviderPrepareNotEligible", err)
			}
			if _, _, parked := residentEntryOf(antigravityResidents, h.profile.ContextKey); parked {
				t.Fatal("ineligible prestart must not remain in resident table")
			}

			run, err := h.runtime().Start(t.Context(), "legacy resume", RunSpec{Dir: h.dir, ResumeID: "legacy-session"})
			if err != nil {
				t.Fatal(err)
			}
			_, out := drainAgy(t, run)
			if out.Status != statusCompleted || !out.ExitConfirmed {
				t.Fatalf("legacy run=%+v, want completed with ExitConfirmed=true", out)
			}
			if _, _, parked := residentEntryOf(antigravityResidents, h.profile.ContextKey); parked {
				t.Fatal("legacy server must not park after run")
			}
			reqs := h.requests()
			wantMethod := "session/load"
			if capMode == "no-list" {
				// Advertises resume without list: uses session/resume but still never parks.
				wantMethod = "session/resume"
			}
			if len(reqs[wantMethod]) != 1 {
				t.Fatalf("requests=%v, want 1 %s", reqs, wantMethod)
			}
		})
	}
}

func TestAntigravityPrestartAuthenticatesWithAPIKeyWhenSignedOut(t *testing.T) {
	h := newAgyResidentHarness(t, "signed-out", map[string]string{"GEMINI_API_KEY": "fixture-key"})
	run, err := h.runtime().Start(t.Context(), "", RunSpec{Dir: h.dir, PrepareOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	_, out := drainAgy(t, run)
	if out.Status != statusCompleted || !out.Parked {
		t.Fatalf("out=%+v, want parked", out)
	}
	reqs := h.requests()
	if len(reqs["authenticate"]) != 1 || len(reqs["session/list"]) != 2 {
		t.Fatalf("requests=%v, want 1 authenticate and 2 session/list", reqs)
	}
}

func TestAntigravityPrestartIdleReclaim(t *testing.T) {
	previous := antigravityResidents.setIdle(80 * time.Millisecond)
	t.Cleanup(func() { antigravityResidents.setIdle(previous) })

	// Unused prestart is reclaimed after idle delay.
	unused := newAgyResidentHarness(t, "turn", nil)
	preRun, err := unused.runtime().Start(t.Context(), "", RunSpec{Dir: unused.dir, PrepareOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, out := drainAgy(t, preRun); !out.Parked {
		t.Fatalf("unused prestart=%+v", out)
	}
	awaitTrue(t, "unused prestart idle reclaim", 5*time.Second, func() bool {
		_, _, ok := residentEntryOf(antigravityResidents, unused.profile.ContextKey)
		return !ok
	})

	// Run-adopted process is NOT reclaimed by the prestart idle timer.
	adopted := newAgyResidentHarness(t, "turn", nil)
	pre2, err := adopted.runtime().Start(t.Context(), "", RunSpec{Dir: adopted.dir, PrepareOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, out := drainAgy(t, pre2); !out.Parked {
		t.Fatalf("adopted prestart=%+v", out)
	}
	run, err := adopted.runtime().Start(t.Context(), "adopt now", RunSpec{Dir: adopted.dir})
	if err != nil {
		t.Fatal(err)
	}
	if _, out := drainAgy(t, run); out.Status != statusCompleted || out.ExitConfirmed {
		t.Fatalf("adopted run=%+v", out)
	}
	time.Sleep(200 * time.Millisecond)
	proc, retiring, ok := residentEntryOf(antigravityResidents, adopted.profile.ContextKey)
	if !ok || retiring || !proc.alive() {
		t.Fatalf("Run-adopted process was reclaimed: ok=%v retiring=%v", ok, retiring)
	}
}
