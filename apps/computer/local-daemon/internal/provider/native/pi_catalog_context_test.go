package native

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestPiCatalogPreservesContextCauseAfterChildCleanup(t *testing.T) {
	for _, kind := range []string{"deadline", "cancel"} {
		t.Run(kind, func(t *testing.T) {
			pidFile := filepath.Join(t.TempDir(), "pid")
			ctx, cancel := context.WithCancelCause(t.Context())
			defer cancel(nil)
			timeout := 400 * time.Millisecond
			if kind == "cancel" {
				timeout = 5 * time.Second
			}
			bounded, stop := context.WithTimeout(ctx, timeout)
			defer stop()
			done := make(chan error, 1)
			go func() {
				_, err := DiscoverPiModels(bounded, fixtureInvocation(t, "block", map[string]string{"FIXTURE_PID_FILE": pidFile}))
				done <- err
			}()
			var encoded []byte
			waitDeadline := time.NewTimer(3 * time.Second)
			defer waitDeadline.Stop()
			poll := time.NewTicker(5 * time.Millisecond)
			defer poll.Stop()
			for len(encoded) == 0 {
				if data, err := os.ReadFile(pidFile); err == nil && len(bytes.TrimSpace(data)) > 0 {
					encoded = data
					break
				}
				select {
				case err := <-done:
					t.Fatalf("catalog child exited before reporting pid: %v", err)
				case <-waitDeadline.C:
					t.Fatal("catalog child did not start")
				case <-poll.C:
				}
			}
			want := context.DeadlineExceeded
			if kind == "cancel" {
				want = context.Canceled
				cancel(errors.New("secret-cancel-cause"))
			}
			err := <-done
			if !errors.Is(err, want) || strings.Contains(err.Error(), "secret") {
				t.Fatalf("context cause lost or disclosed: %v", err)
			}
			pid, err := strconv.Atoi(strings.TrimSpace(string(encoded)))
			if err != nil {
				t.Fatal(err)
			}
			if runtime.GOOS != "windows" {
				child, err := os.FindProcess(pid)
				if err != nil {
					t.Fatal(err)
				}
				defer child.Release()
				if child.Signal(syscall.Signal(0)) == nil {
					t.Fatal("catalog child survived cancellation")
				}
			}
		})
	}
}

func TestPiCatalogMasksNonContextFailure(t *testing.T) {
	inv := fixtureInvocation(t, "print", map[string]string{"FIXTURE_STDOUT": "secret-output", "FIXTURE_EXIT": "1"})
	_, err := DiscoverPiModels(t.Context(), inv)
	if !errors.Is(err, errPiNoModels) || strings.Contains(err.Error(), "secret") {
		t.Fatalf("unsafe catalog failure: %v", err)
	}
}
