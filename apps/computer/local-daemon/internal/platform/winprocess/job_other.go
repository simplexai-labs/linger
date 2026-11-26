//go:build !windows

// Package winprocess provides Windows process identity, termination, and
// Job Object helpers, with pass-through stubs on non-Windows platforms.
package winprocess

import "os/exec"

// RunInKillOnCloseJob runs cmd directly on non-Windows platforms where
// Windows Job Objects do not exist.
func RunInKillOnCloseJob(cmd *exec.Cmd) error {
	return cmd.Run()
}
