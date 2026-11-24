package localmodels

import (
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"modernc.org/sqlite"
)

// Defaults of the installer lock wait.
const (
	// defaultInstallerLockWait matches the installer's own LOCK_WAIT_MS,
	// which is above the quit-time stop's hard exit.
	defaultInstallerLockWait  = 3 * time.Minute
	defaultInstallerLockRetry = time.Second
)

// SQLite primary result codes that mean another connection holds the lock.
const (
	sqliteBusy   = 5
	sqliteLocked = 6
)

// installerLockPath names the installer's local-models lock. The installer
// keeps the localmodels state in <home>/runtime/localmodels/state and its
// lock database beside it as <home>/runtime/localmodels/operation.sqlite
// (localModelsLockFile in packages/local-installation), so the lock sits in
// the state directory's parent.
func installerLockPath(tool *Tool) string {
	if tool == nil || tool.StateDirectory == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(tool.StateDirectory), "operation.sqlite")
}

// awaitSettled waits until the first installer lock probe of this Library
// has ended. Every caller shares one probe, which runs on the Library's
// lifetime: a caller that stops waiting does not stop it.
func (l *Library) awaitSettled(ctx context.Context) error {
	l.settleOnce.Do(func() {
		if !l.track(1) {
			close(l.settledCh)
			return
		}
		go func() {
			defer l.wg.Done()
			defer close(l.settledCh)
			l.awaitInstallerIdle(l.ctx)
		}()
	})
	select {
	case <-l.settledCh:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-l.ctx.Done():
		return errLibraryClosed
	}
}

// settled reports whether the installer lock probe has ended.
func (l *Library) settled() bool {
	select {
	case <-l.settledCh:
		return true
	default:
		return false
	}
}

// awaitInstallerIdle waits while the installer holds its local-models lock:
// the stop a quit starts after the app is gone unloads every model under
// it, and a status read meanwhile still shows them loaded. The wait is
// bounded; any doubt about the lock file counts as idle, so the Daemon
// never blocks on a file it cannot trust.
func (l *Library) awaitInstallerIdle(ctx context.Context) {
	path := installerLockPath(l.tool)
	if path == "" {
		return
	}
	started := time.Now()
	waiting := false
	for {
		if !l.installerLockBusy(ctx, path) {
			slog.Info("local_models.installer_lock", "phase", "idle", "ms", time.Since(started).Milliseconds())
			return
		}
		if l.testInstallerBusy != nil {
			l.testInstallerBusy()
		}
		if !waiting {
			waiting = true
			slog.Info("local_models.installer_lock", "phase", "waiting")
		}
		if time.Since(started) >= l.installerLockWait {
			slog.Warn("local_models.installer_lock", "phase", "timeout", "ms", time.Since(started).Milliseconds())
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(l.installerLockRetry):
		}
	}
}

// installerLockBusy takes the lock and releases it at once: holding it
// while a model loads would make the installer's own resume fail.
func (l *Library) installerLockBusy(ctx context.Context, path string) bool {
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false
	}
	if err != nil {
		slog.Warn("local_models.installer_lock", "phase", "skipped", "reason", "stat", "error", err)
		return false
	}
	if !info.Mode().IsRegular() || !ownedByCurrentUser(info) {
		slog.Warn("local_models.installer_lock", "phase", "skipped", "reason", "untrusted_file")
		return false
	}
	if strings.ContainsAny(path, "?#") {
		slog.Warn("local_models.installer_lock", "phase", "skipped", "reason", "path")
		return false
	}
	// mode=rw never creates the file.
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?mode=rw&_pragma=busy_timeout(0)")
	if err != nil {
		slog.Warn("local_models.installer_lock", "phase", "skipped", "reason", "open", "error", err)
		return false
	}
	defer db.Close()
	conn, err := db.Conn(ctx)
	if err == nil {
		defer conn.Close()
		_, err = conn.ExecContext(ctx, "BEGIN EXCLUSIVE")
		if err == nil {
			_, err = conn.ExecContext(ctx, "ROLLBACK")
			if err != nil {
				slog.Warn("local_models.installer_lock", "phase", "rollback_failed", "error", err)
			}
			return false
		}
	}
	var sqliteErr *sqlite.Error
	if errors.As(err, &sqliteErr) {
		switch sqliteErr.Code() & 0xff {
		case sqliteBusy, sqliteLocked:
			return true
		}
	}
	if ctx.Err() == nil {
		slog.Warn("local_models.installer_lock", "phase", "skipped", "reason", "probe", "error", err)
	}
	return false
}
