// Package localmodels runs the installer's localmodels tool for the Daemon.
// It reads `library status`, starts the library actions a Computer owner
// chose, supervises the long ones (download, load), and maps the tool's
// localmodels.library-status/v1 into the Runner Gateway LocalModelsSnapshot.
// It never chooses a model: every action names the model the owner picked.
package localmodels

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

const (
	defaultBifrostHost = "127.0.0.1"
	defaultBifrostPort = 18480
	defaultBifrostAddr = "127.0.0.1:18480"
	maxOwnedFileBytes  = 1 << 20
	maxAddrFileBytes   = 256
	maxMarkerFileBytes = 4096
)

var (
	bifrostAddrMu   sync.Mutex
	bifrostPortFree = loopbackPortFree
	bifrostPickPort = allocateBifrostPort
)

// HarnessRoot returns the shared runtime/harness directory sibling to a
// localmodels StateDirectory, or an empty string when stateDir is unset.
func HarnessRoot(stateDir string) string {
	if stateDir == "" {
		return ""
	}
	return filepath.Clean(filepath.Join(stateDir, "..", "..", "harness"))
}

// ToolsDirectory returns the localmodels tools directory sibling to a
// localmodels StateDirectory, or an empty string when stateDir is unset.
func ToolsDirectory(stateDir string) string {
	if stateDir == "" {
		return ""
	}
	return filepath.Clean(filepath.Join(stateDir, "..", "tools"))
}

// BifrostDirectory returns the Bifrost application directory sibling to a
// localmodels StateDirectory, or an empty string when stateDir is unset.
func BifrostDirectory(stateDir string) string {
	if stateDir == "" {
		return ""
	}
	return filepath.Clean(filepath.Join(stateDir, "..", "bifrost"))
}

// BifrostAddrFile returns the persisted loopback Bifrost address file sibling
// to a localmodels StateDirectory, or an empty string when stateDir is unset.
func BifrostAddrFile(stateDir string) string {
	if stateDir == "" {
		return ""
	}
	return filepath.Clean(filepath.Join(stateDir, "..", "bifrost-addr"))
}

// LegacyToolsMarkerFile returns the file in which the installer records the
// shared tools directory a home kept from before per-home isolation, sibling
// to a localmodels StateDirectory, or an empty string when stateDir is unset.
func LegacyToolsMarkerFile(stateDir string) string {
	if stateDir == "" {
		return ""
	}
	return filepath.Clean(filepath.Join(stateDir, "..", "tools-dir"))
}

// Tool is where the installer put the localmodels tool and its state, as
// the Computer config records it.
type Tool struct {
	Python           string
	ModuleDirectory  string
	StateDirectory   string
	BaseDirectory    string
	BundledPiBinDir  string
	BundledPiVersion string
}

// Action is one owner-chosen library action. Model is empty only for
// refresh and custom_download; UnloadFirst and Force are only for load;
// ContextTokens is for load or smoke_test; CustomDownload is only for
// custom_download.
type Action struct {
	Name           string
	Model          string
	UnloadFirst    []string
	Force          bool
	ContextTokens  uint64
	CustomDownload *wire.LocalModelCustomDownloadInput
}

// Action names, as the Runner Gateway sends them.
const (
	ActionDownload       = "download"
	ActionCancel         = "cancel"
	ActionLoad           = "load"
	ActionUnload         = "unload"
	ActionRemove         = "remove"
	ActionRefresh        = "refresh"
	ActionSmokeTest      = "smoke_test"
	ActionCustomDownload = "custom_download"
)

// arguments are the `library` arguments of one call. Model ids are validated
// by the caller, so none starts with "-". Transient hub tokens are never
// placed on argv; custom_download receives its JSON input on stdin.
func (t Tool) arguments(action Action) []string {
	args := []string{"-P", "-s", "-m", "localmodels", "library"}
	switch action.Name {
	case ActionRefresh:
		return append(args, "status", "--base-dir", t.BaseDirectory, "--json")
	case ActionDownload:
		return append(args, "download", action.Model, "--base-dir", t.BaseDirectory, "--jsonl")
	case ActionCustomDownload:
		return append(args, "custom", "download", "--config-stdin", "--base-dir", t.BaseDirectory, "--jsonl")
	case ActionSmokeTest:
		ctxTokens := action.ContextTokens
		if ctxTokens == 0 {
			ctxTokens = 4096
		}
		return append(args, "smoke-test", action.Model, "--ctx", strconv.FormatUint(ctxTokens, 10), "--base-dir", t.BaseDirectory, "--jsonl")
	case ActionLoad:
		args = append(args, "load", action.Model)
		for _, other := range action.UnloadFirst {
			args = append(args, "--unload", other)
		}
		if action.Force {
			args = append(args, "--force")
		}
		if action.ContextTokens > 0 {
			args = append(args, "--ctx", strconv.FormatUint(action.ContextTokens, 10))
		}
		return append(args, "--base-dir", t.BaseDirectory, "--jsonl")
	default:
		return append(args, action.Name, action.Model, "--base-dir", t.BaseDirectory, "--json")
	}
}

// command builds one library invocation for the tool.
func (t Tool) command(environment map[string]string, action Action) *exec.Cmd {
	return t.commandArgs(environment, t.arguments(action))
}

