//go:build windows

package privatefs

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	// fileAllAccess matches Win32 FILE_ALL_ACCESS, .NET FileSystemRights.FullControl,
	// and SDDL "FA" for files and directories (STANDARD_RIGHTS_REQUIRED | SYNCHRONIZE | 0x1FF).
	fileAllAccess = uint32(0x001F01FF)
	dirInheritAll = uint8(windows.CONTAINER_INHERIT_ACE | windows.OBJECT_INHERIT_ACE)
	shareAll      = windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE | windows.FILE_SHARE_DELETE
)

// ValidationFailure describes a structured failure from ValidateOrRepair using
// the allowlisted reason codes expected by the Windows private path checker.
type ValidationFailure struct {
	Code      string `json:"code"`
	Ancestor  string `json:"ancestor,omitempty"`
	SID       string `json:"sid,omitempty"`
	Stage     string `json:"stage,omitempty"`
	ErrorType string `json:"errorType,omitempty"`
	HResult   string `json:"hresult,omitempty"`
}

func uncheckedFailure(stage string, err error) *ValidationFailure {
	failure := &ValidationFailure{
		Code:  "UNCHECKED",
		Stage: stage,
	}
	if err != nil {
		var errno windows.Errno
		if errors.As(err, &errno) {
			failure.ErrorType = "Win32Exception"
			failure.HResult = fmt.Sprintf("0x%08X", uint32(0x80070000)|(uint32(errno)&0xFFFF))
		} else {
			failure.ErrorType = "IOException"
		}
	}
	return failure
}

func pathNotFound(err error) bool {
	return errors.Is(err, windows.ERROR_FILE_NOT_FOUND) ||
		errors.Is(err, windows.ERROR_PATH_NOT_FOUND)
}

func hasUnsafeStreamSeparator(cleanPath string) bool {
	volume := filepath.VolumeName(cleanPath)
	return strings.Contains(strings.TrimPrefix(cleanPath, volume), ":")
}

// ValidateOrRepair checks that targetPath is a local, non-reparse private file,
// directory, or candidate location owned by the current user (or Administrators
// when the user is an administrator) without reparse ancestors, and optionally
// repairs the DACL to a protected owner + SYSTEM FullControl policy.
//
// Returns nil when valid, or a structured ValidationFailure matching the
// allowlisted codes of packages/local-installation/src/windows-private.ts.
func ValidateOrRepair(targetPath, kind string, repair bool) *ValidationFailure {
	if kind != "file" && kind != "directory" && kind != "location" {
		return uncheckedFailure("init", errors.New("invalid private path kind"))
	}
	if targetPath == "" || strings.HasPrefix(targetPath, `\\`) {
		return &ValidationFailure{Code: "UNSAFE_TYPE"}
	}
	cleanPath := filepath.Clean(targetPath)
	if !filepath.IsAbs(cleanPath) || strings.HasPrefix(cleanPath, `\\`) || hasUnsafeStreamSeparator(cleanPath) {
		return &ValidationFailure{Code: "UNSAFE_TYPE"}
	}

	userSID, err := CurrentSID()
	if err != nil {
		return uncheckedFailure("init", err)
	}
	systemSID, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		return uncheckedFailure("init", err)
	}

	if kind == "location" {
		return validateLocation(cleanPath, userSID)
	}
	return validateTarget(cleanPath, kind == "directory", repair, userSID, systemSID)
}

func validateLocation(cleanPath string, userSID *windows.SID) *ValidationFailure {
	namePtr, err := windows.UTF16PtrFromString(cleanPath)
	if err != nil {
		return uncheckedFailure("target", err)
	}
	attrs, err := windows.GetFileAttributes(namePtr)
	var ancestorProbe string
	if err == nil {
		if attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || attrs&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
			return &ValidationFailure{Code: "UNSAFE_TYPE"}
		}
		parent := filepath.Dir(cleanPath)
		if parent == cleanPath {
			return &ValidationFailure{Code: "UNSAFE_TYPE"}
		}
		openAttrs, sd, openErr := readTargetInfoAndSD(cleanPath, namePtr, windows.OWNER_SECURITY_INFORMATION)
		if openErr != nil {
			return uncheckedFailure("owner", openErr)
		}
		if openAttrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || openAttrs&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
			return &ValidationFailure{Code: "UNSAFE_TYPE"}
		}
		owner, _, ownerErr := sd.Owner()
		if ownerErr != nil || owner == nil {
			return uncheckedFailure("owner", ownerErr)
		}
		if !privateOwner(owner, userSID) {
			return &ValidationFailure{Code: "UNSAFE_OWNER", SID: owner.String()}
		}
		ancestorProbe = parent
	} else if pathNotFound(err) {
		probe := filepath.Dir(cleanPath)
		for probe != "" {
			probePtr, ptrErr := windows.UTF16PtrFromString(probe)
			if ptrErr != nil {
				return uncheckedFailure("target", ptrErr)
			}
			probeAttrs, probeErr := windows.GetFileAttributes(probePtr)
			if probeErr == nil {
				if probeAttrs&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
					return &ValidationFailure{Code: "UNSAFE_TYPE"}
				}
				ancestorProbe = probe
				break
			}
			if !pathNotFound(probeErr) {
				return uncheckedFailure("target", probeErr)
			}
			next := filepath.Dir(probe)
			if next == probe {
				break
			}
			probe = next
		}
		if ancestorProbe == "" {
			return &ValidationFailure{Code: "UNSAFE_TYPE"}
		}
	} else {
		return uncheckedFailure("target", err)
	}

	return checkAncestors(ancestorProbe)
}

