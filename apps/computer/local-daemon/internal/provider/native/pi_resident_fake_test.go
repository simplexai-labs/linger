package native

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The resident fake Pi serves many prompts on one process. The prompt
// message picks the turn's behavior. It logs "<pid> spawn",
// "<pid> prompt:<msg>" and "<pid> steer:<msg>" to piResidentLogEnv.
const (
	piResidentLogEnv                 = "PI_RESIDENT_LOG"
	piResidentExitHangEnv            = "PI_RESIDENT_EXIT_HANG"
	piResidentSyncMCPEnv             = "PI_RESIDENT_SYNC_MCP"
	piResidentThinkingEnv            = "PI_RESIDENT_THINKING_MODEL"
	piResidentCompactModeEnv         = "PI_RESIDENT_COMPACT_MODE"
	piResidentCompactInstructionsEnv = "PI_RESIDENT_COMPACT_INSTRUCTIONS"
	piResidentMessageCountEnv        = "PI_RESIDENT_MESSAGE_COUNT"
	piResidentStateModelEnv          = "PI_RESIDENT_STATE_MODEL"
	piResidentStreamingFileEnv       = "PI_RESIDENT_STREAMING_FILE"
)

type piResidentFakeState struct {
	*piFakeProcess
	reader       *bufio.Reader
	mu           sync.Mutex
	pending      int
	streaming    bool
	compacting   bool
	compactAbort chan struct{}
	messageCount int
	lastEntryID  string
	entrySeq     int
}

func (f *piResidentFakeState) log(line string) {
	path := os.Getenv(piResidentLogEnv)
	if path == "" {
		return
	}
	if file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600); err == nil {
		_, _ = fmt.Fprintf(file, "%d %s\n", os.Getpid(), line)
		_ = file.Close()
	}
}

func piResidentFake(args []string) int {
	f := &piResidentFakeState{piFakeProcess: &piFakeProcess{}}
	for i := 0; i+1 < len(args); i++ {
		switch args[i] {
		case "--session-dir":
			f.sessionDir = args[i+1]
		case "--session-id":
			f.sessionID = args[i+1]
		}
	}
	if f.sessionDir == "" || f.sessionID == "" {
		return 21
	}
	f.syncSessionTail()
	if path := os.Getenv(piFakeArgvEnv); path != "" {
		_ = os.WriteFile(path, []byte(joinLines(args)), 0o600)
	}
	f.log("spawn")
	reader := bufio.NewReader(os.Stdin)
	f.reader = reader
	for {
		line, err := reader.ReadBytes('\n')
		if err == io.EOF {
			if os.Getenv(piResidentExitHangEnv) != "" {
				time.Sleep(time.Hour)
			}
			return 0
		}
		if err != nil {
			return 23
		}
		var command struct {
			ID                 string `json:"id"`
			Type               string `json:"type"`
			Message            string `json:"message"`
			Level              string `json:"level"`
			CustomInstructions string `json:"customInstructions"`
		}
		if json.Unmarshal(line, &command) != nil {
			return 22
		}
		if code := f.handle(command.ID, command.Type, command.Message, command.Level, command.CustomInstructions); code >= 0 {
			return code
		}
	}
}

func joinLines(args []string) string {
	out := ""
	for i, arg := range args {
		if i > 0 {
			out += "\n"
		}
		out += arg
	}
	return out
}

func (f *piResidentFakeState) sessionPath() string {
	return filepath.Join(f.sessionDir, "fixture_"+f.sessionID+".jsonl")
}

func (f *piResidentFakeState) syncSessionTail() {
	file, err := os.Open(f.sessionPath())
	if err != nil {
		return
	}
	defer file.Close()
	reader := bufio.NewReaderSize(file, 64<<10)
	count := 0
	lastID := ""
	for {
		line, err := reader.ReadBytes('\n')
		if trimmed := bytes.TrimSpace(line); len(trimmed) > 0 {
			var entry struct {
				Type string `json:"type"`
				ID   string `json:"id"`
			}
			if json.Unmarshal(trimmed, &entry) == nil && entry.Type != "" && entry.Type != "session" {
				count++
				if entry.ID != "" {
					lastID = entry.ID
				}
			}
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			break
		}
	}
	f.mu.Lock()
	f.lastEntryID = lastID
	f.entrySeq = count
	if count > 0 {
		f.messageCount = count
	}
	f.mu.Unlock()
}

func (f *piResidentFakeState) nextEntryID(prefix string) (id, parentID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.entrySeq++
	parentID = f.lastEntryID
	id = fmt.Sprintf("%s%d-%d", prefix, os.Getpid(), f.entrySeq)
	f.lastEntryID = id
	return id, parentID
}

func (f *piResidentFakeState) ensureHeader() {
	path := f.sessionPath()
	if _, err := os.Stat(path); err == nil {
		return
	}
	cwd, _ := os.Getwd()
	header, _ := json.Marshal(map[string]any{"type": "session", "version": 3, "id": f.sessionID, "cwd": cwd})
	_ = os.WriteFile(path, append(header, '\n'), 0o600)
}

