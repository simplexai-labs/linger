package transport

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

func TestGatewayRejectsUnknownCommandsAndInvalidOperationAuthority(t *testing.T) {
	for _, frame := range []string{
		`{"type":"unknown.command","protocol_version":"2"}`,
		`{"type":"operation.start","protocol_version":"2","host_access":"trusted","registration_id":"registration","assignment_revision":1}`,
		`{"type":"operation.start","protocol_version":"2","registration_id":"registration","assignment_revision":1}`,
		`{"type":"operation.start","protocol_version":"2","host_access":"trusted","assignment_revision":1}`,
		`{"type":"operation.start","protocol_version":"2","host_access":"trusted","registration_id":"registration"}`,
	} {
		t.Run(frame, func(t *testing.T) {
			closed := make(chan error, 1)
			upgrader := websocket.Upgrader{}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				peer, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					t.Error(err)
					return
				}
				defer peer.Close()
				if err := peer.WriteMessage(websocket.TextMessage, []byte(frame)); err != nil {
					t.Error(err)
					return
				}
				_ = peer.SetReadDeadline(time.Now().Add(5 * time.Second))
				_, _, err = peer.ReadMessage()
				closed <- err
			}))
			defer server.Close()
			stream, err := (GatewayControlPlane{URL: "ws" + strings.TrimPrefix(server.URL, "http"), BearerToken: "test-token"}).Connect(t.Context(), Hello{})
			if err != nil {
				t.Fatal(err)
			}
			defer stream.Close()
			if _, err := stream.Receive(t.Context()); err == nil {
				t.Fatal("invalid command was accepted")
			}
			var closeError *websocket.CloseError
			if err := <-closed; !errors.As(err, &closeError) || closeError.Code != websocket.CloseProtocolError {
				t.Fatalf("close=%v, want 1002", err)
			}
			// Closing the transport also releases any caller waiting for another frame.
			done := make(chan error, 1)
			go func() { _, err := stream.Receive(context.Background()); done <- err }()
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("closed receive succeeded")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("receive remained pending after protocol close")
			}
		})
	}
}