func getAttributesFallback(namePtr *uint16) (uint32, error) {
	attrs, err := windows.GetFileAttributes(namePtr)
	if err == nil {
		return attrs, nil
	}
	if !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return 0, err
	}
	var data windows.Win32finddata
	findHandle, findErr := windows.FindFirstFile(namePtr, &data)
	if findErr != nil {
		return 0, err
	}
	_ = windows.FindClose(findHandle)
	return data.FileAttributes, nil
}

func readTargetInfoAndSD(cleanPath string, namePtr *uint16, secInfo windows.SECURITY_INFORMATION) (uint32, *windows.SECURITY_DESCRIPTOR, error) {
	handle, err := windows.CreateFile(
		namePtr,
		windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL,
		shareAll,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT,
		0,
	)
	if err == nil {
		defer windows.CloseHandle(handle)
		var info windows.ByHandleFileInformation
		if infoErr := windows.GetFileInformationByHandle(handle, &info); infoErr != nil {
			return 0, nil, infoErr
		}
		sd, secErr := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, secInfo)
		if secErr != nil {
			return 0, nil, secErr
		}
		if sd == nil {
			return 0, nil, errors.New("security descriptor unavailable")
		}
		return info.FileAttributes, sd, nil
	}
	if !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return 0, nil, err
	}
	// CreateFile implicitly adds FILE_READ_ATTRIBUTES/SYNCHRONIZE, so an owner
	// locked out of their own file fails CreateFile even though they retain
	// implicit READ_CONTROL. Fall back to parent-entry attributes +
	// GetNamedSecurityInfo (which opens with pure READ_CONTROL via NtOpenFile).
	attrs, attrErr := getAttributesFallback(namePtr)
	if attrErr != nil {
		return 0, nil, attrErr
	}
	sd, secErr := windows.GetNamedSecurityInfo(cleanPath, windows.SE_FILE_OBJECT, secInfo)
	if secErr != nil {
		return 0, nil, secErr
	}
	if sd == nil {
		return 0, nil, errors.New("security descriptor unavailable")
	}
	return attrs, sd, nil
}

func validateTarget(cleanPath string, expectDir, repair bool, userSID, systemSID *windows.SID) *ValidationFailure {
	namePtr, err := windows.UTF16PtrFromString(cleanPath)
	if err != nil {
		return uncheckedFailure("target", err)
	}
	attrs, sd, err := readTargetInfoAndSD(
		cleanPath,
		namePtr,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION,
	)
	if err != nil {
		return uncheckedFailure("target", err)
	}

	isReparse := attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0
	isDir := attrs&windows.FILE_ATTRIBUTE_DIRECTORY != 0
	if isReparse || isDir != expectDir {
		return &ValidationFailure{Code: "UNSAFE_TYPE"}
	}

	owner, _, err := sd.Owner()
	if err != nil || owner == nil {
		return uncheckedFailure("owner", err)
	}
	if !privateOwner(owner, userSID) {
		return &ValidationFailure{Code: "UNSAFE_OWNER", SID: owner.String()}
	}

	parent := filepath.Dir(cleanPath)
	if parent != cleanPath {
		if failure := checkAncestors(parent); failure != nil {
			return failure
		}
	}

	if repair && !isAlreadyRepaired(sd, userSID, systemSID, expectDir) {
		updated, repairFailure := repairTargetDACL(cleanPath, namePtr, expectDir, userSID)
		if repairFailure != nil {
			return repairFailure
		}
		sd = updated
	}

	return verifyTargetDACL(sd, expectDir, userSID, systemSID)
}

func checkAncestors(probe string) *ValidationFailure {
	for probe != "" {
		ptr, err := windows.UTF16PtrFromString(probe)
		if err != nil {
			return uncheckedFailure("ancestor", err)
		}
		attrs, err := windows.GetFileAttributes(ptr)
		if err != nil {
			return uncheckedFailure("ancestor", err)
		}
		if attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return &ValidationFailure{
				Code:     "UNSAFE_PARENT_LINK",
				Ancestor: probe,
			}
		}
		next := filepath.Dir(probe)
		if next == probe {
			break
		}
		probe = next
	}
	return nil
}

