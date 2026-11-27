//go:build windows

// Package winupdate atomically swaps a pre-staged Windows Desktop installation
// and relaunches Linger after the previous process exits.
package winupdate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	// DefaultRegistryKey is the per-user uninstall registry key written by
	// apps/desktop/packaging/win/installer.nsi.
	DefaultRegistryKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\Linger`
	// UninstallerFileName is the NSIS uninstaller placed beside Linger.exe.
	UninstallerFileName = "Uninstall Linger.exe"
	// StopMarkerRelPath is the relative path of STOP_MARKER written by
	// apps/desktop/packaging/win/installer.nsi.
	StopMarkerRelPath = `resources\stops-services`

	stagedDirPrefix = ".linger-update-"
	oldDirPrefix    = ".Linger-old-"
	maxConfigBytes  = 1 << 20
)

var versionPattern = regexp.MustCompile(`^\d+\.\d+\.\d+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$`)

// Request describes a pre-staged Windows Desktop update to apply after the
// running application exits.
type Request struct {
	ParentPID    int    `json:"parentPid,omitempty"`
	InstallDir   string `json:"installDir"`
	StagedDir    string `json:"stagedDir"`
	Version      string `json:"version"`
	RegistryKey  string `json:"registryKey,omitempty"`
	SkipRegistry bool   `json:"skipRegistry,omitempty"`
	Relaunch     *bool  `json:"relaunch,omitempty"`
	LogPath      string `json:"logPath,omitempty"`
}

type applyDeps struct {
	renameFn          func(oldpath, newpath string) error
	relaunchFn        func(exePath string) error
	nowFn             func() time.Time
	parentWaitTimeout time.Duration
	preserveTimeout   time.Duration
	rename1Timeout    time.Duration
	rename2Timeout    time.Duration
	rollbackTimeout   time.Duration
	retryInterval     time.Duration
}

func defaultApplyDeps() applyDeps {
	return applyDeps{
		renameFn:          os.Rename,
		relaunchFn:        launchDetached,
		nowFn:             time.Now,
		parentWaitTimeout: 15 * time.Second,
		preserveTimeout:   5 * time.Second,
		rename1Timeout:    10 * time.Second,
		rename2Timeout:    15 * time.Second,
		rollbackTimeout:   15 * time.Second,
		retryInterval:     200 * time.Millisecond,
	}
}

// ApplyConfigFile reads a JSON Request from configPath, deletes configPath
// best-effort, and applies the update.
func ApplyConfigFile(ctx context.Context, configPath string) error {
	cleanPath, err := validateLocalPath(configPath, "config path")
	if err != nil {
		return err
	}
	if err := verifyDirChainNoReparse(filepath.Dir(cleanPath)); err != nil {
		return fmt.Errorf("config directory unsafe: %w", err)
	}
	data, err := readRegularFileNoReparse(cleanPath, maxConfigBytes)
	if err != nil {
		return fmt.Errorf("read update config: %w", err)
	}
	defer func() { _ = os.Remove(cleanPath) }()

	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var req Request
	if err := decoder.Decode(&req); err != nil {
		return fmt.Errorf("decode update config: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return errors.New("update config must contain one JSON object")
	}
	return Apply(ctx, req)
}

// Apply preserves NSIS uninstall metadata, waits for ParentPID to exit, swaps
// StagedDir into InstallDir with rollback on failure, updates DisplayVersion in
// HKCU, removes the empty staging wrapper, and relaunches Linger.exe.
func Apply(ctx context.Context, req Request) error {
	return apply(ctx, req, defaultApplyDeps())
}

func apply(ctx context.Context, req Request, deps applyDeps) error {
	validated, err := validateRequest(req)
	if err != nil {
		return err
	}
	logger := openApplyLogger(validated.logPath)
	defer logger.close()

	logger.printf("starting apply version=%s installDir=%s stagedDir=%s parentPid=%d",
		validated.version, validated.installDir, validated.stagedDir, req.ParentPID)

	relaunchExisting := func(reason string) {
		if !validated.relaunch {
			return
		}
		if relaunchErr := deps.relaunchFn(filepath.Join(validated.installDir, "Linger.exe")); relaunchErr != nil {
			logger.printf("relaunch existing app after %s failed: %v", reason, relaunchErr)
		}
	}

	// Preserve NSIS metadata before waiting for Electron to exit: running
	// Linger.exe never mutates Uninstall Linger.exe or resources\stops-services,
	// so Defender's scan of the copied PE overlaps with the exit window instead
	// of contending with Rename 2.
	for _, rel := range []string{UninstallerFileName, StopMarkerRelPath} {
		if err := preserveMetadataFile(ctx, validated.installDir, validated.stagedDir, rel, deps.preserveTimeout, deps.retryInterval, logger); err != nil {
			logger.printf("preserve metadata %s failed: %v", rel, err)
			if waitErr := waitForParentExit(ctx, req.ParentPID, deps.parentWaitTimeout, logger); waitErr == nil {
				relaunchExisting("metadata preservation failure")
			}
			return err
		}
	}

	if err := waitForParentExit(ctx, req.ParentPID, deps.parentWaitTimeout, logger); err != nil {
		logger.printf("parent wait aborted: %v", err)
		return err
	}

	oldDir, err := chooseOldDir(validated.parentDir, deps.nowFn())
	if err != nil {
		logger.printf("choose backup directory failed: %v", err)
		relaunchExisting("backup directory allocation failure")
		return err
	}

	// Move current installDir aside so stagedDir can take its place.
	if err := renameWithRetry(ctx, deps.renameFn, validated.installDir, oldDir, deps.rename1Timeout, deps.retryInterval); err != nil {
		logger.printf("rename installDir -> oldDir failed: %v", err)
		relaunchExisting("rename1 failure")
		return fmt.Errorf("move existing installation aside: %w", err)
	}

	// Promote stagedDir into installDir; roll back immediately on error.
	if err := renameWithRetry(ctx, deps.renameFn, validated.stagedDir, validated.installDir, deps.rename2Timeout, deps.retryInterval); err != nil {
		logger.printf("rename stagedDir -> installDir failed: %v; rolling back", err)
		rollbackErr := renameWithRetry(context.Background(), deps.renameFn, oldDir, validated.installDir, deps.rollbackTimeout, deps.retryInterval)
		if rollbackErr != nil {
			logger.printf("rollback oldDir -> installDir failed: %v", rollbackErr)
			return errors.Join(
				fmt.Errorf("promote staged update: %w", err),
				fmt.Errorf("rollback previous installation: %w", rollbackErr),
			)
		}
		logger.printf("rollback succeeded")
		relaunchExisting("rollback")
		return fmt.Errorf("promote staged update: %w", err)
	}

	// Best-effort HKCU DisplayVersion update when the existing uninstall key
	// declares an InstallLocation matching installDir.
	if !validated.skipRegistry {
		updateUninstallDisplayVersion(validated.registryKey, validated.installDir, validated.version, logger)
	}

	// Best-effort removal of the now-empty .Linger-update-* wrapper.
	if validated.wrapperDir != "" {
		if err := os.Remove(validated.wrapperDir); err != nil && !isNotExist(err) {
			logger.printf("cleanup wrapper %s skipped: %v", validated.wrapperDir, err)
		}
	}

	// Relaunch the newly installed Linger.exe detached.
	if validated.relaunch {
		exePath := filepath.Join(validated.installDir, "Linger.exe")
		if err := deps.relaunchFn(exePath); err != nil {
			logger.printf("relaunch new app failed: %v", err)
			return fmt.Errorf("relaunch updated app: %w", err)
		}
		logger.printf("relaunched %s", exePath)
	}
	logger.printf("apply completed version=%s", validated.version)
	return nil
}

type validatedRequest struct {
	installDir   string
	stagedDir    string
	parentDir    string
	wrapperDir   string
	version      string
	registryKey  string
	skipRegistry bool
	relaunch     bool
	logPath      string
}

func validateRequest(req Request) (validatedRequest, error) {
	if !versionPattern.MatchString(req.Version) {
		return validatedRequest{}, fmt.Errorf("invalid update version %q", req.Version)
	}
	installDir, err := validateLocalPath(req.InstallDir, "installDir")
	if err != nil {
		return validatedRequest{}, err
	}
	stagedDir, err := validateLocalPath(req.StagedDir, "stagedDir")
	if err != nil {
		return validatedRequest{}, err
	}
	if filepath.Dir(installDir) == installDir {
		return validatedRequest{}, errors.New("installDir must not be a volume root")
	}
	if filepath.Dir(stagedDir) == stagedDir {
		return validatedRequest{}, errors.New("stagedDir must not be a volume root")
	}
	if strings.EqualFold(installDir, stagedDir) {
		return validatedRequest{}, errors.New("installDir and stagedDir must be distinct")
	}
	if pathWithin(stagedDir, installDir) || pathWithin(installDir, stagedDir) {
		return validatedRequest{}, errors.New("installDir and stagedDir must not overlap")
	}
	if !strings.EqualFold(filepath.VolumeName(installDir), filepath.VolumeName(stagedDir)) {
		return validatedRequest{}, errors.New("installDir and stagedDir must share the same volume")
	}

	parentDir := filepath.Dir(installDir)
	stagedParent := filepath.Dir(stagedDir)
	var wrapperDir string
	switch {
	case strings.EqualFold(stagedParent, parentDir) && hasStagedPrefix(filepath.Base(stagedDir)):
		wrapperDir = ""
	case strings.EqualFold(filepath.Dir(stagedParent), parentDir) && hasStagedPrefix(filepath.Base(stagedParent)):
		wrapperDir = stagedParent
	default:
		return validatedRequest{}, errors.New("stagedDir must live inside a sibling .Linger-update-* folder beside installDir")
	}

	if err := verifyDirChainNoReparse(installDir); err != nil {
		return validatedRequest{}, fmt.Errorf("installDir unsafe: %w", err)
	}
	if err := verifyRegularFileNoReparse(filepath.Join(installDir, "Linger.exe")); err != nil {
		return validatedRequest{}, fmt.Errorf("installed Linger.exe invalid: %w", err)
	}
	if err := verifyDirChainNoReparse(stagedDir); err != nil {
		return validatedRequest{}, fmt.Errorf("stagedDir unsafe: %w", err)
	}
	if err := verifyRegularFileNoReparse(filepath.Join(stagedDir, "Linger.exe")); err != nil {
		return validatedRequest{}, fmt.Errorf("staged Linger.exe invalid: %w", err)
	}

	regKey := strings.TrimSpace(req.RegistryKey)
	if !req.SkipRegistry {
		if regKey == "" {
			regKey = DefaultRegistryKey
		}
		if strings.HasPrefix(regKey, `\`) || strings.HasPrefix(regKey, `/`) || strings.Contains(regKey, "..") {
			return validatedRequest{}, errors.New("registryKey must be a relative HKCU subkey")
		}
	}

	var logPath string
	if strings.TrimSpace(req.LogPath) != "" {
		cleanedLog, err := validateLocalPath(req.LogPath, "logPath")
		if err != nil {
			return validatedRequest{}, err
		}
		if pathWithin(cleanedLog, installDir) || pathWithin(cleanedLog, stagedDir) || (wrapperDir != "" && pathWithin(cleanedLog, wrapperDir)) {
			return validatedRequest{}, errors.New("logPath must lie outside installDir and stagedDir")
		}
		logPath = cleanedLog
	}

	relaunch := true
	if req.Relaunch != nil {
		relaunch = *req.Relaunch
	}

	return validatedRequest{
		installDir:   installDir,
		stagedDir:    stagedDir,
		parentDir:    parentDir,
		wrapperDir:   wrapperDir,
		version:      req.Version,
		registryKey:  regKey,
		skipRegistry: req.SkipRegistry,
		relaunch:     relaunch,
		logPath:      logPath,
	}, nil
}

func hasStagedPrefix(name string) bool {
	return strings.HasPrefix(strings.ToLower(name), stagedDirPrefix) && len(name) > len(stagedDirPrefix)
}

func pathWithin(candidate, root string) bool {
	if strings.EqualFold(candidate, root) {
		return true
	}
	prefix := root
	if !strings.HasSuffix(prefix, `\`) {
		prefix += `\`
	}
	return len(candidate) > len(prefix) && strings.EqualFold(candidate[:len(prefix)], prefix)
}

// validateLocalPath ensures raw is an absolute local Windows drive path (e.g.
// C:\path), rejecting UNC paths, device paths, relative paths, and NTFS ADS
// colons.
func validateLocalPath(raw, field string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", fmt.Errorf("%s is required", field)
	}
	if strings.HasPrefix(raw, `\\`) || strings.HasPrefix(raw, `//`) {
		return "", fmt.Errorf("%s must be a local filesystem path", field)
	}
	clean := filepath.Clean(raw)
	vol := filepath.VolumeName(clean)
	if len(vol) != 2 || vol[1] != ':' || !isASCIIAlpha(vol[0]) || !filepath.IsAbs(clean) {
		return "", fmt.Errorf("%s must be an absolute local drive path", field)
	}
	rest := strings.TrimPrefix(clean, vol)
	if strings.Contains(rest, ":") {
		return "", fmt.Errorf("%s must not contain alternate data streams", field)
	}
	return clean, nil
}

