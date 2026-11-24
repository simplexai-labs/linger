package localmodels

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

func envEntries(env []string) map[string][]string {
	entries := make(map[string][]string, len(env))
	for _, item := range env {
		key, value, ok := strings.Cut(item, "=")
		if !ok {
			continue
		}
		entries[key] = append(entries[key], value)
	}
	return entries
}

func envValue(t *testing.T, env []string, key string) string {
	t.Helper()
	entries := envEntries(env)
	values := entries[key]
	if len(values) != 1 {
		t.Fatalf("%s occurrences = %v, want exactly 1", key, values)
	}
	return values[0]
}

func listenLoopbackTest(t *testing.T) (int, func()) {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	cleanup := func() { _ = listener.Close() }
	t.Cleanup(cleanup)
	return port, cleanup
}

func seedFreeBifrostAddr(t *testing.T, stateDir string) string {
	t.Helper()
	probe := bifrostPortFree
	t.Cleanup(func() { bifrostPortFree = probe })
	bifrostPortFree = func(int) bool { return true }
	const addr = "127.0.0.1:49888"
	if err := privatefs.EnsureDir(filepath.Dir(stateDir)); err != nil {
		t.Fatal(err)
	}
	if err := privatefs.WriteFile(BifrostAddrFile(stateDir), []byte(addr+"\n"), false); err != nil {
		t.Fatal(err)
	}
	return addr
}

func assertBifrostAddrRotation(t *testing.T, stateDir, previous string, wantRotation bool) {
	t.Helper()
	addr, _, ok := readSavedBifrostAddr(BifrostAddrFile(stateDir))
	if !ok || (addr != previous) != wantRotation {
		t.Fatalf("saved Bifrost address changed from %q to %q (valid=%t), want rotation=%t", previous, addr, ok, wantRotation)
	}
}

func TestDerivedLocalmodelsSiblingPaths(t *testing.T) {
	if ToolsDirectory("") != "" || BifrostDirectory("") != "" || BifrostAddrFile("") != "" {
		t.Fatal("empty stateDir must return empty sibling paths")
	}
	stateDir := filepath.Join(t.TempDir(), "runtime", "localmodels", "state")
	parent := filepath.Dir(stateDir)
	if got := ToolsDirectory(stateDir); got != filepath.Join(parent, "tools") {
		t.Fatalf("ToolsDirectory = %q, want %q", got, filepath.Join(parent, "tools"))
	}
	if got := BifrostDirectory(stateDir); got != filepath.Join(parent, "bifrost") {
		t.Fatalf("BifrostDirectory = %q, want %q", got, filepath.Join(parent, "bifrost"))
	}
	if got := BifrostAddrFile(stateDir); got != filepath.Join(parent, "bifrost-addr") {
		t.Fatalf("BifrostAddrFile = %q, want %q", got, filepath.Join(parent, "bifrost-addr"))
	}
}

