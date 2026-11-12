package voice

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
	api "github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
	voiceapi "github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

const (
	// maxVoiceLiveFileBytes bounds one file the live voice reads whole, to
	// attach it to an email or a Slack message.
	maxVoiceLiveFileBytes = 32 << 20
	// voiceLiveReadChunk is one read of a file; its base64 fits the Runner
	// Gateway's 256 KiB string limit.
	voiceLiveReadChunk = 192 << 10
	// voiceLiveCatBytes is what cat reads to print its first characters.
	voiceLiveCatBytes = 12 << 10
	voiceLiveCatRunes = 3000
	// voiceLiveCardDeadline lets a card's files upload from the Computer.
	voiceLiveCardDeadline = 120_000
)

// voiceLiveFolder is one folder of ./playground the call may open.
type voiceLiveFolder struct {
	display string
	// folder names it to the Computer: a Task's output or the Room's own.
	folder map[string]any
	// roomID is where a card with its files goes; taskID is set for a Task.
	roomID, taskID string
}

// voiceLiveFolder resolves ./playground/<name>/ from what the call may open:
// this Room's own folder, or the output of a task the call's user gave it and
// its Agent coordinates. It never trusts a model-supplied host path.
func (s *Service) voiceLiveFolder(ctx context.Context, session voicelive.Session, name string) (voiceLiveFolder, error) {
	display := voicelive.PlaygroundRoot + name + "/"
	if name == session.RoomID {
		return voiceLiveFolder{display: display, folder: map[string]any{"room_id": name}, roomID: name}, nil
	}
	task, err := s.queries.GetVoiceLiveTaskByWorkItem(ctx, store.GetVoiceLiveTaskByWorkItemParams{RoomID: session.RoomID, OwnerActorID: session.HumanActorID, WorkItemID: name})
	if errors.Is(err, pgx.ErrNoRows) {
		return voiceLiveFolder{}, voicelive.ErrNotFound
	}
	if err != nil {
		return voiceLiveFolder{}, err
	}
	authorized, err := s.queries.VoiceLiveTaskCoordinatedBy(ctx, store.VoiceLiveTaskCoordinatedByParams{TaskID: task.WorkItemID, TenantID: session.TenantID, CoordinatorActorID: session.Agent.ID})
	if err != nil {
		return voiceLiveFolder{}, err
	}
	if !authorized {
		return voiceLiveFolder{}, voicelive.ErrNotFound
	}
	return voiceLiveFolder{display: display, folder: map[string]any{"task_id": task.WorkItemID, "origin_room_id": task.HomeRoomID},
		roomID: task.HomeRoomID, taskID: task.WorkItemID}, nil
}

// callVoiceLivePlayground runs one file action on the Computer of the
// call's Agent.
func (s *Service) callVoiceLivePlayground(ctx context.Context, session voicelive.Session, name string, arguments map[string]any, deadlineMS int) (map[string]any, error) {
	target, _, ok, err := s.voiceLiveBrowserTarget(ctx, session)
	if err != nil {
		return nil, err
	}
	tools, supported := s.localComputers.(roomagent.LocalComputerTools)
	if !ok || !supported {
		return nil, &roomagent.LocalComputerToolError{Code: "computer_offline", Message: "The user's computer is not connected."}
	}
	call := api.LocalComputerToolCall{TenantId: session.TenantID, OwnerActorId: session.HumanActorID, ComputerId: target.ComputerID,
		AgentId: target.AgentManagementID, ToolSessionId: session.ID, Server: api.Playground, ToolName: name, Arguments: arguments}
	if deadlineMS > 0 {
		call.DeadlineMs = &deadlineMS
	}
	return tools.CallLocalComputerTool(ctx, call)
}

// voiceLiveFileError is what the live model is told when a file action fails.
func voiceLiveFileError(err error) (string, error) {
	var local *roomagent.LocalComputerToolError
	if errors.As(err, &local) {
		return voicelive.Output(map[string]string{"error": local.Code, "detail": local.Message}), nil
	}
	if errors.Is(err, voicelive.ErrNotFound) {
		return voicelive.Output(map[string]string{"error": "folder_not_found", "next": "ls ./playground/ lists the folders you can open."}), nil
	}
	return "", err
}

