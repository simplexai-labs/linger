// Package provider discovers installed Runtimes and executes Agent turns.
package provider

import (
	"context"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
)

// terminalPathCaptureTimeout bounds one interactive login-shell PATH probe.
var terminalPathCaptureTimeout = 5 * time.Second

// System PATH configuration locations; overridden only in unit tests.
var (
	systemPathsFile = "/etc/paths"
	systemPathsDir  = "/etc/paths.d"
)

const (
	cleanProbePath                 = "/usr/bin:/bin:/usr/sbin:/sbin"
	fnmMultishellParentDir         = "fnm_multishells"
	fnmMultishellEnvName           = "FNM_MULTISHELL_PATH"
	defaultTerminalRecheckInterval = 10 * time.Minute
	terminalFailureInitialBackoff  = 2 * time.Minute
	terminalFailureMaxBackoff      = 15 * time.Minute
	terminalProbeStartMarker       = "\x00linger-runtime-env\x00"
	terminalProbeEndMarker         = "\x00linger-runtime-env-end\x00"
	terminalProbeScript            = `/bin/sh -c 'printf "\000linger-runtime-env\000PATH=%s\000FNM_MULTISHELL_PATH=%s\000FNM_DIR=%s\000NVM_DIR=%s\000ZDOTDIR=%s\000MISE_CONFIG_DIR=%s\000XDG_DATA_HOME=%s\000XDG_CONFIG_HOME=%s\000linger-runtime-env-end\000\n" "$PATH" "$FNM_MULTISHELL_PATH" "$FNM_DIR" "$NVM_DIR" "$ZDOTDIR" "$MISE_CONFIG_DIR" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME"'`
)

var allowedTerminalMetaKeys = map[string]bool{
	"FNM_MULTISHELL_PATH": true,
	"FNM_DIR":             true,
	"NVM_DIR":             true,
	"ZDOTDIR":             true,
	"MISE_CONFIG_DIR":     true,
	"XDG_DATA_HOME":       true,
	"XDG_CONFIG_HOME":     true,
}

// TerminalEnvironmentCache caches the login-shell PATH and shell directory
// metadata across discovery ticks, re-capturing only when watched shell startup
// files or version-manager pointers change or when Runtime executables change.
type TerminalEnvironmentCache struct {
	mu                      sync.Mutex
	now                     func() time.Time
	recheckInterval         time.Duration
	initialized             bool
	hasCaptured             bool
	lastCaptureAt           time.Time
	consecutiveFailures     int
	nextRetryAt             time.Time
	capturedPath            string
	shellMeta               map[string]string
	watch                   terminalWatchSnapshot
	lastHome                string
	lastShell               string
	hasStabilizedInherited  bool
	lastInheritedRaw        string
	lastParentMultishell    string
	stabilizedInheritedPath []string
}

// NewTerminalEnvironmentCache returns an empty cache for resolving Runtime
// terminal environments across repeated discovery passes.
func NewTerminalEnvironmentCache() *TerminalEnvironmentCache {
	return &TerminalEnvironmentCache{
		now:             time.Now,
		recheckInterval: defaultTerminalRecheckInterval,
	}
}

func (c *TerminalEnvironmentCache) currentTime() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

func captureFailureBackoff(failures int) time.Duration {
	if failures <= 1 {
		return terminalFailureInitialBackoff
	}
	backoff := terminalFailureInitialBackoff
	for range failures - 1 {
		if backoff >= terminalFailureMaxBackoff {
			return terminalFailureMaxBackoff
		}
		backoff *= 2
	}
	if backoff > terminalFailureMaxBackoff {
		return terminalFailureMaxBackoff
	}
	return backoff
}

// Discover resolves options.Environment through c and runs Runtime discovery.
func (c *TerminalEnvironmentCache) Discover(ctx context.Context, options DiscoveryOptions) (DiscoveryResult, error) {
	options.Environment = c.Resolve(ctx, options.Environment, false)
	return discoverResolved(ctx, options), nil
}

