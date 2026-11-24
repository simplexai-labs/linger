package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/localmodels"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

// fakeModelInvoker holds each call until release or cancellation.
type fakeModelInvoker struct {
	mu       sync.Mutex
	started  chan provider.ModelInvokeRequest
	release  chan struct{}
	requests []provider.ModelInvokeRequest
}

func newFakeModelInvoker() *fakeModelInvoker {
	return &fakeModelInvoker{started: make(chan provider.ModelInvokeRequest, 8), release: make(chan struct{})}
}

func (f *fakeModelInvoker) Close() {}

func (f *fakeModelInvoker) Invoke(ctx context.Context, request provider.ModelInvokeRequest) provider.ModelInvokeResult {
	f.mu.Lock()
	f.requests = append(f.requests, request)
	f.mu.Unlock()
	f.started <- request
	select {
	case <-f.release:
		return provider.ModelInvokeResult{
			Outcome: provider.ModelInvokeCompleted, Text: `{"answer":"ok"}`, Model: "fixture-model", RuntimeVersion: "0.166.0",
			Usage: &provider.ModelInvokeUsage{InputTokens: 10, CachedInputTokens: 2, OutputTokens: 3},
		}
	case <-ctx.Done():
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeCanceled, Reason: "Model invocation was canceled"}
	}
}

func (f *fakeModelInvoker) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

func (f *fakeModelInvoker) lastRequest() provider.ModelInvokeRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.requests[len(f.requests)-1]
}

func modelInvokeFixture(t *testing.T, invoker ModelInvoker) (*Daemon, *fakeStream) {
	t.Helper()
	stream := &fakeStream{}
	d, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream}, IdentityStore: fakeStore{},
		OperationResolver: prepareOperationResolver{workingDirectory: t.TempDir()},
		ModelInvoker:      invoker,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Tests never touch the real network; a failed call finds it reachable
	// unless the test says otherwise.
	d.dialNetwork = func(context.Context, string, string) error { return nil }
	t.Cleanup(d.WaitForOperations)
	return d, stream
}

func modelInvokeCommand(invokeID string, payload map[string]any) protocol.Command {
	body := map[string]any{
		"invoke_id": invokeID, "mode": "structured", "reasoning_effort": "low", "instructions": "Answer.",
		"input": "Question", "output_schema": map[string]any{"type": "object"}, "timeout_ms": 30000,
	}
	for key, value := range payload {
		body[key] = value
	}
	return protocol.Command{
		Type: protocol.CommandModelInvoke, CommandID: "command-" + invokeID, ProtocolVersion: "1.2",
		RunnerID: "computer-1", ConnectionEpoch: 1, TenantID: "tenant-1", OwnerActorID: "owner-1", AgentID: "agent-1",
		RuntimeType: "codex", Payload: mustJSON(body),
	}
}