func TestCommandArgsIsolatesLocalmodelsPathsAndStripsAmbientEnvCaseInsensitively(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "runtime", "localmodels", "state")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	tool := Tool{
		Python:          filepath.Join(root, "python"),
		ModuleDirectory: filepath.Join(root, "modules"),
		StateDirectory:  stateDir,
		BaseDirectory:   filepath.Join(root, "runtime", "localmodels", "models"),
	}
	ambient := map[string]string{
		"PATH":                     "/usr/bin",
		"localmodels_state":        "/foreign/state",
		"LOCALMODELS_TOOLS_DIR":    "/foreign/tools",
		"localmodels_tools_dir":    "/foreign/tools-lower",
		"Localmodels_Bifrost_Dir":  "/foreign/bifrost",
		"LOCALMODELS_BIFROST_ADDR": "127.0.0.1:19999",
		"localmodels_bifrost_addr": "127.0.0.1:20000",
		"pythonhome":               "/foreign/python",
	}

	cmd := tool.commandArgs(ambient, []string{"-P", "-s", "-m", "localmodels", "library", "status", "--json"})
	entries := envEntries(cmd.Env)

	for _, stripped := range []string{
		"localmodels_state",
		"localmodels_tools_dir",
		"Localmodels_Bifrost_Dir",
		"localmodels_bifrost_addr",
		"pythonhome",
		"PYTHONHOME",
	} {
		if _, found := entries[stripped]; found {
			t.Fatalf("ambient key %q leaked into cmd.Env: %v", stripped, entries[stripped])
		}
	}
	if got := envValue(t, cmd.Env, "LOCALMODELS_STATE"); got != stateDir {
		t.Fatalf("LOCALMODELS_STATE = %q, want %q", got, stateDir)
	}
	if got := envValue(t, cmd.Env, "LOCALMODELS_TOOLS_DIR"); got != ToolsDirectory(stateDir) {
		t.Fatalf("LOCALMODELS_TOOLS_DIR = %q, want %q", got, ToolsDirectory(stateDir))
	}
	if got := envValue(t, cmd.Env, "LOCALMODELS_BIFROST_DIR"); got != BifrostDirectory(stateDir) {
		t.Fatalf("LOCALMODELS_BIFROST_DIR = %q, want %q", got, BifrostDirectory(stateDir))
	}
	if got := envValue(t, cmd.Env, "LOCALMODELS_BIFROST_ADDR"); got != defaultBifrostAddr {
		t.Fatalf("LOCALMODELS_BIFROST_ADDR = %q, want %q", got, defaultBifrostAddr)
	}
	if runtime.GOOS != "windows" {
		for _, dir := range []string{ToolsDirectory(stateDir), BifrostDirectory(stateDir)} {
			info, err := os.Stat(dir)
			if err != nil {
				t.Fatalf("expected private sibling dir %q: %v", dir, err)
			}
			if perm := info.Mode().Perm(); perm != 0o700 {
				t.Fatalf("dir %q perm = %o, want 700", dir, perm)
			}
		}
	}
	if _, err := os.Stat(BifrostAddrFile(stateDir)); !os.IsNotExist(err) {
		t.Fatalf("read-only library status must not create bifrost-addr, err = %v", err)
	}

	// An unset StateDirectory still strips inherited LOCALMODELS_* values without setting relative paths.
	emptyTool := Tool{Python: tool.Python, ModuleDirectory: tool.ModuleDirectory}
	emptyCmd := emptyTool.commandArgs(ambient, []string{"-P", "-s", "-m", "localmodels", "library", "status"})
	emptyEntries := envEntries(emptyCmd.Env)
	for _, key := range []string{"LOCALMODELS_TOOLS_DIR", "LOCALMODELS_BIFROST_DIR", "LOCALMODELS_BIFROST_ADDR"} {
		if _, found := emptyEntries[key]; found {
			t.Fatalf("empty StateDirectory set %q = %v", key, emptyEntries[key])
		}
	}
}

