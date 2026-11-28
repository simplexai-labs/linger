//go:build darwin

package localtools

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWindowShareWatcherNotifiesOnUserStoppedAndStopsPreviousWindow(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "commands.log")
	scriptPath := filepath.Join(t.TempDir(), "fake-window-share.sh")
	script := `#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> "` + logPath + `"
  case "$line" in
    *watch*99*)
      printf '{"stopped_by_user":99}\n'
      ;;
  esac
done
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	stopped := make(chan uint32, 1)
	watcher := newWindowShareWatcher(scriptPath, func(windowID uint32) {
		stopped <- windowID
	})
	defer watcher.close()

	watcher.watch(42)
	watcher.watch(99)

	select {
	case got := <-stopped:
		if got != 99 {
			t.Fatalf("stopped window = %d, want 99", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for stopped_by_user callback")
	}

	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 3 || lines[0] != `{"watch":42}` || lines[1] != `{"stop":42}` || lines[2] != `{"watch":99}` {
		t.Fatalf("commands = %q, want watch 42 -> stop 42 -> watch 99", lines)
	}
}
