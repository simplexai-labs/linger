//go:build windows

package winupdate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"golang.org/x/sys/windows/registry"
)

func boolPtr(v bool) *bool { return &v }

func setupDirs(t *testing.T, nested bool) (parent, installDir, wrapperDir, stagedDir string) {
	t.Helper()
	parent = filepath.Join(t.TempDir(), "Programs")
	installDir = filepath.Join(parent, "Linger")
	if err := os.MkdirAll(filepath.Join(installDir, "resources"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(installDir, "Linger.exe"), []byte("old-linger"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(installDir, UninstallerFileName), []byte("nsis-uninstaller"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(installDir, StopMarkerRelPath), []byte("stop"), 0o644); err != nil {
		t.Fatal(err)
	}

	if nested {
		wrapperDir = filepath.Join(parent, ".Linger-update-0.17.0")
		stagedDir = filepath.Join(wrapperDir, "Linger")
	} else {
		stagedDir = filepath.Join(parent, ".Linger-update-0.17.0")
	}
	if err := os.MkdirAll(filepath.Join(stagedDir, "resources", "app"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stagedDir, "Linger.exe"), []byte("new-linger"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stagedDir, "resources", "app", "marker.txt"), []byte("v0.17.0"), 0o644); err != nil {
		t.Fatal(err)
	}
	return parent, installDir, wrapperDir, stagedDir
}

func createTestRegistryKey(t *testing.T, installLocation *string, displayVersion string) string {
	t.Helper()
	keyPath := fmt.Sprintf(`Software\LingerTest\WinUpdate-%s`, uuid.NewString())
	key, _, err := registry.CreateKey(registry.CURRENT_USER, keyPath, registry.ALL_ACCESS)
	if err != nil {
		t.Fatalf("create test registry key: %v", err)
	}
	defer key.Close()
	if installLocation != nil {
		if err := key.SetStringValue("InstallLocation", *installLocation); err != nil {
			t.Fatalf("set InstallLocation: %v", err)
		}
	}
	if err := key.SetStringValue("DisplayVersion", displayVersion); err != nil {
		t.Fatalf("set DisplayVersion: %v", err)
	}
	t.Cleanup(func() {
		_ = registry.DeleteKey(registry.CURRENT_USER, keyPath)
		_ = registry.DeleteKey(registry.CURRENT_USER, `Software\LingerTest`)
	})
	return keyPath
}

func readTestRegistryVersion(t *testing.T, keyPath string) string {
	t.Helper()
	key, err := registry.OpenKey(registry.CURRENT_USER, keyPath, registry.QUERY_VALUE)
	if err != nil {
		t.Fatalf("open test registry key: %v", err)
	}
	defer key.Close()
	v, _, err := key.GetStringValue("DisplayVersion")
	if err != nil {
		t.Fatalf("read DisplayVersion: %v", err)
	}
	return v
}

func strPtr(v string) *string { return &v }

func TestApplyHappyPathNestedWrapperAndRegistryUpdate(t *testing.T) {
	parent, installDir, wrapperDir, stagedDir := setupDirs(t, true)
	regKey := createTestRegistryKey(t, strPtr(installDir), "0.16.0")
	logDir := t.TempDir()
	logPath := filepath.Join(logDir, "update-apply-0.17.0.log")

	var relaunched []string
	deps := defaultApplyDeps()
	deps.relaunchFn = func(exePath string) error {
		relaunched = append(relaunched, exePath)
		return nil
	}

	err := apply(context.Background(), Request{
		InstallDir:  installDir,
		StagedDir:   stagedDir,
		Version:     "0.17.0",
		RegistryKey: regKey,
		LogPath:     logPath,
	}, deps)
	if err != nil {
		t.Fatalf("apply failed: %v", err)
	}

	gotExe, err := os.ReadFile(filepath.Join(installDir, "Linger.exe"))
	if err != nil || string(gotExe) != "new-linger" {
		t.Fatalf("expected new Linger.exe, got %q (err=%v)", string(gotExe), err)
	}
	gotUninstaller, err := os.ReadFile(filepath.Join(installDir, UninstallerFileName))
	if err != nil || string(gotUninstaller) != "nsis-uninstaller" {
		t.Fatalf("uninstaller not preserved: %q (err=%v)", string(gotUninstaller), err)
	}
	gotMarker, err := os.ReadFile(filepath.Join(installDir, StopMarkerRelPath))
	if err != nil || string(gotMarker) != "stop" {
		t.Fatalf("stop marker not preserved: %q (err=%v)", string(gotMarker), err)
	}

	if _, err := os.Lstat(wrapperDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected wrapper dir %s to be removed, err=%v", wrapperDir, err)
	}

	entries, err := os.ReadDir(parent)
	if err != nil {
		t.Fatal(err)
	}
	var oldDirs []string
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), oldDirPrefix) {
			oldDirs = append(oldDirs, entry.Name())
		}
	}
	if len(oldDirs) != 1 {
		t.Fatalf("expected 1 %s* folder, got %v", oldDirPrefix, oldDirs)
	}
	oldExe, err := os.ReadFile(filepath.Join(parent, oldDirs[0], "Linger.exe"))
	if err != nil || string(oldExe) != "old-linger" {
		t.Fatalf("expected old Linger.exe in backup dir, got %q (err=%v)", string(oldExe), err)
	}

	if got := readTestRegistryVersion(t, regKey); got != "0.17.0" {
		t.Fatalf("DisplayVersion = %q, want 0.17.0", got)
	}
	if len(relaunched) != 1 || relaunched[0] != filepath.Join(installDir, "Linger.exe") {
		t.Fatalf("relaunched = %v, want [%s]", relaunched, filepath.Join(installDir, "Linger.exe"))
	}
	logBytes, err := os.ReadFile(logPath)
	if err != nil || !strings.Contains(string(logBytes), "apply completed version=0.17.0") {
		t.Fatalf("expected diagnostic log in %s, got %q (err=%v)", logPath, string(logBytes), err)
	}
}