// Resolve returns a copy of source with PATH resolved as the user's terminal
// would, reusing the cached login-shell capture unless forceCapture is true,
// watched startup metadata changed, a failed capture's retry backoff elapsed,
// or the coarse periodic recheck interval elapsed.
func (c *TerminalEnvironmentCache) Resolve(ctx context.Context, source map[string]string, forceCapture bool) map[string]string {
	resolved := maps.Clone(platformEnvironment(source))
	if resolved == nil {
		resolved = make(map[string]string)
	}
	if runtime.GOOS == "windows" {
		return c.resolveWindows(resolved)
	}
	home := resolved["HOME"]
	shell := resolved["SHELL"]
	inheritedPath := resolved["PATH"]
	parentMultishell := resolved[fnmMultishellEnvName]
	canCapture := filepath.IsAbs(shell)

	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.hasStabilizedInherited || c.lastInheritedRaw != inheritedPath || c.lastParentMultishell != parentMultishell {
		c.stabilizedInheritedPath = stabilizePathEntries(filepath.SplitList(inheritedPath), parentMultishell)
		c.lastInheritedRaw = inheritedPath
		c.lastParentMultishell = parentMultishell
		c.hasStabilizedInherited = true
	}

	contextChanged := !c.initialized || c.lastHome != home || c.lastShell != shell
	if contextChanged {
		c.hasCaptured = false
		c.capturedPath = ""
		c.shellMeta = nil
		c.lastCaptureAt = time.Time{}
		c.consecutiveFailures = 0
		c.nextRetryAt = time.Time{}
	}
	now := c.currentTime()
	periodicRecheck := false
	if c.consecutiveFailures > 0 {
		periodicRecheck = !now.Before(c.nextRetryAt)
	} else if c.recheckInterval > 0 {
		periodicRecheck = !now.Before(c.lastCaptureAt.Add(c.recheckInterval))
	}
	currentWatch := takeTerminalWatchSnapshot(home, c.shellMeta, resolved)
	shouldCapture := canCapture && (contextChanged || forceCapture || !currentWatch.equal(c.watch) || periodicRecheck)

	if shouldCapture {
		if captured, meta, ok := captureTerminalPath(ctx, resolved); ok {
			capturedAt := c.currentTime()
			c.hasCaptured = true
			c.consecutiveFailures = 0
			c.nextRetryAt = time.Time{}
			c.lastCaptureAt = capturedAt
			c.capturedPath = captured
			c.shellMeta = meta
			c.watch = takeTerminalWatchSnapshot(home, c.shellMeta, resolved)
		} else {
			failedAt := c.currentTime()
			c.consecutiveFailures++
			c.nextRetryAt = failedAt.Add(captureFailureBackoff(c.consecutiveFailures))
			c.watch = currentWatch
		}
	} else if contextChanged {
		c.watch = currentWatch
	}

	c.initialized = true
	c.lastHome = home
	c.lastShell = shell

	if c.hasCaptured {
		resolved["PATH"] = mergeTerminalSearchPath(c.capturedPath, c.stabilizedInheritedPath, home)
	} else {
		resolved["PATH"] = buildFallbackSearchPath(c.stabilizedInheritedPath, home)
	}
	return resolved
}

// terminalEnvironment resolves PATH as the user's terminal would for one-shot
// discovery callers.
func terminalEnvironment(ctx context.Context, source map[string]string) map[string]string {
	return NewTerminalEnvironmentCache().Resolve(ctx, source, false)
}

func userRuntimeDirectories(home string) []string {
	if !filepath.IsAbs(home) {
		return nil
	}
	cleanHome := filepath.Clean(home)
	directories := make([]string, 0, 5)
	for _, relative := range []string{".local/bin", ".npm-global/bin", ".volta/bin", ".bun/bin", ".claude/local"} {
		directories = append(directories, filepath.Join(cleanHome, relative))
	}
	directories = append(directories, nodeManagerDirectories(cleanHome)...)
	return directories
}

// commonRuntimeDirectories are where Runtime installers and package managers
// put executables when a login shell adds them to PATH.
func commonRuntimeDirectories(home string) []string {
	directories := []string{"/opt/homebrew/bin", "/usr/local/bin"}
	return append(directories, userRuntimeDirectories(home)...)
}

func mergeTerminalSearchPath(capturedPath string, stabilizedInherited []string, home string) string {
	entries := filepath.SplitList(capturedPath)
	entries = append(entries, stabilizedInherited...)
	entries = append(entries, commonRuntimeDirectories(home)...)
	return strings.Join(deduplicatePathEntries(entries), string(os.PathListSeparator))
}

// nodeManagerDirectories lists the existing global bin folders of Node
// version managers, which only an interactive profile adds to PATH: every nvm
// Node (newest first, so a global install under any of them is found), fnm's
// default Node, and pnpm's global bin.
func nodeManagerDirectories(home string) []string {
	var directories []string
	versions, _ := filepath.Glob(filepath.Join(home, ".nvm", "versions", "node", "*", "bin"))
	slices.SortFunc(versions, func(left, right string) int {
		return compareNodeVersions(filepath.Base(filepath.Dir(right)), filepath.Base(filepath.Dir(left)))
	})
	directories = append(directories, versions...)
	for _, relative := range []string{
		".local/share/fnm/aliases/default/bin", "Library/Application Support/fnm/aliases/default/bin", ".fnm/aliases/default/bin",
		"Library/pnpm", ".local/share/pnpm",
	} {
		directory := filepath.Join(home, relative)
		if info, err := os.Stat(directory); err == nil && info.IsDir() {
			directories = append(directories, directory)
		}
	}
	return directories
}

