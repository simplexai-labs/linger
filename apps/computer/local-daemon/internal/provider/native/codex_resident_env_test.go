package native

import (
	"slices"
	"testing"
)

func TestCodexMismatchDetectsMirrorEnvChange(t *testing.T) {
	baseEnv := map[string]string{"CODEX_HOME": "/tmp/codex-home", "TMPDIR": "/tmp/a"}
	proc := &codexProcess{
		home:     "/tmp/codex-home",
		envPrint: codexEnvFingerprint(baseEnv),
	}
	spec := RunSpec{}
	// Changing only TMPDIR stays compatible.
	if fields := codexMismatch(Profile{Env: map[string]string{"CODEX_HOME": "/tmp/codex-home", "TMPDIR": "/tmp/b"}}, spec, "")(proc); len(fields) != 0 {
		t.Fatalf("expected TMPDIR-only change to match, got %v", fields)
	}
	// Adding or updating mirror acceleration variables forces a recycle.
	updated := Profile{Env: map[string]string{
		"CODEX_HOME":    "/tmp/codex-home",
		"PIP_INDEX_URL": "https://pypi.tuna.tsinghua.edu.cn/simple/",
		"GOPROXY":       "https://goproxy.cn|https://goproxy.io|direct",
	}}
	if fields := codexMismatch(updated, spec, "")(proc); !slices.Contains(fields, "env") {
		t.Fatalf("expected codexMismatch to include env, got %v", fields)
	}
}