// commandArgs builds one tool invocation the way the installer runs it: the
// sealed kit on PYTHONPATH and as the working directory, no user site
// packages, no bytecode writes into the sealed kit, forced UTF-8 mode so Python
// never falls back to a legacy Windows ANSI code page, per-home isolated
// LOCALMODELS_* directories and Bifrost address, and PI_CODING_AGENT_DIR aligned
// with the Pi profile the Daemon discovers. When model-source.json exists
// (byok, subscription, or local), PI_CODING_AGENT_DIR is isolated through the
// shared localGatewayPiProfile helper (omitted when no managed gateway-home
// exists yet so localmodels writes into this home's tools/gateway-home/.pi/agent
// without colliding with byok-home or personal ~/.pi/agent). When no
// model-source.json exists yet, it follows workspace.PiSourceEnvironment on the
// base environment (stripping any stale byok-home) so tool writes and Runtime
// discovery stay on the same profile.
func (t Tool) commandArgs(environment map[string]string, args []string) *exec.Cmd {
	cmd := exec.Command(t.Python, args...)
	cmd.Dir = t.ModuleDirectory
	effective := make(map[string]string, len(environment)+10)
	for key, value := range environment {
		switch strings.ToUpper(key) {
		case "PYTHONHOME", "PYTHONSTARTUP", "PYTHONINSPECT", "PYTHONPATH",
			"PYTHONUTF8", "PYTHONIOENCODING",
			"LOCALMODELS_STATE", "LOCALMODELS_TOOLS_DIR", "LOCALMODELS_BIFROST_DIR", "LOCALMODELS_BIFROST_ADDR",
			"PI_CODING_AGENT_DIR":
			continue
		}
		effective[key] = value
	}
	effective["PYTHONPATH"] = t.ModuleDirectory
	effective["LOCALMODELS_STATE"] = t.StateDirectory
	overlay := ReadOverlay(t.StateDirectory)
	legacy := legacyLoadedGateway(t.StateDirectory, environment, overlay)
	if legacy != nil {
		effective["LOCALMODELS_TOOLS_DIR"] = legacy.toolsDir
		if legacy.bifrostDir != "" {
			effective["LOCALMODELS_BIFROST_DIR"] = legacy.bifrostDir
		}
		if legacy.addr != "" {
			effective["LOCALMODELS_BIFROST_ADDR"] = legacy.addr
		}
	} else if t.StateDirectory != "" {
		toolsDir := ToolsDirectory(t.StateDirectory)
		bifrostDir := BifrostDirectory(t.StateDirectory)
		ensureSiblingDirectories(t.StateDirectory, toolsDir, bifrostDir)
		effective["LOCALMODELS_TOOLS_DIR"] = toolsDir
		effective["LOCALMODELS_BIFROST_DIR"] = bifrostDir
		effective["LOCALMODELS_BIFROST_ADDR"] = resolveBifrostAddr(
			t.StateDirectory,
			toolsDir,
			!isReadOnlyOrStopSubcommand(args),
		)
	}
	if overlay == nil && legacy == nil {
		baseForPi := make(map[string]string, len(environment))
		for key, value := range environment {
			if strings.EqualFold(key, "PI_CODING_AGENT_DIR") {
				trimmed := strings.TrimSpace(value)
				if trimmed == "" || isManagedProfilePath(t.StateDirectory, trimmed, "byok-home") {
					continue
				}
				baseForPi["PI_CODING_AGENT_DIR"] = trimmed
				continue
			}
			baseForPi[key] = value
		}
		if piEnv, err := workspace.PiSourceEnvironment(baseForPi); err == nil && piEnv["PI_CODING_AGENT_DIR"] != "" {
			effective["PI_CODING_AGENT_DIR"] = piEnv["PI_CODING_AGENT_DIR"]
		}
	} else if piProfile := localGatewayPiProfile(environment, t.StateDirectory, overlay, legacy); piProfile != "" {
		effective["PI_CODING_AGENT_DIR"] = piProfile
	}
	effective["PYTHONNOUSERSITE"] = "1"
	effective["PYTHONDONTWRITEBYTECODE"] = "1"
	effective["PYTHONUTF8"] = "1"
	effective["PYTHONIOENCODING"] = "utf-8"
	if t.BundledPiBinDir != "" && !isSetupInspectArgs(args) {
		appendBundledPiPath(effective, t.StateDirectory, t.BundledPiBinDir, t.BundledPiVersion)
	}
	cmd.Env = make([]string, 0, len(effective))
	for key, value := range effective {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	return cmd
}

type versionedPiDir struct {
	version string
	dir     string
}

func newerHarnessPiDirs(stateDir, bundledVersion string) []string {
	harness := HarnessRoot(stateDir)
	if harness == "" || !parseVersionName(bundledVersion).isVersion {
		return nil
	}
	piToolsDir := filepath.Join(harness, "tools", "pi")
	entries, err := os.ReadDir(piToolsDir)
	if err != nil {
		return nil
	}
	var matched []versionedPiDir
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		if !parseVersionName(name).isVersion || compareVersionNames(name, bundledVersion) <= 0 {
			continue
		}
		versionDir := filepath.Join(piToolsDir, name)
		if !dirExists(versionDir) || harnessExecutableInDir(versionDir, "pi") == "" {
			continue
		}
		matched = append(matched, versionedPiDir{version: name, dir: versionDir})
	}
	slices.SortFunc(matched, func(a, b versionedPiDir) int {
		return compareVersionNames(b.version, a.version)
	})
	dirs := make([]string, 0, len(matched))
	for _, item := range matched {
		dirs = append(dirs, item.dir)
	}
	return dirs
}

