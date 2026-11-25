package native

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// The test binary doubles as a fake Pi when piFakeEnv is set. It is
// dispatched from init so the shared TestMain stays untouched.
const (
	piFakeEnv       = "NATIVE_PI_FAKE"
	piFakeRecordEnv = "PI_FAKE_RECORD"
	piFakeArgvEnv   = "PI_FAKE_ARGV"
	piFakeChildEnv  = "PI_FAKE_CHILD_PID"
	piFakeLogEnv    = "PI_FAKE_COMMANDS"
	// piFakeDialogEnv names the file the review mode appends each
	// extension UI response to.
	piFakeDialogEnv = "PI_FAKE_DIALOGS"
)

func init() {
	switch mode := os.Getenv(piFakeEnv); mode {
	case "":
	case "sleep":
		time.Sleep(time.Minute)
		os.Exit(0)
	case "catalog":
		os.Exit(piFakeCatalog())
	case "invoke-clamp":
		os.Exit(piFakeInvokeClamp(os.Args[1:]))
	case "resident":
		os.Exit(piResidentFake(os.Args[1:]))
	default:
		os.Exit(piFake(mode, os.Args[1:]))
	}
}

type piFakeProcess struct {
	mode       string
	sessionDir string
	sessionID  string
	thinking   string
	out        sync.Mutex
	cleared    bool
}

func (f *piFakeProcess) send(value any) {
	encoded, _ := json.Marshal(value)
	f.out.Lock()
	defer f.out.Unlock()
	_, _ = os.Stdout.Write(append(encoded, '\n'))
}

func (f *piFakeProcess) reply(id, command string, data any) {
	f.send(map[string]any{"type": "response", "id": id, "command": command, "success": true, "data": data})
}

func (f *piFakeProcess) assistantEnd(text, stopReason, errorMessage string) {
	f.send(map[string]any{"type": "message_end", "message": map[string]any{
		"role": "assistant", "model": "fixture/model", "stopReason": stopReason, "errorMessage": errorMessage,
		"content": []any{map[string]any{"type": "text", "text": text}},
		"usage":   map[string]any{"input": 2, "output": 3, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 5},
	}})
}

func (f *piFakeProcess) finish() {
	cwd, _ := os.Getwd()
	header, _ := json.Marshal(map[string]any{"type": "session", "id": f.sessionID, "cwd": cwd})
	_ = os.WriteFile(filepath.Join(f.sessionDir, "fixture_"+f.sessionID+".jsonl"), append(header, '\n'), 0o600)
	f.send(map[string]any{"type": "message_start", "message": map[string]any{"role": "assistant"}})
	f.send(map[string]any{"type": "message_update", "assistantMessageEvent": map[string]any{"type": "text_delta", "delta": "done"}})
	f.assistantEnd("done", "stop", "")
	f.send(map[string]any{"type": "agent_end"})
	f.send(map[string]any{"type": "agent_settled", "aborted": false})
}

func (f *piFakeProcess) tool(id, name string, isError bool) {
	f.send(map[string]any{"type": "tool_execution_start", "toolName": name, "toolCallId": id, "args": map[string]any{"command": "ls"}})
	f.send(map[string]any{"type": "tool_execution_end", "toolName": name, "toolCallId": id, "result": "output of " + id, "isError": isError})
}