func isASCIIAlpha(b byte) bool {
	return (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z')
}

// verifyDirChainNoReparse checks every directory from the volume root down to
// dir, rejecting symlinks, junctions, and other reparse points without keeping
// handles open after return.
func verifyDirChainNoReparse(dir string) error {
	var chain []string
	cur := dir
	for {
		chain = append(chain, cur)
		next := filepath.Dir(cur)
		if next == cur {
			break
		}
		cur = next
	}
	for i := len(chain) - 1; i >= 0; i-- {
		if err := verifyDirNoReparse(chain[i]); err != nil {
			return err
		}
	}
	return nil
}

func verifyDirNoReparse(dir string) error {
	info, err := statNoReparse(dir)
	if err != nil {
		return err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return fmt.Errorf("reparse point rejected: %s", dir)
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		return fmt.Errorf("expected directory: %s", dir)
	}
	return nil
}

func verifyRegularFileNoReparse(filePath string) error {
	info, err := statNoReparse(filePath)
	if err != nil {
		return err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return fmt.Errorf("reparse point rejected: %s", filePath)
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0 {
		return fmt.Errorf("expected regular file: %s", filePath)
	}
	return nil
}

func statNoReparse(target string) (windows.ByHandleFileInformation, error) {
	name, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return windows.ByHandleFileInformation{}, err
	}
	handle, err := windows.CreateFile(
		name,
		windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT,
		0,
	)
	if err != nil {
		return windows.ByHandleFileInformation{}, &os.PathError{Op: "stat", Path: target, Err: err}
	}
	defer windows.CloseHandle(handle)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return windows.ByHandleFileInformation{}, err
	}
	return info, nil
}

