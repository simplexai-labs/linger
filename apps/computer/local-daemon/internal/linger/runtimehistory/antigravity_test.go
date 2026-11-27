package runtimehistory

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func writeAntigravityTranscript(t *testing.T, root, sessionID, content string) string {
	t.Helper()
	logsDir := filepath.Join(root, "brain", sessionID, ".system_generated", "logs")
	if err := os.MkdirAll(logsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(logsDir, "transcript.jsonl")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestAntigravityHistoryCategorizesRedactsAndPaginates(t *testing.T) {
	home := t.TempDir()
	session := "agy-session-001"
	transcript := strings.Join([]string{
		`{"type":"SYSTEM_MESSAGE","step_index":0,"created_at":"2026-08-01T10:00:00Z","content":"init"}`,
		`{"type":"USER_INPUT","step_index":1,"created_at":"2026-08-01T10:00:01Z","content":"Check /Users/alice/secret.txt with Bearer secret-token-123"}`,
		`{"type":"PLANNER_RESPONSE","step_index":2,"created_at":"2026-08-01T10:00:02Z","thinking":"private-cot-1","tool_calls":[{"name":"run_command","args":{"CommandLine":"ls"}}]}`,
		`{"type":"GENERIC","step_index":3,"created_at":"2026-08-01T10:00:03Z","content":"output from tool"}`,
		`{"type":"PLANNER_RESPONSE","step_index":4,"created_at":"2026-08-01T10:00:04Z","thinking":"private-cot-2"}`,
		`{"type":"PLANNER_RESPONSE","step_index":5,"created_at":"2026-08-01T10:00:05Z","thinking":"private-cot-3","content":"Done checking."}`,
		`{"type":"CHECKPOINT","step_index":6,"created_at":"2026-08-01T10:00:06Z","content":"Compacted summary"}`,
		`{"type":"CUSTOM_EVENT","created_at":"2026-08-01T10:00:07Z","detail":"extra"}`,
	}, "\n") + "\n"
	path := writeAntigravityTranscript(t, home, session, transcript)

	page := InspectAntigravity(context.Background(), Request{CodexHome: home, ThreadID: session})
	encoded, err := json.Marshal(page)
	if err != nil {
		t.Fatal(err)
	}
	if page.Status != "available" || page.ProviderKind != "antigravity" || page.Source != "antigravity_transcript" {
		t.Fatalf("unexpected page header: %s", encoded)
	}
	if page.Instructions.Status != "unavailable" || page.Instructions.Source != "antigravity_transcript" {
		t.Fatalf("unexpected instructions: %+v", page.Instructions)
	}
	if strings.Contains(string(encoded), "private-cot") || strings.Contains(string(encoded), "secret-token-123") || strings.Contains(string(encoded), "/Users/alice") {
		t.Fatalf("expected thinking, secrets, and paths redacted: %s", encoded)
	}
	if len(page.Records) != 8 {
		t.Fatalf("len(records) = %d, want 8", len(page.Records))
	}

	wantCategories := []string{"lifecycle", "message", "tool_call", "tool_result", "reasoning", "message", "compaction", "provider_event"}
	wantRoles := []string{"system", "user", "assistant", "", "assistant", "assistant", "system", ""}
	wantTurns := []string{"step-0", "step-1", "step-1", "step-1", "step-1", "step-1", "step-1", "step-1"}
	for i, rec := range page.Records {
		if rec.Category != wantCategories[i] {
			t.Fatalf("record[%d].Category = %q, want %q", i, rec.Category, wantCategories[i])
		}
		if rec.Role != wantRoles[i] {
			t.Fatalf("record[%d].Role = %q, want %q", i, rec.Role, wantRoles[i])
		}
		if rec.TurnID != wantTurns[i] {
			t.Fatalf("record[%d].TurnID = %q, want %q", i, rec.TurnID, wantTurns[i])
		}
		if rec.Timestamp == "" {
			t.Fatalf("record[%d].Timestamp is empty", i)
		}
	}
	if page.Records[2].ToolName != "run_command" || page.Records[2].ToolCallID != "" || page.Records[3].ToolCallID != "" {
		t.Fatalf("record[2]=%+v record[3]=%+v, want run_command with empty ToolCallID when transcript omits IDs", page.Records[2], page.Records[3])
	}
	// Verify PLANNER_RESPONSE thinking field is redacted as reasoning_content.
	foundReasoningRedaction := false
	for _, field := range page.Records[2].RedactedFields {
		if field.Path == "/thinking" && field.Reason == "reasoning_content" {
			foundReasoningRedaction = true
		}
	}
	if !foundReasoningRedaction {
		t.Fatalf("expected /thinking redacted as reasoning_content, got %+v", page.Records[2].RedactedFields)
	}
	if nativeMap, ok := page.Records[2].NativeRecord.(map[string]any); !ok || nativeMap["thinking"] != nil {
		t.Fatalf("thinking leaked into native_record: %+v", page.Records[2].NativeRecord)
	}

	// Frozen pagination: appending lines after first page does not invalidate cursor.
	latest := InspectAntigravity(context.Background(), Request{CodexHome: home, ThreadID: session, Limit: 3})
	if latest.Status != "available" || len(latest.Records) != 3 || latest.PreviousCursor == "" {
		t.Fatalf("latest page = %+v", latest)
	}
	if err := os.WriteFile(path, []byte(transcript+`{"type":"USER_INPUT","step_index":8,"created_at":"2026-08-01T10:00:08Z","content":"later"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	older := InspectAntigravity(context.Background(), Request{CodexHome: home, ThreadID: session, Cursor: latest.PreviousCursor, Limit: 3})
	if older.Status != "available" || older.Snapshot.RecordCount != 8 || len(older.Records) != 3 || older.Records[0].Ordinal != 2 {
		t.Fatalf("older page = %+v", older)
	}

	// Truncating/mutating the frozen prefix expires the cursor.
	if err := os.WriteFile(path, []byte(`{"type":"USER_INPUT","step_index":0,"content":"rewritten"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	expired := InspectAntigravity(context.Background(), Request{CodexHome: home, ThreadID: session, Cursor: latest.PreviousCursor, Limit: 3})
	if expired.Status != "unavailable" || expired.Reason != "snapshot_expired" {
		t.Fatalf("expected snapshot_expired, got %+v", expired)
	}
}

func TestAntigravityHistoryFallbackOrdinalTurnID(t *testing.T) {
	home := t.TempDir()
	session := "agy-ordinal"
	writeAntigravityTranscript(t, home, session, `{"type":"USER_INPUT","content":"no step index"}`+"\n")
	page := InspectAntigravity(context.Background(), Request{CodexHome: home, ThreadID: session})
	if page.Status != "available" || len(page.Records) != 1 || page.Records[0].TurnID != "ordinal-0" {
		t.Fatalf("unexpected page: %+v", page)
	}
}

func TestAntigravityHistoryExtractsOptionalToolCallIDs(t *testing.T) {
	home := t.TempDir()
	session := "agy-tool-ids"
	transcript := strings.Join([]string{
		`{"type":"PLANNER_RESPONSE","step_index":0,"tool_calls":[{"id":"tc-1","name":"run_command","args":{"CommandLine":"\"ls\""}}]}`,
		`{"type":"GENERIC","step_index":1,"tool_call_id":"tc-1","content":"ok"}`,
		`{"type":"PLANNER_RESPONSE","step_index":2,"content":"Running command","tool_calls":[{"id":"tc-2","name":"run_command","args":{"CommandLine":"\"pwd\""}}]}`,
		`{"type":"GENERIC","step_index":3,"id":"tc-2","content":"/repo"}`,
	}, "\n") + "\n"
	writeAntigravityTranscript(t, home, session, transcript)

	page := InspectAntigravity(context.Background(), Request{CodexHome: home, ThreadID: session})
	if page.Status != "available" || len(page.Records) != 4 {
		t.Fatalf("unexpected page: %+v", page)
	}
	if page.Records[0].Category != "tool_call" || page.Records[0].ToolName != "run_command" || page.Records[0].ToolCallID != "tc-1" {
		t.Fatalf("record[0] = %+v, want tool_call run_command tc-1", page.Records[0])
	}
	if page.Records[1].Category != "tool_result" || page.Records[1].ToolCallID != "tc-1" {
		t.Fatalf("record[1] = %+v, want tool_result tc-1", page.Records[1])
	}
	if page.Records[2].Category != "message" || page.Records[2].ToolCallID != "tc-2" {
		t.Fatalf("record[2] = %+v, want message with ToolCallID tc-2", page.Records[2])
	}
	if page.Records[3].Category != "tool_result" || page.Records[3].ToolCallID != "tc-2" {
		t.Fatalf("record[3] = %+v, want tool_result fallback id tc-2", page.Records[3])
	}
}

func TestAntigravityHistoryRedactsWindowsPaths(t *testing.T) {
	home := t.TempDir()
	session := "agy-win-paths"
	transcript := `{"type":"PLANNER_RESPONSE","step_index":0,"tool_calls":[{"name":"run_command","args":{"Single":"C:\\Users\\alice\\secret.txt","Quoted":"\"C:\\\\Users\\\\alice\\\\secret.txt\""}}]}` + "\n"
	writeAntigravityTranscript(t, home, session, transcript)

	page := InspectAntigravity(context.Background(), Request{CodexHome: home, ThreadID: session})
	if page.Status != "available" || len(page.Records) != 1 {
		t.Fatalf("unexpected page: %+v", page)
	}
	encoded, err := json.Marshal(page)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "alice") || strings.Contains(string(encoded), "secret.txt") {
		t.Fatalf("Windows user paths leaked in redacted transcript: %s", encoded)
	}
	var physicalPaths []string
	for _, field := range page.Records[0].RedactedFields {
		if field.Reason == "physical_path" {
			physicalPaths = append(physicalPaths, field.Path)
		}
	}
	if len(physicalPaths) != 2 {
		t.Fatalf("redacted physical_path fields = %v, want 2 (%+v)", physicalPaths, page.Records[0].RedactedFields)
	}

	// Custom Windows home outside C:\Users\... inside JSON-encoded tool_calls args.
	customHome := `D:\Work\agent\.gemini\antigravity-cli`
	var redactions []RedactedField
	sanitized := sanitizeString(`"D:\\Work\\agent\\.gemini\\antigravity-cli\\brain\\s1"`, customHome, "/tool_calls/0/args/Path", &redactions)
	if strings.Contains(sanitized, `Work`) || !strings.Contains(sanitized, "[REDACTED_PATH]") {
		t.Fatalf("custom double-escaped Windows home was not redacted: %q", sanitized)
	}
	if len(redactions) != 1 || redactions[0].Reason != "physical_path" {
		t.Fatalf("custom Windows home redactions = %+v, want physical_path", redactions)
	}
}

func TestAntigravityHistoryRejectsTraversalMissingAndSymlinks(t *testing.T) {
	home := t.TempDir()
	invalid := InspectAntigravity(context.Background(), Request{CodexHome: home, ThreadID: "../escape"})
	if invalid.Status != "unavailable" || invalid.Reason != "transcript_session_invalid" || invalid.Instructions.Source != "antigravity_transcript" {
		t.Fatalf("invalid threadId = %+v", invalid)
	}
	missing := InspectAntigravity(context.Background(), Request{CodexHome: home, ThreadID: "missing-session"})
	if missing.Status != "unavailable" || missing.Reason != "transcript_unavailable" {
		t.Fatalf("missing transcript = %+v", missing)
	}
	badLimit := InspectAntigravity(context.Background(), Request{CodexHome: home, ThreadID: "missing-session", Limit: maxPageLimit + 1})
	if badLimit.Status != "unavailable" || badLimit.Reason != "history_limit_invalid" {
		t.Fatalf("badLimit = %+v", badLimit)
	}

	if runtime.GOOS == "windows" {
		return
	}
	// Verify every path segment rejects symlinks with transcript_symlink.
	outside := t.TempDir()
	outsideFile := filepath.Join(outside, "transcript.jsonl")
	if err := os.WriteFile(outsideFile, []byte(`{"type":"USER_INPUT","content":"outside"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	segments := []string{"brain", "session", ".system_generated", "logs", "transcript.jsonl"}
	for _, target := range segments {
		t.Run("symlink_"+target, func(t *testing.T) {
			root := t.TempDir()
			session := "sess-sym"
			switch target {
			case "brain":
				if err := os.Symlink(outside, filepath.Join(root, "brain")); err != nil {
					t.Fatal(err)
				}
			case "session":
				if err := os.MkdirAll(filepath.Join(root, "brain"), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, filepath.Join(root, "brain", session)); err != nil {
					t.Fatal(err)
				}
			case ".system_generated":
				if err := os.MkdirAll(filepath.Join(root, "brain", session), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, filepath.Join(root, "brain", session, ".system_generated")); err != nil {
					t.Fatal(err)
				}
			case "logs":
				if err := os.MkdirAll(filepath.Join(root, "brain", session, ".system_generated"), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, filepath.Join(root, "brain", session, ".system_generated", "logs")); err != nil {
					t.Fatal(err)
				}
			case "transcript.jsonl":
				logsDir := filepath.Join(root, "brain", session, ".system_generated", "logs")
				if err := os.MkdirAll(logsDir, 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outsideFile, filepath.Join(logsDir, "transcript.jsonl")); err != nil {
					t.Fatal(err)
				}
			}
			got := InspectAntigravity(context.Background(), Request{CodexHome: root, ThreadID: session})
			if got.Status != "unavailable" || got.Reason != "transcript_symlink" {
				t.Fatalf("symlink %s = %+v, want transcript_symlink", target, got)
			}
		})
	}
}

func TestOpenAntigravityTranscriptPath(t *testing.T) {
	if _, _, err := OpenAntigravityTranscriptPath(""); err == nil {
		t.Fatal("expected error for empty path")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "transcript.jsonl")
	if err := os.WriteFile(path, []byte(`{"type":"CHECKPOINT"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	file, info, err := OpenAntigravityTranscriptPath(path)
	if err != nil {
		t.Fatalf("OpenAntigravityTranscriptPath(%q): %v", path, err)
	}
	_ = file.Close()
	if !info.Mode().IsRegular() || info.Size() == 0 {
		t.Fatalf("unexpected info: mode=%v size=%d", info.Mode(), info.Size())
	}
	if runtime.GOOS == "windows" {
		return
	}
	link := filepath.Join(dir, "link.jsonl")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, _, err := OpenAntigravityTranscriptPath(link); err == nil {
		t.Fatal("expected symlink rejection from OpenAntigravityTranscriptPath")
	}
}