func appendBundledPiPath(effective map[string]string, stateDir, bundledBinDir, bundledVersion string) {
	pathKey := "PATH"
	var existing []string
	if runtime.GOOS == "windows" {
		var keys []string
		for key := range effective {
			if strings.EqualFold(key, "PATH") {
				keys = append(keys, key)
			}
		}
		slices.Sort(keys)
		if len(keys) > 0 {
			pathKey = keys[0]
			for _, key := range keys {
				if key == "PATH" {
					pathKey = "PATH"
					break
				}
			}
			for _, key := range keys {
				if value := effective[key]; value != "" {
					existing = append(existing, filepath.SplitList(value)...)
				}
				if key != pathKey {
					delete(effective, key)
				}
			}
		}
	} else if value := effective["PATH"]; value != "" {
		existing = filepath.SplitList(value)
	}

	candidates := append([]string(nil), existing...)
	userHome := workspace.EnvLookup(effective, "HOME")
	if userHome == "" {
		userHome = workspace.EnvLookup(effective, "USERPROFILE")
	}
	if userHome == "" {
		userHome, _ = os.UserHomeDir()
	}
	if userHome != "" {
		if localBin := filepath.Join(userHome, ".local", "bin"); dirExists(localBin) {
			candidates = append(candidates, localBin)
		}
	}
	if runtime.GOOS == "windows" {
		if appData := workspace.EnvLookup(effective, "APPDATA"); appData != "" {
			if npmBin := filepath.Join(appData, "npm"); dirExists(npmBin) {
				candidates = append(candidates, npmBin)
			}
		}
	}
	candidates = append(candidates, newerHarnessPiDirs(stateDir, bundledVersion)...)
	candidates = append(candidates, ensureStableBundledPiBinDir(stateDir, bundledBinDir))

	seen := make(map[string]struct{}, len(candidates))
	deduped := make([]string, 0, len(candidates))
	for _, entry := range candidates {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		normalized := filepath.Clean(trimmed)
		if runtime.GOOS == "windows" {
			normalized = strings.ToLower(normalized)
		}
		if _, dup := seen[normalized]; dup {
			continue
		}
		seen[normalized] = struct{}{}
		deduped = append(deduped, entry)
	}
	effective[pathKey] = strings.Join(deduped, string(os.PathListSeparator))
}

func ensureStableBundledPiBinDir(stateDir, bundledBinDir string) string {
	if runtime.GOOS == "windows" || stateDir == "" || bundledBinDir == "" || !filepath.IsAbs(stateDir) || !filepath.IsAbs(bundledBinDir) {
		return bundledBinDir
	}
	target := filepath.Clean(filepath.Join(bundledBinDir, "pi"))
	runtimeDir := filepath.Dir(filepath.Dir(filepath.Clean(stateDir)))
	bundledRoot := filepath.Join(runtimeDir, "bundled-pi")
	binDir := filepath.Join(bundledRoot, "bin")
	linkPath := filepath.Join(binDir, "pi")
	if target == linkPath {
		return binDir
	}
	if currentTarget, err := os.Readlink(linkPath); err == nil && currentTarget == target {
		return binDir
	}
	if err := privatefs.EnsureDir(bundledRoot); err != nil {
		return bundledBinDir
	}
	if err := privatefs.EnsureDir(binDir); err != nil {
		return bundledBinDir
	}
	var nonce [8]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return bundledBinDir
	}
	tempLink := filepath.Join(binDir, ".pi."+hex.EncodeToString(nonce[:])+".tmp")
	if err := os.Symlink(target, tempLink); err != nil {
		return bundledBinDir
	}
	if err := os.Rename(tempLink, linkPath); err != nil {
		_ = os.Remove(tempLink)
		return bundledBinDir
	}
	return binDir
}

func isSetupInspectArgs(args []string) bool {
	sub := localmodelsSubcommand(args)
	for i := 0; i+1 < len(sub); i++ {
		if sub[i] == "setup" && sub[i+1] == "inspect" {
			return true
		}
	}
	return false
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func ensureSiblingDirectories(stateDir, toolsDir, bifrostDir string) {
	parentDir := filepath.Dir(filepath.Clean(stateDir))
	if !dirExists(parentDir) {
		return
	}
	_ = privatefs.EnsureDir(parentDir)
	_ = privatefs.EnsureDir(toolsDir)
	_ = privatefs.EnsureDir(bifrostDir)
}

func localmodelsSubcommand(args []string) []string {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "-m" && args[i+1] == "localmodels" {
			return args[i+2:]
		}
	}
	return args
}

func isReadOnlyOrStopSubcommand(args []string) bool {
	sub := localmodelsSubcommand(args)
	if len(sub) == 0 {
		return true
	}
	group := sub[0]
	verb := ""
	if len(sub) > 1 {
		verb = sub[1]
	}
	switch group {
	case "harness", "debug":
		return true
	case "stack":
		return verb == "down" || verb == "remove"
	case "library":
		if verb == "custom" && len(sub) > 2 {
			return sub[2] == "search" || sub[2] == "probe"
		}
		return verb == "status" || verb == "unload" || verb == "remove" || verb == "cancel"
	case "speech":
		return verb == "status" || verb == "unload" || verb == "remove" || verb == "cancel" || verb == "stop"
	case "foundations":
		return verb == "stop"
	case "gateway":
		return verb == "stop"
	case "source":
		return verb == "status" || verb == "check" || verb == "models"
	case "setup":
		return verb == "inspect" || verb == "review" || verb == "binding"
	default:
		return false
	}
}

func parseLoopbackBifrostAddr(raw string) (string, int, bool) {
	trimmed := strings.TrimSpace(raw)
	portStr, ok := strings.CutPrefix(trimmed, defaultBifrostHost+":")
	if !ok || portStr == "" || len(portStr) > 5 || portStr[0] == '0' {
		return "", 0, false
	}
	for i := range len(portStr) {
		if portStr[i] < '0' || portStr[i] > '9' {
			return "", 0, false
		}
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		return "", 0, false
	}
	return fmt.Sprintf("%s:%d", defaultBifrostHost, port), port, true
}

type ownedBifrostRecord struct {
	addr   string
	port   int
	appDir string
}

