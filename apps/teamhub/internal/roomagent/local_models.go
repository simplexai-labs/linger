package roomagent

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

// Errors of a local-models action besides the Computer's own refusals.
var (
	// ErrLocalModelsUnsupported: the connected Computer has not reported a
	// model library on this connection, so it cannot take the action.
	ErrLocalModelsUnsupported = errors.New("Local Computer does not report a model library")
	// ErrLocalModelsTimeout: the Computer did not answer the action in time.
	ErrLocalModelsTimeout = errors.New("Local Computer did not answer the local-models action")
)

// LocalModelActionCommand asks the owner's connected Computer to act on its
// model library. ModelID is empty only for refresh; UnloadFirst is only for
// load.
type LocalModelActionCommand struct {
	TenantID, OwnerActorID, ComputerID string
	RequestID                          string
	Action                             string
	ModelID                            string
	UnloadFirst                        []string
	ExpiresAt                          time.Time
}

// LocalModelActionRefusal is the Computer's reason for not starting an
// action. Pool, NeedBytes and FreeBytes come with a refusal for room.
type LocalModelActionRefusal struct {
	Code, Detail, Pool   string
	NeedBytes, FreeBytes *int64
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
		ExpiresAt: command.ExpiresAt.UTC(),
	}
	if command.ModelID != "" {
		request.ModelId = &command.ModelID
	}
	if len(command.UnloadFirst) > 0 {
		unloadFirst := append([]string(nil), command.UnloadFirst...)
		request.UnloadFirst = &unloadFirst
	}
	response, err := g.client.ActOnLocalComputerModelsWithResponse(ctx, command.TenantID, command.OwnerActorID, command.ComputerID, request)
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

func localModelActionRefusal(value nodeservicesinternal.LocalModelActionRefusal) *LocalModelActionRefusal {
	refusal := &LocalModelActionRefusal{Code: string(value.Code), NeedBytes: value.NeedBytes, FreeBytes: value.FreeBytes}
	if value.Detail != nil {
		refusal.Detail = *value.Detail
	}
	if value.Pool != nil {
		refusal.Pool = *value.Pool
	}
	return refusal
}
