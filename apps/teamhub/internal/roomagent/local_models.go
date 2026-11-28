package roomagent

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

// localModelsActionRequestTimeout covers the Gateway's 30-second budget for a
// local-models action acknowledgement, with transport headroom.
const localModelsActionRequestTimeout = 35 * time.Second

// localModelsCustomProbeTimeout covers the Gateway's 45-second budget for a
// synchronous custom hub search or probe, with transport headroom.
const localModelsCustomProbeTimeout = 50 * time.Second

// Errors of a local-models action besides the Computer's own refusals.
var (
	// ErrLocalModelsUnsupported: the connected Computer has not reported a
	// model library on this connection, so it cannot take the action.
	ErrLocalModelsUnsupported = errors.New("Local Computer does not report a model library")
	// ErrLocalModelsCustomUnsupported: the connected Computer release predates
	// custom local model support (0.71.0).
	ErrLocalModelsCustomUnsupported = errors.New("Local Computer does not support custom local models")
	// ErrLocalModelsTimeout: the Computer did not answer the action in time.
	ErrLocalModelsTimeout = errors.New("Local Computer did not answer the local-models action")
)

// LocalModelActionCommand asks the owner's connected Computer to act on its
// model library. ModelID is empty only for refresh; UnloadFirst and Force are
// only for load; ContextTokens is for load or smoke_test.
type LocalModelActionCommand struct {
	TenantID, OwnerActorID, ComputerID string
	RequestID                          string
	Action                             string
	ModelID                            string
	UnloadFirst                        []string
	Force                              *bool
	ContextTokens                      *int64
	ExpiresAt                          time.Time
}

// LocalModelCustomDownloadCommand asks the owner's connected Computer to start
// a Standby-First custom model download.
type LocalModelCustomDownloadCommand struct {
	TenantID, OwnerActorID, ComputerID string
	RequestID                          string
	CustomDownload                     nodeservicesinternal.LocalModelCustomDownloadInput
	ExpiresAt                          time.Time
}

// LocalModelsCustomError reports a structured failure from a synchronous custom
// hub search or probe request.
type LocalModelsCustomError struct {
	Code    string
	Message string
}

func (e *LocalModelsCustomError) Error() string { return "custom local models failed: " + e.Code }

// LocalModelsCustomManagement runs custom Hugging Face / ModelScope search,
// zero-download probe, and Standby-First download on an owned Computer.
type LocalModelsCustomManagement interface {
	SearchLocalComputerCustomModels(ctx context.Context, target ModelSourceTarget, request nodeservicesinternal.LocalModelCustomSearchRequest) (nodeservicesinternal.LocalModelCustomSearchResponse, error)
	ProbeLocalComputerCustomModel(ctx context.Context, target ModelSourceTarget, request nodeservicesinternal.LocalModelCustomProbeRequest) (nodeservicesinternal.LocalModelCustomProbeResponse, error)
	DownloadLocalComputerCustomModel(ctx context.Context, command LocalModelCustomDownloadCommand) (modelID string, refusal *LocalModelActionRefusal, err error)
}

// LocalModelActionRefusal is the Computer's reason for not starting an
// action. Pool, NeedBytes, FreeBytes, ShortfallBytes, and CanForce come with
// a refusal for room.
type LocalModelActionRefusal struct {
	Code, Detail, Pool                   string
	NeedBytes, FreeBytes, ShortfallBytes *int64
	CanForce                             *bool
}