// readOwnedBifrostRecord reads gateway.bifrost from <toolsDir>/owned.json.
// localmodels writes owned.json under the process umask rather than 0600, so
// this checks for a regular non-symlink file inside the tools dir.
func readOwnedBifrostRecord(toolsDir string) (ownedBifrostRecord, bool) {
	if toolsDir == "" {
		return ownedBifrostRecord{}, false
	}
	ownedPath := filepath.Join(toolsDir, "owned.json")
	info, err := os.Lstat(ownedPath)
	if err != nil || !info.Mode().IsRegular() {
		return ownedBifrostRecord{}, false
	}
	raw, err := readBounded(ownedPath, maxOwnedFileBytes)
	if err != nil {
		return ownedBifrostRecord{}, false
	}
	var doc struct {
		Gateway struct {
			Bifrost *struct {
				Addr   string `json:"addr"`
				AppDir string `json:"app_dir"`
			} `json:"bifrost"`
		} `json:"gateway"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil || doc.Gateway.Bifrost == nil {
		return ownedBifrostRecord{}, false
	}
	addr, port, ok := parseLoopbackBifrostAddr(doc.Gateway.Bifrost.Addr)
	if !ok {
		return ownedBifrostRecord{}, false
	}
	appDir := strings.TrimSpace(doc.Gateway.Bifrost.AppDir)
	if appDir != "" && filepath.IsAbs(appDir) {
		appDir = filepath.Clean(appDir)
	} else {
		appDir = ""
	}
	return ownedBifrostRecord{addr: addr, port: port, appDir: appDir}, true
}

func readOwnedBifrostAddr(toolsDir string) (string, int, bool) {
	rec, ok := readOwnedBifrostRecord(toolsDir)
	if !ok {
		return "", 0, false
	}
	return rec.addr, rec.port, true
}

type legacyGateway struct {
	toolsDir   string
	bifrostDir string
	addr       string
	piProfile  string
}

func loadedLibraryProviders(stateDir string) map[string]struct{} {
	modelsDir := filepath.Join(stateDir, "library", "models")
	entries, err := os.ReadDir(modelsDir)
	if err != nil {
		return nil
	}
	providers := make(map[string]struct{})
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(modelsDir, entry.Name())
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		raw, err := readBounded(path, maxOwnedFileBytes)
		if err != nil {
			continue
		}
		var doc struct {
			State        string `json:"state"`
			Registration *struct {
				Provider string `json:"provider"`
			} `json:"registration"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			continue
		}
		if doc.State == "loaded" && doc.Registration != nil && doc.Registration.Provider != "" {
			providers[doc.Registration.Provider] = struct{}{}
		}
	}
	return providers
}

