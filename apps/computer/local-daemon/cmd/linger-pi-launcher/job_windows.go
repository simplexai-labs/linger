//go:build windows

package main

import (
	"os/exec"
	"syscall"
	"unsafe"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/winprocess"
	"golang.org/x/sys/windows"
)

func createKillOnCloseJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	_, err = windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)),
		uint32(unsafe.Sizeof(limits)),
	)
	if err != nil {
		_ = windows.CloseHandle(job)
		return 0, err
	}
	return job, nil
}

// runOwned binds the child Node process to a kill-on-close job before it
// executes user code so terminating pi.exe also terminates node.exe instead
// of leaving it holding cwd busy.
func runOwned(cmd *exec.Cmd) error {
	job, err := createKillOnCloseJob()
	if err != nil {
		return cmd.Run()
	}
	defer func() { _ = windows.CloseHandle(job) }()
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_SUSPENDED
	if err := cmd.Start(); err != nil {
		return err
	}
	if process, openErr := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid)); openErr == nil {
		// Environments that forbid nested jobs fail assignment; let the child
		// still run instead of refusing launch.
		_ = windows.AssignProcessToJobObject(job, process)
		_ = windows.CloseHandle(process)
	}
	if err := winprocess.Resume(cmd.Process.Pid); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}
	return cmd.Wait()
}
