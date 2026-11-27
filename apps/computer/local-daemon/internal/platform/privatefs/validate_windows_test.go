//go:build windows

package privatefs

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func setSDDLForTest(t *testing.T, targetPath, sddl string, protect bool) {
	t.Helper()
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		t.Fatalf("parse SDDL %q: %v", sddl, err)
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil {
		t.Fatalf("extract DACL: %v", err)
	}
	info := windows.SECURITY_INFORMATION(windows.DACL_SECURITY_INFORMATION)
	if protect {
		info |= windows.PROTECTED_DACL_SECURITY_INFORMATION
	} else {
		info |= windows.UNPROTECTED_DACL_SECURITY_INFORMATION
	}
	if err := windows.SetNamedSecurityInfo(targetPath, windows.SE_FILE_OBJECT, info, nil, nil, dacl, nil); err != nil {
		t.Fatalf("SetNamedSecurityInfo(%s): %v", targetPath, err)
	}
}

func TestValidateOrRepairDirectoryAndFileLifecycle(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "private-dir")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	// Fresh directory under TempDir inherits parent permissions.
	if failure := ValidateOrRepair(dir, "directory", false); failure == nil || failure.Code != "INHERITED_ACCESS" {
		t.Fatalf("expected INHERITED_ACCESS before repair, got %+v", failure)
	}

	// Repair protects the directory with owner + SYSTEM FullControl.
	if failure := ValidateOrRepair(dir, "directory", true); failure != nil {
		t.Fatalf("expected repair success, got %+v", failure)
	}
	if failure := ValidateOrRepair(dir, "directory", false); failure != nil {
		t.Fatalf("expected post-repair validation success, got %+v", failure)
	}

	// Verify already-repaired detection reports true after repair.
	userSID, err := CurrentSID()
	if err != nil {
		t.Fatalf("CurrentSID: %v", err)
	}
	systemSID, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		t.Fatalf("CreateWellKnownSid: %v", err)
	}
	sd, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatalf("GetNamedSecurityInfo: %v", err)
	}
	if !isAlreadyRepaired(sd, userSID, systemSID, true) {
		t.Fatal("expected directory to satisfy isAlreadyRepaired after repair")
	}

	// File inside the protected directory inherits user + SYSTEM and validates without repair.
	file := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(file, []byte("{}"), 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}
	if failure := ValidateOrRepair(file, "file", false); failure != nil {
		t.Fatalf("expected inherited private file to validate, got %+v", failure)
	}
	if failure := ValidateOrRepair(file, "file", true); failure != nil {
		t.Fatalf("expected file repair success, got %+v", failure)
	}
	fileSD, err := windows.GetNamedSecurityInfo(file, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatalf("GetNamedSecurityInfo(file): %v", err)
	}
	if !isAlreadyRepaired(fileSD, userSID, systemSID, false) {
		t.Fatal("expected file to satisfy isAlreadyRepaired after repair")
	}
}

func TestValidateOrRepairRejectsSharedAndMissingOwnerAccess(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "private")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if failure := ValidateOrRepair(dir, "directory", true); failure != nil {
		t.Fatalf("repair dir: %v", failure)
	}
	userSID, err := CurrentSID()
	if err != nil {
		t.Fatalf("CurrentSID: %v", err)
	}

	// Inherit-only Authenticated Users (S-1-5-11) on the target directory must be rejected as SHARED_ACCESS.
	setSDDLForTest(t, dir, "D:P(A;OICI;FA;;;"+userSID.String()+")(A;OICI;FA;;;SY)(A;OICIIO;0x1301bf;;;AU)", true)
	failure := ValidateOrRepair(dir, "directory", false)
	if failure == nil || failure.Code != "SHARED_ACCESS" || failure.SID != "S-1-5-11" {
		t.Fatalf("expected SHARED_ACCESS with sid S-1-5-11, got %+v", failure)
	}

	// Repair restores exact owner + SYSTEM FullControl.
	if failure := ValidateOrRepair(dir, "directory", true); failure != nil {
		t.Fatalf("expected repair to clear SHARED_ACCESS, got %+v", failure)
	}

	// File granting Everyone read access must be rejected as SHARED_ACCESS.
	file := filepath.Join(dir, "secret.json")
	if err := os.WriteFile(file, []byte("{}"), 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}
	setSDDLForTest(t, file, "D:P(A;;FA;;;"+userSID.String()+")(A;;FA;;;SY)(A;;FR;;;WD)", true)
	failure = ValidateOrRepair(file, "file", false)
	if failure == nil || failure.Code != "SHARED_ACCESS" || failure.SID != "S-1-1-0" {
		t.Fatalf("expected SHARED_ACCESS with sid S-1-1-0, got %+v", failure)
	}

	// Protected file with only SYSTEM Allow ACE (no owner access) must fail with MISSING_OWNER_ACCESS.
	setSDDLForTest(t, file, "D:P(A;;FA;;;SY)", true)
	t.Cleanup(func() {
		setSDDLForTest(t, file, "D:P(A;;FA;;;"+userSID.String()+")(A;;FA;;;SY)", true)
	})
	failure = ValidateOrRepair(file, "file", false)
	if failure == nil || failure.Code != "MISSING_OWNER_ACCESS" {
		t.Fatalf("expected MISSING_OWNER_ACCESS, got %+v", failure)
	}
	// Owner retains implicit WRITE_DAC, so repair restores owner access.
	if failure := ValidateOrRepair(file, "file", true); failure != nil {
		t.Fatalf("expected repair to fix MISSING_OWNER_ACCESS, got %+v", failure)
	}
}

