package lingercontext

import (
	"bytes"
	"encoding/base64"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func readWholePlaygroundFile(t *testing.T, store *ViewStore, folder PlaygroundFolder, relative string) []byte {
	t.Helper()
	var recovered []byte
	var offset int64
	for {
		result, err := store.ReadPlayground(t.Context(), "tenant-1", "agent-1", folder, relative, offset, MaxPlaygroundReadBytes)
		if err != nil {
			t.Fatal(err)
		}
		encoded := result["data_base64"].(string)
		if len(encoded) > 256*1024 {
			t.Fatalf("one read is %d base64 characters, over the Runner Gateway string limit", len(encoded))
		}
		chunk, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			t.Fatal(err)
		}
		recovered = append(recovered, chunk...)
		offset = result["next_offset"].(int64)
		if result["eof"] == true {
			return recovered
		}
	}
}

func TestLivePlaygroundReadsTaskOutputWithoutMetaMountAndRejectsOtherScopes(t *testing.T) {
	fixture := openSharedTaskFixture(t)
	alter := applyScoped(t, fixture.store, scopedView("alter-1", testAlterKey, alterScope("task-1", "room-1")))
	content := bytes.Repeat([]byte("output"), 100000)
	taskDir := filepath.Join(alter.WorkspacePath, "playground", "task-1")
	if err := os.WriteFile(filepath.Join(taskDir, "report.txt"), content, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.Close(); err != nil {
		t.Fatal(err)
	}
	fixture.reopen(t)
	folder := PlaygroundFolder{TaskID: "task-1", OriginRoomID: "room-1"}
	if !bytes.Equal(readWholePlaygroundFile(t, fixture.store, folder, "report.txt"), content) {
		t.Fatal("Live did not read the actual Task output")
	}
	listed, err := fixture.store.ListPlayground(t.Context(), "tenant-1", "agent-1", folder, "")
	if err != nil {
		t.Fatal(err)
	}
	files := listed["files"].([]map[string]any)
	if len(files) != 1 || files[0]["name"] != "report.txt" || files[0]["size"] != int64(len(content)) || files[0]["directory"] != false {
		t.Fatalf("list=%v", listed)
	}
	for _, wrong := range []struct {
		tenant, agent string
		folder        PlaygroundFolder
	}{
		{"other", "agent-1", folder},
		{"tenant-1", "other", folder},
		{"tenant-1", "agent-1", PlaygroundFolder{TaskID: "task-1", OriginRoomID: "other"}},
		{"tenant-1", "agent-1", PlaygroundFolder{TaskID: "task-2", OriginRoomID: "room-1"}},
		{"tenant-1", "agent-1", PlaygroundFolder{TaskID: "task-1", OriginRoomID: "room-1", RoomID: "room-1"}},
	} {
		if _, err := fixture.store.ReadPlayground(t.Context(), wrong.tenant, wrong.agent, wrong.folder, "report.txt", 0, 10); !errors.Is(err, ErrPlaygroundFolder) {
			t.Fatalf("cross-scope read %+v = %v", wrong, err)
		}
	}
	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := createTestFileLink(t, outside, filepath.Join(taskDir, "link")); err != nil {
		t.Fatal(err)
	}
	for _, filename := range []string{"../secret", outside, "link"} {
		if _, err := fixture.store.ReadPlayground(t.Context(), "tenant-1", "agent-1", folder, filename, 0, 10); err == nil {
			t.Fatalf("unsafe path accepted: %s", filename)
		}
	}
	if _, err := fixture.store.ReadPlayground(t.Context(), "tenant-1", "agent-1", folder, "report.txt", 0, MaxPlaygroundReadBytes+1); !errors.Is(err, ErrPlaygroundPath) {
		t.Fatalf("an over-limit read = %v", err)
	}
	if _, err := fixture.store.ReadPlayground(t.Context(), "tenant-1", "agent-1", folder, "missing.txt", 0, 10); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("a missing file = %v", err)
	}
}

func TestLivePlaygroundReadsTheMetaRoomFolder(t *testing.T) {
	fixture := openSharedTaskFixture(t)
	meta := applyScoped(t, fixture.store, scopedView("meta-1", testMetaKey, metaScope()))
	roomDir := filepath.Join(meta.WorkspacePath, "playground", "room-1")
	if err := os.MkdirAll(filepath.Join(roomDir, "drafts"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(roomDir, "drafts", "note.md"), []byte("# Note"), 0o600); err != nil {
		t.Fatal(err)
	}
	folder := PlaygroundFolder{RoomID: "room-1"}
	listed, err := fixture.store.ListPlayground(t.Context(), "tenant-1", "agent-1", folder, "")
	if err != nil {
		t.Fatal(err)
	}
	if files := listed["files"].([]map[string]any); len(files) != 1 || files[0]["name"] != "drafts" || files[0]["directory"] != true {
		t.Fatalf("list=%v", listed)
	}
	if got := readWholePlaygroundFile(t, fixture.store, folder, "drafts/note.md"); string(got) != "# Note" {
		t.Fatalf("read=%q", got)
	}
	if _, err := fixture.store.ListPlayground(t.Context(), "tenant-1", "agent-1", folder, "drafts/note.md"); !errors.Is(err, ErrPlaygroundNotFolder) {
		t.Fatalf("listing a file = %v", err)
	}
	if _, err := fixture.store.ReadPlayground(t.Context(), "tenant-1", "agent-1", folder, "drafts", 0, 10); !errors.Is(err, ErrPlaygroundNotFile) {
		t.Fatalf("reading a folder = %v", err)
	}
	for _, wrong := range []struct {
		tenant, agent, room string
	}{{"other", "agent-1", "room-1"}, {"tenant-1", "agent-2", "room-1"}, {"tenant-1", "agent-1", "room-2"}} {
		if _, err := fixture.store.ListPlayground(t.Context(), wrong.tenant, wrong.agent, PlaygroundFolder{RoomID: wrong.room}, ""); !errors.Is(err, ErrPlaygroundFolder) {
			t.Fatalf("another Room folder %+v = %v", wrong, err)
		}
	}
}
