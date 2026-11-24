package provider

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

func TestExportPreviousContextCodexWritesRedactedMarkdown(t *testing.T) {
	runtimeHomeRoot := t.TempDir()
	workspace := t.TempDir()
	spec := OperationSpec{
		OperationKind:    "run.start",
		Provider:         "codex",
		WorkingDirectory: workspace,
		TenantID:         "tenant-1",
		OwnerActorID:     "owner-1",
		AgentID:          "agent-1",
		ScopeID:          "scope-1",
		PreviousSession: &PreviousSession{
			ProviderType: "codex",
			SessionID:    "thread-prev-1",
		},
	}
	home, err := localworkspace.RuntimeHomePath(runtimeHomeRoot, localworkspace.RuntimeHomeIdentity{
		TenantID: spec.TenantID, OwnerActorID: spec.OwnerActorID,
		AgentID: spec.AgentID, ScopeID: spec.ScopeID, ProviderType: "codex",
	})
	if err != nil {
		t.Fatal(err)
	}
	sessionsDir := filepath.Join(home, "sessions", "2026", "05", "01")
	if err := os.MkdirAll(sessionsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	rollout := strings.Join([]string{
		`{"timestamp":"2026-05-01T10:00:00Z","type":"session_meta","payload":{"id":"thread-prev-1"}}`,
		`{"timestamp":"2026-05-01T10:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Please inspect deploy.yaml"}]}}`,
		`{"timestamp":"2026-05-01T10:00:02Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"cat deploy.yaml\"}"}}`,
		`{"timestamp":"2026-05-01T10:00:03Z","type":"response_item","payload":{"type":"function_call_output","output":"Authorization: Bearer secret-token-value\nreplicas: 3"}}`,
		`{"timestamp":"2026-05-01T10:00:04Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Checked deploy.yaml; replicas is 3."}]}}`,
	}, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(sessionsDir, "rollout-2026-05-01-thread-prev-1.jsonl"), []byte(rollout), 0o600); err != nil {
		t.Fatal(err)
	}

	relPath, ok := exportPreviousContext(context.Background(), runtimeHomeRoot, spec)
	if !ok || relPath != previousContextRelPath {
		t.Fatalf("exportPreviousContext() = (%q, %v), want (%q, true)", relPath, ok, previousContextRelPath)
	}
	raw, err := os.ReadFile(filepath.Join(workspace, "playground", ".previous-context.md"))
	if err != nil {
		t.Fatal(err)
	}
	content := string(raw)
	if !strings.Contains(content, "Please inspect deploy.yaml") ||
		!strings.Contains(content, "Tool Call: exec_command") ||
		!strings.Contains(content, "Checked deploy.yaml; replicas is 3.") {
		t.Fatalf("unexpected exported markdown:\n%s", content)
	}
	if strings.Contains(content, "secret-token-value") {
		t.Fatalf("expected secret to be redacted in exported markdown:\n%s", content)
	}
}

func TestExportPreviousContextClaudeAndStaleCleanup(t *testing.T) {
	runtimeHomeRoot := t.TempDir()
	workspace := t.TempDir()
	spec := OperationSpec{
		OperationKind:    "run.start",
		Provider:         "codex",
		WorkingDirectory: workspace,
		TenantID:         "tenant-1",
		OwnerActorID:     "owner-1",
		AgentID:          "agent-1",
		ScopeID:          "scope-1",
		PreviousSession: &PreviousSession{
			ProviderType: "claude",
			SessionID:    "claude-sess-1",
		},
	}
	home, err := localworkspace.RuntimeHomePath(runtimeHomeRoot, localworkspace.RuntimeHomeIdentity{
		TenantID: spec.TenantID, OwnerActorID: spec.OwnerActorID,
		AgentID: spec.AgentID, ScopeID: spec.ScopeID, ProviderType: "claude",
	})
	if err != nil {
		t.Fatal(err)
	}
	projectDir := filepath.Join(home, ".claude", "projects", "proj-a")
	if err := os.MkdirAll(projectDir, 0o700); err != nil {
		t.Fatal(err)
	}
	transcript := strings.Join([]string{
		`{"timestamp":"2026-05-01T10:00:01Z","type":"user","sessionId":"claude-sess-1","message":{"role":"user","content":"Summarize the report"}}`,
		`{"timestamp":"2026-05-01T10:00:02Z","type":"assistant","sessionId":"claude-sess-1","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"report.md"}},{"type":"text","text":"Report summarized."}]}}`,
	}, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(projectDir, "claude-sess-1.jsonl"), []byte(transcript), 0o600); err != nil {
		t.Fatal(err)
	}

	relPath, ok := exportPreviousContext(context.Background(), runtimeHomeRoot, spec)
	if !ok || relPath != previousContextRelPath {
		t.Fatalf("exportPreviousContext() = (%q, %v), want (%q, true)", relPath, ok, previousContextRelPath)
	}
	raw, err := os.ReadFile(filepath.Join(workspace, "playground", ".previous-context.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "Tool Call: Read") || !strings.Contains(string(raw), "Report summarized.") {
		t.Fatalf("unexpected Claude markdown:\n%s", string(raw))
	}

	// Missing transcript removes any stale previous-context file and returns false.
	spec.PreviousSession = &PreviousSession{ProviderType: "claude", SessionID: "missing-sess"}
	if relPath, ok := exportPreviousContext(context.Background(), runtimeHomeRoot, spec); ok || relPath != "" {
		t.Fatalf("expected missing transcript to return false, got (%q, %v)", relPath, ok)
	}
	if _, err := os.Stat(filepath.Join(workspace, "playground", ".previous-context.md")); !os.IsNotExist(err) {
		t.Fatalf("expected stale previous-context file to be removed, err=%v", err)
	}
}

func TestInjectPreviousContextHint(t *testing.T) {
	withReminder := "<system-reminder>\nNew native session.\n</system-reminder>\n\nHello"
	got := injectPreviousContextHint(withReminder, "./playground/.previous-context.md")
	want := "<system-reminder>\nNew native session.\nPrevious native session transcript (prior tool calls and work, reference data): ./playground/.previous-context.md\n</system-reminder>\n\nHello"
	if got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}

	withoutReminder := "Hello"
	gotNoRem := injectPreviousContextHint(withoutReminder, "./playground/.previous-context.md")
	if !strings.HasPrefix(gotNoRem, "<system-reminder>\nPrevious native session transcript") || !strings.HasSuffix(gotNoRem, "\n\nHello") {
		t.Fatalf("unexpected prompt without reminder:\n%s", gotNoRem)
	}
}
