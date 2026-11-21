package native

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// The test binary doubles as a fake `agy acp` when agyFakeEnv names a mode.
// Every request it reads is appended to agyFakeRecordEnv as one JSON line.
const (
	agyFakeEnv       = "NATIVE_AGY_FAKE"
	agyFakeRecordEnv = "AGY_FAKE_RECORD"
	agyFakeMetaEnv   = "AGY_FAKE_META"
	// agyFakeCommandEnv names the command a permission request asks for.
	agyFakeCommandEnv = "AGY_FAKE_COMMAND"
)

func init() {
	if mode := os.Getenv(agyFakeEnv); mode != "" {
		os.Exit(agyFake(mode, os.Args[1:]))
	}
}

type agyFakeProcess struct {
	mode      string
	geminiDir string
	logFile   string
	out       sync.Mutex
	record    *os.File
	authed    bool
	// answers carries the client's responses to the fake's own requests.
	answers chan map[string]any
}

func (f *agyFakeProcess) send(value any) {
	encoded, _ := json.Marshal(value)
	f.out.Lock()
	defer f.out.Unlock()
	_, _ = os.Stdout.Write(append(encoded, '\n'))
}

func (f *agyFakeProcess) result(id json.RawMessage, result any) {
	f.send(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func (f *agyFakeProcess) fail(id json.RawMessage, code int, message string) {
	f.send(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": message}})
}

func (f *agyFakeProcess) update(sessionID string, update map[string]any) {
	f.send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sessionID, "update": update}})
}

func agyFakeSession(id string) map[string]any {
	return map[string]any{
		"sessionId": id,
		"models": map[string]any{
			"availableModels": []any{
				map[string]any{"modelId": "gemini-pro-high", "name": "Gemini Pro (High)"},
				map[string]any{"modelId": "gemini-pro-low", "name": "Gemini Pro (Low)"},
				map[string]any{"modelId": "gemini-flash-medium", "name": "Gemini Flash (Medium)"},
			},
			"currentModelId": "gemini-pro-low",
		},
		"configOptions": []any{
			map[string]any{"id": "model", "category": "model", "currentValue": "gemini-pro", "options": []any{
				map[string]any{"value": "gemini-pro", "name": "Gemini Pro"},
				map[string]any{"value": "gemini-flash", "name": "Gemini Flash"},
			}},
			map[string]any{"id": "thought_level", "category": "thought_level", "currentValue": "low", "options": []any{}},
		},
	}
}

func agyFake(mode string, args []string) int {
	if len(args) == 0 || args[0] != "acp" {
		fmt.Fprintln(os.Stderr, "unexpected argv")
		return 2
	}
	var geminiDir, logFile string
	for i := 1; i < len(args); i += 2 {
		if i+1 >= len(args) {
			fmt.Fprintln(os.Stderr, "missing flag value")
			return 2
		}
		switch args[i] {
		case "--gemini-dir":
			geminiDir = args[i+1]
			if !filepath.IsAbs(geminiDir) {
				fmt.Fprintln(os.Stderr, "gemini-dir must be absolute")
				return 2
			}
		case "--log-file":
			logFile = args[i+1]
			if !filepath.IsAbs(logFile) {
				fmt.Fprintln(os.Stderr, "log-file must be absolute")
				return 2
			}
		default:
			fmt.Fprintln(os.Stderr, "unexpected flag:", args[i])
			return 2
		}
	}
	f := &agyFakeProcess{mode: mode, geminiDir: geminiDir, logFile: logFile, answers: make(chan map[string]any, 1)}
	f.writeStartupFiles(args)
	if path := os.Getenv(agyFakeRecordEnv); path != "" {
		f.record, _ = os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		line := scanner.Bytes()
		if f.record != nil {
			_, _ = f.record.Write(append(append([]byte{}, line...), '\n'))
		}
		var frame struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params map[string]any  `json:"params"`
			Result map[string]any  `json:"result"`
		}
		if json.Unmarshal(line, &frame) != nil {
			return 3
		}
		if frame.Method == "" {
			f.answers <- frame.Result
			continue
		}
		f.handle(frame.ID, frame.Method, frame.Params)
	}
	return 0
}

func (f *agyFakeProcess) appDataDir() string {
	if f.geminiDir != "" {
		return filepath.Join(f.geminiDir, "antigravity-cli")
	}
	return filepath.Join(os.Getenv("HOME"), ".gemini", "antigravity-cli")
}

func (f *agyFakeProcess) writeStartupFiles(args []string) {
	logPath := f.logFile
	if logPath == "" {
		logPath = filepath.Join(f.appDataDir(), "log", "acp-server.log")
	}
	_ = os.MkdirAll(filepath.Dir(logPath), 0o700)
	_ = os.WriteFile(logPath, []byte("started\n"), 0o600)

	metaPath := os.Getenv(agyFakeMetaEnv)
	if metaPath == "" {
		return
	}
	token, _ := os.ReadFile(filepath.Join(f.appDataDir(), "antigravity-oauth-token"))
	settings, _ := os.ReadFile(filepath.Join(f.appDataDir(), "settings.json"))
	meta, _ := json.Marshal(map[string]any{
		"args":      args,
		"geminiDir": f.geminiDir,
		"logFile":   f.logFile,
		"home":      os.Getenv("HOME"),
		"token":     string(token),
		"settings":  string(settings),
	})
	_ = os.WriteFile(metaPath, meta, 0o600)
}

