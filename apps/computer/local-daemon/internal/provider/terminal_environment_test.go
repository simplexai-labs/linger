package provider

import (
	"bytes"
	"encoding/json"
	"errors"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestDiscoverUsesInteractiveTerminalPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX terminal fixture")
	}
	isolateClaudeKeychain(t)
	root := t.TempDir()
	locations := map[string]string{
		"pi":     filepath.Join(root, ".local/share/mise/installs/npm-earendil-works-pi-coding-agent/latest/node_modules/.bin"),
		"codex":  filepath.Join(root, ".local/bin"),
		"claude": filepath.Join(root, ".local/share/mise/installs/node/22.22.3/bin"),
	}
	versions := map[string]string{"codex": "codex-cli 0.171.0", "claude": "2.1.282", "pi": "1.2.0"}
	for name, directory := range locations {
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
		script := "#!/usr/bin/env fixture-node\nif [ \"$1\" = --version ]; then echo '" + versions[name] + "'; exit 0; fi\n"
		if name == "codex" {
			script += `
read initialize
echo '{"id":1,"result":{"userAgent":"fixture"}}'
read initialized
read request
case "$request" in
 *'"method":"model/list"'*) echo '{"id":2,"result":{"data":[{"id":"terminal-model"}],"nextCursor":null}}' ;;
 *) echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":false}}' ;;
esac
`
		}
		if err := os.WriteFile(filepath.Join(directory, name), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	nodeDir := locations["claude"]
	if err := os.WriteFile(filepath.Join(nodeDir, "fixture-node"), []byte("#!/bin/sh\nexec /bin/sh \"$@\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	shell := filepath.Join(root, "terminal-shell")
	if err := os.WriteFile(shell, []byte("#!/bin/sh\n[ \"$1\" = '-lic' ] || exit 2\nprintf 'mise startup notice\\n'\nexport PATH=\"$TERMINAL_PATH\"\nexec /bin/sh -c \"$2\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	original := map[string]string{"HOME": root, "SHELL": shell, "PATH": "/usr/bin:/bin", "TERMINAL_PATH": strings.Join([]string{locations["pi"], locations["codex"], nodeDir, "/usr/bin", "/bin"}, string(os.PathListSeparator))}
	result, err := Discover(t.Context(), DiscoveryOptions{Environment: original})
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"codex", "claude", "pi"} {
		var entry string
		var diagnostic RuntimeDiagnostic
		for _, value := range result.Diagnostics {
			if value.Type == name {
				diagnostic = value
				entry = diagnostic.EntryPath
			}
		}
		if entry != filepath.Join(locations[name], name) || diagnostic.Version == "" {
			t.Fatalf("%s was not discovered and version-probed: %+v", name, diagnostic)
		}
		environment := maps.Clone(original)
		environment["PATH"] = diagnostic.ExecutionPath
		command := exec.Command(entry, "--version")
		command.Env = environmentList(environment)
		if output, err := command.Output(); err != nil || strings.TrimSpace(string(output)) != versions[name] {
			t.Fatalf("%s interpreter PATH: output=%q err=%v", name, output, err)
		}
	}
	if result.Diagnostics[0].Status != "ready" {
		t.Fatalf("Codex probe lost terminal PATH: %+v", result.Diagnostics[0])
	}
	refreshed, err := RefreshRuntimeAuthentication(t.Context(), result, DiscoveryOptions{Environment: original})
	if err != nil || refreshed.Diagnostics[0].Status != "ready" {
		t.Fatalf("auth refresh lost terminal PATH: %+v %v", refreshed, err)
	}
	wire, err := DiagnosticsJSON(result.Diagnostics)
	if err != nil || strings.Contains(string(wire), root) {
		t.Fatalf("private paths entered diagnostic wire: %s %v", wire, err)
	}
	var decoded []RuntimeDiagnostic
	if err := json.Unmarshal(wire, &decoded); err != nil {
		t.Fatal(err)
	}
	if original["PATH"] != "/usr/bin:/bin" {
		t.Fatal("mutated caller environment")
	}
}

func TestTerminalEnvironmentKeepsInheritedPathOnShellFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX terminal fixture")
	}
	root := t.TempDir()
	shell := filepath.Join(root, "shell")
	for _, script := range []string{"#!/bin/sh\nexit 1\n", "#!/bin/sh\nprintf 'unframed startup output\\n'\n"} {
		if err := os.WriteFile(shell, []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
		environment := terminalEnvironment(t.Context(), map[string]string{"HOME": root, "SHELL": shell, "PATH": "/usr/bin:/bin"})
		userFirst := filepath.Join(root, ".claude/local") + ":/usr/bin:/bin:"
		if !strings.Contains(environment["PATH"], userFirst) || !strings.HasPrefix(environment["PATH"], filepath.Join(root, ".local/bin")+":") {
			t.Fatalf("PATH=%q", environment["PATH"])
		}
	}
}

func TestTerminalEnvironmentReusesLastCapturedPathWhenTheShellFails(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX terminal fixture")
	}
	root := t.TempDir()
	shell := filepath.Join(root, "shell")
	terminalPath := filepath.Join(root, ".nvm-like/bin")
	if err := os.WriteFile(shell, []byte("#!/bin/sh\nexport PATH=\"$TERMINAL_PATH\"\nexec /bin/sh -c \"$2\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	source := map[string]string{"HOME": root, "SHELL": shell, "PATH": "/usr/bin:/bin", "TERMINAL_PATH": terminalPath}
	cache := NewTerminalEnvironmentCache()
	if environment := cache.Resolve(t.Context(), source, false); !strings.HasPrefix(environment["PATH"], terminalPath+":/usr/bin:/bin") {
		t.Fatalf("first PATH=%q", environment["PATH"])
	}
	// The next read misses its budget, as a slow profile does under load.
	if err := os.WriteFile(shell, []byte("#!/bin/sh\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if environment := cache.Resolve(t.Context(), source, true); !strings.HasPrefix(environment["PATH"], terminalPath+":/usr/bin:/bin") {
		t.Fatalf("PATH after a failed read=%q", environment["PATH"])
	}
}

func TestTerminalEnvironmentFindsNodeManagerGlobalInstalls(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX install directories")
	}
	root := t.TempDir()
	older := filepath.Join(root, ".nvm/versions/node/v9.11.2/bin")
	newer := filepath.Join(root, ".nvm/versions/node/v22.3.0/bin")
	pnpm := filepath.Join(root, "Library/pnpm")
	for _, directory := range []string{older, newer, pnpm} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	codex := filepath.Join(older, "codex")
	if err := os.WriteFile(codex, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	// No terminal PATH: nvm, fnm and pnpm folders come only from a profile.
	environment := terminalEnvironment(t.Context(), map[string]string{"HOME": root, "PATH": "/usr/bin:/bin"})
	entries := filepath.SplitList(environment["PATH"])
	if newerAt, olderAt, pnpmAt := slices.Index(entries, newer), slices.Index(entries, older), slices.Index(entries, pnpm); newerAt < 0 || olderAt < newerAt || pnpmAt < 0 || pnpmAt > slices.Index(entries, "/usr/bin") {
		t.Fatalf("PATH=%q", environment["PATH"])
	}
	if path := firstCandidateEntry(t, "codex", "codex", DiscoveryOptions{Environment: environment}); path != codex {
		t.Fatalf("resolved %q; want %q", path, codex)
	}
}

func TestTerminalEnvironmentReadsBashInteractiveStartup(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux bash startup semantics")
	}
	shell, err := exec.LookPath("bash")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, ".bash_profile"), []byte("printf 'login startup notice\\n'\n. \"$HOME/.bashrc\"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".bashrc"), []byte("case $- in *i*) export PATH=\"$TERMINAL_PATH\";; esac\n"), 0600); err != nil {
		t.Fatal(err)
	}
	terminalPath := filepath.Join(root, "mise/bin") + ":/usr/bin:/bin"
	environment := terminalEnvironment(t.Context(), map[string]string{"HOME": root, "PATH": "/usr/bin:/bin", "SHELL": shell, "TERMINAL_PATH": terminalPath})
	if !strings.HasPrefix(environment["PATH"], terminalPath) {
		t.Fatalf("interactive bash startup was not captured: %q", environment["PATH"])
	}
}

func TestTerminalEnvironmentAppendsCommonRuntimeDirectories(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX install directories")
	}
	root := t.TempDir()
	// A GUI launch has neither a login shell nor the Homebrew or npm directories.
	environment := terminalEnvironment(t.Context(), map[string]string{"HOME": root, "PATH": "/usr/bin:/bin:/usr/local/bin"})
	// Without a terminal PATH the user's own directories precede the inherited
	// /usr/local/bin, which can hold an older global install.
	want := strings.Join([]string{filepath.Join(root, ".local/bin"), filepath.Join(root, ".npm-global/bin"),
		filepath.Join(root, ".volta/bin"), filepath.Join(root, ".bun/bin"), filepath.Join(root, ".claude/local"),
		"/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"}, ":")
	if environment["PATH"] != want {
		t.Fatalf("PATH=%q, want %q", environment["PATH"], want)
	}
	claude := filepath.Join(root, ".npm-global/bin/linger-runtime-fixture")
	if err := os.MkdirAll(filepath.Dir(claude), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(claude, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if path := firstCandidateEntry(t, "fixture", "linger-runtime-fixture", DiscoveryOptions{Environment: environment}); path != claude {
		t.Fatalf("resolved %q; want %q", path, claude)
	}
}

func TestTerminalEnvironmentStabilizesFnmMultishellsAndCleansUpSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX terminal fixture")
	}
	root := t.TempDir()
	fnmInstall := filepath.Join(root, "fnm", "node-versions", "v22.0.0", "installation")
	fnmBin := filepath.Join(fnmInstall, "bin")
	parentInstall := filepath.Join(root, "fnm", "node-versions", "v20.0.0", "installation")
	parentBin := filepath.Join(parentInstall, "bin")
	stableReal := filepath.Join(root, "Cellar", "tool", "1.0", "bin")
	managedReal := filepath.Join(root, "managed", "v1", "bin")
	miseReal := filepath.Join(root, "mise", "installs", "1.0", "bin")
	for _, dir := range []string{fnmBin, parentBin, stableReal, managedReal, miseReal} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	stableHomebrew := filepath.Join(root, "opt", "homebrew", "opt", "tool", "bin")
	managedCurrent := filepath.Join(root, "managed", "current", "bin")
	miseLatest := filepath.Join(root, "mise", "latest", "bin")
	for _, pair := range [][2]string{
		{stableReal, stableHomebrew},
		{managedReal, managedCurrent},
		{miseReal, miseLatest},
	} {
		if err := os.MkdirAll(filepath.Dir(pair[1]), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(pair[0], pair[1]); err != nil {
			t.Fatal(err)
		}
	}

	multishellsDir := filepath.Join(root, "state", "fnm_multishells")
	if err := os.MkdirAll(multishellsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	parentMultishell := filepath.Join(multishellsDir, "parent_0")
	if err := os.Symlink(parentInstall, parentMultishell); err != nil {
		t.Fatal(err)
	}
	childMultishell := filepath.Join(multishellsDir, "child_1")
	relTarget, err := filepath.Rel(multishellsDir, fnmInstall)
	if err != nil {
		t.Fatal(err)
	}
	danglingEntry := filepath.Join(multishellsDir, "dangling_9", "bin")
	probeEnvLog := filepath.Join(root, "probe-env.log")

	shell := filepath.Join(root, "fnm-shell")
	script := `#!/bin/sh
[ "$1" = '-lic' ] || exit 2
printf 'PATH=%s\nFNM_MULTISHELL_PATH=%s\n' "$PATH" "$FNM_MULTISHELL_PATH" > "$PROBE_ENV_LOG"
ln -s "$CHILD_TARGET" "$CHILD_MULTISHELL"
export FNM_MULTISHELL_PATH="$CHILD_MULTISHELL"
export PATH="$CHILD_MULTISHELL/bin:$STABLE_HOMEBREW:$MANAGED_CURRENT:$MISE_LATEST:$DANGLING_ENTRY:$STABLE_HOMEBREW:/usr/bin:/bin"
exec /bin/sh -c "$2"
`
	if err := os.WriteFile(shell, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}

	source := map[string]string{
		"HOME":                root,
		"SHELL":               shell,
		"PATH":                strings.Join([]string{filepath.Join(parentMultishell, "bin"), "/usr/bin", "/bin"}, ":"),
		"FNM_MULTISHELL_PATH": parentMultishell,
		"PROBE_ENV_LOG":       probeEnvLog,
		"CHILD_TARGET":        relTarget,
		"CHILD_MULTISHELL":    childMultishell,
		"STABLE_HOMEBREW":     stableHomebrew,
		"MANAGED_CURRENT":     managedCurrent,
		"MISE_LATEST":         miseLatest,
		"DANGLING_ENTRY":      danglingEntry,
	}
	resolved := terminalEnvironment(t.Context(), source)

	probeLogged, err := os.ReadFile(probeEnvLog)
	if err != nil {
		t.Fatal(err)
	}
	if string(probeLogged) != "PATH=/usr/bin:/bin:/usr/sbin:/sbin\nFNM_MULTISHELL_PATH=\n" {
		t.Fatalf("child probe environment was not clean baseline: %q", string(probeLogged))
	}
	if _, statErr := os.Lstat(childMultishell); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("child fnm_multishells symlink leaked: err=%v", statErr)
	}
	if info, statErr := os.Lstat(parentMultishell); statErr != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("parent fnm_multishells symlink was unexpectedly modified: info=%v err=%v", info, statErr)
	}

	entries := filepath.SplitList(resolved["PATH"])
	wantPrefix := []string{
		fnmBin,
		stableHomebrew,
		managedCurrent,
		miseLatest,
		danglingEntry,
		"/usr/bin",
		"/bin",
		parentBin,
	}
	if len(entries) < len(wantPrefix) || !slices.Equal(entries[:len(wantPrefix)], wantPrefix) {
		t.Fatalf("PATH entries = %v, want prefix %v", entries, wantPrefix)
	}
	seen := make(map[string]int)
	for _, entry := range entries {
		seen[entry]++
		if seen[entry] > 1 {
			t.Fatalf("duplicate PATH entry %q in %v", entry, entries)
		}
	}

	// Fallback path when shell fails also stabilizes inherited fnm_multishells and deduplicates.
	failingShell := filepath.Join(root, "failing-shell")
	if err := os.WriteFile(failingShell, []byte("#!/bin/sh\nexit 1\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	fallbackSource := maps.Clone(source)
	fallbackSource["SHELL"] = failingShell
	fallbackSource["PATH"] = strings.Join([]string{filepath.Join(parentMultishell, "bin"), "/usr/bin", "/usr/bin", filepath.Join(root, ".local/bin")}, ":")
	fallback := terminalEnvironment(t.Context(), fallbackSource)
	fallbackEntries := filepath.SplitList(fallback["PATH"])
	if strings.Contains(fallback["PATH"], "fnm_multishells") {
		t.Fatalf("fallback PATH kept ephemeral fnm_multishells: %q", fallback["PATH"])
	}
	if !strings.Contains(fallback["PATH"], parentBin) {
		t.Fatalf("fallback PATH missing stabilized parent fnm bin %q: %q", parentBin, fallback["PATH"])
	}
	fallbackSeen := make(map[string]int)
	for _, entry := range fallbackEntries {
		fallbackSeen[entry]++
		if fallbackSeen[entry] > 1 {
			t.Fatalf("duplicate fallback PATH entry %q in %v", entry, fallbackEntries)
		}
	}
}

func TestTerminalEnvironmentCacheCachesAndWatchesStartupAndVersionPointers(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX terminal fixture")
	}
	root := t.TempDir()
	dotfiles := filepath.Join(root, "dotfiles")
	zdotdir := filepath.Join(root, "zdot")
	fnmDir := filepath.Join(root, "fnm-home")
	nvmDir := filepath.Join(root, "nvm-home")
	miseConfig := filepath.Join(root, "mise-cfg")
	fishConfD := filepath.Join(root, ".config", "fish", "conf.d")
	for _, dir := range []string{
		dotfiles,
		zdotdir,
		filepath.Join(fnmDir, "aliases"),
		filepath.Join(fnmDir, "v20"),
		filepath.Join(fnmDir, "v22"),
		filepath.Join(nvmDir, "alias"),
		miseConfig,
		fishConfD,
	} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	zshrc := filepath.Join(root, ".zshrc")
	if err := os.WriteFile(zshrc, []byte("# initial\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	dotZprofile := filepath.Join(dotfiles, ".zprofile")
	if err := os.WriteFile(dotZprofile, []byte("# zprofile\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(dotZprofile, filepath.Join(root, ".zprofile")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(fnmDir, "v20"), filepath.Join(fnmDir, "aliases", "default")); err != nil {
		t.Fatal(err)
	}

	countFile := filepath.Join(root, "probe-count")
	targetPathFile := filepath.Join(root, "target-path")
	if err := os.WriteFile(targetPathFile, []byte("/term/v1:/usr/bin:/bin\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	shell := filepath.Join(root, "counting-shell")
	script := `#!/bin/sh
echo x >> "$COUNT_FILE"
IFS= read -r tp < "$TARGET_PATH_FILE"
export PATH="$tp"
export ZDOTDIR="$TEST_ZDOTDIR"
export FNM_DIR="$TEST_FNM_DIR"
export NVM_DIR="$TEST_NVM_DIR"
export MISE_CONFIG_DIR="$TEST_MISE_CONFIG"
exec /bin/sh -c "$2"
`
	if err := os.WriteFile(shell, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	probes := func() int {
		data, err := os.ReadFile(countFile)
		if err != nil {
			return 0
		}
		return strings.Count(string(data), "x")
	}

	source := map[string]string{
		"HOME":             root,
		"SHELL":            shell,
		"PATH":             "/usr/bin:/bin",
		"COUNT_FILE":       countFile,
		"TARGET_PATH_FILE": targetPathFile,
		"TEST_ZDOTDIR":     zdotdir,
		"TEST_FNM_DIR":     fnmDir,
		"TEST_NVM_DIR":     nvmDir,
		"TEST_MISE_CONFIG": miseConfig,
	}
	cache := NewTerminalEnvironmentCache()

	first := cache.Resolve(t.Context(), source, false)
	if !strings.HasPrefix(first["PATH"], "/term/v1:") || probes() != 1 {
		t.Fatalf("initial Resolve: PATH=%q probes=%d", first["PATH"], probes())
	}

	// Steady tick and non-PATH overlay changes must not re-run the shell.
	second := cache.Resolve(t.Context(), source, false)
	if second["PATH"] != first["PATH"] || probes() != 1 {
		t.Fatalf("cached Resolve re-probed shell: probes=%d PATH=%q", probes(), second["PATH"])
	}
	overlay := maps.Clone(source)
	overlay["CODEX_HOME"] = filepath.Join(root, "codex-overlay")
	overlay["PI_CODING_AGENT_DIR"] = filepath.Join(root, "pi-overlay")
	third := cache.Resolve(t.Context(), overlay, false)
	if third["PATH"] != first["PATH"] || third["CODEX_HOME"] != overlay["CODEX_HOME"] || third["PI_CODING_AGENT_DIR"] != overlay["PI_CODING_AGENT_DIR"] || probes() != 1 {
		t.Fatalf("overlay Resolve failed: probes=%d env=%v", probes(), third)
	}

	// External caller PATH change is respected without re-running the shell.
	extPath := maps.Clone(source)
	extPath["PATH"] = "/external/bin:/usr/bin:/bin"
	fourth := cache.Resolve(t.Context(), extPath, false)
	if !strings.Contains(fourth["PATH"], "/external/bin") || probes() != 1 {
		t.Fatalf("external PATH Resolve: probes=%d PATH=%q", probes(), fourth["PATH"])
	}

	wantProbes := 1
	triggerAndVerify := func(name string, version string, mutate func()) {
		t.Helper()
		mutate()
		wantPath := "/term/" + version + ":/usr/bin:/bin"
		if err := os.WriteFile(targetPathFile, []byte(wantPath+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		got := cache.Resolve(t.Context(), source, false)
		wantProbes++
		if probes() != wantProbes || !strings.HasPrefix(got["PATH"], "/term/"+version+":") {
			t.Fatalf("%s: probes=%d (want %d) PATH=%q", name, probes(), wantProbes, got["PATH"])
		}
	}

	nextModTime := time.Now().Add(2 * time.Second)
	touch := func(p, content string) {
		if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		nextModTime = nextModTime.Add(time.Second)
		if err := os.Chtimes(p, nextModTime, nextModTime); err != nil {
			t.Fatal(err)
		}
	}

	triggerAndVerify("home .zshrc edit", "v2", func() {
		touch(zshrc, "# modified\n")
	})
	triggerAndVerify("symlinked dotfile target edit", "v3", func() {
		touch(dotZprofile, "# modified dotfile\n")
	})
	triggerAndVerify("ZDOTDIR .zshrc created", "v4", func() {
		touch(filepath.Join(zdotdir, ".zshrc"), "# zdotdir\n")
	})
	triggerAndVerify("fnm aliases/default symlink repointed", "v5", func() {
		def := filepath.Join(fnmDir, "aliases", "default")
		if err := os.Remove(def); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join(fnmDir, "v22"), def); err != nil {
			t.Fatal(err)
		}
	})
	triggerAndVerify("nvm alias/default edit", "v6", func() {
		touch(filepath.Join(nvmDir, "alias", "default"), "22\n")
	})
	triggerAndVerify("mise config.toml edit", "v7", func() {
		touch(filepath.Join(miseConfig, "config.toml"), "[tools]\nnode = \"22\"\n")
	})
	triggerAndVerify("fish conf.d entry added", "v8", func() {
		touch(filepath.Join(fishConfD, "extra.fish"), "set -gx FOO bar\n")
	})
	triggerAndVerify("fish_variables edited", "v9", func() {
		touch(filepath.Join(root, ".config", "fish", "fish_variables"), "SETUVAR fish_user_paths:/fish/bin\n")
	})

	etcPaths := filepath.Join(root, "etc-paths")
	etcPathsDir := filepath.Join(root, "etc-paths.d")
	if err := os.MkdirAll(etcPathsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	prevPathsFile, prevPathsDir := systemPathsFile, systemPathsDir
	systemPathsFile, systemPathsDir = etcPaths, etcPathsDir
	t.Cleanup(func() {
		systemPathsFile, systemPathsDir = prevPathsFile, prevPathsDir
	})
	// Re-seed watch snapshot with the injected system paths locations before modifying them.
	if err := os.WriteFile(targetPathFile, []byte("/term/v9b:/usr/bin:/bin\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_ = cache.Resolve(t.Context(), source, true)
	wantProbes++

	triggerAndVerify("system /etc/paths edited", "v10", func() {
		touch(etcPaths, "/usr/local/bin\n")
	})
	triggerAndVerify("system /etc/paths.d entry added", "v11", func() {
		touch(filepath.Join(etcPathsDir, "10-extra"), "/opt/extra/bin\n")
	})

	// forceCapture=true re-runs the shell even with no file changes.
	if err := os.WriteFile(targetPathFile, []byte("/term/v12:/usr/bin:/bin\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	forced := cache.Resolve(t.Context(), source, true)
	wantProbes++
	if probes() != wantProbes || !strings.HasPrefix(forced["PATH"], "/term/v12:") {
		t.Fatalf("forceCapture: probes=%d (want %d) PATH=%q", probes(), wantProbes, forced["PATH"])
	}
}

func TestTerminalEnvironmentCacheCachesStabilizedInheritedPathAcrossTerminalClose(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX terminal fixture")
	}
	root := t.TempDir()
	parentInstall := filepath.Join(root, "fnm", "node-versions", "v20.0.0", "installation")
	parentBin := filepath.Join(parentInstall, "bin")
	if err := os.MkdirAll(parentBin, 0o700); err != nil {
		t.Fatal(err)
	}
	multishellsDir := filepath.Join(root, "state", "fnm_multishells")
	if err := os.MkdirAll(multishellsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	parentLink := filepath.Join(multishellsDir, "parent_live")
	if err := os.Symlink(parentInstall, parentLink); err != nil {
		t.Fatal(err)
	}
	shell := filepath.Join(root, "shell")
	if err := os.WriteFile(shell, []byte("#!/bin/sh\nexport PATH='/term/bin:/usr/bin:/bin'\nexec /bin/sh -c \"$2\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	source := map[string]string{
		"HOME":                root,
		"SHELL":               shell,
		"PATH":                strings.Join([]string{filepath.Join(parentLink, "bin"), "/usr/bin"}, ":"),
		"FNM_MULTISHELL_PATH": parentLink,
	}
	cache := NewTerminalEnvironmentCache()
	first := cache.Resolve(t.Context(), source, false)
	if !strings.Contains(first["PATH"], parentBin) {
		t.Fatalf("initial Resolve missing stabilized inherited fnm bin %q: %q", parentBin, first["PATH"])
	}

	// Simulate the launching terminal exiting and deleting its fnm_multishells symlink.
	if err := os.Remove(parentLink); err != nil {
		t.Fatal(err)
	}
	second := cache.Resolve(t.Context(), source, false)
	if second["PATH"] != first["PATH"] || strings.Contains(second["PATH"], "fnm_multishells") {
		t.Fatalf("closing launching terminal changed cached PATH: got=%q want=%q", second["PATH"], first["PATH"])
	}
}

func TestTerminalEnvironmentCacheRecoversFromInitialCaptureFailureWithoutFileEdits(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX terminal fixture")
	}
	root := t.TempDir()
	modeFile := filepath.Join(root, "mode")
	if err := os.WriteFile(modeFile, []byte("fail\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	shell := filepath.Join(root, "recovering-shell")
	script := `#!/bin/sh
IFS= read -r mode < "$MODE_FILE"
if [ "$mode" != "ok" ]; then exit 1; fi
export PATH="/recovered/initial/bin:/usr/bin:/bin"
exec /bin/sh -c "$2"
`
	if err := os.WriteFile(shell, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	source := map[string]string{
		"HOME":      root + "/",
		"SHELL":     shell,
		"PATH":      "/usr/bin:/bin",
		"MODE_FILE": modeFile,
	}
	now := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	cache := NewTerminalEnvironmentCache()
	cache.now = func() time.Time { return now }

	fallback := cache.Resolve(t.Context(), source, false)
	wantUserBin := filepath.Join(root, ".local", "bin")
	if !strings.HasPrefix(fallback["PATH"], wantUserBin+":") {
		t.Fatalf("initial failure fallback did not prepend user dir with trailing-slash HOME: %q", fallback["PATH"])
	}

	// Flip shell to healthy without touching any watched files: backoff holds until 2m elapses.
	if err := os.WriteFile(modeFile, []byte("ok\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	backedOff := cache.Resolve(t.Context(), source, false)
	if !strings.HasPrefix(backedOff["PATH"], wantUserBin+":") {
		t.Fatalf("cache bypassed failure backoff before 2m: %q", backedOff["PATH"])
	}

	now = now.Add(time.Minute)
	recovered := cache.Resolve(t.Context(), source, false)
	if !strings.HasPrefix(recovered["PATH"], "/recovered/initial/bin:") {
		t.Fatalf("cache did not retry/recover after initial capture failure backoff elapsed: %q", recovered["PATH"])
	}
}

func TestTerminalEnvironmentCacheNeverDegradesOnTimeoutOrError(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX terminal fixture")
	}
	root := t.TempDir()
	modeFile := filepath.Join(root, "shell-mode")
	targetPathFile := filepath.Join(root, "target-path")
	zshrc := filepath.Join(root, ".zshrc")
	if err := os.WriteFile(zshrc, []byte("# initial\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(modeFile, []byte("ok\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(targetPathFile, []byte("/good/terminal/bin:/usr/bin:/bin\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	shell := filepath.Join(root, "flaky-shell")
	script := `#!/bin/sh
IFS= read -r mode < "$MODE_FILE"
case "$mode" in
  timeout) sleep 2; exit 0 ;;
  fail) exit 1 ;;
esac
IFS= read -r tp < "$TARGET_PATH_FILE"
export PATH="$tp"
exec /bin/sh -c "$2"
`
	if err := os.WriteFile(shell, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	source := map[string]string{
		"HOME":             root,
		"SHELL":            shell,
		"PATH":             "/usr/bin:/bin",
		"MODE_FILE":        modeFile,
		"TARGET_PATH_FILE": targetPathFile,
	}
	now := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	cache := NewTerminalEnvironmentCache()
	cache.now = func() time.Time { return now }

	// Initial capture runs under the normal budget (pays macOS first-exec scan).
	initial := cache.Resolve(t.Context(), source, false)
	if !strings.HasPrefix(initial["PATH"], "/good/terminal/bin:") {
		t.Fatalf("initial PATH=%q", initial["PATH"])
	}

	prevTimeout := terminalPathCaptureTimeout
	terminalPathCaptureTimeout = 100 * time.Millisecond
	t.Cleanup(func() { terminalPathCaptureTimeout = prevTimeout })

	// Trigger re-capture via .zshrc while shell times out: must keep /good/terminal/bin.
	if err := os.WriteFile(modeFile, []byte("timeout\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(zshrc, []byte("# timeout edit\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(2 * time.Second)
	_ = os.Chtimes(zshrc, future, future)

	withOverlay := maps.Clone(source)
	withOverlay["CODEX_HOME"] = filepath.Join(root, "new-codex-home")
	timedOut := cache.Resolve(t.Context(), withOverlay, false)
	if !strings.HasPrefix(timedOut["PATH"], "/good/terminal/bin:") || strings.HasPrefix(timedOut["PATH"], filepath.Join(root, ".local/bin")) {
		t.Fatalf("timeout degraded cached terminal PATH: %q", timedOut["PATH"])
	}
	if timedOut["CODEX_HOME"] != withOverlay["CODEX_HOME"] {
		t.Fatalf("overlay CODEX_HOME lost during failed recapture: %+v", timedOut)
	}

	// Retry after initial 2m backoff fails with exit 1 -> still keeps cached PATH and enters 4m backoff.
	if err := os.WriteFile(modeFile, []byte("fail\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	now = now.Add(terminalFailureInitialBackoff)
	errored := cache.Resolve(t.Context(), withOverlay, false)
	if !strings.HasPrefix(errored["PATH"], "/good/terminal/bin:") {
		t.Fatalf("error degraded cached terminal PATH: %q", errored["PATH"])
	}

	// Before 4m backoff elapses, healthy shell is not yet probed.
	if err := os.WriteFile(modeFile, []byte("ok\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(targetPathFile, []byte("/recovered/terminal/bin:/usr/bin:/bin\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	now = now.Add(3 * time.Minute)
	stillBackedOff := cache.Resolve(t.Context(), withOverlay, false)
	if !strings.HasPrefix(stillBackedOff["PATH"], "/good/terminal/bin:") {
		t.Fatalf("backoff did not hold cached PATH before 4m: %q", stillBackedOff["PATH"])
	}

	// Healthy shell recovers once the 4m backoff elapses and updates PATH.
	now = now.Add(time.Minute)
	recovered := cache.Resolve(t.Context(), withOverlay, false)
	if !strings.HasPrefix(recovered["PATH"], "/recovered/terminal/bin:") {
		t.Fatalf("retry did not recover updated terminal PATH: %q", recovered["PATH"])
	}
}

func TestTerminalEnvironmentMetadataNeverLeaksToDiagnosticsJSON(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX terminal fixture")
	}
	isolateClaudeKeychain(t)
	root := t.TempDir()
	shell := filepath.Join(root, "meta-shell")
	script := `#!/bin/sh
printf 'secret shell banner\n'
export FNM_DIR="$META_ROOT/fnm-secret-dir"
export NVM_DIR="$META_ROOT/nvm-secret-dir"
export ZDOTDIR="$META_ROOT/zdot-secret-dir"
export MISE_CONFIG_DIR="$META_ROOT/mise-cfg-secret"
export XDG_DATA_HOME="$META_ROOT/xdg-data-secret"
export XDG_CONFIG_HOME="$META_ROOT/xdg-config-secret"
export PATH="/usr/bin:/bin"
exec /bin/sh -c "$2"
`
	if err := os.WriteFile(shell, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	result, err := Discover(t.Context(), DiscoveryOptions{
		Environment: map[string]string{
			"HOME":      root,
			"SHELL":     shell,
			"PATH":      "/usr/bin:/bin",
			"META_ROOT": root,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	wire, err := DiagnosticsJSON(result.Diagnostics)
	if err != nil {
		t.Fatal(err)
	}
	text := string(wire)
	for _, secret := range []string{root, "secret shell banner", "fnm-secret-dir", "nvm-secret-dir", "zdot-secret-dir", "mise-cfg-secret", "xdg-data-secret", "xdg-config-secret"} {
		if strings.Contains(text, secret) {
			t.Fatalf("metadata %q leaked into diagnostics JSON: %s", secret, text)
		}
	}
}

func TestCaptureTerminalPathPreservesSharedFnmMultishellsOnFailureWithoutMarkers(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX terminal fixture")
	}

	root := t.TempDir()
	installTarget := filepath.Join(root, "fnm", "node-versions", "v22.0.0", "installation")
	if err := os.MkdirAll(filepath.Join(installTarget, "bin"), 0o700); err != nil {
		t.Fatal(err)
	}

	localStateMultishells := filepath.Join(root, ".local", "state", fnmMultishellParentDir)
	stateHome := filepath.Join(root, "xdg-state")
	stateMultishells := filepath.Join(stateHome, fnmMultishellParentDir)
	tmpDir := filepath.Join(root, "tmp-dir")
	tmpMultishells := filepath.Join(tmpDir, fnmMultishellParentDir)
	parentMultishells := filepath.Join(root, "custom-fnm", fnmMultishellParentDir)
	for _, dir := range []string{localStateMultishells, stateMultishells, tmpMultishells, parentMultishells} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}

	parentLink := filepath.Join(parentMultishells, "parent_live")
	preexisting := []string{
		parentLink,
		filepath.Join(parentMultishells, "unrelated_parent_live"),
		filepath.Join(localStateMultishells, "unrelated_home_live"),
		filepath.Join(stateMultishells, "unrelated_state_live"),
		filepath.Join(tmpMultishells, "unrelated_tmp_live"),
	}
	for _, link := range preexisting {
		if err := os.Symlink(installTarget, link); err != nil {
			t.Fatal(err)
		}
	}
	regularMarker := filepath.Join(parentMultishells, "keep-regular")
	if err := os.WriteFile(regularMarker, []byte("keep\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	overflowFile := filepath.Join(root, "overflow.txt")
	if err := os.WriteFile(overflowFile, bytes.Repeat([]byte("a"), maxProbeOutputBytes+1024), 0o600); err != nil {
		t.Fatal(err)
	}

	modeFile := filepath.Join(root, "failure-mode")
	probeRanFile := filepath.Join(root, "probe-ran")
	shell := filepath.Join(root, "failing-no-markers-shell")
	script := `#!/bin/sh
IFS= read -r mode < "$FAILURE_MODE_FILE"
if [ "$mode" = "prime" ]; then exit 0; fi
ln -s "$FNM_INSTALL_DIR" "$HOME/.local/state/fnm_multishells/concurrent_home_${mode}"
ln -s "$FNM_INSTALL_DIR" "$XDG_STATE_HOME/fnm_multishells/concurrent_state_${mode}"
ln -s "$FNM_INSTALL_DIR" "$TMPDIR/fnm_multishells/concurrent_tmp_${mode}"
ln -s "$FNM_INSTALL_DIR" "$PARENT_MULTISHELLS_DIR/concurrent_parent_${mode}"
printf 'ran\n' > "$PROBE_RAN_FILE"
case "$mode" in
  timeout)
    sleep 2
    exit 0 ;;
  exit1)
    exit 1 ;;
  stdout-overflow)
    cat "$OVERFLOW_FILE"
    exit 0 ;;
  bad-output)
    printf 'unframed startup banner\n'
    exit 0 ;;
esac
`
	if err := os.WriteFile(shell, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(modeFile, []byte("prime\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	primeTestExecutable(t, shell, "FAILURE_MODE_FILE="+modeFile)

	prevTimeout := terminalPathCaptureTimeout
	terminalPathCaptureTimeout = 200 * time.Millisecond
	t.Cleanup(func() { terminalPathCaptureTimeout = prevTimeout })

	source := map[string]string{
		"HOME":                   root,
		"SHELL":                  shell,
		"PATH":                   filepath.Join(parentLink, "bin") + ":/usr/bin:/bin",
		"FNM_MULTISHELL_PATH":    parentLink,
		"XDG_STATE_HOME":         stateHome,
		"TMPDIR":                 tmpDir,
		"PARENT_MULTISHELLS_DIR": parentMultishells,
		"FAILURE_MODE_FILE":      modeFile,
		"PROBE_RAN_FILE":         probeRanFile,
		"FNM_INSTALL_DIR":        installTarget,
		"OVERFLOW_FILE":          overflowFile,
	}

	for _, mode := range []string{"timeout", "exit1", "stdout-overflow", "bad-output"} {
		t.Run(mode, func(t *testing.T) {
			_ = os.Remove(probeRanFile)
			if err := os.WriteFile(modeFile, []byte(mode+"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, _, ok := captureTerminalPath(t.Context(), source); ok {
				t.Fatalf("expected failure for mode %s", mode)
			}
			if _, err := os.Stat(probeRanFile); err != nil {
				t.Fatalf("probe script did not create concurrent symlinks before failing: %v", err)
			}
			kept := append([]string{
				regularMarker,
				filepath.Join(localStateMultishells, "concurrent_home_"+mode),
				filepath.Join(stateMultishells, "concurrent_state_"+mode),
				filepath.Join(tmpMultishells, "concurrent_tmp_"+mode),
				filepath.Join(parentMultishells, "concurrent_parent_"+mode),
			}, preexisting...)
			for _, entry := range kept {
				if _, err := os.Lstat(entry); err != nil {
					t.Fatalf("expected shared fnm_multishells entry %s to be preserved: %v", entry, err)
				}
			}
		})
	}
}

func TestCaptureTerminalPathCleansUpReportedFnmMultishellOnFailureWithMarkers(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX terminal fixture")
	}

	root := t.TempDir()
	installTarget := filepath.Join(root, "fnm", "node-versions", "v22.0.0", "installation")
	if err := os.MkdirAll(filepath.Join(installTarget, "bin"), 0o700); err != nil {
		t.Fatal(err)
	}

	multishellsDir := filepath.Join(root, "state", fnmMultishellParentDir)
	if err := os.MkdirAll(multishellsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	parentLink := filepath.Join(multishellsDir, "parent_live")
	unrelatedLink := filepath.Join(multishellsDir, "unrelated_live")
	for _, link := range []string{parentLink, unrelatedLink} {
		if err := os.Symlink(installTarget, link); err != nil {
			t.Fatal(err)
		}
	}

	overflowFile := filepath.Join(root, "overflow.txt")
	if err := os.WriteFile(overflowFile, bytes.Repeat([]byte("a"), maxProbeOutputBytes+1024), 0o600); err != nil {
		t.Fatal(err)
	}

	modeFile := filepath.Join(root, "failure-mode")
	probeRanFile := filepath.Join(root, "probe-ran")
	shell := filepath.Join(root, "failing-with-markers-shell")
	script := `#!/bin/sh
IFS= read -r mode < "$FAILURE_MODE_FILE"
if [ "$mode" = "prime" ]; then exit 0; fi
probe_link="$MULTISHELLS_DIR/probe_${mode}"
ln -s "$FNM_INSTALL_DIR" "$probe_link"
ln -s "$FNM_INSTALL_DIR" "$MULTISHELLS_DIR/concurrent_${mode}"
printf 'ran\n' > "$PROBE_RAN_FILE"
export FNM_MULTISHELL_PATH="$probe_link"
case "$mode" in
  empty-deduped)
    export PATH=":::"
    exec /bin/sh -c "$2" ;;
  stderr-overflow)
    export PATH="/usr/bin:/bin"
    /bin/sh -c "$2"
    cat "$OVERFLOW_FILE" >&2
    exit 0 ;;
  exit1)
    export PATH="/usr/bin:/bin"
    /bin/sh -c "$2"
    exit 1 ;;
esac
`
	if err := os.WriteFile(shell, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(modeFile, []byte("prime\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	primeTestExecutable(t, shell, "FAILURE_MODE_FILE="+modeFile)

	source := map[string]string{
		"HOME":                root,
		"SHELL":               shell,
		"PATH":                filepath.Join(parentLink, "bin") + ":/usr/bin:/bin",
		"FNM_MULTISHELL_PATH": parentLink,
		"MULTISHELLS_DIR":     multishellsDir,
		"FAILURE_MODE_FILE":   modeFile,
		"PROBE_RAN_FILE":      probeRanFile,
		"FNM_INSTALL_DIR":     installTarget,
		"OVERFLOW_FILE":       overflowFile,
	}

	for _, mode := range []string{"empty-deduped", "stderr-overflow", "exit1"} {
		t.Run(mode, func(t *testing.T) {
			_ = os.Remove(probeRanFile)
			if err := os.WriteFile(modeFile, []byte(mode+"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, _, ok := captureTerminalPath(t.Context(), source); ok {
				t.Fatalf("expected failure for mode %s", mode)
			}
			if _, err := os.Stat(probeRanFile); err != nil {
				t.Fatalf("probe script did not run: %v", err)
			}
			probeLink := filepath.Join(multishellsDir, "probe_"+mode)
			if _, err := os.Lstat(probeLink); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("reported probe symlink %s leaked: err=%v", probeLink, err)
			}
			concurrentLink := filepath.Join(multishellsDir, "concurrent_"+mode)
			for _, kept := range []string{parentLink, unrelatedLink, concurrentLink} {
				if _, err := os.Lstat(kept); err != nil {
					t.Fatalf("expected %s to remain untouched: %v", kept, err)
				}
			}
		})
	}
}

func TestTerminalEnvironmentCacheFailureBackoffProgressionAndBypass(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX terminal fixture")
	}
	root := t.TempDir()
	zshrc := filepath.Join(root, ".zshrc")
	if err := os.WriteFile(zshrc, []byte("# initial\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	modeFile := filepath.Join(root, "mode")
	if err := os.WriteFile(modeFile, []byte("fail\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	countFile := filepath.Join(root, "probe-count")
	shell := filepath.Join(root, "counting-failing-shell")
	script := `#!/bin/sh
echo x >> "$COUNT_FILE"
IFS= read -r mode < "$MODE_FILE"
if [ "$mode" != "ok" ]; then exit 1; fi
export PATH="/recovered/bin:/usr/bin:/bin"
exec /bin/sh -c "$2"
`
	if err := os.WriteFile(shell, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	probes := func() int {
		data, err := os.ReadFile(countFile)
		if err != nil {
			return 0
		}
		return strings.Count(string(data), "x")
	}

	now := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	cache := NewTerminalEnvironmentCache()
	cache.now = func() time.Time { return now }
	source := map[string]string{
		"HOME":       root,
		"SHELL":      shell,
		"PATH":       "/usr/bin:/bin",
		"MODE_FILE":  modeFile,
		"COUNT_FILE": countFile,
	}

	// Verify 2m -> 4m -> 8m -> 15m -> 15m backoff progression.
	_ = cache.Resolve(t.Context(), source, false)
	if probes() != 1 {
		t.Fatalf("initial probe count = %d, want 1", probes())
	}
	wantProbes := 1
	for _, wait := range []time.Duration{
		2 * time.Minute,
		4 * time.Minute,
		8 * time.Minute,
		15 * time.Minute,
		15 * time.Minute,
	} {
		now = now.Add(wait - time.Second)
		_ = cache.Resolve(t.Context(), source, false)
		if probes() != wantProbes {
			t.Fatalf("retried 1s before %s backoff elapsed: probes=%d want %d", wait, probes(), wantProbes)
		}
		now = now.Add(time.Second)
		_ = cache.Resolve(t.Context(), source, false)
		wantProbes++
		if probes() != wantProbes {
			t.Fatalf("did not retry after %s backoff elapsed: probes=%d want %d", wait, probes(), wantProbes)
		}
	}

	// forceCapture=true and watched file changes bypass active backoff immediately.
	now = now.Add(time.Second)
	_ = cache.Resolve(t.Context(), source, true)
	wantProbes++
	if probes() != wantProbes {
		t.Fatalf("forceCapture did not bypass backoff: probes=%d want %d", probes(), wantProbes)
	}

	now = now.Add(time.Second)
	mod := time.Now().Add(2 * time.Second)
	if err := os.WriteFile(zshrc, []byte("# edit 1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(zshrc, mod, mod); err != nil {
		t.Fatal(err)
	}
	_ = cache.Resolve(t.Context(), source, false)
	wantProbes++
	if probes() != wantProbes {
		t.Fatalf(".zshrc edit did not bypass backoff: probes=%d want %d", probes(), wantProbes)
	}

	// Recovery resets consecutiveFailures and clears backoff.
	if err := os.WriteFile(modeFile, []byte("ok\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	now = now.Add(15 * time.Minute)
	recovered := cache.Resolve(t.Context(), source, false)
	wantProbes++
	if probes() != wantProbes || !strings.HasPrefix(recovered["PATH"], "/recovered/bin:") {
		t.Fatalf("recovery failed: probes=%d PATH=%q", probes(), recovered["PATH"])
	}

	// Trigger a failure via periodic recheck (10m) after successful capture:
	// backoff must restart at 2m and recheckInterval must not override it.
	if err := os.WriteFile(modeFile, []byte("fail\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	now = now.Add(defaultTerminalRecheckInterval)
	stillCached := cache.Resolve(t.Context(), source, false)
	wantProbes++
	if probes() != wantProbes || !strings.HasPrefix(stillCached["PATH"], "/recovered/bin:") {
		t.Fatalf("periodic recheck failure: probes=%d PATH=%q", probes(), stillCached["PATH"])
	}
	now = now.Add(2*time.Minute - time.Second)
	_ = cache.Resolve(t.Context(), source, false)
	if probes() != wantProbes {
		t.Fatalf("recheckInterval overrode failure backoff: probes=%d want %d", probes(), wantProbes)
	}
	now = now.Add(time.Second)
	_ = cache.Resolve(t.Context(), source, false)
	wantProbes++
	if probes() != wantProbes {
		t.Fatalf("reset 2m backoff did not fire: probes=%d want %d", probes(), wantProbes)
	}
}

func TestTerminalEnvironmentCachePeriodicRecheckPicksUpUnwatchedSourcedFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX terminal fixture")
	}
	root := t.TempDir()
	sourcedFile := filepath.Join(root, "unwatched-sourced.sh")
	if err := os.WriteFile(sourcedFile, []byte("/unwatched/v1:/usr/bin:/bin\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	zshrc := filepath.Join(root, ".zshrc")
	if err := os.WriteFile(zshrc, []byte("# sources unwatched file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	countFile := filepath.Join(root, "probe-count")
	shell := filepath.Join(root, "sourcing-shell")
	script := `#!/bin/sh
echo x >> "$COUNT_FILE"
IFS= read -r sourced < "$SOURCED_FILE"
export PATH="$sourced"
exec /bin/sh -c "$2"
`
	if err := os.WriteFile(shell, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	probes := func() int {
		data, err := os.ReadFile(countFile)
		if err != nil {
			return 0
		}
		return strings.Count(string(data), "x")
	}

	now := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	cache := NewTerminalEnvironmentCache()
	cache.now = func() time.Time { return now }
	source := map[string]string{
		"HOME":         root,
		"SHELL":        shell,
		"PATH":         "/usr/bin:/bin",
		"SOURCED_FILE": sourcedFile,
		"COUNT_FILE":   countFile,
	}

	first := cache.Resolve(t.Context(), source, false)
	if !strings.HasPrefix(first["PATH"], "/unwatched/v1:") || probes() != 1 {
		t.Fatalf("initial Resolve: PATH=%q probes=%d", first["PATH"], probes())
	}

	// Edit only the unwatched sourced file; watched files stay untouched.
	if err := os.WriteFile(sourcedFile, []byte("/unwatched/v2:/usr/bin:/bin\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	now = now.Add(defaultTerminalRecheckInterval - time.Second)
	beforeRecheck := cache.Resolve(t.Context(), source, false)
	if !strings.HasPrefix(beforeRecheck["PATH"], "/unwatched/v1:") || probes() != 1 {
		t.Fatalf("re-probed before 10m recheck interval: PATH=%q probes=%d", beforeRecheck["PATH"], probes())
	}

	now = now.Add(time.Second)
	afterRecheck := cache.Resolve(t.Context(), source, false)
	if !strings.HasPrefix(afterRecheck["PATH"], "/unwatched/v2:") || probes() != 2 {
		t.Fatalf("periodic recheck did not pick up unwatched edit: PATH=%q probes=%d", afterRecheck["PATH"], probes())
	}

	// Subsequent steady tick stays cached until another 10m elapses.
	now = now.Add(time.Minute)
	steady := cache.Resolve(t.Context(), source, false)
	if !strings.HasPrefix(steady["PATH"], "/unwatched/v2:") || probes() != 2 {
		t.Fatalf("steady tick after periodic recheck re-probed: PATH=%q probes=%d", steady["PATH"], probes())
	}

	// Zero-value TerminalEnvironmentCache handles nil now and disabled recheckInterval safely.
	var zeroCache TerminalEnvironmentCache
	if err := os.WriteFile(countFile, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	zeroFirst := zeroCache.Resolve(t.Context(), source, false)
	zeroSecond := zeroCache.Resolve(t.Context(), source, false)
	if !strings.HasPrefix(zeroFirst["PATH"], "/unwatched/v2:") || zeroSecond["PATH"] != zeroFirst["PATH"] || probes() != 1 {
		t.Fatalf("zero-value cache unexpected behavior: first=%q second=%q probes=%d", zeroFirst["PATH"], zeroSecond["PATH"], probes())
	}
}