func piFake(mode string, args []string) int {
	f := &piFakeProcess{mode: mode, thinking: "medium"}
	for i := 0; i+1 < len(args); i++ {
		switch args[i] {
		case "--session-dir":
			f.sessionDir = args[i+1]
		case "--session-id":
			f.sessionID = args[i+1]
		case "--thinking":
			f.thinking = args[i+1]
		}
	}
	if f.sessionDir == "" || f.sessionID == "" {
		return 21
	}
	if path := os.Getenv(piFakeArgvEnv); path != "" {
		_ = os.WriteFile(path, []byte(strings.Join(args, "\n")), 0o600)
		_ = os.WriteFile(path+".node_path", []byte(os.Getenv(piNodePathKey)), 0o600)
		_ = os.WriteFile(path+".shell_text_hook", []byte(os.Getenv(piShellTextHookEnvKey)), 0o600)
		_ = os.WriteFile(path+".context_window", []byte(os.Getenv(piContextWindowEnvKey)), 0o600)
	}
	reader := bufio.NewReader(os.Stdin)
	for {
		line, err := reader.ReadBytes('\n')
		if err == io.EOF {
			return 0
		}
		if err != nil {
			return 23
		}
		var command struct {
			ID      string `json:"id"`
			Type    string `json:"type"`
			Message string `json:"message"`
			Level   string `json:"level"`
		}
		if json.Unmarshal(line, &command) != nil {
			return 22
		}
		if command.Type == "extension_ui_response" {
			if code := f.dialogAnswered(line); code >= 0 {
				return code
			}
			continue
		}
		if path := os.Getenv(piFakeLogEnv); path != "" {
			if log, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600); err == nil {
				entry := command.Type
				if command.Level != "" {
					entry += ":" + command.Level
				}
				_, _ = log.WriteString(entry + "\n")
				_ = log.Close()
			}
		}
		if code := f.handle(command.ID, command.Type, command.Message, command.Level); code >= 0 {
			return code
		}
	}
}

// handle returns an exit code, or -1 to keep reading.
func (f *piFakeProcess) handle(id, kind, message, level string) int {
	switch kind {
	case "get_state":
		if f.mode == "clamp-state" {
			f.reply(id, kind, map[string]any{
				"sessionId": f.sessionID,
				"model": map[string]any{
					"provider":  "localmodels",
					"id":        "Spark-X2.6-4B-Q8_0",
					"reasoning": true,
					// Realistic bifrost_models.py map: "off" is omitted, producing ["none", "low", "high"].
					"thinkingLevelMap": map[string]any{
						"minimal": nil,
						"low":     "low",
						"medium":  nil,
						"high":    "high",
					},
				},
				"thinkingLevel": f.thinking,
			})
			return -1
		}
		f.reply(id, kind, map[string]any{"sessionId": f.sessionID})
		switch f.mode {
		case "pressure":
			noise := map[string]any{"type": "noise", "pad": strings.Repeat("x", 38)}
			for range 8000 {
				f.send(noise)
			}
		case "blocked":
			time.Sleep(time.Minute)
			return 0
		}
	case "set_thinking_level":
		f.thinking = level
		f.reply(id, kind, nil)
	case "prompt":
		if path := os.Getenv(piFakeRecordEnv); path != "" {
			_ = os.WriteFile(path, []byte(message), 0o600)
		}
		if f.mode == "handled" {
			f.reply(id, kind, map[string]any{"disposition": "handled"})
			return -1
		}
		f.reply(id, kind, map[string]any{"disposition": "started"})
		if f.mode == "exit-early" {
			return 0
		}
		f.send(map[string]any{"type": "agent_start"})
		return f.act()
	case "steer":
		if f.mode == "steer-race" {
			f.send(map[string]any{"type": "agent_end"})
		}
		f.reply(id, kind, map[string]any{"disposition": "queued"})
		if f.mode == "steer" {
			// Pi shows a steered message as a user message before the next reply.
			user := map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": message}}}
			f.send(map[string]any{"type": "message_start", "message": user})
			f.send(map[string]any{"type": "message_end", "message": user})
		}
		f.finish()
	case "clear_queue":
		f.cleared = true
		f.reply(id, kind, nil)
	case "abort":
		if !f.cleared {
			return 24
		}
		if f.mode == "complete-on-abort" {
			f.finish()
			f.reply(id, kind, nil)
			return -1
		}
		f.send(map[string]any{"type": "agent_settled", "aborted": true})
		f.reply(id, kind, nil)
	default:
		return 25
	}
	return -1
}