// compareNodeVersions orders nvm folder names such as v22.11.0 numerically.
func compareNodeVersions(left, right string) int {
	leftParts := strings.Split(strings.TrimPrefix(left, "v"), ".")
	rightParts := strings.Split(strings.TrimPrefix(right, "v"), ".")
	for index := 0; index < len(leftParts) && index < len(rightParts); index++ {
		leftNumber, leftErr := strconv.Atoi(leftParts[index])
		rightNumber, rightErr := strconv.Atoi(rightParts[index])
		if leftErr != nil || rightErr != nil {
			return strings.Compare(left, right)
		}
		if leftNumber != rightNumber {
			return leftNumber - rightNumber
		}
	}
	return len(leftParts) - len(rightParts)
}

// Without the terminal PATH (a slow profile at boot times out), the user's own
// install directories come first so an older global install inherited from the
// app (e.g. /usr/local/bin/claude) does not shadow the user's current one.
func buildFallbackSearchPath(stabilizedInherited []string, home string) string {
	entries := userRuntimeDirectories(home)
	entries = append(entries, stabilizedInherited...)
	entries = append(entries, commonRuntimeDirectories(home)...)
	return strings.Join(deduplicatePathEntries(entries), string(os.PathListSeparator))
}

func deduplicatePathEntries(entries []string) []string {
	result := make([]string, 0, len(entries))
	seen := make(map[string]bool, len(entries))
	for _, entry := range entries {
		if entry == "" {
			continue
		}
		clean := filepath.Clean(entry)
		if seen[clean] {
			continue
		}
		seen[clean] = true
		result = append(result, clean)
	}
	return result
}

func stabilizePathEntries(entries []string, multishellPath string) []string {
	cleanMultishell := ""
	if multishellPath != "" && filepath.IsAbs(multishellPath) {
		cleanMultishell = filepath.Clean(multishellPath)
	}
	result := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry == "" {
			continue
		}
		result = append(result, stabilizeFnmMultishellEntry(entry, cleanMultishell))
	}
	return result
}

func stabilizeFnmMultishellEntry(entry, multishellPath string) string {
	clean := filepath.Clean(entry)
	if !filepath.IsAbs(clean) {
		return entry
	}
	linkPath, suffix, matched := matchFnmMultishellEntry(clean, multishellPath)
	if !matched {
		return clean
	}
	if resolved, ok := resolveFnmMultishellSymlink(linkPath, suffix); ok {
		return resolved
	}
	return clean
}

func matchFnmMultishellEntry(cleanEntry, multishellPath string) (linkPath, suffix string, matched bool) {
	if multishellPath != "" {
		if cleanEntry == multishellPath {
			return multishellPath, "", true
		}
		if cleanEntry == filepath.Join(multishellPath, "bin") {
			return multishellPath, "bin", true
		}
	}
	parent := filepath.Dir(cleanEntry)
	if filepath.Base(cleanEntry) == "bin" && filepath.Base(filepath.Dir(parent)) == fnmMultishellParentDir {
		return parent, "bin", true
	}
	if filepath.Base(parent) == fnmMultishellParentDir {
		return cleanEntry, "", true
	}
	return "", "", false
}

func resolveFnmMultishellSymlink(linkPath, suffix string) (string, bool) {
	info, err := os.Lstat(linkPath)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		return "", false
	}
	target, err := os.Readlink(linkPath)
	if err != nil || target == "" {
		return "", false
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(filepath.Dir(linkPath), target)
	}
	resolved := filepath.Clean(target)
	if suffix != "" {
		resolved = filepath.Join(resolved, suffix)
	}
	stat, err := os.Stat(resolved)
	if err != nil || !stat.IsDir() {
		return "", false
	}
	return resolved, true
}

func cleanupFnmMultishellSymlink(childPath, parentPath string) {
	if childPath == "" || !filepath.IsAbs(childPath) {
		return
	}
	cleanChild := filepath.Clean(childPath)
	if filepath.Base(filepath.Dir(cleanChild)) != fnmMultishellParentDir {
		return
	}
	if parentPath != "" && cleanChild == filepath.Clean(parentPath) {
		return
	}
	info, err := os.Lstat(cleanChild)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		return
	}
	_ = os.Remove(cleanChild)
}

