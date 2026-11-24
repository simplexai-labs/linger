package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/localmodels"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

// modelInvokeLogReasonLimit keeps a failed call's log line short; the full
// receipt reason still goes to the Agent Service.
const modelInvokeLogReasonLimit = 300

// serviceFeatureModelInvokeOutcomes in runner.welcome's service_features says
// the Agent Service accepts context_too_long and unsupported outcomes on
// executed model_invoke. Older services close the connection on them.
const serviceFeatureModelInvokeOutcomes = "model_invoke_outcomes"

// ModelInvoker runs one execute model_invoke on a local Runtime.
type ModelInvoker interface {
	Invoke(ctx context.Context, request provider.ModelInvokeRequest) provider.ModelInvokeResult
	// Close stops the processes it keeps between calls.
	Close()
}

// modelInvoke is the Daemon's record of one in-flight model invocation. It has no
// Context, takes no Operation slot and is never written to the ledger: a lost
// connection or a drain kills its process and nobody replays it.
type modelInvoke struct {
	id     string
	cancel context.CancelFunc
}

type modelInvokeRequest struct {
	InvokeID        string                     `json:"invoke_id"`
	Model           string                     `json:"model"`
	Mode            string                     `json:"mode"`
	ReasoningEffort string                     `json:"reasoning_effort"`
	Instructions    string                     `json:"instructions"`
	Input           string                     `json:"input"`
	OutputSchema    json.RawMessage            `json:"output_schema"`
	WorkspaceFiles  []provider.ModelInvokeFile `json:"workspace_files"`
	TimeoutMS       int64                      `json:"timeout_ms"`
	MaxOutputChars  int                        `json:"max_output_chars"`
	SessionKey      string                     `json:"session_key"`
}

// handleModelInvoke admits one model call and runs it off the receive loop.
// The Agent Service's model scheduler decides how many run at once; a call the
// Daemon refuses is answered at once and nothing is queued.
func (d *Daemon) handleModelInvoke(ctx context.Context, stream transport.Stream, command protocol.Command) error {
	var request modelInvokeRequest
	if err := json.Unmarshal(command.Payload, &request); err != nil {
		return fmt.Errorf("decode model invocation: %w", err)
	}
	if request.InvokeID == "" {
		return errors.New("model invocation is incomplete")
	}
	receivedAt := time.Now()
	slog.Info("runner.model.invoke", "phase", "received", "invoke_id", request.InvokeID,
		"agent_id", command.AgentID, "runtime_type", command.RuntimeType, "model", request.Model, "mode", request.Mode)
	d.admissionMu.Lock()
	result := d.modelInvokeBlocked(command, request)
	var entry *modelInvoke
	var invokeCtx context.Context
	if result.Outcome == "" {
		d.modelInvokeMu.Lock()
		if d.modelInvokes[request.InvokeID] != nil {
			result = provider.ModelInvokeResult{Outcome: provider.ModelInvokeFailed, Reason: "Model invocation is already running"}
		} else {
			var cancel context.CancelFunc
			invokeCtx, cancel = context.WithCancel(ctx)
			entry = &modelInvoke{id: request.InvokeID, cancel: cancel}
			d.modelInvokes[request.InvokeID] = entry
		}
		d.modelInvokeMu.Unlock()
	}
	d.admissionMu.Unlock()
	if entry == nil {
		return d.sendModelInvoked(ctx, stream, command, request.InvokeID, result, time.Since(receivedAt))
	}
	d.preparationWG.Add(1)
	go func() {
		defer d.preparationWG.Done()
		d.runModelInvoke(invokeCtx, stream, command, request, entry, receivedAt)
	}()
	return nil
}