func readRegularFileNoReparse(filePath string, limit int64) ([]byte, error) {
	file, err := openRegularFileForReadNoReparse(filePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("file exceeds %d byte limit", limit)
	}
	return data, nil
}

func openRegularFileForReadNoReparse(filePath string) (*os.File, error) {
	name, err := windows.UTF16PtrFromString(filePath)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(
		name,
		windows.GENERIC_READ|windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_OPEN_REPARSE_POINT,
		0,
	)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: filePath, Err: err}
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		_ = windows.CloseHandle(handle)
		return nil, err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		_ = windows.CloseHandle(handle)
		return nil, fmt.Errorf("reparse point rejected: %s", filePath)
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0 {
		_ = windows.CloseHandle(handle)
		return nil, fmt.Errorf("expected regular file: %s", filePath)
	}
	return os.NewFile(uintptr(handle), filePath), nil
}

func waitForParentExit(ctx context.Context, pid int, timeout time.Duration, logger *applyLogger) error {
	if pid <= 0 {
		return nil
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return nil
	}
	if err != nil {
		// Access denied (e.g. PID recycled to a privileged process) must not
		// block an update when installDir is already unlocked.
		logger.printf("open parent pid=%d returned %v; proceeding to swap", pid, err)
		return nil //nolint:nilerr // proceed to rename retry loop if PID cannot be opened
	}
	defer windows.CloseHandle(handle)

	deadline := time.Now().Add(timeout)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			logger.printf("parent pid=%d did not exit within %s; proceeding to swap", pid, timeout)
			return nil
		}
		slice := remaining
		if slice > 250*time.Millisecond {
			slice = 250 * time.Millisecond
		}
		ms := uint32((slice + time.Millisecond - 1) / time.Millisecond)
		if ms == 0 {
			ms = 1
		}
		event, waitErr := windows.WaitForSingleObject(handle, ms)
		switch event {
		case windows.WAIT_OBJECT_0:
			logger.printf("parent pid=%d exited", pid)
			return nil
		case uint32(windows.WAIT_TIMEOUT):
			continue
		default:
			logger.printf("wait parent pid=%d returned event=%d err=%v; proceeding to swap", pid, event, waitErr)
			return nil
		}
	}
}

