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

// serviceFeatureLocalModelsStorage in runner.welcome's service_features says
// the Agent Service accepts host.models_dir, host.models_dir_exists, and
// per-model storage on LocalModelsSnapshot frames. Older services close the
// connection on unknown host or model properties.
const serviceFeatureLocalModelsStorage = "local_models_storage"

// serviceFeatureLocalModelsCustom in runner.welcome's service_features says
// the Agent Service accepts custom hub models (origin, custom, verification,
// download shard_index/shard_count, mlx engine, host.supported_formats, and
// custom hub error codes) and execute kind local_models_custom.
const serviceFeatureLocalModelsCustom = "local_models_custom"

// serviceFeatureLocalModelUnavailable in runner.welcome's service_features
// says the Agent Service accepts the local_model_unavailable Run failure
// code. An older service rejects the frame, so the Daemon reports
// model_unavailable to it instead.
const serviceFeatureLocalModelUnavailable = "local_model_unavailable"

// serviceFeatureModelGatewayUnavailable in runner.welcome's service_features
// says the Agent Service accepts the model_gateway_unavailable Run failure
// code. An older service rejects the frame, so the Daemon reports
// execution_failed to it instead.
const serviceFeatureModelGatewayUnavailable = "model_gateway_unavailable"

// serviceFeatureRuntimeFailureDetail in runner.welcome's service_features says
// the Agent Service accepts the optional detail property on
// RuntimeExecutionFailure. Older services reject unknown properties on that
// object, so the Daemon omits detail when absent.
const serviceFeatureRuntimeFailureDetail = "runtime_failure_detail"

// serviceFeatureOperationBackgroundWait in runner.welcome's service_features
// says the Agent Service accepts run.background_waiting and
// run.background_resumed Operation events.
const serviceFeatureOperationBackgroundWait = "operation_background_wait"

// serviceFeatureDynamicReasoningEfforts in runner.welcome's service_features
// says the Agent Service accepts reasoning effort tokens beyond the legacy
// seven-value set in runtime diagnostics and model source status.
const serviceFeatureDynamicReasoningEfforts = "dynamic_reasoning_efforts"

// serviceFeatureLocalModelsAdmissionV2 in runner.welcome's service_features
// says the Agent Service accepts elastic admission metadata on LocalModel,
// LocalModelError, and LocalModelActionRefusal rows. Older services close the
// connection on unknown properties.
const serviceFeatureLocalModelsAdmissionV2 = "local_models_admission_v2"

// serviceFeatureLocalModelLoadingStatus in runner.welcome's service_features
// says the Agent Service accepts pre-run.started status.changed events carrying
// stage loading_local_model while EnsureLoaded wakes a standby model.
const serviceFeatureLocalModelLoadingStatus = "local_model_loading_status"

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
	// WillLoad reports whether EnsureLoaded will load or wait on a load for
	// piModel before the Runtime can start.
	WillLoad(piModel string) bool
	// IsStandbyModel reports whether piModel names a known local library model
	// that is currently unloaded or otherwise not loaded.
	IsStandbyModel(piModel string) bool
	// IsLoadedHealthy reports whether piModel can answer without waking a
	// standby local model.
	IsLoadedHealthy(ctx context.Context, piModel string) bool
	// AcquireUse holds an active use lease for piModel until the returned
	// release callback runs, preventing idle auto-unload while work runs.
	AcquireUse(piModel string) func()
}

// willLoadLocalModel reports whether a Pi Run targeting model will trigger a
// local model load before the Runtime starts.
func (d *Daemon) willLoadLocalModel(runtimeType, model string) bool {
	if d.localModels == nil || runtimeType != "pi" || model == "" {
		return false
	}
	return d.localModels.WillLoad(model)
}

// acquireLocalModelUse holds an active use lease on a Pi local model while a
// Run or model_invoke executes. A Pi call that names no model holds every
// loaded library model, since Pi answers it with whichever one is loaded.
func (d *Daemon) acquireLocalModelUse(runtimeType, model string) func() {
	if d.localModels == nil || runtimeType != "pi" {
		return func() {}
	}
	return d.localModels.AcquireUse(model)
}

