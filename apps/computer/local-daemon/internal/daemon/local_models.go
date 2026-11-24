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

// serviceFeatureLocalModels in runner.welcome's service_features says the
// Agent Service accepts runner.local_models and sends local_models commands.
// An Agent Service that predates them closes the connection on the frame.
const serviceFeatureLocalModels = "local_models"

// serviceFeatureByokEndpoint in runner.welcome's service_features says the
// Agent Service accepts a BYOK summary's path and endpoint.
const serviceFeatureByokEndpoint = "byok_endpoint"

// serviceFeatureLocalModelsDiagnostics in runner.welcome's service_features says
// the Agent Service accepts extended local-models diagnostic reasons, refusal
// codes, and debug-mode metadata. Older services close the connection on them.
const serviceFeatureLocalModelsDiagnostics = "local_models_diagnostics"

// serviceFeatureLocalModelsEngine in runner.welcome's service_features says
// the Agent Service accepts per-model engine, engine_label, concurrency, and
// host_ram_bytes fields on LocalModel rows. Older services close the connection
// on unknown LocalModel properties.
const serviceFeatureLocalModelsEngine = "local_models_engine"

// serviceFeatureLocalModelsConcurrencyProbe in runner.welcome's
// service_features says the Agent Service accepts per-model
// concurrency_probing on LocalModel rows. Older services close the connection
// on unknown LocalModel properties.
const serviceFeatureLocalModelsConcurrencyProbe = "local_models_concurrency_probe"

// serviceFeatureLocalModelsExternalHolders in runner.welcome's service_features
// says the Agent Service accepts external_holders on LocalModelPool rows. Older
// services close the connection on unknown LocalModelPool properties.
const serviceFeatureLocalModelsExternalHolders = "local_models_external_holders"

// serviceFeatureLocalModelUnavailable in runner.welcome's service_features
// says the Agent Service accepts the local_model_unavailable Run failure
// code. An older service rejects the frame, so the Daemon reports
// model_unavailable to it instead.
const serviceFeatureLocalModelUnavailable = "local_model_unavailable"

// LocalModelLibrary runs the actions a Computer owner chooses on this
// Computer's localmodels library. The Daemon never picks a model: on its
// own it loads only the downloaded model a Run's Agent already names, and it
// never downloads a model or unloads another one to make room.
type LocalModelLibrary interface {
	// Act answers once the tool accepted (nil) or refused the action;
	// answered is false when the deadline passed before the tool decided.
	Act(ctx context.Context, action localmodels.Action, deadline time.Time) (refusal *wire.LocalModelActionRefusal, answered bool)
	// Refresh reads the library and publishes the snapshot.
	Refresh(ctx context.Context) wire.LocalModelsSnapshot
	// EnsureLoaded loads the downloaded library model whose pi_model is
	// piModel when it is not loaded, and waits for it. It returns nil when
	// piModel names no library model.
	EnsureLoaded(ctx context.Context, piModel string) error
}

