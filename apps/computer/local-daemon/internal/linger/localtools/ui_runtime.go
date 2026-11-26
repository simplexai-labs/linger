package localtools

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/uiruntime"
)

const unifiedToolTimeout = 10 * time.Minute
const uiImageBudget = 12 * 1024 * 1024

// Leave enough time for a driver to act and return its receipt.
const minUIExecutionBudget = 3 * toolResponseMargin

type uiDispatchReceipt struct {
	Server string `json:"server"`
	Method string `json:"method"`
	Status string `json:"status"`
}

// uiExecution keeps script state for one Operation and execution lease.
type uiExecution struct {
	cancel    context.CancelFunc
	set       *mcpproxy.Set
	endpoints map[string]mcpproxy.ToolEndpoint
	catalogs  map[string][]tool
	engine    *uiruntime.Runtime
	server    *toolServer
	slot      chan struct{}
	closeOnce sync.Once
	closeErr  error
	sequence  uint64
	blocked   map[string]bool
	receipts  []uiDispatchReceipt
	// unknown keeps every unknown-outcome receipt for the Operation; a lost
	// response or a reset must not hide which action may have applied.
	unknown     []uiDispatchReceipt
	lastResults map[string]json.RawMessage
	images      map[string]json.RawMessage
	imageBytes  int
	generation  uint64
}

// BindUI runs after the local driver bindings have been installed.
// Those bindings remain privately owned by Set for authorization and cleanup.
func (m *Manager) BindUI(ctx context.Context, spec provider.OperationSpec, identity mcpproxy.OperationIdentity, set *mcpproxy.Set) error {
	endpoints := set.ComputerEndpoints()
	if len(endpoints) == 0 {
		return nil
	}
	if !filepath.IsAbs(m.options.NodePath) {
		return errors.New("managed UI JavaScript runtime is unavailable")
	}
	ctx, cancel := context.WithCancel(ctx)
	u := &uiExecution{cancel: cancel, set: set, endpoints: map[string]mcpproxy.ToolEndpoint{}, catalogs: map[string][]tool{}, slot: make(chan struct{}, 1), blocked: map[string]bool{}, images: map[string]json.RawMessage{}}
	for _, endpoint := range endpoints {
		if endpoint.Name != "computer" && endpoint.Name != "browser" {
			cancel()
			return errors.New("unexpected UI driver namespace")
		}
		u.endpoints[endpoint.Name] = endpoint
	}
	modules := filepath.Dir(filepath.Dir(filepath.Dir(m.options.PlaywrightEntry)))
	engine, err := uiruntime.New(ctx, uiruntime.Options{NodePath: m.options.NodePath, QuickJSDirectory: filepath.Join(modules, "quickjs-wasi"), Dispatch: u.dispatch, Limits: uiruntime.Limits{MaxWallTime: 9 * time.Minute}})
	if err != nil {
		cancel()
		return err
	}
	u.engine = engine
	server, err := openToolServer(ctx, identity, unifiedUITools(), u.call, unifiedToolTimeout)
	if err != nil {
		return errors.Join(err, u.close())
	}
	u.server = server
	if err = set.PrivatizeComputerTools(identity, spec.PermissionReview); err != nil {
		return errors.Join(err, u.close())
	}
	if err = set.AddLocal(mcpproxy.LocalBinding{Name: "computer", URL: server.url, ToolNames: []string{"ui_exec", "ui_reset"}, WaitReady: server.waitReady, Close: u.close, Timeout: unifiedToolTimeout}); err != nil {
		return errors.Join(err, u.close())
	}
	return nil
}