func TestCommandArgsBifrostAddrDefaultFallbackPersistenceAndOwnedPrecedence(t *testing.T) {
	newTool := func(t *testing.T) (Tool, string) {
		t.Helper()
		root := t.TempDir()
		stateDir := filepath.Join(root, "runtime", "localmodels", "state")
		if err := os.MkdirAll(stateDir, 0o700); err != nil {
			t.Fatal(err)
		}
		return Tool{
			Python:          filepath.Join(root, "python"),
			ModuleDirectory: filepath.Join(root, "modules"),
			StateDirectory:  stateDir,
			BaseDirectory:   filepath.Join(root, "runtime", "localmodels", "models"),
		}, stateDir
	}

	t.Run("defaults to 127.0.0.1:18480 when free and persists bifrost-addr", func(t *testing.T) {
		prevFree, prevPick := bifrostPortFree, bifrostPickPort
		t.Cleanup(func() { bifrostPortFree, bifrostPickPort = prevFree, prevPick })
		bifrostPortFree = func(int) bool { return true }
		bifrostPickPort = allocateBifrostPort

		tool, stateDir := newTool(t)
		cmd := tool.commandArgs(nil, []string{"-P", "-s", "-m", "localmodels", "source", "apply", "--mode", "byok"})
		if got := envValue(t, cmd.Env, "LOCALMODELS_BIFROST_ADDR"); got != "127.0.0.1:18480" {
			t.Fatalf("LOCALMODELS_BIFROST_ADDR = %q, want 127.0.0.1:18480", got)
		}
		saved, err := privatefs.ReadFile(BifrostAddrFile(stateDir), maxAddrFileBytes)
		if err != nil {
			t.Fatalf("expected persisted bifrost-addr: %v", err)
		}
		if strings.TrimSpace(string(saved)) != "127.0.0.1:18480" {
			t.Fatalf("persisted bifrost-addr = %q, want 127.0.0.1:18480", string(saved))
		}
	})

	t.Run("allocates and reuses an ephemeral free port when 18480 is occupied", func(t *testing.T) {
		prevFree, prevPick := bifrostPortFree, bifrostPickPort
		t.Cleanup(func() { bifrostPortFree, bifrostPickPort = prevFree, prevPick })
		bifrostPortFree = func(port int) bool {
			return port != defaultBifrostPort && loopbackPortFree(port)
		}
		bifrostPickPort = allocateBifrostPort

		tool, stateDir := newTool(t)
		cmd := tool.commandArgs(nil, []string{"-P", "-s", "-m", "localmodels", "library", "load", "qwen3-4b:Q4_K_M"})
		allocated := envValue(t, cmd.Env, "LOCALMODELS_BIFROST_ADDR")
		if allocated == defaultBifrostAddr || !strings.HasPrefix(allocated, "127.0.0.1:") {
			t.Fatalf("allocated addr = %q, want non-18480 loopback addr", allocated)
		}
		saved, err := privatefs.ReadFile(BifrostAddrFile(stateDir), maxAddrFileBytes)
		if err != nil || strings.TrimSpace(string(saved)) != allocated {
			t.Fatalf("persisted bifrost-addr = %q (err=%v), want %q", string(saved), err, allocated)
		}
		// Read-only and subsequent allocating calls reuse the persisted address.
		statusCmd := tool.commandArgs(nil, []string{"-P", "-s", "-m", "localmodels", "source", "status"})
		if got := envValue(t, statusCmd.Env, "LOCALMODELS_BIFROST_ADDR"); got != allocated {
			t.Fatalf("status addr = %q, want %q", got, allocated)
		}
		applyCmd := tool.commandArgs(nil, []string{"-P", "-s", "-m", "localmodels", "source", "apply", "--mode", "byok"})
		if got := envValue(t, applyCmd.Env, "LOCALMODELS_BIFROST_ADDR"); got != allocated {
			t.Fatalf("second apply addr = %q, want %q", got, allocated)
		}
	})

	t.Run("moves away from a persisted bifrost-addr held by a real foreign listener", func(t *testing.T) {
		tool, stateDir := newTool(t)
		if err := privatefs.EnsureDir(filepath.Dir(stateDir)); err != nil {
			t.Fatal(err)
		}
		occupiedPort, _ := listenLoopbackTest(t)
		occupiedAddr := fmt.Sprintf("127.0.0.1:%d", occupiedPort)
		if err := privatefs.WriteFile(BifrostAddrFile(stateDir), []byte(occupiedAddr+"\n"), false); err != nil {
			t.Fatal(err)
		}
		cmd := tool.commandArgs(nil, []string{"-P", "-s", "-m", "localmodels", "source", "apply", "--mode", "byok"})
		moved := envValue(t, cmd.Env, "LOCALMODELS_BIFROST_ADDR")
		if moved == occupiedAddr || !strings.HasPrefix(moved, "127.0.0.1:") {
			t.Fatalf("moved addr = %q, want a free port other than %q", moved, occupiedAddr)
		}
		saved, err := privatefs.ReadFile(BifrostAddrFile(stateDir), maxAddrFileBytes)
		if err != nil || strings.TrimSpace(string(saved)) != moved {
			t.Fatalf("updated bifrost-addr = %q (err=%v), want %q", string(saved), err, moved)
		}
	})

	t.Run("prefers owned.json gateway.bifrost.addr even while its port is listening", func(t *testing.T) {
		tool, stateDir := newTool(t)
		livePort, _ := listenLoopbackTest(t)
		liveAddr := fmt.Sprintf("127.0.0.1:%d", livePort)
		toolsDir := ToolsDirectory(stateDir)
		if err := privatefs.EnsureDir(toolsDir); err != nil {
			t.Fatal(err)
		}
		// Match localmodels' default-umask owned.json (0644) and verify it beats bifrost-addr.
		ownedJSON := fmt.Sprintf(`{"schema":"localmodels.owned/v1","gateway":{"bifrost":{"addr":%q}}}`, liveAddr)
		if err := os.WriteFile(filepath.Join(toolsDir, "owned.json"), []byte(ownedJSON), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := privatefs.EnsureDir(filepath.Dir(stateDir)); err != nil {
			t.Fatal(err)
		}
		if err := privatefs.WriteFile(BifrostAddrFile(stateDir), []byte("127.0.0.1:49321\n"), false); err != nil {
			t.Fatal(err)
		}
		for _, args := range [][]string{
			{"-P", "-s", "-m", "localmodels", "source", "apply", "--mode", "byok"},
			{"-P", "-s", "-m", "localmodels", "library", "status"},
		} {
			cmd := tool.commandArgs(nil, args)
			if got := envValue(t, cmd.Env, "LOCALMODELS_BIFROST_ADDR"); got != liveAddr {
				t.Fatalf("args %v addr = %q, want owned %q", args, got, liveAddr)
			}
		}

		// Non-loopback owned.json addr is rejected and falls back to bifrost-addr.
		badOwned := `{"schema":"localmodels.owned/v1","gateway":{"bifrost":{"addr":"0.0.0.0:18480"}}}`
		if err := os.WriteFile(filepath.Join(toolsDir, "owned.json"), []byte(badOwned), 0o644); err != nil {
			t.Fatal(err)
		}
		statusCmd := tool.commandArgs(nil, []string{"-P", "-s", "-m", "localmodels", "source", "status"})
		if got := envValue(t, statusCmd.Env, "LOCALMODELS_BIFROST_ADDR"); got != "127.0.0.1:49321" {
			t.Fatalf("fallback addr = %q, want persisted 127.0.0.1:49321", got)
		}
	})
}

func listenNonLoopbackTest(t *testing.T) (int, bool) {
	t.Helper()
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return 0, false
	}
	for _, raw := range addrs {
		ipNet, ok := raw.(*net.IPNet)
		if !ok || ipNet.IP == nil {
			continue
		}
		ip := ipNet.IP
		if ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
			continue
		}
		network := "tcp6"
		if ip.To4() != nil {
			network = "tcp4"
		}
		listener, listenErr := net.Listen(network, net.JoinHostPort(ip.String(), "0"))
		if listenErr != nil {
			continue
		}
		t.Cleanup(func() { _ = listener.Close() })
		return listener.Addr().(*net.TCPAddr).Port, true
	}
	return 0, false
}

