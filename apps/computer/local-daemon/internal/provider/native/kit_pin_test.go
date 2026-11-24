package native

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The desktop bundles the localmodels kit that installs the managed Codex,
// Claude and Pi. Each distribution records the Runtime versions its kit
// installs; the Daemon must accept every one, or a fresh desktop install gets
// a Runtime the Daemon refuses.
func TestDesktopKitInstallsRuntimesTheDaemonAccepts(t *testing.T) {
	files, err := filepath.Glob("../../../../../desktop/distribution/*.json")
	if err != nil || len(files) == 0 {
		t.Fatalf("desktop distributions: %v %v", files, err)
	}
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var distribution struct {
			LocalmodelsTool struct {
				RuntimeVersions map[string]string `json:"runtimeVersions"`
			} `json:"localmodelsTool"`
		}
		if err := json.Unmarshal(data, &distribution); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		for _, kind := range []string{"codex", "claude", "pi"} {
			version := distribution.LocalmodelsTool.RuntimeVersions[kind]
			if err := RequireVersion(kind, version); err != nil {
				t.Errorf("%s: localmodels installs %s %q: %v", filepath.Base(file), kind, version, err)
			}
		}
	}
}