func waitForModelInvoked(t *testing.T, stream *fakeStream, invokeID string) map[string]any {
	t.Helper()
	watchdog := time.After(5 * time.Second)
	for {
		for _, event := range stream.snapshotEvents() {
			var payload map[string]any
			_ = json.Unmarshal(event.Payload, &payload)
			if event.Type == protocol.EventModelInvoked && payload["invoke_id"] == invokeID {
				return payload
			}
		}
		select {
		case <-watchdog:
			t.Fatalf("no model.invoked for %s", invokeID)
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestModelInvokeRunsTheCallAndReportsItsResult(t *testing.T) {
	for _, runtime := range []string{"codex", "pi"} {
		t.Run(runtime, func(t *testing.T) {
			invoker := newFakeModelInvoker()
			d, stream := modelInvokeFixture(t, invoker)
			command := modelInvokeCommand("invoke-1", map[string]any{"session_key": "permission-review:abc"})
			command.RuntimeType = runtime
			if err := d.handleModelInvoke(context.Background(), stream, command); err != nil {
				t.Fatal(err)
			}
			request := <-invoker.started
			if request.RuntimeType != runtime || request.Mode != "structured" || request.ReasoningEffort != "low" ||
				request.Instructions != "Answer." || request.Input != "Question" || string(request.OutputSchema) != `{"type":"object"}` ||
				request.Timeout != 30*time.Second || request.SessionKey != "permission-review:abc" {
				t.Fatalf("request = %+v", request)
			}
			close(invoker.release)
			payload := waitForModelInvoked(t, stream, "invoke-1")
			if payload["outcome"] != "completed" || payload["text"] != `{"answer":"ok"}` || payload["model"] != "fixture-model" ||
				payload["runtime_version"] != "0.166.0" || payload["command_id"] != "command-invoke-1" || payload["runner_id"] != "computer-1" ||
				payload["reason"] != nil {
				t.Fatalf("payload = %v", payload)
			}
			usage, _ := payload["usage"].(map[string]any)
			if usage["input_tokens"] != float64(10) || usage["cached_input_tokens"] != float64(2) || usage["output_tokens"] != float64(3) {
				t.Fatalf("usage = %v", usage)
			}
		})
	}
}

func TestModelInvokeRunsEveryCallItReceives(t *testing.T) {
	invoker := newFakeModelInvoker()
	d, stream := modelInvokeFixture(t, invoker)
	// The Agent Service's scheduler bounds concurrency; the Daemon has no cap.
	running := make([]string, 0, 5)
	for index := range 5 {
		id := fmt.Sprintf("invoke-%d", index+1)
		if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand(id, nil)); err != nil {
			t.Fatal(err)
		}
		<-invoker.started
		running = append(running, id)
	}
	close(invoker.release)
	for _, id := range running {
		if payload := waitForModelInvoked(t, stream, id); payload["outcome"] != "completed" {
			t.Fatalf("%s payload = %v", id, payload)
		}
	}
	if invoker.calls() != len(running) {
		t.Fatalf("calls = %d", invoker.calls())
	}
}

func TestActiveModelInvokeCountTracksInFlightCalls(t *testing.T) {
	invoker := newFakeModelInvoker()
	d, stream := modelInvokeFixture(t, invoker)
	if got := d.ActiveModelInvokeCount(); got != 0 {
		t.Fatalf("initial active model invokes = %d", got)
	}
	for _, id := range []string{"invoke-a", "invoke-b"} {
		if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand(id, nil)); err != nil {
			t.Fatal(err)
		}
		<-invoker.started
	}
	if got := d.ActiveModelInvokeCount(); got != 2 {
		t.Fatalf("in-flight active model invokes = %d", got)
	}
	if got := d.ActiveOperationCount(); got != 0 {
		t.Fatalf("model invokes must not count as active operations, got %d", got)
	}
	cancel := protocol.Command{
		Type: protocol.CommandModelInvokeCancel, CommandID: "cancel-invoke-a", RunnerID: "computer-1", ConnectionEpoch: 1,
		Payload: mustJSON(map[string]any{"invoke_id": "invoke-a", "reason": "scheduler_yield"}),
	}
	if err := d.cancelModelInvoke(cancel); err != nil {
		t.Fatal(err)
	}
	if payload := waitForModelInvoked(t, stream, "invoke-a"); payload["outcome"] != "canceled" {
		t.Fatalf("payload = %v", payload)
	}
	if got := d.ActiveModelInvokeCount(); got != 1 {
		t.Fatalf("remaining active model invokes = %d", got)
	}
	close(invoker.release)
	if payload := waitForModelInvoked(t, stream, "invoke-b"); payload["outcome"] != "completed" {
		t.Fatalf("payload = %v", payload)
	}
	d.WaitForOperations()
	if got := d.ActiveModelInvokeCount(); got != 0 {
		t.Fatalf("final active model invokes = %d", got)
	}
}

func TestModelInvokeIsCanceledByDisconnectAndDrain(t *testing.T) {
	for name, stop := range map[string]func(*Daemon, context.CancelFunc){
		"connection lost": func(_ *Daemon, cancelConnection context.CancelFunc) { cancelConnection() },
		"connection cleanup": func(d *Daemon, _ context.CancelFunc) {
			d.cancelModelInvokes("connection_lost")
		},
		"drain": func(d *Daemon, _ context.CancelFunc) { d.Drain(); d.WaitForOperations() },
	} {
		t.Run(name, func(t *testing.T) {
			invoker := newFakeModelInvoker()
			d, stream := modelInvokeFixture(t, invoker)
			connectionCtx, cancelConnection := context.WithCancel(context.Background())
			defer cancelConnection()
			if err := d.handleModelInvoke(connectionCtx, stream, modelInvokeCommand("invoke-stop", nil)); err != nil {
				t.Fatal(err)
			}
			<-invoker.started
			stop(d, cancelConnection)
			payload := waitForModelInvoked(t, stream, "invoke-stop")
			if payload["outcome"] != "canceled" || payload["text"] != nil {
				t.Fatalf("payload = %v", payload)
			}
			d.WaitForOperations()
			if len(d.modelInvokes) != 0 {
				t.Fatalf("in-flight calls = %v", d.modelInvokes)
			}
		})
	}
}

func TestModelInvokeCancelStopsOnlyThatCall(t *testing.T) {
	invoker := newFakeModelInvoker()
	d, stream := modelInvokeFixture(t, invoker)
	for _, id := range []string{"invoke-keep", "invoke-yield"} {
		if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand(id, nil)); err != nil {
			t.Fatal(err)
		}
		<-invoker.started
	}
	cancel := func(id string) protocol.Command {
		return protocol.Command{
			Type: protocol.CommandModelInvokeCancel, CommandID: "cancel-" + id, RunnerID: "computer-1", ConnectionEpoch: 1,
			Payload: mustJSON(map[string]any{"invoke_id": id, "reason": "scheduler_yield"}),
		}
	}
	if err := d.cancelModelInvoke(cancel("invoke-yield")); err != nil {
		t.Fatal(err)
	}
	if payload := waitForModelInvoked(t, stream, "invoke-yield"); payload["outcome"] != "canceled" {
		t.Fatalf("payload = %v", payload)
	}
	// A cancel that arrives after its call was answered does nothing.
	if err := d.cancelModelInvoke(cancel("invoke-yield")); err != nil {
		t.Fatal(err)
	}
	close(invoker.release)
	if payload := waitForModelInvoked(t, stream, "invoke-keep"); payload["outcome"] != "completed" {
		t.Fatalf("payload = %v", payload)
	}
}