func (f *piResidentFakeState) appendEntry(entry map[string]any) {
	encoded, err := json.Marshal(entry)
	if err != nil {
		return
	}
	if file, err := os.OpenFile(f.sessionPath(), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600); err == nil {
		_, _ = file.Write(append(encoded, '\n'))
		_ = file.Close()
	}
}

func (f *piResidentFakeState) appendMessage(role, text string) {
	id, parentID := f.nextEntryID("m")
	entry := map[string]any{
		"type": "message",
		"id":   id,
		"message": map[string]any{
			"role":    role,
			"content": []any{map[string]any{"type": "text", "text": text}},
		},
	}
	if parentID != "" {
		entry["parentId"] = parentID
	}
	f.appendEntry(entry)
}

func (f *piResidentFakeState) appendCompaction() string {
	f.ensureHeader()
	f.mu.Lock()
	firstKept := f.lastEntryID
	f.mu.Unlock()
	if firstKept == "" {
		firstKept = "e1"
	}
	id, parentID := f.nextEntryID("c")
	entry := map[string]any{
		"type":             "compaction",
		"id":               id,
		"summary":          "fixture summary",
		"firstKeptEntryId": firstKept,
		"tokensBefore":     32100,
	}
	if parentID != "" {
		entry["parentId"] = parentID
	}
	f.appendEntry(entry)
	f.mu.Lock()
	f.messageCount = 1
	f.mu.Unlock()
	return firstKept
}

func (f *piResidentFakeState) finishTurn(prompt string) {
	f.ensureHeader()
	f.appendMessage("user", prompt)
	f.appendMessage("assistant", "done")
	f.mu.Lock()
	f.messageCount += 2
	f.mu.Unlock()
	f.send(map[string]any{"type": "message_start", "message": map[string]any{"role": "assistant"}})
	f.send(map[string]any{"type": "message_update", "assistantMessageEvent": map[string]any{"type": "text_delta", "delta": "done"}})
	f.assistantEnd("done", "stop", "")
	f.send(map[string]any{"type": "agent_end"})
	f.send(map[string]any{"type": "agent_settled", "aborted": false})
}

