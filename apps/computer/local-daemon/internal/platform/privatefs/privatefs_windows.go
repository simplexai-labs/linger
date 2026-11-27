//go:build windows

package privatefs

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

func CurrentSID() (*windows.SID, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	return user.User.Sid.Copy()
}

func SecurityDescriptor() (*windows.SECURITY_DESCRIPTOR, error) {
	sid, err := CurrentSID()
	if err != nil {
		return nil, err
	}
	return windows.SecurityDescriptorFromString("O:" + sid.String() + "D:P(A;OICI;FA;;;" + sid.String() + ")(A;OICI;FA;;;SY)")
}

// PipeSecurityDescriptor deliberately grants only this user access. SYSTEM is
// not needed to serve an interactive user's local HTTP control endpoint.
func PipeSecurityDescriptor() (string, error) {
	sid, err := CurrentSID()
	if err != nil {
		return "", err
	}
	return "O:" + sid.String() + "D:P(A;;GA;;;" + sid.String() + ")", nil
}

func attributes() (*windows.SecurityAttributes, error) {
	sd, err := SecurityDescriptor()
	if err != nil {
		return nil, err
	}
	return &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}, nil
}

// pinParents rejects every reparse point and keeps each ancestor open without
// FILE_SHARE_DELETE until the target has been opened. A junction or parent
// rename therefore cannot redirect the path between validation and opening it.
func pinParents(path string) (func(), error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if strings.HasPrefix(absolute, `\\`) || strings.Contains(strings.TrimPrefix(absolute, filepath.VolumeName(absolute)), ":") {
		return nil, errors.New("private state requires a local filesystem path")
	}
	parent := filepath.Dir(absolute)
	var paths []string
	for {
		paths = append(paths, parent)
		next := filepath.Dir(parent)
		if next == parent {
			break
		}
		parent = next
	}
	handles := []windows.Handle{}
	closeAll := func() {
		for i := len(handles) - 1; i >= 0; i-- {
			_ = windows.CloseHandle(handles[i])
		}
	}
	for i := len(paths) - 1; i >= 0; i-- {
		name, err := windows.UTF16PtrFromString(paths[i])
		if err != nil {
			closeAll()
			return nil, err
		}
		handle, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			closeAll()
			return nil, &os.PathError{Op: "open private ancestor", Path: paths[i], Err: err}
		}
		handles = append(handles, handle)
		var info windows.ByHandleFileInformation
		if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
			closeAll()
			return nil, err
		}
		if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
			closeAll()
			return nil, fmt.Errorf("private path has an unsafe ancestor (%s)", paths[i])
		}
	}
	return closeAll, nil
}

func openHandle(path string, access, disposition uint32, sa *windows.SecurityAttributes) (*os.File, error) {
	closeParents, err := pinParents(path)
	if err != nil {
		return nil, err
	}
	defer closeParents()
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(name, access|windows.READ_CONTROL, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, sa, disposition, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open private path", Path: path, Err: err}
	}
	return os.NewFile(uintptr(handle), path), nil
}

func validateHandle(file *os.File, kind string, ownerOnly bool) error {
	handle := windows.Handle(file.Fd())
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errors.New("private path is a reparse point")
	}
	directory := info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0
	if (kind == "directory") != directory || (!directory && info.NumberOfLinks != 1) {
		return errors.New("private path type or link count is unsafe")
	}
	sd, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	return validateDescriptor(sd, ownerOnly)
}

// privateOwner reports whether owner may own the current user's private path:
// the user, or BUILTIN\Administrators when the user is an administrator. That
// group owns what an elevated process creates (Run as administrator, the
// built-in Administrator), and an administrator can take ownership of any
// file, so accepting it trusts no other account. Git for Windows decides
// ownership the same way.
func privateOwner(owner, user *windows.SID) bool {
	return owner != nil && (windows.EqualSid(owner, user) ||
		owner.IsWellKnown(windows.WinBuiltinAdministratorsSid) && currentUserIsAdministrator())
}

// currentUserIsAdministrator reports whether this process's token, or the
// elevated token UAC links to it, has Administrators enabled.
var currentUserIsAdministrator = func() bool {
	administrators, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return false
	}
	if member, err := windows.Token(0).IsMember(administrators); err == nil && member {
		return true
	}
	linked, err := windows.GetCurrentProcessToken().GetLinkedToken()
	if err != nil {
		return false
	}
	defer linked.Close()
	member, err := linked.IsMember(administrators)
	return err == nil && member
}

func validateDescriptor(sd *windows.SECURITY_DESCRIPTOR, ownerOnly bool) error {
	user, err := CurrentSID()
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil || !privateOwner(owner, user) {
		return errors.New("private path is not owned by the current user")
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil {
		return errors.New("private path has no access restriction")
	}
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			return err
		}
		if ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 {
			continue
		}
		if ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
			continue
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return errors.New("private path contains an unsupported permission entry")
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if windows.EqualSid(sid, user) || sid.IsWellKnown(windows.WinLocalSystemSid) || sid.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
			continue
		}
		mask := uint32(windows.GENERIC_ALL | windows.GENERIC_WRITE | windows.FILE_GENERIC_WRITE | windows.DELETE | windows.WRITE_DAC | windows.WRITE_OWNER | 0x40)
		// FILE_GENERIC_WRITE also contains READ_CONTROL and SYNCHRONIZE; those
		// alone do not grant write access and must remain valid for public Skills.
		mask &^= windows.READ_CONTROL | windows.SYNCHRONIZE
		if ownerOnly {
			mask = ^uint32(0)
		}
		if uint32(ace.Mask)&mask != 0 {
			// The SID names the account to remove; it is not secret.
			return fmt.Errorf("private path grants access to another user (%s)", sid.String())
		}
	}
	return nil
}

