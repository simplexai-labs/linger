//go:build darwin

package localtools

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
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

// TestWindowShareWatcherCloseHasNoWaitRace starts a tiny helper script and
// closes the watcher concurrently while watch/stop calls run, verifying under
// -race that cmd.Wait is called only once in readLoop.
func TestWindowShareWatcherCloseHasNoWaitRace(t *testing.T) {
	dir := t.TempDir()
	helper := filepath.Join(dir, "fake-window-share.sh")
	script := "#!/bin/sh\nwhile IFS= read -r line; do :; done\n"
	if err := os.WriteFile(helper, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	watcher := newWindowShareWatcher(helper, nil)
	watcher.watch(42)

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		watcher.watch(43)
		watcher.stop(43)
	}()
	go func() {
		defer wg.Done()
		watcher.close()
	}()
	wg.Wait()
	// Repeated close is a safe no-op.
	watcher.close()
}
