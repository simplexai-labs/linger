package workspace

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

func stubClaudeKeychain(t *testing.T, content string) {
	t.Helper()
	stubClaudeKeychainEntries(t, map[string][]byte{"": []byte(content)})
}

func stubClaudeKeychainEntries(t *testing.T, entries map[string][]byte) {
	t.Helper()
	previousRead, previousRemove := claudeKeychainRead, claudeKeychainRemove
	claudeKeychainRead = func(root string) ([]byte, error) { return entries[root], nil }
	claudeKeychainRemove = func(root string) error {
		if root == "" {
			t.Fatal("attempted to delete Host login")
		}
		delete(entries, root)
		return nil
	}
	t.Cleanup(func() { claudeKeychainRead, claudeKeychainRemove = previousRead, previousRemove })
}

func claudeSource(t *testing.T) (string, map[string]string) {
	t.Helper()
	stubClaudeKeychain(t, "")
	home := t.TempDir()
	source := filepath.Join(home, ".claude")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	return source, map[string]string{"HOME": home}
}

func TestClaudeCredentialsPreferTheNativeKeychainOverAStaleHostFile(t *testing.T) {
	source, environment := claudeSource(t)
	if err := os.WriteFile(filepath.Join(source, ".credentials.json"), []byte(`{"claudeAiOauth":{"accessToken":"file"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	stubClaudeKeychain(t, `{"claudeAiOauth":{"accessToken":"keychain"}}`)
	configRoot := filepath.Join(t.TempDir(), ".claude")
	if err := os.MkdirAll(configRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := configureClaudeCredentials(configRoot, environment, nil); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(configRoot, ".credentials.json"))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(content), `{"claudeAiOauth":{"accessToken":"keychain"}}`; got != want {
		t.Fatalf("seeded credential = %s, want %s", got, want)
	}
	if environment["CLAUDE_CONFIG_DIR"] != configRoot {
		t.Fatalf("CLAUDE_CONFIG_DIR = %q, want %q", environment["CLAUDE_CONFIG_DIR"], configRoot)
	}
}

func TestClaudeCredentialsAdoptTheHostKeychainWithoutAFile(t *testing.T) {
	_, environment := claudeSource(t)
	stubClaudeKeychain(t, `{"claudeAiOauth":{"accessToken":"keychain"}}`)
	configRoot := filepath.Join(t.TempDir(), ".claude")
	if err := os.MkdirAll(configRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := configureClaudeCredentials(configRoot, environment, nil); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(configRoot, ".credentials.json"))
	if err != nil {
		t.Fatalf("Keychain credential was not adopted: %v", err)
	}
	if got, want := string(content), `{"claudeAiOauth":{"accessToken":"keychain"}}`; got != want {
		t.Fatalf("seeded credential = %s, want %s", got, want)
	}
	info, err := os.Stat(filepath.Join(configRoot, ".credentials.json"))
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); runtime.GOOS != "windows" && mode&0o077 != 0 {
		t.Fatalf("seeded credential mode = %v, want owner-only", mode)
	}
	if err := privatefs.CheckPath(configRoot, "directory", true); err != nil {
		t.Fatalf("configRoot ACL: %v", err)
	}
	if err := privatefs.CheckPath(filepath.Join(configRoot, ".credentials.json"), "file", true); err != nil {
		t.Fatalf("seeded credential ACL: %v", err)
	}
	if err := privatefs.CheckPath(filepath.Join(configRoot, ".linger-auth-source.sha256"), "file", true); err != nil {
		t.Fatalf("seeded generation marker ACL: %v", err)
	}
}

func TestClaudeCredentialsLeaveExplicitEnvironmentAuthAlone(t *testing.T) {
	_, environment := claudeSource(t)
	environment["ANTHROPIC_API_KEY"] = "fixture-not-a-real-key"
	stubClaudeKeychain(t, `{"claudeAiOauth":{"accessToken":"keychain"}}`)
	configRoot := filepath.Join(t.TempDir(), ".claude")
	if err := os.MkdirAll(configRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := configureClaudeCredentials(configRoot, environment, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(configRoot, ".credentials.json")); !os.IsNotExist(err) {
		t.Fatalf("Keychain was consulted although the environment carries a key: %v", err)
	}
}

func TestClaudeCredentialsRejectAMalformedKeychain(t *testing.T) {
	_, environment := claudeSource(t)
	stubClaudeKeychain(t, "not json")
	configRoot := filepath.Join(t.TempDir(), ".claude")
	if err := os.MkdirAll(configRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := configureClaudeCredentials(configRoot, environment, nil); err == nil {
		t.Fatal("malformed Keychain must not be reported as authenticated")
	}
	if _, err := os.Stat(filepath.Join(configRoot, ".credentials.json")); !os.IsNotExist(err) {
		t.Fatalf("a malformed Keychain entry was seeded: %v", err)
	}
}

// The readiness probe and a Context Runtime home must reach the same verdict:
// this is the divergence that let the Agent creation page report a ready Claude
// Runtime whose first Operation then failed with "Not logged in".
func TestClaudeProbeEnvironmentMatchesTheContextRuntimeHome(t *testing.T) {
	_, environment := claudeSource(t)
	stubClaudeKeychain(t, `{"claudeAiOauth":{"accessToken":"keychain"}}`)
	prepared, release, err := ClaudeProbeEnvironment(environment, "")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if environment["CLAUDE_CONFIG_DIR"] != "" {
		t.Fatal("probe preparation mutated the shared discovery environment")
	}
	probeRoot := prepared["CLAUDE_CONFIG_DIR"]
	if probeRoot == "" {
		t.Fatal("probe environment carries no CLAUDE_CONFIG_DIR")
	}
	content, err := os.ReadFile(filepath.Join(probeRoot, ".credentials.json"))
	if err != nil {
		t.Fatalf("probe configuration has no credential: %v", err)
	}
	if got, want := string(content), `{"claudeAiOauth":{"accessToken":"keychain"}}`; got != want {
		t.Fatalf("probe credential = %s, want %s", got, want)
	}
	release()
	if _, err := os.Stat(probeRoot); !os.IsNotExist(err) {
		t.Fatalf("probe configuration outlived its release: %v", err)
	}
}

func TestClaudeProbeEnvironmentReportsNoCredentialWhenTheHostHasNone(t *testing.T) {
	_, environment := claudeSource(t)
	stubClaudeKeychain(t, "")
	prepared, release, err := ClaudeProbeEnvironment(environment, "")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if _, err := os.Stat(filepath.Join(prepared["CLAUDE_CONFIG_DIR"], ".credentials.json")); !os.IsNotExist(err) {
		t.Fatalf("probe invented a credential: %v", err)
	}
}

// A model call's configuration root outlives the call, so the next call keeps
// Claude's native refresh instead of refreshing from the stale Host login.
func TestClaudeModelInvokeEnvironmentKeepsANativeRefreshAcrossCalls(t *testing.T) {
	_, environment := claudeSource(t)
	stubClaudeKeychain(t, `{"claudeAiOauth":{"accessToken":"host","expiresAt":1}}`)
	configRoot := filepath.Join(t.TempDir(), "model-invoke", ".claude")
	prepared, err := ClaudeModelInvokeEnvironment(configRoot, environment)
	if err != nil {
		t.Fatal(err)
	}
	if prepared["CLAUDE_CONFIG_DIR"] != configRoot || environment["CLAUDE_CONFIG_DIR"] != "" {
		t.Fatalf("prepared = %q, shared = %q", prepared["CLAUDE_CONFIG_DIR"], environment["CLAUDE_CONFIG_DIR"])
	}
	refreshed := `{"claudeAiOauth":{"accessToken":"refreshed","expiresAt":4102448400000}}`
	if err := os.WriteFile(filepath.Join(configRoot, ".credentials.json"), []byte(refreshed), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ClaudeModelInvokeEnvironment(configRoot, environment); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(configRoot, ".credentials.json"))
	if err != nil || string(content) != refreshed {
		t.Fatalf("native refresh was replaced: %s, %v", content, err)
	}
}

// Seeding runs at the start of every Operation. Claude refreshes its own token
// inside the Context Runtime home, so re-seeding must not hand the next
// Operation a token the previous one has already replaced.
func TestClaudeCredentialsKeepARefreshedRuntimeToken(t *testing.T) {
	source, environment := claudeSource(t)
	host := `{"claudeAiOauth":{"accessToken":"host","expiresAt":4102444800000}}`
	if err := os.WriteFile(filepath.Join(source, ".credentials.json"), []byte(host), 0o600); err != nil {
		t.Fatal(err)
	}
	configRoot := filepath.Join(t.TempDir(), ".claude")
	if err := os.MkdirAll(configRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	refreshed := `{"claudeAiOauth":{"accessToken":"refreshed","expiresAt":4102448400000}}`
	if err := os.WriteFile(filepath.Join(configRoot, ".credentials.json"), []byte(refreshed), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := configureClaudeCredentials(configRoot, environment, nil); err != nil {
		t.Fatal(err)
	}

	content, err := os.ReadFile(filepath.Join(configRoot, ".credentials.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != refreshed {
		t.Fatalf("seeding replaced a newer Runtime token: %s", content)
	}
}

func TestClaudeCredentialsAdoptANewerHostLogin(t *testing.T) {
	source, environment := claudeSource(t)
	host := `{"claudeAiOauth":{"accessToken":"host","expiresAt":4102452000000}}`
	if err := os.WriteFile(filepath.Join(source, ".credentials.json"), []byte(host), 0o600); err != nil {
		t.Fatal(err)
	}
	configRoot := filepath.Join(t.TempDir(), ".claude")
	if err := os.MkdirAll(configRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	stale := `{"claudeAiOauth":{"accessToken":"stale","expiresAt":4102448400000}}`
	if err := os.WriteFile(filepath.Join(configRoot, ".credentials.json"), []byte(stale), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := configureClaudeCredentials(configRoot, environment, nil); err != nil {
		t.Fatal(err)
	}

	content, err := os.ReadFile(filepath.Join(configRoot, ".credentials.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != host {
		t.Fatalf("a newer Host login was not adopted: %s", content)
	}
}

// An API-key credential carries no expiry, so there is nothing to compare and
// the Host's copy stays authoritative.
func TestClaudeCredentialsWithoutAnExpiryFollowTheHost(t *testing.T) {
	source, environment := claudeSource(t)
	host := `{"apiKey":"host"}`
	if err := os.WriteFile(filepath.Join(source, ".credentials.json"), []byte(host), 0o600); err != nil {
		t.Fatal(err)
	}
	configRoot := filepath.Join(t.TempDir(), ".claude")
	if err := os.MkdirAll(configRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configRoot, ".credentials.json"), []byte(`{"apiKey":"previous"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := configureClaudeCredentials(configRoot, environment, nil); err != nil {
		t.Fatal(err)
	}

	content, err := os.ReadFile(filepath.Join(configRoot, ".credentials.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != host {
		t.Fatalf("seeded credential = %s, want the Host copy", content)
	}
}

func TestWritePrivateRuntimeFileAtomicAndHardensLegacyPermissions(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", ".claude")
	path := filepath.Join(dir, ".credentials.json")
	if err := writePrivateRuntimeFile(path, []byte(`{"v":1}`)); err != nil {
		t.Fatalf("initial writePrivateRuntimeFile: %v", err)
	}
	if err := privatefs.CheckPath(dir, "directory", true); err != nil {
		t.Fatalf("dir not private: %v", err)
	}
	if err := privatefs.CheckPath(path, "file", true); err != nil {
		t.Fatalf("file not private: %v", err)
	}

	// Simulate a legacy loosely-permitted file and overwrite atomically.
	if runtime.GOOS != "windows" {
		if err := os.Chmod(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := writePrivateRuntimeFile(path, []byte(`{"v":2}`)); err != nil {
		t.Fatalf("replacement writePrivateRuntimeFile: %v", err)
	}
	if err := privatefs.CheckPath(dir, "directory", true); err != nil {
		t.Fatalf("dir not re-hardened: %v", err)
	}
	if err := privatefs.CheckPath(path, "file", true); err != nil {
		t.Fatalf("file not re-hardened: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != `{"v":2}` {
		t.Fatalf("content = %q, err = %v", got, err)
	}

	// Symlink destinations must be refused without altering their target.
	outside := filepath.Join(t.TempDir(), "outside.json")
	if err := os.WriteFile(outside, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "symlink.json")
	if err := os.Symlink(outside, link); err == nil {
		if err := writePrivateRuntimeFile(link, []byte("overwrite")); err == nil {
			t.Fatal("writePrivateRuntimeFile followed a symlink")
		}
		if data, err := os.ReadFile(outside); err != nil || string(data) != "keep" {
			t.Fatalf("symlink target modified: %q, %v", data, err)
		}
	}
}

func TestClaudeConfigRootEntryPointsProtectDirectoriesAndKeepProbesInStateBase(t *testing.T) {
	t.Run("ConfigureClaudeContextHome", func(t *testing.T) {
		_, environment := claudeSource(t)
		stubClaudeKeychain(t, `{"claudeAiOauth":{"accessToken":"keychain"}}`)
		home := t.TempDir()
		workspaceDir := t.TempDir()
		configRoot := filepath.Join(home, ".claude")
		if err := os.MkdirAll(configRoot, 0o755); err != nil {
			t.Fatal(err)
		}
		if runtime.GOOS != "windows" {
			if err := os.Chmod(configRoot, 0o755); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := ConfigureClaudeContextHome(home, workspaceDir, environment, nil); err != nil {
			t.Fatal(err)
		}
		if err := privatefs.CheckPath(configRoot, "directory", true); err != nil {
			t.Fatalf("configRoot not private: %v", err)
		}
		if err := privatefs.CheckPath(filepath.Join(configRoot, ".credentials.json"), "file", true); err != nil {
			t.Fatalf("credential not private: %v", err)
		}
		if err := privatefs.CheckPath(filepath.Join(configRoot, ".linger-auth-source.sha256"), "file", true); err != nil {
			t.Fatalf("marker not private: %v", err)
		}
	})

	t.Run("ClaudeProbeEnvironment in daemon state base", func(t *testing.T) {
		_, environment := claudeSource(t)
		stubClaudeKeychain(t, `{"claudeAiOauth":{"accessToken":"keychain"}}`)
		stateTempBase := filepath.Join(t.TempDir(), "daemon-state", "operation-tmp")
		prepared, release, err := ClaudeProbeEnvironment(environment, stateTempBase)
		if err != nil {
			t.Fatal(err)
		}
		defer release()
		probeConfig := prepared["CLAUDE_CONFIG_DIR"]
		probeRoot := filepath.Dir(probeConfig)
		if !strings.HasPrefix(probeRoot, stateTempBase+string(os.PathSeparator)) {
			t.Fatalf("probe root %q is not under configured state base %q", probeRoot, stateTempBase)
		}
		if err := privatefs.CheckPath(stateTempBase, "directory", true); err != nil {
			t.Fatalf("stateTempBase not private: %v", err)
		}
		if err := privatefs.CheckPath(probeRoot, "directory", true); err != nil {
			t.Fatalf("probeRoot not private: %v", err)
		}
		if err := privatefs.CheckPath(probeConfig, "directory", true); err != nil {
			t.Fatalf("probeConfig not private: %v", err)
		}
		if err := privatefs.CheckPath(filepath.Join(probeConfig, ".credentials.json"), "file", true); err != nil {
			t.Fatalf("probe credential not private: %v", err)
		}
		// While the probe is active, PruneOperationTemps must not remove it.
		if removed, _, err := PruneOperationTemps(stateTempBase, nil); err != nil || removed != 0 {
			t.Fatalf("prune removed active probe: removed=%d err=%v", removed, err)
		}
		// Release is idempotent and removes the probe directory completely.
		release()
		release()
		if _, err := os.Stat(probeRoot); !os.IsNotExist(err) {
			t.Fatalf("probe root outlived release: %v", err)
		}
	})

	t.Run("ClaudeProbeEnvironment fallback protects OS temp dir", func(t *testing.T) {
		_, environment := claudeSource(t)
		stubClaudeKeychain(t, `{"claudeAiOauth":{"accessToken":"keychain"}}`)
		prepared, release, err := ClaudeProbeEnvironment(environment, "")
		if err != nil {
			t.Fatal(err)
		}
		defer release()
		probeConfig := prepared["CLAUDE_CONFIG_DIR"]
		if err := privatefs.CheckPath(filepath.Dir(probeConfig), "directory", true); err != nil {
			t.Fatalf("fallback probe root not private: %v", err)
		}
		if err := privatefs.CheckPath(probeConfig, "directory", true); err != nil {
			t.Fatalf("fallback probe configRoot not private: %v", err)
		}
		if err := privatefs.CheckPath(filepath.Join(probeConfig, ".credentials.json"), "file", true); err != nil {
			t.Fatalf("fallback probe credential not private: %v", err)
		}
	})

	t.Run("ClaudeModelInvokeEnvironment", func(t *testing.T) {
		_, environment := claudeSource(t)
		stubClaudeKeychain(t, `{"claudeAiOauth":{"accessToken":"keychain"}}`)
		configRoot := filepath.Join(t.TempDir(), "model-invoke", ".claude")
		if err := os.MkdirAll(configRoot, 0o755); err != nil {
			t.Fatal(err)
		}
		if runtime.GOOS != "windows" {
			if err := os.Chmod(configRoot, 0o755); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := ClaudeModelInvokeEnvironment(configRoot, environment); err != nil {
			t.Fatal(err)
		}
		if err := privatefs.CheckPath(configRoot, "directory", true); err != nil {
			t.Fatalf("model invoke configRoot not private: %v", err)
		}
		if err := privatefs.CheckPath(filepath.Join(configRoot, ".credentials.json"), "file", true); err != nil {
			t.Fatalf("model invoke credential not private: %v", err)
		}
	})
}

func TestClaudeCredentialsRepairLegacyLoosePermissionsOnUnchangedFastPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX mode bits test; Windows ACL equivalent is in claude_credentials_windows_test.go")
	}
	_, environment := claudeSource(t)
	token := `{"claudeAiOauth":{"accessToken":"keychain","expiresAt":4102444800000}}`
	stubClaudeKeychain(t, token)
	configRoot := filepath.Join(t.TempDir(), ".claude")
	if err := configureClaudeCredentials(configRoot, environment, nil); err != nil {
		t.Fatal(err)
	}
	credPath := filepath.Join(configRoot, ".credentials.json")
	markerPath := filepath.Join(configRoot, ".linger-auth-source.sha256")

	// Simulate legacy loosely-permitted directory and files on disk.
	if err := os.Chmod(configRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(credPath, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(markerPath, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := privatefs.CheckPath(credPath, "file", true); err == nil {
		t.Fatal("expected loose credential to fail CheckPath before repair")
	}

	// Re-run with unchanged source and a resident process: files and directory
	// must be repaired in place without retiring the resident.
	retired := 0
	if err := configureClaudeCredentials(configRoot, map[string]string{"HOME": environment["HOME"]}, func() error {
		retired++
		return nil
	}); err != nil {
		t.Fatalf("reconcile unchanged credential: %v", err)
	}
	if retired != 0 {
		t.Fatalf("ACL-only repair retired resident %d times", retired)
	}
	if err := privatefs.CheckPath(configRoot, "directory", true); err != nil {
		t.Fatalf("configRoot was not repaired: %v", err)
	}
	if err := privatefs.CheckPath(credPath, "file", true); err != nil {
		t.Fatalf("credential was not repaired: %v", err)
	}
	if err := privatefs.CheckPath(markerPath, "file", true); err != nil {
		t.Fatalf("marker was not repaired: %v", err)
	}
	got, err := os.ReadFile(credPath)
	if err != nil || string(got) != token {
		t.Fatalf("repaired credential content = %q, err = %v", got, err)
	}
}
