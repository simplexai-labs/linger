// Package runtimehistory inspects and sanitizes native Runtime session history.
package runtimehistory

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// InspectAntigravity reads one Antigravity conversation transcript with
// bounded, frozen pagination and redaction. Its root is resolved from the
// Computer user's Antigravity store, never from a wire path.
func InspectAntigravity(ctx context.Context, request Request) Page {
	page, err := inspectAntigravity(ctx, request)
	if err == nil {
		return page
	}
	reason := "transcript_unavailable"
	var detail *readError
	if errors.As(err, &detail) {
		reason = detail.reason
	}
	return Page{
		Status:       "unavailable",
		ProviderKind: "antigravity",
		Reason:       reason,
		Instructions: Instructions{
			Status: "unavailable",
			Source: "antigravity_transcript",
			Reason: reason,
			Blocks: []InstructionBlock{},
		},
		Records: []Record{},
	}
}

// OpenAntigravityTranscript safely opens one Antigravity conversation's
// transcript.jsonl under storeRoot using os.OpenRoot and segment-by-segment
// Lstat checks, rejecting invalid session IDs, symlinks, and non-regular files.
// The caller owns the returned *os.File and must close it.
func OpenAntigravityTranscript(storeRoot, sessionID string) (*os.File, os.FileInfo, error) {
	if strings.TrimSpace(storeRoot) == "" {
		return nil, nil, fail("transcript_unavailable")
	}
	if !threadIDRE.MatchString(sessionID) {
		return nil, nil, fail("transcript_session_invalid")
	}
	root, err := os.OpenRoot(storeRoot)
	if err != nil {
		return nil, nil, fail("transcript_unavailable")
	}
	defer root.Close()
	dirSegments := []string{
		"brain",
		filepath.Join("brain", sessionID),
		filepath.Join("brain", sessionID, ".system_generated"),
		filepath.Join("brain", sessionID, ".system_generated", "logs"),
	}
	for _, segment := range dirSegments {
		info, statErr := root.Lstat(segment)
		if statErr != nil {
			return nil, nil, fail("transcript_unavailable")
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, nil, fail("transcript_symlink")
		}
		if !info.IsDir() {
			return nil, nil, fail("transcript_unavailable")
		}
	}
	transcript := filepath.Join("brain", sessionID, ".system_generated", "logs", "transcript.jsonl")
	linkInfo, err := root.Lstat(transcript)
	if err != nil {
		return nil, nil, fail("transcript_unavailable")
	}
	if linkInfo.Mode()&os.ModeSymlink != 0 {
		return nil, nil, fail("transcript_symlink")
	}
	if !linkInfo.Mode().IsRegular() {
		return nil, nil, fail("transcript_unavailable")
	}
	file, err := root.Open(transcript)
	if err != nil {
		return nil, nil, fail("transcript_unavailable")
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, nil, fail("transcript_unavailable")
	}
	return file, info, nil
}

// OpenAntigravityTranscriptPath safely opens a single Antigravity transcript
// file at path using os.OpenRoot on its parent directory, rejecting symlinks
// and non-regular files. The caller owns the returned *os.File and must close
// it.
func OpenAntigravityTranscriptPath(path string) (*os.File, os.FileInfo, error) {
	if strings.TrimSpace(path) == "" {
		return nil, nil, fail("transcript_unavailable")
	}
	dir := filepath.Dir(path)
	base := filepath.Base(path)
	if base == "" || base == "." || base == ".." || base == string(filepath.Separator) {
		return nil, nil, fail("transcript_unavailable")
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, nil, fail("transcript_unavailable")
	}
	defer root.Close()
	linkInfo, err := root.Lstat(base)
	if err != nil {
		return nil, nil, fail("transcript_unavailable")
	}
	if linkInfo.Mode()&os.ModeSymlink != 0 {
		return nil, nil, fail("transcript_symlink")
	}
	if !linkInfo.Mode().IsRegular() {
		return nil, nil, fail("transcript_unavailable")
	}
	file, err := root.Open(base)
	if err != nil {
		return nil, nil, fail("transcript_unavailable")
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, nil, fail("transcript_unavailable")
	}
	return file, info, nil
}