func preserveMetadataFile(
	ctx context.Context,
	installDir, stagedDir, relPath string,
	timeout, interval time.Duration,
	logger *applyLogger,
) error {
	src := filepath.Join(installDir, relPath)
	dst := filepath.Join(stagedDir, relPath)

	_, dstErr := os.Lstat(dst)
	if dstErr == nil {
		return nil
	}
	if !isNotExist(dstErr) {
		return fmt.Errorf("inspect staged metadata %s: %w", relPath, dstErr)
	}

	ancestorErr := verifyRelativeSubdirsNoReparse(installDir, filepath.Dir(relPath))
	if isNotExist(ancestorErr) {
		return nil
	}
	if ancestorErr != nil {
		return fmt.Errorf("unsafe metadata ancestor %s: %w", relPath, ancestorErr)
	}

	deadline := time.Now().Add(timeout)
	if interval <= 0 {
		interval = 50 * time.Millisecond
	}
	var lastErr error
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := copyMetadataOnce(src, dst, stagedDir, relPath)
		if isNotExist(err) || errors.Is(err, os.ErrExist) {
			return nil
		}
		if err == nil {
			logger.printf("preserved metadata %s", relPath)
			return nil
		}
		if !isTransientLockError(err) {
			return fmt.Errorf("preserve metadata %s: %w", relPath, err)
		}
		lastErr = err
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return fmt.Errorf("preserve metadata %s: %w", relPath, lastErr)
		}
		wait := interval
		if wait > remaining {
			wait = remaining
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func copyMetadataOnce(src, dst, stagedDir, relPath string) error {
	srcFile, err := openRegularFileForReadNoReparse(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	dstParent := filepath.Dir(dst)
	if dstParent != stagedDir {
		if err := ensureRelativeSubdirsNoReparse(stagedDir, filepath.Dir(relPath)); err != nil {
			return fmt.Errorf("prepare staged metadata directory: %w", err)
		}
	}

	dstFile, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(dstFile, srcFile)
	closeErr := dstFile.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(dst)
		return errors.Join(copyErr, closeErr)
	}
	return nil
}

func isTransientLockError(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) ||
		errors.Is(err, windows.ERROR_LOCK_VIOLATION) ||
		errors.Is(err, windows.ERROR_ACCESS_DENIED)
}

