package computerconfig

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func desktopConfig(t *testing.T, desktop string) (Config, error) {
	t.Helper()
	root := t.TempDir()
	file := filepath.Join(root, "computer.json")
	encoded := fmt.Sprintf(`{"runner_id":"computer-1","display_name":"Fixture","gateway":{"url":"ws://127.0.0.1:4000/v1/runner-gateway","token_env":"LINGER_COMPUTER_TOKEN"},"state_directory":%q,"workspace_grants":[]%s}`, root, desktop)
	if err := os.WriteFile(file, []byte(encoded), 0o600); err != nil {
		t.Fatal(err)
	}
	return Load(file, map[string]string{"LINGER_COMPUTER_TOKEN": testToken("computer-1", "tenant-1", "owner-1")})
}

func TestDesktopConfigIsOptional(t *testing.T) {
	config, err := desktopConfig(t, "")
	if err != nil {
		t.Fatal(err)
	}
	if config.Desktop != nil {
		t.Fatalf("standalone config has Desktop = %+v", config.Desktop)
	}
}

func TestDesktopConfigReadsTeamHubCLIDirectory(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "teamhub-cli")
	config, err := desktopConfig(t, fmt.Sprintf(`,"desktop":{"teamhub_cli_directory":%q}`, directory))
	if err != nil {
		t.Fatal(err)
	}
	if config.Desktop == nil || config.Desktop.TeamHubCLIDirectory != directory || config.Desktop.CuaSocket != "" {
		t.Fatalf("Desktop = %+v", config.Desktop)
	}
	if config.GatewayToken == "" {
		t.Fatal("token_env credential was not read")
	}
}

func TestDesktopConfigRejectsRelativeTeamHubCLIDirectory(t *testing.T) {
	if _, err := desktopConfig(t, `,"desktop":{"teamhub_cli_directory":"teamhub-cli"}`); err == nil {
		t.Fatal("relative TeamHub CLI directory was accepted")
	}
}

func TestDesktopConfigCuaSocket(t *testing.T) {
	const socket = "/tmp/linger-host/driver.sock"
	config, err := desktopConfig(t, fmt.Sprintf(`,"desktop":{"cua_socket":%q}`, socket))
	if runtime.GOOS != "darwin" {
		if err == nil {
			t.Fatal("accepted a macOS socket on another platform")
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	if config.Desktop.CuaSocket != socket {
		t.Fatalf("socket = %q", config.Desktop.CuaSocket)
	}
	for _, path := range []string{"driver.sock", "/", "/tmp/../driver.sock", "/tmp/driver.sock/", "/tmp/bad\x00.sock", "/" + strings.Repeat("x", 103)} {
		encoded, err := json.Marshal(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := desktopConfig(t, fmt.Sprintf(`,"desktop":{"cua_socket":%s}`, encoded)); err == nil {
			t.Errorf("accepted %q", path)
		}
	}
}