func TestModelInvokeRefusesWithoutRunningTheCall(t *testing.T) {
	for name, test := range map[string]struct {
		setup   func(*Daemon)
		payload map[string]any
		outcome string
	}{
		"draining":           {setup: func(d *Daemon) { d.draining = true }, outcome: "unavailable"},
		"locally stopped":    {setup: func(d *Daemon) { d.locallyStopped["agent-1"] = true }, outcome: "unavailable"},
		"structured without": {payload: map[string]any{"output_schema": nil}, outcome: "failed"},
		"unknown effort":     {payload: map[string]any{"reasoning_effort": "xhigh"}, outcome: "failed"},
		"text with files": {payload: map[string]any{
			"mode": "text", "workspace_files": []map[string]any{{"path": "a.md", "content_base64": "YQ=="}},
		}, outcome: "failed"},
	} {
		t.Run(name, func(t *testing.T) {
			invoker := newFakeModelInvoker()
			d, stream := modelInvokeFixture(t, invoker)
			if test.setup != nil {
				test.setup(d)
			}
			if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand("invoke-refused", test.payload)); err != nil {
				t.Fatal(err)
			}
			if payload := waitForModelInvoked(t, stream, "invoke-refused"); payload["outcome"] != test.outcome || payload["reason"] == nil {
				t.Fatalf("payload = %v", payload)
			}
			if invoker.calls() != 0 {
				t.Fatal("a refused call ran")
			}
		})
	}
}