func verifyRelativeSubdirsNoReparse(root, relDir string) error {
	if relDir == "." || relDir == "" {
		return nil
	}
	cur := root
	for _, part := range strings.Split(filepath.Clean(relDir), string(filepath.Separator)) {
		if part == "" || part == "." {
			continue
		}
		cur = filepath.Join(cur, part)
		if err := verifyDirNoReparse(cur); err != nil {
			return err
		}
	}
	return nil
}

func ensureRelativeSubdirsNoReparse(root, relDir string) error {
	if relDir == "." || relDir == "" {
		return nil
	}
	cur := root
	for _, part := range strings.Split(filepath.Clean(relDir), string(filepath.Separator)) {
		if part == "" || part == "." {
			continue
		}
		cur = filepath.Join(cur, part)
		if err := os.Mkdir(cur, 0o750); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
		if err := verifyDirNoReparse(cur); err != nil {
			return err
		}
	}
	return nil
}

func chooseOldDir(parentDir string, now time.Time) (string, error) {
	base := fmt.Sprintf("%s%d", oldDirPrefix, now.UnixMilli())
	candidate := filepath.Join(parentDir, base)
	if _, err := os.Lstat(candidate); isNotExist(err) {
		return candidate, nil
	}
	for i := 1; i <= 100; i++ {
		candidate = filepath.Join(parentDir, fmt.Sprintf("%s-%d", base, i))
		if _, err := os.Lstat(candidate); isNotExist(err) {
			return candidate, nil
		}
	}
	return "", errors.New("could not allocate unique backup folder name")
}

