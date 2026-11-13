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

// LocalModelLibrary runs the actions a Computer owner chooses on this
// Computer's localmodels library. The Daemon never picks a model itself.
type LocalModelLibrary interface {
	// Act answers once the tool accepted (nil) or refused the action;
	// answered is false when the deadline passed before the tool decided.
	Act(ctx context.Context, action localmodels.Action, deadline time.Time) (refusal *wire.LocalModelActionRefusal, answered bool)
	// Refresh reads the library and publishes the snapshot.
	Refresh(ctx context.Context) wire.LocalModelsSnapshot
}

// refreshLocalModels reports the library on a newly welcomed connection.
func (d *Daemon) refreshLocalModels(ctx context.Context) {
	if d.localModels == nil {
		return
	}
	// Reading the library runs the tool; the connection must not wait.
	go d.localModels.Refresh(ctx)
}

// PublishLocalModels sends one runner.local_models snapshot on the live
// connection. Without one it does nothing: every connection starts with a
// fresh read.
func (d *Daemon) PublishLocalModels(snapshot wire.LocalModelsSnapshot) {
	d.localModelsMu.Lock()
	defer d.localModelsMu.Unlock()
	d.connectionMu.Lock()
	stream := d.diagnosticsStream
	d.connectionMu.Unlock()
	if stream == nil {
		return
	}
	d.localModelsRevision++
	sentAt := time.Now().UTC()
	frame := wire.RunnerLocalModels{
		Type: wire.TypeRunnerLocalModels, ProtocolVersion: d.protocolVersion, RunnerID: d.computerID,
		SentAt: sentAt.Format(time.RFC3339Nano), Revision: d.localModelsRevision, LocalModels: snapshot,
	}
	payload, err := json.Marshal(frame)
	if err == nil {
		err = stream.Send(context.Background(), protocol.Event{
			Type: protocol.EventLocalModels, ProtocolVersion: d.protocolVersion, RunnerID: d.computerID,
			Revision: d.localModelsRevision, SentAt: sentAt, Payload: payload,
		})
	}
	if err != nil {
		slog.Warn("local_models.snapshot_not_sent", "revision", d.localModelsRevision, "error", err)
	}
}

func (d *Daemon) handleLocalModelsCommand(ctx context.Context, stream transport.Stream, command protocol.Command) error {
	var request wire.CapabilityLocalModelsExecute
	if err := json.Unmarshal(command.Payload, &request); err != nil {
		return errors.New("invalid local models command")
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, request.ExpiresAt)
	if err != nil {
		return errors.New("invalid local models command expiry")
	}
	if !expiresAt.After(time.Now()) {
		// The Gateway no longer waits for an answer; starting the action
		// would act on a request nobody follows.
		slog.Info("local_models.command_expired", "action", request.Action, "model", request.ModelID)
		return nil
	}
	action := localmodels.Action{Name: request.Action, Model: request.ModelID, UnloadFirst: request.UnloadFirst}
	var refusal *wire.LocalModelActionRefusal
	switch {
	case request.RunnerID != d.computerID || !d.ownedBy(request.TenantID, request.OwnerActorID):
		// The Agent Service routes only the Computer's own owners here.
		slog.Warn("local_models.command_rejected", "reason", "owner", "action", request.Action)
		refusal = &wire.LocalModelActionRefusal{Code: localmodels.CodeToolFailed, Detail: "the command does not name this Computer's owner"}
	case !validLocalModelAction(action):
		slog.Warn("local_models.command_rejected", "reason", "shape", "action", request.Action)
		refusal = &wire.LocalModelActionRefusal{Code: "MODEL_UNKNOWN", Detail: "the command names no valid model action"}
	case d.localModels == nil:
		refusal = &wire.LocalModelActionRefusal{Code: localmodels.CodeToolNotInstalled}
	default:
		slog.Info("local_models.command_received", "action", action.Name, "model", action.Model, "unload_first", action.UnloadFirst)
		var answered bool
		refusal, answered = d.localModels.Act(ctx, action, expiresAt)
		if !answered {
			// The Gateway stopped waiting at the same deadline and reports the
			// action as unconfirmed; any answer now would be a guess.
			slog.Info("local_models.answer_missed_deadline", "action", action.Name, "model", action.Model)
			return nil
		}
	}
	route := protocol.EventCapabilityLocalModelsAccepted
	var frame any = wire.CapabilityLocalModelsAccepted{
		ProtocolVersion: request.ProtocolVersion, CommandID: request.CommandID, RunnerID: request.RunnerID,
		TenantID: request.TenantID, OwnerActorID: request.OwnerActorID, ConnectionEpoch: request.ConnectionEpoch,
		ExpiresAt: request.ExpiresAt, Type: wire.TypeExecuted, Kind: wire.KindLocalModels,
		Action: request.Action, ModelID: request.ModelID, Outcome: wire.OutcomeAccepted,
	}
	if refusal != nil {
		route = protocol.EventCapabilityLocalModelsRefused
		frame = wire.CapabilityLocalModelsRefused{
			ProtocolVersion: request.ProtocolVersion, CommandID: request.CommandID, RunnerID: request.RunnerID,
			TenantID: request.TenantID, OwnerActorID: request.OwnerActorID, ConnectionEpoch: request.ConnectionEpoch,
			ExpiresAt: request.ExpiresAt, Type: wire.TypeExecuted, Kind: wire.KindLocalModels,
			Action: request.Action, ModelID: request.ModelID, Refusal: *refusal, Outcome: wire.OutcomeRefused,
		}
		slog.Info("local_models.command_refused", "action", action.Name, "model", action.Model, "code", refusal.Code)
	}
	payload, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	return stream.Send(ctx, protocol.Event{
		Type: route, ProtocolVersion: command.ProtocolVersion,
		CommandID: command.CommandID, RunnerID: command.RunnerID,
		TenantID: request.TenantID, OwnerActorID: request.OwnerActorID,
		ConnectionEpoch: command.ConnectionEpoch, SentAt: time.Now().UTC(), Payload: payload,
	})
}

// validLocalModelAction checks what the wire schema requires, so no value
// the tool would read as an option reaches its command line.
func validLocalModelAction(action localmodels.Action) bool {
	switch action.Name {
	case localmodels.ActionRefresh:
		return action.Model == "" && len(action.UnloadFirst) == 0
	case localmodels.ActionDownload, localmodels.ActionCancel, localmodels.ActionUnload, localmodels.ActionRemove:
		return localmodels.ValidModelID(action.Model) && len(action.UnloadFirst) == 0
	case localmodels.ActionLoad:
		if !localmodels.ValidModelID(action.Model) {
			return false
		}
		for _, other := range action.UnloadFirst {
			if !localmodels.ValidModelID(other) || other == action.Model {
				return false
			}
		}
		return true
	}
	return false
}