func TestModelInvokeWithoutAnInvokerAnswersRuntimeUnavailable(t *testing.T) {
	d, stream := modelInvokeFixture(t, nil)
	if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand("invoke-none", nil)); err != nil {
		t.Fatal(err)
	}
	if payload := waitForModelInvoked(t, stream, "invoke-none"); payload["outcome"] != "runtime_unavailable" {
		t.Fatalf("payload = %v", payload)
	}
}

func TestModelInvokeCarriesWorkspaceFilesBothWays(t *testing.T) {
	invoker := &workspaceModelInvoker{}
	d, stream := modelInvokeFixture(t, invoker)
	command := modelInvokeCommand("invoke-files", map[string]any{
		"mode": "workspace", "output_schema": nil,
		"workspace_files": []map[string]any{{"path": "raw/a.md", "content_base64": "aGVsbG8="}},
	})
	if err := d.handleModelInvoke(context.Background(), stream, command); err != nil {
		t.Fatal(err)
	}
	payload := waitForModelInvoked(t, stream, "invoke-files")
	files, _ := payload["workspace_files"].([]any)
	if payload["outcome"] != "completed" || len(files) != 1 {
		t.Fatalf("payload = %v", payload)
	}
	file, _ := files[0].(map[string]any)
	if file["path"] != "pages/a.json" || file["content_base64"] != "e30=" {
		t.Fatalf("file = %v", file)
	}
	if len(invoker.request.WorkspaceFiles) != 1 || string(invoker.request.WorkspaceFiles[0].Content) != "hello" {
		t.Fatalf("request files = %+v", invoker.request.WorkspaceFiles)
	}
}

type workspaceModelInvoker struct{ request provider.ModelInvokeRequest }

func (w *workspaceModelInvoker) Close() {}

func (w *workspaceModelInvoker) Invoke(_ context.Context, request provider.ModelInvokeRequest) provider.ModelInvokeResult {
	w.request = request
	return provider.ModelInvokeResult{
		Outcome: provider.ModelInvokeCompleted, Text: "",
		WorkspaceFiles: []provider.ModelInvokeFile{{Path: "pages/a.json", Content: []byte("{}")}},
	}
}

// A reply within the text and tree bounds can still encode past the frame
// limit; it is reported as failed instead of closing the connection.
func TestModelInvokeDegradesAReplyLargerThanAFrame(t *testing.T) {
	invoker := &oversizedModelInvoker{}
	d, stream := modelInvokeFixture(t, invoker)
	if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand("invoke-big", map[string]any{"mode": "text", "output_schema": nil})); err != nil {
		t.Fatal(err)
	}
	payload := waitForModelInvoked(t, stream, "invoke-big")
	if payload["outcome"] != "failed" || payload["text"] != nil || payload["workspace_files"] != nil ||
		!strings.Contains(fmt.Sprint(payload["reason"]), "frame limit") {
		t.Fatalf("payload outcome = %v reason = %v", payload["outcome"], payload["reason"])
	}
	for _, event := range stream.snapshotEvents() {
		if len(event.Payload) > transport.MaxFrameBytes {
			t.Fatalf("sent a %d byte frame", len(event.Payload))
		}
	}
}

type oversizedModelInvoker struct{}

func (oversizedModelInvoker) Close() {}

func (oversizedModelInvoker) Invoke(context.Context, provider.ModelInvokeRequest) provider.ModelInvokeResult {
	// Control characters escape to six bytes each in JSON.
	text := strings.Repeat("\x01", provider.ModelInvokeMaxTextBytes)
	files := []provider.ModelInvokeFile{{Path: "pages/a.json", Content: make([]byte, provider.ModelInvokeMaxWorkspaceBytes)}}
	return provider.ModelInvokeResult{Outcome: provider.ModelInvokeCompleted, Text: text, WorkspaceFiles: files}
}

