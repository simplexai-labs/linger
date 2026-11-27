package native

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The test binary doubles as a fake `agy acp` when agyFakeEnv names a mode.
// Every request it reads is appended to agyFakeRecordEnv as one JSON line.
const (
	agyFakeEnv                    = "NATIVE_AGY_FAKE"
	agyFakeRecordEnv              = "AGY_FAKE_RECORD"
	agyFakeMetaEnv                = "AGY_FAKE_META"
	agyFakeCapabilitiesEnv        = "AGY_FAKE_CAPABILITIES"
	agyFakeMCPCallEnv             = "AGY_FAKE_MCP_CALL"
	agyFakePIDFileEnv             = "AGY_FAKE_PID_FILE"
	agyFakeGateEnv                = "AGY_FAKE_GATE"
	agyFakeNoDefaultsEnv          = "AGY_FAKE_NO_DEFAULTS"
	agyFakeSessionIDEnv           = "AGY_FAKE_SESSION_ID"
	agyFakeTranscriptEnv          = "AGY_FAKE_TRANSCRIPT"
	agyFakeCompactTranscriptEnv   = "AGY_FAKE_COMPACT_TRANSCRIPT"
	agyFakeCompactInitialStepsEnv = "AGY_FAKE_COMPACT_INITIAL_STEPS"
	agyFakeCompactModeEnv         = "AGY_FAKE_COMPACT_MODE"
	agyFakeCompactGateEnv         = "AGY_FAKE_COMPACT_GATE"
	agyFakeCompactPermOutEnv      = "AGY_FAKE_COMPACT_PERM_OUT"
	// agyFakeCommandEnv names the command a permission request asks for.
	agyFakeCommandEnv = "AGY_FAKE_COMMAND"
)

func init() {
	if len(os.Args) == 3 && os.Args[1] == "antigravity-hook" {
		os.Exit(AntigravityRunHook(os.Stdin, os.Stdout, os.Stderr, os.Args[2]))
	}
	if mode := os.Getenv(agyFakeEnv); mode != "" {
		os.Exit(agyFake(mode, os.Args[1:]))
	}
}

type agyFakeMCPTarget struct {
	name    string
	url     string
	headers map[string]string
}

type agyFakeProcess struct {
	mode      string
	geminiDir string
	logFile   string
	addDir    string
	out       sync.Mutex
	record    *os.File
	authed    bool
	mcpMu     sync.Mutex
	mcpList   []agyFakeMCPTarget
	// answers carries the client's responses to the fake's own requests.
	answers     chan map[string]any
	closed      chan struct{}
	promptMu    sync.Mutex
	promptCount int
	p1ID        json.RawMessage
	p1Done      bool
	toolDone    chan struct{}
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
	configOptions := []any{
		map[string]any{"id": "model", "category": "model", "currentValue": "gemini-pro", "options": []any{
			map[string]any{"value": "gemini-pro", "name": "Gemini Pro"},
			map[string]any{"value": "gemini-flash", "name": "Gemini Flash"},
		}},
		map[string]any{"id": "thought_level", "category": "thought_level", "currentValue": "low", "options": []any{}},
	}
	if os.Getenv(agyFakeNoDefaultsEnv) == "1" {
		configOptions = []any{}
	}
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
		"configOptions": configOptions,
	}
}

func agyFakeInitializeResult() map[string]any {
	result := map[string]any{
		"protocolVersion": 1,
		"agentInfo":       map[string]any{"name": "fake"},
	}
	switch os.Getenv(agyFakeCapabilitiesEnv) {
	case "full":
		result["agentCapabilities"] = map[string]any{
			"sessionCapabilities": map[string]any{"list": map[string]any{}, "resume": map[string]any{}},
		}
	case "snake":
		result["agentCapabilities"] = map[string]any{
			"session_capabilities": map[string]any{"list": map[string]any{}, "resume": map[string]any{}},
		}
	case "no-list":
		result["agentCapabilities"] = map[string]any{
			"sessionCapabilities": map[string]any{"resume": map[string]any{}},
		}
	case "no-resume":
		result["agentCapabilities"] = map[string]any{
			"sessionCapabilities": map[string]any{"list": map[string]any{}},
		}
	case "false":
		result["agentCapabilities"] = map[string]any{
			"sessionCapabilities": map[string]any{"list": false, "resume": false},
		}
	case "null":
		result["agentCapabilities"] = map[string]any{
			"sessionCapabilities": map[string]any{"list": nil, "resume": nil},
		}
	}
	return result
}

