package localmodels

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/mirrors"
)

func TestToolCommandArgsForcesPythonUTF8Mode(t *testing.T) {
	fake := newFakeTool(t)

	cmd := fake.tool.commandArgs(map[string]string{
		"PYTHONUTF8":       "0",
		"PythonUtf8":       "0",
		"pythonutf8":       "0",
		"PYTHONIOENCODING": "gbk",
		"PythonIOEncoding": "cp936",
		"pythonioencoding": "cp932",
		"CUSTOM_KEEP":      "yes",
	}, []string{"-P", "-s", "-m", "localmodels", "library", "status", "--json"})

	if !slices.Contains(cmd.Env, "PYTHONUTF8=1") {
		t.Fatalf("expected PYTHONUTF8=1 in env %v", cmd.Env)
	}
	if !slices.Contains(cmd.Env, "PYTHONIOENCODING=utf-8") {
		t.Fatalf("expected PYTHONIOENCODING=utf-8 in env %v", cmd.Env)
	}
	if !slices.Contains(cmd.Env, "CUSTOM_KEEP=yes") {
		t.Fatalf("expected unrelated env CUSTOM_KEEP=yes preserved in %v", cmd.Env)
	}

	var utf8Entries, ioEncodingEntries []string
	for _, entry := range cmd.Env {
		key, _, found := strings.Cut(entry, "=")
		if !found {
			continue
		}
		switch strings.ToUpper(key) {
		case "PYTHONUTF8":
			utf8Entries = append(utf8Entries, entry)
		case "PYTHONIOENCODING":
			ioEncodingEntries = append(ioEncodingEntries, entry)
		}
	}
	if !slices.Equal(utf8Entries, []string{"PYTHONUTF8=1"}) {
		t.Fatalf("PYTHONUTF8 entries = %v, want [PYTHONUTF8=1]", utf8Entries)
	}
	if !slices.Equal(ioEncodingEntries, []string{"PYTHONIOENCODING=utf-8"}) {
		t.Fatalf("PYTHONIOENCODING entries = %v, want [PYTHONIOENCODING=utf-8]", ioEncodingEntries)
	}
}

func TestToolCommandArgsSharesLingerRegionFileAndRegion(t *testing.T) {
	fake := newFakeTool(t)
	regionPath := mirrors.RegionFileFromStateDir(fake.tool.StateDirectory)
	if err := os.MkdirAll(filepath.Dir(regionPath), 0o700); err != nil {
		t.Fatalf("mkdir region dir: %v", err)
	}
	raw, err := json.Marshal(mirrors.Profile{
		Schema:             mirrors.Schema,
		Region:             "cn",
		ResolvedAt:         time.Now().UTC().Format(time.RFC3339),
		Method:             "probe",
		NetworkFingerprint: "direct",
	})
	if err != nil {
		t.Fatalf("marshal profile: %v", err)
	}
	if err := os.WriteFile(regionPath, raw, 0o600); err != nil {
		t.Fatalf("write region.json: %v", err)
	}

	cmd := fake.tool.commandArgs(map[string]string{}, []string{"-P", "-s", "-m", "localmodels", "library", "download", "demo:Q4"})
	if !slices.Contains(cmd.Env, "SIMPLEX_REGION_FILE="+regionPath) {
		t.Fatalf("expected SIMPLEX_REGION_FILE=%s in env %v", regionPath, cmd.Env)
	}
	if !slices.Contains(cmd.Env, "SIMPLEX_REGION=cn") {
		t.Fatalf("expected SIMPLEX_REGION=cn in env %v", cmd.Env)
	}

	// Invalid SIMPLEX_REGION and relative SIMPLEX_REGION_FILE are stripped before spawning localmodels.
	emptyTool := fake.tool
	emptyTool.StateDirectory = ""
	sanitized := emptyTool.commandArgs(map[string]string{
		"SIMPLEX_REGION":      "mars",
		"SIMPLEX_REGION_FILE": "relative/region.json",
	}, []string{"-P", "-s", "-m", "localmodels", "library", "status", "--json"})
	for _, entry := range sanitized.Env {
		if strings.HasPrefix(strings.ToUpper(entry), "SIMPLEX_REGION") {
			t.Fatalf("unexpected unsanitized SIMPLEX_REGION* entry in env: %q", entry)
		}
	}
}