// voiceLiveFilePath resolves a file path the model gave.
func (s *Service) voiceLiveFilePath(ctx context.Context, session voicelive.Session, raw string) (voiceLiveFolder, string, string, error) {
	parsed, ok := voicelive.ParsePlaygroundPath(raw)
	if !ok {
		return voiceLiveFolder{}, "", voicelive.ErrorOutput("invalid_file_path"), nil
	}
	if parsed.Folder == "" || parsed.Inside == "" {
		return voiceLiveFolder{}, "", voicelive.ErrorOutput("not_a_file"), nil
	}
	folder, err := s.voiceLiveFolder(ctx, session, parsed.Folder)
	if err != nil {
		output, err := voiceLiveFileError(err)
		return voiceLiveFolder{}, "", output, err
	}
	return folder, parsed.Inside, "", nil
}

// listVoiceLiveFiles prints a folder like ls -lh.
func (s *Service) listVoiceLiveFiles(ctx context.Context, session voicelive.Session, request voiceapi.VoiceLiveToolCall) (string, error) {
	var args voicelive.PathArguments
	if voicelive.DecodeArguments(request.Arguments, &args) != nil {
		return "", voicelive.ErrInvalid
	}
	parsed, ok := voicelive.ParsePlaygroundPath(args.Path)
	if !ok {
		return voicelive.ErrorOutput("invalid_file_path"), nil
	}
	if parsed.Folder == "" {
		return s.listVoiceLiveFolders(ctx, session)
	}
	folder, err := s.voiceLiveFolder(ctx, session, parsed.Folder)
	if err != nil {
		return voiceLiveFileError(err)
	}
	result, err := s.callVoiceLivePlayground(ctx, session, "list", map[string]any{"folder": folder.folder, "path": parsed.Inside}, 0)
	if err != nil {
		return voiceLiveFileError(err)
	}
	var listed struct {
		Files []struct {
			Name      string `json:"name"`
			Directory bool   `json:"directory"`
			Size      int64  `json:"size"`
			Modified  string `json:"modified_ns"`
		} `json:"files"`
		Total int `json:"total"`
	}
	if err := remarshal(result, &listed); err != nil {
		return "", err
	}
	entries := make([]voicelive.ListEntry, 0, len(listed.Files))
	for _, file := range listed.Files {
		entry := voicelive.ListEntry{Name: file.Name, Directory: file.Directory, Size: file.Size}
		if nanos, err := strconv.ParseInt(file.Modified, 10, 64); err == nil {
			entry.Modified = time.Unix(0, nanos)
		}
		entries = append(entries, entry)
	}
	display := folder.display
	if parsed.Inside != "" {
		display += strings.TrimSuffix(parsed.Inside, "/") + "/"
	}
	return voicelive.FormatListing(display, entries, listed.Total), nil
}

// listVoiceLiveFolders prints ./playground/: the Room's own folder and the
// output folder of each task this call can talk about.
func (s *Service) listVoiceLiveFolders(ctx context.Context, session voicelive.Session) (string, error) {
	views, err := s.voiceLiveTaskViews(ctx, session)
	if err != nil {
		return "", err
	}
	var listing strings.Builder
	listing.WriteString(voicelive.PlaygroundRoot + "\n")
	fmt.Fprintf(&listing, "%s/  this room's own files\n", session.RoomID)
	for _, view := range views {
		if view.WorkItemID != "" {
			fmt.Fprintf(&listing, "%s/  %s output: %s\n", view.WorkItemID, voicelive.TaskID(view.Ordinal), voicelive.Snippet(view.Goal))
		}
	}
	return listing.String(), nil
}

// readVoiceLiveFile prints the first characters of a text file like cat.
func (s *Service) readVoiceLiveFile(ctx context.Context, session voicelive.Session, request voiceapi.VoiceLiveToolCall) (string, error) {
	var args voicelive.PathArguments
	if voicelive.DecodeArguments(request.Arguments, &args) != nil {
		return "", voicelive.ErrInvalid
	}
	folder, inside, output, err := s.voiceLiveFilePath(ctx, session, args.Path)
	if output != "" || err != nil {
		return output, err
	}
	result, err := s.callVoiceLivePlayground(ctx, session, "read", map[string]any{"folder": folder.folder, "path": inside, "offset": 0, "limit": voiceLiveCatBytes}, 0)
	if err != nil {
		return voiceLiveFileError(err)
	}
	chunk, err := decodeVoiceLiveChunk(result)
	if err != nil {
		return "", err
	}
	data := chunk.data
	if !chunk.EOF {
		// The read may end inside a character.
		for cut := 0; cut < utf8.UTFMax && len(data) > 0 && !utf8.Valid(data); cut++ {
			data = data[:len(data)-1]
		}
	}
	if !utf8.Valid(data) {
		return voicelive.ErrorOutput("not_text"), nil
	}
	text, truncated := voicelive.Truncate(string(data), voiceLiveCatRunes)
	if truncated || !chunk.EOF {
		text += fmt.Sprintf("\n… truncated (%s total)", voicelive.HumanSize(chunk.Size))
	}
	return text, nil
}