func (f *piFakeProcess) act() int {
	switch f.mode {
	case "steer", "steer-race", "steer-unconsumed", "complete-on-abort":
	case "retry":
		f.assistantEnd("", "error", "retryable")
		f.send(map[string]any{"type": "agent_end"})
		f.send(map[string]any{"type": "auto_retry_start"})
		f.send(map[string]any{"type": "agent_start"})
		f.send(map[string]any{"type": "auto_retry_end", "success": true})
		f.finish()
	case "cancel":
		program, _ := os.Executable()
		child := exec.Command(program)
		child.Env = []string{piFakeEnv + "=sleep"}
		if err := child.Start(); err != nil {
			return 26
		}
		_ = os.WriteFile(os.Getenv(piFakeChildEnv), []byte(fmt.Sprintf("%d\n", child.Process.Pid)), 0o600)
	case "tool-failure":
		f.tool("call_bash", "bash", true)
		f.finish()
	case "requests":
		f.send(map[string]any{"type": "message_start", "message": map[string]any{"role": "assistant"}})
		f.send(map[string]any{"type": "message_update", "assistantMessageEvent": map[string]any{"type": "thinking_delta", "delta": "plan"}})
		f.send(map[string]any{"type": "message_end", "message": map[string]any{
			"role": "assistant", "model": "fixture/model", "stopReason": "toolUse",
			"content": []any{map[string]any{"type": "toolCall", "id": "call_ls", "name": "bash"}},
			"usage":   map[string]any{"input": 4, "output": 1, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 5},
		}})
		f.tool("call_ls", "bash", false)
		f.finish()
	case "review":
		// Another extension's dialog first: the Daemon cancels it.
		f.send(map[string]any{"type": "extension_ui_request", "id": "ui-other", "method": "confirm", "title": "Clear session?", "message": "x"})
		f.send(map[string]any{"type": "extension_ui_request", "id": "ui-notify", "method": "notify", "message": "x"})
		call, _ := json.Marshal(map[string]any{"toolName": "bash", "input": map[string]any{"command": "git push"}})
		f.send(map[string]any{"type": "extension_ui_request", "id": "ui-review", "method": "input", "title": piReviewDialog, "placeholder": string(call)})
	case "composite":
		f.tool("call_shared|fc_first", "read", false)
		f.tool("call_shared|fc_second", "read", false)
		f.finish()
	case "clamp-state":
		if f.thinking != "off" && f.thinking != "low" && f.thinking != "high" {
			f.assistantEnd("", "error", "Unexpected reasoning effort "+f.thinking)
			f.send(map[string]any{"type": "agent_end"})
			f.send(map[string]any{"type": "agent_settled", "aborted": false})
			return -1
		}
		cwd, _ := os.Getwd()
		header, _ := json.Marshal(map[string]any{"type": "session", "id": f.sessionID, "cwd": cwd})
		_ = os.WriteFile(filepath.Join(f.sessionDir, "fixture_"+f.sessionID+".jsonl"), append(header, '\n'), 0o600)
		f.send(map[string]any{"type": "message_start", "message": map[string]any{"role": "assistant"}})
		f.assistantEnd("effort:"+f.thinking, "stop", "")
		f.send(map[string]any{"type": "agent_end"})
		f.send(map[string]any{"type": "agent_settled", "aborted": false})
	default:
		f.finish()
	}
	return -1
}

// dialogAnswered records one extension UI response and finishes the turn
// once the review is answered. It returns an exit code, or -1.
func (f *piFakeProcess) dialogAnswered(line []byte) int {
	if path := os.Getenv(piFakeDialogEnv); path != "" {
		if log, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600); err == nil {
			_, _ = log.Write(line)
			_ = log.Close()
		}
	}
	var answer struct{ ID string }
	if json.Unmarshal(line, &answer) != nil {
		return 22
	}
	if answer.ID == "ui-review" {
		f.finish()
	}
	return -1
}

// piFakeCatalog answers each catalog request with an unrelated rejected
// reply first, then the real one.
func piFakeCatalog() int {
	reader := bufio.NewScanner(os.Stdin)
	for reader.Scan() {
		var request struct{ ID, Type string }
		if json.Unmarshal(reader.Bytes(), &request) != nil {
			return 22
		}
		fmt.Printf(`{"type":"response","id":"unrelated-%s","command":%q,"success":false,"error":"no"}`+"\n", request.ID, request.Type)
		fmt.Println(`{"type":"noise"}`)
		switch request.ID {
		case "linger-state":
			fmt.Println(`{"type":"response","id":"linger-state","command":"get_state","success":true,"data":{"model":{"provider":"fixture","id":"reasoner"},"thinkingLevel":"high"}}`)
		case "linger-models":
			fmt.Println(`{"type":"response","id":"linger-models","command":"get_available_models","success":true,"data":{"models":[` +
				`{"provider":"fixture","id":"reasoner","reasoning":true,"thinkingLevelMap":{"minimal":null,"max":"maximum"}},` +
				`{"provider":" fixture ","id":"fast","reasoning":false},` +
				`{"provider":"fixture","id":"reasoner","reasoning":false},` +
				`{"provider":"","id":"orphan","reasoning":true}]}}`)
		default:
			return 25
		}
	}
	return 0
}

