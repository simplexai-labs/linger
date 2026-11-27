package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/localmodels"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

// ModelSourceManager inspects, probes and switches this Computer's active
// model source (local models, native subscriptions, or BYOK on Bifrost).
type ModelSourceManager interface {
	Status(ctx context.Context) (wire.ModelSourceStatus, error)
	TestByok(ctx context.Context, input wire.ByokConfigInput) (wire.ByokTestResult, error)
	ListByokModels(ctx context.Context, input wire.ByokConfigInput) (wire.ByokModelList, error)
	Apply(ctx context.Context, apply localmodels.ModelSourceApply) (wire.ModelSourceStatus, error)
	// EnsureGateway brings back the BYOK gateway runtimeType reaches its
	// model through when it does not answer.
	EnsureGateway(ctx context.Context, runtimeType string) error
	// GatewayMode names the managed gateway runtimeType reaches its model
	// through, "local" or "byok", or is empty for the Runtime's own provider.
	GatewayMode(runtimeType string) string
}

// ensureModelGateway brings back the model gateway runtimeType runs on, if
// any, before a Run or model call starts it. On failure it returns the
// public Run failure code the tool's structured code maps to, empty when
// none fits, so the Room names the cause instead of a refused connection
// the Runtime cannot classify.
func (d *Daemon) ensureModelGateway(ctx context.Context, runtimeType string, modelGatewayUnavailable bool) (string, error) {
	if d.modelSource == nil {
		return "", nil
	}
	err := d.modelSource.EnsureGateway(ctx, runtimeType)
	if err == nil || ctx.Err() != nil {
		return "", err
	}
	var sourceErr *localmodels.ModelSourceError
	if !errors.As(err, &sourceErr) {
		return "", err
	}
	slog.Warn("runner.model_gateway.unavailable", "runtime_type", runtimeType, "code", sourceErr.Code, "detail", receiptReason(redact.Text(sourceErr.Message)))
	switch sourceErr.Code {
	case "BYOK_UNREACHABLE", "NETWORK_UNAVAILABLE":
		return "network_error", err
	case "BYOK_AUTH_FAILED":
		return "authentication_required", err
	}
	if modelGatewayUnavailable {
		return "model_gateway_unavailable", err
	}
	return "", err
}

