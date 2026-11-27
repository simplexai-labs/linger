package roomagent

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

// Errors of a local-speech action besides the Computer's own refusals.
var (
	// ErrLocalSpeechUnsupported reports that the connected Computer has not
	// reported local speech capability on this connection.
	ErrLocalSpeechUnsupported = errors.New("Local Computer does not support local speech")
	// ErrLocalSpeechTimeout reports that the Computer did not answer the
	// local-speech action before its deadline.
	ErrLocalSpeechTimeout = errors.New("Local Computer did not answer the local-speech action")
)

// LocalSpeechManagement forwards local-speech commands to an owned Computer.
type LocalSpeechManagement interface {
	ActOnLocalSpeech(ctx context.Context, command LocalSpeechActionCommand) (*LocalSpeechActionRefusal, error)
}

// LocalSpeechActionCommand asks the owner's connected Computer to act on its
// localmodels speech catalog or runtime settings.
type LocalSpeechActionCommand struct {
	TenantID, OwnerActorID, ComputerID string
	RequestID                          string
	Action                             string
	ModelID                            string
	UseGPU                             *bool
	KeepLoadedSeconds                  *int
	Language                           string
	IncludeGPUEngine                   *bool
	ExpiresAt                          time.Time
}

// LocalSpeechActionRefusal is the Computer's reason for not starting a speech
// action.
type LocalSpeechActionRefusal struct {
	Code, Detail string
}

// ActOnLocalSpeech forwards one local-speech action and returns the Computer's
// immediate answer: nil when accepted, else its refusal.
func (g *HTTPGateway) ActOnLocalSpeech(ctx context.Context, command LocalSpeechActionCommand) (*LocalSpeechActionRefusal, error) {
	if !opaqueIDPattern.MatchString(command.TenantID) || !opaqueIDPattern.MatchString(command.OwnerActorID) || !opaqueIDPattern.MatchString(command.ComputerID) {
		return nil, ErrLocalComputerNotFound
	}
	request := nodeservicesinternal.LocalSpeechActionCommand{
		RequestId:         command.RequestID,
		Action:            nodeservicesinternal.LocalSpeechActionKind(command.Action),
		UseGpu:            command.UseGPU,
		KeepLoadedSeconds: command.KeepLoadedSeconds,
		IncludeGpuEngine:  command.IncludeGPUEngine,
		ExpiresAt:         command.ExpiresAt.UTC(),
	}
	if command.ModelID != "" {
		request.ModelId = &command.ModelID
	}
	if command.Language != "" {
		request.Language = &command.Language
	}
	response, err := g.localModelsClient.ActOnLocalComputerSpeechWithResponse(ctx, command.TenantID, command.OwnerActorID, command.ComputerID, request)
	if err != nil {
		return nil, fmt.Errorf("local-speech %s: %w", command.Action, err)
	}
	switch code := response.StatusCode(); {
	case code == http.StatusOK && response.JSON200 != nil && response.JSON200.RequestId == command.RequestID:
		ack := response.JSON200
		if ack.Outcome == nodeservicesinternal.LocalSpeechActionAcceptedOutcome && ack.Refusal == nil {
			return nil, nil
		}
		if ack.Outcome == nodeservicesinternal.LocalSpeechActionRefusedOutcome && ack.Refusal != nil {
			detail := ""
			if ack.Refusal.Detail != nil {
				detail = *ack.Refusal.Detail
			}
			return &LocalSpeechActionRefusal{Code: string(ack.Refusal.Code), Detail: detail}, nil
		}
	case code == http.StatusNotFound:
		return nil, ErrLocalComputerNotFound
	case code == http.StatusConflict:
		return nil, ErrLocalSpeechUnsupported
	case code == http.StatusServiceUnavailable && response.JSON503 != nil:
		switch response.JSON503.Error.Code {
		case "LOCAL_COMPUTER_OFFLINE":
			return nil, ErrLocalComputerOffline
		case "LOCAL_SPEECH_ACTION_TIMEOUT":
			return nil, ErrLocalSpeechTimeout
		}
	}
	return nil, fmt.Errorf("AgentManagement returned status %d for local-speech %s", response.StatusCode(), command.Action)
}
