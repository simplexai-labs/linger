//go:build windows

package main

import (
	"errors"
	"fmt"
	"os/exec"
	"syscall"
	"unsafe"

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

// resumeProcess resumes the initial thread of a child started with
// CREATE_SUSPENDED once Job Object ownership has been configured.
func resumeProcess(pid int) error {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return err
	}
	defer func() { _ = windows.CloseHandle(snapshot) }()
	entry := windows.ThreadEntry32{Size: uint32(unsafe.Sizeof(windows.ThreadEntry32{}))}
	resumed := 0
	for err = windows.Thread32First(snapshot, &entry); err == nil; err = windows.Thread32Next(snapshot, &entry) {
		if entry.OwnerProcessID != uint32(pid) {
			continue
		}
		thread, openErr := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
		if openErr != nil {
			return openErr
		}
		_, resumeErr := windows.ResumeThread(thread)
		_ = windows.CloseHandle(thread)
		if resumeErr != nil {
			return resumeErr
		}
		resumed++
	}
	if err != nil && !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return err
	}
	if resumed == 0 {
		return fmt.Errorf("no initial thread for process %d", pid)
	}
	return nil
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
	if err := resumeProcess(cmd.Process.Pid); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}
	return cmd.Wait()
}
