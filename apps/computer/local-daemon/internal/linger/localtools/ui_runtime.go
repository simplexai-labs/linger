package localtools

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
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
	// driverFailed records that a driver call of this execution failed.
	driverFailed bool
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
				"Return to the model for ambiguous choices, visual interpretation or missing information. Only properties of the global state object persist across ui_exec calls; keep plain data there, such as ids and text (state.pid=w.pid), never a view, which works only in the call that made it. Local variables such as v do not persist, and state itself cannot be reassigned. An uncaught script error resets state, so catch expected failures in the script. When the user specifies the next control, resolve it from the fresh observation and act immediately in this script. " +
				"For repeated stages, read changing values from each observation in JavaScript and continue in a bounded loop. Never paste a value from the last model turn when the current UI supplies it. On an unrecognized stage return its observation before writing. " +
				"Browser: let v=await ui.page(url) opens the page and returns its observation; v=await ui.page() or v=await v.observe() reads the current page again. Read v.text. Use v=await v.click(role,name), v=await v.type(role,name,text) or v=await v.select(role,name,[value]). " +
				"Fill several named controls from one observation with v=await v.fill([{type,name,value},...]); type is the control role, e.g. textbox or combobox. " +
				"macOS and Windows: when the user names an app and window, discover and read it in one call: const r=await ui.computer.list_windows({app:appName}); const matches=r.structuredContent.windows.filter(w=>w.title===windowTitle); if(matches.length!==1)return r.structuredContent.windows; const w=matches[0]; let v=await ui.window(w.pid,w.window_id).observe(); use v.text for reads. " +
				"To act, pass the role and name exactly as shown in v.text: v=await v.click(role,name). Each named action returns the next observation. Use it for the next decision. Observe again for missing or changing state. " +
				"To see a window, return await ui.computer.get_window_state({pid,window_id,include_screenshot:true}): a returned or emitted screenshot reaches you in this same call. A confirmed click only means the driver sent it, so after a click by coordinates return the next screenshot and check for the change you expected. If nothing changed, read the window again and click from that fresh screenshot before trying another route, and report what the screen shows when the control still does not respond. " +
				"On recovery inspect existing field values first. Raw ui.browser and ui.computer methods return driver results. Use ui.emit(result) to choose which images and text to return, console.log for notes and ui.help('computer'), ui.help('browser'), or ui.help() for unfamiliar methods. Never replay an unknown write. Linger reviews each action before it runs.",
			InputSchema: schema(map[string]any{
				"code": map[string]any{"type": "string", "minLength": 1, "maxLength": 65536, "description": "Async JavaScript body. Put repeated decisions in a for loop: inspect v.text, stop on completion or ambiguity, derive values from that view, then assign each awaited action back to v. " +
					"Return what you read, e.g. return v.text. Do not yield between known stages. Single-step tasks need no loop."},
				"timeout_ms": map[string]any{"type": "integer", "minimum": minUIExecutionBudget.Milliseconds(), "maximum": 540000},
			}, "code"),
		},
		{Name: "ui_reset", Description: "Discard this Operation's persistent JavaScript state and image handles. Call it only after an image-budget note or when state holds values you no longer trust; it is not a finish step, so when the task is done answer the user without it. Does not close user apps, clear unknown action records, or replay actions. Re-read target state after resetting.", InputSchema: schema(map[string]any{})},
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
	u.driverFailed = false
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
		// A failed driver call carries its own code, such as a missing
		// permission; only a failure of the script itself gets this hint.
		if !u.driverFailed {
			summary["hint"] = "The script threw, so fix the script: a JavaScript error is neither a macOS permission problem nor a site block. Receipts with status confirmed happened; do not repeat them. last_results holds each namespace's latest driver result, not the cause of the error."
		}
	}
	content := []json.RawMessage{}
	expandedBytes := 0
	hasImage := false
	expand := func(outputs []json.RawMessage) bool {
		for _, output := range outputs {
			var outputHasImage bool
			parts, expandErr := u.expandContent(output, 0, &outputHasImage)
			for _, part := range parts {
				expandedBytes += len(part)
			}
			if expandedBytes > maxMCPBytes/2 {
				expandErr = errors.New("UI expanded output exceeds its byte limit")
			}
			if expandErr != nil {
				err = errors.Join(err, expandErr)
				summary["error"] = err.Error()
				return false
			}
			content = append(content, parts...)
			hasImage = hasImage || outputHasImage
		}
		return true
	}
	// Notes and emitted text do not stand in for a returned screenshot: when
	// the script selected no image, the ones in its returned observation go.
	if expand(result.Output) && !hasImage {
		expand(u.returnedImages(result.Value))
	}
	// A returned string, usually page text, reads poorly once escaped inside
	// the summary JSON, so the model gets it verbatim and the summary omits it.
	shown := summary
	var value string
	if bytes.HasPrefix(result.Value, []byte(`"`)) && json.Unmarshal(result.Value, &value) == nil {
		plain, _ := json.Marshal(map[string]string{"type": "text", "text": value})
		content = append(content, plain)
		shown = maps.Clone(summary)
		shown["value"] = "returned text shown above"
	}
	encoded, _ := json.Marshal(shown)
	text, _ := json.Marshal(map[string]string{"type": "text", "text": string(encoded)})
	content = append(content, text)
	reply := map[string]any{"isError": err != nil, "content": content}
	// Codex gives the model structuredContent in place of content, which
	// drops the image parts. The last text part carries the same summary.
	if !hasImage {
		reply["structuredContent"] = summary
	}
	return json.Marshal(reply)
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

