//go:build windows

package native

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"golang.org/x/sys/windows"
)

func createNonWhitelistedWindowsTemp(t *testing.T) string {
	t.Helper()
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
	return badTemp
}

func TestWindowsPrivateTempDirsAvoidSystemTempWithNonWhitelistedSID(t *testing.T) {
	badTemp := createNonWhitelistedWindowsTemp(t)
	privateState := filepath.Join(t.TempDir(), "daemon-state")
	if err := privatefs.EnsureDir(privateState); err != nil {
		t.Fatal(err)
	}
	opTempBase := filepath.Join(privateState, "operation-tmp")

	t.Setenv("TEMP", badTemp)
	t.Setenv("TMP", badTemp)

	t.Run("newAntigravityHookEndpoint", func(t *testing.T) {
		ep, err := newAntigravityHookEndpoint(`C:\linger\linger-computer-daemon.exe`, opTempBase)
		if err != nil {
			t.Fatalf("newAntigravityHookEndpoint failed with non-whitelisted TEMP: %v", err)
		}
		defer ep.Close()
		hookDir := ep.Dir()
		opTempDir := filepath.Dir(hookDir)
		expectedBase := opTempBase
		if resolved, err := filepath.EvalSymlinks(opTempBase); err == nil && resolved != "" {
			expectedBase = resolved
		}
		if !strings.HasPrefix(opTempDir, expectedBase+string(os.PathSeparator)) {
			t.Fatalf("hook dir %q is not under operation-tmp %q", hookDir, expectedBase)
		}
		if err := privatefs.CheckPath(hookDir, "directory", true); err != nil {
			t.Fatalf("hookDir ACL: %v", err)
		}
		if err := privatefs.CheckPath(filepath.Join(hookDir, ".agents", "hooks.json"), "file", true); err != nil {
			t.Fatalf("hooks.json ACL: %v", err)
		}
		if err := ep.Close(); err != nil {
			t.Fatalf("Close: %v", err)
		}
		if _, err := os.Stat(opTempDir); !os.IsNotExist(err) {
			t.Fatalf("hook temp dir survived Close: %v", err)
		}
	})

	t.Run("claudeWriteMCPConfig", func(t *testing.T) {
		path, cleanup, err := claudeWriteMCPConfig(opTempBase, []byte(`{"mcpServers":{}}`))
		if err != nil {
			t.Fatalf("claudeWriteMCPConfig failed with non-whitelisted TEMP: %v", err)
		}
		defer cleanup()
		mcpDir := filepath.Dir(path)
		opTempDir := filepath.Dir(mcpDir)
		if !strings.HasPrefix(opTempDir, opTempBase+string(os.PathSeparator)) {
			t.Fatalf("mcp config %q is not under operation-tmp %q", path, opTempBase)
		}
		if err := privatefs.CheckPath(mcpDir, "directory", true); err != nil {
			t.Fatalf("mcpDir ACL: %v", err)
		}
		if err := privatefs.CheckPath(path, "file", true); err != nil {
			t.Fatalf("mcp-config.json ACL: %v", err)
		}
		cleanup()
		if _, err := os.Stat(opTempDir); !os.IsNotExist(err) {
			t.Fatalf("mcp temp dir survived cleanup: %v", err)
		}
	})
}