// ActOnLocalModels forwards one local-models action and returns the
// Computer's immediate answer: nil when it started the action, else its
// refusal. Progress arrives later as stored snapshots.
func (g *HTTPGateway) ActOnLocalModels(ctx context.Context, command LocalModelActionCommand) (*LocalModelActionRefusal, error) {
	if !opaqueIDPattern.MatchString(command.TenantID) || !opaqueIDPattern.MatchString(command.OwnerActorID) || !opaqueIDPattern.MatchString(command.ComputerID) {
		return nil, ErrLocalComputerNotFound
	}
	request := nodeservicesinternal.LocalModelActionCommand{
		RequestId: command.RequestID, Action: nodeservicesinternal.LocalModelActionKind(command.Action),
		Force: command.Force, ContextTokens: command.ContextTokens,
		ExpiresAt: command.ExpiresAt.UTC(),
	}
	if command.ModelID != "" {
		request.ModelId = &command.ModelID
	}
	if len(command.UnloadFirst) > 0 {
		unloadFirst := append([]string(nil), command.UnloadFirst...)
		request.UnloadFirst = &unloadFirst
	}
	response, err := g.localModelsClient.ActOnLocalComputerModelsWithResponse(ctx, command.TenantID, command.OwnerActorID, command.ComputerID, request)
	if err != nil {
		return nil, fmt.Errorf("local-models %s: %w", command.Action, err)
	}
	switch code := response.StatusCode(); {
	case code == http.StatusOK && response.JSON200 != nil && response.JSON200.RequestId == command.RequestID:
		ack := response.JSON200
		if ack.Outcome == nodeservicesinternal.LocalModelActionAccepted && ack.Refusal == nil {
			return nil, nil
		}
		if ack.Outcome == nodeservicesinternal.LocalModelActionRefused && ack.Refusal != nil {
			return localModelActionRefusal(*ack.Refusal), nil
		}
	case code == http.StatusNotFound:
		return nil, ErrLocalComputerNotFound
	case code == http.StatusConflict:
		if response.JSON409 != nil && response.JSON409.Error.Code == "LOCAL_MODELS_CUSTOM_UNSUPPORTED" {
			return nil, ErrLocalModelsCustomUnsupported
		}
		return nil, ErrLocalModelsUnsupported
	case code == http.StatusServiceUnavailable && response.JSON503 != nil:
		switch response.JSON503.Error.Code {
		case "LOCAL_COMPUTER_OFFLINE":
			return nil, ErrLocalComputerOffline
		case "LOCAL_MODELS_ACTION_TIMEOUT":
			return nil, ErrLocalModelsTimeout
		}
	}
	return nil, fmt.Errorf("AgentManagement returned status %d for local-models %s", response.StatusCode(), command.Action)
}

// SearchLocalComputerCustomModels searches Hugging Face or ModelScope via the Computer.
func (g *HTTPGateway) SearchLocalComputerCustomModels(ctx context.Context, target ModelSourceTarget, request nodeservicesinternal.LocalModelCustomSearchRequest) (nodeservicesinternal.LocalModelCustomSearchResponse, error) {
	if !validModelSourceTarget(target) {
		return nodeservicesinternal.LocalModelCustomSearchResponse{}, ErrLocalComputerNotFound
	}
	probeCtx, cancel := context.WithTimeout(ctx, localModelsCustomProbeTimeout)
	defer cancel()
	response, err := g.modelSourceClient.SearchLocalComputerCustomModelsWithResponse(probeCtx, target.TenantID, target.OwnerActorID, target.ComputerID, request)
	if err != nil {
		return nodeservicesinternal.LocalModelCustomSearchResponse{}, fmt.Errorf("local-models custom search: %w", err)
	}
	if response.StatusCode() == http.StatusOK && response.JSON200 != nil {
		return *response.JSON200, nil
	}
	return nodeservicesinternal.LocalModelCustomSearchResponse{}, localModelsCustomGatewayError(response.StatusCode(),
		firstError(response.JSON400, response.JSON409, response.JSON502, response.JSON503))
}

// ProbeLocalComputerCustomModel runs a zero-download custom repository probe via the Computer.
func (g *HTTPGateway) ProbeLocalComputerCustomModel(ctx context.Context, target ModelSourceTarget, request nodeservicesinternal.LocalModelCustomProbeRequest) (nodeservicesinternal.LocalModelCustomProbeResponse, error) {
	if !validModelSourceTarget(target) {
		return nodeservicesinternal.LocalModelCustomProbeResponse{}, ErrLocalComputerNotFound
	}
	probeCtx, cancel := context.WithTimeout(ctx, localModelsCustomProbeTimeout)
	defer cancel()
	response, err := g.modelSourceClient.ProbeLocalComputerCustomModelWithResponse(probeCtx, target.TenantID, target.OwnerActorID, target.ComputerID, request)
	if err != nil {
		return nodeservicesinternal.LocalModelCustomProbeResponse{}, fmt.Errorf("local-models custom probe: %w", err)
	}
	if response.StatusCode() == http.StatusOK && response.JSON200 != nil {
		return *response.JSON200, nil
	}
	return nodeservicesinternal.LocalModelCustomProbeResponse{}, localModelsCustomGatewayError(response.StatusCode(),
		firstError(response.JSON400, response.JSON409, response.JSON502, response.JSON503))
}