func unifiedUITools() []tool {
	return []tool{
		{
			Name: "ui_exec",
			Description: "Execute one async JavaScript body for the longest sequence you can determine from current UI evidence. Await each action, inspect its result, branch or loop in this same body, then return the verified outcome. " +
				"Return to the model for ambiguous choices, visual interpretation or missing information. Only state persists across executions; an uncaught script error resets it, so catch expected failures in the script. When the user specifies the next control, resolve it from the fresh observation and act immediately in this script. " +
				"For repeated stages, read changing values from each observation in JavaScript and continue in a bounded loop. Never paste a value from the last model turn when the current UI supplies it. On an unrecognized stage return its observation before writing. " +
				"Browser: const page=await ui.page(url); let v=await page.observe(); on resume omit the URL. Read v.text. Use v=await v.click(role,name), v=await v.type(role,name,text) or v=await v.select(role,name,[value]). " +
				"Fill several named controls from one observation with v=await v.fill([{type,name,value},...]); type is the control role, e.g. textbox or combobox. " +
				"Use ui.emit(ui.diff(before, after)) to replace the snapshot tree with its changes between two full observations of the same page and keep the newer result's other sections. " +
				"macOS: when the user names an app and window, discover and read it in one call: const r=await ui.computer.list_windows({app:appName}); const matches=r.structuredContent.windows.filter(w=>w.title===windowTitle); if(matches.length!==1)return r.structuredContent.windows; const w=matches[0]; let v=await ui.window(w.pid,w.window_id).observe(); use v.text for reads. " +
				"To act, v=await v.click('AXButton',name). Each named action returns the next observation. Use it for the next decision. Observe again for missing or changing state. " +
				"On recovery inspect existing field values first. Raw ui.browser and ui.computer methods return driver results. Use ui.emit(result) for images and ui.help(namespace) for unfamiliar methods. Never replay an unknown write. Each action retains its permission review.",
			InputSchema: schema(map[string]any{
				"code": map[string]any{"type": "string", "minLength": 1, "maxLength": 65536, "description": "Async JavaScript body. Put repeated decisions in a for loop: inspect v.text, stop on completion or ambiguity, derive values from that view, then assign each awaited action back to v. " +
					"Return the final observed state. Do not yield between known stages. Single-step tasks need no loop."},
				"timeout_ms": map[string]any{"type": "integer", "minimum": minUIExecutionBudget.Milliseconds(), "maximum": 540000},
			}, "code"),
		},
		{Name: "ui_reset", Description: "Discard this Operation's persistent JavaScript state and image handles. Does not close user apps, clear unknown action records, or replay actions. Re-read target state after resetting.", InputSchema: schema(map[string]any{})},
	}
}

func (u *uiExecution) call(ctx context.Context, name string, args json.RawMessage) (json.RawMessage, error) {
	if !u.set.ToolReviewerReady() {
		return nil, fmt.Errorf("UI action reviewer is not ready for this Operation: %w", errNotSent)
	}
	select {
	case u.slot <- struct{}{}:
		defer func() { <-u.slot }()
	default:
		return nil, fmt.Errorf("UI execution is busy; await the current call: %w", errNotSent)
	}
	if err := schedulingError(ctx); err != nil {
		return nil, err
	}
	if name == "ui_reset" {
		var empty struct{}
		if err := decodeUI(args, &empty); err != nil {
			return nil, err
		}
		if err := u.engine.Reset(ctx); err != nil {
			return nil, err
		}
		u.images = map[string]json.RawMessage{}
		u.imageBytes = 0
		return uiTextResult(map[string]any{"reset": true, "generation": u.engine.Generation(), "unknown_actions": u.unknown}), nil
	}
	if name != "ui_exec" {
		return nil, errors.New("unknown UI entry")
	}
	var input struct {
		Code      string `json:"code"`
		TimeoutMS *int64 `json:"timeout_ms"`
	}
	if err := decodeUI(args, &input); err != nil {
		return nil, err
	}
	if len(input.Code) == 0 || len(input.Code) > 65536 {
		return nil, errors.New("UI code must contain 1 to 65536 bytes")
	}
	budget := 165 * time.Second
	if input.TimeoutMS != nil {
		if *input.TimeoutMS < minUIExecutionBudget.Milliseconds() || *input.TimeoutMS > (9*time.Minute).Milliseconds() {
			return nil, errors.New("UI execution budget is outside the allowed range")
		}
		budget = time.Duration(*input.TimeoutMS) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	scheduling, stop := schedulingContext(ctx)
	defer stop()
	u.receipts = nil
	u.lastResults = map[string]json.RawMessage{}
	u.syncImageGeneration(u.engine.Generation())
	result, err := u.engine.Exec(ctx, scheduling, input.Code)
	defer func() { u.syncImageGeneration(u.engine.Generation()) }()
	summary := map[string]any{"generation": result.Generation, "value": result.Value, "receipts": u.receipts}
	if len(u.unknown) > 0 {
		summary["unknown_actions"] = u.unknown
	}
	if current := u.engine.Generation(); current != result.Generation {
		summary["state_reset"] = true
		summary["current_generation"] = current
	}
	if err != nil {
		summary["error"] = err.Error()
		summary["last_results"] = u.lastResults
	}
	content := []json.RawMessage{}
	expandedBytes := 0
	for _, output := range result.Output {
		parts, expandErr := u.expandOutput(output)
		for _, part := range parts {
			expandedBytes += len(part)
		}
		if expandedBytes > maxMCPBytes/2 {
			expandErr = errors.New("UI expanded output exceeds its byte limit")
		}
		if expandErr != nil {
			err = errors.Join(err, expandErr)
			summary["error"] = err.Error()
			break
		}
		content = append(content, parts...)
	}
	encoded, _ := json.Marshal(summary)
	text, _ := json.Marshal(map[string]string{"type": "text", "text": string(encoded)})
	content = append(content, text)
	return json.Marshal(map[string]any{"isError": err != nil, "content": content, "structuredContent": summary})
}

func decodeUI[T any](data []byte, result *T) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(result); err != nil {
		return err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("trailing UI protocol data")
	}
	return nil
}