func TestApplyDirectSiblingLayoutAndSkipRegistry(t *testing.T) {
	_, installDir, _, stagedDir := setupDirs(t, false)
	err := Apply(context.Background(), Request{
		InstallDir:   installDir,
		StagedDir:    stagedDir,
		Version:      "0.17.0-rc.1",
		SkipRegistry: true,
		Relaunch:     boolPtr(false),
	})
	if err != nil {
		t.Fatalf("Apply direct sibling failed: %v", err)
	}
	gotExe, err := os.ReadFile(filepath.Join(installDir, "Linger.exe"))
	if err != nil || string(gotExe) != "new-linger" {
		t.Fatalf("expected new Linger.exe, got %q (err=%v)", string(gotExe), err)
	}
}

func TestWinUpdateHelperSleep(t *testing.T) {
	if os.Getenv("GO_WANT_WINUPDATE_SLEEP") != "1" {
		return
	}
	time.Sleep(400 * time.Millisecond)
	os.Exit(0)
}

func TestApplyWaitsForRealParentProcessExit(t *testing.T) {
	_, installDir, _, stagedDir := setupDirs(t, true)
	cmd := exec.Command(os.Args[0], "-test.run=^TestWinUpdateHelperSleep$")
	cmd.Env = append(os.Environ(), "GO_WANT_WINUPDATE_SLEEP=1")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start helper child: %v", err)
	}
	var waitOnce sync.Once
	reap := func() {
		waitOnce.Do(func() {
			_ = cmd.Wait()
		})
	}
	defer reap()

	started := time.Now()
	err := Apply(context.Background(), Request{
		ParentPID:    cmd.Process.Pid,
		InstallDir:   installDir,
		StagedDir:    stagedDir,
		Version:      "0.17.0",
		SkipRegistry: true,
		Relaunch:     boolPtr(false),
	})
	elapsed := time.Since(started)
	reap()

	if err != nil {
		t.Fatalf("Apply with ParentPID failed: %v", err)
	}
	if elapsed < 250*time.Millisecond {
		t.Fatalf("expected Apply to wait for child process exit, returned in %s", elapsed)
	}
}