// piFakeInvokeClamp emulates one-shot InvokePiModel RPC mode with a model
// whose thinkingLevelMap restricts reasoning to ["low", "high"].
func piFakeInvokeClamp(args []string) int {
	if path := os.Getenv(piFakeArgvEnv); path != "" {
		_ = os.WriteFile(path, []byte(strings.Join(args, "\n")), 0o600)
	}
	thinking := "medium"
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--thinking" {
			thinking = args[i+1]
		}
	}
	send := func(value any) {
		encoded, _ := json.Marshal(value)
		_, _ = os.Stdout.Write(append(encoded, '\n'))
	}
	reader := bufio.NewReader(os.Stdin)
	for {
		line, err := reader.ReadBytes('\n')
		if err == io.EOF {
			return 0
		}
		if err != nil {
			return 23
		}
		var command struct {
			ID    string `json:"id"`
			Type  string `json:"type"`
			Level string `json:"level"`
		}
		if json.Unmarshal(line, &command) != nil {
			return 22
		}
		if path := os.Getenv(piFakeLogEnv); path != "" {
			if log, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600); err == nil {
				entry := command.Type
				if command.Level != "" {
					entry += ":" + command.Level
				}
				_, _ = log.WriteString(entry + "\n")
				_ = log.Close()
			}
		}
		switch command.Type {
		case "get_state":
			send(map[string]any{
				"type": "response", "id": command.ID, "command": "get_state", "success": true,
				"data": map[string]any{
					"model": map[string]any{
						"provider":  "localmodels",
						"id":        "Spark-X2.6-4B-Q8_0",
						"reasoning": true,
						"thinkingLevelMap": map[string]any{
							"minimal": nil,
							"low":     "low",
							"medium":  nil,
							"high":    "high",
						},
					},
					"thinkingLevel": thinking,
				},
			})
		case "set_thinking_level":
			thinking = command.Level
			send(map[string]any{"type": "response", "id": command.ID, "command": "set_thinking_level", "success": true})
		case "prompt":
			if thinking != "off" && thinking != "low" && thinking != "high" {
				send(map[string]any{"type": "response", "id": command.ID, "command": "prompt", "success": true, "data": map[string]any{"disposition": "started"}})
				send(map[string]any{"type": "agent_start"})
				send(map[string]any{"type": "message_end", "message": map[string]any{
					"role": "assistant", "model": "localmodels/Spark-X2.6-4B-Q8_0",
					"stopReason": "error", "errorMessage": "Unexpected reasoning effort " + thinking,
					"content": []any{},
				}})
				send(map[string]any{"type": "agent_end"})
				send(map[string]any{"type": "agent_settled", "aborted": false})
				continue
			}
			send(map[string]any{"type": "response", "id": command.ID, "command": "prompt", "success": true, "data": map[string]any{"disposition": "started"}})
			send(map[string]any{"type": "agent_start"})
			send(map[string]any{"type": "message_start", "message": map[string]any{"role": "assistant"}})
			send(map[string]any{"type": "message_end", "message": map[string]any{
				"role": "assistant", "model": "localmodels/Spark-X2.6-4B-Q8_0", "stopReason": "stop",
				"content": []any{map[string]any{"type": "text", "text": `{"ok":true,"effort":"` + thinking + `"}`}},
				"usage":   map[string]any{"input": 5, "output": 4, "cacheRead": 0, "cacheWrite": 0},
			}})
			send(map[string]any{"type": "agent_end"})
			send(map[string]any{"type": "agent_settled", "aborted": false})
		default:
			return 25
		}
	}
}