func TestValidateOrRepairRejectsUnsafeTypesAndJunctions(t *testing.T) {
	if failure := ValidateOrRepair(`\\server\share\private`, "directory", false); failure == nil || failure.Code != "UNSAFE_TYPE" {
		t.Fatalf("expected UNSAFE_TYPE for UNC path, got %+v", failure)
	}
	if failure := ValidateOrRepair(`C:\`, "location", false); failure == nil || failure.Code != "UNSAFE_TYPE" {
		t.Fatalf("expected UNSAFE_TYPE for bare drive root location, got %+v", failure)
	}

	root := t.TempDir()
	if failure := ValidateOrRepair(root, "directory", true); failure != nil {
		t.Fatalf("repair root: %v", failure)
	}
	file := filepath.Join(root, "settings.json")
	if err := os.WriteFile(file, []byte("{}"), 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}

	// Mismatched kinds must fail with UNSAFE_TYPE.
	if failure := ValidateOrRepair(file, "directory", false); failure == nil || failure.Code != "UNSAFE_TYPE" {
		t.Fatalf("expected UNSAFE_TYPE for file checked as directory, got %+v", failure)
	}
	if failure := ValidateOrRepair(root, "file", false); failure == nil || failure.Code != "UNSAFE_TYPE" {
		t.Fatalf("expected UNSAFE_TYPE for directory checked as file, got %+v", failure)
	}
	if failure := ValidateOrRepair(file, "location", false); failure == nil || failure.Code != "UNSAFE_TYPE" {
		t.Fatalf("expected UNSAFE_TYPE for existing file checked as location, got %+v", failure)
	}

	// Valid existing and not-yet-created candidate locations.
	if failure := ValidateOrRepair(root, "location", false); failure != nil {
		t.Fatalf("expected valid existing location, got %+v", failure)
	}
	if failure := ValidateOrRepair(filepath.Join(root, "missing", "nested"), "location", false); failure != nil {
		t.Fatalf("expected valid missing location, got %+v", failure)
	}

	// Directory junction as target or ancestor.
	junction := filepath.Join(root, "link")
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", junction, root).CombinedOutput(); err != nil {
		t.Fatalf("create junction: %v (%s)", err, string(out))
	}
	t.Cleanup(func() { _ = os.Remove(junction) })

	if failure := ValidateOrRepair(junction, "directory", false); failure == nil || failure.Code != "UNSAFE_TYPE" {
		t.Fatalf("expected UNSAFE_TYPE for junction target, got %+v", failure)
	}
	failure := ValidateOrRepair(filepath.Join(junction, "settings.json"), "file", false)
	if failure == nil || failure.Code != "UNSAFE_PARENT_LINK" || failure.Ancestor != junction {
		t.Fatalf("expected UNSAFE_PARENT_LINK with ancestor %q, got %+v", junction, failure)
	}
	failure = ValidateOrRepair(filepath.Join(junction, "not-created-yet"), "location", false)
	if failure == nil || failure.Code != "UNSAFE_PARENT_LINK" || failure.Ancestor != junction {
		t.Fatalf("expected UNSAFE_PARENT_LINK for missing location under junction, got %+v", failure)
	}
}

func TestVerifyTargetDACLEdgeCases(t *testing.T) {
	userSID, err := CurrentSID()
	if err != nil {
		t.Fatalf("CurrentSID: %v", err)
	}
	systemSID, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		t.Fatalf("CreateWellKnownSid: %v", err)
	}

	// Nil security descriptor (such as filesystems without DACLs) must fail closed as UNCHECKED without panicking.
	if isAlreadyRepaired(nil, userSID, systemSID, true) {
		t.Fatal("expected isAlreadyRepaired(nil) to return false")
	}
	if failure := verifyTargetDACL(nil, true, userSID, systemSID); failure == nil || failure.Code != "UNCHECKED" {
		t.Fatalf("expected UNCHECKED for nil SD, got %+v", failure)
	}

	// Inherit-only Allow ACE for the current user does not grant access to the target itself.
	inheritOnlySD, err := windows.SecurityDescriptorFromString(
		"D:P(A;OICIIO;FA;;;" + userSID.String() + ")(A;OICI;FA;;;SY)",
	)
	if err != nil {
		t.Fatalf("parse inherit-only SDDL: %v", err)
	}
	if failure := verifyTargetDACL(inheritOnlySD, true, userSID, systemSID); failure == nil || failure.Code != "MISSING_OWNER_ACCESS" {
		t.Fatalf("expected MISSING_OWNER_ACCESS for inherit-only owner ACE, got %+v", failure)
	}

	// Zero-mask Allow ACE for the current user does not grant access to the target itself.
	zeroMaskSD, err := windows.SecurityDescriptorFromString(
		"D:P(A;;0x0;;;" + userSID.String() + ")(A;;FA;;;SY)",
	)
	if err != nil {
		t.Fatalf("parse zero-mask SDDL: %v", err)
	}
	if failure := verifyTargetDACL(zeroMaskSD, false, userSID, systemSID); failure == nil || failure.Code != "MISSING_OWNER_ACCESS" {
		t.Fatalf("expected MISSING_OWNER_ACCESS for zero-mask owner ACE, got %+v", failure)
	}

	// Conditional callback Allow ACE (ACCESS_ALLOWED_CALLBACK_ACE_TYPE) must fail closed.
	callbackSD, err := windows.SecurityDescriptorFromString(
		"D:P(XA;;FA;;;" + userSID.String() + ";(Exists LingerCheck))(A;;FA;;;SY)",
	)
	if err != nil {
		t.Fatalf("parse callback SDDL: %v", err)
	}
	if failure := verifyTargetDACL(callbackSD, false, userSID, systemSID); failure == nil || failure.Code != "SHARED_ACCESS" {
		t.Fatalf("expected SHARED_ACCESS for unsupported callback ACE type, got %+v", failure)
	}
}