// modelInvokeBlocked returns the outcome for a call the Daemon must refuse, or
// an empty result. The caller holds admissionMu.
func (d *Daemon) modelInvokeBlocked(command protocol.Command, request modelInvokeRequest) provider.ModelInvokeResult {
	if d.draining {
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeUnavailable, Reason: "Local Computer Daemon is draining"}
	}
	d.activeMu.Lock()
	stopped := d.locallyStopped[command.AgentID]
	d.activeMu.Unlock()
	if stopped {
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeUnavailable, Reason: "Agent Runner is locally stopped"}
	}
	if d.runtimeCleanupUnconfirmed(command.RuntimeType) {
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeRuntimeUnavailable, Reason: cleanupUnconfirmedMessage}
	}
	if d.modelInvoker == nil {
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeRuntimeUnavailable, Reason: "Model invocation is unavailable"}
	}
	if request.Model == "" && d.modelInvokeUnready != nil && d.modelInvokeUnready(command.RuntimeType) {
		// Pi lists the Computer's downloaded local models so a Run or model
		// call that names one can load it, but a legacy call that names no
		// model cannot run when none is loaded.
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeRuntimeUnavailable, Reason: "The Runtime has no loaded model"}
	}
	if reason := invalidModelInvokeRequest(request); reason != "" {
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeFailed, Reason: reason}
	}
	return provider.ModelInvokeResult{}
}

// invalidModelInvokeRequest restates the schema's cross-field rules so a call
// the Agent should never send fails instead of running.
func invalidModelInvokeRequest(request modelInvokeRequest) string {
	switch request.ReasoningEffort {
	case "low", "medium", "high":
	default:
		return "Model invocation reasoning effort is invalid"
	}
	switch request.Mode {
	case provider.ModelInvokeStructured:
		var schema map[string]any
		if json.Unmarshal(request.OutputSchema, &schema) != nil || schema == nil {
			return "Structured model invocation requires an output schema"
		}
	case provider.ModelInvokeText:
	case provider.ModelInvokeWorkspace:
	default:
		return "Model invocation mode is invalid"
	}
	if request.Mode != provider.ModelInvokeWorkspace && len(request.WorkspaceFiles) != 0 {
		return "Only workspace model invocations carry files"
	}
	if request.Input == "" {
		return "Model invocation input is empty"
	}
	return ""
}

func (d *Daemon) runModelInvoke(ctx context.Context, stream transport.Stream, command protocol.Command, request modelInvokeRequest, entry *modelInvoke, receivedAt time.Time) {
	slog.Info("runner.model.invoke", "phase", "started", "invoke_id", entry.id)
	var result provider.ModelInvokeResult
	if failureCode, err := d.ensureModelGateway(ctx, command.RuntimeType); err != nil {
		result = modelGatewayInvokeFailure(ctx, failureCode, err)
	} else if failureCode, err := d.ensureLocalModel(ctx, command.RuntimeType, request.Model); err != nil {
		result = localModelInvokeFailure(ctx, failureCode, err)
	} else {
		effort := d.normalizeModelInvokeEffort(command.RuntimeType, request.Model, request.ReasoningEffort)
		result = d.modelInvoker.Invoke(ctx, provider.ModelInvokeRequest{
			RuntimeType: command.RuntimeType, Model: request.Model, Mode: request.Mode, ReasoningEffort: effort,
			Instructions: request.Instructions, Input: request.Input, OutputSchema: request.OutputSchema,
			WorkspaceFiles: request.WorkspaceFiles, Timeout: time.Duration(request.TimeoutMS) * time.Millisecond,
			SessionKey: request.SessionKey, MaxOutputChars: request.MaxOutputChars,
		})
		result = d.networkUnavailableModelInvoke(ctx, entry.id, command.RuntimeType, request.Model, result)
	}
	entry.cancel()
	d.modelInvokeMu.Lock()
	if d.modelInvokes[entry.id] == entry {
		delete(d.modelInvokes, entry.id)
	}
	d.modelInvokeMu.Unlock()
	if err := d.sendModelInvoked(context.WithoutCancel(ctx), stream, command, entry.id, result, time.Since(receivedAt)); err != nil {
		slog.Debug("runner.model.invoke receipt unavailable", "invoke_id", entry.id)
	}
}

// localModelInvokeFailure answers a Pi model call whose library model could
// not be loaded, matching ensureLocalModel on a Run.
func localModelInvokeFailure(ctx context.Context, _ string, err error) provider.ModelInvokeResult {
	if ctx.Err() != nil {
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeCanceled, Reason: "Model invocation was canceled"}
	}
	reason := "The local model could not be loaded"
	var loadErr *localmodels.LocalModelLoadError
	if errors.As(err, &loadErr) && loadErr.Code != "" {
		reason += " (" + loadErr.Code + ")"
	}
	return provider.ModelInvokeResult{Outcome: provider.ModelInvokeRuntimeUnavailable, Reason: reason}
}