// stoppedModelInvoker answers every call as a session call that stopped early.
type stoppedModelInvoker struct {
	request chan provider.ModelInvokeRequest
}

func (s stoppedModelInvoker) Close() {}

func (s stoppedModelInvoker) Invoke(_ context.Context, request provider.ModelInvokeRequest) provider.ModelInvokeResult {
	s.request <- request
	return provider.ModelInvokeResult{Outcome: provider.ModelInvokeOutputLimited, Reason: "Model reply exceeded its output limit", Text: `{"actions":[{"p`}
}

func TestModelInvokeCarriesTheCapAndWhatAStoppedCallStreamed(t *testing.T) {
	invoker := stoppedModelInvoker{request: make(chan provider.ModelInvokeRequest, 1)}
	d, stream := modelInvokeFixture(t, invoker)
	if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand("invoke-1", map[string]any{"max_output_chars": 24000})); err != nil {
		t.Fatal(err)
	}
	if request := <-invoker.request; request.MaxOutputChars != 24000 {
		t.Fatalf("request = %+v", request)
	}
	payload := waitForModelInvoked(t, stream, "invoke-1")
	if payload["outcome"] != "output_limited" || payload["text"] != `{"actions":[{"p` || payload["reason"] != "Model reply exceeded its output limit" || payload["usage"] != nil {
		t.Fatalf("payload = %v", payload)
	}
}

// failingModelInvoker answers every call as failed with a fixed reason.
type failingModelInvoker struct{ reason string }

func (f failingModelInvoker) Close() {}

func (f failingModelInvoker) Invoke(context.Context, provider.ModelInvokeRequest) provider.ModelInvokeResult {
	return provider.ModelInvokeResult{Outcome: provider.ModelInvokeFailed, Reason: f.reason}
}

// modelInvokeLogLines records the runner.model.invoke lines with the given phase.
func modelInvokeLogLines(t *testing.T) func(phase string) []map[string]any {
	t.Helper()
	buffer := &bytes.Buffer{}
	var mu sync.Mutex
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(lockedWriter{mu: &mu, w: buffer}, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return func(phase string) []map[string]any {
		mu.Lock()
		defer mu.Unlock()
		var lines []map[string]any
		for _, line := range strings.Split(strings.TrimSpace(buffer.String()), "\n") {
			var record map[string]any
			if json.Unmarshal([]byte(line), &record) == nil && record["msg"] == "runner.model.invoke" && record["phase"] == phase {
				lines = append(lines, record)
			}
		}
		return lines
	}
}

type lockedWriter struct {
	mu *sync.Mutex
	w  *bytes.Buffer
}

func (l lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}

func TestModelInvokeLogsARedactedTruncatedFailureReason(t *testing.T) {
	secret := "sk-" + strings.Repeat("A", 40)
	for name, test := range map[string]struct {
		reason string
		check  func(t *testing.T, logged string)
	}{
		"readable": {reason: "model_not_found: The model gpt-x does not exist", check: func(t *testing.T, logged string) {
			if logged != "model_not_found: The model gpt-x does not exist" {
				t.Fatalf("reason = %q", logged)
			}
		}},
		"credentials": {reason: "upstream 401 with key " + secret + " and Authorization: Bearer fixture-token", check: func(t *testing.T, logged string) {
			if strings.Contains(logged, secret) || strings.Contains(logged, "fixture-token") || !strings.Contains(logged, "[REDACTED]") {
				t.Fatalf("reason = %q", logged)
			}
		}},
		"long": {reason: strings.Repeat("é", 400), check: func(t *testing.T, logged string) {
			if logged != strings.Repeat("é", 300) {
				t.Fatalf("reason has %d runes", len([]rune(logged)))
			}
		}},
	} {
		t.Run(name, func(t *testing.T) {
			lines := modelInvokeLogLines(t)
			d, stream := modelInvokeFixture(t, failingModelInvoker{reason: test.reason})
			if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand("invoke-failed", nil)); err != nil {
				t.Fatal(err)
			}
			waitForModelInvoked(t, stream, "invoke-failed")
			failed := lines("failed")
			if len(failed) != 1 || failed[0]["invoke_id"] != "invoke-failed" {
				t.Fatalf("log lines = %v", failed)
			}
			logged, _ := failed[0]["reason"].(string)
			test.check(t, logged)
		})
	}
}

