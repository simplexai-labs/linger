//go:build !windows

package lingercontext

import (
	"os"
	"syscall"
)

// contextFileOpenFlags keeps a Context file that became a FIFO from blocking the open.
const contextFileOpenFlags = os.O_RDONLY | syscall.O_NONBLOCK

func validatePlatformRelativePath(string) error { return nil }
func validatePlatformMappings([]Mapping) error  { return nil }
func replaceProjectionFile(root *os.Root, source, target string) error {
	return root.Rename(source, target)
}
func syncDirectory(root *os.Root, relative string) error {
	file, err := root.Open(relative)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}

// singleLink reports whether a file has no other hard link that could name
// content from outside its folder.
func singleLink(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Nlink == 1
}