func TestLoopbackPortFreeRejectsNonLoopbackInterfaceListener(t *testing.T) {
	port, ok := listenNonLoopbackTest(t)
	if !ok {
		t.Skip("host has no bindable non-loopback interface address")
	}
	if loopbackPortFree(port) {
		t.Fatalf("loopbackPortFree(%d) = true while a non-loopback interface listens on that port", port)
	}
	root := t.TempDir()
	stateDir := filepath.Join(root, "runtime", "localmodels", "state")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	tool := Tool{
		Python:          filepath.Join(root, "python"),
		ModuleDirectory: filepath.Join(root, "modules"),
		StateDirectory:  stateDir,
		BaseDirectory:   filepath.Join(root, "runtime", "localmodels", "models"),
	}
	occupiedAddr := fmt.Sprintf("127.0.0.1:%d", port)
	if err := privatefs.WriteFile(BifrostAddrFile(stateDir), []byte(occupiedAddr+"\n"), false); err != nil {
		t.Fatal(err)
	}
	cmd := tool.commandArgs(nil, []string{"-P", "-s", "-m", "localmodels", "library", "load", "inkling-2-mini:UD-Q4_K_M"})
	moved := envValue(t, cmd.Env, "LOCALMODELS_BIFROST_ADDR")
	if moved == occupiedAddr || !strings.HasPrefix(moved, "127.0.0.1:") {
		t.Fatalf("LOCALMODELS_BIFROST_ADDR = %q, want a free port other than %q", moved, occupiedAddr)
	}
}

