package computerconfig

import (
	"fmt"
	"path/filepath"
	"testing"
)

func TestLocalModelsConfigIsOptional(t *testing.T) {
	config, err := loadConfigFields(t, "")
	if err != nil {
		t.Fatal(err)
	}
	if config.LocalModels != nil {
		t.Fatalf("config without local_models has LocalModels = %+v", config.LocalModels)
	}
}

func TestLocalModelsConfigReadsToolLocation(t *testing.T) {
	root := t.TempDir()
	want := LocalModels{
		Python: filepath.Join(root, "kit", "python", "bin", "python3"), ModuleDirectory: filepath.Join(root, "kit"),
		StateDirectory: filepath.Join(root, "state"), BaseDirectory: filepath.Join(root, "models"),
	}
	config, err := loadConfigFields(t, fmt.Sprintf(`,"local_models":{"python":%q,"module_directory":%q,"state_directory":%q,"base_directory":%q}`, want.Python, want.ModuleDirectory, want.StateDirectory, want.BaseDirectory))
	if err != nil {
		t.Fatal(err)
	}
	if config.LocalModels == nil || *config.LocalModels != want {
		t.Fatalf("LocalModels = %+v", config.LocalModels)
	}
}

func TestLocalModelsConfigRejectsRelativeOrMissingPaths(t *testing.T) {
	for _, field := range []string{
		`,"local_models":{"python":"python3","module_directory":"/kit","state_directory":"/s","base_directory":"/b"}`,
		`,"local_models":{"python":"/kit/python3","module_directory":"/kit","state_directory":"/s"}`,
		`,"local_models":{"python":"/kit/python3","module_directory":"/kit","state_directory":"/s","base_directory":"/b","extra":"/x"}`,
	} {
		if _, err := loadConfigFields(t, field); err == nil {
			t.Fatalf("invalid local_models accepted: %s", field)
		}
	}
}

func TestLocalModelsConfigReadsTheInstallerLockFile(t *testing.T) {
	root := t.TempDir()
	fields := func(lockFile string) string {
		return fmt.Sprintf(`,"local_models":{"python":%q,"module_directory":%q,"state_directory":%q,"base_directory":%q,"lock_file":%q}`,
			filepath.Join(root, "python3"), root, filepath.Join(root, "state"), filepath.Join(root, "models"), lockFile)
	}
	lock := filepath.Join(root, "operation.sqlite")
	config, err := loadConfigFields(t, fields(lock))
	if err != nil {
		t.Fatal(err)
	}
	if config.LocalModels.LockFile != lock {
		t.Fatalf("LockFile = %q", config.LocalModels.LockFile)
	}
	// A relative path is ignored, not fatal: the lock only orders Runs.
	config, err = loadConfigFields(t, fields("operation.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	if config.LocalModels.LockFile != "" {
		t.Fatalf("LockFile = %q", config.LocalModels.LockFile)
	}
}
