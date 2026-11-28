package localmodels

import (
	"slices"
	"strings"
	"testing"
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

func TestToolArgumentsIncludeForceOnlyWhenSetOnLoad(t *testing.T) {
	tool := Tool{BaseDirectory: "/models"}
	normal := tool.arguments(Action{Name: ActionLoad, Model: "qwen3-4b:Q4_K_M", UnloadFirst: []string{"other:Q4"}})
	if slices.Contains(normal, "--force") {
		t.Fatalf("normal load unexpectedly passed --force: %v", normal)
	}
	forced := tool.arguments(Action{Name: ActionLoad, Model: "qwen3-4b:Q4_K_M", UnloadFirst: []string{"other:Q4"}, Force: true})
	want := []string{"-P", "-s", "-m", "localmodels", "library", "load", "qwen3-4b:Q4_K_M", "--unload", "other:Q4", "--force", "--base-dir", "/models", "--jsonl"}
	if !slices.Equal(forced, want) {
		t.Fatalf("forced load args = %v, want %v", forced, want)
	}
}