// sendVoiceLiveCard posts a card with files as the call's Agent. The Computer
// reads the files and commits the card through the Agent API, as `teamhub
// message card --attach` does; a Task whose files it carries counts as told.
func (s *Service) sendVoiceLiveCard(ctx context.Context, session voicelive.Session, request voiceapi.VoiceLiveToolCall) (string, error) {
	var args voicelive.SendCardArguments
	if voicelive.DecodeArguments(request.Arguments, &args) != nil {
		return "", voicelive.ErrInvalid
	}
	title, content := strings.TrimSpace(args.Title), strings.TrimSpace(args.Content)
	if title == "" || utf8.RuneCountInString(title) > 120 || strings.ContainsAny(title, "\r\n") || content == "" ||
		utf8.RuneCountInString(content) > 20000 || len(args.Attach) > voicelive.MaxCardFiles {
		return "", voicelive.ErrInvalid
	}
	// A Task's result goes to the Room that coordinates the Task, which is
	// this Room unless the Task came from a group Room.
	roomID, files, tasks := "", make([]map[string]any, 0, len(args.Attach)), []string{}
	for _, raw := range args.Attach {
		folder, inside, output, err := s.voiceLiveFilePath(ctx, session, raw)
		if output != "" || err != nil {
			return output, err
		}
		if roomID != "" && folder.roomID != roomID {
			return voicelive.ErrorOutput("files_from_different_rooms"), nil
		}
		roomID = folder.roomID
		if folder.taskID != "" && !slices.Contains(tasks, folder.taskID) {
			tasks = append(tasks, folder.taskID)
		}
		files = append(files, map[string]any{"folder": folder.folder, "path": inside})
	}
	if roomID == "" {
		roomID = session.RoomID
	}
	current, err := s.voiceLiveCurrent(ctx, session)
	if err != nil {
		return "", err
	}
	if !current {
		// A call that handed over may not post its result as well.
		return "", voicelive.ErrNotFound
	}
	result, err := s.callVoiceLivePlayground(ctx, session, "send_card", map[string]any{
		"operation_id": voiceLiveInvocationID(session, request), "inbox_id": "room:" + roomID,
		"title": title, "content": content, "files": files,
	}, voiceLiveCardDeadline)
	if err != nil {
		return voiceLiveFileError(err)
	}
	messageID, _ := result["message_id"].(string)
	if messageID == "" {
		return voicelive.Output(map[string]string{"error": "outcome_unknown", "detail": "The card may have been posted; check the chat before trying again."}), nil
	}
	if err := s.markVoiceLiveTasksTold(ctx, session, tasks, messageID); err != nil {
		return "", err
	}
	return voicelive.Output(map[string]any{"status": "delivered", "message_id": messageID, "documents": result["documents"]}), nil
}

// voiceLiveCurrent reports whether the call still holds the live lease.
func (s *Service) voiceLiveCurrent(ctx context.Context, session voicelive.Session) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	return s.queries.WithTx(tx).LockVoiceLiveSessionCurrent(ctx, session.ID)
}