func CheckPath(path, kind string, ownerOnly bool) error {
	if kind != "file" && kind != "directory" {
		return errors.New("invalid private path kind")
	}
	file, err := openHandle(path, windows.FILE_READ_ATTRIBUTES, windows.OPEN_EXISTING, nil)
	if err != nil {
		return err
	}
	defer file.Close()
	return validateHandle(file, kind, ownerOnly)
}

// CheckFile validates the identity and ACL of an already opened object.
func CheckFile(file *os.File, kind string, ownerOnly bool) error {
	return validateHandle(file, kind, ownerOnly)
}

func OpenRead(path string, ownerOnly bool) (*os.File, error) {
	file, err := openHandle(path, windows.GENERIC_READ, windows.OPEN_EXISTING, nil)
	if err != nil {
		return nil, err
	}
	if err := validateHandle(file, "file", ownerOnly); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

func EnsureDir(path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("private directory must be absolute")
	}
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		parent := filepath.Dir(path)
		if parent == path {
			return err
		}
		if _, err := os.Lstat(parent); errors.Is(err, os.ErrNotExist) {
			if err := EnsureDir(parent); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		release, err := pinParents(path)
		if err != nil {
			return err
		}
		defer release()
		sa, err := attributes()
		if err != nil {
			return err
		}
		name, err := windows.UTF16PtrFromString(path)
		if err != nil {
			return err
		}
		if err := windows.CreateDirectory(name, sa); err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
			return err
		}
	} else if err != nil {
		return err
	}
	file, err := openHandle(path, windows.FILE_READ_ATTRIBUTES|windows.WRITE_DAC, windows.OPEN_EXISTING, nil)
	if err != nil {
		return err
	}
	defer file.Close()
	if validateHandle(file, "directory", true) == nil {
		return nil
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(file.Fd()), &info); err != nil {
		return err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errors.New("private directory is unsafe")
	}
	sd, err := windows.GetSecurityInfo(windows.Handle(file.Fd()), windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	current, currentErr := CurrentSID()
	if err != nil || currentErr != nil || !privateOwner(owner, current) {
		return errors.New("private directory belongs to another user")
	}
	desired, err := SecurityDescriptor()
	if err != nil {
		return err
	}
	dacl, _, err := desired.DACL()
	if err != nil {
		return err
	}
	if err := windows.SetSecurityInfo(windows.Handle(file.Fd()), windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		return fmt.Errorf("protect private directory: %w", err)
	}
	return validateHandle(file, "directory", true)
}

// ProtectDirectory applies EnsureDir to path and then gives each regular file
// directly inside it that this user owns the same protected owner-only DACL.
// Files that an earlier version wrote without one (Node's mode bits do nothing
// on Windows) would otherwise keep ACEs inherited from the user profile, and
// the daemon refuses to read them. Subdirectories are left to their owners.
func ProtectDirectory(path string) error {
	if err := EnsureDir(path); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			continue
		}
		file := filepath.Join(path, entry.Name())
		if err := ProtectFile(file); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("%s: %w", file, err)
		}
	}
	return nil
}

// ProtectFile tightens an existing regular file owned by the current user to a
// protected owner-only DACL. Reparse points, directories, hard-linked files,
// and files owned by another user are refused without modification.
func ProtectFile(path string) error {
	file, err := openHandle(path, windows.FILE_READ_ATTRIBUTES|windows.WRITE_DAC, windows.OPEN_EXISTING, nil)
	if err != nil {
		return err
	}
	defer file.Close()
	if validateHandle(file, "file", true) == nil {
		return nil
	}
	handle := windows.Handle(file.Fd())
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errors.New("private path is a reparse point")
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0 || info.NumberOfLinks != 1 {
		return errors.New("private path type or link count is unsafe")
	}
	sd, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	current, currentErr := CurrentSID()
	if err != nil || currentErr != nil || !privateOwner(owner, current) {
		return errors.New("private file belongs to another user")
	}
	desired, err := SecurityDescriptor()
	if err != nil {
		return err
	}
	dacl, _, err := desired.DACL()
	if err != nil {
		return err
	}
	if err := windows.SetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		return fmt.Errorf("protect private file: %w", err)
	}
	return validateHandle(file, "file", true)
}

func openWrite(path string, exclusive bool) (*os.File, error) {
	sa, err := attributes()
	if err != nil {
		return nil, err
	}
	disposition := uint32(windows.OPEN_ALWAYS)
	if exclusive {
		disposition = windows.CREATE_NEW
	}
	file, err := openHandle(path, windows.GENERIC_WRITE|windows.FILE_READ_ATTRIBUTES, disposition, sa)
	if err != nil {
		return nil, err
	}
	if err := validateHandle(file, "file", true); err != nil {
		file.Close()
		return nil, err
	}
	if !exclusive {
		if _, err := file.Seek(0, 2); err != nil {
			file.Close()
			return nil, err
		}
	}
	return file, nil
}
func OpenLog(path string) (*os.File, error) { return openWrite(path, false) }