// modelGatewayInvokeFailure answers a model call whose Runtime's gateway
// could not be mounted. When the tool could not reach the endpoint or the
// network, the call is unavailable, so the caller waits for this Computer as
// it does for a disconnected one; otherwise the Computer is online, its
// Runtime cannot run the call, and the reason names the tool's code.
func modelGatewayInvokeFailure(ctx context.Context, failureCode string, err error) provider.ModelInvokeResult {
	if ctx.Err() != nil {
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeCanceled, Reason: "Model invocation was canceled"}
	}
	reason := "The model gateway could not be started"
	var sourceErr *localmodels.ModelSourceError
	if errors.As(err, &sourceErr) {
		reason += " (" + sourceErr.Code + ")"
	}
	switch failureCode {
	case "authentication_required":
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeAuthRequired, Reason: reason}
	case "network_error":
		return provider.ModelInvokeResult{Outcome: provider.ModelInvokeUnavailable, Reason: reason}
	}
	return provider.ModelInvokeResult{Outcome: provider.ModelInvokeRuntimeUnavailable, Reason: reason}
}

// normalizeModelInvokeEffort clamps requested reasoning effort for Codex and
// Claude against the requested model (falling back to the Runtime's discovered
// default model when omitted). Pi clamps live from its own get_state model
// metadata inside InvokePiModel.
func (d *Daemon) normalizeModelInvokeEffort(runtimeType, requestedModel, requested string) string {
	if runtimeType != "codex" && runtimeType != "claude" {
		return requested
	}
	d.inventoryMu.RLock()
	raw := append(json.RawMessage(nil), d.runtimeDiagnostics...)
	d.inventoryMu.RUnlock()
	if len(raw) == 0 {
		return requested
	}
	var diagnostics []provider.RuntimeDiagnostic
	if json.Unmarshal(raw, &diagnostics) != nil {
		return requested
	}
	for _, diag := range diagnostics {
		if diag.Type != runtimeType {
			continue
		}
		model, ok := runtimeModelForEffort(diag.Models, requestedModel)
		if !ok || len(model.AllowedReasoningEffort) == 0 {
			return requested
		}
		allowed := filterModelInvokeEfforts(runtimeType, model.AllowedReasoningEffort)
		if len(allowed) == 0 {
			return requested
		}
		normalized := native.NormalizeReasoningEffort(requested, allowed, model.DefaultReasoningEffort)
		if normalized != requested {
			slog.Info("runner.model.invoke.effort_normalized", "runtime_type", runtimeType,
				"model", model.ID, "requested", requested, "normalized", normalized)
		}
		return normalized
	}
	return requested
}

func runtimeModelForEffort(models []provider.RuntimeModel, requestedModel string) (provider.RuntimeModel, bool) {
	if requestedModel != "" {
		for _, model := range models {
			if model.ID == requestedModel {
				return model, true
			}
		}
	}
	return defaultRuntimeModel(models)
}

func filterModelInvokeEfforts(runtimeType string, efforts []string) []string {
	supported := make([]string, 0, len(efforts))
	for _, raw := range efforts {
		value := strings.ToLower(strings.TrimSpace(raw))
		if validModelInvokeEffort(runtimeType, value) {
			supported = append(supported, value)
		}
	}
	return supported
}

func validModelInvokeEffort(runtimeType, effort string) bool {
	switch runtimeType {
	case "claude":
		switch effort {
		case "none", "low", "medium", "high", "xhigh", "max":
			return true
		}
	case "codex":
		switch effort {
		case "none", "minimal", "low", "medium", "high", "xhigh":
			return true
		}
	}
	return false
}

func defaultRuntimeModel(models []provider.RuntimeModel) (provider.RuntimeModel, bool) {
	for _, model := range models {
		if model.IsDefault {
			return model, true
		}
	}
	if len(models) == 1 {
		return models[0], true
	}
	return provider.RuntimeModel{}, false
}