func agyFake(mode string, args []string) int {
	if len(args) == 0 || args[0] != "acp" {
		fmt.Fprintln(os.Stderr, "unexpected argv")
		return 2
	}
	var geminiDir, logFile, addDir string
	for i := 1; i < len(args); {
		if args[i] == "--include-default-customizations=false" {
			i++
			continue
		}
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
		case "--add-dir":
			addDir = args[i+1]
			if !filepath.IsAbs(addDir) {
				fmt.Fprintln(os.Stderr, "add-dir must be absolute")
				return 2
			}
		default:
			fmt.Fprintln(os.Stderr, "unexpected flag:", args[i])
			return 2
		}
		i += 2
	}
	f := &agyFakeProcess{
		mode:      mode,
		geminiDir: geminiDir,
		logFile:   logFile,
		addDir:    addDir,
		answers:   make(chan map[string]any, 1),
		closed:    make(chan struct{}),
		toolDone:  make(chan struct{}),
	}
	f.writeStartupFiles(args)
	if pidFile := os.Getenv(agyFakePIDFileEnv); pidFile != "" {
		if file, err := os.OpenFile(pidFile, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600); err == nil {
			_, _ = fmt.Fprintf(file, "%d\n", os.Getpid())
			_ = file.Close()
		}
	}
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
			close(f.closed)
			return 3
		}
		if frame.Method == "" {
			f.answers <- frame.Result
			continue
		}
		f.handle(frame.ID, frame.Method, frame.Params)
	}
	close(f.closed)
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
		"addDir":    f.addDir,
		"home":      os.Getenv("HOME"),
		"token":     string(token),
		"settings":  string(settings),
	})
	_ = os.WriteFile(metaPath, meta, 0o600)
}

func (f *agyFakeProcess) callHook(payload map[string]any) AntigravityHookResponse {
	if f.addDir == "" {
		return AntigravityHookResponse{}
	}
	raw, err := os.ReadFile(filepath.Join(f.addDir, ".agents", "hooks.json"))
	if err != nil {
		return AntigravityHookResponse{}
	}
	var doc map[string]map[string][]map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		return AntigravityHookResponse{}
	}
	eventName, _ := payload["hookEventName"].(string)
	cmdStr := agyFakeHookCommand(doc, eventName)
	if cmdStr == "" {
		return AntigravityHookResponse{}
	}
	arg := ""
	if strings.Contains(cmdStr, antigravityHookDenyToolsArg) {
		arg = antigravityHookDenyToolsArg
	} else if idx := strings.Index(cmdStr, "http://127.0.0.1:"); idx >= 0 {
		urlPart := cmdStr[idx:]
		if end := strings.IndexAny(urlPart, "'\" "); end >= 0 {
			urlPart = urlPart[:end]
		}
		arg = urlPart
	}
	if arg == "" {
		return AntigravityHookResponse{}
	}
	encoded, _ := json.Marshal(payload)
	var out, errBuf bytes.Buffer
	if AntigravityRunHook(bytes.NewReader(encoded), &out, &errBuf, arg) != 0 {
		return AntigravityHookResponse{}
	}
	var resp AntigravityHookResponse
	_ = json.Unmarshal(out.Bytes(), &resp)
	return resp
}

func agyFakeHookCommand(doc map[string]map[string][]map[string]any, eventName string) string {
	for _, group := range doc {
		entries := group[eventName]
		for _, entry := range entries {
			if cmd, ok := entry["command"].(string); ok && cmd != "" {
				return cmd
			}
			if nested, ok := entry["hooks"].([]any); ok {
				for _, item := range nested {
					if m, ok := item.(map[string]any); ok {
						if cmd, ok := m["command"].(string); ok && cmd != "" {
							return cmd
						}
					}
				}
			}
		}
	}
	return ""
}

