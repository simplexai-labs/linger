//go:build windows

package clicredential

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"golang.org/x/sys/windows"
)

func grantUsersReadACL(t *testing.T, paths ...string) {
	t.Helper()
	sid, err := privatefs.CurrentSID()
	if err != nil {
		t.Fatal(err)
	}
	// Grant BUILTIN\Users (S-1-5-32-545) read access alongside the owner and SYSTEM.
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;" + sid.String() + ")(A;OICI;FA;;;SY)(A;OICI;FR;;;S-1-5-32-545)")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range paths {
		if err := windows.SetNamedSecurityInfo(target, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
			t.Fatalf("set broad ACL on %s: %v", target, err)
		}
	}
}

func TestWindowsLookupCurrentAndPutRepairLegacyUsersReadACL(t *testing.T) {
	profile := testProfile("tenant-one", "agent-one")
	for _, op := range []struct {
		name string
		run  func(t *testing.T, store *Store)
	}{
		{
			name: "Lookup",
			run: func(t *testing.T, store *Store) {
				t.Helper()
				installation, err := store.Lookup("tenant-one", "agent-one")
				if err != nil || installation.Profile != profile {
					t.Fatalf("Lookup = %+v, %v", installation, err)
				}
			},
		},
		{
			name: "Current",
			run: func(t *testing.T, store *Store) {
				t.Helper()
				stored, ok, err := store.Current("tenant-one", "agent-one")
				if err != nil || !ok || stored.Profile != profile || stored.AssignmentRevision != 1 {
					t.Fatalf("Current = %+v, ok %v, err %v", stored, ok, err)
				}
			},
		},
		{
			name: "Put with unchanged profile",
			run: func(t *testing.T, store *Store) {
				t.Helper()
				if _, err := store.Put("tenant-one", "agent-one", profile, rotatedToken, 2); err != nil {
					t.Fatalf("Put: %v", err)
				}
			},
		},
	} {
		t.Run(op.name, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "agent-cli-credentials")
			store := mustOpen(t, root)
			if _, err := store.Put("tenant-one", "agent-one", profile, testToken, 1); err != nil {
				t.Fatalf("initial Put: %v", err)
			}
			agentDirectory := store.agentDirectory("tenant-one", "agent-one")
			files := []string{
				filepath.Join(agentDirectory, credentialFile),
				filepath.Join(agentDirectory, stateFile),
				filepath.Join(agentDirectory, profileFile),
			}
			grantUsersReadACL(t, append([]string{agentDirectory}, files...)...)

			if err := privatefs.CheckPath(agentDirectory, "directory", true); err == nil {
				t.Fatal("expected broad agentDirectory ACL to fail CheckPath before repair")
			}
			for _, path := range files {
				if err := privatefs.CheckPath(path, "file", true); err == nil {
					t.Fatalf("expected broad %s ACL to fail CheckPath before repair", path)
				}
			}

			op.run(t, store)

			if err := privatefs.CheckPath(agentDirectory, "directory", true); err != nil {
				t.Fatalf("agentDirectory ACL not repaired: %v", err)
			}
			for _, path := range files {
				if err := privatefs.CheckPath(path, "file", true); err != nil {
					t.Fatalf("%s ACL not repaired: %v", path, err)
				}
			}
		})
	}
}

func TestWindowsRefusesHardLinkedCredentialFiles(t *testing.T) {
	profile := testProfile("tenant-one", "agent-one")
	for _, targetName := range []string{credentialFile, stateFile, profileFile} {
		t.Run(targetName, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "agent-cli-credentials")
			store := mustOpen(t, root)
			if _, err := store.Put("tenant-one", "agent-one", profile, testToken, 1); err != nil {
				t.Fatal(err)
			}
			agentDirectory := store.agentDirectory("tenant-one", "agent-one")
			target := filepath.Join(agentDirectory, targetName)
			alias := filepath.Join(agentDirectory, targetName+".alias")
			if err := os.Link(target, alias); err != nil {
				t.Fatal(err)
			}

			if _, err := store.Lookup("tenant-one", "agent-one"); err == nil || Retryable(err) {
				t.Fatalf("Lookup accepted hard-linked %s or marked retryable: %v", targetName, err)
			}
			if _, _, err := store.Current("tenant-one", "agent-one"); err == nil || Retryable(err) {
				t.Fatalf("Current accepted hard-linked %s or marked retryable: %v", targetName, err)
			}
			if _, err := store.Put("tenant-one", "agent-one", profile, rotatedToken, 2); err == nil || Retryable(err) {
				t.Fatalf("Put accepted hard-linked %s or marked retryable: %v", targetName, err)
			}
		})
	}
}
