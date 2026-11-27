package workspace

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func antigravityTestIdentity() RuntimeHomeIdentity {
	return RuntimeHomeIdentity{
		TenantID:     "tenant-1",
		OwnerActorID: "owner-1",
		AgentID:      "agent-1",
		ScopeID:      "context-1",
		ProviderType: "antigravity",
	}
}

func TestAntigravityRuntimeHomeSeedsAndPreservesRefreshedToken(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime-homes")
	userHome := t.TempDir()
	sourceDir := filepath.Join(userHome, ".gemini", "antigravity-cli")
	if err := os.MkdirAll(sourceDir, 0o700); err != nil {
		t.Fatal(err)
	}
	sourceTokenPath := filepath.Join(sourceDir, antigravityOAuthTokenFile)
	sourceSettingsPath := filepath.Join(sourceDir, antigravitySettingsFile)
	if err := os.WriteFile(sourceTokenPath, []byte("initial-oauth-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sourceSettingsPath, []byte(`{"theme":"dark"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"HOME": userHome}
	identity := antigravityTestIdentity()

	retires := 0
	var retiredHomes []string
	retire := func(home string) error {
		retires++
		retiredHomes = append(retiredHomes, home)
		return nil
	}

	home, err := PrepareAntigravityRuntimeHome(context.Background(), root, env, identity, retire)
	if err != nil {
		t.Fatal(err)
	}
	homePath := home.Path
	if retires != 1 || len(retiredHomes) != 1 || retiredHomes[0] != homePath {
		t.Fatalf("first prepare retires=%d homes=%v, want 1 (%q)", retires, retiredHomes, homePath)
	}
	destAppData := AntigravityAppDataDir(homePath)
	if AntigravityGeminiDir(homePath) != filepath.Join(homePath, "gemini") ||
		destAppData != filepath.Join(homePath, "gemini", "antigravity-cli") ||
		AntigravityACPLogPath(homePath) != filepath.Join(homePath, "acp.log") {
		t.Fatalf("unexpected Antigravity path helpers for %q", homePath)
	}
	gotToken, err := os.ReadFile(filepath.Join(destAppData, antigravityOAuthTokenFile))
	if err != nil || string(gotToken) != "initial-oauth-token" {
		t.Fatalf("seeded token = %q err=%v", gotToken, err)
	}
	gotSettings, err := os.ReadFile(filepath.Join(destAppData, antigravitySettingsFile))
	if err != nil || string(gotSettings) != `{"theme":"dark"}` {
		t.Fatalf("seeded settings = %q err=%v", gotSettings, err)
	}

	// Simulate an in-home OAuth token refresh written by agy; user home stays untouched.
	if err := os.WriteFile(filepath.Join(destAppData, antigravityOAuthTokenFile), []byte("refreshed-in-home-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := home.Close(); err != nil {
		t.Fatal(err)
	}

	// Repeated prepare with unchanged source keeps the refreshed token and never retires.
	retires = 0
	home, err = PrepareAntigravityRuntimeHome(context.Background(), root, env, identity, retire)
	if err != nil {
		t.Fatal(err)
	}
	if retires != 0 {
		t.Fatalf("unchanged source retired %d times, want 0", retires)
	}
	gotToken, err = os.ReadFile(filepath.Join(destAppData, antigravityOAuthTokenFile))
	if err != nil || string(gotToken) != "refreshed-in-home-token" {
		t.Fatalf("refreshed token was overwritten: %q err=%v", gotToken, err)
	}
	userToken, err := os.ReadFile(sourceTokenPath)
	if err != nil || string(userToken) != "initial-oauth-token" {
		t.Fatalf("user source token was altered: %q err=%v", userToken, err)
	}
	if err := home.Close(); err != nil {
		t.Fatal(err)
	}

	// Changing user source token retires once and replaces destination.
	if err := os.WriteFile(sourceTokenPath, []byte("new-account-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	retires = 0
	home, err = PrepareAntigravityRuntimeHome(context.Background(), root, env, identity, retire)
	if err != nil {
		t.Fatal(err)
	}
	if retires != 1 {
		t.Fatalf("changed token retired %d times, want 1", retires)
	}
	gotToken, err = os.ReadFile(filepath.Join(destAppData, antigravityOAuthTokenFile))
	if err != nil || string(gotToken) != "new-account-token" {
		t.Fatalf("updated token = %q err=%v", gotToken, err)
	}
	if err := home.Close(); err != nil {
		t.Fatal(err)
	}

	// Deleting user source token retires once and removes destination.
	if err := os.Remove(sourceTokenPath); err != nil {
		t.Fatal(err)
	}
	retires = 0
	home, err = PrepareAntigravityRuntimeHome(context.Background(), root, env, identity, retire)
	if err != nil {
		t.Fatal(err)
	}
	if retires != 1 {
		t.Fatalf("removed token retired %d times, want 1", retires)
	}
	if _, err := os.Lstat(filepath.Join(destAppData, antigravityOAuthTokenFile)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("deleted source token survived in isolated home: err=%v", err)
	}
	if err := home.Close(); err != nil {
		t.Fatal(err)
	}

	// Preparing again while still absent does not retire or recreate the token.
	retires = 0
	home, err = PrepareAntigravityRuntimeHome(context.Background(), root, env, identity, retire)
	if err != nil {
		t.Fatal(err)
	}
	if retires != 0 {
		t.Fatalf("steady absent token retired %d times, want 0", retires)
	}
	if err := home.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestAntigravityRuntimeHomeAbortsWithoutMutatingWhenRetireFails(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime-homes")
	userHome := t.TempDir()
	sourceDir := filepath.Join(userHome, ".gemini", "antigravity-cli")
	if err := os.MkdirAll(sourceDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceDir, antigravityOAuthTokenFile), []byte("token-v1"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceDir, antigravitySettingsFile), []byte(`{"v":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"HOME": userHome}
	identity := antigravityTestIdentity()

	home, err := PrepareAntigravityRuntimeHome(context.Background(), root, env, identity, nil)
	if err != nil {
		t.Fatal(err)
	}
	destAppData := AntigravityAppDataDir(home.Path)
	if err := home.Close(); err != nil {
		t.Fatal(err)
	}

	// Change both files in user source, then fail retireResident.
	if err := os.WriteFile(filepath.Join(sourceDir, antigravityOAuthTokenFile), []byte("token-v2"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceDir, antigravitySettingsFile), []byte(`{"v":2}`), 0o600); err != nil {
		t.Fatal(err)
	}
	retireErr := errors.New("resident exit unconfirmed")
	if _, err := PrepareAntigravityRuntimeHome(context.Background(), root, env, identity, func(string) error {
		return retireErr
	}); !errors.Is(err, retireErr) {
		t.Fatalf("err = %v, want %v", err, retireErr)
	}

	// Isolated files must remain untouched while the live resident could not be stopped.
	gotToken, err := os.ReadFile(filepath.Join(destAppData, antigravityOAuthTokenFile))
	if err != nil || string(gotToken) != "token-v1" {
		t.Fatalf("token mutated after retire error: %q err=%v", gotToken, err)
	}
	gotSettings, err := os.ReadFile(filepath.Join(destAppData, antigravitySettingsFile))
	if err != nil || string(gotSettings) != `{"v":1}` {
		t.Fatalf("settings mutated after retire error: %q err=%v", gotSettings, err)
	}
}

func TestAntigravityRuntimeHomeSyncsSettingsChangesAndDeletions(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime-homes")
	userHome := t.TempDir()
	sourceDir := filepath.Join(userHome, ".gemini", "antigravity-cli")
	if err := os.MkdirAll(sourceDir, 0o700); err != nil {
		t.Fatal(err)
	}
	settingsSrc := filepath.Join(sourceDir, antigravitySettingsFile)
	if err := os.WriteFile(settingsSrc, []byte(`{"model":"a"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"HOME": userHome}
	identity := antigravityTestIdentity()

	retires := 0
	retire := func(string) error {
		retires++
		return nil
	}

	home, err := PrepareAntigravityRuntimeHome(context.Background(), root, env, identity, retire)
	if err != nil {
		t.Fatal(err)
	}
	destSettings := filepath.Join(AntigravityAppDataDir(home.Path), antigravitySettingsFile)
	if retires != 1 {
		t.Fatalf("initial settings retires = %d, want 1", retires)
	}
	if err := home.Close(); err != nil {
		t.Fatal(err)
	}

	// Unchanged settings skip writes and retirement.
	retires = 0
	home, err = PrepareAntigravityRuntimeHome(context.Background(), root, env, identity, retire)
	if err != nil {
		t.Fatal(err)
	}
	if retires != 0 {
		t.Fatalf("unchanged settings retires = %d, want 0", retires)
	}
	if err := home.Close(); err != nil {
		t.Fatal(err)
	}

	// Modified settings retire once and update destination.
	if err := os.WriteFile(settingsSrc, []byte(`{"model":"b"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	retires = 0
	home, err = PrepareAntigravityRuntimeHome(context.Background(), root, env, identity, retire)
	if err != nil {
		t.Fatal(err)
	}
	if retires != 1 {
		t.Fatalf("modified settings retires = %d, want 1", retires)
	}
	got, err := os.ReadFile(destSettings)
	if err != nil || string(got) != `{"model":"b"}` {
		t.Fatalf("settings = %q err=%v", got, err)
	}
	if err := home.Close(); err != nil {
		t.Fatal(err)
	}

	// Deleted settings retire once and remove destination.
	if err := os.Remove(settingsSrc); err != nil {
		t.Fatal(err)
	}
	retires = 0
	home, err = PrepareAntigravityRuntimeHome(context.Background(), root, env, identity, retire)
	if err != nil {
		t.Fatal(err)
	}
	if retires != 1 {
		t.Fatalf("deleted settings retires = %d, want 1", retires)
	}
	if _, err := os.Lstat(destSettings); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("deleted settings survived: err=%v", err)
	}
	if err := home.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestAntigravityRuntimeHomeWorksWithoutUserGeminiDir(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime-homes")
	userHome := t.TempDir()
	env := map[string]string{"USERPROFILE": userHome}
	identity := antigravityTestIdentity()

	retires := 0
	home, err := PrepareAntigravityRuntimeHome(context.Background(), root, env, identity, func(string) error {
		retires++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer home.Close()
	if retires != 0 {
		t.Fatalf("absent user dir retired %d times, want 0", retires)
	}
	if _, err := os.Stat(filepath.Join(userHome, ".gemini")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("prepare must not create user .gemini dir: err=%v", err)
	}
	if info, err := os.Stat(AntigravityAppDataDir(home.Path)); err != nil || !info.IsDir() {
		t.Fatalf("isolated appDataDir missing: %v %v", info, err)
	}
}

func TestAntigravityRuntimeHomeEmptySourceTokenDoesNotChurn(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime-homes")
	userHome := t.TempDir()
	sourceDir := filepath.Join(userHome, ".gemini", "antigravity-cli")
	if err := os.MkdirAll(sourceDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceDir, antigravityOAuthTokenFile), []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"HOME": userHome}
	identity := antigravityTestIdentity()

	retires := 0
	retire := func(string) error {
		retires++
		return nil
	}

	home, err := PrepareAntigravityRuntimeHome(context.Background(), root, env, identity, retire)
	if err != nil {
		t.Fatal(err)
	}
	destToken := filepath.Join(AntigravityAppDataDir(home.Path), antigravityOAuthTokenFile)
	data, err := os.ReadFile(destToken)
	if err != nil || len(data) != 0 {
		t.Fatalf("empty token seed = %q err=%v", data, err)
	}
	if retires != 1 {
		t.Fatalf("initial empty token seed retires = %d, want 1", retires)
	}
	if err := home.Close(); err != nil {
		t.Fatal(err)
	}

	retires = 0
	home, err = PrepareAntigravityRuntimeHome(context.Background(), root, env, identity, retire)
	if err != nil {
		t.Fatal(err)
	}
	if retires != 0 {
		t.Fatalf("repeated empty token prepare retired %d times, want 0", retires)
	}
	if err := home.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestAntigravityRuntimeHomeRejectsUnsafePathsAndSeedFiles(t *testing.T) {
	t.Run("oversized_seed_file", func(t *testing.T) {
		root := filepath.Join(t.TempDir(), "runtime-homes")
		userHome := t.TempDir()
		sourceDir := filepath.Join(userHome, ".gemini", "antigravity-cli")
		if err := os.MkdirAll(sourceDir, 0o700); err != nil {
			t.Fatal(err)
		}
		oversized := bytes.Repeat([]byte("a"), antigravitySeedFileLimit+1)
		if err := os.WriteFile(filepath.Join(sourceDir, antigravitySettingsFile), oversized, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := PrepareAntigravityRuntimeHome(context.Background(), root, map[string]string{"HOME": userHome}, antigravityTestIdentity(), nil); err == nil {
			t.Fatal("oversized seed file was accepted")
		}
	})

	t.Run("non_regular_seed_file", func(t *testing.T) {
		root := filepath.Join(t.TempDir(), "runtime-homes")
		userHome := t.TempDir()
		sourceDir := filepath.Join(userHome, ".gemini", "antigravity-cli")
		if err := os.MkdirAll(filepath.Join(sourceDir, antigravityOAuthTokenFile), 0o700); err != nil {
			t.Fatal(err)
		}
		if _, err := PrepareAntigravityRuntimeHome(context.Background(), root, map[string]string{"HOME": userHome}, antigravityTestIdentity(), nil); err == nil {
			t.Fatal("directory seed file was accepted")
		}
	})

	t.Run("acp_log_directory", func(t *testing.T) {
		root := filepath.Join(t.TempDir(), "runtime-homes")
		userHome := t.TempDir()
		identity := antigravityTestIdentity()
		homePath, err := RuntimeHomePath(root, identity)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(AntigravityACPLogPath(homePath), 0o700); err != nil {
			t.Fatal(err)
		}
		if _, err := PrepareAntigravityRuntimeHome(context.Background(), root, map[string]string{"HOME": userHome}, identity, nil); err == nil {
			t.Fatal("directory acp.log was accepted")
		}
	})

	t.Run("symlinks_inside_runtime_home", func(t *testing.T) {
		outside := t.TempDir()
		outsideFile := filepath.Join(outside, "target.log")
		if err := os.WriteFile(outsideFile, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}

		for _, tc := range []struct {
			name  string
			setup func(homePath string) error
		}{
			{
				name: "acp_log_symlink",
				setup: func(homePath string) error {
					if err := os.MkdirAll(homePath, 0o700); err != nil {
						return err
					}
					return os.Symlink(outsideFile, AntigravityACPLogPath(homePath))
				},
			},
			{
				name: "gemini_dir_symlink",
				setup: func(homePath string) error {
					if err := os.MkdirAll(homePath, 0o700); err != nil {
						return err
					}
					return createTestDirectoryLink(outside, AntigravityGeminiDir(homePath))
				},
			},
			{
				name: "app_data_dir_symlink",
				setup: func(homePath string) error {
					if err := os.MkdirAll(AntigravityGeminiDir(homePath), 0o700); err != nil {
						return err
					}
					return createTestDirectoryLink(outside, AntigravityAppDataDir(homePath))
				},
			},
		} {
			t.Run(tc.name, func(t *testing.T) {
				root := filepath.Join(t.TempDir(), "runtime-homes")
				userHome := t.TempDir()
				identity := antigravityTestIdentity()
				homePath, err := RuntimeHomePath(root, identity)
				if err != nil {
					t.Fatal(err)
				}
				if err := tc.setup(homePath); err != nil {
					if runtime.GOOS == "windows" {
						t.Skipf("symlink unavailable on Windows: %v", err)
					}
					t.Fatal(err)
				}
				if _, err := PrepareAntigravityRuntimeHome(context.Background(), root, map[string]string{"HOME": userHome}, identity, nil); err == nil {
					t.Fatalf("%s was accepted", tc.name)
				}
			})
		}
	})
}

func TestAntigravityUserAppDataDir(t *testing.T) {
	home := filepath.Join(t.TempDir(), "user-home")
	userProfile := filepath.Join(t.TempDir(), "user-profile")

	if got := AntigravityUserAppDataDir(map[string]string{"HOME": "  " + home + "  ", "USERPROFILE": userProfile}); got != filepath.Join(home, ".gemini", "antigravity-cli") {
		t.Fatalf("HOME dir = %q, want %q", got, filepath.Join(home, ".gemini", "antigravity-cli"))
	}
	if got := AntigravityUserAppDataDir(map[string]string{"HOME": "   ", "USERPROFILE": " " + userProfile + " "}); got != filepath.Join(userProfile, ".gemini", "antigravity-cli") {
		t.Fatalf("USERPROFILE fallback = %q, want %q", got, filepath.Join(userProfile, ".gemini", "antigravity-cli"))
	}
	if got := AntigravityUserAppDataDir(map[string]string{"UserProfile": " " + userProfile + " "}); got != filepath.Join(userProfile, ".gemini", "antigravity-cli") {
		t.Fatalf("case-insensitive UserProfile = %q, want %q", got, filepath.Join(userProfile, ".gemini", "antigravity-cli"))
	}
	if got := AntigravityUserAppDataDir(map[string]string{"Home": home, "UserProfile": userProfile}); got != filepath.Join(home, ".gemini", "antigravity-cli") {
		t.Fatalf("case-insensitive Home precedence = %q, want %q", got, filepath.Join(home, ".gemini", "antigravity-cli"))
	}
	if got := AntigravityUserAppDataDir(map[string]string{"HOME": home, "Home": userProfile}); got != filepath.Join(home, ".gemini", "antigravity-cli") {
		t.Fatalf("exact HOME precedence = %q, want %q", got, filepath.Join(home, ".gemini", "antigravity-cli"))
	}
	if got := AntigravityUserAppDataDir(map[string]string{"HOME": " ", "USERPROFILE": ""}); got != "" {
		t.Fatalf("empty env = %q, want empty", got)
	}
}

func TestSeedAntigravityAppDataDir(t *testing.T) {
	t.Run("copies_present_and_skips_missing", func(t *testing.T) {
		userHome := t.TempDir()
		sourceDir := AntigravityUserAppDataDir(map[string]string{"HOME": userHome})
		if err := os.MkdirAll(sourceDir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(sourceDir, antigravityOAuthTokenFile), []byte("oauth-seed"), 0o600); err != nil {
			t.Fatal(err)
		}

		destDir := filepath.Join(t.TempDir(), "probe", "gemini", "antigravity-cli")
		if err := SeedAntigravityAppDataDir(destDir, map[string]string{"HOME": userHome}); err != nil {
			t.Fatal(err)
		}
		gotToken, err := os.ReadFile(filepath.Join(destDir, antigravityOAuthTokenFile))
		if err != nil || string(gotToken) != "oauth-seed" {
			t.Fatalf("seeded token = %q err=%v", gotToken, err)
		}
		if _, err := os.Lstat(filepath.Join(destDir, antigravitySettingsFile)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("missing settings file should be skipped, err=%v", err)
		}
	})

	t.Run("rejects_oversized_seed_file", func(t *testing.T) {
		userHome := t.TempDir()
		sourceDir := AntigravityUserAppDataDir(map[string]string{"HOME": userHome})
		if err := os.MkdirAll(sourceDir, 0o700); err != nil {
			t.Fatal(err)
		}
		oversized := bytes.Repeat([]byte("a"), antigravitySeedFileLimit+1)
		if err := os.WriteFile(filepath.Join(sourceDir, antigravitySettingsFile), oversized, 0o600); err != nil {
			t.Fatal(err)
		}
		destDir := filepath.Join(t.TempDir(), "app-data")
		if err := SeedAntigravityAppDataDir(destDir, map[string]string{"HOME": userHome}); err == nil {
			t.Fatal("oversized seed file was accepted")
		}
	})

	t.Run("rejects_non_regular_seed_file", func(t *testing.T) {
		userHome := t.TempDir()
		sourceDir := AntigravityUserAppDataDir(map[string]string{"HOME": userHome})
		if err := os.MkdirAll(filepath.Join(sourceDir, antigravityOAuthTokenFile), 0o700); err != nil {
			t.Fatal(err)
		}
		destDir := filepath.Join(t.TempDir(), "app-data")
		if err := SeedAntigravityAppDataDir(destDir, map[string]string{"HOME": userHome}); err == nil {
			t.Fatal("non-regular seed file was accepted")
		}
	})

	t.Run("rejects_seeding_into_source_dir", func(t *testing.T) {
		userHome := t.TempDir()
		sourceDir := AntigravityUserAppDataDir(map[string]string{"HOME": userHome})
		if err := os.MkdirAll(sourceDir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := SeedAntigravityAppDataDir(sourceDir, map[string]string{"HOME": userHome}); err == nil {
			t.Fatal("seeding into user source dir was accepted")
		}
	})
}

func TestAntigravityAuthFingerprint(t *testing.T) {
	if got := AntigravityAuthFingerprint(map[string]string{}); got != "" {
		t.Fatalf("empty env fingerprint = %q, want empty", got)
	}
	userHome := t.TempDir()
	env := map[string]string{"HOME": userHome}
	sourceDir := AntigravityUserAppDataDir(env)
	absent := AntigravityAuthFingerprint(env)
	if absent == "" {
		t.Fatal("absent fingerprint should be non-empty when HOME is set")
	}
	if err := os.MkdirAll(sourceDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceDir, antigravityOAuthTokenFile), []byte("tok-1"), 0o600); err != nil {
		t.Fatal(err)
	}
	withToken := AntigravityAuthFingerprint(env)
	if withToken == absent {
		t.Fatal("fingerprint did not change when token appeared")
	}
	if err := os.WriteFile(filepath.Join(sourceDir, antigravityOAuthTokenFile), []byte("tok-2"), 0o600); err != nil {
		t.Fatal(err)
	}
	if AntigravityAuthFingerprint(env) == withToken {
		t.Fatal("fingerprint did not change when token updated")
	}
}
