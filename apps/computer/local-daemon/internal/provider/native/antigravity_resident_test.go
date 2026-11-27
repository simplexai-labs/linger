package native

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestAntigravityResidentReusesAcrossTurnsWithMCPFront(t *testing.T) {
	upstream1, calls1 := agyMCPServer(t)
	upstream2, calls2 := agyMCPServer(t)
	h := newAgyResidentHarness(t, "turn", map[string]string{agyFakeMCPCallEnv: "1"})

	// Turn 1: cold spawn with upstream1.
	run1, err := h.runtime().Start(t.Context(), "turn one", RunSpec{
		Dir:               h.dir,
		ExposeTurnStarted: true,
		MCPServers:        agyMCPConfig(map[string]string{"teamhub": upstream1.URL}),
	})
	if err != nil {
		t.Fatal(err)
	}
	events1, out1 := drainAgy(t, run1)
	if out1.Status != statusCompleted || out1.SessionID != "fake-session" || out1.ExitConfirmed {
		t.Fatalf("turn1=%+v", out1)
	}
	if events1[0].ProcessReused == nil || *events1[0].ProcessReused {
		t.Fatalf("turn1 expected ProcessReused=false: %+v", events1[0])
	}
	if got := calls1(); len(got) != 1 || got[0]["prompt"] != "turn one" {
		t.Fatalf("upstream1 calls=%+v", got)
	}

	// While parked, the resident front must answer 503 and never touch upstream1.
	proc, retiring, ok := residentEntryOf(antigravityResidents, h.profile.ContextKey)
	if !ok || retiring || proc.front == nil {
		t.Fatalf("parked proc=%v retiring=%v ok=%v", proc, retiring, ok)
	}
	resp, err := http.Post(proc.front.URL("teamhub"), "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("parked front status=%d, want 503", resp.StatusCode)
	}
	if len(calls1()) != 1 {
		t.Fatal("parked front forwarded a request to upstream1")
	}

	// Turn 2: same MCP server name with new upstream2 URL reuses same PID.
	counters2 := &ReadinessCounters{}
	run2, err := h.runtime().Start(t.Context(), "turn two", RunSpec{
		Dir:               h.dir,
		ResumeID:          out1.SessionID,
		ExposeTurnStarted: true,
		MCPServers:        agyMCPConfig(map[string]string{"teamhub": upstream2.URL}),
		Readiness:         counters2,
	})
	if err != nil {
		t.Fatal(err)
	}
	events2, out2 := drainAgy(t, run2)
	if out2.Status != statusCompleted || out2.SessionID != out1.SessionID || out2.ExitConfirmed {
		t.Fatalf("turn2=%+v", out2)
	}
	if counters2.spawns != 0 {
		t.Fatalf("turn2 spawns=%d, want 0", counters2.spawns)
	}
	if events2[0].ProcessReused == nil || !*events2[0].ProcessReused {
		t.Fatalf("turn2 expected ProcessReused=true: %+v", events2[0])
	}
	if pids := h.pids(); len(pids) != 1 {
		t.Fatalf("pids=%v, want 1 reused PID", pids)
	}
	reqs := h.requests()
	if len(reqs["initialize"]) != 1 || len(reqs["session/new"]) != 1 || len(reqs["session/resume"]) != 0 || len(reqs["session/prompt"]) != 2 {
		t.Fatalf("unexpected requests: %v", reqs)
	}
	if len(calls1()) != 1 {
		t.Fatalf("upstream1 received calls during turn 2: %+v", calls1())
	}
	if got := calls2(); len(got) != 1 || got[0]["prompt"] != "turn two" {
		t.Fatalf("upstream2 calls=%+v", got)
	}
}