func TestLoopbackPortFreeReusesRecentlyClosedListener(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("checks Linux TCP TIME_WAIT behavior")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	client, err := net.Dial("tcp4", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := server.Close(); err != nil {
		t.Fatal(err)
	}
	if err := client.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Read(make([]byte, 1)); !errors.Is(err, io.EOF) {
		t.Fatalf("client read after server close = %v, want EOF", err)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	if !loopbackPortFree(port) {
		t.Fatalf("port %d remains busy after the server closed its connection and listener", port)
	}
}

func TestUnavailableInterfaceBindErrors(t *testing.T) {
	for _, tc := range []struct {
		name        string
		err         syscall.Errno
		unavailable bool
	}{
		{name: "address unavailable", err: syscall.EADDRNOTAVAIL, unavailable: true},
		{name: "address family unsupported", err: syscall.EAFNOSUPPORT, unavailable: true},
		{name: "invalid address", err: syscall.EINVAL, unavailable: true},
		{name: "address in use", err: syscall.EADDRINUSE},
		{name: "Winsock address unavailable", err: 10049, unavailable: true},
		{name: "Winsock address family unsupported", err: 10047, unavailable: true},
		{name: "Winsock invalid address", err: 10022, unavailable: true},
		{name: "Winsock address in use", err: 10048},
		{name: "Winsock access denied", err: 10013},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := &net.OpError{Op: "listen", Net: "tcp", Err: os.NewSyscallError("bind", tc.err)}
			if got := isUnavailableInterfaceBind(err); got != tc.unavailable {
				t.Fatalf("isUnavailableInterfaceBind(%v) = %t, want %t", err, got, tc.unavailable)
			}
		})
	}
}

