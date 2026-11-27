//go:build windows

// Package finalpath resolves canonical filesystem paths, following Windows
// directory junctions in addition to symbolic links.
package finalpath

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

const maxReparseDepth = 64

// Resolve returns the canonical path of path after following symbolic links
// and Windows directory junctions.
func Resolve(path string) (string, error) {
	if resolved, err := finalPathByHandle(path); err == nil {
		return resolved, nil
	}
	return resolveReparsePath(path)
}

// filepath.EvalSymlinks stops at directory junctions since Go 1.23. Ask
// Windows for the path of the handle it actually opens.
func finalPathByHandle(path string) (string, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	handle, err := windows.CreateFile(
		name,
		0,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS,
		0,
	)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(handle)
	buffer := make([]uint16, windows.MAX_LONG_PATH)
	n, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], uint32(len(buffer)), 0) // normalized DOS path
	if err != nil {
		return "", err
	}
	if n >= uint32(len(buffer)) {
		return "", errors.New("resolved path is too long")
	}
	return trimExtendedPrefix(windows.UTF16ToString(buffer[:n])), nil
}

func trimExtendedPrefix(value string) string {
	if share, ok := strings.CutPrefix(value, `\\?\UNC\`); ok {
		return `\\` + share
	}
	return strings.TrimPrefix(value, `\\?\`)
}

// resolveReparsePath walks path components with os.Lstat and os.Readlink when
// GetFinalPathNameByHandle is unavailable (for example under a restricted
// token), expanding both symbolic links and directory junctions.
func resolveReparsePath(target string) (string, error) {
	current, err := filepath.Abs(target)
	if err != nil {
		return "", err
	}
	for range maxReparseDepth {
		rewritten, changed, err := expandFirstReparseComponent(current)
		if err != nil {
			return "", err
		}
		if !changed {
			return filepath.EvalSymlinks(current)
		}
		current = rewritten
	}
	return "", errors.New("too many symbolic links or directory junctions")
}

func expandFirstReparseComponent(absPath string) (string, bool, error) {
	volume := filepath.VolumeName(absPath)
	rest := strings.TrimLeft(strings.TrimPrefix(absPath, volume), `\/`)
	if rest == "" {
		return absPath, false, nil
	}
	parts := strings.Split(rest, string(filepath.Separator))
	prefix := volume + string(filepath.Separator)
	for i, part := range parts {
		if part == "" {
			continue
		}
		candidate := filepath.Join(prefix, part)
		info, err := os.Lstat(candidate)
		if err != nil {
			return "", false, err
		}
		if info.Mode()&(fs.ModeSymlink|fs.ModeIrregular) != 0 {
			linkTarget, readErr := os.Readlink(candidate)
			if readErr == nil {
				linkTarget = trimExtendedPrefix(linkTarget)
				if !filepath.IsAbs(linkTarget) {
					linkTarget = filepath.Join(filepath.Dir(candidate), linkTarget)
				}
				tail := parts[i+1:]
				if len(tail) == 0 {
					return filepath.Clean(linkTarget), true, nil
				}
				return filepath.Clean(filepath.Join(append([]string{linkTarget}, tail...)...)), true, nil
			}
		}
		prefix = candidate
	}
	return absPath, false, nil
}
