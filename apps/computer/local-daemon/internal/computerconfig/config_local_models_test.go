package computerconfig

import "testing"

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
	config, err := loadConfigFields(t, `,"local_models":{"python":"/kit/python/bin/python3","module_directory":"/kit","state_directory":"/home/runtime/localmodels/state","base_directory":"/home/runtime/localmodels/models"}`)
	if err != nil {
		t.Fatal(err)
	}
	want := LocalModels{
		Python: "/kit/python/bin/python3", ModuleDirectory: "/kit",
		StateDirectory: "/home/runtime/localmodels/state", BaseDirectory: "/home/runtime/localmodels/models",
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