func TestRotateUnownedBifrostAddrMovesOffFailedPortAndKeepsOwned(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "runtime", "localmodels", "state")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	tool := Tool{
		Python:          filepath.Join(root, "python"),
		ModuleDirectory: filepath.Join(root, "modules"),
		StateDirectory:  stateDir,
		BaseDirectory:   filepath.Join(root, "runtime", "localmodels", "models"),
	}
	if err := privatefs.WriteFile(BifrostAddrFile(stateDir), []byte("127.0.0.1:49888\n"), false); err != nil {
		t.Fatal(err)
	}
	tool.rotateUnownedBifrostAddr()
	rotatedRaw, err := privatefs.ReadFile(BifrostAddrFile(stateDir), maxAddrFileBytes)
	if err != nil {
		t.Fatal(err)
	}
	rotated := strings.TrimSpace(string(rotatedRaw))
	if rotated == "127.0.0.1:49888" || !strings.HasPrefix(rotated, "127.0.0.1:") {
		t.Fatalf("rotated bifrost-addr = %q, want a new loopback address", rotated)
	}

	// Once owned.json records a gateway, rotateUnownedBifrostAddr must not move it.
	toolsDir := ToolsDirectory(stateDir)
	if err := os.MkdirAll(toolsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	ownedJSON := `{"schema":"localmodels.owned/v1","gateway":{"bifrost":{"addr":"127.0.0.1:49901"}}}`
	if err := os.WriteFile(filepath.Join(toolsDir, "owned.json"), []byte(ownedJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	tool.rotateUnownedBifrostAddr()
	keptRaw, err := privatefs.ReadFile(BifrostAddrFile(stateDir), maxAddrFileBytes)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(keptRaw)) != rotated {
		t.Fatalf("bifrost-addr changed while owned: got %q, want %q", strings.TrimSpace(string(keptRaw)), rotated)
	}
}

func TestCommandArgsKeepsVerifiedLegacyGatewayWhileLoadedModelsRemain(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "runtime", "localmodels", "state")
	modelsDir := filepath.Join(stateDir, "library", "models")
	legacyTools := filepath.Join(root, "legacy-instance", "tools")
	legacyBifrost := filepath.Join(root, "legacy-instance", "bifrost")
	legacyPi := filepath.Join(legacyTools, "gateway-home", ".pi", "agent")
	isolatedPi := filepath.Join(ToolsDirectory(stateDir), "gateway-home", ".pi", "agent")
	for _, dir := range []string{modelsDir, legacyBifrost, legacyPi, isolatedPi} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	ownedJSON := fmt.Sprintf(
		`{"schema":"localmodels.owned/v1","gateway":{"bifrost":{"addr":"127.0.0.1:18580","app_dir":%q}}}`,
		legacyBifrost,
	)
	if err := os.WriteFile(filepath.Join(legacyTools, "owned.json"), []byte(ownedJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	bifrostCfg := `{"providers":{"localmodels-lib-inkling-2-mini-ud-q4-k-m":{"keys":[]}}}`
	if err := os.WriteFile(filepath.Join(legacyBifrost, "config.json"), []byte(bifrostCfg), 0o600); err != nil {
		t.Fatal(err)
	}
	writeModelSourceJSON(t, stateDir, map[string]any{
		"schema":      modelSourceSchema,
		"mode":        "local",
		"runtime":     "pi",
		"gateway_url": "http://127.0.0.1:18580",
		"environment": map[string]string{"PI_CODING_AGENT_DIR": legacyPi},
	})
	modelRecordPath := filepath.Join(modelsDir, "inkling-2-mini_UD-Q4_K_M.json")
	loadedRecord := `{"state":"loaded","registration":{"provider":"localmodels-lib-inkling-2-mini-ud-q4-k-m"}}`
	if err := os.WriteFile(modelRecordPath, []byte(loadedRecord), 0o600); err != nil {
		t.Fatal(err)
	}

	tool := Tool{
		Python:          filepath.Join(root, "python"),
		ModuleDirectory: filepath.Join(root, "modules"),
		StateDirectory:  stateDir,
		BaseDirectory:   filepath.Join(root, "models"),
	}
	cmd := tool.commandArgs(nil, []string{"-P", "-s", "-m", "localmodels", "library", "load", "inkling-2-mini-iq3xxs:UD-IQ3_XXS"})
	if got := envValue(t, cmd.Env, "LOCALMODELS_TOOLS_DIR"); got != legacyTools {
		t.Fatalf("LOCALMODELS_TOOLS_DIR = %q, want legacy %q", got, legacyTools)
	}
	if got := envValue(t, cmd.Env, "LOCALMODELS_BIFROST_DIR"); got != legacyBifrost {
		t.Fatalf("LOCALMODELS_BIFROST_DIR = %q, want legacy %q", got, legacyBifrost)
	}
	if got := envValue(t, cmd.Env, "LOCALMODELS_BIFROST_ADDR"); got != "127.0.0.1:18580" {
		t.Fatalf("LOCALMODELS_BIFROST_ADDR = %q, want 127.0.0.1:18580", got)
	}
	if got := envValue(t, cmd.Env, "PI_CODING_AGENT_DIR"); got != legacyPi {
		t.Fatalf("PI_CODING_AGENT_DIR = %q, want legacy %q", got, legacyPi)
	}
	if got := OverlayEnvironment(nil, stateDir)["PI_CODING_AGENT_DIR"]; got != legacyPi {
		t.Fatalf("OverlayEnvironment PI_CODING_AGENT_DIR = %q, want legacy %q", got, legacyPi)
	}

	overlayPath := filepath.Join(stateDir, "model-source.json")
	overlayJSON, err := os.ReadFile(overlayPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(overlayPath); err != nil {
		t.Fatal(err)
	}
	inherited := map[string]string{"LOCALMODELS_TOOLS_DIR": legacyTools}
	cmdWithOverride := tool.commandArgs(inherited, []string{"-P", "-s", "-m", "localmodels", "library", "status"})
	if got := envValue(t, cmdWithOverride.Env, "LOCALMODELS_TOOLS_DIR"); got != ToolsDirectory(stateDir) {
		t.Fatalf("LOCALMODELS_TOOLS_DIR with inherited override = %q, want %q", got, ToolsDirectory(stateDir))
	}
	if err := os.WriteFile(overlayPath, overlayJSON, 0o600); err != nil {
		t.Fatal(err)
	}

	// Once all legacy models are unloaded, the home switches to its per-home isolated paths.
	if err := os.WriteFile(modelRecordPath, []byte(`{"state":"idle"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cmdAfter := tool.commandArgs(nil, []string{"-P", "-s", "-m", "localmodels", "library", "status"})
	if got := envValue(t, cmdAfter.Env, "LOCALMODELS_TOOLS_DIR"); got != ToolsDirectory(stateDir) {
		t.Fatalf("LOCALMODELS_TOOLS_DIR after unload = %q, want isolated %q", got, ToolsDirectory(stateDir))
	}
	if got := envValue(t, cmdAfter.Env, "LOCALMODELS_BIFROST_DIR"); got != BifrostDirectory(stateDir) {
		t.Fatalf("LOCALMODELS_BIFROST_DIR after unload = %q, want isolated %q", got, BifrostDirectory(stateDir))
	}
	if got := envValue(t, cmdAfter.Env, "PI_CODING_AGENT_DIR"); got != isolatedPi {
		t.Fatalf("PI_CODING_AGENT_DIR after unload = %q, want isolated %q", got, isolatedPi)
	}
	if got := OverlayEnvironment(nil, stateDir)["PI_CODING_AGENT_DIR"]; got != isolatedPi {
		t.Fatalf("OverlayEnvironment PI_CODING_AGENT_DIR after unload = %q, want isolated %q", got, isolatedPi)
	}
}

func TestCommandArgsFollowsTheInstallerLegacyToolsMarker(t *testing.T) {
	root := t.TempDir()
	stateDir := filepath.Join(root, "runtime", "localmodels", "state")
	legacyTools := filepath.Join(root, "user", ".local", "share", "localmodels", "tools")
	legacyBifrost := filepath.Join(root, "user", ".local", "share", "localmodels", "bifrost")
	legacyPi := filepath.Join(legacyTools, "gateway-home", ".pi", "agent")
	for _, dir := range []string{stateDir, legacyPi} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := privatefs.WriteFile(LegacyToolsMarkerFile(stateDir), []byte(legacyTools+"\n"), false); err != nil {
		t.Fatal(err)
	}
	tool := Tool{
		Python:          filepath.Join(root, "python"),
		ModuleDirectory: filepath.Join(root, "modules"),
		StateDirectory:  stateDir,
		BaseDirectory:   filepath.Join(root, "models"),
	}
	args := []string{"-P", "-s", "-m", "localmodels", "stack", "up"}

	// Without a Bifrost record, localmodels keeps its own Bifrost defaults.
	cmd := tool.commandArgs(map[string]string{"LOCALMODELS_BIFROST_ADDR": "127.0.0.1:19999"}, args)
	if got := envValue(t, cmd.Env, "LOCALMODELS_TOOLS_DIR"); got != legacyTools {
		t.Fatalf("LOCALMODELS_TOOLS_DIR = %q, want legacy %q", got, legacyTools)
	}
	entries := envEntries(cmd.Env)
	if values := entries["LOCALMODELS_BIFROST_DIR"]; len(values) != 0 {
		t.Fatalf("LOCALMODELS_BIFROST_DIR = %v, want unset", values)
	}
	if values := entries["LOCALMODELS_BIFROST_ADDR"]; len(values) != 0 {
		t.Fatalf("LOCALMODELS_BIFROST_ADDR = %v, want unset", values)
	}
	if got := envValue(t, cmd.Env, "PI_CODING_AGENT_DIR"); got != legacyPi {
		t.Fatalf("PI_CODING_AGENT_DIR = %q, want legacy %q", got, legacyPi)
	}

	ownedJSON := fmt.Sprintf(
		`{"schema":"localmodels.owned/v1","deployments":{"qwen3.8-27b-18100":{}},"gateway":{"bifrost":{"addr":"127.0.0.1:18480","app_dir":%q}}}`,
		legacyBifrost,
	)
	if err := os.WriteFile(filepath.Join(legacyTools, "owned.json"), []byte(ownedJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd = tool.commandArgs(nil, args)
	if got := envValue(t, cmd.Env, "LOCALMODELS_BIFROST_DIR"); got != legacyBifrost {
		t.Fatalf("LOCALMODELS_BIFROST_DIR = %q, want legacy %q", got, legacyBifrost)
	}
	if got := envValue(t, cmd.Env, "LOCALMODELS_BIFROST_ADDR"); got != "127.0.0.1:18480" {
		t.Fatalf("LOCALMODELS_BIFROST_ADDR = %q, want 127.0.0.1:18480", got)
	}
	if _, err := os.Stat(ToolsDirectory(stateDir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("per-home tools dir created for a legacy home: %v", err)
	}
}