func TestModelInvokeLogsNoReasonForACompletedCall(t *testing.T) {
	lines := modelInvokeLogLines(t)
	invoker := newFakeModelInvoker()
	d, stream := modelInvokeFixture(t, invoker)
	if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand("invoke-ok", nil)); err != nil {
		t.Fatal(err)
	}
	<-invoker.started
	close(invoker.release)
	waitForModelInvoked(t, stream, "invoke-ok")
	completed := lines("completed")
	if len(completed) != 1 {
		t.Fatalf("log lines = %v", completed)
	}
	if _, ok := completed[0]["reason"]; ok {
		t.Fatalf("completed line has a reason: %v", completed[0])
	}
}

func TestModelInvokeNormalizesUnsupportedEffortForTargetModel(t *testing.T) {
	tests := []struct {
		name        string
		runtimeType string
		models      []provider.RuntimeModel
		requested   string
		want        string
	}{
		{
			name:        "codex model clamps medium to declared high default",
			runtimeType: "codex",
			models: []provider.RuntimeModel{{
				ID:                     "custom-model",
				Label:                  "Custom Model",
				AllowedReasoningEffort: []string{"low", "high"},
				DefaultReasoningEffort: "high",
				IsDefault:              true,
			}},
			requested: "medium",
			want:      "high",
		},
		{
			name:        "codex model clamps medium to declared low default on tie",
			runtimeType: "codex",
			models: []provider.RuntimeModel{{
				ID:                     "custom-model",
				Label:                  "Custom Model",
				AllowedReasoningEffort: []string{"low", "high"},
				DefaultReasoningEffort: "low",
				IsDefault:              true,
			}},
			requested: "medium",
			want:      "low",
		},
		{
			name:        "codex model filters unsupported ultra effort from allowed list",
			runtimeType: "codex",
			models: []provider.RuntimeModel{{
				ID:                     "custom-model",
				Label:                  "Custom Model",
				AllowedReasoningEffort: []string{"low", "ultra"},
				IsDefault:              true,
			}},
			requested: "high",
			want:      "low",
		},
		{
			name:        "claude none-only model normalizes to none",
			runtimeType: "claude",
			models: []provider.RuntimeModel{{
				ID:                     "claude-none",
				Label:                  "Claude None",
				AllowedReasoningEffort: []string{"none"},
				IsDefault:              true,
			}},
			requested: "medium",
			want:      "none",
		},
		{
			name:        "pi passes requested effort through for live get_state clamping",
			runtimeType: "pi",
			models: []provider.RuntimeModel{{
				ID:                     "localmodels/Spark-X2.6-4B-Q8_0",
				Label:                  "Spark-X2.6-4B-Q8_0",
				AllowedReasoningEffort: []string{"low", "high"},
				DefaultReasoningEffort: "high",
				IsDefault:              true,
			}},
			requested: "medium",
			want:      "medium",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			invoker := newFakeModelInvoker()
			stream := &fakeStream{}
			diagnostics := mustJSON([]provider.RuntimeDiagnostic{{
				Type:   tc.runtimeType,
				Status: "ready",
				Models: tc.models,
			}})
			d, err := newTestDaemon(t, Options{
				ComputerID:         "computer-1",
				ControlPlane:       fakeControlPlane{stream: stream},
				IdentityStore:      fakeStore{},
				OperationResolver:  prepareOperationResolver{workingDirectory: t.TempDir()},
				ModelInvoker:       invoker,
				Runtimes:           []string{tc.runtimeType},
				RuntimeDiagnostics: diagnostics,
			})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(d.WaitForOperations)

			command := modelInvokeCommand("invoke-effort", map[string]any{"reasoning_effort": tc.requested})
			command.RuntimeType = tc.runtimeType
			if err := d.handleModelInvoke(context.Background(), stream, command); err != nil {
				t.Fatal(err)
			}
			request := <-invoker.started
			if request.ReasoningEffort != tc.want {
				t.Fatalf("normalized ReasoningEffort = %q; want %q", request.ReasoningEffort, tc.want)
			}
			close(invoker.release)
			if payload := waitForModelInvoked(t, stream, "invoke-effort"); payload["outcome"] != "completed" {
				t.Fatalf("payload = %v", payload)
			}
		})
	}
}

