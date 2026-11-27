package lingercontext

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func decodeRebuildWarnings(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	var warnings []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if line == "" {
			continue
		}
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("decode log line %q: %v", line, err)
		}
		if entry["msg"] == "runner.context_view.missing_workspace_rebuild" {
			warnings = append(warnings, entry)
		}
	}
	return warnings
}

func TestEnsureRebuildsMissingWorkspaceAndProjection(t *testing.T) {
	cases := []struct {
		name             string
		wantReason       string
		expectLocalWork  bool
		expectReusedKept bool
		corrupt          func(t *testing.T, store *ViewStore, record ViewRecord)
	}{
		{
			name:       "deleted_workspace_dir",
			wantReason: "workspace_missing",
			corrupt: func(t *testing.T, _ *ViewStore, record ViewRecord) {
				if err := removeGeneration(record.WorkspacePath); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name:       "deleted_view_dir",
			wantReason: "workspace_missing",
			corrupt: func(t *testing.T, _ *ViewStore, record ViewRecord) {
				if err := removeGeneration(filepath.Dir(record.WorkspacePath)); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name:       "deleted_views_root",
			wantReason: "view_root_missing",
			corrupt: func(t *testing.T, store *ViewStore, _ ViewRecord) {
				if err := removeGeneration(store.root); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name:             "deleted_readonly_projection_dir",
			wantReason:       "projection_missing",
			expectLocalWork:  true,
			expectReusedKept: true,
			corrupt: func(t *testing.T, _ *ViewStore, record ViewRecord) {
				if err := removeGeneration(filepath.Join(record.WorkspacePath, "inbox")); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name:             "deleted_readonly_projection_file",
			wantReason:       "projection_missing",
			expectLocalWork:  true,
			expectReusedKept: true,
			corrupt: func(t *testing.T, _ *ViewStore, record ViewRecord) {
				inbox := filepath.Join(record.WorkspacePath, "inbox")
				if err := os.Chmod(inbox, 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.Remove(filepath.Join(inbox, "message.txt")); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name:       "moved_linger_home_missing_old_workspace",
			wantReason: "workspace_missing",
			corrupt: func(t *testing.T, store *ViewStore, record ViewRecord) {
				if err := removeGeneration(filepath.Dir(record.WorkspacePath)); err != nil {
					t.Fatal(err)
				}
				oldPath := filepath.Join(t.TempDir(), "old-linger", "context-views", filepath.Base(filepath.Dir(record.WorkspacePath)), "workspace")
				if _, err := store.db.Exec(`UPDATE context_views_v3 SET workspace_path=? WHERE execution_context_key=?`, oldPath, record.View.ExecutionContextKey); err != nil {
					t.Fatal(err)
				}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			content := newTestContent(t)
			store := openTestStore(t)
			var logs bytes.Buffer
			store.logger = slog.New(slog.NewJSONHandler(&logs, nil))

			message := content.file("message.txt", []byte("hello rebuild\n"))
			kept := content.file("kept.md", []byte("keep me intact\n"))
			digest := content.publish(t, "context-1", "runtime-1", []Mapping{
				{Kind: "inbox_view", TargetPath: "inbox", Access: "read_only", Files: []FileInput{message}},
				{Kind: "memory", TargetPath: "memory", Access: "read_only", Files: []FileInput{kept}},
				{Kind: "playground", TargetPath: "playground", Access: "read_write"},
			}, nil, nil)
			source := ContentSource{ContentURL: content.url()}

			first, err := store.Ensure(t.Context(), testRequest("context-1", digest), source)
			if err != nil {
				t.Fatal(err)
			}
			localWork := filepath.Join(first.WorkspacePath, "playground", "notes.txt")
			if err := os.WriteFile(localWork, []byte("agent work"), 0o600); err != nil {
				t.Fatal(err)
			}
			content.takeRequests()
			logs.Reset()

			tc.corrupt(t, store, first)

			rebuilt, err := store.Ensure(t.Context(), testRequest("context-1", digest), source)
			if err != nil {
				t.Fatalf("Ensure rebuild failed: %v", err)
			}
			if rebuilt.WorkspacePath != first.WorkspacePath {
				t.Fatalf("rebuilt WorkspacePath = %q, want %q", rebuilt.WorkspacePath, first.WorkspacePath)
			}
			warnings := decodeRebuildWarnings(t, &logs)
			if len(warnings) != 1 {
				t.Fatalf("rebuild warnings = %d, want 1; logs=%s", len(warnings), logs.String())
			}
			if warnings[0]["reason"] != tc.wantReason {
				t.Fatalf("warning reason = %v, want %q", warnings[0]["reason"], tc.wantReason)
			}
			if warnings[0]["agent_id"] != "agent-1" || warnings[0]["view_digest"] != digest {
				t.Fatalf("warning metadata = %v", warnings[0])
			}
			requests := content.takeRequests()
			if len(requests) < 2 || requests[0] != "views/"+digest {
				t.Fatalf("rebuild requests = %v, want manifest and missing files", requests)
			}
			if tc.expectReusedKept {
				for _, req := range requests {
					if req == "files/"+kept.SHA256 {
						t.Fatalf("intact read-only file was re-downloaded: %v", requests)
					}
				}
			}
			requireContent(t, filepath.Join(rebuilt.WorkspacePath, "inbox", "message.txt"), "hello rebuild\n")
			requireContent(t, filepath.Join(rebuilt.WorkspacePath, "memory", "kept.md"), "keep me intact\n")
			if _, err := os.Stat(filepath.Join(rebuilt.WorkspacePath, "agent", "pyproject.toml")); err != nil {
				t.Fatalf("agent project was not recreated: %v", err)
			}
			if tc.expectLocalWork {
				requireContent(t, localWork, "agent work")
			}

			// Subsequent Ensure must hit the fast path with zero requests and no warning.
			logs.Reset()
			again, err := store.Ensure(t.Context(), testRequest("context-1", digest), source)
			if err != nil || again.WorkspacePath != rebuilt.WorkspacePath {
				t.Fatalf("repeat Ensure = %+v, %v", again, err)
			}
			if reqs := content.takeRequests(); len(reqs) != 0 {
				t.Fatalf("repeat Ensure made requests after rebuild: %v", reqs)
			}
			if w := decodeRebuildWarnings(t, &logs); len(w) != 0 {
				t.Fatalf("repeat Ensure emitted rebuild warning: %v", w)
			}

			ref := json.RawMessage(`{"view_digest":"` + digest + `"}`)
			if _, err := store.CurrentView(t.Context(), "context-1", digest); err != nil {
				t.Fatalf("CurrentView after rebuild: %v", err)
			}
			if _, err := store.ValidatedView(t.Context(), "context-1", ref); err != nil {
				t.Fatalf("ValidatedView after rebuild: %v", err)
			}
			if path, err := store.ValidatedWorkspace(t.Context(), "context-1", ref); err != nil || path != rebuilt.WorkspacePath {
				t.Fatalf("ValidatedWorkspace after rebuild = %q, %v", path, err)
			}
		})
	}
}

func TestEnsureRecoversMultipleReadyRowsAfterViewsRootDeletedAndReopened(t *testing.T) {
	directory := t.TempDir()
	database := filepath.Join(directory, "context-views.sqlite")
	viewsRoot := filepath.Join(directory, "context-views")
	content := newTestContent(t)

	store, err := OpenViewStore(database, viewsRoot, nil)
	if err != nil {
		t.Fatal(err)
	}
	source := ContentSource{ContentURL: content.url()}

	msg1 := content.file("one.txt", []byte("context one\n"))
	msg2 := content.file("two.txt", []byte("context two\n"))
	digest1 := content.publish(t, "context-1", "runtime-1", []Mapping{
		{Kind: "inbox_view", TargetPath: "inbox", Access: "read_only", Files: []FileInput{msg1}},
	}, nil, nil)
	digest2 := content.publish(t, "context-2", "runtime-1", []Mapping{
		{Kind: "inbox_view", TargetPath: "inbox", Access: "read_only", Files: []FileInput{msg2}},
	}, nil, nil)

	rec1, err := store.Ensure(t.Context(), testRequest("context-1", digest1), source)
	if err != nil {
		t.Fatal(err)
	}
	rec2, err := store.Ensure(t.Context(), testRequest("context-2", digest2), source)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	// Simulate Windows reinstall / state migration: SQLite survives, context-views dir is gone.
	if err := removeGeneration(viewsRoot); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenViewStore(database, viewsRoot, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = reopened.Close()
		makeWritable(viewsRoot)
	}()
	content.takeRequests()

	got1, err := reopened.Ensure(t.Context(), testRequest("context-1", digest1), source)
	if err != nil || got1.WorkspacePath != rec1.WorkspacePath {
		t.Fatalf("context-1 rebuild = %+v, %v", got1, err)
	}
	got2, err := reopened.Ensure(t.Context(), testRequest("context-2", digest2), source)
	if err != nil || got2.WorkspacePath != rec2.WorkspacePath {
		t.Fatalf("context-2 rebuild = %+v, %v", got2, err)
	}
	requireContent(t, filepath.Join(got1.WorkspacePath, "inbox", "one.txt"), "context one\n")
	requireContent(t, filepath.Join(got2.WorkspacePath, "inbox", "two.txt"), "context two\n")

	content.takeRequests()
	if _, err := reopened.Ensure(t.Context(), testRequest("context-1", digest1), source); err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.Ensure(t.Context(), testRequest("context-2", digest2), source); err != nil {
		t.Fatal(err)
	}
	if reqs := content.takeRequests(); len(reqs) != 0 {
		t.Fatalf("subsequent Ensure after rebuild made requests: %v", reqs)
	}
}

func TestEnsureSecurityViolationsNeverSilentlyRebuild(t *testing.T) {
	cases := []struct {
		name   string
		tamper func(t *testing.T, record ViewRecord)
	}{
		{
			name: "readonly_escaping_link",
			tamper: func(t *testing.T, record ViewRecord) {
				inbox := filepath.Join(record.WorkspacePath, "inbox")
				if err := os.Chmod(inbox, 0o700); err != nil {
					t.Fatal(err)
				}
				if err := createTestDirectoryLink(t.TempDir(), filepath.Join(inbox, "escape")); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "readonly_dangling_link",
			tamper: func(t *testing.T, record ViewRecord) {
				inbox := filepath.Join(record.WorkspacePath, "inbox")
				if err := os.Chmod(inbox, 0o700); err != nil {
					t.Fatal(err)
				}
				if err := createTestDirectoryLink(filepath.Join(t.TempDir(), "nonexistent"), filepath.Join(inbox, "dangling")); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "workspace_replaced_with_escaping_link",
			tamper: func(t *testing.T, record ViewRecord) {
				if err := removeGeneration(record.WorkspacePath); err != nil {
					t.Fatal(err)
				}
				if err := createTestDirectoryLink(t.TempDir(), record.WorkspacePath); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "workspace_replaced_with_dangling_link",
			tamper: func(t *testing.T, record ViewRecord) {
				if err := removeGeneration(record.WorkspacePath); err != nil {
					t.Fatal(err)
				}
				if err := createTestDirectoryLink(filepath.Join(t.TempDir(), "missing-target"), record.WorkspacePath); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "workspace_replaced_with_regular_file",
			tamper: func(t *testing.T, record ViewRecord) {
				if err := removeGeneration(record.WorkspacePath); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(record.WorkspacePath, []byte("hijack"), 0o600); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "view_dir_replaced_with_escaping_link",
			tamper: func(t *testing.T, record ViewRecord) {
				viewDir := filepath.Dir(record.WorkspacePath)
				if err := removeGeneration(viewDir); err != nil {
					t.Fatal(err)
				}
				outside := t.TempDir()
				if err := os.MkdirAll(filepath.Join(outside, "workspace", "inbox"), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := createTestDirectoryLink(outside, viewDir); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "view_dir_replaced_with_dangling_link",
			tamper: func(t *testing.T, record ViewRecord) {
				viewDir := filepath.Dir(record.WorkspacePath)
				if err := removeGeneration(viewDir); err != nil {
					t.Fatal(err)
				}
				if err := createTestDirectoryLink(filepath.Join(t.TempDir(), "missing-view"), viewDir); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "readonly_parent_dir_replaced_with_link",
			tamper: func(t *testing.T, record ViewRecord) {
				agentsDir := filepath.Join(record.WorkspacePath, ".agents")
				if err := removeGeneration(agentsDir); err != nil {
					t.Fatal(err)
				}
				outside := t.TempDir()
				if err := os.MkdirAll(filepath.Join(outside, "skills"), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := createTestDirectoryLink(outside, agentsDir); err != nil {
					t.Fatal(err)
				}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			content := newTestContent(t)
			store := openTestStore(t)
			var logs bytes.Buffer
			store.logger = slog.New(slog.NewJSONHandler(&logs, nil))

			message := content.file("message.txt", []byte("hello\n"))
			skill := content.file("pkg/SKILL.md", []byte("skill\n"))
			digest := content.publish(t, "context-1", "runtime-1", []Mapping{
				{Kind: "inbox_view", TargetPath: "inbox", Access: "read_only", Files: []FileInput{message}},
				{Kind: "memory", TargetPath: ".agents/skills", Access: "read_only", Files: []FileInput{skill}},
				{Kind: "playground", TargetPath: "playground", Access: "read_write"},
			}, nil, nil)
			source := ContentSource{ContentURL: content.url()}

			record, err := store.Ensure(t.Context(), testRequest("context-1", digest), source)
			if err != nil {
				t.Fatal(err)
			}
			content.takeRequests()
			logs.Reset()

			tc.tamper(t, record)

			if _, err := store.Ensure(t.Context(), testRequest("context-1", digest), source); err == nil {
				t.Fatal("Ensure succeeded despite security violation")
			}
			if reqs := content.takeRequests(); len(reqs) != 0 {
				t.Fatalf("Ensure attempted rebuild on security violation: %v", reqs)
			}
			if w := decodeRebuildWarnings(t, &logs); len(w) != 0 {
				t.Fatalf("security violation logged missing-workspace rebuild warning: %v", w)
			}
			ref := json.RawMessage(`{"view_digest":"` + digest + `"}`)
			if _, err := store.CurrentView(t.Context(), "context-1", digest); err == nil || errors.Is(err, os.ErrNotExist) {
				t.Fatalf("CurrentView on security violation = %v, want non-ErrNotExist error", err)
			}
			if _, err := store.ValidatedWorkspace(t.Context(), "context-1", ref); err == nil || errors.Is(err, os.ErrNotExist) {
				t.Fatalf("ValidatedWorkspace on security violation = %v, want non-ErrNotExist error", err)
			}
		})
	}
}

func TestReadOnlyLookupsFailClosedWhenWorkspaceDirectoryDeleted(t *testing.T) {
	content := newTestContent(t)
	store := openTestStore(t)
	message := content.file("message.txt", []byte("hello\n"))
	digest := content.publish(t, "context-1", "runtime-1", []Mapping{
		{Kind: "inbox_view", TargetPath: "inbox", Access: "read_only", Files: []FileInput{message}},
	}, nil, nil)
	source := ContentSource{ContentURL: content.url()}

	record, err := store.Ensure(t.Context(), testRequest("context-1", digest), source)
	if err != nil {
		t.Fatal(err)
	}
	if err := removeGeneration(filepath.Dir(record.WorkspacePath)); err != nil {
		t.Fatal(err)
	}

	ref := json.RawMessage(`{"view_digest":"` + digest + `"}`)
	for name, check := range map[string]func() error{
		"CurrentView": func() error {
			_, err := store.CurrentView(t.Context(), "context-1", digest)
			return err
		},
		"ValidatedView": func() error {
			_, err := store.ValidatedView(t.Context(), "context-1", ref)
			return err
		},
		"ValidatedWorkspace": func() error {
			_, err := store.ValidatedWorkspace(t.Context(), "context-1", ref)
			return err
		},
	} {
		err := check()
		if !errors.Is(err, ErrContextConflict) || !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s error = %v; want both ErrContextConflict and os.ErrNotExist", name, err)
		}
	}

	// Read-only lookups must not recreate the directory or mutate the SQLite row.
	if _, err := os.Lstat(filepath.Dir(record.WorkspacePath)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("read-only lookup recreated directory: %v", err)
	}
	var ready int
	var pending any
	if err := store.db.QueryRow(`SELECT ready, pending_projection_json FROM context_views_v3 WHERE execution_context_key=?`, "context-1").Scan(&ready, &pending); err != nil {
		t.Fatal(err)
	}
	if ready != 1 || pending != nil {
		t.Fatalf("read-only lookup mutated row: ready=%d pending=%v", ready, pending)
	}

	// Ensure rebuilds cleanly and restores read-only lookups.
	rebuilt, err := store.Ensure(t.Context(), testRequest("context-1", digest), source)
	if err != nil {
		t.Fatalf("Ensure rebuild: %v", err)
	}
	if got, err := store.ValidatedWorkspace(t.Context(), "context-1", ref); err != nil || got != rebuilt.WorkspacePath {
		t.Fatalf("ValidatedWorkspace after rebuild = %q, %v", got, err)
	}
}

func TestEnsureRebuildPreservesDeterministicPathAndSharedTaskLinks(t *testing.T) {
	content := newTestContent(t)
	store := openTestStore(t)
	sharedRoot := filepath.Join(t.TempDir(), "shared-tasks")
	if err := store.UseSharedTaskStorage(LocalSharedTaskStorage(sharedRoot)); err != nil {
		t.Fatal(err)
	}

	key := `["alter_ego","agent-1","task-1"]`
	scope := &SharedTaskScope{
		Version: 1, TenantID: "tenant-1", AgentID: "agent-1",
		OriginRoomID: "room-1", Role: "alter_ego", TaskID: "task-1",
	}
	message := content.file("message.txt", []byte("task brief\n"))
	digest := content.publish(t, key, "runtime-1", []Mapping{
		{Kind: "inbox_view", TargetPath: "inbox", Access: "read_only", Files: []FileInput{message}},
		{Kind: "playground", TargetPath: "playground", Access: "read_write"},
	}, scope, nil)
	source := ContentSource{ContentURL: content.url()}

	first, err := store.Ensure(t.Context(), testRequest(key, digest), source)
	if err != nil {
		t.Fatal(err)
	}
	// Write a deliverable into shared task storage via the workspace link.
	taskFile := filepath.Join(first.WorkspacePath, "playground", "task-1", "output.txt")
	if err := os.WriteFile(taskFile, []byte("shared deliverable"), 0o600); err != nil {
		t.Fatal(err)
	}

	// Delete the view directory while shared task storage and SQLite survive.
	if err := removeGeneration(filepath.Dir(first.WorkspacePath)); err != nil {
		t.Fatal(err)
	}

	rebuilt, err := store.Ensure(t.Context(), testRequest(key, digest), source)
	if err != nil {
		t.Fatalf("Ensure rebuild with shared task scope failed: %v", err)
	}
	if rebuilt.WorkspacePath != first.WorkspacePath {
		t.Fatalf("rebuilt path = %q, want deterministic %q", rebuilt.WorkspacePath, first.WorkspacePath)
	}
	requireContent(t, filepath.Join(rebuilt.WorkspacePath, "inbox", "message.txt"), "task brief\n")
	requireContent(t, filepath.Join(rebuilt.WorkspacePath, "playground", "task-1", "output.txt"), "shared deliverable")
}

func TestEnsureRebuildsRelocatedWorkspaceWithIntactOldPath(t *testing.T) {
	content := newTestContent(t)
	store := openTestStore(t)
	var logs bytes.Buffer
	store.logger = slog.New(slog.NewJSONHandler(&logs, nil))

	message := content.file("message.txt", []byte("hello relocated\n"))
	kept := content.file("kept.md", []byte("keep me relocated\n"))
	digest := content.publish(t, "context-1", "runtime-1", []Mapping{
		{Kind: "inbox_view", TargetPath: "inbox", Access: "read_only", Files: []FileInput{message}},
		{Kind: "memory", TargetPath: "memory", Access: "read_only", Files: []FileInput{kept}},
		{Kind: "playground", TargetPath: "playground", Access: "read_write"},
	}, nil, nil)
	source := ContentSource{ContentURL: content.url()}

	first, err := store.Ensure(t.Context(), testRequest("context-1", digest), source)
	if err != nil {
		t.Fatal(err)
	}
	localWork := filepath.Join(first.WorkspacePath, "playground", "notes.txt")
	if err := os.WriteFile(localWork, []byte("agent work"), 0o600); err != nil {
		t.Fatal(err)
	}

	// Keep the old path intact on disk while existing projection files remain
	// under the expected workspace path, simulating a copied LINGER_HOME.
	oldPath := filepath.Join(t.TempDir(), "old-linger", "context-views", filepath.Base(filepath.Dir(first.WorkspacePath)), "workspace")
	if err := os.MkdirAll(oldPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`UPDATE context_views_v3 SET workspace_path=? WHERE execution_context_key=?`, oldPath, first.View.ExecutionContextKey); err != nil {
		t.Fatal(err)
	}
	content.takeRequests()
	logs.Reset()

	rebuilt, err := store.Ensure(t.Context(), testRequest("context-1", digest), source)
	if err != nil {
		t.Fatalf("Ensure relocated rebuild failed: %v", err)
	}
	if rebuilt.WorkspacePath != first.WorkspacePath {
		t.Fatalf("rebuilt WorkspacePath = %q, want %q", rebuilt.WorkspacePath, first.WorkspacePath)
	}
	warnings := decodeRebuildWarnings(t, &logs)
	if len(warnings) != 1 {
		t.Fatalf("rebuild warnings = %d, want 1; logs=%s", len(warnings), logs.String())
	}
	if warnings[0]["reason"] != "workspace_relocated" {
		t.Fatalf("warning reason = %v, want %q", warnings[0]["reason"], "workspace_relocated")
	}
	requests := content.takeRequests()
	if len(requests) < 2 || requests[0] != "views/"+digest {
		t.Fatalf("relocated rebuild requests = %v, want manifest and files", requests)
	}
	requireContent(t, filepath.Join(rebuilt.WorkspacePath, "inbox", "message.txt"), "hello relocated\n")
	requireContent(t, filepath.Join(rebuilt.WorkspacePath, "memory", "kept.md"), "keep me relocated\n")
	requireContent(t, localWork, "agent work")
	if orphaned := orphanedDirectories(t, first.WorkspacePath); len(orphaned) != 1 {
		t.Fatalf("orphaned projections = %v, want 1 set-aside directory", orphaned)
	}
	if _, err := os.Stat(oldPath); err != nil {
		t.Fatalf("old workspace path was unexpectedly removed: %v", err)
	}

	// Next Ensure must take the fast path with zero requests and no warning.
	logs.Reset()
	again, err := store.Ensure(t.Context(), testRequest("context-1", digest), source)
	if err != nil || again.WorkspacePath != rebuilt.WorkspacePath {
		t.Fatalf("repeat Ensure = %+v, %v", again, err)
	}
	if reqs := content.takeRequests(); len(reqs) != 0 {
		t.Fatalf("repeat Ensure made requests after relocated rebuild: %v", reqs)
	}
	if w := decodeRebuildWarnings(t, &logs); len(w) != 0 {
		t.Fatalf("repeat Ensure emitted rebuild warning: %v", w)
	}
	if cur, err := store.CurrentView(t.Context(), "context-1", digest); err != nil || cur.WorkspacePath != rebuilt.WorkspacePath {
		t.Fatalf("CurrentView after relocated rebuild = %+v, %v", cur, err)
	}
}
