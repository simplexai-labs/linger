//go:build windows

package winprocess

import (
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestSnapshotHelperProcess(t *testing.T) {
	if os.Getenv("LINGER_SNAPSHOT_HELPER") != "1" {
		return
	}
	time.Sleep(10 * time.Second)
}

func TestSnapshotCapturesCurrentAndChildProcess(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("resolve test executable: %v", err)
	}
	token := `linger-snapshot-probe "quoted arg" caf` + "\u00e9"
	cmd := exec.Command(exe, "-test.run=^TestSnapshotHelperProcess$", "--", token)
	cmd.Env = append(os.Environ(), "LINGER_SNAPSHOT_HELPER=1")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start helper process: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	})

	snap, err := Snapshot(false)
	if err != nil {
		t.Fatalf("Snapshot(false) failed: %v", err)
	}
	if len(snap.Processes) == 0 {
		t.Fatal("expected non-empty process list")
	}
	if len(snap.Listeners) != 0 {
		t.Fatalf("expected no listeners when includeListeners=false, got %d", len(snap.Listeners))
	}

	selfPID := os.Getpid()
	selfIdentity, err := Inspect(selfPID)
	if err != nil || selfIdentity == nil {
		t.Fatalf("Inspect(self) failed: identity=%v err=%v", selfIdentity, err)
	}
	expectedSelfCreated := strings.TrimPrefix(selfIdentity.StartTime, "windows:")

	var foundSelf, foundChild *ProcessEntry
	for i := range snap.Processes {
		entry := &snap.Processes[i]
		if entry.PID == selfPID {
			foundSelf = entry
		}
		if entry.PID == cmd.Process.Pid {
			foundChild = entry
		}
	}
	if foundSelf == nil {
		t.Fatalf("current process %d missing from snapshot", selfPID)
	}
	if foundSelf.Created != expectedSelfCreated {
		t.Fatalf("self Created=%q, want %q", foundSelf.Created, expectedSelfCreated)
	}
	if foundSelf.Name == "" || foundSelf.Command == "" {
		t.Fatalf("expected non-empty self Name/Command, got %+v", *foundSelf)
	}

	if foundChild == nil {
		t.Fatalf("child process %d missing from snapshot", cmd.Process.Pid)
	}
	if foundChild.PPID != selfPID {
		t.Fatalf("child PPID=%d, want %d", foundChild.PPID, selfPID)
	}
	if !strings.Contains(foundChild.Command, "linger-snapshot-probe") ||
		!strings.Contains(foundChild.Command, "quoted arg") ||
		!strings.Contains(foundChild.Command, "caf\u00e9") {
		t.Fatalf("child command line missing expected token: %q", foundChild.Command)
	}
	childCreated, err := strconv.ParseUint(foundChild.Created, 10, 64)
	if err != nil || childCreated == 0 {
		t.Fatalf("expected positive child Created FILETIME, got %q", foundChild.Created)
	}
	selfCreated, _ := strconv.ParseUint(foundSelf.Created, 10, 64)
	if childCreated < selfCreated {
		t.Fatalf("expected child Created (%d) >= self Created (%d)", childCreated, selfCreated)
	}
}

func TestSnapshotIncludesIPv4Listeners(t *testing.T) {
	loopback, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen loopback: %v", err)
	}
	defer loopback.Close()

	wildcard, err := net.Listen("tcp4", "0.0.0.0:0")
	if err != nil {
		t.Fatalf("listen wildcard: %v", err)
	}
	defer wildcard.Close()

	loopbackPort := loopback.Addr().(*net.TCPAddr).Port
	wildcardPort := wildcard.Addr().(*net.TCPAddr).Port

	snap, err := Snapshot(true)
	if err != nil {
		t.Fatalf("Snapshot(true) failed: %v", err)
	}

	selfPID := os.Getpid()
	var foundLoopback, foundWildcard *ListenerEntry
	for i := range snap.Listeners {
		entry := &snap.Listeners[i]
		if entry.Port == loopbackPort {
			foundLoopback = entry
		}
		if entry.Port == wildcardPort {
			foundWildcard = entry
		}
	}

	if foundLoopback == nil {
		t.Fatalf("loopback listener on port %d missing", loopbackPort)
	}
	if foundLoopback.PID != selfPID || foundLoopback.Address != "127.0.0.1" {
		t.Fatalf("unexpected loopback listener: %+v (want pid=%d, addr=127.0.0.1)", *foundLoopback, selfPID)
	}

	if foundWildcard == nil {
		t.Fatalf("wildcard listener on port %d missing", wildcardPort)
	}
	if foundWildcard.PID != selfPID || foundWildcard.Address != "0.0.0.0" {
		t.Fatalf("unexpected wildcard listener: %+v (want pid=%d, addr=0.0.0.0)", *foundWildcard, selfPID)
	}
}

func TestIPv4ListenerAddressDecoding(t *testing.T) {
	if got := ipv4ListenerAddress(0); got != "0.0.0.0" {
		t.Fatalf("0 -> %q, want 0.0.0.0", got)
	}
	if got := ipv4ListenerAddress(0x0100007F); got != "127.0.0.1" {
		t.Fatalf("0x0100007F -> %q, want 127.0.0.1", got)
	}
	if got := ipv4ListenerAddress(0x0100A8C0); got != "" {
		t.Fatalf("192.168.0.1 -> %q, want empty", got)
	}
}