// markVoiceLiveTasksTold records each Task's latest report as delivered by
// the card, so list_tasks no longer offers it as news.
func (s *Service) markVoiceLiveTasksTold(ctx context.Context, session voicelive.Session, tasks []string, messageID string) error {
	if len(tasks) == 0 {
		return nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	for _, task := range tasks {
		report, err := queries.GetVoiceLiveTaskLatestReport(ctx, store.GetVoiceLiveTaskLatestReportParams{TaskID: task, CoordinatorActorID: session.Agent.ID, TenantID: session.TenantID})
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		if err = queries.CreateVoiceLiveReportDelivery(ctx, store.CreateVoiceLiveReportDeliveryParams{ReportID: report, VoiceSessionID: session.ID, MessageID: messageID}); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// readVoiceLiveFileWhole reads a whole file into memory, chunk by chunk, to
// attach it to an email or a Slack message. It fails when the file changes
// while it is read.
func (s *Service) readVoiceLiveFileWhole(ctx context.Context, session voicelive.Session, folder voiceLiveFolder, inside string, w io.Writer) error {
	return copyVoiceLiveFile(func(offset int64) (map[string]any, error) {
		return s.callVoiceLivePlayground(ctx, session, "read", map[string]any{"folder": folder.folder, "path": inside, "offset": offset, "limit": voiceLiveReadChunk}, 0)
	}, w)
}

// copyVoiceLiveFile joins the reads read returns from each offset.
func copyVoiceLiveFile(read func(offset int64) (map[string]any, error), w io.Writer) error {
	var size int64 = -1
	var modified string
	var offset int64
	for {
		result, err := read(offset)
		if err != nil {
			return err
		}
		chunk, err := decodeVoiceLiveChunk(result)
		if err != nil {
			return err
		}
		if size < 0 {
			size, modified = chunk.Size, chunk.Modified
		}
		if size > maxVoiceLiveFileBytes {
			return &roomagent.LocalComputerToolError{Code: "file_too_large", Message: "The file is over 32 MiB."}
		}
		if chunk.Size != size || chunk.Modified != modified || chunk.Offset != offset || (!chunk.EOF && chunk.Next <= offset) {
			return &roomagent.LocalComputerToolError{Code: "file_changed", Message: "The file changed while it was read; try again."}
		}
		if _, err = w.Write(chunk.data); err != nil {
			return err
		}
		if chunk.EOF {
			return nil
		}
		offset = chunk.Next
	}
}

type voiceLiveChunk struct {
	Data     string `json:"data_base64"`
	Size     int64  `json:"size"`
	Modified string `json:"modified_ns"`
	Offset   int64  `json:"offset"`
	Next     int64  `json:"next_offset"`
	EOF      bool   `json:"eof"`
	data     []byte
}

func decodeVoiceLiveChunk(result map[string]any) (voiceLiveChunk, error) {
	var chunk voiceLiveChunk
	if err := remarshal(result, &chunk); err != nil {
		return chunk, err
	}
	var err error
	chunk.data, err = base64.StdEncoding.DecodeString(chunk.Data)
	if err != nil || chunk.Modified == "" || chunk.Size < 0 || chunk.Offset < 0 || chunk.Next != chunk.Offset+int64(len(chunk.data)) ||
		chunk.Next > chunk.Size || chunk.EOF != (chunk.Next == chunk.Size) || len(chunk.data) > voiceLiveReadChunk {
		return chunk, voicelive.ErrInvalid
	}
	return chunk, nil
}

func remarshal(value any, target any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, target)
}

// voiceLiveImageTypes are the image types a Document embeds.
var voiceLiveImageTypes = []string{"image/png", "image/jpeg", "image/gif", "image/webp"}

// inlineVoiceLiveImages embeds the ./playground images a new document shows,
// read from the user's Computer, as the Document import takes them. output
// is what the live model is told, naming the image, when one cannot be used.
func (s *Service) inlineVoiceLiveImages(ctx context.Context, session voicelive.Session, markdown string) (string, string, error) {
	uris := map[string]string{}
	for _, image := range voicelive.PlaygroundImages(markdown) {
		folder, inside, output, err := s.voiceLiveFilePath(ctx, session, image)
		if err != nil {
			return "", "", err
		}
		if output == "" {
			var content bytes.Buffer
			if readErr := s.readVoiceLiveFileWhole(ctx, session, folder, inside, &content); readErr != nil {
				if output, err = voiceLiveFileError(readErr); err != nil {
					return "", "", err
				}
			} else if mediaType := http.DetectContentType(content.Bytes()); !slices.Contains(voiceLiveImageTypes, mediaType) {
				output = voicelive.ErrorOutput("not_an_image")
			} else {
				uris[image] = "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(content.Bytes())
			}
		}
		if output != "" {
			var fields map[string]any
			if err := json.Unmarshal([]byte(output), &fields); err != nil {
				return "", "", err
			}
			fields["image"] = image
			return "", voicelive.Output(fields), nil
		}
	}
	return voicelive.InlineImages(markdown, uris), "", nil
}
