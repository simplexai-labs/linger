package computerconfig

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

func TestLoadReadsOwnerScopedExistingComputerConfig(t *testing.T) {
	root := t.TempDir()
	token := testToken("computer-1", "tenant-1", "owner-1")
	tokenPath := filepath.Join(root, "token")
	authPath := filepath.Join(root, "auth.json")
	configPath := filepath.Join(root, "computer.json")
	if err := os.WriteFile(tokenPath, []byte(token), 0o600); err != nil {
		t.Fatal(err)
	}
	encoded := fmt.Sprintf(`{"max_concurrent_operations":1,"runner_id":"computer-1","display_name":"Computer","gateway":{"url":"wss://agent.example.test/v1/runner-gateway","token_file":%q},"state_directory":%q,"codex":{"auth_file":%q},"runtime_paths":{"codex":%q},"workspace_grants":[{"grant_id":"grant-1","tenant_id":"tenant-1","root_path":%q,"mode":"workspace-write","scope":"owner"}]}`, tokenPath, filepath.Join(root, "state"), authPath, filepath.Join(root, "codex"), filepath.Join(root, "workspace"))
	if err := os.WriteFile(configPath, []byte(encoded), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := Load(configPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	updated, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(updated, &fields); err != nil || fields["max_concurrent_operations"] != nil {
		t.Fatalf("failed to migrate Computer config: %v", err)
	}
	if config.ComputerID != "computer-1" || config.CodexAuthFile != authPath || len(config.Owners) != 1 || config.Owners[0].OwnerActorID != "owner-1" {
		t.Fatalf("config=%+v", config)
	}
	// Account replacement loads the old configuration while setup holds this lock.
	lock, acquired, err := privatefs.AcquireLock(filepath.Join(config.StateDirectory, SetupLockName))
	if err != nil || !acquired {
		t.Fatalf("acquire setup lock: %v", err)
	}
	defer privatefs.ReleaseLock(lock)
	if err := os.WriteFile(configPath, []byte(encoded), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := MigrateSetupConfig(configPath, config.StateDirectory); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(configPath, nil); err != nil {
		t.Fatal(err)
	}

}

func TestLoadRejectsCredentialForAnotherComputer(t *testing.T) {
	root := t.TempDir()
	tokenPath := filepath.Join(root, "token")
	configPath := filepath.Join(root, "computer.json")
	_ = os.WriteFile(tokenPath, []byte(testToken("computer-other", "tenant-1", "owner-1")), 0o600)
	encoded := fmt.Sprintf(`{"runner_id":"computer-1","display_name":"Computer","gateway":{"url":"wss://agent.example.test/v1/runner-gateway","token_file":%q},"state_directory":%q,"workspace_grants":[]}`, tokenPath, root)
	_ = os.WriteFile(configPath, []byte(encoded), 0o600)
	if _, err := Load(configPath, nil); err == nil {
		t.Fatal("cross-Computer credential was accepted")
	}
}

func testToken(computerID, tenantID, ownerID string) string {
	payload := fmt.Sprintf(`{"v":1,"runner_id":%q,"tenant_owners":[{"tenant_id":%q,"owner_actor_id":%q}]}`, computerID, tenantID, ownerID)
	return "sr1." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".signature"
}