type fixedOutcomeModelInvoker struct {
	result provider.ModelInvokeResult
}

func (f fixedOutcomeModelInvoker) Close() {}

func (f fixedOutcomeModelInvoker) Invoke(context.Context, provider.ModelInvokeRequest) provider.ModelInvokeResult {
	return f.result
}

func TestModelInvokeOutcomesFollowWelcomeServiceFeature(t *testing.T) {
	cases := []struct {
		name            string
		result          provider.ModelInvokeResult
		featureAccepted bool
		wantOutcome     string
	}{
		{
			name:            "context_too_long downgrades for legacy service",
			result:          provider.ModelInvokeResult{Outcome: provider.ModelInvokeContextTooLong, Reason: "prompt too long"},
			featureAccepted: false,
			wantOutcome:     provider.ModelInvokeFailed,
		},
		{
			name:            "context_too_long passes through when service accepts model_invoke_outcomes",
			result:          provider.ModelInvokeResult{Outcome: provider.ModelInvokeContextTooLong, Reason: "prompt too long"},
			featureAccepted: true,
			wantOutcome:     provider.ModelInvokeContextTooLong,
		},
		{
			name:            "unsupported downgrades for legacy service",
			result:          provider.ModelInvokeResult{Outcome: provider.ModelInvokeUnsupported, Reason: "Pi background calls do not run file tools"},
			featureAccepted: false,
			wantOutcome:     provider.ModelInvokeRuntimeUnavailable,
		},
		{
			name:            "unsupported passes through when service accepts model_invoke_outcomes",
			result:          provider.ModelInvokeResult{Outcome: provider.ModelInvokeUnsupported, Reason: "Pi background calls do not run file tools"},
			featureAccepted: true,
			wantOutcome:     provider.ModelInvokeUnsupported,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d, stream := modelInvokeFixture(t, fixedOutcomeModelInvoker{result: tc.result})
			d.modelInvokeOutcomes.Store(tc.featureAccepted)
			if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand("invoke-outcome", nil)); err != nil {
				t.Fatal(err)
			}
			payload := waitForModelInvoked(t, stream, "invoke-outcome")
			if payload["outcome"] != tc.wantOutcome {
				t.Fatalf("outcome = %v; want %q", payload["outcome"], tc.wantOutcome)
			}
		})
	}
}

// Pi may list the Computer's downloaded local models with none loaded; a
// model call, which names no model, is refused instead of starting Pi.
func TestModelInvokeRefusesAPiWithNoLoadedModel(t *testing.T) {
	invoker := newFakeModelInvoker()
	d, stream := modelInvokeFixture(t, invoker)
	d.modelInvokeUnready = func(runtimeType string) bool { return runtimeType == "pi" }
	command := modelInvokeCommand("invoke-pi", nil)
	command.RuntimeType = "pi"
	if err := d.handleModelInvoke(context.Background(), stream, command); err != nil {
		t.Fatal(err)
	}
	if payload := waitForModelInvoked(t, stream, "invoke-pi"); payload["outcome"] != "runtime_unavailable" {
		t.Fatalf("payload = %v", payload)
	}
	if invoker.calls() != 0 {
		t.Fatalf("invoker calls = %d", invoker.calls())
	}
	// Another Runtime is unaffected.
	if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand("invoke-codex", nil)); err != nil {
		t.Fatal(err)
	}
	<-invoker.started
	close(invoker.release)
	if payload := waitForModelInvoked(t, stream, "invoke-codex"); payload["outcome"] != "completed" {
		t.Fatalf("payload = %v", payload)
	}
}