// isLocalModelStandby reports whether a Pi Runtime request targets a known
// standby local library model that is not loaded.
func (d *Daemon) isLocalModelStandby(runtimeType, model string) bool {
	if d.localModels == nil || runtimeType != "pi" || model == "" {
		return false
	}
	return d.localModels.IsStandbyModel(model)
}

// isLocalModelLoadedHealthy reports whether a Pi Runtime model_invoke with
// wake_local_model=false can run without loading a standby local model.
func (d *Daemon) isLocalModelLoadedHealthy(ctx context.Context, runtimeType, model string) bool {
	if d.localModels == nil || runtimeType != "pi" || model == "" {
		return true
	}
	return d.localModels.IsLoadedHealthy(ctx, model)
}

// customLocalModelLibrary is an optional extension implemented by
// *localmodels.Library for custom hub search/probe and dynamic model ID
// reporting on custom_download.
type customLocalModelLibrary interface {
	ActWithResult(ctx context.Context, action localmodels.Action, deadline time.Time) (modelID string, refusal *wire.LocalModelActionRefusal, answered bool)
	SearchCustom(ctx context.Context, input wire.LocalModelCustomSearchInput) (wire.LocalModelCustomSearchResult, error)
	ProbeCustom(ctx context.Context, input wire.LocalModelCustomProbeInput) (wire.LocalModelCustomProbeResult, error)
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
	if !d.localModelsCustom.Load() {
		snapshot = stripLocalModelsCustom(snapshot)
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
	if !d.localModelsStorage.Load() {
		snapshot = stripLocalModelsStorage(snapshot)
	}
	if !d.localModelsAdmissionV2.Load() {
		snapshot = stripLocalModelsAdmissionV2(snapshot)
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
	action := localmodels.Action{
		Name:           request.Action,
		Model:          request.ModelID,
		UnloadFirst:    request.UnloadFirst,
		CustomDownload: request.CustomDownload,
	}
	if request.Force != nil {
		action.Force = *request.Force
	}
	if request.ContextTokens != nil {
		action.ContextTokens = *request.ContextTokens
	}
	acceptedModelID := request.ModelID
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
		if customLib, ok := d.localModels.(customLocalModelLibrary); ok {
			acceptedModelID, refusal, answered = customLib.ActWithResult(ctx, action, expiresAt)
		} else {
			refusal, answered = d.localModels.Act(ctx, action, expiresAt)
		}
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
		Action: request.Action, ModelID: acceptedModelID, Outcome: wire.OutcomeAccepted,
	}
	if refusal != nil {
		wireRefusal := *refusal
		if !d.localModelsCustom.Load() {
			wireRefusal = downgradeLocalModelsCustomRefusal(wireRefusal)
		}
		if !d.localModelsDiagnostics.Load() {
			wireRefusal = downgradeLocalModelActionRefusal(wireRefusal)
		}
		if !d.localModelsAdmissionV2.Load() {
			wireRefusal = stripLocalModelActionRefusalAdmissionV2(wireRefusal)
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

func (d *Daemon) handleLocalModelsCustomCommand(ctx context.Context, stream transport.Stream, command protocol.Command) error {
	var request wire.CapabilityLocalModelsCustom
	if err := json.Unmarshal(command.Payload, &request); err != nil {
		return errors.New("invalid local models custom command")
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, request.ExpiresAt)
	if err != nil {
		return errors.New("invalid local models custom command expiry")
	}
	sendFailed := func(code, message string, retryable bool) error {
		frame := wire.CapabilityLocalModelsCustomFailed{
			ProtocolVersion: request.ProtocolVersion,
			CommandID:       request.CommandID,
			RunnerID:        request.RunnerID,
			TenantID:        request.TenantID,
			OwnerActorID:    request.OwnerActorID,
			ConnectionEpoch: request.ConnectionEpoch,
			ExpiresAt:       request.ExpiresAt,
			Type:            wire.TypeExecuted,
			Kind:            wire.KindLocalModelsCustom,
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
			Type:            protocol.EventCapabilityLocalModelsCustomFailed,
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
		return sendFailed("LOCAL_MODEL_ACTION_FORBIDDEN", "This Computer does not belong to the owner.", false)
	case !expiresAt.After(time.Now()):
		return sendFailed("LOCAL_MODELS_CUSTOM_EXPIRED", "The custom model request expired; try again.", true)
	case d.localModels == nil:
		return sendFailed(localmodels.CodeToolNotInstalled, "The localmodels tool is not installed on this Computer.", false)
	}
	customLib, ok := d.localModels.(customLocalModelLibrary)
	if !ok {
		return sendFailed(localmodels.CodeToolFailed, "Custom local model actions are unavailable on this Computer.", false)
	}
	commandCtx, cancel := context.WithDeadline(ctx, expiresAt)
	defer cancel()

	var searchResult *wire.LocalModelCustomSearchResult
	var probeResult *wire.LocalModelCustomProbeResult
	var actionErr error

	switch request.Action {
	case "search":
		input := wire.LocalModelCustomSearchInput{}
		if request.Search != nil {
			input = *request.Search
		}
		res, err := customLib.SearchCustom(commandCtx, input)
		if err != nil {
			actionErr = err
		} else {
			searchResult = &res
		}
	case "probe":
		if request.Probe == nil || request.Probe.Target == "" {
			return sendFailed("INVALID_REPO_SPEC", "A custom repository target is required.", false)
		}
		res, err := customLib.ProbeCustom(commandCtx, *request.Probe)
		if err != nil {
			actionErr = err
		} else {
			probeResult = &res
		}
	default:
		return sendFailed("INVALID_REPO_SPEC", "Unsupported custom local model action.", false)
	}
	if actionErr != nil {
		var typed *localmodels.CustomHubError
		if errors.As(actionErr, &typed) {
			slog.Warn("local_models_custom.command_refused", "action", request.Action, "code", typed.Code)
			return sendFailed(typed.Code, typed.Message, typed.Retryable)
		}
		slog.Warn("local_models_custom.command_failed", "action", request.Action)
		return sendFailed(localmodels.CodeToolFailed, "Could not complete the custom local model request on this Computer.", true)
	}
	frame := wire.CapabilityLocalModelsCustomSucceeded{
		ProtocolVersion: request.ProtocolVersion,
		CommandID:       request.CommandID,
		RunnerID:        request.RunnerID,
		TenantID:        request.TenantID,
		OwnerActorID:    request.OwnerActorID,
		ConnectionEpoch: request.ConnectionEpoch,
		ExpiresAt:       request.ExpiresAt,
		Type:            wire.TypeExecuted,
		Kind:            wire.KindLocalModelsCustom,
		Action:          request.Action,
		Outcome:         wire.OutcomeSucceeded,
		SearchResult:    searchResult,
		ProbeResult:     probeResult,
	}
	payload, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	return stream.Send(ctx, protocol.Event{
		Type:            protocol.EventCapabilityLocalModelsCustomSucceeded,
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

// validLocalModelAction checks what the wire schema requires, so no value
// the tool would read as an option reaches its command line.
func validLocalModelAction(action localmodels.Action) bool {
	switch action.Name {
	case localmodels.ActionRefresh:
		return action.Model == "" && len(action.UnloadFirst) == 0 && !action.Force && action.ContextTokens == 0 && action.CustomDownload == nil
	case localmodels.ActionCustomDownload:
		if action.Model != "" || len(action.UnloadFirst) != 0 || action.Force || action.ContextTokens != 0 || action.CustomDownload == nil {
			return false
		}
		in := action.CustomDownload
		return (in.Hub == "huggingface" || in.Hub == "modelscope") && in.RepoID != "" && in.VariantID != ""
	case localmodels.ActionSmokeTest:
		return localmodels.ValidModelID(action.Model) && len(action.UnloadFirst) == 0 && !action.Force && action.CustomDownload == nil &&
			(action.ContextTokens == 0 || action.ContextTokens == 2048 || action.ContextTokens == 4096)
	case localmodels.ActionDownload, localmodels.ActionCancel, localmodels.ActionUnload, localmodels.ActionRemove:
		return localmodels.ValidModelID(action.Model) && len(action.UnloadFirst) == 0 && !action.Force && action.ContextTokens == 0 && action.CustomDownload == nil
	case localmodels.ActionLoad:
		if !localmodels.ValidModelID(action.Model) || action.CustomDownload != nil {
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

// stripLocalModelsCustom removes custom hub fields, shard progress counters,
// mlx engine values, host supported_formats, and custom error codes when
// talking to an Agent Service that did not announce serviceFeatureLocalModelsCustom.
func stripLocalModelsCustom(snapshot wire.LocalModelsSnapshot) wire.LocalModelsSnapshot {
	if snapshot.Host != nil && len(snapshot.Host.SupportedFormats) > 0 {
		hostCopy := *snapshot.Host
		hostCopy.SupportedFormats = nil
		snapshot.Host = &hostCopy
	}
	if len(snapshot.Models) == 0 {
		return snapshot
	}
	models := make([]wire.LocalModel, len(snapshot.Models))
	for i, model := range snapshot.Models {
		model.Origin = ""
		model.Custom = nil
		model.Verification = nil
		if model.Engine == "mlx" {
			model.Engine = ""
		}
		if model.Download != nil && (model.Download.ShardIndex != nil || model.Download.ShardCount != nil) {
			dlCopy := *model.Download
			dlCopy.ShardIndex = nil
			dlCopy.ShardCount = nil
			model.Download = &dlCopy
		}
		if model.Error != nil && isCustomLocalModelErrorCode(model.Error.Code) {
			errCopy := *model.Error
			errCopy.Code = "UNKNOWN_ERROR"
			model.Error = &errCopy
		}
		models[i] = model
	}
	snapshot.Models = models
	return snapshot
}

// stripLocalModelsStorage omits host.models_dir, host.models_dir_exists, and
// per-model storage without mutating caller-owned pointers or slices when
// talking to an Agent Service that did not announce
// serviceFeatureLocalModelsStorage.
func stripLocalModelsStorage(snapshot wire.LocalModelsSnapshot) wire.LocalModelsSnapshot {
	if snapshot.Host != nil {
		host := *snapshot.Host
		host.ModelsDir = ""
		host.ModelsDirExists = nil
		snapshot.Host = &host
	}
	if len(snapshot.Models) > 0 {
		models := make([]wire.LocalModel, len(snapshot.Models))
		for i, model := range snapshot.Models {
			model.Storage = nil
			models[i] = model
		}
		snapshot.Models = models
	}
	return snapshot
}

// stripLocalModelsAdmissionV2 omits elastic admission metadata when talking to
// an Agent Service that did not announce serviceFeatureLocalModelsAdmissionV2.
func stripLocalModelsAdmissionV2(snapshot wire.LocalModelsSnapshot) wire.LocalModelsSnapshot {
	if len(snapshot.Models) == 0 {
		return snapshot
	}
	models := make([]wire.LocalModel, len(snapshot.Models))
	for i, model := range snapshot.Models {
		model.MinimumMemoryBytes = nil
		model.Degraded = nil
		model.RequestedPosture = nil
		model.EffectivePosture = nil
		model.DegradationReason = ""
		model.MemoryPressureWarning = nil
		model.OomRetries = nil
		model.Forced = nil
		if model.Error != nil {
			copied := *model.Error
			copied.Pool = ""
			copied.NeedBytes = nil
			copied.FreeBytes = nil
			copied.ShortfallBytes = nil
			copied.CanForce = nil
			model.Error = &copied
		}
		models[i] = model
	}
	snapshot.Models = models
	return snapshot
}

// stripLocalModelActionRefusalAdmissionV2 omits elastic admission refusal
// fields when talking to an Agent Service without local_models_admission_v2.
func stripLocalModelActionRefusalAdmissionV2(refusal wire.LocalModelActionRefusal) wire.LocalModelActionRefusal {
	refusal.ShortfallBytes = nil
	refusal.CanForce = nil
	return refusal
}

func isCustomLocalModelErrorCode(code string) bool {
	switch code {
	case "HUB_AUTH_REQUIRED", "HUB_FORBIDDEN", "HUB_REPO_NOT_FOUND",
		"HUB_FORMAT_UNSUPPORTED", "HUB_UNREACHABLE",
		"UNSUPPORTED_ARCHITECTURE", "CORRUPT_WEIGHTS":
		return true
	default:
		return false
	}
}

func downgradeLocalModelsCustomRefusal(refusal wire.LocalModelActionRefusal) wire.LocalModelActionRefusal {
	if isCustomLocalModelErrorCode(refusal.Code) {
		refusal.Code = "UNKNOWN_ERROR"
	}
	return refusal
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
