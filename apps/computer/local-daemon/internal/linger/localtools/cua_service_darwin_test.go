package localtools

import (
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

// TestCuaServiceFixtureProcess stands in for the Cua service in the tests
// below, which re-execute this binary; run directly, it skips.
func TestCuaServiceFixtureProcess(t *testing.T) {
	socket := os.Getenv("LINGER_TEST_CUA_SERVICE_SOCKET")
	if socket == "" {
		t.Skip("fixture process for the Cua service tests")
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	for {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		// Keep the connection until the caller closes it, as the real service
		// does: a caller reads the peer pid after connecting, and that read
		// fails once this side has closed.
		go func() {
			_, _ = io.Copy(io.Discard, connection)
			_ = connection.Close()
		}()
	}
}

// startCuaServiceFixture runs a separate process listening on the
// installation's service socket, so the socket peer pid is not this test.
func startCuaServiceFixture(t *testing.T, socket string) (string, <-chan error) {
	t.Helper()
	directory := filepath.Dir(socket)
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	if err := privatefs.EnsureDir(directory); err != nil {
		t.Fatal(err)
	}
	service := exec.Command(os.Args[0], "-test.run=^TestCuaServiceFixtureProcess$")
	service.Env = append(os.Environ(), "LINGER_TEST_CUA_SERVICE_SOCKET="+socket)
	if err := service.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- service.Wait() }()
	t.Cleanup(func() { _ = service.Process.Kill() })
	for deadline := time.Now().Add(10 * time.Second); cuaServicePID(socket) != service.Process.Pid; time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("fixture Cua service did not listen")
		}
	}
	if err := privatefs.WriteFile(filepath.Join(directory, "environment"), []byte("settings"), false); err != nil {
		t.Fatal(err)
	}
	return directory, exited
}

func TestManagerCloseStopsTheInstallationCuaService(t *testing.T) {
	m, err := New(Options{StateDirectory: t.TempDir(), CuaPath: filepath.Join(t.TempDir(), "cua-driver")})
	if err != nil {
		t.Fatal(err)
	}
	directory, exited := startCuaServiceFixture(t, filepath.Join(m.cuaServiceDirectory(), "driver.sock"))
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		t.Fatal("Daemon exit left its Cua service running")
	}
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatalf("Cua service directory remains after exit: %v", err)
	}
}

func TestManagerCloseLeavesAnEmbeddedHostCuaServiceRunning(t *testing.T) {
	root, err := os.MkdirTemp("/tmp", "linger-host-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	socket := filepath.Join(root, "host.sock")
	m, err := New(Options{StateDirectory: t.TempDir(), CuaPath: filepath.Join(t.TempDir(), "cua-driver"), CuaEmbedded: true, CuaSocket: socket})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.ensureCuaService(t.Context()); err == nil {
		t.Fatal("accepted missing host socket")
	}
	directory, exited := startCuaServiceFixture(t, socket)
	if got, err := m.ensureCuaService(t.Context()); got != socket || err != nil {
		t.Fatalf("host socket = %q, %v", got, err)
	}
	if err := os.Chmod(directory, 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := m.ensureCuaService(t.Context()); err == nil {
		t.Fatal("accepted non-private host directory")
	}
	if err := m.RestartCua(); err != nil {
		t.Fatal(err)
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-exited:
		t.Fatalf("Daemon exit stopped the embedding host's Cua service: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	if _, err := os.Stat(filepath.Join(directory, "environment")); err != nil {
		t.Fatalf("embedding host's Cua stamp was removed: %v", err)
	}
}