// A Pi model call that names its model loads it on demand through the local
// model library, matching a Pi Run, even when no model was loaded yet.
func TestModelInvokeLoadsNamedPiLocalModelOnDemand(t *testing.T) {
	invoker := newFakeModelInvoker()
	d, stream := modelInvokeFixture(t, invoker)
	library := &fakeLocalModels{}
	d.localModels = library
	d.modelInvokeUnready = func(runtimeType string) bool { return runtimeType == "pi" }

	command := modelInvokeCommand("invoke-pi-named", map[string]any{"model": localRunModel})
	command.RuntimeType = "pi"
	if err := d.handleModelInvoke(context.Background(), stream, command); err != nil {
		t.Fatal(err)
	}
	<-invoker.started
	close(invoker.release)
	if payload := waitForModelInvoked(t, stream, "invoke-pi-named"); payload["outcome"] != "completed" {
		t.Fatalf("payload = %v", payload)
	}
	if len(library.ensured) != 1 || library.ensured[0] != localRunModel {
		t.Fatalf("EnsureLoaded calls = %v", library.ensured)
	}
	if got := invoker.lastRequest().Model; got != localRunModel {
		t.Fatalf("invoked model = %q, want %q", got, localRunModel)
	}

	// A load refusal surfaces as runtime_unavailable without starting Pi.
	library.ensureErr = &localmodels.LocalModelLoadError{Code: "LOAD_NO_ROOM", ModelID: "qwen3-4b:Q4_K_M"}
	failedCommand := modelInvokeCommand("invoke-pi-oom", map[string]any{"model": localRunModel})
	failedCommand.RuntimeType = "pi"
	if err := d.handleModelInvoke(context.Background(), stream, failedCommand); err != nil {
		t.Fatal(err)
	}
	payload := waitForModelInvoked(t, stream, "invoke-pi-oom")
	if payload["outcome"] != "runtime_unavailable" || !strings.Contains(payload["reason"].(string), "LOAD_NO_ROOM") {
		t.Fatalf("load failure payload = %v", payload)
	}
	if invoker.calls() != 1 {
		t.Fatalf("invoker calls = %d, want 1", invoker.calls())
	}
}

// Effort normalization clamps against the requested model's advertised levels
// rather than the Runtime's default model.
func TestModelInvokeNormalizesEffortForRequestedModel(t *testing.T) {
	invoker := newFakeModelInvoker()
	d, stream := modelInvokeFixture(t, invoker)
	d.runtimeDiagnostics = mustJSON([]provider.RuntimeDiagnostic{{
		Type: "codex", Status: "ready",
		Models: []provider.RuntimeModel{
			{ID: "gpt-default", IsDefault: true, AllowedReasoningEffort: []string{"low", "medium"}, DefaultReasoningEffort: "low"},
			{ID: "gpt-high-only", AllowedReasoningEffort: []string{"high"}, DefaultReasoningEffort: "high"},
		},
	}})
	if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand("invoke-effort", map[string]any{
		"model":            "gpt-high-only",
		"reasoning_effort": "low",
	})); err != nil {
		t.Fatal(err)
	}
	<-invoker.started
	close(invoker.release)
	if payload := waitForModelInvoked(t, stream, "invoke-effort"); payload["outcome"] != "completed" {
		t.Fatalf("payload = %v", payload)
	}
	if got := invoker.lastRequest(); got.Model != "gpt-high-only" || got.ReasoningEffort != "high" {
		t.Fatalf("request = %+v; want model gpt-high-only and effort high", got)
	}
}