func TestAntigravityResidentRecyclesOnMCPAddAndRemove(t *testing.T) {
	t.Run("add", func(t *testing.T) {
		u1, calls1 := agyMCPServer(t)
		u2, calls2 := agyMCPServer(t)
		h := newAgyResidentHarness(t, "turn", map[string]string{agyFakeMCPCallEnv: "1"})

		r1, err := h.runtime().Start(t.Context(), "t1", RunSpec{
			Dir: h.dir, MCPServers: agyMCPConfig(map[string]string{"teamhub": u1.URL}),
		})
		if err != nil {
			t.Fatal(err)
		}
		_, out1 := drainAgy(t, r1)
		proc1, _, ok := residentEntryOf(antigravityResidents, h.profile.ContextKey)
		if !ok {
			t.Fatal("turn1 did not park")
		}

		counters := &ReadinessCounters{}
		r2, err := h.runtime().Start(t.Context(), "t2", RunSpec{
			Dir: h.dir, ResumeID: out1.SessionID,
			MCPServers: agyMCPConfig(map[string]string{"teamhub": u1.URL, "browser": u2.URL}),
			Readiness:  counters,
		})
		if err != nil {
			t.Fatal(err)
		}
		_, out2 := drainAgy(t, r2)
		if out2.Status != statusCompleted {
			t.Fatalf("turn2=%+v", out2)
		}
		if counters.spawns != 1 || counters.recycles["incompatible:mcp"] != 1 {
			t.Fatalf("counters=%+v, want spawn=1 incompatible:mcp=1", counters)
		}
		if proc1.alive() {
			t.Fatal("old PID stayed alive after MCP add recycle")
		}
		if pids := h.pids(); len(pids) != 2 || pids[0] == pids[1] {
			t.Fatalf("pids=%v, want 2 distinct PIDs", pids)
		}
		if len(calls1()) != 2 || len(calls2()) != 1 {
			t.Fatalf("calls1=%d calls2=%d", len(calls1()), len(calls2()))
		}
	})

	t.Run("remove", func(t *testing.T) {
		u1, calls1 := agyMCPServer(t)
		u2, calls2 := agyMCPServer(t)
		h := newAgyResidentHarness(t, "turn", map[string]string{agyFakeMCPCallEnv: "1"})

		r1, err := h.runtime().Start(t.Context(), "t1", RunSpec{
			Dir: h.dir, MCPServers: agyMCPConfig(map[string]string{"teamhub": u1.URL, "browser": u2.URL}),
		})
		if err != nil {
			t.Fatal(err)
		}
		_, out1 := drainAgy(t, r1)
		proc1, _, ok := residentEntryOf(antigravityResidents, h.profile.ContextKey)
		if !ok {
			t.Fatal("turn1 did not park")
		}

		counters := &ReadinessCounters{}
		r2, err := h.runtime().Start(t.Context(), "t2", RunSpec{
			Dir: h.dir, ResumeID: out1.SessionID,
			MCPServers: agyMCPConfig(map[string]string{"teamhub": u1.URL}),
			Readiness:  counters,
		})
		if err != nil {
			t.Fatal(err)
		}
		_, out2 := drainAgy(t, r2)
		if out2.Status != statusCompleted {
			t.Fatalf("turn2=%+v", out2)
		}
		if counters.spawns != 1 || counters.recycles["incompatible:mcp"] != 1 {
			t.Fatalf("counters=%+v, want spawn=1 incompatible:mcp=1", counters)
		}
		if proc1.alive() {
			t.Fatal("old PID stayed alive after MCP remove recycle")
		}
		if pids := h.pids(); len(pids) != 2 || pids[0] == pids[1] {
			t.Fatalf("pids=%v, want 2 distinct PIDs", pids)
		}
		if len(calls1()) != 2 || len(calls2()) != 1 {
			t.Fatalf("removed MCP server must not be called on turn 2: calls1=%d calls2=%d", len(calls1()), len(calls2()))
		}
	})
}

