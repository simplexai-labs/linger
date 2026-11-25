//go:build unix

package native

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestAntigravityResidentExternalCrashSIGKILLRecoversCleanly(t *testing.T) {
	u1, calls1 := agyMCPServer(t)
	u2, calls2 := agyMCPServer(t)
	temp1 := filepath.Join(t.TempDir(), "temp-1")
	temp2 := filepath.Join(t.TempDir(), "temp-2")
	for _, dir := range []string{temp1, temp2} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}

	h := newAgyResidentHarness(t, "turn", map[string]string{agyFakeMCPCallEnv: "1"})
	h.profile.RetainProcessTemp = func() (func() error, error) {
		return func() error { return os.RemoveAll(temp1) }, nil
	}
	r1, err := h.runtime().Start(t.Context(), "t1", RunSpec{
		Dir:        h.dir,
		MCPServers: agyMCPConfig(map[string]string{"teamhub": u1.URL}),
	})
	if err != nil {
		t.Fatal(err)
	}
	_, out1 := drainAgy(t, r1)
	if out1.Status != statusCompleted || out1.ExitConfirmed {
		t.Fatalf("turn1=%+v", out1)
	}
	proc1, _, ok := residentEntryOf(antigravityResidents, h.profile.ContextKey)
	if !ok || proc1.front == nil {
		t.Fatalf("turn1 did not park with mcpFront")
	}
	front1URL := proc1.front.URL("teamhub")

	// Externally kill the parked resident process.
	if err := syscall.Kill(proc1.pid, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	awaitTrue(t, "killed resident noticed dead", 5*time.Second, func() bool {
		return !proc1.alive()
	})

	// Next Start must retire the dead resident, release its temp dir and front,
	// and spawn a fresh process cleanly.
	h.profile.RetainProcessTemp = func() (func() error, error) {
		return func() error { return os.RemoveAll(temp2) }, nil
	}
	c2 := &ReadinessCounters{}
	r2, err := h.runtime().Start(t.Context(), "t2", RunSpec{
		Dir:        h.dir,
		ResumeID:   out1.SessionID,
		MCPServers: agyMCPConfig(map[string]string{"teamhub": u2.URL}),
		Readiness:  c2,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, out2 := drainAgy(t, r2)
	if out2.Status != statusCompleted || out2.ExitConfirmed {
		t.Fatalf("turn2=%+v", out2)
	}
	if c2.spawns != 1 || c2.recycles["expired"] != 1 {
		t.Fatalf("counters=%+v, want spawn=1 expired=1", c2)
	}
	if _, err := os.Stat(temp1); !os.IsNotExist(err) {
		t.Fatalf("crashed resident temp1 was not released: %v", err)
	}
	if resp, err := http.Post(front1URL, "application/json", strings.NewReader(`{}`)); err == nil {
		_ = resp.Body.Close()
		t.Fatalf("crashed resident mcpFront stayed open with status %d", resp.StatusCode)
	}
	if len(calls1()) != 1 || len(calls2()) != 1 {
		t.Fatalf("calls1=%d calls2=%d", len(calls1()), len(calls2()))
	}

	// Kill the second parked resident and verify PrepareOnly respawns cleanly.
	proc2, _, ok := residentEntryOf(antigravityResidents, h.profile.ContextKey)
	if !ok {
		t.Fatal("turn2 did not park")
	}
	if err := syscall.Kill(proc2.pid, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	awaitTrue(t, "second killed resident noticed dead", 5*time.Second, func() bool {
		return !proc2.alive()
	})

	h.profile.RetainProcessTemp = nil
	preRun, err := h.runtime().Start(t.Context(), "", RunSpec{
		Dir: h.dir, PrepareOnly: true, ResumeID: out1.SessionID,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, preOut := drainAgy(t, preRun)
	if preOut.Status != statusCompleted || !preOut.Parked || !holdsPrestart() {
		t.Fatalf("prepare after crash=%+v holdsPrestart=%v", preOut, holdsPrestart())
	}
	if _, err := os.Stat(temp2); !os.IsNotExist(err) {
		t.Fatalf("second crashed resident temp2 was not released: %v", err)
	}
	if pids := h.pids(); len(pids) != 3 {
		t.Fatalf("pids=%v, want 3 spawns", pids)
	}
}