func (f *agyFakeProcess) checkAuth(id json.RawMessage) bool {
	if f.mode == "signed-out" && !f.authed {
		f.fail(id, acpAuthRequired, "Authentication required")
		return false
	}
	if f.mode == "token-file" && !f.authed {
		token, err := os.ReadFile(filepath.Join(f.appDataDir(), "antigravity-oauth-token"))
		if err != nil || len(token) == 0 {
			f.fail(id, acpAuthRequired, "Authentication required")
			return false
		}
	}
	return true
}

func (f *agyFakeProcess) rememberMCPServers(raw any) {
	list, ok := raw.([]any)
	if !ok || len(list) == 0 {
		return
	}
	var parsed []agyFakeMCPTarget
	for _, item := range list {
		server, ok := item.(map[string]any)
		if !ok {
			continue
		}
		targetURL, _ := server["url"].(string)
		if targetURL == "" {
			continue
		}
		name, _ := server["name"].(string)
		headers := map[string]string{}
		if rawHeaders, ok := server["headers"].([]any); ok {
			for _, pair := range rawHeaders {
				if obj, ok := pair.(map[string]any); ok {
					k, _ := obj["name"].(string)
					v, _ := obj["value"].(string)
					if k != "" {
						headers[k] = v
					}
				}
			}
		}
		parsed = append(parsed, agyFakeMCPTarget{name: name, url: targetURL, headers: headers})
	}
	f.mcpMu.Lock()
	f.mcpList = parsed
	f.mcpMu.Unlock()
}

func (f *agyFakeProcess) handle(id json.RawMessage, method string, params map[string]any) {
	switch method {
	case "initialize":
		f.result(id, agyFakeInitializeResult())
	case "authenticate":
		f.authed = params["methodId"] == "gemini-api-key"
		f.result(id, map[string]any{})
	case "session/list":
		if !f.checkAuth(id) {
			return
		}
		if f.mode == "list-error" {
			f.fail(id, -32603, "session list failed")
			return
		}
		f.result(id, map[string]any{"sessions": []any{}})
	case "session/new", "session/load", "session/resume":
		if !f.checkAuth(id) {
			return
		}
		sessionID := os.Getenv(agyFakeSessionIDEnv)
		if sessionID == "" {
			sessionID = "fake-session"
		}
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
		if method == "session/resume" {
			sessionID, _ = params["sessionId"].(string)
			if f.mode == "unknown-session" || f.mode == "load-error" || f.mode == "resume-error" {
				f.fail(id, -32603, "session could not be resumed")
				return
			}
			if f.mode == "load-hang" {
				select {}
			}
		}
		f.rememberMCPServers(params["mcpServers"])
		f.result(id, agyFakeSession(sessionID))
	case "session/set_config_option":
		if params["value"] == "unknown-model" {
			f.fail(id, -32602, "Unknown model ID: unknown-model")
			return
		}
		f.result(id, map[string]any{"configOptions": []any{}})
	case "session/prompt":
		promptText := ""
		if blocks, ok := params["prompt"].([]any); ok && len(blocks) > 0 {
			if first, ok := blocks[0].(map[string]any); ok {
				promptText, _ = first["text"].(string)
			}
		}
		go f.prompt(id, params["sessionId"].(string), promptText)
	case "session/cancel":
	default:
		f.fail(id, -32601, "method not found")
	}
}

func (f *agyFakeProcess) callMCPServers(sessionID, promptText string) error {
	f.mcpMu.Lock()
	targets := append([]agyFakeMCPTarget(nil), f.mcpList...)
	f.mcpMu.Unlock()
	client := &http.Client{Timeout: 5 * time.Second}
	for _, target := range targets {
		body, _ := json.Marshal(map[string]any{
			"server":    target.name,
			"sessionId": sessionID,
			"prompt":    promptText,
			"pid":       os.Getpid(),
		})
		req, err := http.NewRequest(http.MethodPost, target.url, bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		for k, v := range target.headers {
			req.Header.Set(k, v)
		}
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return fmt.Errorf("MCP server %s returned %d", target.name, resp.StatusCode)
		}
	}
	return nil
}

