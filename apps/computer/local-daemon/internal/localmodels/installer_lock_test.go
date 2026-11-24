package localmodels

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// holdInstallerLock takes the lock the way the installer does and returns
// its release.
func holdInstallerLock(t *testing.T, path string) func() {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(context.Background(), "CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER)"); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(context.Background(), "BEGIN EXCLUSIVE"); err != nil {
		t.Fatal(err)
	}
	released := false
	release := func() {
		if released {
			return
		}
		released = true
		_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
		_ = conn.Close()
		_ = db.Close()
	}
	t.Cleanup(release)
	return release
}

func quickLockRetry(library *Library) {
	library.installerLockRetry = 20 * time.Millisecond
}

// busyProbes returns a channel told of every probe that finds the
// installer's lock held. Set it before the Library probes.
func busyProbes(library *Library) <-chan struct{} {
	probes := make(chan struct{}, 64)
	library.testInstallerBusy = func() {
		select {
		case probes <- struct{}{}:
		default:
		}
	}
	return probes
}

// drainAndAwait waits for a probe that started after this call.
func drainAndAwait(t *testing.T, probes <-chan struct{}) {
	t.Helper()
	for {
		select {
		case <-probes:
			continue
		default:
		}
		break
	}
	timeout := time.After(20 * time.Second)
	for range 2 {
		select {
		case <-probes:
		case <-timeout:
			t.Fatal("timed out waiting for a lock probe")
		}
	}
}

func TestARunWaitsForTheInstallersStop(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "loaded")))
	release := holdInstallerLock(t, installerLockPath(&fake.tool))
	fake.script("load", fakeScript{
		Lines: []fakeLine{{Line: progressLine(testModel, "load", 0, 2)}, {Line: resultLine(testModel)}}, StatusAfter: statusJSON(model(testModel, "loaded")),
	})
	library := newEnsureLibrary(t, fake, 0)
	quickLockRetry(library)
	probes := busyProbes(library)
	library.Refresh(context.Background())
	done := make(chan error, 1)
	go func() { done <- library.EnsureLoaded(context.Background(), testPiModel) }()
	drainAndAwait(t, probes)
	select {
	case err := <-done:
		t.Fatalf("returned %v while the installer held its lock", err)
	default:
	}
	// The stop unloads the model under the lock.
	fake.write("status.json", status(model(testModel, "idle")))
	statusReads := len(callsWithPrefix(fake, "status "))
	release()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if len(callsWithPrefix(fake, "status ")) <= statusReads {
		t.Fatal("no status read after the lock was released")
	}
	if load := callsWithPrefix(fake, "load "); len(load) != 1 {
		t.Fatalf("loads = %v", load)
	}
}

func TestAMissingInstallerLockIsNotWaitedFor(t *testing.T) {
	fake := newFakeTool(t)
	library := newEnsureLibrary(t, fake, 0)
	library.installerLockRetry = time.Hour
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := library.awaitSettled(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(installerLockPath(&fake.tool)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the probe created the lock file: %v", err)
	}
}

func TestTheInstallerLockWaitIsBounded(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "loaded")))
	holdInstallerLock(t, installerLockPath(&fake.tool))
	library := newEnsureLibrary(t, fake, 0)
	quickLockRetry(library)
	library.installerLockWait = 200 * time.Millisecond
	if err := library.EnsureLoaded(context.Background(), testPiModel); err != nil {
		t.Fatal(err)
	}
	if !library.settled() {
		t.Fatal("not settled after the bound")
	}
}

func TestACancelledRunLeavesTheSharedLockWait(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "loaded")))
	release := holdInstallerLock(t, installerLockPath(&fake.tool))
	library := newEnsureLibrary(t, fake, 0)
	quickLockRetry(library)
	probes := busyProbes(library)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := library.EnsureLoaded(ctx, testPiModel); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- library.EnsureLoaded(context.Background(), testPiModel) }()
	drainAndAwait(t, probes)
	select {
	case err := <-done:
		t.Fatalf("a later Run returned %v while the lock was held", err)
	default:
	}
	release()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestASettledRunDoesNotProbeTheLockAgain(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "loaded")))
	library := newEnsureLibrary(t, fake, 0)
	library.Refresh(context.Background())
	if err := library.awaitSettled(context.Background()); err != nil {
		t.Fatal(err)
	}
	holdInstallerLock(t, installerLockPath(&fake.tool))
	before := len(fake.calls())
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := library.EnsureLoaded(ctx, testPiModel); err != nil {
		t.Fatal(err)
	}
	if len(fake.calls()) != before {
		t.Fatalf("ran the tool: %v", fake.calls()[before:])
	}
}

func TestASymlinkedInstallerLockIsNotTrusted(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	fake := newFakeTool(t)
	target := filepath.Join(t.TempDir(), "elsewhere.sqlite")
	holdInstallerLock(t, target)
	if err := os.Symlink(target, installerLockPath(&fake.tool)); err != nil {
		t.Fatal(err)
	}
	library := newEnsureLibrary(t, fake, 0)
	quickLockRetry(library)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := library.awaitSettled(ctx); err != nil {
		t.Fatal(err)
	}
}

// A model outside the library does not wait for the installer: its stop
// changes nothing that is on the Computer.
func TestARunOutsideTheLibraryDoesNotWaitForTheInstaller(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "loaded")))
	holdInstallerLock(t, installerLockPath(&fake.tool))
	library := newEnsureLibrary(t, fake, 0)
	quickLockRetry(library)
	library.Refresh(context.Background())
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := library.EnsureLoaded(ctx, "openai/gpt-5"); err != nil {
		t.Fatal(err)
	}
	if library.settled() {
		t.Fatal("the probe ended while the installer held its lock")
	}
}

// The installer's layout puts the lock beside the state directory; the
// installer's localModelsLockFile pins the same path.
func TestTheInstallerLockSitsBesideTheStateDirectory(t *testing.T) {
	tool := &Tool{StateDirectory: filepath.Join("/home", "u", "runtime", "localmodels", "state")}
	if got := installerLockPath(tool); got != filepath.Join("/home", "u", "runtime", "localmodels", "operation.sqlite") {
		t.Fatalf("lock = %q", got)
	}
}
