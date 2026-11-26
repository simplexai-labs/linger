//go:build !windows

package main

import "os/exec"

func runOwned(cmd *exec.Cmd) error {
	return cmd.Run()
}