func uiTextResult(value any) json.RawMessage {
	encoded, _ := json.Marshal(value)
	result, _ := json.Marshal(map[string]any{"content": []any{map[string]string{"type": "text", "text": string(encoded)}}, "structuredContent": value})
	return result
}

func (u *uiExecution) dispatch(ctx context.Context, call uiruntime.Call) (json.RawMessage, error) {
	u.syncImageGeneration(call.Generation)
	if err := schedulingError(ctx); err != nil {
		return nil, err
	}
	if call.Namespace == "help" {
		return u.help(ctx, call.Method)
	}
	endpoint, ok := u.endpoints[call.Namespace]
	if !ok {
		return nil, errors.New("UI namespace is unavailable; call ui.help()")
	}
	methods, err := u.catalog(ctx, endpoint)
	if err != nil {
		return nil, err
	}
	name := call.Method
	if call.Namespace == "browser" {
		name = "browser_" + name
	}
	found := false
	for _, method := range methods {
		if method.Name == name {
			found = true
			break
		}
	}
	if !found {
		return nil, errors.New("UI method is unavailable; read this namespace's help")
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(call.Arguments, &object) != nil || object == nil {
		return nil, errors.New("UI method arguments must be an object")
	}
	fullName := "mcp__" + endpoint.Name + "__" + name
	write := !permission.ReadOnlyLocalTool(fullName, string(call.Arguments))
	if write && u.blocked[endpoint.Name] {
		return nil, errors.New("UI action outcome is unknown; this Operation cannot send further writes to this server")
	}
	if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) <= 2*toolResponseMargin {
		return nil, errors.New("UI action was not dispatched: insufficient response budget")
	}
	receipt := uiDispatchReceipt{Server: endpoint.Name, Method: name, Status: "not_dispatched"}
	u.receipts = append(u.receipts, receipt)
	index := len(u.receipts) - 1
	wait, stop := schedulingContext(ctx)
	err = u.set.ReviewTool(wait, endpoint.Name, name, call.Arguments)
	stop()
	if err != nil {
		return nil, err
	}
	if err = schedulingError(ctx); err != nil {
		return nil, err
	}
	if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) <= 2*toolResponseMargin {
		return nil, errors.New("UI action was not dispatched: permission review exhausted the response budget")
	}
	u.receipts[index].Status = "dispatched"
	result, err := u.rpc(ctx, endpoint, "tools/call", map[string]any{"name": name, "arguments": call.Arguments})
	if err != nil {
		if errors.Is(err, errNotSent) {
			u.receipts[index].Status = "not_dispatched"
			return nil, err
		}
		u.markUnknown(index, write)
		return nil, fmt.Errorf("UI tool outcome is unknown; do not replay: %w", err)
	}
	var envelope struct {
		IsError bool `json:"isError"`
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
		Structured json.RawMessage `json:"structuredContent"`
	}
	if json.Unmarshal(result, &envelope) != nil || envelope.Content == nil {
		u.markUnknown(index, write)
		return nil, errors.New("UI tool returned an invalid result; outcome unknown")
	}
	var structured struct {
		Outcome string `json:"outcome"`
	}
	_ = json.Unmarshal(envelope.Structured, &structured)
	if structured.Outcome == "unknown" {
		u.markUnknown(index, write)
		return nil, errors.New("UI tool outcome is unknown; inspect the current state")
	}
	if envelope.IsError {
		u.receipts[index].Status = "failed"
		if structured.Outcome == "not_dispatched" {
			u.receipts[index].Status = "not_dispatched"
		}
		var message strings.Builder
		for _, c := range envelope.Content {
			message.WriteString(c.Text)
			message.WriteByte('\n')
		}
		text := message.String()
		if len(text) > 4000 {
			text = text[:4000]
		}
		return nil, fmt.Errorf("UI tool failed: %s", text)
	}
	u.receipts[index].Status = "confirmed"
	delete(u.lastResults, endpoint.Name)
	retained, err := u.retainImages(result)
	if err == nil && len(retained) <= 262144 {
		u.lastResults[endpoint.Name] = retained
	}
	return retained, err
}