func bifrostConfigHasAnyProvider(appDir string, wanted map[string]struct{}) bool {
	if appDir == "" || len(wanted) == 0 {
		return false
	}
	cfgPath := filepath.Join(appDir, "config.json")
	info, err := os.Lstat(cfgPath)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	raw, err := readBounded(cfgPath, maxOwnedFileBytes)
	if err != nil {
		return false
	}
	var doc struct {
		Providers map[string]json.RawMessage `json:"providers"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return false
	}
	for provider := range wanted {
		if _, ok := doc.Providers[provider]; ok {
			return true
		}
	}
	return false
}

func toolsDirFromGatewayPiProfile(piDir string) string {
	if piDir == "" || !filepath.IsAbs(piDir) {
		return ""
	}
	cleaned := filepath.Clean(piDir)
	if !strings.EqualFold(filepath.Base(cleaned), "agent") {
		return ""
	}
	piParent := filepath.Dir(cleaned)
	if !strings.EqualFold(filepath.Base(piParent), ".pi") {
		return ""
	}
	gatewayHome := filepath.Dir(piParent)
	if !strings.EqualFold(filepath.Base(gatewayHome), "gateway-home") {
		return ""
	}
	return filepath.Dir(gatewayHome)
}

// defaultLegacyToolsDir is localmodels' own default tools directory,
// TOOLS_DIR = ~/.local/share/localmodels/tools expanded the way Python's
// expanduser does: USERPROFILE on Windows, HOME elsewhere.
func defaultLegacyToolsDir(baseEnv map[string]string) string {
	homeKey := "HOME"
	if runtime.GOOS == "windows" {
		homeKey = "USERPROFILE"
	}
	home := workspace.EnvLookup(baseEnv, homeKey)
	if home == "" || !filepath.IsAbs(home) {
		return ""
	}
	return filepath.Join(filepath.Clean(home), ".local", "share", "localmodels", "tools")
}

// legacyLoadedGateway preserves continuity for upgraded hosts whose loaded
// models are still registered in the platform's default legacy tool directory
// or a gateway recorded in local-mode model-source.json.
func legacyLoadedGateway(stateDir string, baseEnv map[string]string, overlay *OverlayState) *legacyGateway {
	if stateDir == "" {
		return nil
	}
	if marked := markedLegacyGateway(stateDir); marked != nil {
		return marked
	}
	isolatedTools := ToolsDirectory(stateDir)
	if _, _, owned := readOwnedBifrostAddr(isolatedTools); owned {
		return nil
	}
	loadedProviders := loadedLibraryProviders(stateDir)
	if len(loadedProviders) == 0 {
		return nil
	}
	candidates := make([]string, 0, 2)
	addCandidate := func(dir string) {
		if dir == "" || !filepath.IsAbs(dir) {
			return
		}
		cleaned := filepath.Clean(dir)
		if cleaned == isolatedTools {
			return
		}
		for _, existing := range candidates {
			if existing == cleaned {
				return
			}
		}
		candidates = append(candidates, cleaned)
	}
	if overlay != nil && overlay.Mode == "local" {
		addCandidate(toolsDirFromGatewayPiProfile(overlay.Environment["PI_CODING_AGENT_DIR"]))
	}
	addCandidate(defaultLegacyToolsDir(baseEnv))

	for _, toolsDir := range candidates {
		rec, ok := readOwnedBifrostRecord(toolsDir)
		if !ok || rec.appDir == "" {
			continue
		}
		if overlay != nil && overlay.Mode == "local" && overlay.GatewayURL != "" {
			if strings.TrimRight(overlay.GatewayURL, "/") != "http://"+rec.addr {
				continue
			}
		}
		if !bifrostConfigHasAnyProvider(rec.appDir, loadedProviders) {
			continue
		}
		piProfile := filepath.Join(toolsDir, "gateway-home", ".pi", "agent")
		if !dirExists(piProfile) {
			piProfile = ""
		}
		return &legacyGateway{
			toolsDir:   toolsDir,
			bifrostDir: rec.appDir,
			addr:       rec.addr,
			piProfile:  piProfile,
		}
	}
	return nil
}

// markedLegacyGateway follows the installer's record of a home that still
// runs from the shared tools directory its plan was applied in, so the Daemon
// reads the same deployments, Pi profile and Bifrost as the installer. Only
// what that directory's owned.json records is set; localmodels keeps its own
// defaults for the rest, as when the plan was applied.
func markedLegacyGateway(stateDir string) *legacyGateway {
	raw, err := privatefs.ReadFile(LegacyToolsMarkerFile(stateDir), maxMarkerFileBytes)
	if err != nil {
		return nil
	}
	toolsDir := strings.TrimSpace(string(raw))
	if toolsDir == "" || !filepath.IsAbs(toolsDir) {
		return nil
	}
	toolsDir = filepath.Clean(toolsDir)
	gateway := &legacyGateway{toolsDir: toolsDir}
	if rec, ok := readOwnedBifrostRecord(toolsDir); ok {
		gateway.bifrostDir = rec.appDir
		gateway.addr = rec.addr
	}
	if piProfile := filepath.Join(toolsDir, "gateway-home", ".pi", "agent"); dirExists(piProfile) {
		gateway.piProfile = piProfile
	}
	return gateway
}

func readSavedBifrostAddr(addrFile string) (string, int, bool) {
	if addrFile == "" {
		return "", 0, false
	}
	raw, err := privatefs.ReadFile(addrFile, maxAddrFileBytes)
	if err != nil {
		return "", 0, false
	}
	return parseLoopbackBifrostAddr(string(raw))
}

func resolveBifrostAddr(stateDir, toolsDir string, allocate bool) string {
	if allocate {
		bifrostAddrMu.Lock()
		defer bifrostAddrMu.Unlock()
	}
	if addr, _, ok := readOwnedBifrostAddr(toolsDir); ok {
		return addr
	}
	addrFile := BifrostAddrFile(stateDir)
	if addr, port, ok := readSavedBifrostAddr(addrFile); ok {
		if !allocate || bifrostPortFree(port) {
			return addr
		}
	}
	if !allocate {
		return defaultBifrostAddr
	}
	port, ok := bifrostPickPort(defaultBifrostPort)
	if !ok {
		return defaultBifrostAddr
	}
	addr := fmt.Sprintf("%s:%d", defaultBifrostHost, port)
	parentDir := filepath.Dir(filepath.Clean(stateDir))
	if dirExists(parentDir) {
		_ = privatefs.EnsureDir(parentDir)
		_ = privatefs.WriteFile(addrFile, []byte(addr+"\n"), false)
	}
	return addr
}

// rotateUnownedBifrostAddr moves bifrost-addr onto a fresh free port after a
// gateway registration failure when this home does not yet own a Bifrost
// instance, so retries never deadlock on a port rejected by localmodels.
func (t Tool) rotateUnownedBifrostAddr() {
	if t.StateDirectory == "" {
		return
	}
	bifrostAddrMu.Lock()
	defer bifrostAddrMu.Unlock()
	if _, _, owned := readOwnedBifrostAddr(ToolsDirectory(t.StateDirectory)); owned {
		return
	}
	addrFile := BifrostAddrFile(t.StateDirectory)
	exclude := defaultBifrostPort
	if _, savedPort, ok := readSavedBifrostAddr(addrFile); ok {
		exclude = savedPort
	}
	port, ok := allocateBifrostPortExcluding(0, exclude)
	if !ok {
		return
	}
	parentDir := filepath.Dir(filepath.Clean(t.StateDirectory))
	if dirExists(parentDir) {
		_ = privatefs.EnsureDir(parentDir)
		_ = privatefs.WriteFile(addrFile, []byte(fmt.Sprintf("%s:%d\n", defaultBifrostHost, port)), false)
	}
}

func allocateBifrostPort(preferred int) (int, bool) {
	return allocateBifrostPortExcluding(preferred, 0)
}

func allocateBifrostPortExcluding(preferred, exclude int) (int, bool) {
	if preferred >= 1024 && preferred <= 65535 && preferred != exclude && bifrostPortFree(preferred) {
		return preferred, true
	}
	for range 100 {
		listener, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			continue
		}
		addr, ok := listener.Addr().(*net.TCPAddr)
		_ = listener.Close()
		if !ok || addr.Port <= 0 || addr.Port == exclude {
			continue
		}
		if bifrostPortFree(addr.Port) {
			return addr.Port, true
		}
	}
	return 0, false
}

func loopbackPortFree(port int) bool {
	v4Addr := fmt.Sprintf("%s:%d", defaultBifrostHost, port)
	if !bindLoopbackFree("tcp4", v4Addr, false) {
		return false
	}
	v6Addr := fmt.Sprintf("[::1]:%d", port)
	if !bindLoopbackFree("tcp6", v6Addr, true) {
		return false
	}
	if loopbackAnswers("tcp4", v4Addr) || loopbackAnswers("tcp6", v6Addr) {
		return false
	}
	return nonLoopbackPortFree(port)
}

func bindLoopbackFree(network, address string, allowMissingIPv6 bool) bool {
	listener, err := net.Listen(network, address)
	if err == nil {
		_ = listener.Close()
		return true
	}
	if !allowMissingIPv6 {
		return false
	}
	// When an ephemeral IPv6 loopback bind also fails, this host has no ::1.
	probe, probeErr := net.Listen("tcp6", "[::1]:0")
	if probeErr != nil {
		return true
	}
	_ = probe.Close()
	return false
}

func loopbackAnswers(network, address string) bool {
	conn, err := net.DialTimeout(network, address, 200*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// runBuffered executes localmodels with stdout and stderr redirected to
// temporary files (never pipes) so any background gateway child spawned by
// localmodels survives after the CLI process exits.
func (t Tool) runBuffered(
	ctx context.Context,
	environment map[string]string,
	tempDir, prefix string,
	maxBytes int64,
	args []string,
	stdin []byte,
) (stdoutBytes, stderrBytes []byte, exitCode int, err error) {
	if tempDir != "" {
		if mkErr := os.MkdirAll(tempDir, 0o700); mkErr != nil {
			return nil, nil, -1, mkErr
		}
	}
	stdout, err := os.CreateTemp(tempDir, prefix+"-*.out")
	if err != nil {
		return nil, nil, -1, err
	}
	defer func() { _ = os.Remove(stdout.Name()) }()
	stderr, err := os.CreateTemp(tempDir, prefix+"-*.err")
	if err != nil {
		_ = stdout.Close()
		return nil, nil, -1, err
	}
	defer func() { _ = os.Remove(stderr.Name()) }()

	cmd := t.commandArgs(environment, args)
	if len(stdin) > 0 {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	process.Prepare(cmd)
	startErr := cmd.Start()
	_ = stdout.Close()
	_ = stderr.Close()
	if startErr != nil {
		return nil, nil, -1, startErr
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	select {
	case <-exited:
	case <-ctx.Done():
		_ = cmd.Process.Kill()
		<-exited
		return nil, nil, -1, context.Cause(ctx)
	}
	code := cmd.ProcessState.ExitCode()
	out, readErr := readBounded(stdout.Name(), maxBytes)
	var errOut []byte
	if code != 0 {
		if diagnostic, diagErr := readBounded(stderr.Name(), 4096); diagErr == nil {
			errOut = diagnostic
		}
	}
	return out, errOut, code, readErr
}

// installed reports whether the configured interpreter still exists.
func (t Tool) installed() bool {
	info, err := os.Stat(t.Python)
	return err == nil && info.Mode().IsRegular()
}

// CustomHubError reports a structured failure from a synchronous custom hub
// search or probe call. Message is always scrubbed of transient tokens.
type CustomHubError struct {
	Code      string
	Message   string
	Retryable bool
}

func (e *CustomHubError) Error() string {
	if e.Message != "" {
		return e.Code + ": " + e.Message
	}
	return e.Code
}

const (
	customSearchSchema = "localmodels.library-custom-search/v1"
	customProbeSchema  = "localmodels.library-custom-probe/v1"
	maxCustomOutput    = 4 << 20
)

func (t Tool) runCustomSearch(
	ctx context.Context,
	environment map[string]string,
	tempDir string,
	req wire.LocalModelCustomSearchInput,
) (wire.LocalModelCustomSearchResult, error) {
	if !t.installed() {
		return wire.LocalModelCustomSearchResult{}, &CustomHubError{
			Code:    CodeToolNotInstalled,
			Message: "The localmodels tool is not installed on this Computer.",
		}
	}
	stdin, err := json.Marshal(req)
	if err != nil {
		return wire.LocalModelCustomSearchResult{}, &CustomHubError{
			Code:    "INVALID_REPO_SPEC",
			Message: "Custom model search input is invalid.",
		}
	}
	defer clear(stdin)
	args := []string{"-P", "-s", "-m", "localmodels", "library", "custom", "search", "--config-stdin", "--base-dir", t.BaseDirectory, "--json"}
	stdout, stderrBytes, exitCode, runErr := t.runBuffered(ctx, environment, tempDir, "custom-search", maxCustomOutput, args, stdin)
	if exitCode != 0 && len(stderrBytes) > 0 {
		slog.Debug("local_models.tool_stderr", "action", "custom_search", "stderr", redact.TextWithSecrets(string(stderrBytes), req.Token))
	}
	if runErr != nil {
		if errors.Is(runErr, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return wire.LocalModelCustomSearchResult{}, &CustomHubError{
				Code:      "HUB_UNREACHABLE",
				Message:   "Custom model search timed out on this Computer.",
				Retryable: true,
			}
		}
		return wire.LocalModelCustomSearchResult{}, &CustomHubError{
			Code:      CodeToolFailed,
			Message:   "Could not run custom model search on this Computer.",
			Retryable: true,
		}
	}
	doc := lastJSONDocument(stdout)
	if exitCode != 0 {
		return wire.LocalModelCustomSearchResult{}, parseCustomHubFailure(doc, "Custom model search failed on this Computer.", req.Token)
	}
	var envelope struct {
		Schema string `json:"schema"`
		OK     bool   `json:"ok"`
	}
	if len(doc) == 0 || json.Unmarshal(doc, &envelope) != nil || envelope.Schema != customSearchSchema || !envelope.OK {
		return wire.LocalModelCustomSearchResult{}, parseCustomHubFailure(doc, "Custom model search returned an unreadable response.", req.Token)
	}
	var result wire.LocalModelCustomSearchResult
	if err := json.Unmarshal(doc, &result); err != nil {
		return wire.LocalModelCustomSearchResult{}, &CustomHubError{
			Code:      CodeToolFailed,
			Message:   "Custom model search returned an unreadable response.",
			Retryable: true,
		}
	}
	return sanitizeCustomSearchResult(result, req.Token), nil
}

func (t Tool) runCustomProbe(
	ctx context.Context,
	environment map[string]string,
	tempDir string,
	req wire.LocalModelCustomProbeInput,
) (wire.LocalModelCustomProbeResult, error) {
	if !t.installed() {
		return wire.LocalModelCustomProbeResult{}, &CustomHubError{
			Code:    CodeToolNotInstalled,
			Message: "The localmodels tool is not installed on this Computer.",
		}
	}
	stdin, err := json.Marshal(req)
	if err != nil {
		return wire.LocalModelCustomProbeResult{}, &CustomHubError{
			Code:    "INVALID_REPO_SPEC",
			Message: "Custom model probe input is invalid.",
		}
	}
	defer clear(stdin)
	args := []string{"-P", "-s", "-m", "localmodels", "library", "custom", "probe", "--config-stdin", "--base-dir", t.BaseDirectory, "--json"}
	stdout, stderrBytes, exitCode, runErr := t.runBuffered(ctx, environment, tempDir, "custom-probe", maxCustomOutput, args, stdin)
	if exitCode != 0 && len(stderrBytes) > 0 {
		slog.Debug("local_models.tool_stderr", "action", "custom_probe", "stderr", redact.TextWithSecrets(string(stderrBytes), req.Token))
	}
	if runErr != nil {
		if errors.Is(runErr, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return wire.LocalModelCustomProbeResult{}, &CustomHubError{
				Code:      "HUB_UNREACHABLE",
				Message:   "Custom model probe timed out on this Computer.",
				Retryable: true,
			}
		}
		return wire.LocalModelCustomProbeResult{}, &CustomHubError{
			Code:      CodeToolFailed,
			Message:   "Could not run custom model probe on this Computer.",
			Retryable: true,
		}
	}
	doc := lastJSONDocument(stdout)
	if exitCode != 0 {
		return wire.LocalModelCustomProbeResult{}, parseCustomHubFailure(doc, "Custom model probe failed on this Computer.", req.Token)
	}
	var envelope struct {
		Schema string `json:"schema"`
		OK     bool   `json:"ok"`
	}
	if len(doc) == 0 || json.Unmarshal(doc, &envelope) != nil || envelope.Schema != customProbeSchema || !envelope.OK {
		return wire.LocalModelCustomProbeResult{}, parseCustomHubFailure(doc, "Custom model probe returned an unreadable response.", req.Token)
	}
	var result wire.LocalModelCustomProbeResult
	if err := json.Unmarshal(doc, &result); err != nil {
		return wire.LocalModelCustomProbeResult{}, &CustomHubError{
			Code:      CodeToolFailed,
			Message:   "Custom model probe returned an unreadable response.",
			Retryable: true,
		}
	}
	return sanitizeCustomProbeResult(result, req.Token)
}

func parseCustomHubFailure(doc []byte, fallback, token string) *CustomHubError {
	var body struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Detail  string `json:"detail"`
	}
	if len(doc) > 0 && json.Unmarshal(doc, &body) == nil {
		code := strings.TrimSpace(body.Code)
		if code == "" {
			code = CodeToolFailed
		}
		rawMsg := strings.TrimSpace(body.Message)
		if rawMsg == "" {
			rawMsg = strings.TrimSpace(body.Detail)
		}
		msg := fallback
		if rawMsg != "" {
			msg = clip(redact.TextWithSecrets(rawMsg, token), 1000)
		}
		return &CustomHubError{
			Code:      code,
			Message:   msg,
			Retryable: code == "HUB_UNREACHABLE" || code == "NETWORK_UNAVAILABLE" || code == CodeToolFailed,
		}
	}
	return &CustomHubError{
		Code:      CodeToolFailed,
		Message:   fallback,
		Retryable: true,
	}
}

func normalizeArch(arch string) string {
	switch arch {
	case "amd64":
		return "x86_64"
	case "aarch64":
		return "arm64"
	default:
		return arch
	}
}

func sanitizeSupportedFormats(raw []string) []string {
	if len(raw) == 0 {
		return nil
	}
	out := make([]string, 0, min(len(raw), 8))
	for _, item := range raw {
		if (item == "gguf" || item == "mlx") && !slices.Contains(out, item) {
			out = append(out, item)
			if len(out) == 8 {
				break
			}
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func sanitizeCustomSearchResult(result wire.LocalModelCustomSearchResult, token string) wire.LocalModelCustomSearchResult {
	result.Query = clip(redact.TextWithSecrets(strings.TrimSpace(result.Query), token), 256)
	if !slices.Contains([]string{"all", "huggingface", "modelscope"}, result.Hub) {
		result.Hub = "all"
	}
	if !slices.Contains([]string{"compatible", "gguf", "mlx", "all"}, result.Format) {
		result.Format = "compatible"
	}
	if !slices.Contains([]string{"linux", "darwin", "windows"}, result.Platform) {
		result.Platform = runtime.GOOS
	}
	result.Arch = normalizeArch(result.Arch)
	if result.Arch != "x86_64" && result.Arch != "arm64" {
		result.Arch = normalizeArch(runtime.GOARCH)
	}
	result.SupportedFormats = sanitizeSupportedFormats(result.SupportedFormats)
	if result.SupportedFormats == nil {
		result.SupportedFormats = []string{"gguf"}
	}
	if result.Results == nil {
		result.Results = []wire.LocalModelCustomSearchResultItem{}
	}
	if len(result.Results) > 100 {
		result.Results = result.Results[:100]
	}
	filtered := make([]wire.LocalModelCustomSearchResultItem, 0, len(result.Results))
	for _, item := range result.Results {
		if !slices.Contains([]string{"huggingface", "modelscope"}, item.Hub) {
			continue
		}
		item.RepoID = clip(strings.TrimSpace(item.RepoID), 256)
		item.URL = clip(strings.TrimSpace(item.URL), 2048)
		item.Title = clip(strings.TrimSpace(item.Title), 200)
		item.Owner = clip(strings.TrimSpace(item.Owner), 120)
		if item.RepoID == "" || item.URL == "" || item.Title == "" || item.Owner == "" {
			continue
		}
		if !slices.Contains([]string{"gguf", "mlx", "safetensors", "unknown"}, item.Format) {
			item.Format = "unknown"
		}
		if item.Family != "" && !slices.Contains(families, item.Family) {
			item.Family = "other"
		}
		item.Architecture = clip(strings.TrimSpace(item.Architecture), 64)
		item.UpdatedAt = clip(strings.TrimSpace(item.UpdatedAt), 64)
		item.Description = clip(redact.TextWithSecrets(strings.TrimSpace(item.Description), token), 2000)
		item.License = clip(strings.TrimSpace(item.License), 120)
		item.IncompatibilityCode = clip(strings.TrimSpace(item.IncompatibilityCode), 64)
		if item.DefaultQuant != nil {
			item.DefaultQuant.ID = clip(strings.TrimSpace(item.DefaultQuant.ID), 128)
			item.DefaultQuant.Label = clip(strings.TrimSpace(item.DefaultQuant.Label), 128)
			if item.DefaultQuant.ID == "" || item.DefaultQuant.Label == "" {
				item.DefaultQuant = nil
			}
		}
		filtered = append(filtered, item)
	}
	result.Results = filtered
	warnings := make([]string, 0, min(len(result.Warnings), 20))
	for _, w := range result.Warnings {
		if len(warnings) >= 20 {
			break
		}
		cleaned := clip(redact.TextWithSecrets(strings.TrimSpace(w), token), 400)
		if cleaned != "" {
			warnings = append(warnings, cleaned)
		}
	}
	result.Warnings = warnings
	return result
}

func sanitizeCustomProbeResult(result wire.LocalModelCustomProbeResult, token string) (wire.LocalModelCustomProbeResult, error) {
	if !slices.Contains([]string{"ready", "gated", "incompatible", "not_found"}, result.Outcome) {
		return wire.LocalModelCustomProbeResult{}, &CustomHubError{
			Code:      CodeToolFailed,
			Message:   "Custom model probe returned an unknown outcome.",
			Retryable: true,
		}
	}
	result.MetadataNote = clip(redact.TextWithSecrets(strings.TrimSpace(result.MetadataNote), token), 400)
	result.RecommendedVariantID = clip(strings.TrimSpace(result.RecommendedVariantID), 128)
	result.SelectedQuantID = clip(strings.TrimSpace(result.SelectedQuantID), 128)
	result.SuggestedSearchQuery = clip(strings.TrimSpace(result.SuggestedSearchQuery), 256)
	result.RepoID = clip(strings.TrimSpace(result.RepoID), 256)
	if result.Hub != "" && !slices.Contains([]string{"huggingface", "modelscope"}, result.Hub) {
		result.Hub = ""
	}
	if result.Reason != "" && !slices.Contains([]string{"raw_safetensors", "mlx_unsupported", "no_runnable_files"}, result.Reason) {
		result.Reason = "no_runnable_files"
	}
	if result.HubHTTPStatus != nil && (*result.HubHTTPStatus < 400 || *result.HubHTTPStatus > 499) {
		result.HubHTTPStatus = nil
	}
	if result.Repo != nil {
		repo := *result.Repo
		repo.RepoID = clip(strings.TrimSpace(repo.RepoID), 256)
		repo.Revision = clip(strings.TrimSpace(repo.Revision), 128)
		repo.URL = clip(strings.TrimSpace(repo.URL), 2048)
		repo.Title = clip(strings.TrimSpace(repo.Title), 200)
		repo.Owner = clip(strings.TrimSpace(repo.Owner), 120)
		repo.License = clip(strings.TrimSpace(repo.License), 120)
		if repo.Format != "" && !slices.Contains([]string{"gguf", "mlx", "safetensors", "unknown"}, repo.Format) {
			repo.Format = "unknown"
		}
		if repo.Family != "" && !slices.Contains(families, repo.Family) {
			repo.Family = "other"
		}
		if !slices.Contains([]string{"huggingface", "modelscope"}, repo.Hub) || repo.RepoID == "" || repo.URL == "" {
			result.Repo = nil
		} else {
			result.Repo = &repo
		}
	}
	if result.GgufMeta != nil {
		meta := *result.GgufMeta
		meta.Architecture = clip(strings.TrimSpace(meta.Architecture), 64)
		result.GgufMeta = &meta
	}
	if result.Host != nil {
		host := *result.Host
		if !slices.Contains([]string{"linux", "darwin", "windows"}, host.Platform) {
			host.Platform = runtime.GOOS
		}
		host.Arch = normalizeArch(host.Arch)
		if host.Arch != "x86_64" && host.Arch != "arm64" {
			host.Arch = normalizeArch(runtime.GOARCH)
		}
		host.SupportedFormats = sanitizeSupportedFormats(host.SupportedFormats)
		if host.SupportedFormats == nil {
			host.SupportedFormats = []string{"gguf"}
		}
		if host.TargetPool != "" {
			if _, _, err := poolKind(host.TargetPool); err != nil {
				host.TargetPool = ""
			}
		}
		result.Host = &host
	}
	if len(result.MmprojCandidates) > 32 {
		result.MmprojCandidates = result.MmprojCandidates[:32]
	}
	if len(result.QuantVariants) > 128 {
		result.QuantVariants = result.QuantVariants[:128]
	}
	if len(result.QuantVariants) > 0 {
		validVariants := make([]wire.LocalModelCustomQuantVariant, 0, len(result.QuantVariants))
		for _, v := range result.QuantVariants {
			v.ID = clip(strings.TrimSpace(v.ID), 128)
			v.Label = clip(strings.TrimSpace(v.Label), 128)
			v.Quant = clip(strings.TrimSpace(v.Quant), 64)
			v.MmprojFile = clip(strings.TrimSpace(v.MmprojFile), 512)
			if v.ID == "" || v.Label == "" || v.Quant == "" || !ValidModelID(v.CustomModelID) {
				continue
			}
			if v.ShardCount < 1 {
				v.ShardCount = 1
			}
			if v.Files == nil {
				v.Files = []wire.LocalModelCustomQuantFile{}
			}
			if len(v.Files) > 256 {
				v.Files = v.Files[:256]
			}
			if v.MemoryEstimateBasis != "gguf_header" && v.MemoryEstimateBasis != "rough_1.2x_plus_0.8gb" {
				v.MemoryEstimateBasis = "rough_1.2x_plus_0.8gb"
			}
			if !slices.Contains([]string{"comfortable", "tight", "exceeds"}, v.MemoryStatus) {
				v.MemoryStatus = "tight"
			}
			validVariants = append(validVariants, v)
		}
		result.QuantVariants = validVariants
	}
	return result, nil
}