// Capture PATH and allowlisted non-secret path metadata: shell stdout and
// credentials never enter diagnostics or wire payloads.
//
// Only the probe's own reported FNM_MULTISHELL_PATH symlink is removed; shared
// fnm_multishells directories are never diff-scanned on failure so concurrent
// user terminal sessions never lose active symlinks, and failure backoff bounds
// any leftover from a timed-out probe.
func captureTerminalPath(ctx context.Context, source map[string]string) (string, map[string]string, bool) {
	shell := source["SHELL"]
	if runtime.GOOS == "windows" || !filepath.IsAbs(shell) {
		return "", nil, false
	}

	bounded, cancel := context.WithTimeout(ctx, terminalPathCaptureTimeout)
	defer cancel()

	probeEnv := maps.Clone(source)
	if probeEnv == nil {
		probeEnv = make(map[string]string)
	}
	probeEnv["PATH"] = cleanProbePath
	delete(probeEnv, fnmMultishellEnvName)

	command := exec.CommandContext(bounded, shell, "-lic", terminalProbeScript)
	command.Env = environmentList(probeEnv)
	if home := source["HOME"]; filepath.IsAbs(home) {
		command.Dir = home
	}
	stdout := &boundedProbeBuffer{limit: maxProbeOutputBytes}
	stderr := &boundedProbeBuffer{limit: maxProbeOutputBytes}
	command.Stdout, command.Stderr = stdout, stderr
	runErr := process.Run(bounded, command, time.Second)
	captured, meta, ok := parseTerminalProbeOutput(stdout.String())
	if !ok {
		return "", nil, false
	}
	childMultishell := meta[fnmMultishellEnvName]
	delete(meta, fnmMultishellEnvName)
	defer cleanupFnmMultishellSymlink(childMultishell, source[fnmMultishellEnvName])

	if runErr != nil || stdout.overflow || stderr.overflow {
		return "", nil, false
	}
	stabilized := stabilizePathEntries(filepath.SplitList(captured), childMultishell)
	deduped := deduplicatePathEntries(stabilized)
	if len(deduped) == 0 {
		return "", nil, false
	}
	return strings.Join(deduped, string(os.PathListSeparator)), meta, true
}

func parseTerminalProbeOutput(output string) (string, map[string]string, bool) {
	_, rest, ok := strings.Cut(output, terminalProbeStartMarker)
	if !ok {
		return "", nil, false
	}
	payload, _, ok := strings.Cut(rest, terminalProbeEndMarker)
	if !ok {
		return "", nil, false
	}
	meta := make(map[string]string)
	var capturedPath string
	for _, field := range strings.Split(payload, "\x00") {
		if field == "" {
			continue
		}
		key, rawValue, hasEq := strings.Cut(field, "=")
		if !hasEq || strings.ContainsAny(rawValue, "\x00\r\n") {
			if key == "PATH" {
				return "", nil, false
			}
			continue
		}
		value := strings.TrimSpace(rawValue)
		if key == "PATH" {
			if value == "" {
				return "", nil, false
			}
			capturedPath = value
			continue
		}
		if allowedTerminalMetaKeys[key] && value != "" && filepath.IsAbs(value) {
			meta[key] = filepath.Clean(value)
		}
	}
	if capturedPath == "" {
		return "", nil, false
	}
	return capturedPath, meta, true
}

type watchedPathEntry struct {
	path       string
	exists     bool
	mode       os.FileMode
	size       int64
	modTime    int64
	isSymlink  bool
	linkTarget string
	targetOK   bool
	targetMode os.FileMode
	targetSize int64
	targetMod  int64
}

type terminalWatchSnapshot struct {
	entries []watchedPathEntry
}

func (s terminalWatchSnapshot) equal(other terminalWatchSnapshot) bool {
	return slices.Equal(s.entries, other.entries)
}

func lookupWatchMetadata(shellMeta, source map[string]string, key string) string {
	if value := shellMeta[key]; filepath.IsAbs(value) {
		return filepath.Clean(value)
	}
	if value := source[key]; filepath.IsAbs(value) {
		return filepath.Clean(value)
	}
	return ""
}

