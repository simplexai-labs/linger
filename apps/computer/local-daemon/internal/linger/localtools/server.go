package localtools

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
)

type toolServer struct {
	server    *http.Server
	url       string
	path      string
	tools     []tool
	identity  mcpproxy.OperationIdentity
	ctx       context.Context
	call      func(context.Context, string, json.RawMessage) (json.RawMessage, error)
	ready     chan struct{}
	readyOnce sync.Once
	slots     chan struct{}
	callsMu   sync.Mutex
	calls     map[string]context.CancelFunc
	timeout   time.Duration
}

type localToolCall struct {
	Name      string                 `json:"name"`
	Arguments json.RawMessage        `json:"arguments"`
	Metadata  *localToolCallMetadata `json:"_meta,omitempty"`
}

type localToolCallMetadata struct {
	FullBrowserSnapshot bool `json:"linger/fullBrowserSnapshot"`
}

type fullBrowserSnapshotKey struct{}

func openToolServer(ctx context.Context, identity mcpproxy.OperationIdentity, tools []tool, call func(context.Context, string, json.RawMessage) (json.RawMessage, error), timeout time.Duration) (*toolServer, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s := &toolServer{path: "/mcp/" + rand.Text(), tools: tools, identity: identity, ctx: ctx, call: call, ready: make(chan struct{}), slots: make(chan struct{}, 16), calls: make(map[string]context.CancelFunc), timeout: timeout}
	s.url = "http://" + listener.Addr().String() + s.path
	s.server = &http.Server{Handler: http.HandlerFunc(s.handle), ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = s.server.Serve(listener) }()
	return s, nil
}

func (s *toolServer) waitReady(ctx context.Context) error {
	select {
	case <-s.ready:
		return nil
	case <-ctx.Done():
		return context.Cause(ctx)
	case <-s.ctx.Done():
		return context.Cause(s.ctx)
	}
}

