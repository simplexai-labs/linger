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
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

// serviceFeatureLocalVoiceAsr in runner.welcome's service_features says the
// Agent Service accepts runner.local_speech snapshots and sends
// local_speech_action / local_asr_transcribe commands.
const serviceFeatureLocalVoiceAsr = "local_voice_asr"

// LocalSpeechLibrary runs localmodels speech actions and local ASR
// transcriptions on this Computer.
type LocalSpeechLibrary interface {
	Act(ctx context.Context, action localmodels.SpeechAction, deadline time.Time) (refusal *wire.LocalSpeechActionRefusal, answered bool)
	Refresh(ctx context.Context) wire.LocalSpeechSnapshot
	Transcribe(ctx context.Context, req localmodels.SpeechTranscribeRequest) (localmodels.SpeechTranscribeResult, error)
}

func (d *Daemon) refreshLocalSpeech(ctx context.Context) {
	if d.localSpeech == nil {
		return
	}
	go d.localSpeech.Refresh(ctx)
}

// PublishLocalSpeech sends one runner.local_speech snapshot on the live
// connection when its Agent Service announced local_voice_asr.
func (d *Daemon) PublishLocalSpeech(snapshot wire.LocalSpeechSnapshot) {
	d.localSpeechMu.Lock()
	defer d.localSpeechMu.Unlock()
	d.connectionMu.Lock()
	stream := d.localSpeechStream
	d.connectionMu.Unlock()
	if stream == nil {
		return
	}
	d.localSpeechRevision++
	sentAt := time.Now().UTC()
	frame := wire.RunnerLocalSpeech{
		Type:            wire.TypeRunnerLocalSpeech,
		ProtocolVersion: d.protocolVersion,
		RunnerID:        d.computerID,
		SentAt:          sentAt.Format(time.RFC3339Nano),
		Revision:        d.localSpeechRevision,
		LocalSpeech:     snapshot,
	}
	payload, err := json.Marshal(frame)
	if err == nil {
		err = stream.Send(context.Background(), protocol.Event{
			Type:            protocol.EventLocalSpeech,
			ProtocolVersion: d.protocolVersion,
			RunnerID:        d.computerID,
			Revision:        d.localSpeechRevision,
			SentAt:          sentAt,
			Payload:         payload,
		})
	}
	if err != nil {
		slog.Warn("local_speech.snapshot_not_sent", "revision", d.localSpeechRevision, "error", err)
	}
}

func (d *Daemon) acceptsLocalSpeech(stream transport.Stream) bool {
	d.connectionMu.Lock()
	defer d.connectionMu.Unlock()
	return d.localSpeechStream != nil && d.localSpeechStream == stream
}

