package lingercontext

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// PlaygroundFolder names one folder the live voice may read: a delegated
// Task's output folder, or a Meta Room's own folder. TeamHub authorizes the
// names; this endpoint only resolves folders it retained for the Agent.
type PlaygroundFolder struct {
	TaskID       string `json:"task_id,omitempty"`
	OriginRoomID string `json:"origin_room_id,omitempty"`
	RoomID       string `json:"room_id,omitempty"`
}

var (
	// ErrPlaygroundFolder means the endpoint holds no such folder for the Agent.
	ErrPlaygroundFolder = errors.New("playground folder is not available to this Agent")
	// ErrPlaygroundPath means a path is malformed, leaves its folder or passes a link.
	ErrPlaygroundPath = errors.New("playground path is invalid")
	// ErrPlaygroundNotFolder means a list named a file.
	ErrPlaygroundNotFolder = errors.New("playground path is not a folder")
	// ErrPlaygroundNotFile means a read named a folder or a special file.
	ErrPlaygroundNotFile = errors.New("playground path is not a single regular file")
)

const (
	// maxPlaygroundEntries bounds one listing.
	maxPlaygroundEntries = 100
	// MaxPlaygroundReadBytes keeps one read's base64 inside the Runner
	// Gateway's 256 KiB string limit.
	MaxPlaygroundReadBytes = 192 * 1024
)

// PlaygroundDirectory resolves folder to its directory on this endpoint.
func (s *ViewStore) PlaygroundDirectory(ctx context.Context, tenantID, agentID string, folder PlaygroundFolder) (string, error) {
	if tenantID == "" || agentID == "" {
		return "", ErrPlaygroundFolder
	}
	switch {
	case folder.TaskID != "" && folder.OriginRoomID != "" && folder.RoomID == "":
		return s.taskPlaygroundDirectory(ctx, SharedTaskScope{Version: 1, TenantID: tenantID, AgentID: agentID,
			OriginRoomID: folder.OriginRoomID, Role: sharedTaskRoleAlterEgo, TaskID: folder.TaskID})
	case folder.RoomID != "" && folder.TaskID == "" && folder.OriginRoomID == "":
		return s.roomPlaygroundDirectory(ctx, tenantID, agentID, folder.RoomID)
	default:
		return "", ErrPlaygroundFolder
	}
}