// ensureLocalModel loads the library model a Pi Run names before the Run
// starts, so a model a quit unloaded does not fail every Run until someone
// loads it by hand. On failure it returns the public Run failure code.
func (d *Daemon) ensureLocalModel(ctx context.Context, runtimeType, model string) (string, error) {
	if d.localModels == nil || runtimeType != "pi" || model == "" {
		return "", nil
	}
	err := d.localModels.EnsureLoaded(ctx, model)
	if err == nil || ctx.Err() != nil {
		return "", err
	}
	var loadErr *localmodels.LocalModelLoadError
	if !errors.As(err, &loadErr) {
		return "", err
	}
	slog.Warn("runner.local_model.unavailable", "runtime_type", runtimeType, "model", loadErr.ModelID, "code", loadErr.Code)
	if d.localModelUnavailable.Load() {
		return "local_model_unavailable", err
	}
	return "model_unavailable", err
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
// connection when its Agent Service accepts them. Otherwise it does nothing:
// every connection starts with a fresh read.
func (d *Daemon) PublishLocalModels(snapshot wire.LocalModelsSnapshot) {
	d.localModelsMu.Lock()
	defer d.localModelsMu.Unlock()
	d.connectionMu.Lock()
	stream := d.localModelsStream
	d.connectionMu.Unlock()
	if stream == nil {
		return
	}
	if !d.localModelsDiagnostics.Load() {
		snapshot = downgradeLocalModelsSnapshot(snapshot)
	}
	if !d.localModelsEngine.Load() {
		snapshot = stripLocalModelsEngine(snapshot)
	}
	if !d.localModelsConcurrencyProbe.Load() {
		snapshot = stripLocalModelsConcurrencyProbe(snapshot)
	}
	if !d.localModelsExternalHolders.Load() {
		snapshot = stripLocalModelsExternalHolders(snapshot)
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
	case !d.acceptsLocalModels(stream):
		// The welcome did not name local_models, so no snapshot follows the
		// action on this connection.
		slog.Warn("local_models.command_rejected", "reason", "service_features", "action", request.Action)
		refusal = &wire.LocalModelActionRefusal{Code: localmodels.CodeToolFailed, Detail: "the Agent Service did not announce local models on this connection"}
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
		wireRefusal := *refusal
		if !d.localModelsDiagnostics.Load() {
			wireRefusal = downgradeLocalModelActionRefusal(wireRefusal)
		}
		route = protocol.EventCapabilityLocalModelsRefused
		frame = wire.CapabilityLocalModelsRefused{
			ProtocolVersion: request.ProtocolVersion, CommandID: request.CommandID, RunnerID: request.RunnerID,
			TenantID: request.TenantID, OwnerActorID: request.OwnerActorID, ConnectionEpoch: request.ConnectionEpoch,
			ExpiresAt: request.ExpiresAt, Type: wire.TypeExecuted, Kind: wire.KindLocalModels,
			Action: request.Action, ModelID: request.ModelID, Refusal: wireRefusal, Outcome: wire.OutcomeRefused,
		}
		slog.Info("local_models.command_refused", "action", action.Name, "model", action.Model, "code", wireRefusal.Code)
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

// acceptsLocalModels reports whether stream is the live connection and its
// welcome named local_models.
func (d *Daemon) acceptsLocalModels(stream transport.Stream) bool {
	d.connectionMu.Lock()
	defer d.connectionMu.Unlock()
	return d.localModelsStream != nil && d.localModelsStream == stream
}

// downgradeLocalModelsSnapshot strips diagnostic fields and maps newer codes to
// legacy equivalents when talking to an Agent Service that did not announce
// serviceFeatureLocalModelsDiagnostics.
func downgradeLocalModelsSnapshot(snapshot wire.LocalModelsSnapshot) wire.LocalModelsSnapshot {
	snapshot.Debug = nil
	if len(snapshot.Models) == 0 {
		return snapshot
	}
	models := make([]wire.LocalModel, len(snapshot.Models))
	for i, model := range snapshot.Models {
		if reason := model.Availability.Reason; reason != nil {
			legacy := &wire.LocalModelAvailabilityReason{Code: reason.Code, NeedBytes: reason.NeedBytes, HaveBytes: reason.HaveBytes}
			switch legacy.Code {
			case "MEMORY_INSUFFICIENT", "DISK_INSUFFICIENT", "PLATFORM_UNSUPPORTED":
			default:
				legacy.Code = "PLATFORM_UNSUPPORTED"
				legacy.NeedBytes, legacy.HaveBytes = nil, nil
			}
			model.Availability.Reason = legacy
		}
		if model.Error != nil {
			copied := *model.Error
			copied.Code = downgradeLocalModelErrorCode(copied.Code)
			model.Error = &copied
		}
		models[i] = model
	}
	snapshot.Models = models
	return snapshot
}

// stripLocalModelsEngine omits per-model engine metadata when talking to an
// Agent Service that did not announce serviceFeatureLocalModelsEngine.
func stripLocalModelsEngine(snapshot wire.LocalModelsSnapshot) wire.LocalModelsSnapshot {
	if len(snapshot.Models) == 0 {
		return snapshot
	}
	models := make([]wire.LocalModel, len(snapshot.Models))
	for i, model := range snapshot.Models {
		model.Engine = ""
		model.EngineLabel = ""
		model.Concurrency = nil
		model.HostRamBytes = nil
		models[i] = model
	}
	snapshot.Models = models
	return snapshot
}

// stripLocalModelsConcurrencyProbe omits per-model concurrency_probing when
// talking to an Agent Service that did not announce
// serviceFeatureLocalModelsConcurrencyProbe.
func stripLocalModelsConcurrencyProbe(snapshot wire.LocalModelsSnapshot) wire.LocalModelsSnapshot {
	if len(snapshot.Models) == 0 {
		return snapshot
	}
	models := make([]wire.LocalModel, len(snapshot.Models))
	for i, model := range snapshot.Models {
		model.ConcurrencyProbing = nil
		models[i] = model
	}
	snapshot.Models = models
	return snapshot
}

// stripLocalModelsExternalHolders omits pool external_holders when talking to
// an Agent Service that did not announce serviceFeatureLocalModelsExternalHolders.
func stripLocalModelsExternalHolders(snapshot wire.LocalModelsSnapshot) wire.LocalModelsSnapshot {
	if len(snapshot.Pools) == 0 {
		return snapshot
	}
	pools := make([]wire.LocalModelPool, len(snapshot.Pools))
	for i, pool := range snapshot.Pools {
		pool.ExternalHolders = nil
		pools[i] = pool
	}
	snapshot.Pools = pools
	return snapshot
}

func downgradeLocalModelActionRefusal(refusal wire.LocalModelActionRefusal) wire.LocalModelActionRefusal {
	switch refusal.Code {
	case "GPU_UNSUPPORTED", "DRIVER_UPDATE_REQUIRED", "RUNTIME_DEPENDENCY_MISSING":
		refusal.Code = "PLATFORM_UNSUPPORTED"
	case "UNKNOWN_ERROR":
		refusal.Code = "ENGINE_START_FAILED"
	}
	return refusal
}

func downgradeLocalModelErrorCode(code string) string {
	switch code {
	case "GPU_UNSUPPORTED", "DRIVER_UPDATE_REQUIRED", "RUNTIME_DEPENDENCY_MISSING":
		return "PLATFORM_UNSUPPORTED"
	case "UNKNOWN_ERROR":
		return "ENGINE_START_FAILED"
	default:
		return code
	}
}