func renameWithRetry(
	ctx context.Context,
	renameFn func(string, string) error,
	from, to string,
	timeout, interval time.Duration,
) error {
	deadline := time.Now().Add(timeout)
	if interval <= 0 {
		interval = 50 * time.Millisecond
	}
	var lastErr error
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := renameFn(from, to)
		if err == nil {
			return nil
		}
		lastErr = err
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return lastErr
		}
		wait := interval
		if wait > remaining {
			wait = remaining
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func updateUninstallDisplayVersion(regKey, installDir, version string, logger *applyLogger) {
	key, err := registry.OpenKey(registry.CURRENT_USER, regKey, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		if !errors.Is(err, registry.ErrNotExist) {
			logger.printf("open uninstall registry key failed: %v", err)
		}
		return
	}
	defer key.Close()

	location, _, err := key.GetStringValue("InstallLocation")
	if err != nil {
		logger.printf("skipping registry update: InstallLocation unreadable: %v", err)
		return
	}
	trimmed := strings.TrimSpace(strings.Trim(strings.TrimSpace(location), `"`))
	if trimmed == "" {
		logger.printf("skipping registry update: InstallLocation is empty")
		return
	}
	if !strings.EqualFold(filepath.Clean(trimmed), installDir) {
		logger.printf("skipping registry update: InstallLocation mismatch")
		return
	}
	if err := key.SetStringValue("DisplayVersion", version); err != nil {
		logger.printf("write DisplayVersion failed: %v", err)
		return
	}
	logger.printf("updated DisplayVersion to %s", version)
}

func launchDetached(exePath string) error {
	cmd := exec.Command(exePath)
	cmd.Dir = filepath.Dir(exePath)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS,
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

type applyLogger struct {
	file *os.File
}

func openApplyLogger(logPath string) *applyLogger {
	if logPath == "" {
		return &applyLogger{}
	}
	if err := verifyDirChainNoReparse(filepath.Dir(logPath)); err != nil {
		return &applyLogger{}
	}
	info, err := statNoReparse(logPath)
	if err == nil && info.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		return &applyLogger{}
	}
	if err != nil && !isNotExist(err) {
		return &applyLogger{}
	}
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return &applyLogger{}
	}
	return &applyLogger{file: f}
}

func isNotExist(err error) bool {
	return errors.Is(err, os.ErrNotExist) ||
		errors.Is(err, windows.ERROR_FILE_NOT_FOUND) ||
		errors.Is(err, windows.ERROR_PATH_NOT_FOUND)
}

func (l *applyLogger) printf(format string, args ...any) {
	if l == nil || l.file == nil {
		return
	}
	_, _ = fmt.Fprintf(l.file, "%s %s\n", time.Now().UTC().Format(time.RFC3339Nano), fmt.Sprintf(format, args...))
}

func (l *applyLogger) close() {
	if l == nil || l.file == nil {
		return
	}
	_ = l.file.Close()
	l.file = nil
}