func (f *agyFakeProcess) prompt(id json.RawMessage, sessionID, promptText string) {
	if gate := os.Getenv(agyFakeGateEnv); gate != "" {
		_ = os.WriteFile(gate+".started", []byte(strconv.Itoa(os.Getpid())), 0o600)
		for {
			if _, err := os.Stat(gate); err == nil {
				break
			}
			select {
			case <-f.closed:
				return
			case <-time.After(10 * time.Millisecond):
			}
		}
	}
	if f.mode == "prompt-error" {
		f.fail(id, -32603, "prompt execution failed")
		return
	}
	if f.mode == "inline-error" {
		f.update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "\n\u26a0 FAILED_PRECONDITION (code 400): User location is not supported for the API use.\n"}})
		f.result(id, map[string]any{"stopReason": "end_turn"})
		return
	}
	if f.mode == "empty-end-turn" {
		f.result(id, map[string]any{"stopReason": "end_turn"})
		return
	}
	if os.Getenv(agyFakeMCPCallEnv) == "1" {
		if err := f.callMCPServers(sessionID, promptText); err != nil {
			f.fail(id, -32603, err.Error())
			return
		}
	}
	f.promptMu.Lock()
	f.promptCount++
	promptNum := f.promptCount
	if promptNum == 1 {
		f.p1ID = id
	}
	f.promptMu.Unlock()

	if f.mode == "compact" {
		f.promptCompactMode(id, sessionID, promptText)
		return
	}

	if f.mode == "stop-hook" || f.mode == "stop-hook-error" {
		f.update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "Initial answer."}})
		if f.mode == "stop-hook-error" {
			f.callHook(map[string]any{
				"hookEventName":      "Stop",
				"conversationId":     sessionID,
				"executionNum":       0,
				"continuationActive": false,
				"terminationReason":  "ERROR",
				"error":              "upstream failure",
				"fullyIdle":          true,
			})
			f.result(id, map[string]any{"stopReason": "end_turn", "usage": map[string]any{"inputTokens": 5, "outputTokens": 3}})
			return
		}
		resp0 := f.callHook(map[string]any{
			"hookEventName":      "Stop",
			"conversationId":     sessionID,
			"executionNum":       0,
			"continuationActive": false,
			"terminationReason":  "NO_TOOL_CALL",
			"fullyIdle":          true,
		})
		if resp0.Decision == "continue" {
			f.update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "Continued:" + resp0.Reason}})
			// agy empirically sends continuationActive: false even on re-entry.
			resp1 := f.callHook(map[string]any{
				"hookEventName":      "Stop",
				"conversationId":     sessionID,
				"executionNum":       1,
				"continuationActive": false,
				"terminationReason":  "NO_TOOL_CALL",
				"fullyIdle":          true,
			})
			if resp1.Decision == "continue" {
				f.update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "UNEXPECTED_SECOND_CONTINUE"}})
			}
		}
		f.result(id, map[string]any{"stopReason": "end_turn", "usage": map[string]any{"inputTokens": 12, "outputTokens": 6}})
		return
	}

	if f.mode == "pretooluse-shell" {
		command := os.Getenv(agyFakeCommandEnv)
		if command == "" {
			command = "ls"
		}
		hookResp := f.callHook(map[string]any{
			"hookEventName":  "PreToolUse",
			"conversationId": sessionID,
			"toolCall": map[string]any{
				"id":   "tc-1",
				"name": "run_command",
				"args": map[string]any{"CommandLine": command},
			},
		})
		if hookResp.Decision != "allow" {
			f.update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "DENIED:" + hookResp.Reason}})
			f.result(id, map[string]any{"stopReason": "end_turn", "usage": map[string]any{"inputTokens": 5, "outputTokens": 4}})
			return
		}
		f.send(map[string]any{"jsonrpc": "2.0", "id": 901, "method": "session/request_permission", "params": map[string]any{
			"sessionId": sessionID,
			"toolCall":  map[string]any{"toolCallId": "tc-1", "name": "run_command", "title": command, "kind": "execute", "rawInput": map[string]any{"CommandLine": command}},
			"options": []any{
				map[string]any{"optionId": "deny", "name": "Deny", "kind": "reject_once"},
				map[string]any{"optionId": "allow", "name": "Allow", "kind": "allow_once"},
			},
		}})
		ans := <-f.answers
		selected := ""
		if outcome, ok := ans["outcome"].(map[string]any); ok {
			selected, _ = outcome["optionId"].(string)
		}
		f.update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "ALLOWED:" + selected}})
		f.result(id, map[string]any{"stopReason": "end_turn", "usage": map[string]any{"inputTokens": 5, "outputTokens": 4}})
		return
	}

	if f.mode == "model-invoke" || f.mode == "model-invoke-tool" || f.mode == "model-invoke-overflow" || f.mode == "model-invoke-hang" {
		if f.mode == "model-invoke-hang" {
			<-f.closed
			return
		}
		if f.mode == "model-invoke-overflow" {
			chunk := strings.Repeat("x", 64*1024)
			for range 20 {
				f.update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": chunk}})
			}
			f.result(id, map[string]any{"stopReason": "end_turn", "usage": map[string]any{"inputTokens": 10, "outputTokens": 100}})
			return
		}
		if f.mode == "model-invoke-tool" {
			f.update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "pre-tool scratch"}})
			hookResp := f.callHook(map[string]any{
				"hookEventName":  "PreToolUse",
				"conversationId": sessionID,
				"toolCall":       map[string]any{"id": "tc-m1", "name": "run_command", "args": map[string]any{"CommandLine": "cat /etc/passwd"}},
			})
			f.update(sessionID, map[string]any{"sessionUpdate": "tool_call", "toolCallId": "tc-m1", "name": "run_command", "kind": "execute", "status": "pending"})
			f.send(map[string]any{"jsonrpc": "2.0", "id": 902, "method": "session/request_permission", "params": map[string]any{
				"sessionId": sessionID,
				"toolCall":  map[string]any{"toolCallId": "tc-m1", "name": "run_command", "kind": "execute"},
				"options": []any{
					map[string]any{"optionId": "deny", "name": "Deny", "kind": "reject_once"},
					map[string]any{"optionId": "allow", "name": "Allow", "kind": "allow_once"},
				},
			}})
			ans := <-f.answers
			permSelected := ""
			if outcome, ok := ans["outcome"].(map[string]any); ok {
				permSelected, _ = outcome["optionId"].(string)
			}
			f.update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": fmt.Sprintf("hook=%s perm=%s", hookResp.Decision, permSelected)}})
			f.result(id, map[string]any{"stopReason": "end_turn", "usage": map[string]any{"inputTokens": 12, "outputTokens": 6, "cachedReadTokens": 4}})
			return
		}
		reply := "Antigravity answer: " + promptText
		if strings.Contains(promptText, "json") {
			reply = `{"ok":true}`
		}
		f.update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": reply}})
		f.result(id, map[string]any{"stopReason": "end_turn", "usage": map[string]any{"inputTokens": 20, "outputTokens": 8, "cachedReadTokens": 5, "cachedWriteTokens": 3}})
		return
	}

	if f.mode == "steer-hook" {
		f.update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "Before tool."}})
		f.update(sessionID, map[string]any{"sessionUpdate": "tool_call", "toolCallId": "call-1", "name": "run_command", "title": "ls", "kind": "execute", "status": "pending", "rawInput": map[string]any{"CommandLine": "ls"}})
		f.update(sessionID, map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "call-1", "status": "completed", "content": []any{
			map[string]any{"type": "content", "content": map[string]any{"type": "text", "text": "a.txt"}},
		}})
		var steered []string
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			resp := f.callHook(map[string]any{
				"hookEventName":  "PreInvocation",
				"conversationId": sessionID,
				"invocationNum":  1,
			})
			if len(resp.InjectSteps) > 0 {
				for _, step := range resp.InjectSteps {
					steered = append(steered, step.UserMessage)
				}
				break
			}
			select {
			case <-f.closed:
				return
			case <-time.After(10 * time.Millisecond):
			}
		}
		reply := "NO_STEER"
		if len(steered) > 0 {
			reply = "STEERED:" + strings.Join(steered, "|")
		}
		f.update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": reply}})
		f.result(id, map[string]any{"stopReason": "end_turn", "usage": map[string]any{"inputTokens": 5, "outputTokens": 3}})
		return
	}

	if f.mode == "waiting-background-v2" {
		if promptNum == 1 {
			f.update(sessionID, map[string]any{"sessionUpdate": "tool_call", "toolCallId": "call-sched-1", "name": "schedule", "title": "schedule", "kind": "other", "status": "pending", "rawInput": map[string]any{"DurationSeconds": 60}})
			f.update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "Scheduled."}})
			fullyIdle := false
			f.callHook(map[string]any{
				"hookEventName":  "Stop",
				"conversationId": sessionID,
				"fullyIdle":      fullyIdle,
			})
			select {
			case <-f.toolDone:
			case <-f.closed:
			}
			return
		}
		f.promptMu.Lock()
		p1ID := f.p1ID
		alreadySent := f.p1Done
		f.p1Done = true
		f.promptMu.Unlock()
		if !alreadySent && len(p1ID) > 0 {
			f.result(p1ID, map[string]any{"stopReason": "end_turn", "usage": map[string]any{"inputTokens": 10, "outputTokens": 2}})
			close(f.toolDone)
		}
		preResp := f.callHook(map[string]any{
			"hookEventName":  "PreInvocation",
			"conversationId": sessionID,
			"invocationNum":  1,
		})
		extra := ""
		if len(preResp.InjectSteps) > 0 {
			extra = " [unexpected-inject]"
		}
		f.update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "Woken:" + promptText + extra}})
		f.update(sessionID, map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "call-sched-1", "status": "completed", "content": []any{}})
		f.callHook(map[string]any{
			"hookEventName":  "Stop",
			"conversationId": sessionID,
			"fullyIdle":      true,
		})
		f.result(id, map[string]any{"stopReason": "end_turn", "usage": map[string]any{"inputTokens": 20, "outputTokens": 5}})
		return
	}

	if f.mode == "background-wake" {
		if promptNum == 1 {
			f.update(sessionID, map[string]any{"sessionUpdate": "tool_call", "toolCallId": "call-1", "name": "run_command", "title": "sleep 60", "kind": "execute", "status": "pending", "rawInput": map[string]any{"CommandLine": "sleep 60"}})
			f.update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "Running in the background."}})
			f.result(id, map[string]any{"stopReason": "end_turn"})
			return
		}
		f.update(sessionID, map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "call-1", "status": "completed", "content": []any{
			map[string]any{"type": "content", "content": map[string]any{"type": "text", "text": "done"}},
		}})
		f.update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "WokenLegacy:" + promptText}})
		f.result(id, map[string]any{"stopReason": "end_turn", "usage": map[string]any{"inputTokens": 8, "outputTokens": 3}})
		return
	}
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