// DownloadLocalComputerCustomModel starts a Standby-First custom model download on the Computer.
func (g *HTTPGateway) DownloadLocalComputerCustomModel(ctx context.Context, command LocalModelCustomDownloadCommand) (string, *LocalModelActionRefusal, error) {
	if !opaqueIDPattern.MatchString(command.TenantID) || !opaqueIDPattern.MatchString(command.OwnerActorID) || !opaqueIDPattern.MatchString(command.ComputerID) {
		return "", nil, ErrLocalComputerNotFound
	}
	request := nodeservicesinternal.LocalModelCustomDownloadCommand{
		RequestId:      command.RequestID,
		ExpiresAt:      command.ExpiresAt.UTC(),
		CustomDownload: command.CustomDownload,
	}
	response, err := g.localModelsClient.DownloadLocalComputerCustomModelWithResponse(ctx, command.TenantID, command.OwnerActorID, command.ComputerID, request)
	if err != nil {
		return "", nil, fmt.Errorf("local-models custom download: %w", err)
	}
	switch code := response.StatusCode(); {
	case code == http.StatusOK && response.JSON200 != nil && response.JSON200.RequestId == command.RequestID:
		ack := response.JSON200
		if ack.Outcome == nodeservicesinternal.LocalModelActionAccepted && ack.Refusal == nil {
			modelID := ""
			if ack.ModelId != nil {
				modelID = *ack.ModelId
			}
			return modelID, nil, nil
		}
		if ack.Outcome == nodeservicesinternal.LocalModelActionRefused && ack.Refusal != nil {
			return "", localModelActionRefusal(*ack.Refusal), nil
		}
	case code == http.StatusNotFound:
		return "", nil, ErrLocalComputerNotFound
	case code == http.StatusConflict:
		if response.JSON409 != nil && response.JSON409.Error.Code == "LOCAL_MODELS_CUSTOM_UNSUPPORTED" {
			return "", nil, ErrLocalModelsCustomUnsupported
		}
		return "", nil, ErrLocalModelsUnsupported
	case code == http.StatusServiceUnavailable && response.JSON503 != nil:
		switch response.JSON503.Error.Code {
		case "LOCAL_COMPUTER_OFFLINE":
			return "", nil, ErrLocalComputerOffline
		case "LOCAL_MODELS_ACTION_TIMEOUT":
			return "", nil, ErrLocalModelsTimeout
		}
	}
	return "", nil, fmt.Errorf("AgentManagement returned status %d for local-models custom download", response.StatusCode())
}

func localModelsCustomGatewayError(status int, body *nodeservicesinternal.ErrorResponse) error {
	switch {
	case status == http.StatusNotFound:
		return ErrLocalComputerNotFound
	case status == http.StatusConflict && body != nil && body.Error.Code == "LOCAL_MODELS_CUSTOM_UNSUPPORTED":
		return ErrLocalModelsCustomUnsupported
	case status == http.StatusConflict:
		return ErrLocalModelsUnsupported
	case body != nil && body.Error.Code == "LOCAL_COMPUTER_OFFLINE":
		return ErrLocalComputerOffline
	case body != nil && (body.Error.Code == "LOCAL_MODELS_ACTION_TIMEOUT" || body.Error.Code == "LOCAL_MODELS_CUSTOM_EXPIRED"):
		return ErrLocalModelsTimeout
	case body != nil && body.Error.Code != "":
		return &LocalModelsCustomError{Code: body.Error.Code, Message: body.Error.Message}
	}
	return fmt.Errorf("AgentManagement returned status %d for custom local models", status)
}

func localModelActionRefusal(value nodeservicesinternal.LocalModelActionRefusal) *LocalModelActionRefusal {
	refusal := &LocalModelActionRefusal{
		Code:           string(value.Code),
		NeedBytes:      value.NeedBytes,
		FreeBytes:      value.FreeBytes,
		ShortfallBytes: value.ShortfallBytes,
		CanForce:       value.CanForce,
	}
	if value.Detail != nil {
		refusal.Detail = *value.Detail
	}
	if value.Pool != nil {
		refusal.Pool = *value.Pool
	}
	return refusal
}