func (d *Daemon) handleLocalSpeechActionCommand(ctx context.Context, stream transport.Stream, command protocol.Command) error {
	var request wire.CapabilityLocalSpeechActionExecute
	if err := json.Unmarshal(command.Payload, &request); err != nil {
		return errors.New("invalid local speech action command")
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, request.ExpiresAt)
	if err != nil {
		return errors.New("invalid local speech action expiry")
	}
	if !expiresAt.After(time.Now()) {
		slog.Info("local_speech.command_expired", "action", request.Action, "model", request.ModelID)
		return nil
	}
	action := localmodels.SpeechAction{
		Name:              request.Action,
		Model:             request.ModelID,
		UseGPU:            request.UseGpu,
		KeepLoadedSeconds: request.KeepLoadedSeconds,
		Language:          request.Language,
		IncludeGPUEngine:  request.IncludeGpuEngine,
	}
	var refusal *wire.LocalSpeechActionRefusal
	switch {
	case request.RunnerID != d.computerID || !d.ownedBy(request.TenantID, request.OwnerActorID):
		slog.Warn("local_speech.command_rejected", "reason", "owner", "action", request.Action)
		refusal = &wire.LocalSpeechActionRefusal{Code: localmodels.CodeToolFailed, Detail: "the command does not name this Computer's owner"}
	case !validLocalSpeechActionCommand(action):
		slog.Warn("local_speech.command_rejected", "reason", "shape", "action", request.Action)
		refusal = &wire.LocalSpeechActionRefusal{Code: "MODEL_UNKNOWN", Detail: "the command names no valid speech action"}
	case !d.acceptsLocalSpeech(stream):
		slog.Warn("local_speech.command_rejected", "reason", "service_features", "action", request.Action)
		refusal = &wire.LocalSpeechActionRefusal{Code: localmodels.CodeToolFailed, Detail: "the Agent Service did not announce local_voice_asr on this connection"}
	case d.localSpeech == nil:
		refusal = &wire.LocalSpeechActionRefusal{Code: localmodels.CodeToolNotInstalled}
	default:
		slog.Info("local_speech.command_received", "action", action.Name, "model", action.Model)
		var answered bool
		refusal, answered = d.localSpeech.Act(ctx, action, expiresAt)
		if !answered {
			slog.Info("local_speech.answer_missed_deadline", "action", action.Name, "model", action.Model)
			return nil
		}
	}
	route := protocol.EventCapabilityLocalSpeechActionAccepted
	var frame any = wire.CapabilityLocalSpeechActionAccepted{
		ProtocolVersion: request.ProtocolVersion,
		CommandID:       request.CommandID,
		RunnerID:        request.RunnerID,
		TenantID:        request.TenantID,
		OwnerActorID:    request.OwnerActorID,
		ConnectionEpoch: request.ConnectionEpoch,
		ExpiresAt:       request.ExpiresAt,
		Type:            wire.TypeExecuted,
		Kind:            wire.KindLocalSpeechAction,
		Action:          request.Action,
		ModelID:         request.ModelID,
		Outcome:         wire.OutcomeAccepted,
	}
	if refusal != nil {
		route = protocol.EventCapabilityLocalSpeechActionRefused
		frame = wire.CapabilityLocalSpeechActionRefused{
			ProtocolVersion: request.ProtocolVersion,
			CommandID:       request.CommandID,
			RunnerID:        request.RunnerID,
			TenantID:        request.TenantID,
			OwnerActorID:    request.OwnerActorID,
			ConnectionEpoch: request.ConnectionEpoch,
			ExpiresAt:       request.ExpiresAt,
			Type:            wire.TypeExecuted,
			Kind:            wire.KindLocalSpeechAction,
			Action:          request.Action,
			ModelID:         request.ModelID,
			Refusal:         *refusal,
			Outcome:         wire.OutcomeRefused,
		}
		slog.Info("local_speech.command_refused", "action", action.Name, "model", action.Model, "code", refusal.Code)
	}
	payload, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	return stream.Send(ctx, protocol.Event{
		Type:            route,
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

func (d *Daemon) handleLocalAsrTranscribeCommand(ctx context.Context, stream transport.Stream, command protocol.Command) error {
	var request wire.CapabilityLocalAsrTranscribeExecute
	if err := json.Unmarshal(command.Payload, &request); err != nil {
		return errors.New("invalid local ASR transcribe command")
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, request.ExpiresAt)
	if err != nil {
		return errors.New("invalid local ASR transcribe expiry")
	}
	if !expiresAt.After(time.Now()) {
		slog.Info("local_asr.transcribe_expired", "command_id", request.CommandID)
		return nil
	}

	sendFailed := func(code, message string, retryable bool) error {
		retryFlag := retryable
		frame := wire.CapabilityLocalAsrTranscribeFailed{
			ProtocolVersion: request.ProtocolVersion,
			CommandID:       request.CommandID,
			RunnerID:        request.RunnerID,
			TenantID:        request.TenantID,
			OwnerActorID:    request.OwnerActorID,
			ConnectionEpoch: request.ConnectionEpoch,
			ExpiresAt:       request.ExpiresAt,
			Type:            wire.TypeExecuted,
			Kind:            wire.KindLocalAsrTranscribe,
			Outcome:         wire.OutcomeFailed,
			ErrorCode:       code,
			ErrorMessage:    message,
			Retryable:       &retryFlag,
		}
		payload, marshalErr := json.Marshal(frame)
		if marshalErr != nil {
			return marshalErr
		}
		return stream.Send(ctx, protocol.Event{
			Type:            protocol.EventCapabilityLocalAsrTranscribeFailed,
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
		return sendFailed("OWNER_MISMATCH", "the command does not name this Computer's owner", false)
	case !d.acceptsLocalSpeech(stream):
		return sendFailed("LOCAL_VOICE_ASR_UNSUPPORTED", "the Agent Service did not announce local_voice_asr on this connection", false)
	case d.localSpeech == nil:
		return sendFailed(localmodels.CodeToolNotInstalled, "localmodels tool is not installed", false)
	}

	runCtx, cancel := context.WithDeadline(ctx, expiresAt)
	defer cancel()
	result, err := d.localSpeech.Transcribe(runCtx, localmodels.SpeechTranscribeRequest{
		ModelID:           request.ModelID,
		Language:          request.Language,
		UseGPU:            request.UseGpu,
		KeepLoadedSeconds: request.KeepLoadedSeconds,
		AudioWavBase64:    request.AudioWavBase64,
	})
	if err != nil {
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) && !expiresAt.After(time.Now()) {
			return nil
		}
		var speechErr *localmodels.SpeechTranscribeError
		if errors.As(err, &speechErr) {
			return sendFailed(speechErr.Code, speechErr.Message, speechErr.Retryable)
		}
		return sendFailed("TRANSCRIBE_FAILED", err.Error(), true)
	}
	frame := wire.CapabilityLocalAsrTranscribeSucceeded{
		ProtocolVersion: request.ProtocolVersion,
		CommandID:       request.CommandID,
		RunnerID:        request.RunnerID,
		TenantID:        request.TenantID,
		OwnerActorID:    request.OwnerActorID,
		ConnectionEpoch: request.ConnectionEpoch,
		ExpiresAt:       request.ExpiresAt,
		Type:            wire.TypeExecuted,
		Kind:            wire.KindLocalAsrTranscribe,
		Outcome:         wire.OutcomeSucceeded,
		Text:            result.Text,
		Language:        result.Language,
		Duration:        result.Duration,
		Model:           result.Model,
		RequestedDevice: result.RequestedDevice,
		EffectiveDevice: result.EffectiveDevice,
		FallbackReason:  result.FallbackReason,
		Segments:        result.Segments,
	}
	payload, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	return stream.Send(ctx, protocol.Event{
		Type:            protocol.EventCapabilityLocalAsrTranscribeSucceeded,
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

func validLocalSpeechActionCommand(action localmodels.SpeechAction) bool {
	if action.Model != "" && !localmodels.ValidModelID(action.Model) {
		return false
	}
	if action.Language != "" && !localmodels.ValidSpeechLanguage(action.Language) {
		return false
	}
	if action.KeepLoadedSeconds != nil && (*action.KeepLoadedSeconds < -1 || *action.KeepLoadedSeconds > 86400) {
		return false
	}
	switch action.Name {
	case localmodels.SpeechActionRefresh, localmodels.SpeechActionUnload:
		return true
	case localmodels.SpeechActionDownload, localmodels.SpeechActionCancel,
		localmodels.SpeechActionRemove, localmodels.SpeechActionLoad:
		return action.Model != ""
	case localmodels.SpeechActionConfigure:
		return action.Model != "" || action.UseGPU != nil || action.KeepLoadedSeconds != nil || action.Language != ""
	default:
		return false
	}
}
