package localtools

import (
	"fmt"
	"time"
	"unsafe"
)

var (
	procIsIconic            = user32.NewProc("IsIconic")
	procIsWindow            = user32.NewProc("IsWindow")
	procShowWindowAsync     = user32.NewProc("ShowWindowAsync")
	procSetWindowPos        = user32.NewProc("SetWindowPos")
	procGetForegroundWindow = user32.NewProc("GetForegroundWindow")
)

const (
	swShowNoActivate = 4
	swpNoSize        = 0x0001
	swpNoMove        = 0x0002
	swpNoActivate    = 0x0010
)

// restoreMinimizedWindow restores window of pid when it is minimized, without
// activating it, and places it right below the window in front. The user's
// foreground window and keyboard focus stay where they are, and background
// input then reaches the restored window. It reports whether it restored the
// window.
func restoreMinimizedWindow(pid, window int64) (bool, error) {
	hwnd := uintptr(window)
	if valid, _, _ := procIsWindow.Call(hwnd); valid == 0 {
		return false, nil
	}
	var owner uint32
	procGetWindowThreadProcessID.Call(hwnd, uintptr(unsafe.Pointer(&owner)))
	if int64(owner) != pid {
		return false, nil
	}
	if iconic, _, _ := procIsIconic.Call(hwnd); iconic == 0 {
		return false, nil
	}
	below := func() {
		if front, _, _ := procGetForegroundWindow.Call(); front != 0 && front != hwnd {
			procSetWindowPos.Call(hwnd, front, 0, 0, 0, 0, swpNoSize|swpNoMove|swpNoActivate)
		}
	}
	// Ordering first keeps the restored window from showing above the user's
	// window; ordering again covers an app that raises itself on restore.
	below()
	// The async call never blocks on an app that does not answer messages.
	procShowWindowAsync.Call(hwnd, swShowNoActivate)
	for deadline := time.Now().Add(time.Second); ; time.Sleep(25 * time.Millisecond) {
		if iconic, _, _ := procIsIconic.Call(hwnd); iconic == 0 {
			break
		}
		if time.Now().After(deadline) {
			return false, fmt.Errorf("window %d stayed minimized", window)
		}
	}
	below()
	return true, nil
}