// TypeScript feeds every Agent frame through this production decoder, and
// validates every frame emitted by the production Go serializer below.
func TestRunnerWireContractFixtures(t *testing.T) {
	if source := os.Getenv("LINGER_RUNNER_WIRE_AGENT_FIXTURE"); source != "" {
		encoded, err := os.ReadFile(source)
		if err != nil {
			t.Fatal(err)
		}
		var frames []json.RawMessage
		if err := json.Unmarshal(encoded, &frames); err != nil {
			t.Fatal(err)
		}
		seen := map[string]bool{}
		for _, frame := range frames {
			command, err := decodeGatewayCommand(frame)
			if err != nil {
				t.Fatalf("decode Agent fixture: %v", err)
			}
			if command.Type == "" {
				t.Fatal("decoded an empty command")
			}
			seen[command.Type] = true
			var wire map[string]json.RawMessage
			if err := json.Unmarshal(frame, &wire); err != nil {
				t.Fatal(err)
			}
			var wireCommand protocol.Command
			if err := json.Unmarshal(frame, &wireCommand); err != nil {
				t.Fatal(err)
			}
			if command.ProtocolVersion != wireCommand.ProtocolVersion || command.CommandID != wireCommand.CommandID ||
				command.RegistrationID != wireCommand.RegistrationID || command.AssignmentRevision != wireCommand.AssignmentRevision ||
				command.AgentID != wireCommand.AgentID || command.OperationID != wireCommand.OperationID ||
				command.ConnectionEpoch != wireCommand.ConnectionEpoch || command.HostAccess != wireCommand.HostAccess {
				t.Fatalf("decoded command lost identity: %s", command.Type)
			}
			if command.Type == protocol.CommandOperationStart && len(command.Payload) == 0 {
				t.Fatal("Operation request was dropped")
			}
			if command.Type == protocol.CommandOperationInput && len(command.Input) == 0 {
				t.Fatal("Operation input was dropped")
			}
			if command.Type == protocol.CommandAgentCLICredentialPut && len(command.Payload) == 0 {
				t.Fatal("CLI credential was dropped")
			}
		}
		for _, kind := range []string{protocol.CommandRunnerWelcome, protocol.CommandRunnerReconciled, protocol.CommandRegistrationSnapshot,
			protocol.CommandAgentRunnerEnsure, protocol.CommandAgentRunnerRemove, protocol.CommandAgentCLICredentialPut,
			protocol.CommandDebugInspect, protocol.CommandCapabilitySkillsScan, protocol.CommandCapabilityBrowserConnect,
			protocol.CommandCapabilityComputerPermission, protocol.CommandCapabilityLocalModels, protocol.CommandCapabilityModelSource, protocol.CommandOperationPrepare, protocol.CommandOperationStart, protocol.CommandOperationInput,
			protocol.CommandOperationCancel, protocol.CommandOperationAck, protocol.CommandProviderPrepare,
			protocol.CommandSessionCompact, protocol.CommandModelInvoke, protocol.CommandModelInvokeCancel,
			protocol.CommandComputerToolCall} {
			if !seen[kind] {
				t.Errorf("Agent fixture missing %s", kind)
			}
		}
	}
	events := runnerWireDaemonEvents(t)
	frames := make(chan []json.RawMessage, 1)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer peer.Close()
		_ = peer.SetReadDeadline(time.Now().Add(10 * time.Second))
		var result []json.RawMessage
		for range events {
			_, frame, err := peer.ReadMessage()
			if err != nil {
				t.Error(err)
				return
			}
			result = append(result, json.RawMessage(frame))
		}
		frames <- result
	}))
	defer server.Close()
	device, err := GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	hello := Hello{Capabilities: []string{"browser_connection", "computer_permissions"}, RuntimeDiagnostics: runnerWireRuntimeDiagnostics(), ProtocolVersion: "2", RunnerID: "computer-1", ConnectionNonce: "nonce-1", Identity: device, Signature: make([]byte, 64), SentAt: time.Date(2026, 10, 28, 0, 0, 0, 0, time.UTC)}
	stream, err := (GatewayControlPlane{URL: "ws" + strings.TrimPrefix(server.URL, "http"), BearerToken: "test-token"}).Connect(t.Context(), hello)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	for _, event := range events {
		if err := stream.Send(t.Context(), event); err != nil {
			t.Fatalf("send %s: %v", event.Type, err)
		}
	}
	var result []json.RawMessage
	select {
	case result = <-frames:
	case <-time.After(10 * time.Second):
		t.Fatal("wire fixtures were not received")
	}
	if target := os.Getenv("LINGER_RUNNER_WIRE_DAEMON_FIXTURE"); target != "" {
		encoded, err := json.Marshal(result)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, encoded, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func runnerWireDaemonEvents(t *testing.T) []protocol.Event {
	t.Helper()
	raw := func(value any) json.RawMessage {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return encoded
	}
	failure := map[string]any{"code": "FIXTURE_FAILED", "message": "Fixture failure", "retryable": false}
	contextView := raw(map[string]any{"view_digest": strings.Repeat("a", 64)})
	base := protocol.Event{ProtocolVersion: "2", HostAccess: "trusted", CommandID: "command-1", TenantID: "tenant-1", RunnerID: "computer-1", AgentID: "agent-1", RegistrationID: "registration-1", AssignmentRevision: 1, OperationID: "operation-1", ConnectionEpoch: 1, RunnerRevision: 1, Generation: 1, ExecutionLeaseID: "lease-1", WorkspaceGrantID: "grant-1", RuntimeType: "codex", ExecutionContextKey: "context-1", RuntimeInstanceID: "runtime-1", ContextViewRef: contextView, Sequence: 1, Revision: 1, SentAt: time.Date(2026, 10, 28, 0, 0, 0, 0, time.UTC)}
	var events []protocol.Event
	appendEvent := func(kind string, payload any) {
		event := base
		event.Type = kind
		event.Payload = raw(payload)
		events = append(events, event)
	}
	appendEvent(protocol.EventComputerToolResult, map[string]any{"type": "executed", "kind": "computer_tool", "protocol_version": "2", "command_id": "live-tools-1", "runner_id": "computer-1", "connection_epoch": 1, "tenant_id": "tenant-1", "owner_actor_id": "owner-1", "agent_id": "agent-1", "result": map[string]any{"files": []string{"report.md"}}})
	appendEvent(protocol.EventDaemonHello, nil)
	appendEvent(protocol.EventRuntimeObserved, map[string]any{"count": 0})
	appendEvent(protocol.EventRuntimeDiagnostics, runnerWireRuntimeDiagnostics())
	appendEvent(protocol.EventRunnerHeartbeat, map[string]any{"active_operation_ids": []string{}})
	credential := map[string]any{"sha256": strings.Repeat("a", 64), "assignment_revision": 1, "profile": map[string]any{"url": "https://teamhub.example", "tenant_id": "tenant-1", "agent_id": "agent-1"}}
	appendEvent(protocol.EventAgentRunnerReady, map[string]any{"cli_credential": credential})
	appendEvent(protocol.EventAgentRunnerRemoved, nil)
	appendEvent(protocol.EventAgentRunnerFailed, nil)
	appendEvent(protocol.EventAgentCLICredentialStored, map[string]any{"sha256": strings.Repeat("a", 64)})
	appendEvent(protocol.EventAgentCLICredentialFailed, map[string]any{"error": failure})
	debug := base
	debug.Type = protocol.EventDebugInspected
	debug.ViewDigest = strings.Repeat("a", 64)
	debug.Payload = raw(map[string]any{"status": "unavailable", "provider_kind": "codex", "reason": "Fixture history", "instructions": map[string]any{"status": "unavailable", "source": "codex_rollout", "blocks": []any{}}, "records": []any{}})
	events = append(events, debug)
	coldDetachedDebug := base
	coldDetachedDebug.Type = protocol.EventDebugInspected
	coldDetachedDebug.RegistrationID = ""
	coldDetachedDebug.AssignmentRevision = 0
	coldDetachedDebug.RunnerRevision = 0
	coldDetachedDebug.ViewDigest = ""
	coldDetachedDebug.Payload = raw(map[string]any{
		"status": "available", "provider_kind": "antigravity", "source": "antigravity_transcript",
		"snapshot":     map[string]any{"id": "snap-1", "thread_id": "conv-1", "captured_at": "2026-10-28T00:00:00Z", "record_count": 1, "tail_state": "clean"},
		"instructions": map[string]any{"status": "unavailable", "source": "antigravity_transcript", "reason": "none", "blocks": []any{}},
		"records":      []any{map[string]any{"ordinal": 0, "turn_id": "step-0", "category": "message", "native_type": "USER_INPUT", "role": "user", "native_record": map[string]any{"type": "USER_INPUT", "content": "hi"}, "redacted_fields": []any{}}},
	})
	events = append(events, coldDetachedDebug)
	capability := func(route, kind, outcome string, extra map[string]any) {
		payload := map[string]any{"type": "executed", "kind": kind, "outcome": outcome, "protocol_version": "2", "command_id": "command-1", "runner_id": "computer-1", "tenant_id": "tenant-1", "owner_actor_id": "actor-1", "connection_epoch": 1, "expires_at": "2026-11-01T00:00:00Z"}
		for key, value := range extra {
			payload[key] = value
		}
		appendEvent(route, payload)
	}
	capability(protocol.EventCapabilitySkillsScanned, "skills_scan", "succeeded", map[string]any{"scan_id": "scan-1", "runtime_type": "codex", "items": []any{}})
	capability(protocol.EventCapabilitySkillsFailed, "skills_scan", "failed", map[string]any{"scan_id": "scan-1", "stage": "scan", "error": failure})
	capability(protocol.EventCapabilityBrowserConnected, "browser_connect", "succeeded", map[string]any{"action": "status", "status": map[string]any{"mode": "isolated", "state": "isolated", "platform": "darwin"}})
	capability(protocol.EventCapabilityBrowserFailed, "browser_connect", "failed", map[string]any{"action": "status", "error": failure})
	permissionStatus := map[string]any{"platform": "darwin", "host": "desktop", "subjects": []any{map[string]any{"subject": "linger", "permissions": []any{
		map[string]any{"id": "screen_recording", "state": "not_determined", "prompt": "available", "relaunch_required": false},
		map[string]any{"id": "accessibility", "state": "granted", "prompt": "available", "relaunch_required": false},
	}}}}
	capability(protocol.EventCapabilityComputerPermissionSucceeded, "computer_permission", "succeeded", map[string]any{"action": "prompt", "status": permissionStatus})
	capability(protocol.EventCapabilityComputerPermissionFailed, "computer_permission", "failed", map[string]any{"action": "relaunch", "error": failure})
	capability(protocol.EventCapabilityLocalModelsAccepted, "local_models", "accepted", map[string]any{"action": "download", "model_id": "qwen3-4b:Q4_K_M"})
	capability(protocol.EventCapabilityLocalModelsRefused, "local_models", "refused", map[string]any{"action": "refresh", "refusal": map[string]any{"code": "TOOL_NOT_INSTALLED"}})
	capability(protocol.EventCapabilityModelSourceSucceeded, "model_source", "succeeded", map[string]any{"action": "test", "test_result": map[string]any{"ok": true, "protocol": "anthropic", "url": "https://api.example.com/v1/messages", "model_id": "vendor/model", "context_window": 200000}})
	capability(protocol.EventCapabilityModelSourceFailed, "model_source", "failed", map[string]any{"action": "apply", "error": failure})
	appendEvent(protocol.EventLocalModels, map[string]any{"type": "runner.local_models", "protocol_version": "2", "runner_id": "computer-1", "sent_at": "2026-10-28T00:00:00Z", "revision": 1, "local_models": map[string]any{"available": false, "reason": map[string]any{"code": "TOOL_NOT_INSTALLED"}, "observed_at": "2026-10-28T00:00:00Z", "pools": []any{}, "models": []any{}}})
	appendEvent(protocol.EventOperationPrepared, map[string]any{"prepare_command_id": "prepare-1", "prepared": true, "outcome": "ready", "duration_ms": 1})
	appendEvent(protocol.EventOperationAccepted, map[string]any{"runner_pid": 123})
	appendEvent(protocol.EventOperationEvent, map[string]any{"type": "status.changed", "status": "working"})
	appendEvent(protocol.EventOperationInputAck, map[string]any{"turn_id": "turn-1"})
	appendEvent(protocol.EventOperationInputRejected, map[string]any{"expected_turn_id": "turn-1", "effect": "definitely_not_applied", "reason": "rejected", "message": "Fixture rejection"})
	appendEvent(protocol.EventOperationInputClosed, map[string]any{"expected_turn_id": "turn-1", "effect": "definitely_not_applied"})
	appendEvent(protocol.EventOperationCompleted, map[string]any{"type": "run", "final_response": "done", "session": map[string]any{"threadId": "thread-1"}})
	appendEvent(protocol.EventOperationFailed, failure)
	appendEvent(protocol.EventOperationCancelled, map[string]any{"reason": "Fixture cancellation"})
	appendEvent(protocol.EventProviderPrepared, map[string]any{"type": "prepared", "target": "provider", "command_id": "command-1", "runner_id": "computer-1", "prepare_id": "prepare-1", "execution_context_key": "context-1", "outcome": "ready", "duration_ms": 1})
	appendEvent(protocol.EventSessionCompacted, map[string]any{"type": "executed", "kind": "session_compact", "command_id": "command-1", "runner_id": "computer-1", "compact_id": "compact-1", "execution_context_key": "context-1", "outcome": "compacted", "pre_tokens": 1200, "duration_ms": 1})
	appendEvent(protocol.EventModelInvoked, map[string]any{"type": "executed", "kind": "model_invoke", "command_id": "command-1", "runner_id": "computer-1", "invoke_id": "invoke-1", "outcome": "completed", "text": `{"answer":"ok"}`, "workspace_files": []map[string]any{{"path": "pages/a.json", "content_base64": "e30="}}, "model": "fixture-model", "runtime_version": "0.166.0", "usage": map[string]any{"input_tokens": 10, "cached_input_tokens": 0, "output_tokens": 2}, "duration_ms": 1})
	return events
}

func runnerWireRuntimeDiagnostics() json.RawMessage {
	return json.RawMessage(`[{"type":"codex","status":"ready","protocol":"app-server","checked_at":"2026-10-28T00:00:00Z","version":"codex-cli 1.0.0","models":[]},{"type":"claude","status":"ready","protocol":"stream-json","checked_at":"2026-10-28T00:00:00Z","version":"2.1.282","models":[]}]`)
}

func TestGatewayRequiresCurrentProviderPreparationAndDebugAssignment(t *testing.T) {
	encode := func(frame map[string]any, drop ...string) []byte {
		copied := make(map[string]any, len(frame))
		for key, value := range frame {
			copied[key] = value
		}
		for _, key := range drop {
			delete(copied, key)
		}
		encoded, err := json.Marshal(copied)
		if err != nil {
			t.Fatal(err)
		}
		return encoded
	}
	viewRef := map[string]any{"view_digest": strings.Repeat("a", 64)}
	prepare := map[string]any{
		"type": "prepare", "target": "provider", "command_id": "prepare-command", "prepare_id": "prepare",
		"protocol_version": "2", "host_access": "trusted", "tenant_id": "tenant", "registration_id": "registration",
		"assignment_revision": 1, "runner_id": "computer", "runner_revision": 1, "connection_epoch": 1,
		"agent_id": "agent", "workspace_grant_id": "grant", "runtime_type": "codex", "execution_context_key": "context",
		"runtime_instance_id": "runtime", "context_view_ref": viewRef, "runtime": map[string]any{"type": "codex"},
		"session_options": map[string]any{"thread_name": "Agent"}, "session": map[string]any{},
	}
	debug := map[string]any{
		"type": "execute", "kind": "debug_history", "protocol_version": "2", "command_id": "debug", "tenant_id": "tenant",
		"registration_id": "registration", "assignment_revision": 1, "runner_id": "computer", "agent_id": "agent",
		"connection_epoch": 1, "runner_revision": 1, "workspace_grant_id": "grant", "execution_context_key": "context",
		"runtime_instance_id": "runtime", "view_digest": strings.Repeat("a", 64),
		"request": map[string]any{"runtime": map[string]any{"type": "codex"}, "session": map[string]any{}},
	}
	detached := map[string]any{"detached_history": true}
	for key, value := range debug {
		if key != "registration_id" && key != "assignment_revision" && key != "runner_revision" && key != "view_digest" {
			detached[key] = value
		}
	}
	for _, frame := range [][]byte{
		encode(prepare, "host_access"),
		encode(prepare, "registration_id"),
		encode(prepare, "assignment_revision"),
		encode(debug, "registration_id", "assignment_revision"),
		[]byte(strings.Replace(string(encode(prepare)), `"protocol_version":"2"`, `"protocol_version":"1.2"`, 1)),
	} {
		if _, err := decodeGatewayCommand(frame); err == nil {
			t.Fatalf("invalid live frame accepted: %s", frame)
		}
	}
	for _, frame := range [][]byte{
		encode(prepare),
		encode(debug),
		encode(detached),
	} {
		if _, err := decodeGatewayCommand(frame); err != nil {
			t.Fatalf("current frame rejected: %s: %v", frame, err)
		}
	}
}

func TestGatewayModelInvocationKeepsIdentityAndRawRequest(t *testing.T) {
	const valid = `{"type":"execute","kind":"model_invoke","command_id":"command-1","invoke_id":"invoke-1","protocol_version":"2","runner_id":"computer-1","connection_epoch":3,"tenant_id":"tenant-1","owner_actor_id":"owner-1","agent_id":"agent-1","runtime_type":"codex","mode":"structured","reasoning_effort":"low","input":"Question","output_schema":{"type":"object"},"timeout_ms":60000}`
	command, err := decodeGatewayCommand([]byte(valid))
	if err != nil {
		t.Fatal(err)
	}
	var request struct {
		InvokeID     string          `json:"invoke_id"`
		Input        string          `json:"input"`
		OutputSchema json.RawMessage `json:"output_schema"`
	}
	if err := json.Unmarshal(command.Payload, &request); err != nil {
		t.Fatal(err)
	}
	if command.Type != protocol.CommandModelInvoke || command.ConnectionEpoch != 3 || command.TenantID != "tenant-1" ||
		command.OwnerActorID != "owner-1" || command.AgentID != "agent-1" || command.RuntimeType != "codex" ||
		request.InvokeID != "invoke-1" || request.Input != "Question" || string(request.OutputSchema) != `{"type":"object"}` {
		t.Fatalf("command = %+v request = %+v", command, request)
	}
	pi, err := decodeGatewayCommand([]byte(strings.Replace(valid, `"runtime_type":"codex"`, `"runtime_type":"pi"`, 1)))
	if err != nil || pi.RuntimeType != "pi" {
		t.Fatalf("Pi model invocation decoded as %+v: %v", pi, err)
	}
	for _, change := range [][2]string{
		{`"protocol_version":"2"`, `"protocol_version":"1.2"`},
		{`"tenant_id":"tenant-1",`, ""},
		{`"owner_actor_id":"owner-1",`, ""},
		{`"agent_id":"agent-1",`, ""},
		{`"runtime_type":"codex",`, ""},
		{`"connection_epoch":3,`, ""},
	} {
		frame := strings.Replace(valid, change[0], change[1], 1)
		if _, err := decodeGatewayCommand([]byte(frame)); err == nil {
			t.Fatalf("incomplete model invocation accepted: %s", frame)
		}
	}
}

func TestGatewayModelInvocationCancelNamesTheCall(t *testing.T) {
	const valid = `{"type":"cancel","target":"model_invoke","command_id":"command-2","invoke_id":"invoke-1","protocol_version":"2","runner_id":"computer-1","connection_epoch":3,"reason":"scheduler_yield"}`
	command, err := decodeGatewayCommand([]byte(valid))
	if err != nil {
		t.Fatal(err)
	}
	var cancel struct {
		InvokeID string `json:"invoke_id"`
		Reason   string `json:"reason"`
	}
	if err := json.Unmarshal(command.Payload, &cancel); err != nil {
		t.Fatal(err)
	}
	if command.Type != protocol.CommandModelInvokeCancel || command.ConnectionEpoch != 3 ||
		cancel.InvokeID != "invoke-1" || cancel.Reason != "scheduler_yield" {
		t.Fatalf("command = %+v cancel = %+v", command, cancel)
	}
	for _, change := range [][2]string{
		{`"invoke_id":"invoke-1",`, ""},
		{`"connection_epoch":3,`, ""},
	} {
		frame := strings.Replace(valid, change[0], change[1], 1)
		if _, err := decodeGatewayCommand([]byte(frame)); err == nil {
			t.Fatalf("accepted %s", frame)
		}
	}
}

func TestGatewaySessionCompactionKeepsIdentityAndRawRequest(t *testing.T) {
	const valid = `{"type":"execute","kind":"session_compact","command_id":"command-1","compact_id":"compact-1","protocol_version":"2","runner_id":"computer-1","connection_epoch":3,"agent_id":"agent-1","runtime_type":"claude","execution_context_key":"meta:agent-1","instructions":"Keep open questions."}`
	command, err := decodeGatewayCommand([]byte(valid))
	if err != nil {
		t.Fatal(err)
	}
	var request struct {
		CompactID    string `json:"compact_id"`
		Instructions string `json:"instructions"`
	}
	if err := json.Unmarshal(command.Payload, &request); err != nil {
		t.Fatal(err)
	}
	if command.Type != protocol.CommandSessionCompact || command.ConnectionEpoch != 3 || command.AgentID != "agent-1" ||
		command.RuntimeType != "claude" || command.ExecutionContextKey != "meta:agent-1" ||
		request.CompactID != "compact-1" || request.Instructions != "Keep open questions." {
		t.Fatalf("command = %+v request = %+v", command, request)
	}
	piCommand, err := decodeGatewayCommand([]byte(strings.Replace(valid, `"runtime_type":"claude"`, `"runtime_type":"pi"`, 1)))
	if err != nil || piCommand.Type != protocol.CommandSessionCompact || piCommand.RuntimeType != "pi" {
		t.Fatalf("pi session compact = %+v, err = %v", piCommand, err)
	}
	agyFrame := strings.Replace(valid, `"runtime_type":"claude"`, `"runtime_type":"antigravity"`, 1)
	agyCommand, err := decodeGatewayCommand([]byte(agyFrame))
	if err != nil {
		t.Fatalf("decode antigravity session compaction: %v", err)
	}
	if agyCommand.RuntimeType != "antigravity" || agyCommand.Type != protocol.CommandSessionCompact {
		t.Fatalf("antigravity command = %+v", agyCommand)
	}
	for _, change := range [][2]string{
		{`"protocol_version":"2"`, `"protocol_version":"1.2"`},
		{`"command_id":"command-1",`, ``},
		{`"runner_id":"computer-1",`, ``},
		{`"connection_epoch":3,`, ``},
		{`"agent_id":"agent-1",`, ``},
		{`"runtime_type":"claude",`, ``},
		{`"execution_context_key":"meta:agent-1",`, ``},
	} {
		frame := strings.Replace(valid, change[0], change[1], 1)
		if _, err := decodeGatewayCommand([]byte(frame)); err == nil {
			t.Fatalf("incomplete session compaction accepted: %s", frame)
		}
	}
}

// A service feature this release does not know is ignored, not refused, so
// an Agent Service may name a newer one to every Computer.
func TestWelcomeAcceptsAnUnknownServiceFeature(t *testing.T) {
	const welcome = `{"type":"runner.welcome","protocol_version":"2","runner_id":"computer-1","connection_id":"connection-1","connection_epoch":1,"heartbeat_interval_ms":15000,"reconcile_operation_ids":[],"service_features":["local_models","model_gateway_unavailable","a_future_feature"]}`
	command, err := decodeGatewayCommand([]byte(welcome))
	if err != nil {
		t.Fatal(err)
	}
	if len(command.ServiceFeatures) != 3 || command.ServiceFeatures[1] != "model_gateway_unavailable" || command.ServiceFeatures[2] != "a_future_feature" {
		t.Fatalf("service_features = %v", command.ServiceFeatures)
	}
}

func TestOperationFailedEncodesModelGatewayUnavailable(t *testing.T) {
	payload, err := json.Marshal(map[string]any{
		"code":      "OPERATION_FAILED",
		"message":   "The BYOK gateway could not be started on this Computer.",
		"retryable": true,
		"failure": map[string]any{
			"code":         "model_gateway_unavailable",
			"runtime_type": "codex",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	frame, err := replyFrame(protocol.Event{
		Type:                protocol.EventOperationFailed,
		ProtocolVersion:     "2",
		HostAccess:          "trusted",
		CommandID:           "command-1",
		TenantID:            "tenant-1",
		RunnerID:            "computer-1",
		AgentID:             "agent-1",
		RegistrationID:      "registration-1",
		AssignmentRevision:  1,
		OperationID:         "operation-1",
		ConnectionEpoch:     1,
		RunnerRevision:      1,
		Generation:          1,
		ExecutionLeaseID:    "lease-1",
		WorkspaceGrantID:    "grant-1",
		RuntimeType:         "codex",
		ExecutionContextKey: "context-1",
		RuntimeInstanceID:   "runtime-1",
		ContextViewRef:      json.RawMessage(`{"view_digest":"` + strings.Repeat("a", 64) + `"}`),
		Sequence:            1,
		Payload:             payload,
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	var wireFrame struct {
		Type  string `json:"type"`
		Error struct {
			Failure struct {
				Code        string `json:"code"`
				RuntimeType string `json:"runtime_type"`
			} `json:"failure"`
		} `json:"error"`
	}
	if err := json.Unmarshal(encoded, &wireFrame); err != nil {
		t.Fatal(err)
	}
	if wireFrame.Type != "operation.failed" || wireFrame.Error.Failure.Code != "model_gateway_unavailable" || wireFrame.Error.Failure.RuntimeType != "codex" {
		t.Fatalf("encoded frame = %s", encoded)
	}
}

func TestDebugInspectedColdDetachedOmitsZeroIdentityFields(t *testing.T) {
	payload, err := json.Marshal(map[string]any{
		"status":        "available",
		"provider_kind": "antigravity",
		"source":        "antigravity_transcript",
		"snapshot": map[string]any{
			"id":           "snap-1",
			"thread_id":    "conv-agy-1",
			"captured_at":  "2026-11-26T12:00:00Z",
			"record_count": 1,
			"tail_state":   "clean",
		},
		"instructions": map[string]any{
			"status": "unavailable",
			"source": "antigravity_transcript",
			"reason": "Native transcript does not contain an instruction snapshot",
			"blocks": []any{},
		},
		"records": []any{
			map[string]any{
				"ordinal":         0,
				"turn_id":         "step-0",
				"category":        "message",
				"native_type":     "USER_INPUT",
				"role":            "user",
				"native_record":   map[string]any{"type": "USER_INPUT", "content": "hello"},
				"redacted_fields": []any{},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	t.Run("cold_detached_omits_optional_identity", func(t *testing.T) {
		frame, err := replyFrame(protocol.Event{
			Type:                protocol.EventDebugInspected,
			ProtocolVersion:     "2",
			CommandID:           "command-cold",
			TenantID:            "tenant-1",
			RunnerID:            "computer-1",
			AgentID:             "agent-1",
			ConnectionEpoch:     1,
			WorkspaceGrantID:    "grant-1",
			ExecutionContextKey: "context-cold",
			RuntimeInstanceID:   "context-cold",
			Payload:             payload,
		})
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(frame)
		if err != nil {
			t.Fatal(err)
		}
		var raw map[string]any
		if err := json.Unmarshal(encoded, &raw); err != nil {
			t.Fatal(err)
		}
		for _, omitted := range []string{"runner_revision", "registration_id", "assignment_revision", "view_digest"} {
			if _, present := raw[omitted]; present {
				t.Fatalf("cold detached frame must omit %q: %s", omitted, encoded)
			}
		}
		if raw["detached_history"] != true || raw["type"] != "executed" || raw["kind"] != "debug_history" || raw["protocol_version"] != "2" {
			t.Fatalf("unexpected cold detached frame: %s", encoded)
		}
		for _, required := range frame.RequiredFields() {
			if _, present := raw[required]; !present {
				t.Fatalf("cold detached frame missing required field %q: %s", required, encoded)
			}
		}
	})

	t.Run("warm_detached_and_live_preserve_identity", func(t *testing.T) {
		warmDetached, err := replyFrame(protocol.Event{
			Type:                protocol.EventDebugInspected,
			ProtocolVersion:     "2",
			CommandID:           "command-warm",
			TenantID:            "tenant-1",
			RunnerID:            "computer-1",
			AgentID:             "agent-1",
			RegistrationID:      "reg-1",
			AssignmentRevision:  2,
			ConnectionEpoch:     1,
			RunnerRevision:      3,
			WorkspaceGrantID:    "grant-1",
			ExecutionContextKey: "context-warm",
			RuntimeInstanceID:   "runtime-1",
			Payload:             payload,
		})
		if err != nil {
			t.Fatal(err)
		}
		encodedWarm, err := json.Marshal(warmDetached)
		if err != nil {
			t.Fatal(err)
		}
		var warmMap map[string]any
		if err := json.Unmarshal(encodedWarm, &warmMap); err != nil {
			t.Fatal(err)
		}
		if warmMap["runner_revision"] != float64(3) || warmMap["registration_id"] != "reg-1" ||
			warmMap["assignment_revision"] != float64(2) || warmMap["detached_history"] != true {
			t.Fatalf("unexpected warm detached frame: %s", encodedWarm)
		}
		if _, present := warmMap["view_digest"]; present {
			t.Fatalf("warm detached frame must omit view_digest: %s", encodedWarm)
		}

		digest := strings.Repeat("b", 64)
		live, err := replyFrame(protocol.Event{
			Type:                protocol.EventDebugInspected,
			ProtocolVersion:     "2",
			CommandID:           "command-live",
			TenantID:            "tenant-1",
			RunnerID:            "computer-1",
			AgentID:             "agent-1",
			RegistrationID:      "reg-1",
			AssignmentRevision:  2,
			ConnectionEpoch:     1,
			RunnerRevision:      3,
			WorkspaceGrantID:    "grant-1",
			ExecutionContextKey: "context-live",
			RuntimeInstanceID:   "runtime-1",
			ViewDigest:          digest,
			Payload:             payload,
		})
		if err != nil {
			t.Fatal(err)
		}
		encodedLive, err := json.Marshal(live)
		if err != nil {
			t.Fatal(err)
		}
		var liveMap map[string]any
		if err := json.Unmarshal(encodedLive, &liveMap); err != nil {
			t.Fatal(err)
		}
		if liveMap["runner_revision"] != float64(3) || liveMap["registration_id"] != "reg-1" ||
			liveMap["assignment_revision"] != float64(2) || liveMap["view_digest"] != digest {
			t.Fatalf("unexpected live frame: %s", encodedLive)
		}
		if _, present := liveMap["detached_history"]; present {
			t.Fatalf("live frame must omit detached_history: %s", encodedLive)
		}
	})
}