func (f *agyFakeProcess) handle(id json.RawMessage, method string, params map[string]any) {
	switch method {
	case "initialize":
		f.result(id, map[string]any{"protocolVersion": 1, "agentInfo": map[string]any{"name": "fake"}})
	case "authenticate":
		f.authed = params["methodId"] == "gemini-api-key"
		f.result(id, map[string]any{})
	case "session/new", "session/load":
		if f.mode == "signed-out" && !f.authed {
			f.fail(id, acpAuthRequired, "Authentication required")
			return
		}
		if f.mode == "token-file" && !f.authed {
			token, err := os.ReadFile(filepath.Join(f.appDataDir(), "antigravity-oauth-token"))
			if err != nil || len(token) == 0 {
				f.fail(id, acpAuthRequired, "Authentication required")
				return
			}
		}
		sessionID := "fake-session"
		if method == "session/new" {
			convDir := filepath.Join(f.appDataDir(), "conversations")
			_ = os.MkdirAll(convDir, 0o700)
			_ = os.WriteFile(filepath.Join(convDir, sessionID+".db"), []byte("sqlite"), 0o600)
		}
		if method == "session/load" {
			sessionID, _ = params["sessionId"].(string)
			if f.mode == "load-error" {
				f.fail(id, -32603, "session could not be loaded")
				return
			}
			if f.mode == "load-hang" {
				select {}
			}
			// Loading replays the stored conversation before answering; an
			// id Antigravity never stored loads with nothing to replay.
			if f.mode != "unknown-session" {
				f.update(sessionID, map[string]any{"sessionUpdate": "user_message_chunk", "content": map[string]any{"type": "text", "text": "earlier prompt"}})
				f.update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "earlier reply"}})
			}
		}
		f.result(id, agyFakeSession(sessionID))
	case "session/set_config_option":
		if params["value"] == "unknown-model" {
			f.fail(id, -32602, "Unknown model ID: unknown-model")
			return
		}
		f.result(id, map[string]any{"configOptions": []any{}})
	case "session/prompt":
		go f.prompt(id, params["sessionId"].(string))
	case "session/cancel":
	default:
		f.fail(id, -32601, "method not found")
	}
}

func (f *agyFakeProcess) prompt(id json.RawMessage, sessionID string) {
	f.update(sessionID, map[string]any{"sessionUpdate": "agent_thought_chunk", "content": map[string]any{"type": "text", "text": "**Looking** around"}})
	f.update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "Let me check."}})
	f.update(sessionID, map[string]any{"sessionUpdate": "plan", "entries": []any{
		map[string]any{"content": "List files", "status": "in_progress", "priority": "high"},
		map[string]any{"content": "Report", "status": "pending", "priority": "low"},
	}})
	f.update(sessionID, map[string]any{"sessionUpdate": "tool_call", "toolCallId": "call-1", "name": "run_command", "title": "ls", "kind": "execute", "status": "pending", "rawInput": map[string]any{"CommandLine": "ls", "WaitMsBeforeAsync": 5000}})
	if f.mode == "permission" || f.mode == "permission-no-reject" {
		command := os.Getenv(agyFakeCommandEnv)
		if command == "" {
			command = "ls"
		}
		options := []any{map[string]any{"optionId": "allow", "name": "Allow", "kind": "allow_once"}}
		if f.mode == "permission" {
			options = append([]any{map[string]any{"optionId": "deny", "name": "Deny", "kind": "reject_once"}}, options...)
		}
		f.send(map[string]any{"jsonrpc": "2.0", "id": 900, "method": "session/request_permission", "params": map[string]any{
			"sessionId": sessionID,
			"toolCall":  map[string]any{"toolCallId": "call-1", "title": command, "kind": "execute", "rawInput": map[string]any{"CommandLine": command}},
			"options":   options,
		}})
		<-f.answers
	}
	if f.mode == "hang" {
		select {}
	}
	if strings.HasPrefix(f.mode, "background") {
		// Antigravity ends the turn while the command runs in the background
		// and continues on its own once it finishes.
		f.update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "Running in the background."}})
		f.result(id, map[string]any{"stopReason": "end_turn"})
		time.Sleep(50 * time.Millisecond)
		switch f.mode {
		case "background-exit":
			os.Exit(0)
		case "background-stuck":
			select {}
		}
	}
	f.update(sessionID, map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "call-1", "status": "completed", "content": []any{
		map[string]any{"type": "content", "content": map[string]any{"type": "text", "text": "a.txt"}},
	}})
	found := "Found "
	if f.mode == "background" {
		// Antigravity opens a continuation's text with a blank line.
		found = "\n\nFound "
	}
	f.update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": found}})
	f.update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "a.txt"}})
	if f.mode == "background" {
		// A turn may end on a tool call; the reply stays the last message.
		f.update(sessionID, map[string]any{"sessionUpdate": "tool_call", "toolCallId": "call-2", "name": "run_command", "title": "true", "kind": "execute", "status": "completed", "rawInput": map[string]any{"CommandLine": "true"}})
		return
	}
	f.result(id, map[string]any{"stopReason": "end_turn", "usage": map[string]any{"inputTokens": 10, "outputTokens": 4, "thoughtTokens": 2, "cachedReadTokens": 3}})
}