func (u *uiExecution) markUnknown(index int, write bool) {
	u.receipts[index].Status = "unknown"
	u.unknown = append(u.unknown, u.receipts[index])
	if write {
		u.blocked[u.receipts[index].Server] = true
	}
}

func (u *uiExecution) syncImageGeneration(generation uint64) {
	if generation == u.generation {
		return
	}
	u.generation = generation
	u.images = map[string]json.RawMessage{}
	u.imageBytes = 0
}

func (u *uiExecution) help(ctx context.Context, topic string) (json.RawMessage, error) {
	if topic == "" {
		var namespaces []string
		for _, name := range []string{"computer", "browser"} {
			if _, ok := u.endpoints[name]; ok {
				namespaces = append(namespaces, name)
			}
		}
		return json.Marshal(map[string]any{"namespaces": namespaces, "state": "Only state persists. Await each method. Use ui.emit(result) for native images and selected output. Read namespace help for unfamiliar methods. Methods return original MCP content and optional structuredContent. Errors throw; unknown effects cannot be retried.", "scope": "This Operation and execution lease only; resets invalidate state and image handles."})
	}
	endpoint, ok := u.endpoints[topic]
	if !ok {
		return nil, errors.New("help topic must be computer or browser")
	}
	methods, err := u.catalog(ctx, endpoint)
	if err != nil {
		return nil, err
	}
	listed := append([]tool(nil), methods...)
	help := map[string]any{"namespace": topic, "methods": listed}
	if topic == "browser" {
		for i := range listed {
			listed[i].Name = strings.TrimPrefix(listed[i].Name, "browser_")
		}
		help["helpers"] = map[string]string{
			"ui.diff(prev, next)": "Compare two whole-page observations of the same browser document. Accepts browser results, page views or snapshot text. Use ui.emit(ui.diff(prev, next)) to replace the newer snapshot tree with its changes. If comparison is unavailable, the newer result is returned with a reason.",
		}
	}
	return json.Marshal(help)
}

func (u *uiExecution) catalog(ctx context.Context, endpoint mcpproxy.ToolEndpoint) ([]tool, error) {
	if methods, ok := u.catalogs[endpoint.Name]; ok {
		return methods, nil
	}
	wait, stop := schedulingContext(ctx)
	defer stop()
	wait, cancel := context.WithTimeout(wait, 10*time.Second)
	defer cancel()
	raw, err := u.rpc(wait, endpoint, "tools/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var result struct {
		Tools []tool `json:"tools"`
	}
	if json.Unmarshal(raw, &result) != nil || result.Tools == nil {
		return nil, errors.New("UI driver catalog is unavailable")
	}
	for _, method := range result.Tools {
		if method.Name == "browser_run_code_unsafe" || method.Name == "ui_exec" || method.Name == "ui_reset" {
			return nil, errors.New("unexpected UI driver capability")
		}
	}
	u.catalogs[endpoint.Name] = result.Tools
	return result.Tools, nil
}