func TestAntigravityResidentHotUpdatesSystemPrompt(t *testing.T) {
	u1, calls1 := agyMCPServer(t)
	u2, calls2 := agyMCPServer(t)
	h := newAgyResidentHarness(t, "turn", map[string]string{agyFakeMCPCallEnv: "1"})

	r1, err := h.runtime().Start(t.Context(), "t1", RunSpec{
		Dir: h.dir, SystemPrompt: "Be brief.",
		MCPServers: agyMCPConfig(map[string]string{"teamhub": u1.URL}),
	})
	if err != nil {
		t.Fatal(err)
	}
	_, out1 := drainAgy(t, r1)
	if out1.Status != statusCompleted {
		t.Fatalf("turn1=%+v", out1)
	}

	// Non-empty -> new non-empty.
	c2 := &ReadinessCounters{}
	r2, err := h.runtime().Start(t.Context(), "t2", RunSpec{
		Dir: h.dir, ResumeID: out1.SessionID, SystemPrompt: "Be thorough.",
		MCPServers: agyMCPConfig(map[string]string{"teamhub": u2.URL}),
		Readiness:  c2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, out2 := drainAgy(t, r2); out2.Status != statusCompleted || c2.spawns != 0 {
		t.Fatalf("turn2=%+v spawns=%d", out2, c2.spawns)
	}

	// Non-empty -> empty.
	c3 := &ReadinessCounters{}
	r3, err := h.runtime().Start(t.Context(), "t3", RunSpec{
		Dir: h.dir, ResumeID: out1.SessionID, SystemPrompt: "",
		MCPServers: agyMCPConfig(map[string]string{"teamhub": u2.URL}),
		Readiness:  c3,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, out3 := drainAgy(t, r3); out3.Status != statusCompleted || c3.spawns != 0 {
		t.Fatalf("turn3=%+v spawns=%d", out3, c3.spawns)
	}

	if pids := h.pids(); len(pids) != 1 {
		t.Fatalf("pids=%v, want 1 reused PID across prompt updates", pids)
	}
	resumes := h.requests()["session/resume"]
	if len(resumes) != 2 {
		t.Fatalf("session/resume count=%d, want 2", len(resumes))
	}
	for i, wantPrompt := range []string{"Be thorough.", ""} {
		params := resumes[i]["params"].(map[string]any)
		servers, _ := json.Marshal(params["mcpServers"])
		if string(servers) != "[]" {
			t.Fatalf("resume[%d] mcpServers=%s, want []", i, servers)
		}
		gotPrompt := params["_meta"].(map[string]any)["antigravity"].(map[string]any)["systemPrompt"].(map[string]any)["append"]
		if gotPrompt != wantPrompt {
			t.Fatalf("resume[%d] append=%q, want %q", i, gotPrompt, wantPrompt)
		}
	}
	if len(calls1()) != 1 || len(calls2()) != 2 {
		t.Fatalf("calls1=%d calls2=%d, want 1 and 2", len(calls1()), len(calls2()))
	}
}

func TestAntigravityResidentHotUpdatesModelAndEffortAndRevertsToDefault(t *testing.T) {
	t.Run("hot_update_and_revert", func(t *testing.T) {
		h := newAgyResidentHarness(t, "turn", nil)
		r1, err := h.runtime().Start(t.Context(), "t1", RunSpec{Dir: h.dir})
		if err != nil {
			t.Fatal(err)
		}
		_, out1 := drainAgy(t, r1)

		// Override model and effort on Turn 2.
		c2 := &ReadinessCounters{}
		r2, err := h.runtime().Start(t.Context(), "t2", RunSpec{
			Dir: h.dir, ResumeID: out1.SessionID, Model: "gemini-flash", Effort: "medium", Readiness: c2,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, out2 := drainAgy(t, r2); out2.Status != statusCompleted || c2.spawns != 0 {
			t.Fatalf("turn2=%+v spawns=%d", out2, c2.spawns)
		}

		// Same model and effort on Turn 3 sends no extra config calls.
		r3, err := h.runtime().Start(t.Context(), "t3", RunSpec{
			Dir: h.dir, ResumeID: out1.SessionID, Model: "gemini-flash", Effort: "medium",
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, out3 := drainAgy(t, r3); out3.Status != statusCompleted {
			t.Fatalf("turn3=%+v", out3)
		}

		// Revert back to default model and empty effort on Turn 4.
		c4 := &ReadinessCounters{}
		r4, err := h.runtime().Start(t.Context(), "t4", RunSpec{
			Dir: h.dir, ResumeID: out1.SessionID, Model: antigravityDefaultModel, Effort: "", Readiness: c4,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, out4 := drainAgy(t, r4); out4.Status != statusCompleted || c4.spawns != 0 {
			t.Fatalf("turn4=%+v spawns=%d", out4, c4.spawns)
		}

		if pids := h.pids(); len(pids) != 1 {
			t.Fatalf("pids=%v, want 1 reused PID", pids)
		}
		var options []string
		for _, frame := range h.requests()["session/set_config_option"] {
			params := frame["params"].(map[string]any)
			options = append(options, params["configId"].(string)+"="+params["value"].(string))
		}
		want := []string{"model=gemini-flash", "thought_level=medium", "model=gemini-pro", "thought_level=low"}
		if !reflect.DeepEqual(options, want) {
			t.Fatalf("options=%v, want %v", options, want)
		}
	})

	t.Run("recycles_when_server_omits_defaults", func(t *testing.T) {
		h := newAgyResidentHarness(t, "turn", map[string]string{agyFakeNoDefaultsEnv: "1"})
		r1, err := h.runtime().Start(t.Context(), "t1", RunSpec{
			Dir: h.dir, Model: "gemini-flash", Effort: "medium",
		})
		if err != nil {
			t.Fatal(err)
		}
		_, out1 := drainAgy(t, r1)
		c2 := &ReadinessCounters{}
		r2, err := h.runtime().Start(t.Context(), "t2", RunSpec{
			Dir: h.dir, ResumeID: out1.SessionID, Model: antigravityDefaultModel, Effort: "", Readiness: c2,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, out2 := drainAgy(t, r2); out2.Status != statusCompleted {
			t.Fatalf("turn2=%+v", out2)
		}
		if c2.spawns != 1 || c2.recycles["incompatible:model+thinking"] != 1 {
			t.Fatalf("counters=%+v, want spawn=1 incompatible:model+thinking=1", c2)
		}
		if pids := h.pids(); len(pids) != 2 {
			t.Fatalf("pids=%v, want 2", pids)
		}
	})
}

func TestAntigravityResidentCrossModelEffortAndEffortlessModelSwitch(t *testing.T) {
	t.Run("cross_model_clear_effort_recycles", func(t *testing.T) {
		h := newAgyResidentHarness(t, "turn", nil)
		r1, err := h.runtime().Start(t.Context(), "t1", RunSpec{
			Dir: h.dir, Model: "gemini-pro", Effort: "high",
		})
		if err != nil {
			t.Fatal(err)
		}
		_, out1 := drainAgy(t, r1)

		c2 := &ReadinessCounters{}
		r2, err := h.runtime().Start(t.Context(), "t2", RunSpec{
			Dir: h.dir, ResumeID: out1.SessionID, Model: "gemini-flash", Effort: "", Readiness: c2,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, out2 := drainAgy(t, r2); out2.Status != statusCompleted {
			t.Fatalf("turn2=%+v", out2)
		}
		if c2.spawns != 1 || c2.recycles["incompatible:thinking"] != 1 {
			t.Fatalf("counters=%+v, want spawn=1 incompatible:thinking=1", c2)
		}
		if pids := h.pids(); len(pids) != 2 || pids[0] == pids[1] {
			t.Fatalf("pids=%v, want 2 distinct PIDs", pids)
		}
		for _, frame := range h.requests()["session/set_config_option"] {
			params := frame["params"].(map[string]any)
			if params["configId"] == "thought_level" && params["value"] == "low" {
				t.Fatalf("must not apply gemini-pro default thought_level=low to gemini-flash: %v", params)
			}
		}
	})

	t.Run("non_default_model_clear_effort_recycles", func(t *testing.T) {
		h := newAgyResidentHarness(t, "turn", nil)
		r1, err := h.runtime().Start(t.Context(), "t1", RunSpec{
			Dir: h.dir, Model: "gemini-flash", Effort: "medium",
		})
		if err != nil {
			t.Fatal(err)
		}
		_, out1 := drainAgy(t, r1)

		c2 := &ReadinessCounters{}
		r2, err := h.runtime().Start(t.Context(), "t2", RunSpec{
			Dir: h.dir, ResumeID: out1.SessionID, Model: "gemini-flash", Effort: "", Readiness: c2,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, out2 := drainAgy(t, r2); out2.Status != statusCompleted {
			t.Fatalf("turn2=%+v", out2)
		}
		if c2.spawns != 1 || c2.recycles["incompatible:thinking"] != 1 {
			t.Fatalf("counters=%+v, want spawn=1 incompatible:thinking=1", c2)
		}
		if pids := h.pids(); len(pids) != 2 || pids[0] == pids[1] {
			t.Fatalf("pids=%v, want 2 distinct PIDs", pids)
		}
	})

	t.Run("effortless_model_switch_does_not_skip_next_effort", func(t *testing.T) {
		h := newAgyResidentHarness(t, "turn", nil)
		// Turn 1 selects gemini-flash without an effort override; fake returns
		// empty configOptions on set_config_option("model", "gemini-flash").
		r1, err := h.runtime().Start(t.Context(), "t1", RunSpec{
			Dir: h.dir, Model: "gemini-flash", Effort: "",
		})
		if err != nil {
			t.Fatal(err)
		}
		_, out1 := drainAgy(t, r1)

		// Turn 2 keeps gemini-flash and requests Effort="low" (matching the
		// initial gemini-pro default); it must still send set_config_option.
		c2 := &ReadinessCounters{}
		r2, err := h.runtime().Start(t.Context(), "t2", RunSpec{
			Dir: h.dir, ResumeID: out1.SessionID, Model: "gemini-flash", Effort: "low", Readiness: c2,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, out2 := drainAgy(t, r2); out2.Status != statusCompleted || c2.spawns != 0 {
			t.Fatalf("turn2=%+v spawns=%d", out2, c2.spawns)
		}
		if pids := h.pids(); len(pids) != 1 {
			t.Fatalf("pids=%v, want 1 reused PID", pids)
		}
		var options []string
		for _, frame := range h.requests()["session/set_config_option"] {
			params := frame["params"].(map[string]any)
			options = append(options, params["configId"].(string)+"="+params["value"].(string))
		}
		want := []string{"model=gemini-flash", "thought_level=low"}
		if !reflect.DeepEqual(options, want) {
			t.Fatalf("options=%v, want %v", options, want)
		}
	})
}

func TestAntigravityResidentHotUpdateSystemPromptEdgeCases(t *testing.T) {
	t.Run("reapplies_model_and_effort_after_resume_reset", func(t *testing.T) {
		h := newAgyResidentHarness(t, "turn", nil)
		r1, err := h.runtime().Start(t.Context(), "t1", RunSpec{
			Dir: h.dir, Model: "gemini-flash", Effort: "medium", SystemPrompt: "v1",
		})
		if err != nil {
			t.Fatal(err)
		}
		_, out1 := drainAgy(t, r1)

		// Turn 2 changes SystemPrompt while keeping gemini-flash/medium; fake's
		// session/resume returns default configOptions (gemini-pro/low), so the
		// turn must re-apply model=gemini-flash and thought_level=medium.
		c2 := &ReadinessCounters{}
		r2, err := h.runtime().Start(t.Context(), "t2", RunSpec{
			Dir: h.dir, ResumeID: out1.SessionID, Model: "gemini-flash", Effort: "medium", SystemPrompt: "v2", Readiness: c2,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, out2 := drainAgy(t, r2); out2.Status != statusCompleted || c2.spawns != 0 {
			t.Fatalf("turn2=%+v spawns=%d", out2, c2.spawns)
		}
		if pids := h.pids(); len(pids) != 1 {
			t.Fatalf("pids=%v, want 1 reused PID", pids)
		}
		var options []string
		for _, frame := range h.requests()["session/set_config_option"] {
			params := frame["params"].(map[string]any)
			options = append(options, params["configId"].(string)+"="+params["value"].(string))
		}
		want := []string{"model=gemini-flash", "thought_level=medium", "model=gemini-flash", "thought_level=medium"}
		if !reflect.DeepEqual(options, want) {
			t.Fatalf("options=%v, want %v", options, want)
		}
	})

	t.Run("resume_error_returns_session_not_found_without_parking", func(t *testing.T) {
		h := newAgyResidentHarness(t, "resume-error", nil)
		r1, err := h.runtime().Start(t.Context(), "t1", RunSpec{
			Dir: h.dir, SystemPrompt: "v1",
		})
		if err != nil {
			t.Fatal(err)
		}
		_, out1 := drainAgy(t, r1)
		if out1.Status != statusCompleted || out1.ExitConfirmed {
			t.Fatalf("turn1=%+v", out1)
		}

		r2, err := h.runtime().Start(t.Context(), "t2", RunSpec{
			Dir: h.dir, ResumeID: out1.SessionID, SystemPrompt: "v2",
		})
		if err != nil {
			t.Fatal(err)
		}
		_, out2 := drainAgy(t, r2)
		if out2.Status != statusFailed || out2.FailureCode != "session_not_found" || !out2.ResumeRefused || out2.SessionID != "" || !out2.ExitConfirmed {
			t.Fatalf("turn2=%+v, want failed session_not_found with ResumeRefused and ExitConfirmed", out2)
		}
		if _, _, parked := residentEntryOf(antigravityResidents, h.profile.ContextKey); parked {
			t.Fatal("failed hot-update session/resume must not park")
		}
	})
}

func TestAntigravityResidentRecyclesOnMCPHeadersAndStdioTransition(t *testing.T) {
	t.Run("headers_changed", func(t *testing.T) {
		u1, _ := agyMCPServer(t)
		h := newAgyResidentHarness(t, "turn", map[string]string{agyFakeMCPCallEnv: "1"})
		r1, err := h.runtime().Start(t.Context(), "t1", RunSpec{
			Dir:        h.dir,
			MCPServers: json.RawMessage(`{"mcpServers":{"teamhub":{"type":"http","url":"` + u1.URL + `","headers":{"Authorization":"Bearer a"}}}}`),
		})
		if err != nil {
			t.Fatal(err)
		}
		_, out1 := drainAgy(t, r1)

		c2 := &ReadinessCounters{}
		r2, err := h.runtime().Start(t.Context(), "t2", RunSpec{
			Dir:        h.dir,
			ResumeID:   out1.SessionID,
			MCPServers: json.RawMessage(`{"mcpServers":{"teamhub":{"type":"http","url":"` + u1.URL + `","headers":{"Authorization":"Bearer b"}}}}`),
			Readiness:  c2,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, out2 := drainAgy(t, r2); out2.Status != statusCompleted {
			t.Fatalf("turn2=%+v", out2)
		}
		if c2.spawns != 1 || c2.recycles["incompatible:mcp"] != 1 {
			t.Fatalf("counters=%+v, want spawn=1 incompatible:mcp=1", c2)
		}
		if pids := h.pids(); len(pids) != 2 || pids[0] == pids[1] {
			t.Fatalf("pids=%v, want 2 distinct PIDs", pids)
		}
	})

	t.Run("http_to_stdio", func(t *testing.T) {
		u1, _ := agyMCPServer(t)
		h := newAgyResidentHarness(t, "turn", nil)
		r1, err := h.runtime().Start(t.Context(), "t1", RunSpec{
			Dir:        h.dir,
			MCPServers: agyMCPConfig(map[string]string{"teamhub": u1.URL}),
		})
		if err != nil {
			t.Fatal(err)
		}
		_, out1 := drainAgy(t, r1)

		c2 := &ReadinessCounters{}
		r2, err := h.runtime().Start(t.Context(), "t2", RunSpec{
			Dir:        h.dir,
			ResumeID:   out1.SessionID,
			MCPServers: json.RawMessage(`{"mcpServers":{"local":{"command":"/bin/tool","args":["--stdio"]}}}`),
			Readiness:  c2,
		})
		if err != nil {
			t.Fatal(err)
		}
		_, out2 := drainAgy(t, r2)
		if out2.Status != statusCompleted || !out2.ExitConfirmed {
			t.Fatalf("turn2=%+v, want completed with ExitConfirmed=true", out2)
		}
		if c2.spawns != 1 || c2.recycles["incompatible:mcp"] != 1 {
			t.Fatalf("counters=%+v, want spawn=1 incompatible:mcp=1", c2)
		}
		if pids := h.pids(); len(pids) != 2 || pids[0] == pids[1] {
			t.Fatalf("pids=%v, want 2 distinct PIDs", pids)
		}
		if ContextHasParkedResident(h.profile.ContextKey) {
			t.Fatal("stdio turn must not park")
		}
	})
}

func TestAntigravityResidentBlankPrestartRecyclesPostTurnResident(t *testing.T) {
	h := newAgyResidentHarness(t, "turn", nil)
	r1, err := h.runtime().Start(t.Context(), "t1", RunSpec{Dir: h.dir})
	if err != nil {
		t.Fatal(err)
	}
	if _, out1 := drainAgy(t, r1); out1.Status != statusCompleted || out1.ExitConfirmed {
		t.Fatalf("turn1=%+v", out1)
	}

	c := &ReadinessCounters{}
	pre, err := h.runtime().Start(t.Context(), "", RunSpec{
		Dir: h.dir, PrepareOnly: true, ResumeID: "", Readiness: c,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, preOut := drainAgy(t, pre)
	if preOut.Status != statusCompleted || !preOut.Parked || !holdsPrestart() {
		t.Fatalf("prestart=%+v holdsPrestart=%v, want fresh parked prestart", preOut, holdsPrestart())
	}
	if c.spawns != 1 || c.recycles["incompatible:session"] != 1 {
		t.Fatalf("counters=%+v, want spawn=1 incompatible:session=1", c)
	}
	if pids := h.pids(); len(pids) != 2 || pids[0] == pids[1] {
		t.Fatalf("pids=%v, want 2 distinct PIDs", pids)
	}
}

func TestAntigravityResidentSafetyBoundariesNeverPark(t *testing.T) {
	t.Run("cancel", func(t *testing.T) {
		h := newAgyResidentHarness(t, "hang", nil)
		ctx, cancel := context.WithCancel(t.Context())
		run, err := h.runtime().Start(ctx, "hang", RunSpec{Dir: h.dir, ExposeTurnStarted: true})
		if err != nil {
			t.Fatal(err)
		}
		<-run.Events
		cancel()
		_, out := drainAgy(t, run)
		if out.Status != statusAborted || !out.ExitConfirmed {
			t.Fatalf("out=%+v", out)
		}
		if _, _, parked := residentEntryOf(antigravityResidents, h.profile.ContextKey); parked {
			t.Fatal("cancelled turn parked")
		}
	})

	t.Run("timeout", func(t *testing.T) {
		h := newAgyResidentHarness(t, "hang", nil)
		run, err := h.runtime().Start(t.Context(), "hang", RunSpec{Dir: h.dir, Budget: 300 * time.Millisecond})
		if err != nil {
			t.Fatal(err)
		}
		_, out := drainAgy(t, run)
		if out.Status != statusTimeout || !out.ExitConfirmed {
			t.Fatalf("out=%+v", out)
		}
		if _, _, parked := residentEntryOf(antigravityResidents, h.profile.ContextKey); parked {
			t.Fatal("timed out turn parked")
		}
	})

	t.Run("prompt_error", func(t *testing.T) {
		h := newAgyResidentHarness(t, "prompt-error", nil)
		run, err := h.runtime().Start(t.Context(), "fail", RunSpec{Dir: h.dir})
		if err != nil {
			t.Fatal(err)
		}
		_, out := drainAgy(t, run)
		if out.Status != statusFailed || !out.ExitConfirmed {
			t.Fatalf("out=%+v", out)
		}
		if _, _, parked := residentEntryOf(antigravityResidents, h.profile.ContextKey); parked {
			t.Fatal("failed prompt turn parked")
		}
	})

	t.Run("model_not_offered", func(t *testing.T) {
		h := newAgyResidentHarness(t, "turn", nil)
		run, err := h.runtime().Start(t.Context(), "hi", RunSpec{Dir: h.dir, Model: "unknown-model"})
		if err != nil {
			t.Fatal(err)
		}
		_, out := drainAgy(t, run)
		if out.Status != statusFailed || out.FailureCode != "model_not_offered" || !out.ExitConfirmed {
			t.Fatalf("out=%+v", out)
		}
		if _, _, parked := residentEntryOf(antigravityResidents, h.profile.ContextKey); parked {
			t.Fatal("model_not_offered turn parked")
		}
	})

	t.Run("session_not_found", func(t *testing.T) {
		h := newAgyResidentHarness(t, "unknown-session", nil)
		run, err := h.runtime().Start(t.Context(), "hi", RunSpec{Dir: h.dir, ResumeID: "missing-session"})
		if err != nil {
			t.Fatal(err)
		}
		_, out := drainAgy(t, run)
		if out.Status != statusFailed || out.FailureCode != "session_not_found" || !out.ResumeRefused || !out.ExitConfirmed {
			t.Fatalf("out=%+v", out)
		}
		if _, _, parked := residentEntryOf(antigravityResidents, h.profile.ContextKey); parked {
			t.Fatal("session_not_found turn parked")
		}
	})

	t.Run("background", func(t *testing.T) {
		shortenForTest(t, &antigravityQuietWindow, 200*time.Millisecond)
		h := newAgyResidentHarness(t, "background", nil)
		run, err := h.runtime().Start(t.Context(), "bg", RunSpec{Dir: h.dir})
		if err != nil {
			t.Fatal(err)
		}
		_, out := drainAgy(t, run)
		if out.Status != statusCompleted || !out.ExitConfirmed {
			t.Fatalf("out=%+v, want completed with ExitConfirmed=true", out)
		}
		if _, _, parked := residentEntryOf(antigravityResidents, h.profile.ContextKey); parked {
			t.Fatal("background continuation turn parked")
		}
	})
}

func TestAntigravityResidentUnconfirmedExitHoldsEntryAndBlocksNextSpawn(t *testing.T) {
	h := newAgyResidentHarness(t, "turn", nil)
	r1, err := h.runtime().Start(t.Context(), "t1", RunSpec{Dir: h.dir})
	if err != nil {
		t.Fatal(err)
	}
	if _, out := drainAgy(t, r1); out.Status != statusCompleted || out.ExitConfirmed {
		t.Fatalf("turn1=%+v", out)
	}
	proc, _, ok := residentEntryOf(antigravityResidents, h.profile.ContextKey)
	if !ok {
		t.Fatal("turn1 did not park")
	}

	neverGone := func(*exec.Cmd, time.Duration) bool { return false }
	antigravityTreeCheck.Store(&neverGone)
	t.Cleanup(func() { antigravityTreeCheck.Store(nil) })

	if _, err := StopParkedResidentsForContext(h.profile.ContextKey); !errors.Is(err, errResidentRecycleUnconfirmed) {
		t.Fatalf("stop err=%v, want errResidentRecycleUnconfirmed", err)
	}
	held, retiring, exists := residentEntryOf(antigravityResidents, h.profile.ContextKey)
	if !exists || !retiring || held != proc {
		t.Fatalf("expected unconfirmed entry held retiring: exists=%v retiring=%v", exists, retiring)
	}
	if _, err := h.runtime().Start(t.Context(), "t2", RunSpec{Dir: h.dir}); !errors.Is(err, errResidentRecycleUnconfirmed) {
		t.Fatalf("start after unconfirmed exit err=%v, want errResidentRecycleUnconfirmed", err)
	}

	// Once tree exit can be confirmed, the next Start cleans up and succeeds.
	antigravityTreeCheck.Store(nil)
	r2, err := h.runtime().Start(t.Context(), "t2", RunSpec{Dir: h.dir})
	if err != nil {
		t.Fatal(err)
	}
	if _, out2 := drainAgy(t, r2); out2.Status != statusCompleted {
		t.Fatalf("turn2=%+v", out2)
	}
}

func TestAntigravityResidentReleaseAndCredentialInvalidation(t *testing.T) {
	t.Run("context_agent_all_and_temp_release", func(t *testing.T) {
		tempDir := filepath.Join(t.TempDir(), "proc-temp")
		if err := os.MkdirAll(tempDir, 0o700); err != nil {
			t.Fatal(err)
		}
		hA := newAgyResidentHarness(t, "turn", nil)
		hA.profile.AgentID = "agent-a"
		hA.profile.RetainProcessTemp = func() (func() error, error) {
			return func() error { return os.RemoveAll(tempDir) }, nil
		}
		hB := newAgyResidentHarness(t, "turn", nil)
		hB.profile.AgentID = "agent-a"
		hC := newAgyResidentHarness(t, "turn", nil)
		hC.profile.AgentID = "agent-c"

		for _, h := range []*agyResidentHarness{hA, hB, hC} {
			r, err := h.runtime().Start(t.Context(), "go", RunSpec{Dir: h.dir})
			if err != nil {
				t.Fatal(err)
			}
			if _, out := drainAgy(t, r); out.Status != statusCompleted || out.ExitConfirmed {
				t.Fatalf("out=%+v", out)
			}
		}
		if _, err := os.Stat(tempDir); err != nil {
			t.Fatal("parked process lost its temp directory")
		}
		if count, err := StopParkedResidentsForContext(hA.profile.ContextKey); count != 1 || err != nil {
			t.Fatalf("context stop=%d err=%v", count, err)
		}
		if _, err := os.Stat(tempDir); !os.IsNotExist(err) {
			t.Fatalf("temp directory survived context stop: %v", err)
		}
		if ContextHasParkedResident(hA.profile.ContextKey) || !ContextHasParkedResident(hB.profile.ContextKey) || !ContextHasParkedResident(hC.profile.ContextKey) {
			t.Fatal("context stop hit wrong process")
		}
		if count, err := StopParkedResidentsForAgent("agent-a"); count != 1 || err != nil {
			t.Fatalf("agent stop=%d err=%v", count, err)
		}
		if ContextHasParkedResident(hB.profile.ContextKey) || !ContextHasParkedResident(hC.profile.ContextKey) {
			t.Fatal("agent stop hit wrong process")
		}
		if count, err := StopAllParkedResidents(); count != 1 || err != nil {
			t.Fatalf("stop all=%d err=%v", count, err)
		}
		if ContextHasParkedResident(hC.profile.ContextKey) {
			t.Fatal("stop all left a process")
		}
	})

	t.Run("release_fence_before_park", func(t *testing.T) {
		gate := filepath.Join(t.TempDir(), "gate")
		h := newAgyResidentHarness(t, "turn", map[string]string{agyFakeGateEnv: gate})
		run, err := h.runtime().Start(t.Context(), "gated", RunSpec{Dir: h.dir})
		if err != nil {
			t.Fatal(err)
		}
		awaitTrue(t, "gate started", 10*time.Second, func() bool {
			_, err := os.Stat(gate + ".started")
			return err == nil
		})
		if count, err := StopParkedResidentsForContext(h.profile.ContextKey); count != 0 || err != nil {
			t.Fatalf("release=%d err=%v", count, err)
		}
		if err := os.WriteFile(gate, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		_, out := drainAgy(t, run)
		if out.Status != statusCompleted || !out.ExitConfirmed {
			t.Fatalf("released turn=%+v, want ExitConfirmed=true", out)
		}
		if _, _, parked := residentEntryOf(antigravityResidents, h.profile.ContextKey); parked {
			t.Fatal("released turn parked")
		}
	})

	t.Run("auth_file_env_and_skills_mismatch", func(t *testing.T) {
		h := newAgyResidentHarness(t, "turn", map[string]string{"GEMINI_API_KEY": "key-1"})
		appData := filepath.Join(h.home, ".gemini", "antigravity-cli")
		if err := os.MkdirAll(appData, 0o700); err != nil {
			t.Fatal(err)
		}
		tokenFile := filepath.Join(appData, "antigravity-oauth-token")
		if err := os.WriteFile(tokenFile, []byte("token-1"), 0o600); err != nil {
			t.Fatal(err)
		}
		h.profile.ResidentSkillDigest = "skills-1"

		r1, err := h.runtime().Start(t.Context(), "t1", RunSpec{Dir: h.dir})
		if err != nil {
			t.Fatal(err)
		}
		_, out1 := drainAgy(t, r1)

		// Change oauth token file -> mismatch=auth.
		if err := os.WriteFile(tokenFile, []byte("token-2"), 0o600); err != nil {
			t.Fatal(err)
		}
		cAuth := &ReadinessCounters{}
		r2, err := h.runtime().Start(t.Context(), "t2", RunSpec{Dir: h.dir, ResumeID: out1.SessionID, Readiness: cAuth})
		if err != nil {
			t.Fatal(err)
		}
		drainAgy(t, r2)
		if cAuth.spawns != 1 || cAuth.recycles["incompatible:auth"] != 1 {
			t.Fatalf("auth change counters=%+v", cAuth)
		}

		// Change GEMINI_API_KEY -> mismatch=env.
		h.profile.Env["GEMINI_API_KEY"] = "key-2"
		cEnv := &ReadinessCounters{}
		r3, err := h.runtime().Start(t.Context(), "t3", RunSpec{Dir: h.dir, ResumeID: out1.SessionID, Readiness: cEnv})
		if err != nil {
			t.Fatal(err)
		}
		drainAgy(t, r3)
		if cEnv.spawns != 1 || cEnv.recycles["incompatible:env"] != 1 {
			t.Fatalf("env change counters=%+v", cEnv)
		}

		// Change ResidentSkillDigest -> mismatch=skills.
		h.profile.ResidentSkillDigest = "skills-2"
		cSkills := &ReadinessCounters{}
		r4, err := h.runtime().Start(t.Context(), "t4", RunSpec{Dir: h.dir, ResumeID: out1.SessionID, Readiness: cSkills})
		if err != nil {
			t.Fatal(err)
		}
		drainAgy(t, r4)
		if cSkills.spawns != 1 || cSkills.recycles["incompatible:skills"] != 1 {
			t.Fatalf("skills change counters=%+v", cSkills)
		}
	})

	t.Run("credentials_stop_and_in_flight_fence", func(t *testing.T) {
		parked := newAgyResidentHarness(t, "turn", nil)
		rParked, err := parked.runtime().Start(t.Context(), "park me", RunSpec{Dir: parked.dir})
		if err != nil {
			t.Fatal(err)
		}
		if _, out := drainAgy(t, rParked); out.Status != statusCompleted || out.ExitConfirmed {
			t.Fatalf("parked turn=%+v", out)
		}

		gate := filepath.Join(t.TempDir(), "cred-gate")
		inFlight := newAgyResidentHarness(t, "turn", map[string]string{agyFakeGateEnv: gate})
		rInFlight, err := inFlight.runtime().Start(t.Context(), "in flight", RunSpec{Dir: inFlight.dir})
		if err != nil {
			t.Fatal(err)
		}
		awaitTrue(t, "in-flight turn started", 10*time.Second, func() bool {
			_, err := os.Stat(gate + ".started")
			return err == nil
		})

		if err := StopParkedAntigravityResidentsForCredentials(); err != nil {
			t.Fatal(err)
		}
		if ContextHasParkedResident(parked.profile.ContextKey) {
			t.Fatal("parked Antigravity resident survived credential stop")
		}

		if err := os.WriteFile(gate, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		_, outInFlight := drainAgy(t, rInFlight)
		if outInFlight.Status != statusCompleted || !outInFlight.ExitConfirmed {
			t.Fatalf("in-flight turn=%+v, want ExitConfirmed=true", outInFlight)
		}
		if ContextHasParkedResident(inFlight.profile.ContextKey) {
			t.Fatal("in-flight Antigravity turn parked after credential invalidation")
		}
	})
}

func TestAntigravityResidentRuntimeHomePrestartRecycleAndTargetedStop(t *testing.T) {
	t.Run("prestart_passes_runtime_home_and_recycles_on_mismatch", func(t *testing.T) {
		metaFile := filepath.Join(t.TempDir(), "prestart-meta.json")
		homeA := filepath.Join(t.TempDir(), "home-a")
		homeB := filepath.Join(t.TempDir(), "home-b")
		for _, dir := range []string{homeA, homeB} {
			if err := os.MkdirAll(filepath.Join(dir, "gemini", "antigravity-cli"), 0o700); err != nil {
				t.Fatal(err)
			}
		}

		h := newAgyResidentHarness(t, "turn", map[string]string{agyFakeMetaEnv: metaFile})
		pre, err := h.runtime().Start(t.Context(), "", RunSpec{Dir: h.dir, PrepareOnly: true, RuntimeHome: homeA})
		if err != nil {
			t.Fatal(err)
		}
		if _, out := drainAgy(t, pre); out.Status != statusCompleted || !out.Parked {
			t.Fatalf("prestart=%+v", out)
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
		if meta.GeminiDir != filepath.Join(homeA, "gemini") || meta.LogFile != filepath.Join(homeA, "acp.log") {
			t.Fatalf("prestart meta=%+v, want homeA gemini/log", meta)
		}

		// Switching to a different RuntimeHome recycles the parked resident with mismatch "runtime_home".
		c := &ReadinessCounters{}
		run, err := h.runtime().Start(t.Context(), "go", RunSpec{Dir: h.dir, RuntimeHome: homeB, Readiness: c})
		if err != nil {
			t.Fatal(err)
		}
		if _, out := drainAgy(t, run); out.Status != statusCompleted {
			t.Fatalf("run=%+v", out)
		}
		if c.spawns != 1 || c.recycles["incompatible:runtime_home"] != 1 {
			t.Fatalf("counters=%+v, want spawn=1 incompatible:runtime_home=1", c)
		}
		if pids := h.pids(); len(pids) != 2 || pids[0] == pids[1] {
			t.Fatalf("pids=%v, want 2 distinct PIDs", pids)
		}
	})

	t.Run("stop_for_home_stops_only_matching_resident", func(t *testing.T) {
		homeA := filepath.Join(t.TempDir(), "home-a")
		homeB := filepath.Join(t.TempDir(), "home-b")
		for _, dir := range []string{homeA, homeB} {
			if err := os.MkdirAll(filepath.Join(dir, "gemini", "antigravity-cli"), 0o700); err != nil {
				t.Fatal(err)
			}
		}
		hA := newAgyResidentHarness(t, "turn", nil)
		hB := newAgyResidentHarness(t, "turn", nil)

		rA, err := hA.runtime().Start(t.Context(), "a", RunSpec{Dir: hA.dir, RuntimeHome: homeA})
		if err != nil {
			t.Fatal(err)
		}
		if _, out := drainAgy(t, rA); out.Status != statusCompleted || out.ExitConfirmed {
			t.Fatalf("turnA=%+v", out)
		}
		rB, err := hB.runtime().Start(t.Context(), "b", RunSpec{Dir: hB.dir, RuntimeHome: homeB})
		if err != nil {
			t.Fatal(err)
		}
		if _, out := drainAgy(t, rB); out.Status != statusCompleted || out.ExitConfirmed {
			t.Fatalf("turnB=%+v", out)
		}

		if err := StopParkedAntigravityResidentForHome(homeA); err != nil {
			t.Fatal(err)
		}
		if ContextHasParkedResident(hA.profile.ContextKey) {
			t.Fatal("homeA resident survived StopParkedAntigravityResidentForHome")
		}
		if !ContextHasParkedResident(hB.profile.ContextKey) {
			t.Fatal("homeB resident was stopped by StopParkedAntigravityResidentForHome(homeA)")
		}
	})
}