func agyFakeCountLines(path string) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	count := 0
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) != "" {
			count++
		}
	}
	return count
}

func agyFakeAppendJSONL(path string, entry map[string]any) {
	if path == "" {
		return
	}
	encoded, err := json.Marshal(entry)
	if err != nil {
		return
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return
	}
	_, _ = file.Write(append(encoded, '\n'))
	_ = file.Close()
}

func (f *agyFakeProcess) promptCompactMode(id json.RawMessage, sessionID, promptText string) {
	transcript := os.Getenv(agyFakeTranscriptEnv)
	compactMode := os.Getenv(agyFakeCompactModeEnv)

	if !strings.HasPrefix(promptText, "/compact") {
		initialSteps := agyFakeCountLines(transcript)
		if transcript != "" {
			agyFakeAppendJSONL(transcript, map[string]any{"step_index": initialSteps, "type": "USER_INPUT"})
			if compactMode != "no-hook-on-normal" && compactMode != "no-hook-on-normal-empty" && compactMode != "no-transcript" {
				f.callHook(map[string]any{
					"hookEventName":   "PreInvocation",
					"conversationId":  sessionID,
					"invocationNum":   0,
					"transcriptPath":  transcript,
					"initialNumSteps": initialSteps,
				})
				f.callHook(map[string]any{
					"hookEventName":  "Stop",
					"conversationId": sessionID,
					"fullyIdle":      true,
					"transcriptPath": transcript,
				})
			}
		}
		f.update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "ok"}})
		f.result(id, map[string]any{"stopReason": "end_turn", "usage": map[string]any{"inputTokens": 10, "outputTokens": 4}})
		return
	}

	if gate := os.Getenv(agyFakeCompactGateEnv); gate != "" {
		_ = os.WriteFile(gate+".started", []byte(strconv.Itoa(os.Getpid())), 0o600)
		for {
			if _, err := os.Stat(gate); err == nil {
				break
			}
			select {
			case <-f.closed:
				return
			case <-time.After(10 * time.Millisecond):
			}
		}
	}

	compactTranscript := os.Getenv(agyFakeCompactTranscriptEnv)
	if compactTranscript == "" {
		compactTranscript = transcript
	}
	initialSteps := agyFakeCountLines(compactTranscript)
	omitInitialSteps := false
	if rawSteps := os.Getenv(agyFakeCompactInitialStepsEnv); rawSteps == "omit" {
		omitInitialSteps = true
	} else if rawSteps != "" {
		if parsed, err := strconv.Atoi(rawSteps); err == nil {
			initialSteps = parsed
		}
	}
	if compactTranscript != "" && compactMode != "no-transcript" {
		payload := map[string]any{
			"hookEventName":  "PreInvocation",
			"conversationId": sessionID,
			"invocationNum":  0,
			"transcriptPath": compactTranscript,
		}
		if !omitInitialSteps {
			payload["initialNumSteps"] = initialSteps
		}
		f.callHook(payload)
	}
	if compactMode == "hang" {
		<-f.closed
		return
	}

	// Emit pre-compaction usage first, followed by a smaller post-compaction
	// update so tests verify the first positive observation is preserved.
	f.update(sessionID, map[string]any{"sessionUpdate": "usage_update", "used": 12345, "size": 200000})
	f.update(sessionID, map[string]any{"sessionUpdate": "usage_update", "used": 2222, "size": 200000})

	if compactMode == "permission" || compactMode == "permission-no-reject" {
		options := []any{map[string]any{"optionId": "allow", "name": "Allow", "kind": "allow_once"}}
		if compactMode == "permission" {
			options = append([]any{map[string]any{"optionId": "deny", "name": "Deny", "kind": "reject_once"}}, options...)
		}
		f.send(map[string]any{
			"jsonrpc": "2.0",
			"id":      901,
			"method":  "session/request_permission",
			"params": map[string]any{
				"sessionId": sessionID,
				"toolCall":  map[string]any{"toolCallId": "compact-call-1", "title": "rm -rf /", "kind": "execute", "rawInput": map[string]any{"CommandLine": "rm -rf /"}},
				"options":   options,
			},
		})
		select {
		case answer := <-f.answers:
			if outPath := os.Getenv(agyFakeCompactPermOutEnv); outPath != "" {
				encoded, _ := json.Marshal(answer)
				_ = os.WriteFile(outPath, encoded, 0o600)
			}
		case <-f.closed:
			return
		}
	}

	if compactMode == "open-tool" {
		f.update(sessionID, map[string]any{
			"sessionUpdate": "tool_call",
			"toolCallId":    "compact-open-1",
			"name":          "run_command",
			"title":         "sleep 60",
			"kind":          "execute",
			"status":        "pending",
			"rawInput":      map[string]any{"CommandLine": "sleep 60"},
		})
	}

	switch compactMode {
	case "empty", "no-hook-on-normal-empty", "no-transcript":
	default:
		agyFakeAppendJSONL(compactTranscript, map[string]any{"step_index": initialSteps, "type": "CHECKPOINT"})
	}

	if compactTranscript != "" && compactMode != "no-transcript" {
		f.callHook(map[string]any{
			"hookEventName":  "Stop",
			"conversationId": sessionID,
			"fullyIdle":      true,
			"transcriptPath": compactTranscript,
		})
	}
	f.result(id, map[string]any{"stopReason": "end_turn"})
}