func TestApplyRetriesThroughTemporaryFileLock(t *testing.T) {
	_, installDir, _, stagedDir := setupDirs(t, true)
	lockPath := filepath.Join(installDir, "locked.dat")
	if err := os.WriteFile(lockPath, []byte("locked"), 0o644); err != nil {
		t.Fatal(err)
	}
	// An open file handle inside installDir prevents renaming installDir on Windows.
	held, err := os.Open(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	released := make(chan struct{})
	go func() {
		time.Sleep(400 * time.Millisecond)
		_ = held.Close()
		close(released)
	}()
	defer func() {
		<-released
	}()

	deps := defaultApplyDeps()
	deps.retryInterval = 50 * time.Millisecond
	deps.rename1Timeout = 5 * time.Second
	deps.relaunchFn = func(string) error { return nil }

	started := time.Now()
	err = apply(context.Background(), Request{
		InstallDir:   installDir,
		StagedDir:    stagedDir,
		Version:      "0.17.0",
		SkipRegistry: true,
		Relaunch:     boolPtr(false),
	}, deps)
	elapsed := time.Since(started)

	if err != nil {
		t.Fatalf("expected retry through temporary lock to succeed, got: %v", err)
	}
	if elapsed < 300*time.Millisecond {
		t.Fatalf("expected rename retry to wait until lock released, elapsed=%s", elapsed)
	}
	gotExe, err := os.ReadFile(filepath.Join(installDir, "Linger.exe"))
	if err != nil || string(gotExe) != "new-linger" {
		t.Fatalf("expected new Linger.exe after retry, got %q (err=%v)", string(gotExe), err)
	}
}

func TestApplyRollsBackWhenPromoteFails(t *testing.T) {
	parent, installDir, _, stagedDir := setupDirs(t, true)
	var relaunched []string
	deps := defaultApplyDeps()
	deps.rename2Timeout = 100 * time.Millisecond
	deps.retryInterval = 25 * time.Millisecond
	deps.relaunchFn = func(exePath string) error {
		relaunched = append(relaunched, exePath)
		return nil
	}
	deps.renameFn = func(from, to string) error {
		if strings.EqualFold(from, stagedDir) && strings.EqualFold(to, installDir) {
			return errors.New("simulated promote failure")
		}
		return os.Rename(from, to)
	}

	err := apply(context.Background(), Request{
		InstallDir:   installDir,
		StagedDir:    stagedDir,
		Version:      "0.17.0",
		SkipRegistry: true,
	}, deps)
	if err == nil || !strings.Contains(err.Error(), "simulated promote failure") {
		t.Fatalf("expected promote failure, got %v", err)
	}

	gotExe, readErr := os.ReadFile(filepath.Join(installDir, "Linger.exe"))
	if readErr != nil || string(gotExe) != "old-linger" {
		t.Fatalf("expected rolled back old Linger.exe, got %q (err=%v)", string(gotExe), readErr)
	}
	entries, err := os.ReadDir(parent)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), oldDirPrefix) {
			t.Fatalf("backup dir %s should have been rolled back", entry.Name())
		}
	}
	if len(relaunched) != 1 || relaunched[0] != filepath.Join(installDir, "Linger.exe") {
		t.Fatalf("expected relaunch of restored app, got %v", relaunched)
	}
}