func (d *Daemon) handleModelSourceCommand(ctx context.Context, stream transport.Stream, command protocol.Command) error {
	var request wire.CapabilityModelSource
	if err := json.Unmarshal(command.Payload, &request); err != nil {
		return errors.New("invalid model source command")
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, request.ExpiresAt)
	if err != nil {
		return errors.New("invalid model source command expiry")
	}
	sendFailed := func(code, message string, retryable bool) error {
		frame := wire.CapabilityModelSourceFailed{
			ProtocolVersion: request.ProtocolVersion,
			CommandID:       request.CommandID,
			RunnerID:        request.RunnerID,
			TenantID:        request.TenantID,
			OwnerActorID:    request.OwnerActorID,
			ConnectionEpoch: request.ConnectionEpoch,
			ExpiresAt:       request.ExpiresAt,
			Type:            wire.TypeExecuted,
			Kind:            wire.KindModelSource,
			Action:          request.Action,
			Outcome:         wire.OutcomeFailed,
			Error: wire.AgentRunnerError{
				Code:      code,
				Message:   message,
				Retryable: retryable,
			},
		}
		payload, marshalErr := json.Marshal(frame)
		if marshalErr != nil {
			return marshalErr
		}
		return stream.Send(ctx, protocol.Event{
			Type:            protocol.EventCapabilityModelSourceFailed,
			ProtocolVersion: command.ProtocolVersion,
			CommandID:       command.CommandID,
			RunnerID:        command.RunnerID,
			TenantID:        request.TenantID,
			OwnerActorID:    request.OwnerActorID,
			ConnectionEpoch: command.ConnectionEpoch,
			SentAt:          time.Now().UTC(),
			Payload:         payload,
		})
	}

	switch {
	case request.RunnerID != d.computerID || !d.ownedBy(request.TenantID, request.OwnerActorID):
		return sendFailed("MODEL_SOURCE_FORBIDDEN", "This Computer does not belong to the owner.", false)
	case !expiresAt.After(time.Now()):
		return sendFailed("MODEL_SOURCE_EXPIRED", "The model source request expired; try again.", true)
	case request.Runtime != "" && !d.runtimeEnabled(request.Runtime):
		return sendFailed("RUNTIME_NOT_ENABLED", "The selected AI runtime is not enabled on this Computer.", false)
	case d.modelSource == nil:
		return sendFailed(localmodels.CodeToolNotInstalled, "The localmodels tool is not installed on this Computer.", false)
	}

	commandCtx, cancel := context.WithDeadline(ctx, expiresAt)
	defer cancel()

	var status *wire.ModelSourceStatus
	var testResult *wire.ByokTestResult
	var modelList *wire.ByokModelList
	var actionErr error

	switch request.Action {
	case "status":
		res, err := d.modelSource.Status(commandCtx)
		if err != nil {
			actionErr = err
		} else {
			status = &res
		}
	case "test":
		if request.Byok == nil || !validByokProtocol(request.Byok.Protocol) {
			return sendFailed("BYOK_INVALID_CONFIG", "A BYOK endpoint with a supported wire format is required.", false)
		}
		res, err := d.modelSource.TestByok(commandCtx, *request.Byok)
		if err != nil {
			actionErr = err
		} else {
			testResult = &res
		}
	case "models":
		if request.Byok == nil || !validByokProtocol(request.Byok.Protocol) {
			return sendFailed("BYOK_INVALID_CONFIG", "A BYOK endpoint with a supported wire format is required.", false)
		}
		res, err := d.modelSource.ListByokModels(commandCtx, *request.Byok)
		if err != nil {
			actionErr = err
		} else {
			modelList = &res
		}
	case "apply":
		if request.Mode == "" {
			return sendFailed("MODEL_SOURCE_INVALID", "Target model source mode is required.", false)
		}
		if request.Byok != nil && !validByokProtocol(request.Byok.Protocol) {
			return sendFailed("BYOK_INVALID_CONFIG", "A BYOK endpoint with a supported wire format is required.", false)
		}
		res, err := d.modelSource.Apply(commandCtx, localmodels.ModelSourceApply{
			Mode:         request.Mode,
			Runtime:      request.Runtime,
			LocalModelID: request.LocalModelID,
			Byok:         request.Byok,
		})
		if err != nil {
			actionErr = err
		} else {
			status = &res
		}
	default:
		return sendFailed("MODEL_SOURCE_INVALID", "Unsupported model source action.", false)
	}

	if actionErr != nil {
		var typed *localmodels.ModelSourceError
		if errors.As(actionErr, &typed) {
			slog.Warn("model_source.command_refused", "action", request.Action, "code", typed.Code)
			return sendFailed(typed.Code, typed.Message, typed.Retryable)
		}
		slog.Warn("model_source.command_failed", "action", request.Action)
		return sendFailed(localmodels.CodeToolFailed, "Could not complete the model source action on this Computer.", true)
	}

	if status != nil {
		if !d.byokEndpoint.Load() {
			// An Agent Service that predates BYOK paths rejects the unknown keys.
			status.Byok.Path, status.Byok.Endpoint = "", ""
		}
		if !d.dynamicReasoningEfforts.Load() && status.ReasoningEffort != "" && !provider.LegacyRuntimeReasoningEffort(status.ReasoningEffort) {
			status.ReasoningEffort = ""
		}
		if request.Action == "apply" {
			slog.Info("model_source.command_succeeded",
				"action", request.Action,
				"mode", status.Mode,
				"runtime", status.Runtime,
				"requested_model", redact.Text(request.LocalModelID),
				"resolved_model", redact.Text(status.RuntimeModel),
			)
		}
	}
	frame := wire.CapabilityModelSourceSucceeded{
		ProtocolVersion: request.ProtocolVersion,
		CommandID:       request.CommandID,
		RunnerID:        request.RunnerID,
		TenantID:        request.TenantID,
		OwnerActorID:    request.OwnerActorID,
		ConnectionEpoch: request.ConnectionEpoch,
		ExpiresAt:       request.ExpiresAt,
		Type:            wire.TypeExecuted,
		Kind:            wire.KindModelSource,
		Action:          request.Action,
		Outcome:         wire.OutcomeSucceeded,
		Status:          status,
		TestResult:      testResult,
		ModelList:       modelList,
	}
	payload, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	return stream.Send(ctx, protocol.Event{
		Type:            protocol.EventCapabilityModelSourceSucceeded,
		ProtocolVersion: command.ProtocolVersion,
		CommandID:       command.CommandID,
		RunnerID:        command.RunnerID,
		TenantID:        request.TenantID,
		OwnerActorID:    request.OwnerActorID,
		ConnectionEpoch: command.ConnectionEpoch,
		SentAt:          time.Now().UTC(),
		Payload:         payload,
	})
}

func validByokProtocol(protocol string) bool {
	switch protocol {
	case "openai-chat", "openai-responses", "anthropic":
		return true
	default:
		return false
	}
}