func (s *toolServer) handle(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	if r.URL.EscapedPath() != s.path || r.Header.Get("Origin") != "" {
		http.Error(w, "Invalid local tool authority", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if s.ctx.Err() != nil {
		http.Error(w, "Operation is no longer active", http.StatusGone)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1024*1024+1))
	if err != nil || len(body) > 1024*1024 {
		http.Error(w, "Invalid local tool request", http.StatusBadRequest)
		return
	}
	var request struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Method  string          `json:"method"`
		Params  json.RawMessage `json:"params"`
	}
	if json.Unmarshal(body, &request) != nil || request.JSONRPC != "2.0" {
		http.Error(w, "Invalid MCP envelope", http.StatusBadRequest)
		return
	}
	if len(request.ID) == 0 {
		if request.Method == "notifications/cancelled" {
			var params struct {
				RequestID json.RawMessage `json:"requestId"`
			}
			if json.Unmarshal(request.Params, &params) == nil {
				s.callsMu.Lock()
				cancel := s.calls[string(bytes.TrimSpace(params.RequestID))]
				s.callsMu.Unlock()
				if cancel != nil {
					cancel()
				}
			}
		}
		w.WriteHeader(http.StatusAccepted)
		return
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		http.Error(w, "Too many local tool requests", http.StatusTooManyRequests)
		return
	}
	var result any
	startedTool := false
	switch request.Method {
	case "initialize":
		result = map[string]any{"protocolVersion": "2025-03-26", "capabilities": map[string]any{"tools": map[string]any{"listChanged": false}}, "serverInfo": map[string]string{"name": "linger-local-tools", "version": transport.ReleaseVersion}}
	case "ping":
		result = map[string]any{}
	case "tools/list":
		result = map[string]any{"tools": s.tools}
	case "tools/call":
		var params localToolCall
		if json.Unmarshal(request.Params, &params) != nil {
			err = errors.New("Invalid local tool arguments")
			break
		}
		if len(params.Arguments) == 0 {
			params.Arguments = json.RawMessage(`{}`)
		}
		var argumentObject map[string]json.RawMessage
		if json.Unmarshal(params.Arguments, &argumentObject) != nil || argumentObject == nil {
			err = errors.New("Local tool arguments must be an object")
			break
		}
		known := false
		for _, t := range s.tools {
			if t.Name == params.Name {
				known = true
				break
			}
		}
		if !known {
			err = errors.New("Local tool is not authorized")
			break
		}
		if s.identity.BeforeToolCall != nil {
			err = s.identity.BeforeToolCall()
			if err != nil {
				break
			}
		}
		budget, budgetErr := toolCallBudget(r, s.timeout)
		if budgetErr != nil {
			err = budgetErr
			break
		}
		ctx, cancel := context.WithDeadline(s.ctx, started.Add(budget))
		defer cancel()
		scheduling, stopScheduling := context.WithCancel(ctx)
		defer stopScheduling()
		stopRequest := context.AfterFunc(r.Context(), stopScheduling)
		defer stopRequest()
		if r.Context().Err() != nil {
			stopScheduling()
		}
		key := string(bytes.TrimSpace(request.ID))
		s.callsMu.Lock()
		if _, duplicate := s.calls[key]; duplicate {
			s.callsMu.Unlock()
			err = errors.New("Local tool request ID is already active")
			break
		}
		s.calls[key] = stopScheduling
		s.callsMu.Unlock()
		defer func() { s.callsMu.Lock(); delete(s.calls, key); s.callsMu.Unlock() }()
		ctx = context.WithValue(ctx, toolSchedulingKey{}, scheduling)
		if params.Metadata != nil && params.Metadata.FullBrowserSnapshot {
			ctx = context.WithValue(ctx, fullBrowserSnapshotKey{}, true)
		}
		if s.identity.BeforeRequest != nil {
			err = s.identity.BeforeRequest(scheduling)
			if err != nil {
				break
			}
		}
		if err = schedulingError(ctx); err != nil {
			break
		}
		startedTool = true
		result, err = s.call(ctx, params.Name, params.Arguments)
	default:
		err = errors.New("MCP method is unavailable")
	}
	if err != nil {
		result = toolError(err, startedTool)
	}
	encoded, encodeErr := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
	if encodeErr != nil || len(encoded) > maxMCPBytes {
		http.Error(w, "Local tool output exceeds its limit", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if _, writeErr := w.Write(encoded); writeErr == nil && request.Method == "tools/list" && err == nil {
		s.readyOnce.Do(func() { close(s.ready) })
	}
}

func toolError(err error, startedTool bool) json.RawMessage {
	outcome := "failed"
	switch {
	case !startedTool:
		outcome = "not_dispatched"
	case errors.Is(err, errOutcomeUnknown), errors.Is(err, errDriverStopped), errors.Is(err, mcpproxy.ErrCleanupUnconfirmed):
		outcome = "unknown"
	case errors.Is(err, errNotSent):
		outcome = "not_dispatched"
	}
	data, _ := json.Marshal(map[string]any{
		"isError":           true,
		"content":           []any{map[string]string{"type": "text", "text": err.Error()}},
		"structuredContent": map[string]string{"outcome": outcome},
	})
	return data
}

// Leave time for result serialization and transport before the Runtime gives up.
const toolResponseMargin = 5 * time.Second

type toolSchedulingKey struct{}

// schedulingContext stops new work on a caller cancellation. The supplied
// context still bounds already dispatched work by the Operation and deadline.
func schedulingContext(ctx context.Context) (context.Context, context.CancelFunc) {
	wait, cancel := context.WithCancel(ctx)
	if signal, ok := ctx.Value(toolSchedulingKey{}).(context.Context); ok {
		stop := context.AfterFunc(signal, cancel)
		if signal.Err() != nil {
			cancel()
		}
		return wait, func() { stop(); cancel() }
	}
	return wait, cancel
}

func schedulingError(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if signal, ok := ctx.Value(toolSchedulingKey{}).(context.Context); ok {
		return signal.Err()
	}
	return nil
}

func toolCallBudget(request *http.Request, budget time.Duration) (time.Duration, error) {
	if values := request.Header.Values("X-Linger-Tool-Budget-Ms"); len(values) > 0 {
		if len(values) != 1 {
			return 0, errors.New("Invalid local tool time budget")
		}
		milliseconds, err := strconv.ParseInt(values[0], 10, 64)
		if err != nil || milliseconds <= 0 {
			return 0, errors.New("Invalid local tool time budget")
		}
		budget = time.Duration(min(milliseconds, budget.Milliseconds())) * time.Millisecond
	}
	if budget <= toolResponseMargin {
		return 0, errors.New("Insufficient local tool response budget")
	}
	return budget - toolResponseMargin, nil
}
