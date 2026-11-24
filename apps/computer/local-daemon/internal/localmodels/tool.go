// Package localmodels runs the installer's localmodels tool for the Daemon.
// It reads `library status`, starts the library actions a Computer owner
// chose, supervises the long ones (download, load), and maps the tool's
// localmodels.library-status/v1 into the Runner Gateway LocalModelsSnapshot.
// It never chooses a model: every action names the model the owner picked.
package localmodels

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
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
	Python          string
	ModuleDirectory string
	StateDirectory  string
	BaseDirectory   string
}

// Action is one owner-chosen library action. Model is empty only for
// refresh; UnloadFirst is only for load.
type Action struct {
	Name        string
	Model       string
	UnloadFirst []string
}

// Action names, as the Runner Gateway sends them.
const (
	ActionDownload = "download"
	ActionCancel   = "cancel"
	ActionLoad     = "load"
	ActionUnload   = "unload"
	ActionRemove   = "remove"
	ActionRefresh  = "refresh"
)

// arguments are the `library` arguments of one call. Model ids are validated
// by the caller, so none starts with "-".
func (t Tool) arguments(action Action) []string {
	args := []string{"-P", "-s", "-m", "localmodels", "library"}
	switch action.Name {
	case ActionRefresh:
		return append(args, "status", "--base-dir", t.BaseDirectory, "--json")
	case ActionDownload:
		return append(args, "download", action.Model, "--base-dir", t.BaseDirectory, "--jsonl")
	case ActionLoad:
		args = append(args, "load", action.Model)
		for _, other := range action.UnloadFirst {
			args = append(args, "--unload", other)
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
	cmd.Env = make([]string, 0, len(effective))
	for key, value := range effective {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	return cmd
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
		return verb == "status" || verb == "unload" || verb == "remove" || verb == "cancel"
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
	home := envLookup(baseEnv, homeKey)
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
