//go:build windows

package workspace

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"golang.org/x/sys/windows"
)

func TestClaudeCredentialsRepairLegacyInheritedWindowsACLOnUnchangedFastPath(t *testing.T) {
	_, environment := claudeSource(t)
	token := `{"claudeAiOauth":{"accessToken":"keychain","expiresAt":4102444800000}}`
	stubClaudeKeychain(t, token)

	configRoot := filepath.Join(t.TempDir(), ".claude")
	if err := configureClaudeCredentials(configRoot, environment, nil); err != nil {
		t.Fatal(err)
	}
	credPath := filepath.Join(configRoot, ".credentials.json")
	markerPath := filepath.Join(configRoot, ".linger-auth-source.sha256")

	// Simulate existing files and directory carrying an inherited broad ACE
	// (such as Authenticated Users or CodexSandboxUsers).
	sid, err := privatefs.CurrentSID()
	if err != nil {
		t.Fatal(err)
	}
	broad, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;" + sid.String() + ")(A;OICI;FA;;;SY)(A;OICI;FR;;;AU)")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := broad.DACL()
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{configRoot, credPath, markerPath} {
		if err := windows.SetNamedSecurityInfo(target, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
			t.Fatal(err)
		}
	}
	if err := privatefs.CheckPath(credPath, "file", true); err == nil {
		t.Fatal("expected legacy credential with broad ACL to fail CheckPath before repair")
	}

	retired := 0
	if err := configureClaudeCredentials(configRoot, map[string]string{"HOME": environment["HOME"]}, func() error {
		retired++
		return nil
	}); err != nil {
		t.Fatalf("reconcile unchanged credential: %v", err)
	}
	if retired != 0 {
		t.Fatalf("ACL-only repair retired resident %d times", retired)
	}
	if err := privatefs.CheckPath(configRoot, "directory", true); err != nil {
		t.Fatalf("configRoot ACL was not repaired: %v", err)
	}
	if err := privatefs.CheckPath(credPath, "file", true); err != nil {
		t.Fatalf("credential ACL was not repaired: %v", err)
	}
	if err := privatefs.CheckPath(markerPath, "file", true); err != nil {
		t.Fatalf("marker ACL was not repaired: %v", err)
	}
	got, err := os.ReadFile(credPath)
	if err != nil || string(got) != token {
		t.Fatalf("repaired credential content = %q, err = %v", got, err)
	}
}