func (u *uiExecution) rpc(ctx context.Context, endpoint mcpproxy.ToolEndpoint, method string, params any) (json.RawMessage, error) {
	u.sequence++
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": u.sequence, "method": method, "params": params})
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.URL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	if deadline, ok := ctx.Deadline(); ok {
		budget := time.Until(deadline) - time.Second
		if budget <= toolResponseMargin {
			return nil, fmt.Errorf("%w: response budget exhausted", errNotSent)
		}
		request.Header.Set("X-Linger-Tool-Budget-Ms", strconv.FormatInt(budget.Milliseconds(), 10))
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		if opErr := (*net.OpError)(nil); errors.As(err, &opErr) && opErr.Op == "dial" {
			return nil, fmt.Errorf("local UI server is unreachable: %w: %w", err, errNotSent)
		}
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusTooManyRequests || response.StatusCode == http.StatusGone {
		return nil, fmt.Errorf("local UI server refused admission (%d): %w", response.StatusCode, errNotSent)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxMCPBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxMCPBytes || response.StatusCode != http.StatusOK {
		return nil, errors.New("UI driver response is unavailable or exceeds its limit")
	}
	var envelope struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      uint64          `json:"id"`
		Result  json.RawMessage `json:"result"`
		Error   json.RawMessage `json:"error"`
	}
	if json.Unmarshal(data, &envelope) != nil || envelope.JSONRPC != "2.0" || envelope.ID != u.sequence || len(envelope.Error) > 0 || len(envelope.Result) == 0 {
		return nil, errors.New("invalid UI driver response")
	}
	return envelope.Result, nil
}

func (u *uiExecution) retainImages(raw json.RawMessage) (json.RawMessage, error) {
	var result map[string]json.RawMessage
	if json.Unmarshal(raw, &result) != nil {
		return nil, errors.New("invalid UI result")
	}
	var content []json.RawMessage
	if len(result["content"]) == 0 {
		return raw, nil
	}
	if err := json.Unmarshal(result["content"], &content); err != nil {
		return nil, err
	}
	for i, part := range content {
		var kind struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(part, &kind) != nil {
			return nil, errors.New("invalid UI content")
		}
		if kind.Type != "image" {
			continue
		}
		if u.imageBytes+len(part) > uiImageBudget {
			// The action already completed, so an error here would invite a replay.
			content[i], _ = json.Marshal(map[string]string{"type": "text", "text": "Image omitted: the UI image budget is exhausted. Call ui_reset to capture more images."})
			continue
		}
		id := rand.Text()
		u.images[id] = part
		u.imageBytes += len(part)
		content[i], _ = json.Marshal(map[string]string{"type": "image", "image_id": id})
	}
	result["content"], _ = json.Marshal(content)
	return json.Marshal(result)
}

func (u *uiExecution) expandOutput(raw json.RawMessage) ([]json.RawMessage, error) {
	return u.expandContent(raw, 0)
}

func (u *uiExecution) expandContent(raw json.RawMessage, depth int) ([]json.RawMessage, error) {
	if depth > 1 {
		return nil, errors.New("UI content envelopes cannot be nested")
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		part, _ := json.Marshal(map[string]string{"type": "text", "text": text})
		return []json.RawMessage{part}, nil
	}
	var object struct {
		Type    string            `json:"type"`
		ImageID string            `json:"image_id"`
		Content []json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &object) != nil {
		part, _ := json.Marshal(map[string]string{"type": "text", "text": string(raw)})
		return []json.RawMessage{part}, nil //nolint:nilerr // Non-object values are represented as text.
	}
	if object.Type == "image" {
		part, ok := u.images[object.ImageID]
		if !ok {
			return nil, errors.New("UI image handle is stale or unavailable")
		}
		return []json.RawMessage{part}, nil
	}
	if object.Content != nil {
		var out []json.RawMessage
		for _, c := range object.Content {
			parts, err := u.expandContent(c, depth+1)
			if err != nil {
				return nil, err
			}
			out = append(out, parts...)
		}
		return out, nil
	}
	if object.Type == "text" || object.Type == "resource_link" || object.Type == "resource" {
		return []json.RawMessage{raw}, nil
	}
	part, _ := json.Marshal(map[string]string{"type": "text", "text": string(raw)})
	return []json.RawMessage{part}, nil
}

func (u *uiExecution) close() error {
	u.closeOnce.Do(func() {
		u.cancel()
		if u.server != nil {
			_ = u.server.server.Close()
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := u.engine.Close(ctx); err != nil {
			u.closeErr = errors.Join(mcpproxy.ErrCleanupUnconfirmed, err)
		}
	})
	return u.closeErr
}