func TestApplyRelaunchesExistingWhenMoveAsideFails(t *testing.T) {
	_, installDir, _, stagedDir := setupDirs(t, true)
	var relaunched []string
	deps := defaultApplyDeps()
	deps.rename1Timeout = 100 * time.Millisecond
	deps.retryInterval = 25 * time.Millisecond
	deps.relaunchFn = func(exePath string) error {
		relaunched = append(relaunched, exePath)
		return nil
	}
	deps.renameFn = func(from, to string) error {
		return errors.New("simulated lock")
	}

	err := apply(context.Background(), Request{
		InstallDir:   installDir,
		StagedDir:    stagedDir,
		Version:      "0.17.0",
		SkipRegistry: true,
	}, deps)
	if err == nil || !strings.Contains(err.Error(), "simulated lock") {
		t.Fatalf("expected move-aside error, got %v", err)
	}
	gotExe, readErr := os.ReadFile(filepath.Join(installDir, "Linger.exe"))
	if readErr != nil || string(gotExe) != "old-linger" {
		t.Fatalf("installDir should remain untouched, got %q (err=%v)", string(gotExe), readErr)
	}
	if len(relaunched) != 1 || relaunched[0] != filepath.Join(installDir, "Linger.exe") {
		t.Fatalf("expected relaunch of existing app, got %v", relaunched)
	}
}

func TestApplyRegistryGuards(t *testing.T) {
	t.Run("updates DisplayVersion when InstallLocation has trailing backslash, mixed case, and quotes", func(t *testing.T) {
		_, installDir, _, stagedDir := setupDirs(t, true)
		formatted := fmt.Sprintf(` "%s\" `, strings.ToUpper(installDir))
		regKey := createTestRegistryKey(t, strPtr(formatted), "0.16.0")

		err := Apply(context.Background(), Request{
			InstallDir:  installDir,
			StagedDir:   stagedDir,
			Version:     "0.17.0",
			RegistryKey: regKey,
			Relaunch:    boolPtr(false),
		})
		if err != nil {
			t.Fatalf("Apply failed: %v", err)
		}
		if got := readTestRegistryVersion(t, regKey); got != "0.17.0" {
			t.Fatalf("DisplayVersion = %q, want 0.17.0", got)
		}
	})

	t.Run("does not overwrite DisplayVersion when InstallLocation is missing or empty", func(t *testing.T) {
		for _, tc := range []struct {
			name     string
			location *string
		}{
			{name: "missing", location: nil},
			{name: "empty", location: strPtr("")},
			{name: "whitespace_and_quotes", location: strPtr(`  ""  `)},
		} {
			t.Run(tc.name, func(t *testing.T) {
				_, installDir, _, stagedDir := setupDirs(t, true)
				regKey := createTestRegistryKey(t, tc.location, "0.16.0")

				err := Apply(context.Background(), Request{
					InstallDir:  installDir,
					StagedDir:   stagedDir,
					Version:     "0.17.0",
					RegistryKey: regKey,
					Relaunch:    boolPtr(false),
				})
				if err != nil {
					t.Fatalf("Apply failed: %v", err)
				}
				if got := readTestRegistryVersion(t, regKey); got != "0.16.0" {
					t.Fatalf("DisplayVersion was overwritten with %s InstallLocation: got %q", tc.name, got)
				}
			})
		}
	})

	t.Run("does not overwrite DisplayVersion when InstallLocation mismatches", func(t *testing.T) {
		_, installDir, _, stagedDir := setupDirs(t, true)
		otherLocation := filepath.Join(t.TempDir(), "OtherInstall")
		regKey := createTestRegistryKey(t, strPtr(otherLocation), "0.16.0")

		err := Apply(context.Background(), Request{
			InstallDir:  installDir,
			StagedDir:   stagedDir,
			Version:     "0.17.0",
			RegistryKey: regKey,
			Relaunch:    boolPtr(false),
		})
		if err != nil {
			t.Fatalf("Apply failed: %v", err)
		}
		if got := readTestRegistryVersion(t, regKey); got != "0.16.0" {
			t.Fatalf("DisplayVersion was overwritten despite InstallLocation mismatch: got %q", got)
		}
	})

	t.Run("does not create a missing registry key", func(t *testing.T) {
		_, installDir, _, stagedDir := setupDirs(t, true)
		missingKey := fmt.Sprintf(`Software\LingerTest\Missing-%s`, uuid.NewString())
		t.Cleanup(func() {
			_ = registry.DeleteKey(registry.CURRENT_USER, missingKey)
			_ = registry.DeleteKey(registry.CURRENT_USER, `Software\LingerTest`)
		})

		err := Apply(context.Background(), Request{
			InstallDir:  installDir,
			StagedDir:   stagedDir,
			Version:     "0.17.0",
			RegistryKey: missingKey,
			Relaunch:    boolPtr(false),
		})
		if err != nil {
			t.Fatalf("Apply failed: %v", err)
		}
		key, openErr := registry.OpenKey(registry.CURRENT_USER, missingKey, registry.QUERY_VALUE)
		if openErr == nil {
			_ = key.Close()
			t.Fatalf("expected missing key %s not to be created", missingKey)
		}
	})
}