func takeTerminalWatchSnapshot(home string, shellMeta, source map[string]string) terminalWatchSnapshot {
	files, dirs := watchedTerminalPaths(home, shellMeta, source)
	seen := make(map[string]bool, len(files)+len(dirs)*2)
	var entries []watchedPathEntry
	addPath := func(path string) {
		if path == "" {
			return
		}
		clean := filepath.Clean(path)
		if seen[clean] {
			return
		}
		seen[clean] = true
		entries = append(entries, inspectWatchedPath(clean))
	}
	for _, file := range files {
		addPath(file)
	}
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		cleanDir := filepath.Clean(dir)
		addPath(cleanDir)
		dirEntries, err := os.ReadDir(cleanDir)
		if err != nil {
			continue
		}
		for _, entry := range dirEntries {
			addPath(filepath.Join(cleanDir, entry.Name()))
		}
	}
	slices.SortFunc(entries, func(left, right watchedPathEntry) int {
		return strings.Compare(left.path, right.path)
	})
	return terminalWatchSnapshot{entries: entries}
}

func watchedTerminalPaths(home string, shellMeta, source map[string]string) (files, dirs []string) {
	zshStartup := []string{".zshenv", ".zprofile", ".zshrc", ".zlogin"}
	posixStartup := []string{".bash_profile", ".bash_login", ".bashrc", ".profile"}

	if zdotdir := lookupWatchMetadata(shellMeta, source, "ZDOTDIR"); zdotdir != "" {
		for _, name := range zshStartup {
			files = append(files, filepath.Join(zdotdir, name))
		}
	}
	if filepath.IsAbs(home) {
		cleanHome := filepath.Clean(home)
		for _, name := range zshStartup {
			files = append(files, filepath.Join(cleanHome, name))
		}
		for _, name := range posixStartup {
			files = append(files, filepath.Join(cleanHome, name))
		}
		files = append(files,
			filepath.Join(cleanHome, ".config", "fish", "config.fish"),
			filepath.Join(cleanHome, ".config", "fish", "fish_variables"),
			filepath.Join(cleanHome, ".local", "share", "fnm", "aliases", "default"),
			filepath.Join(cleanHome, "Library", "Application Support", "fnm", "aliases", "default"),
			filepath.Join(cleanHome, ".nvm", "alias", "default"),
			filepath.Join(cleanHome, ".config", "mise", "config.toml"),
			filepath.Join(cleanHome, ".tool-versions"),
		)
		dirs = append(dirs, filepath.Join(cleanHome, ".config", "fish", "conf.d"))
	}
	if xdgConfig := lookupWatchMetadata(shellMeta, source, "XDG_CONFIG_HOME"); xdgConfig != "" {
		files = append(files,
			filepath.Join(xdgConfig, "fish", "config.fish"),
			filepath.Join(xdgConfig, "fish", "fish_variables"),
			filepath.Join(xdgConfig, "nvm", "alias", "default"),
			filepath.Join(xdgConfig, "mise", "config.toml"),
		)
		dirs = append(dirs, filepath.Join(xdgConfig, "fish", "conf.d"))
	}
	if xdgData := lookupWatchMetadata(shellMeta, source, "XDG_DATA_HOME"); xdgData != "" {
		files = append(files, filepath.Join(xdgData, "fnm", "aliases", "default"))
	}
	if fnmDir := lookupWatchMetadata(shellMeta, source, "FNM_DIR"); fnmDir != "" {
		files = append(files, filepath.Join(fnmDir, "aliases", "default"))
	}
	if nvmDir := lookupWatchMetadata(shellMeta, source, "NVM_DIR"); nvmDir != "" {
		files = append(files, filepath.Join(nvmDir, "alias", "default"))
	}
	if miseConfig := lookupWatchMetadata(shellMeta, source, "MISE_CONFIG_DIR"); miseConfig != "" {
		files = append(files, filepath.Join(miseConfig, "config.toml"))
	}
	if systemPathsFile != "" {
		files = append(files, systemPathsFile)
	}
	if systemPathsDir != "" {
		dirs = append(dirs, systemPathsDir)
	}
	return files, dirs
}

func inspectWatchedPath(path string) watchedPathEntry {
	info, err := os.Lstat(path)
	if err != nil {
		return watchedPathEntry{path: path}
	}
	entry := watchedPathEntry{
		path:    path,
		exists:  true,
		mode:    info.Mode(),
		size:    info.Size(),
		modTime: info.ModTime().UnixNano(),
	}
	if info.Mode()&os.ModeSymlink != 0 {
		entry.isSymlink = true
		entry.linkTarget, _ = os.Readlink(path)
		if targetInfo, statErr := os.Stat(path); statErr == nil {
			entry.targetOK = true
			entry.targetMode = targetInfo.Mode()
			entry.targetSize = targetInfo.Size()
			entry.targetMod = targetInfo.ModTime().UnixNano()
		}
	}
	return entry
}