func (s *ViewStore) taskPlaygroundDirectory(ctx context.Context, scope SharedTaskScope) (string, error) {
	if !sharedTaskIDPattern.MatchString(scope.TaskID) {
		return "", ErrPlaygroundFolder
	}
	storage := s.sharedTaskStorage()
	if storage == nil {
		return "", ErrSharedTaskStorageUnavailable
	}
	var found bool
	err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM shared_task_scopes WHERE json_extract(scope_json,'$.tenant_id')=? AND json_extract(scope_json,'$.agent_id')=? AND json_extract(scope_json,'$.origin_room_id')=? AND json_extract(scope_json,'$.task_id')=? AND json_extract(scope_json,'$.role')='alter_ego')`, scope.TenantID, scope.AgentID, scope.OriginRoomID, scope.TaskID).Scan(&found)
	if err != nil {
		return "", err
	}
	if !found {
		return "", ErrPlaygroundFolder
	}
	directory := storage.taskDirectory(scope, scope.TaskID)
	relative, err := filepath.Rel(storage.root, directory)
	if err != nil {
		return "", err
	}
	return directory, realDirectories(storage.root, relative)
}

// roomPlaygroundDirectory is ./playground/<roomID> of the Agent's Meta
// Context for that Room, the folder its Meta Runs write.
func (s *ViewStore) roomPlaygroundDirectory(ctx context.Context, tenantID, agentID, roomID string) (string, error) {
	if !sharedTaskIDPattern.MatchString(roomID) {
		return "", ErrPlaygroundFolder
	}
	key, err := json.Marshal([]string{"meta", agentID, "room", roomID})
	if err != nil {
		return "", err
	}
	record, err := s.readOnce(ctx, string(key))
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrPlaygroundFolder
	}
	if err != nil {
		return "", err
	}
	if record.View.TenantID != tenantID || record.View.AgentID != agentID {
		return "", ErrPlaygroundFolder
	}
	return filepath.Join(record.WorkspacePath, sharedTaskPlayground, roomID),
		realDirectories(record.WorkspacePath, filepath.Join(sharedTaskPlayground, roomID))
}

// realDirectories requires every component of relative under root to be a
// real directory, so no link leads out of the folder.
func realDirectories(root, relative string) error {
	current := root
	for _, part := range append([]string{""}, strings.Split(relative, string(filepath.Separator))...) {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, fs.ErrNotExist) {
			return ErrPlaygroundFolder
		}
		if err != nil {
			return err
		}
		if !realDirectory(info) {
			return fmt.Errorf("%w: %s", ErrSharedTaskPathConflict, current)
		}
	}
	return nil
}

// OpenPlaygroundFile opens one regular file of a folder. A link anywhere on
// its path, or a file with another hard link, is refused.
func (s *ViewStore) OpenPlaygroundFile(ctx context.Context, tenantID, agentID string, folder PlaygroundFolder, relative string) (*os.File, os.FileInfo, error) {
	directory, err := s.PlaygroundDirectory(ctx, tenantID, agentID, folder)
	if err != nil {
		return nil, nil, err
	}
	file, err := openPlaygroundPath(directory, relative)
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err == nil && (!info.Mode().IsRegular() || !singleLink(info)) {
		err = ErrPlaygroundNotFile
	}
	if err != nil {
		_ = file.Close()
		return nil, nil, err
	}
	return file, info, nil
}

// PlaygroundFilePath is the path of one regular file of a folder, checked
// the way OpenPlaygroundFile checks it, for a program that reads it itself.
func (s *ViewStore) PlaygroundFilePath(ctx context.Context, tenantID, agentID string, folder PlaygroundFolder, relative string) (string, error) {
	file, _, err := s.OpenPlaygroundFile(ctx, tenantID, agentID, folder, relative)
	if err != nil {
		return "", err
	}
	_ = file.Close()
	directory, err := s.PlaygroundDirectory(ctx, tenantID, agentID, folder)
	if err != nil {
		return "", err
	}
	return filepath.Join(directory, filepath.FromSlash(strings.Trim(relative, "/"))), nil
}

func openPlaygroundPath(directory, relative string) (*os.File, error) {
	relative = filepath.FromSlash(strings.Trim(relative, "/"))
	if relative == "" || relative == "." {
		return os.Open(directory)
	}
	if _, err := safeJoin(directory, relative); err != nil {
		return nil, ErrPlaygroundPath
	}
	file, err := openContextFile(directory, relative)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, ErrPlaygroundPath
	}
	return file, err
}

// ListPlayground lists one folder: name, whether it is a folder, size and
// modification time of up to 100 entries. Links are left out.
func (s *ViewStore) ListPlayground(ctx context.Context, tenantID, agentID string, folder PlaygroundFolder, relative string) (map[string]any, error) {
	directory, err := s.PlaygroundDirectory(ctx, tenantID, agentID, folder)
	if err != nil {
		return nil, err
	}
	file, err := openPlaygroundPath(directory, relative)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if info, err := file.Stat(); err != nil {
		return nil, err
	} else if !info.IsDir() {
		return nil, ErrPlaygroundNotFolder
	}
	entries, err := file.ReadDir(-1)
	if err != nil {
		return nil, err
	}
	items := make([]map[string]any, 0, min(len(entries), maxPlaygroundEntries))
	total := 0
	for _, entry := range entries {
		if entry.Type()&(os.ModeSymlink|os.ModeIrregular) != 0 {
			continue
		}
		total++
		if len(items) == maxPlaygroundEntries {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		item := map[string]any{"name": entry.Name(), "directory": entry.IsDir(), "modified_ns": strconv.FormatInt(info.ModTime().UnixNano(), 10)}
		if !entry.IsDir() {
			item["size"] = info.Size()
		}
		items = append(items, item)
	}
	return map[string]any{"files": items, "total": total}, nil
}

// ReadPlayground reads up to limit bytes of one file from offset. TeamHub
// joins reads into a whole file and checks it did not change in between.
func (s *ViewStore) ReadPlayground(ctx context.Context, tenantID, agentID string, folder PlaygroundFolder, relative string, offset, limit int64) (map[string]any, error) {
	if offset < 0 || limit <= 0 || limit > MaxPlaygroundReadBytes {
		return nil, ErrPlaygroundPath
	}
	file, info, err := s.OpenPlaygroundFile(ctx, tenantID, agentID, folder, relative)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if _, err = file.Seek(offset, io.SeekStart); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(file, limit))
	if err != nil {
		return nil, err
	}
	next := offset + int64(len(data))
	return map[string]any{"data_base64": base64.StdEncoding.EncodeToString(data), "size": info.Size(),
		"modified_ns": strconv.FormatInt(info.ModTime().UnixNano(), 10), "offset": offset, "next_offset": next,
		"eof": next >= info.Size()}, nil
}