// cancelModelInvoke cancels one in-flight model call; its canceled receipt
// follows unless it finished first. A call that is not running is already
// answered, so the cancel does nothing.
func (d *Daemon) cancelModelInvoke(command protocol.Command) error {
	var cancel wire.ModelInvokeCancel
	if err := json.Unmarshal(command.Payload, &cancel); err != nil {
		return fmt.Errorf("decode model invocation cancel: %w", err)
	}
	if cancel.InvokeID == "" {
		return errors.New("model invocation cancel is incomplete")
	}
	d.modelInvokeMu.Lock()
	defer d.modelInvokeMu.Unlock()
	entry := d.modelInvokes[cancel.InvokeID]
	if entry == nil {
		slog.Info("runner.model.invoke", "phase", "cancel_ignored", "invoke_id", cancel.InvokeID, "cancellation_source", cancel.Reason)
		return nil
	}
	entry.cancel()
	slog.Info("runner.model.invoke", "phase", "cancel_requested", "invoke_id", entry.id, "cancellation_source", cancel.Reason)
	return nil
}

// cancelModelInvokes cancels every in-flight model call; each still sends its
// canceled receipt if the connection is open.
func (d *Daemon) cancelModelInvokes(source string) {
	d.modelInvokeMu.Lock()
	defer d.modelInvokeMu.Unlock()
	for _, entry := range d.modelInvokes {
		entry.cancel()
		slog.Info("runner.model.invoke", "phase", "cancel_requested", "invoke_id", entry.id, "cancellation_source", source)
	}
}

func (d *Daemon) sendModelInvoked(ctx context.Context, stream transport.Stream, command protocol.Command, invokeID string, result provider.ModelInvokeResult, duration time.Duration) error {
	outcome := result.Outcome
	if !d.modelInvokeOutcomes.Load() {
		switch outcome {
		case provider.ModelInvokeContextTooLong:
			outcome = provider.ModelInvokeFailed
		case provider.ModelInvokeUnsupported:
			outcome = provider.ModelInvokeRuntimeUnavailable
		}
	}
	payload := map[string]any{
		"type": wire.TypeExecuted, "kind": wire.KindModelInvoke, "command_id": command.CommandID, "runner_id": command.RunnerID,
		"invoke_id": invokeID, "outcome": outcome, "duration_ms": duration.Milliseconds(),
	}
	// The Gateway closes the connection on a frame its schema rejects, so
	// optional fields are sent only when they fit it.
	// A session call that stopped early carries what it streamed so far.
	if outcome != provider.ModelInvokeCompleted && result.Text != "" {
		payload["text"] = result.Text
	}
	if outcome == provider.ModelInvokeCompleted {
		payload["text"] = result.Text
		if result.WorkspaceFiles != nil {
			payload["workspace_files"] = result.WorkspaceFiles
		}
		if result.Usage != nil {
			payload["usage"] = result.Usage
		}
	}
	if result.Model != "" && len(result.Model) <= 200 {
		payload["model"] = result.Model
	}
	if result.RuntimeVersion != "" && len(result.RuntimeVersion) <= 128 {
		payload["runtime_version"] = result.RuntimeVersion
	}
	if reason := receiptReason(redact.Text(result.Reason)); reason != "" && outcome != provider.ModelInvokeCompleted {
		payload["reason"] = reason
	}
	encoded := mustJSON(payload)
	if len(encoded) > transport.MaxFrameBytes {
		// JSON escaping and base64 can push a reply that is within the text
		// and tree bounds past the frame limit, and an oversized frame would
		// close the connection for every other Operation on it.
		slog.Warn("runner.model.invoke", "phase", "reply_oversized", "invoke_id", invokeID, "frame_bytes", len(encoded))
		for _, field := range []string{"text", "workspace_files", "usage"} {
			delete(payload, field)
		}
		outcome = provider.ModelInvokeFailed
		payload["outcome"] = outcome
		payload["reason"] = "Model invocation reply exceeds the Runner Gateway frame limit"
		encoded = mustJSON(payload)
	}
	attrs := []any{"phase", outcome, "invoke_id", invokeID, "duration_ms", duration.Milliseconds()}
	// The reason sent above is already redacted, so a diagnostics bundle can
	// show why a call failed without leaking a credential.
	if reason, _ := payload["reason"].(string); reason != "" {
		if runes := []rune(reason); len(runes) > modelInvokeLogReasonLimit {
			reason = string(runes[:modelInvokeLogReasonLimit])
		}
		attrs = append(attrs, "reason", reason)
	}
	slog.Info("runner.model.invoke", attrs...)
	return stream.Send(ctx, protocol.Event{
		Type: protocol.EventModelInvoked, ProtocolVersion: command.ProtocolVersion, CommandID: command.CommandID,
		SentAt: time.Now().UTC(), Payload: encoded,
	})
}