func TestApplyPreserveMetadataFailureRelaunchesExistingApp(t *testing.T) {
	_, installDir, _, stagedDir := setupDirs(t, true)
	// Replace Uninstall Linger.exe with a directory so preserving it fails closed.
	uninstaller := filepath.Join(installDir, UninstallerFileName)
	if err := os.Remove(uninstaller); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(uninstaller, 0o755); err != nil {
		t.Fatal(err)
	}

	var relaunched []string
	deps := defaultApplyDeps()
	deps.preserveTimeout = 100 * time.Millisecond
	deps.retryInterval = 25 * time.Millisecond
	deps.relaunchFn = func(exePath string) error {
		relaunched = append(relaunched, exePath)
		return nil
	}

	err := apply(context.Background(), Request{
		InstallDir:   installDir,
		StagedDir:    stagedDir,
		Version:      "0.17.0",
		SkipRegistry: true,
	}, deps)
	if err == nil || !strings.Contains(err.Error(), "preserve metadata") {
		t.Fatalf("expected preserve metadata failure, got %v", err)
	}
	gotExe, readErr := os.ReadFile(filepath.Join(installDir, "Linger.exe"))
	if readErr != nil || string(gotExe) != "old-linger" {
		t.Fatalf("installDir should remain intact after metadata failure, got %q (err=%v)", string(gotExe), readErr)
	}
	if len(relaunched) != 1 || relaunched[0] != filepath.Join(installDir, "Linger.exe") {
		t.Fatalf("expected relaunch of existing app, got %v", relaunched)
	}
}

