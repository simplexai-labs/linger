//go:build windows

package daemon

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"golang.org/x/sys/windows"
)

func TestWindowsRunAgentCLIAvoidsSystemTempWithNonWhitelistedSID(t *testing.T) {
	badTemp := filepath.Join(t.TempDir(), "bad-system-temp")
	if err := os.MkdirAll(badTemp, 0o700); err != nil {
		t.Fatal(err)
	}
	sid, err := privatefs.CurrentSID()
	if err != nil {
		t.Fatal(err)
	}
	// Grant LOCAL SERVICE (S-1-5-19, non-whitelisted ancestor SID) full access
	// so privatefs ancestor validation rejects any path under badTemp.
	sd, err := windows.SecurityDescriptorFromString("O:" + sid.String() + "D:P(A;OICI;FA;;;" + sid.String() + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5-19)")
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
	if err := privatefs.EnsureDir(filepath.Join(badTemp, "probe")); err == nil || !strings.Contains(err.Error(), "S-1-5-19") {
		t.Fatalf("expected non-whitelisted TEMP ancestor error for S-1-5-19, got %v", err)
	}

	privateState := filepath.Join(t.TempDir(), "daemon-state")
	if err := privatefs.EnsureDir(privateState); err != nil {
		t.Fatal(err)
	}
	opTempBase := filepath.Join(privateState, "operation-tmp")

	t.Setenv("TEMP", badTemp)
	t.Setenv("TMP", badTemp)

	d := &Daemon{stateDirectory: privateState}
	home, configPath, cleanup, err := prepareAgentCLIConfig(d.operationTempBase(), cardInstallation, "room-1")
	if err != nil {
		t.Fatalf("prepareAgentCLIConfig failed with non-whitelisted TEMP: %v", err)
	}
	defer cleanup()
	if !strings.HasPrefix(home, opTempBase+string(os.PathSeparator)) {
		t.Fatalf("home %q is not under operation-tmp %q", home, opTempBase)
	}
	if err := privatefs.CheckPath(home, "directory", true); err != nil {
		t.Fatalf("home ACL: %v", err)
	}
	if err := privatefs.CheckPath(configPath, "file", true); err != nil {
		t.Fatalf("config.json ACL: %v", err)
	}
	cleanup()
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Fatalf("home survived cleanup: %v", err)
	}

	// Verify runAgentCLI itself does not fail on ancestor validation when TEMP
	// grants access to a non-whitelisted SID.
	cliDir := t.TempDir()
	exeBytes, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cliDir, "teamhub.exe"), exeBytes, 0o700); err != nil {
		t.Fatal(err)
	}
	d.teamhubCLIBin = cliDir
	_, err = d.runAgentCLI(t.Context(), cardInstallation, "room-1", []string{"-invalid-flag-for-test"}, "")
	var failure *playgroundFailure
	if !errors.As(err, &failure) {
		t.Fatalf("runAgentCLI returned non-CLI error (expected CLI exit failure, not privatefs ancestor error): %v", err)
	}
	if entries, readErr := os.ReadDir(opTempBase); readErr != nil || len(entries) != 0 {
		t.Fatalf("operation-tmp entries after runAgentCLI = %v, err = %v", entries, readErr)
	}
}
