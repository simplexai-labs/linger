//go:build darwin

package localtools

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWindowShareWatcherNotifiesOnUserStopped(t *testing.T) {
	scriptPath := filepath.Join(t.TempDir(), "fake-window-share.sh")
	script := `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *watch*42*)
      printf '{"stopped_by_user":42}\n'
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

	select {
	case got := <-stopped:
		if got != 42 {
			t.Fatalf("stopped window = %d, want 42", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for stopped_by_user callback")
	}
}