func isAlreadyRepaired(sd *windows.SECURITY_DESCRIPTOR, userSID, systemSID *windows.SID, isDir bool) bool {
	if sd == nil {
		return false
	}
	control, _, err := sd.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		return false
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil || dacl.AceCount != 2 {
		return false
	}
	expectedFlags := uint8(0)
	if isDir {
		expectedFlags = dirInheritAll
	}
	hasUser := false
	hasSystem := false
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			return false
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE ||
			ace.Header.AceFlags != expectedFlags ||
			uint32(ace.Mask) != fileAllAccess {
			return false
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if windows.EqualSid(sid, userSID) {
			hasUser = true
		} else if windows.EqualSid(sid, systemSID) {
			hasSystem = true
		} else {
			return false
		}
	}
	return hasUser && hasSystem
}

func repairTargetDACL(cleanPath string, namePtr *uint16, isDir bool, userSID *windows.SID) (*windows.SECURITY_DESCRIPTOR, *ValidationFailure) {
	var sddl string
	if isDir {
		sddl = "D:P(A;OICI;FA;;;" + userSID.String() + ")(A;OICI;FA;;;SY)"
	} else {
		sddl = "D:P(A;;FA;;;" + userSID.String() + ")(A;;FA;;;SY)"
	}
	desired, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return nil, uncheckedFailure("repair", err)
	}
	dacl, _, err := desired.DACL()
	if err != nil || dacl == nil {
		return nil, uncheckedFailure("repair", err)
	}

	writeHandle, err := windows.CreateFile(
		namePtr,
		windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL|windows.WRITE_DAC,
		shareAll,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT,
		0,
	)
	if err == nil {
		defer windows.CloseHandle(writeHandle)
		var info windows.ByHandleFileInformation
		if infoErr := windows.GetFileInformationByHandle(writeHandle, &info); infoErr != nil {
			return nil, uncheckedFailure("repair", infoErr)
		}
		if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 ||
			(info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0) != isDir {
			return nil, &ValidationFailure{Code: "UNSAFE_TYPE"}
		}
		if secErr := windows.SetSecurityInfo(
			writeHandle,
			windows.SE_FILE_OBJECT,
			windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
			nil,
			nil,
			dacl,
			nil,
		); secErr != nil {
			return nil, uncheckedFailure("repair", secErr)
		}
		sd, secErr := windows.GetSecurityInfo(
			writeHandle,
			windows.SE_FILE_OBJECT,
			windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION,
		)
		if secErr != nil || sd == nil {
			if secErr == nil {
				secErr = errors.New("security descriptor unavailable")
			}
			return nil, uncheckedFailure("repair", secErr)
		}
		return sd, nil
	}
	if !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return nil, uncheckedFailure("repair", err)
	}

	attrs, attrErr := getAttributesFallback(namePtr)
	if attrErr != nil {
		return nil, uncheckedFailure("repair", attrErr)
	}
	if attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 ||
		(attrs&windows.FILE_ATTRIBUTE_DIRECTORY != 0) != isDir {
		return nil, &ValidationFailure{Code: "UNSAFE_TYPE"}
	}
	if secErr := windows.SetNamedSecurityInfo(
		cleanPath,
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil,
		nil,
		dacl,
		nil,
	); secErr != nil {
		return nil, uncheckedFailure("repair", secErr)
	}
	sd, secErr := windows.GetNamedSecurityInfo(
		cleanPath,
		windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION,
	)
	if secErr != nil || sd == nil {
		if secErr == nil {
			secErr = errors.New("security descriptor unavailable")
		}
		return nil, uncheckedFailure("repair", secErr)
	}
	return sd, nil
}

func verifyTargetDACL(sd *windows.SECURITY_DESCRIPTOR, isDir bool, userSID, systemSID *windows.SID) *ValidationFailure {
	if sd == nil {
		return uncheckedFailure("verify", errors.New("security descriptor unavailable"))
	}
	control, _, err := sd.Control()
	if err != nil {
		return uncheckedFailure("verify", err)
	}
	if isDir && control&windows.SE_DACL_PROTECTED == 0 {
		return &ValidationFailure{Code: "INHERITED_ACCESS"}
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return uncheckedFailure("verify", err)
	}
	if dacl == nil {
		return &ValidationFailure{Code: "MISSING_OWNER_ACCESS"}
	}
	currentAllowed := false
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			return uncheckedFailure("verify", err)
		}
		if ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
			continue
		}
		// Reject any non-Allow, non-Deny ACE type (such as callback or object
		// Allow ACEs) fail-closed so exotic ACEs cannot grant hidden access.
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return &ValidationFailure{Code: "SHARED_ACCESS"}
		}
		// Keep inherit-only Allow ACEs checked on the target itself because a
		// private directory also governs future descendants.
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if !windows.EqualSid(sid, userSID) && !windows.EqualSid(sid, systemSID) {
			return &ValidationFailure{
				Code: "SHARED_ACCESS",
				SID:  sid.String(),
			}
		}
		// Only a non-inherit-only, non-zero-mask Allow ACE grants the owner
		// effective access to the target itself.
		if windows.EqualSid(sid, userSID) &&
			ace.Header.AceFlags&windows.INHERIT_ONLY_ACE == 0 &&
			ace.Mask != 0 {
			currentAllowed = true
		}
	}
	if !currentAllowed {
		return &ValidationFailure{Code: "MISSING_OWNER_ACCESS"}
	}
	return nil
}