func (u *uiExecution) dispatch(ctx context.Context, call uiruntime.Call) (output json.RawMessage, err error) {
	defer func() {
		if err != nil {
			u.driverFailed = true
		}
	}()
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

func (u *uiExecution) availableNamespaces() []string {
	var namespaces []string
	for _, name := range []string{"computer", "browser"} {
		if _, ok := u.endpoints[name]; ok {
			namespaces = append(namespaces, name)
		}
	}
	return namespaces
}

func (u *uiExecution) help(ctx context.Context, topic string) (json.RawMessage, error) {
	if topic == "" {
		return json.Marshal(map[string]any{"namespaces": u.availableNamespaces(), "state": "Only properties of the global state object persist across calls. Await each method. Use ui.emit(result) for native images and selected output. Read namespace help for unfamiliar methods. Methods return original MCP content and optional structuredContent. Errors throw; unknown effects cannot be retried.", "scope": "This Operation and execution lease only; resets invalidate state and image handles."})
	}
	endpoint, ok := u.endpoints[topic]
	if !ok {
		calls := []string{"ui.help()"}
		for _, name := range u.availableNamespaces() {
			calls = append(calls, fmt.Sprintf("ui.help(%q)", name))
		}
		var hint string
		switch len(calls) {
		case 1:
			hint = calls[0]
		case 2:
			hint = calls[0] + " or " + calls[1]
		default:
			hint = strings.Join(calls[:len(calls)-1], ", ") + ", or " + calls[len(calls)-1]
		}
		return nil, fmt.Errorf("help topic %q is invalid; call %s", topic, hint)
	}
	methods, err := u.catalog(ctx, endpoint)
	if err != nil {
		return nil, err
	}
	listed := append([]tool(nil), methods...)
	for i := range listed {
		if topic == "browser" {
			listed[i].Name = strings.TrimPrefix(listed[i].Name, "browser_")
		}
	}
	return json.Marshal(map[string]any{"namespace": topic, "methods": listed})
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

// returnedImages selects the screenshots of a driver observation the script
// returned without emitting anything, so returning a view shows it to the
// model. The observation itself stays in the summary's value.
func (u *uiExecution) returnedImages(value json.RawMessage) []json.RawMessage {
	var observation struct {
		Content []json.RawMessage `json:"content"`
	}
	if json.Unmarshal(value, &observation) != nil {
		return nil
	}
	parts := observation.Content
	if parts == nil {
		parts = []json.RawMessage{value}
	}
	var images []json.RawMessage
	for _, part := range parts {
		var handle struct {
			Type    string `json:"type"`
			ImageID string `json:"image_id"`
		}
		if json.Unmarshal(part, &handle) == nil && handle.Type == "image" && u.images[handle.ImageID] != nil {
			images = append(images, part)
		}
	}
	return images
}

func (u *uiExecution) expandContent(raw json.RawMessage, depth int, hasImage *bool) ([]json.RawMessage, error) {
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
		*hasImage = true
		return []json.RawMessage{part}, nil
	}
	if object.Content != nil {
		var out []json.RawMessage
		for _, c := range object.Content {
			parts, err := u.expandContent(c, depth+1, hasImage)
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
