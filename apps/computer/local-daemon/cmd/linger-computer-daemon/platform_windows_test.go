//go:build windows

package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/winupdate"
)

func TestPlatformEntryUsesStdinAndReturnsJSONWithoutStartingDaemon(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private config", "configuraci\u00f3n.json")
	call := func(request any) map[string]any {
		t.Helper()
		input, _ := json.Marshal(request)
		var output bytes.Buffer
		if err := runPlatform(bytes.NewReader(input), &output); err != nil {
			t.Fatal(err)
		}
		var result map[string]any
		if err := json.Unmarshal(output.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	call(map[string]any{"action": "write-private-file", "path": path, "data": "secret\nCaf\u00e9", "exclusive": true})
	result := call(map[string]any{"action": "read-private-file", "path": path})
	if result["data"] != "secret\nCaf\u00e9" {
		t.Fatalf("read=%v", result)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(path), "daemon.lock")); !os.IsNotExist(err) {
		t.Fatalf("helper started daemon: %v", err)
	}
	other := filepath.Join(filepath.Dir(path), "other.json")
	call(map[string]any{"action": "write-private-file", "path": other, "data": "x"})
	call(map[string]any{"action": "check-private-paths", "paths": []string{path, other}, "kind": "file"})
	missing, _ := json.Marshal(map[string]any{"action": "check-private-paths", "paths": []string{path, filepath.Join(filepath.Dir(path), "missing")}, "kind": "file"})
	if err := runPlatform(bytes.NewReader(missing), &bytes.Buffer{}); err == nil {
		t.Fatal("batch check accepted a missing path")
	}
	var output bytes.Buffer
	if err := runPlatform(strings.NewReader(`{"action":"unknown","secret":"do-not-print"}`), &output); err == nil || strings.Contains(err.Error(), "do-not-print") {
		t.Fatalf("unsafe error=%v", err)
	}
	if err := runPlatform(strings.NewReader(`{"action":"read-private-file"} {}`), &output); err == nil {
		t.Fatal("multiple requests accepted")
	}
}

func TestWindowsPlatformCleanupMissingStateAndRejectsCorruptOwner(t *testing.T) {
	state := filepath.Join(t.TempDir(), "not-configured", "state")
	for _, action := range []string{"cleanup-owned-processes", "owned-processes-stopped", "stop-managed-services"} {
		input, _ := json.Marshal(map[string]any{"action": action, "stateDirectory": state})
		var output bytes.Buffer
		if err := runPlatform(bytes.NewReader(input), &output); err != nil {
			t.Fatalf("%s: %v", action, err)
		}
		var result map[string]any
		if err := json.Unmarshal(output.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if action == "cleanup-owned-processes" && result["found"] != false {
			t.Fatalf("cleanup=%v", result)
		}
		if (action == "owned-processes-stopped" || action == "stop-managed-services") && result["stopped"] != true {
			t.Fatalf("%s=%v", action, result)
		}
	}
	if _, err := os.Stat(state); !os.IsNotExist(err) {
		t.Fatalf("cleanup created missing state: %v", err)
	}
	if err := privatefs.WriteFile(filepath.Join(state, "daemon.lock", "owner.json"), []byte("{}"), true); err != nil {
		t.Fatal(err)
	}
	input, _ := json.Marshal(map[string]any{"action": "cleanup-owned-processes", "stateDirectory": state})
	var output bytes.Buffer
	if err := runPlatform(bytes.NewReader(input), &output); err == nil {
		t.Fatal("corrupt owner record ignored")
	}
}

func TestRunPlatformProcessSnapshotAndValidatePrivatePath(t *testing.T) {
	var snapshotOut bytes.Buffer
	if err := runPlatform(strings.NewReader(`{"action":"process-snapshot","includeListeners":true}`), &snapshotOut); err != nil {
		t.Fatalf("runPlatform process-snapshot failed: %v", err)
	}
	var snap struct {
		Processes []struct {
			PID int `json:"pid"`
		} `json:"processes"`
	}
	if err := json.Unmarshal(snapshotOut.Bytes(), &snap); err != nil {
		t.Fatalf("decode process-snapshot output: %v", err)
	}
	if len(snap.Processes) == 0 {
		t.Fatal("expected processes in snapshot")
	}

	dir := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	payload, _ := json.Marshal(map[string]any{
		"action": "validate-private-path",
		"path":   dir,
		"kind":   "directory",
		"repair": true,
	})
	var repairOut bytes.Buffer
	if err := runPlatform(bytes.NewReader(payload), &repairOut); err != nil {
		t.Fatalf("runPlatform validate-private-path failed: %v", err)
	}
	var repairResp struct {
		OK bool `json:"ok"`
	}
	if err := json.Unmarshal(repairOut.Bytes(), &repairResp); err != nil || !repairResp.OK {
		t.Fatalf("expected ok=true, got %q (err=%v)", repairOut.String(), err)
	}
}

func TestRunPlatformWorkerHandlesMultipleRequestsAndEOF(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "worker-state")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	req1, _ := json.Marshal(map[string]any{
		"action": "validate-private-path",
		"path":   dir,
		"kind":   "directory",
		"repair": false,
	})
	req2, _ := json.Marshal(map[string]any{
		"action": "validate-private-path",
		"path":   dir,
		"kind":   "directory",
		"repair": true,
	})
	req3 := []byte(`{"action":"process-snapshot","includeListeners":false}`)
	req4 := []byte(`{"action":"unknown-action"}`)
	req5 := []byte(`not-json`)

	input := strings.Join([]string{
		string(req1),
		"",
		string(req2),
		string(req3),
		string(req4),
		string(req5),
	}, "\n") + "\n"

	var output bytes.Buffer
	if err := runPlatformWorker(strings.NewReader(input), &output); err != nil {
		t.Fatalf("runPlatformWorker returned error: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 5 {
		t.Fatalf("expected 5 worker responses, got %d:\n%s", len(lines), output.String())
	}

	// 1. Pre-repair directory fails with structured INHERITED_ACCESS inside ok=true result.
	var r1 struct {
		OK     bool `json:"ok"`
		Result struct {
			OK      bool `json:"ok"`
			Failure struct {
				Code string `json:"code"`
			} `json:"failure"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(lines[0]), &r1); err != nil || !r1.OK || r1.Result.OK || r1.Result.Failure.Code != "INHERITED_ACCESS" {
		t.Fatalf("unexpected response 1: %s", lines[0])
	}

	// 2. Repair succeeds.
	var r2 struct {
		OK     bool `json:"ok"`
		Result struct {
			OK bool `json:"ok"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(lines[1]), &r2); err != nil || !r2.OK || !r2.Result.OK {
		t.Fatalf("unexpected response 2: %s", lines[1])
	}

	// 3. Process snapshot succeeds.
	var r3 struct {
		OK     bool `json:"ok"`
		Result struct {
			Processes []struct {
				PID int `json:"pid"`
			} `json:"processes"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(lines[2]), &r3); err != nil || !r3.OK || len(r3.Result.Processes) == 0 {
		t.Fatalf("unexpected response 3: %s", lines[2])
	}

	// 4. Unknown action returns worker-level ok=false without crashing loop.
	var r4 struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal([]byte(lines[3]), &r4); err != nil || r4.OK || r4.Error != "unknown platform action" {
		t.Fatalf("unexpected response 4: %s", lines[3])
	}

	// 5. Malformed JSON returns worker-level ok=false without crashing loop.
	var r5 struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal([]byte(lines[4]), &r5); err != nil || r5.OK || r5.Error == "" {
		t.Fatalf("unexpected response 5: %s", lines[4])
	}
}

func TestPlatformEntryApplyWindowsUpdate(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "Programs")
	installDir := filepath.Join(parent, "Linger")
	stagedDir := filepath.Join(parent, ".Linger-update-0.17.0", "Linger")
	if err := os.MkdirAll(filepath.Join(installDir, "resources"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(stagedDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(installDir, "Linger.exe"), []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(installDir, winupdate.UninstallerFileName), []byte("uninst"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(installDir, winupdate.StopMarkerRelPath), []byte("marker"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stagedDir, "Linger.exe"), []byte("new"), 0o755); err != nil {
		t.Fatal(err)
	}

	relaunch := false
	cfgPath := filepath.Join(t.TempDir(), "apply.json")
	payload, err := json.Marshal(winupdate.Request{
		InstallDir:   installDir,
		StagedDir:    stagedDir,
		Version:      "0.17.0",
		SkipRegistry: true,
		Relaunch:     &relaunch,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfgPath, payload, 0o600); err != nil {
		t.Fatal(err)
	}

	handled, err := platformEntry([]string{"apply-windows-update", cfgPath})
	if !handled || err != nil {
		t.Fatalf("platformEntry(apply-windows-update) = (%v, %v), want (true, nil)", handled, err)
	}
	gotExe, err := os.ReadFile(filepath.Join(installDir, "Linger.exe"))
	if err != nil || string(gotExe) != "new" {
		t.Fatalf("Linger.exe = %q (err=%v), want new", string(gotExe), err)
	}
	if _, err := os.Stat(filepath.Join(installDir, winupdate.UninstallerFileName)); err != nil {
		t.Fatalf("uninstaller missing after swap: %v", err)
	}
	if _, err := os.Stat(filepath.Join(installDir, winupdate.StopMarkerRelPath)); err != nil {
		t.Fatalf("stop marker missing after swap: %v", err)
	}
	if _, err := os.Lstat(cfgPath); !os.IsNotExist(err) {
		t.Fatalf("config file %s was not removed: %v", cfgPath, err)
	}
}
