//go:build windows

package provider

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

func TestWindowsAntigravityProbeUsesPrivateTempBase(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	sid, err := privatefs.CurrentSID()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	home := filepath.Join(root, "home")
	badTemp := filepath.Join(root, "bad-temp")
	blockedTemp := filepath.Join(root, "blocked-temp")
	privateBase := filepath.Join(root, "state", "operation-tmp")
	metaFile := filepath.Join(root, "meta.json")
	for _, dir := range []string{home, badTemp} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(blockedTemp, []byte("not-a-directory"), 0o600); err != nil {
		t.Fatal(err)
	}

	// Grant LOCAL SERVICE (S-1-5-19) full access so badTemp is broadly
	// accessible and fails target-level owner-only checks.
	const localServiceSID = "S-1-5-19"
	sd, err := windows.SecurityDescriptorFromString("O:" + sid.String() + "D:P(A;OICI;FA;;;" + sid.String() + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;" + localServiceSID + ")")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(badTemp, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
	if err := privatefs.CheckPath(badTemp, "directory", true); err == nil || !strings.Contains(err.Error(), localServiceSID) {
		t.Fatalf("expected target-level private check to reject %s on badTemp, got %v", localServiceSID, err)
	}

	env := map[string]string{
		"HOME":                   home,
		"USERPROFILE":            home,
		testAgyProtocolHelperEnv: metaFile,
	}
	if systemRoot := os.Getenv("SystemRoot"); systemRoot != "" {
		env["SystemRoot"] = systemRoot
	}

	// Empty TempBase falls back to %TEMP%; a local preparation failure must
	// report RUNTIME_DIAGNOSTIC_FAILED rather than RUNTIME_INCOMPATIBLE.
	t.Setenv("TEMP", blockedTemp)
	t.Setenv("TMP", blockedTemp)
	logged := captureProbeLog(t)
	fallbackOutcome := probeRuntime(context.Background(), "antigravity", executable, env, 5*time.Second, probeOptions{})
	if fallbackOutcome.Status != "error" || fallbackOutcome.Code != "RUNTIME_DIAGNOSTIC_FAILED" {
		t.Fatalf("fallback outcome = %+v, want error RUNTIME_DIAGNOSTIC_FAILED (not RUNTIME_INCOMPATIBLE)", fallbackOutcome)
	}
	if strings.Contains(fallbackOutcome.Message, blockedTemp) {
		t.Fatalf("fallback outcome.Message leaked local path: %q", fallbackOutcome.Message)
	}
	if !strings.Contains(logged.String(), "runner.runtime_probe.prepare_failed") {
		t.Fatalf("expected runner.runtime_probe.prepare_failed in log, got: %s", logged.String())
	}

	// With a clean private TempBase, the probe succeeds and never touches a
	// broadly accessible %TEMP%.
	t.Setenv("TEMP", badTemp)
	t.Setenv("TMP", badTemp)
	privateOutcome := probeRuntime(context.Background(), "antigravity", executable, env, 5*time.Second, probeOptions{tempBase: privateBase})
	if privateOutcome.Status != "ready" {
		t.Fatalf("private TempBase outcome = %+v, want ready", privateOutcome)
	}
	rawMeta, err := os.ReadFile(metaFile)
	if err != nil {
		t.Fatal(err)
	}
	var meta struct {
		GeminiDir      string `json:"geminiDir"`
		LogFile        string `json:"logFile"`
		PrivateCheckOK bool   `json:"privateCheckOK"`
	}
	if err := json.Unmarshal(rawMeta, &meta); err != nil {
		t.Fatal(err)
	}
	if !isPathWithin(privateBase, meta.GeminiDir) || !isPathWithin(privateBase, meta.LogFile) || !meta.PrivateCheckOK {
		t.Fatalf("probe paths = %+v, want private paths under %q", meta, privateBase)
	}
	if entries, err := os.ReadDir(privateBase); err != nil || len(entries) != 0 {
		t.Fatalf("privateBase was not cleaned up: entries=%v err=%v", entries, err)
	}
	if entries, err := os.ReadDir(badTemp); err != nil || len(entries) != 0 {
		t.Fatalf("badTemp was touched during private TempBase probe: entries=%v err=%v", entries, err)
	}
}