func TestApplySecurityRejections(t *testing.T) {
	t.Run("rejects UNC, relative, root, wrong parent, nested overlap, missing exe, bad version, and unsafe logPath", func(t *testing.T) {
		_, installDir, wrapperDir, stagedDir := setupDirs(t, true)
		wrongParent := filepath.Join(t.TempDir(), "Elsewhere", ".Linger-update-0.17.0", "Linger")
		if err := os.MkdirAll(wrongParent, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(wrongParent, "Linger.exe"), []byte("x"), 0o755); err != nil {
			t.Fatal(err)
		}

		noPrefixStaged := filepath.Join(filepath.Dir(installDir), "OtherStage")
		if err := os.MkdirAll(noPrefixStaged, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(noPrefixStaged, "Linger.exe"), []byte("x"), 0o755); err != nil {
			t.Fatal(err)
		}

		missingExeStage := filepath.Join(filepath.Dir(installDir), ".Linger-update-0.18.0", "Linger")
		if err := os.MkdirAll(missingExeStage, 0o755); err != nil {
			t.Fatal(err)
		}

		stagedInsideInstall := filepath.Join(installDir, ".Linger-update-0.19.0")
		if err := os.MkdirAll(stagedInsideInstall, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(stagedInsideInstall, "Linger.exe"), []byte("x"), 0o755); err != nil {
			t.Fatal(err)
		}

		missingInstallExeParent := filepath.Join(t.TempDir(), "MissingInstallExe")
		missingInstallExeDir := filepath.Join(missingInstallExeParent, "Linger")
		missingInstallExeStaged := filepath.Join(missingInstallExeParent, ".Linger-update-0.17.0", "Linger")
		if err := os.MkdirAll(missingInstallExeDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(missingInstallExeStaged, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(missingInstallExeStaged, "Linger.exe"), []byte("new"), 0o755); err != nil {
			t.Fatal(err)
		}

		cases := []struct {
			name string
			req  Request
		}{
			{
				name: "UNC installDir",
				req: Request{
					InstallDir: `\\server\share\Linger`,
					StagedDir:  `\\server\share\.Linger-update-0.17.0\Linger`,
					Version:    "0.17.0",
				},
			},
			{
				name: "relative path",
				req: Request{
					InstallDir: `Linger`,
					StagedDir:  `.Linger-update-0.17.0\Linger`,
					Version:    "0.17.0",
				},
			},
			{
				name: "wrong parent",
				req: Request{
					InstallDir: installDir,
					StagedDir:  wrongParent,
					Version:    "0.17.0",
				},
			},
			{
				name: "stagedDir inside installDir",
				req: Request{
					InstallDir: installDir,
					StagedDir:  stagedInsideInstall,
					Version:    "0.19.0",
				},
			},
			{
				name: "missing staged prefix",
				req: Request{
					InstallDir: installDir,
					StagedDir:  noPrefixStaged,
					Version:    "0.17.0",
				},
			},
			{
				name: "missing installDir Linger.exe",
				req: Request{
					InstallDir: missingInstallExeDir,
					StagedDir:  missingInstallExeStaged,
					Version:    "0.17.0",
				},
			},
			{
				name: "missing Linger.exe",
				req: Request{
					InstallDir: installDir,
					StagedDir:  missingExeStage,
					Version:    "0.18.0",
				},
			},
			{
				name: "invalid version",
				req: Request{
					InstallDir: installDir,
					StagedDir:  stagedDir,
					Version:    "0.17",
				},
			},
			{
				name: "version with whitespace",
				req: Request{
					InstallDir: installDir,
					StagedDir:  stagedDir,
					Version:    "0.17.0;evil",
				},
			},
			{
				name: "logPath inside installDir",
				req: Request{
					InstallDir: installDir,
					StagedDir:  stagedDir,
					Version:    "0.17.0",
					LogPath:    filepath.Join(installDir, "apply.log"),
				},
			},
			{
				name: "logPath inside stagedDir",
				req: Request{
					InstallDir: installDir,
					StagedDir:  stagedDir,
					Version:    "0.17.0",
					LogPath:    filepath.Join(stagedDir, "apply.log"),
				},
			},
			{
				name: "logPath inside wrapperDir",
				req: Request{
					InstallDir: installDir,
					StagedDir:  stagedDir,
					Version:    "0.17.0",
					LogPath:    filepath.Join(wrapperDir, "apply.log"),
				},
			},
		}

		for _, tc := range cases {
			tc.req.SkipRegistry = true
			tc.req.Relaunch = boolPtr(false)
			if err := Apply(context.Background(), tc.req); err == nil {
				t.Errorf("%s: expected rejection, got nil", tc.name)
			}
		}

		// Verify installDir was never mutated by any rejected request.
		gotExe, err := os.ReadFile(filepath.Join(installDir, "Linger.exe"))
		if err != nil || string(gotExe) != "old-linger" {
			t.Fatalf("installDir mutated after rejections: %q (err=%v)", string(gotExe), err)
		}
	})

	t.Run("rejects NTFS directory junctions on installDir, stagedDir, and wrapperDir", func(t *testing.T) {
		mkJunction := func(link, target string) {
			t.Helper()
			out, err := exec.Command("cmd.exe", "/c", "mklink", "/J", link, target).CombinedOutput()
			if err != nil {
				t.Fatalf("mklink /J %s -> %s failed: %v (%s)", link, target, err, string(out))
			}
		}

		// 1. Junction at installDir.
		root1 := filepath.Join(t.TempDir(), "Programs")
		realTarget1 := filepath.Join(t.TempDir(), "RealInstall")
		if err := os.MkdirAll(root1, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(realTarget1, 0o755); err != nil {
			t.Fatal(err)
		}
		jInstall := filepath.Join(root1, "Linger")
		mkJunction(jInstall, realTarget1)
		s1 := filepath.Join(root1, ".Linger-update-0.17.0", "Linger")
		if err := os.MkdirAll(s1, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(s1, "Linger.exe"), []byte("new"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := Apply(context.Background(), Request{
			InstallDir:   jInstall,
			StagedDir:    s1,
			Version:      "0.17.0",
			SkipRegistry: true,
			Relaunch:     boolPtr(false),
		}); err == nil || !strings.Contains(err.Error(), "reparse") {
			t.Fatalf("expected reparse error for junction installDir, got %v", err)
		}

		// 2. Junction at stagedDir.
		parent2, install2, _, _ := setupDirs(t, false)
		realStaged2 := filepath.Join(t.TempDir(), "RealStaged")
		if err := os.MkdirAll(realStaged2, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(realStaged2, "Linger.exe"), []byte("new"), 0o755); err != nil {
			t.Fatal(err)
		}
		jStaged := filepath.Join(parent2, ".Linger-update-0.17.1")
		mkJunction(jStaged, realStaged2)
		if err := Apply(context.Background(), Request{
			InstallDir:   install2,
			StagedDir:    jStaged,
			Version:      "0.17.1",
			SkipRegistry: true,
			Relaunch:     boolPtr(false),
		}); err == nil || !strings.Contains(err.Error(), "reparse") {
			t.Fatalf("expected reparse error for junction stagedDir, got %v", err)
		}

		// 3. Junction at wrapperDir.
		parent3, install3, _, _ := setupDirs(t, false)
		realWrapper3 := filepath.Join(t.TempDir(), "RealWrapper")
		if err := os.MkdirAll(filepath.Join(realWrapper3, "Linger"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(realWrapper3, "Linger", "Linger.exe"), []byte("new"), 0o755); err != nil {
			t.Fatal(err)
		}
		jWrapper := filepath.Join(parent3, ".Linger-update-0.17.2")
		mkJunction(jWrapper, realWrapper3)
		if err := Apply(context.Background(), Request{
			InstallDir:   install3,
			StagedDir:    filepath.Join(jWrapper, "Linger"),
			Version:      "0.17.2",
			SkipRegistry: true,
			Relaunch:     boolPtr(false),
		}); err == nil || !strings.Contains(err.Error(), "reparse") {
			t.Fatalf("expected reparse error for junction wrapperDir, got %v", err)
		}
	})
}

func TestApplyConfigFileRemovesFileAndRejectsUnknownFields(t *testing.T) {
	_, installDir, _, stagedDir := setupDirs(t, true)
	cfgDir := t.TempDir()

	// Unknown JSON field rejected and config file cleaned up.
	badCfg := filepath.Join(cfgDir, "bad.json")
	if err := os.WriteFile(badCfg, []byte(`{"installDir":"C:\\x","unknownField":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ApplyConfigFile(context.Background(), badCfg); err == nil {
		t.Fatal("expected ApplyConfigFile to reject unknown field")
	}
	if _, err := os.Lstat(badCfg); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected bad config file to be removed, err=%v", err)
	}

	// Valid JSON config applies update and removes config file.
	goodCfg := filepath.Join(cfgDir, "good.json")
	payload, err := json.Marshal(Request{
		InstallDir:   installDir,
		StagedDir:    stagedDir,
		Version:      "0.17.0",
		SkipRegistry: true,
		Relaunch:     boolPtr(false),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(goodCfg, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ApplyConfigFile(context.Background(), goodCfg); err != nil {
		t.Fatalf("ApplyConfigFile failed: %v", err)
	}
	if _, err := os.Lstat(goodCfg); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected good config file to be removed, err=%v", err)
	}
	gotExe, err := os.ReadFile(filepath.Join(installDir, "Linger.exe"))
	if err != nil || string(gotExe) != "new-linger" {
		t.Fatalf("expected swapped Linger.exe, got %q (err=%v)", string(gotExe), err)
	}
}