func inspectAntigravity(ctx context.Context, request Request) (Page, error) {
	if err := ctx.Err(); err != nil {
		return Page{}, err
	}
	if !threadIDRE.MatchString(request.ThreadID) {
		return Page{}, fail("transcript_session_invalid")
	}
	if request.Limit == 0 {
		request.Limit = defaultPageLimit
	}
	if request.Limit < 1 || request.Limit > maxPageLimit {
		return Page{}, fail("history_limit_invalid")
	}
	var cursor *cursorPayload
	var err error
	if request.Cursor != "" {
		cursor, err = decodeCursor(request.Cursor, request.ThreadID)
		if err != nil {
			return Page{}, err
		}
	}
	file, info, err := OpenAntigravityTranscript(request.CodexHome, request.ThreadID)
	if err != nil {
		return Page{}, err
	}
	defer file.Close()
	if err := ctx.Err(); err != nil {
		return Page{}, err
	}
	count := info.Size()
	if cursor != nil {
		count = int64(cursor.SnapshotBytes)
	}
	if count < 1 {
		return Page{}, fail("transcript_unavailable")
	}
	if count > maxRolloutBytes {
		return Page{}, fail("transcript_too_large")
	}
	if info.Size() < count {
		return Page{}, fail("snapshot_expired")
	}
	raw := make([]byte, int(count))
	if _, err := io.ReadFull(io.NewSectionReader(file, 0, count), raw); err != nil {
		return Page{}, err
	}
	digestBytes := sha256.Sum256(raw)
	digest := base64.RawURLEncoding.EncodeToString(digestBytes[:])
	if cursor != nil && cursor.SnapshotDigest != digest {
		return Page{}, fail("snapshot_expired")
	}
	records, tail, err := parse(raw, request.CodexHome)
	if err != nil {
		return Page{}, err
	}
	turn := ""
	for i := range records {
		if err := ctx.Err(); err != nil {
			return Page{}, err
		}
		item := &records[i]
		if ts := antigravityTimestamp(item.original); ts != "" {
			item.history.Timestamp = ts
		}
		kind := stringValue(item.original, "type", 256)
		item.history.NativeType = first(kind, "unknown")
		item.history.Role = ""
		item.history.ToolName = ""
		item.history.ToolCallID = ""
		item.history.Phase = ""
		stepTurn := antigravityStepTurnID(item)
		switch kind {
		case "USER_INPUT":
			item.history.Category = "message"
			item.history.Role = "user"
			turn = stepTurn
			item.history.TurnID = turn
		case "PLANNER_RESPONSE":
			item.history.Role = "assistant"
			item.history.TurnID = first(turn, stepTurn)
			rawContent, _ := item.original["content"].(string)
			hasContent := strings.TrimSpace(rawContent) != ""
			toolCalls, _ := item.original["tool_calls"].([]any)
			hasToolCalls := len(toolCalls) > 0
			rawThinking, _ := item.original["thinking"].(string)
			hasThinking := strings.TrimSpace(rawThinking) != ""
			if hasToolCalls {
				item.history.ToolCallID = stringValue(objectValue(toolCalls[0]), "id", 256)
			}
			switch {
			case hasContent:
				item.history.Category = "message"
			case hasToolCalls:
				item.history.Category = "tool_call"
				item.history.ToolName = stringValue(objectValue(toolCalls[0]), "name", 256)
			case hasThinking:
				item.history.Category = "reasoning"
			default:
				item.history.Category = "provider_event"
			}
		case "GENERIC":
			item.history.Category = "tool_result"
			item.history.Role = ""
			item.history.TurnID = first(turn, stepTurn)
			item.history.ToolCallID = first(stringValue(item.original, "tool_call_id", 256), stringValue(item.original, "id", 256))
		case "CHECKPOINT":
			item.history.Category = "compaction"
			item.history.Role = "system"
			item.history.TurnID = first(turn, stepTurn)
		case "SYSTEM_MESSAGE":
			item.history.Category = "lifecycle"
			item.history.Role = "system"
			item.history.TurnID = first(turn, stepTurn)
		default:
			item.history.Category = "provider_event"
			item.history.TurnID = first(turn, stepTurn)
		}
	}
	instructions := Instructions{
		Status: "unavailable",
		Source: "antigravity_transcript",
		Reason: "Native transcript does not contain an instruction snapshot",
		Blocks: []InstructionBlock{},
	}
	end := len(records)
	now := time.Now
	if request.Now != nil {
		now = request.Now
	}
	captured := now().UTC().Format(time.RFC3339Nano)
	if cursor != nil {
		end = cursor.BeforeOrdinal
		captured = cursor.CapturedAt
	}
	if end < 0 || end > len(records) {
		return Page{}, fail("snapshot_expired")
	}
	start := end - request.Limit
	if start < 0 {
		start = 0
	}
	previous := ""
	if start > 0 {
		previous = encodeCursor(cursorPayload{
			Version:        cursorVersion,
			SessionID:      request.ThreadID,
			SnapshotBytes:  len(raw),
			SnapshotDigest: digest,
			CapturedAt:     captured,
			BeforeOrdinal:  start,
		})
	}
	snapshot := Snapshot{
		ID:          snapshotID(digest),
		SessionID:   request.ThreadID,
		CapturedAt:  captured,
		RecordCount: len(records),
		TailState:   tail,
	}
	selected := make([]Record, 0, end-start)
	for _, item := range records[start:end] {
		selected = append(selected, item.history)
	}
	selected = fitPage(selected, instructions, snapshot, previous)
	return Page{
		Status:         "available",
		ProviderKind:   "antigravity",
		Source:         "antigravity_transcript",
		Snapshot:       &snapshot,
		Instructions:   instructions,
		Records:        selected,
		PreviousCursor: previous,
	}, nil
}

func antigravityTimestamp(value map[string]any) string {
	result := stringValue(value, "created_at", 64)
	if result == "" || !timestampRE.MatchString(result) {
		return ""
	}
	if _, err := time.Parse(time.RFC3339Nano, result); err != nil {
		return ""
	}
	return result
}

func antigravityStepTurnID(item *parsedRecord) string {
	if raw, ok := item.original["step_index"].(float64); ok && raw >= 0 && math.Trunc(raw) == raw && raw <= maxJSONSafeInteger {
		return "step-" + strconv.FormatInt(int64(raw), 10)
	}
	return "ordinal-" + strconv.Itoa(item.ordinal)
}
