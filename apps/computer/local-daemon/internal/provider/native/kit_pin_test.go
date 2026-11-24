package native

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The desktop bundles the localmodels kit that installs the managed Codex,
// Claude and Pi. Each distribution records, from that kit's release, the
// Runtime versions it installs and the oldest of each it reuses instead. The
// Daemon must accept both, or a desktop install gets, or keeps, a Runtime the
// Daemon refuses.
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
				RuntimeVersions  map[string]string `json:"runtimeVersions"`
				RuntimeBaselines map[string]string `json:"runtimeBaselines"`
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
			baseline := distribution.LocalmodelsTool.RuntimeBaselines[kind]
			if err := RequireVersion(kind, baseline); err != nil {
				t.Errorf("%s: localmodels reuses %s from %q: %v", filepath.Base(file), kind, baseline, err)
			}
		}
	}
}
