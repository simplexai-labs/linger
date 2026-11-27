//go:build !windows

package localtools

// restoreMinimizedWindow is used only on Windows; see
// restore_window_windows.go.
func restoreMinimizedWindow(pid, window int64) (bool, error) { return false, nil }