func (f *piResidentFakeState) handle(id, kind, message, level, customInstructions string) int {
	switch kind {
	case "get_state":
		f.mu.Lock()
		msgCount := f.messageCount
		isCompacting := f.compacting
		isStreaming := f.streaming
		pending := f.pending
		f.mu.Unlock()
		if flag := os.Getenv(piResidentStreamingFileEnv); flag != "" {
			if _, err := os.Stat(flag); err == nil {
				isStreaming = true
			}
		}
		state := map[string]any{
			"sessionId":           f.sessionID,
			"isStreaming":         isStreaming,
			"isCompacting":        isCompacting,
			"pendingMessageCount": pending,
			"messageCount":        msgCount,
		}
		if raw := os.Getenv(piResidentMessageCountEnv); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil {
				state["messageCount"] = parsed
			}
		}
		if _, err := os.Stat(f.sessionPath()); err == nil {
			state["sessionFile"] = f.sessionPath()
		}
		if os.Getenv(piResidentThinkingEnv) != "" {
			state["thinkingLevel"] = "off"
			state["model"] = map[string]any{
				"provider":         "fixture",
				"id":               "clamped",
				"reasoning":        true,
				"thinkingLevelMap": map[string]any{"off": nil, "minimal": nil, "low": "low", "medium": nil, "high": nil},
			}
		} else if modelSpec := os.Getenv(piResidentStateModelEnv); modelSpec != "" {
			if provider, modelID, ok := strings.Cut(modelSpec, "/"); ok {
				state["model"] = map[string]any{"provider": provider, "id": modelID}
			} else {
				state["model"] = map[string]any{"id": modelSpec}
			}
		}
		f.reply(id, kind, state)
	case "set_thinking_level":
		f.log("thinking:" + level)
		f.reply(id, kind, nil)
	case "get_commands":
		commands := []map[string]any{}
		if os.Getenv(piResidentSyncMCPEnv) != "" {
			commands = append(commands, map[string]any{"name": piMCPSyncCommand, "source": "extension"})
		}
		f.reply(id, kind, map[string]any{"commands": commands})
	case "compact":
		f.log("compact:" + customInstructions)
		if path := os.Getenv(piResidentCompactInstructionsEnv); path != "" {
			_ = os.WriteFile(path, []byte(customInstructions), 0o600)
		}
		mode := os.Getenv(piResidentCompactModeEnv)
		switch {
		case mode == "fail":
			f.send(map[string]any{"type": "response", "id": id, "command": kind, "success": false, "error": "fixture compaction rejected"})
		case mode == "fail_streaming":
			f.mu.Lock()
			f.streaming = true
			f.mu.Unlock()
			f.send(map[string]any{"type": "response", "id": id, "command": kind, "success": false, "error": "fixture compaction rejected"})
		case mode == "exit":
			return 1
		case mode == "hang":
			abortCh := make(chan struct{})
			f.mu.Lock()
			f.compacting = true
			f.compactAbort = abortCh
			f.mu.Unlock()
			go func() {
				<-abortCh
				f.send(map[string]any{"type": "response", "id": id, "command": kind, "success": false, "error": "Compaction cancelled"})
			}()
		case strings.HasPrefix(mode, "wait_file:"):
			gatePath := strings.TrimPrefix(mode, "wait_file:")
			abortCh := make(chan struct{})
			f.mu.Lock()
			f.compacting = true
			f.compactAbort = abortCh
			f.mu.Unlock()
			go func() {
				for {
					select {
					case <-abortCh:
						f.send(map[string]any{"type": "response", "id": id, "command": kind, "success": false, "error": "Compaction cancelled"})
						return
					default:
					}
					if _, err := os.Stat(gatePath); err == nil {
						firstKept := f.appendCompaction()
						f.mu.Lock()
						f.compacting = false
						f.compactAbort = nil
						f.mu.Unlock()
						f.reply(id, kind, map[string]any{"summary": "fixture summary", "firstKeptEntryId": firstKept, "tokensBefore": 32100})
						return
					}
					time.Sleep(10 * time.Millisecond)
				}
			}()
		default:
			firstKept := f.appendCompaction()
			f.reply(id, kind, map[string]any{"summary": "fixture summary", "firstKeptEntryId": firstKept, "tokensBefore": 32100})
		}
	case "prompt":
		if message == "/"+piMCPSyncCommand && os.Getenv(piResidentSyncMCPEnv) != "" {
			mode := os.Getenv(piResidentSyncMCPEnv)
			configBytes, _ := os.ReadFile(os.Getenv(piMCPConfigEnvKey))
			f.log("sync_mcp:" + string(configBytes))
			verdict := map[string]any{"ok": true}
			if mode == "fail" {
				verdict = map[string]any{"ok": false, "error": "fixture MCP sync rejected"}
			}
			encoded, _ := json.Marshal(verdict)
			f.send(map[string]any{"type": "extension_ui_request", "id": "sync-" + id, "method": "input", "title": piMCPSyncDialog, "placeholder": string(encoded)})
			if _, err := f.reader.ReadBytes('\n'); err != nil {
				return 26
			}
			f.reply(id, kind, map[string]any{"disposition": "handled"})
			return -1
		}
		f.log("prompt:" + message)
		f.cleared = false
		f.reply(id, kind, map[string]any{"disposition": "started"})
		f.send(map[string]any{"type": "agent_start"})
		f.act(message)
	case "steer":
		f.log("steer:" + message)
		f.reply(id, kind, map[string]any{"disposition": "queued"})
		user := map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": message}}}
		f.send(map[string]any{"type": "message_start", "message": user})
		f.send(map[string]any{"type": "message_end", "message": user})
		f.finishTurn(message)
	case "clear_queue":
		f.cleared = true
		f.reply(id, kind, nil)
	case "abort":
		f.mu.Lock()
		compacting := f.compacting
		abortCh := f.compactAbort
		if compacting {
			f.compacting = false
			f.compactAbort = nil
		}
		f.mu.Unlock()
		if compacting {
			f.log("abort")
			if abortCh != nil {
				close(abortCh)
			}
			f.reply(id, kind, nil)
			return -1
		}
		if !f.cleared {
			return 24
		}
		f.send(map[string]any{"type": "agent_settled", "aborted": true})
		f.reply(id, kind, nil)
	default:
		return 25
	}
	return -1
}

// piSettleLaterDelay is how long a "settle_later" turn runs before it settles.
const piSettleLaterDelay = 200 * time.Millisecond

func (f *piResidentFakeState) act(message string) {
	switch message {
	case "hold":
	case "settle_later":
		go func() {
			time.Sleep(piSettleLaterDelay)
			f.finishTurn(message)
		}()
	case "fail":
		f.assistantEnd("", "error", "fixture failure")
		f.send(map[string]any{"type": "agent_end"})
		f.send(map[string]any{"type": "agent_settled", "aborted": false})
	case "no_assistant":
		f.send(map[string]any{"type": "agent_end"})
		f.send(map[string]any{"type": "agent_settled", "aborted": false})
	case "aborted":
		f.send(map[string]any{"type": "agent_settled", "aborted": true})
	case "pending":
		f.mu.Lock()
		f.pending = 1
		f.mu.Unlock()
		f.finishTurn(message)
	case "streaming":
		f.mu.Lock()
		f.streaming = true
		f.mu.Unlock()
		f.finishTurn(message)
	case "tools":
		for _, name := range []string{"read", "edit", "write", "grep", "bash", "powershell", "mcp__browser__navigate", "mcp__computer__run_actions", "notebook"} {
			f.tool("call_"+name, name, false)
		}
		f.finishTurn(message)
	default:
		f.finishTurn(message)
	}
}
