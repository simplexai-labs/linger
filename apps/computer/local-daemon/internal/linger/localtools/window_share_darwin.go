//go:build darwin

package localtools

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
)

// windowShareWatcher runs the optional macOS ScreenCaptureKit helper binary
// (`linger-window-share`) so the active captured window displays macOS's native
// purple menu-bar indicator and clicking "Stop Sharing" cancels the active
// desktop operation immediately. At most one window stream is held at a time;
// switching to a new window stops the previous stream first. When the helper
// binary is not installed, all operations gracefully no-op.
type windowShareWatcher struct {
	mu          sync.Mutex
	helperPath  string
	onStopped   func(windowID uint32)
	cmd         *exec.Cmd
	stdin       io.WriteCloser
	current     uint32
	closed      bool
	startFailed bool
}

func newWindowShareWatcher(helperPath string, onStopped func(windowID uint32)) *windowShareWatcher {
	if helperPath == "" {
		helperPath = discoverWindowShareHelper()
	}
	return &windowShareWatcher{
		helperPath: helperPath,
		onStopped:  onStopped,
	}
}

func discoverWindowShareHelper() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	candidate := filepath.Join(filepath.Dir(exe), "linger-window-share")
	if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
		return candidate
	}
	return ""
}

func (w *windowShareWatcher) watch(windowID uint32) {
	if w == nil || windowID == 0 {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed || w.startFailed || w.helperPath == "" || w.current == windowID {
		return
	}
	if w.cmd == nil {
		if !w.startLocked() {
			return
		}
	}
	if w.current != 0 {
		_ = w.sendLocked(map[string]uint32{"stop": w.current})
		w.current = 0
	}
	if w.sendLocked(map[string]uint32{"watch": windowID}) {
		w.current = windowID
	}
}

func (w *windowShareWatcher) stop(windowID uint32) {
	if w == nil || windowID == 0 {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed || w.current != windowID {
		return
	}
	w.current = 0
	if w.stdin != nil {
		w.sendLocked(map[string]uint32{"stop": windowID})
	}
}

func (w *windowShareWatcher) close() {
	if w == nil {
		return
	}
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	w.closed = true
	stdin := w.stdin
	cmd := w.cmd
	w.stdin, w.cmd, w.current = nil, nil, 0
	w.mu.Unlock()
	if stdin != nil {
		_ = stdin.Close()
	}
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}
}

func (w *windowShareWatcher) startLocked() bool {
	cmd := exec.CommandContext(context.Background(), w.helperPath)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		w.startFailed = true
		return false
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		w.startFailed = true
		return false
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		w.startFailed = true
		slog.Debug("computer.window_share.start_skipped", "helper", w.helperPath, "error", err)
		return false
	}
	w.cmd = cmd
	w.stdin = stdin
	go w.readLoop(stdout, cmd)
	return true
}

func (w *windowShareWatcher) sendLocked(msg map[string]uint32) bool {
	if w.stdin == nil {
		return false
	}
	line, err := json.Marshal(msg)
	if err != nil {
		return false
	}
	line = append(line, '\n')
	if _, err := w.stdin.Write(line); err != nil {
		slog.Warn("computer.window_share.write_failed", "error", err)
		return false
	}
	return true
}

func (w *windowShareWatcher) readLoop(stdout io.Reader, cmd *exec.Cmd) {
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		var event struct {
			StoppedByUser uint32 `json:"stopped_by_user"`
		}
		if json.Unmarshal(scanner.Bytes(), &event) == nil && event.StoppedByUser != 0 {
			slog.Info("computer.window_share.stopped_by_user", "window_id", event.StoppedByUser)
			w.mu.Lock()
			if w.current == event.StoppedByUser {
				w.current = 0
			}
			cb := w.onStopped
			w.mu.Unlock()
			if cb != nil {
				cb(event.StoppedByUser)
			}
		}
	}
	_ = cmd.Wait()
}
