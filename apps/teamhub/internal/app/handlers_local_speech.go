package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

const localSpeechActionLifetime = 30 * time.Second

var (
	localSpeechModelIDPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$`)
	localSpeechLanguagePattern = regexp.MustCompile(`^(auto|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*)$`)
)

var localSpeechRefusalCodes = map[string]httpapi.LocalSpeechErrorCode{
	"TOOL_NOT_INSTALLED":   httpapi.LOCALSPEECHUNAVAILABLE,
	"SPEECH_UNSUPPORTED":   httpapi.LOCALSPEECHUNAVAILABLE,
	"TOOL_FAILED":          httpapi.LOCALSPEECHUNAVAILABLE,
	"MODEL_UNKNOWN":        httpapi.LOCALSPEECHMODELUNKNOWN,
	"INVALID_STATE":        httpapi.LOCALSPEECHINVALIDSTATE,
	"JOB_RUNNING":          httpapi.LOCALSPEECHJOBRUNNING,
	"DISK_INSUFFICIENT":    httpapi.LOCALSPEECHDISKINSUFFICIENT,
	"MEMORY_INSUFFICIENT":  httpapi.LOCALSPEECHMEMORYINSUFFICIENT,
	"PLATFORM_UNSUPPORTED": httpapi.LOCALSPEECHPLATFORMUNSUPPORTED,
}

var localSpeechErrorMessages = map[httpapi.LocalSpeechErrorCode]string{
	httpapi.LOCALCOMPUTEROFFLINE:           "Local Computer is offline",
	httpapi.LOCALSPEECHACTIONFORBIDDEN:     "Only the Computer's owner can change its local speech models",
	httpapi.LOCALSPEECHUNAVAILABLE:         "The Computer has no usable local speech runtime",
	httpapi.LOCALSPEECHMODELUNKNOWN:        "The Computer does not know this speech model",
	httpapi.LOCALSPEECHINVALIDSTATE:        "The speech model cannot do that in its current state",
	httpapi.LOCALSPEECHJOBRUNNING:          "The Computer is already working on a speech model job",
	httpapi.LOCALSPEECHDISKINSUFFICIENT:    "The Computer does not have enough disk space for this speech model",
	httpapi.LOCALSPEECHMEMORYINSUFFICIENT:  "The Computer does not have enough memory for this speech model",
	httpapi.LOCALSPEECHPLATFORMUNSUPPORTED: "This speech model does not run on this Computer",
	httpapi.LOCALSPEECHACTIONFAILED:        "The Computer could not start this speech action",
	httpapi.LOCALSPEECHACTIONUNCONFIRMED:   "The Computer did not confirm the speech action in time",
	httpapi.LOCALSPEECHSERVICEUNAVAILABLE:  "Local speech management is unavailable",
}

var localSpeechErrorStatuses = map[httpapi.LocalSpeechErrorCode]int{
	httpapi.LOCALCOMPUTEROFFLINE:          http.StatusServiceUnavailable,
	httpapi.LOCALSPEECHACTIONFORBIDDEN:    http.StatusForbidden,
	httpapi.LOCALSPEECHACTIONFAILED:       http.StatusBadGateway,
	httpapi.LOCALSPEECHACTIONUNCONFIRMED:  http.StatusGatewayTimeout,
	httpapi.LOCALSPEECHSERVICEUNAVAILABLE: http.StatusServiceUnavailable,
}

type storedLocalSpeechSnapshot struct {
	Available   bool                                      `json:"available"`
	Reason      *httpapi.LocalSpeechViewUnavailableReason `json:"reason"`
	ObservedAt  *time.Time                                `json:"observed_at"`
	ToolVersion *string                                   `json:"tool_version"`
	Config      *httpapi.LocalSpeechConfig                `json:"config"`
	Runtime     *httpapi.LocalSpeechRuntime               `json:"runtime"`
	Models      []httpapi.LocalSpeechModel                `json:"models"`
}

// getLocalComputerSpeech reads a Computer's last reported local speech snapshot
// for any member of its Tenant.
func (a *App) getLocalComputerSpeech(c *gin.Context) {
	tenantID, computerID := c.Param("tenantId"), c.Param("computerId")
	viewerID, ok := a.spaceHuman(c, tenantID)
	if !ok {
		return
	}
	if a.agentRuntimeState == nil {
		a.writeLocalSpeechError(c, httpapi.LOCALSPEECHSERVICEUNAVAILABLE)
		return
	}
	record, err := a.agentRuntimeState.LocalSpeech(c.Request.Context(), tenantID, viewerID, computerID)
	switch {
	case errors.Is(err, agentruntimestate.ErrNotFound), errors.Is(err, agentruntimestate.ErrInvalid):
		a.writeError(c, http.StatusNotFound, "LOCAL_COMPUTER_NOT_FOUND", "Local Computer was not found")
		return
	case err != nil:
		a.internalError(c, "read Local Computer speech status", err)
		return
	}
	view, err := localSpeechView(record, viewerID, time.Now())
	if err != nil {
		a.internalError(c, "project Local Computer speech status", err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, view)
}

func localSpeechView(record agentruntimestate.LocalSpeechRecord, viewerID string, now time.Time) (httpapi.LocalSpeechView, error) {
	view := httpapi.LocalSpeechView{
		Computer: httpapi.LocalModelsComputer{
			ComputerId:  record.ComputerID,
			DisplayName: record.DisplayName,
			Status:      httpapi.LocalModelsComputerOffline,
			LastSeenAt:  record.LastSeenAt,
		},
		ViewerIsOwner: record.Owner.OwnerActorID == viewerID,
		Models:        []httpapi.LocalSpeechModel{},
	}
	if localComputerOnline(record.Status, record.LastSeenAt, now) {
		view.Computer.Status = httpapi.LocalModelsComputerOnline
	}
	if len(record.Host) > 0 {
		var host httpapi.LocalModelHost
		if err := json.Unmarshal(record.Host, &host); err != nil {
			return httpapi.LocalSpeechView{}, err
		}
		view.Computer.Host = &host
	}
	if len(record.Snapshot) == 0 {
		view.Reason = &httpapi.LocalSpeechViewUnavailableReason{Code: httpapi.LocalSpeechViewNotReported}
		return view, nil
	}
	var snapshot storedLocalSpeechSnapshot
	if err := json.Unmarshal(record.Snapshot, &snapshot); err != nil {
		return httpapi.LocalSpeechView{}, err
	}
	view.Available = snapshot.Available
	view.Reason = snapshot.Reason
	view.ObservedAt = snapshot.ObservedAt
	view.ToolVersion = snapshot.ToolVersion
	view.Config = snapshot.Config
	view.Runtime = snapshot.Runtime
	if snapshot.Models != nil {
		view.Models = snapshot.Models
	}
	return view, nil
}

// refreshLocalComputerSpeech asks an owned online Computer to refresh its speech status.
func (a *App) refreshLocalComputerSpeech(c *gin.Context) {
	a.forwardLocalSpeechAction(c, roomagent.LocalSpeechActionCommand{Action: "refresh"}, func(computerID string) {
		c.JSON(http.StatusAccepted, httpapi.LocalSpeechRefreshAccepted{
			ComputerId: computerID,
			Action:     httpapi.LocalSpeechRefreshAcceptedRefresh,
		})
	})
}

// actOnLocalComputerSpeech forwards an owner-chosen speech action to their connected Computer.
func (a *App) actOnLocalComputerSpeech(c *gin.Context) {
	var request httpapi.LocalSpeechActionRequest
	if err := decodeJSON(c, &request); err != nil || !validLocalSpeechAction(request) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Local speech action is invalid")
		return
	}
	cmd := roomagent.LocalSpeechActionCommand{
		Action:            string(request.Action),
		UseGPU:            request.UseGpu,
		KeepLoadedSeconds: request.KeepLoadedSeconds,
		IncludeGPUEngine:  request.IncludeGpuEngine,
	}
	if request.ModelId != nil {
		cmd.ModelID = *request.ModelId
	}
	if request.Language != nil {
		cmd.Language = *request.Language
	}
	a.forwardLocalSpeechAction(c, cmd, func(computerID string) {
		c.JSON(http.StatusAccepted, httpapi.LocalSpeechActionAccepted{
			ComputerId: computerID,
			Action:     httpapi.LocalSpeechActionAcceptedAction(request.Action),
			ModelId:    request.ModelId,
		})
	})
}

func (a *App) forwardLocalSpeechAction(c *gin.Context, command roomagent.LocalSpeechActionCommand, onAccepted func(computerID string)) {
	tenantID, computerID := c.Param("tenantId"), c.Param("computerId")
	viewerID, ok := a.spaceHuman(c, tenantID)
	if !ok {
		return
	}
	speechGateway, hasGateway := a.localComputers.(roomagent.LocalSpeechManagement)
	if a.agentRuntimeState == nil || !hasGateway {
		a.writeLocalSpeechError(c, httpapi.LOCALSPEECHSERVICEUNAVAILABLE)
		return
	}
	computer, err := a.agentRuntimeState.GetLocalComputer(c.Request.Context(), computerID)
	switch {
	case errors.Is(err, agentruntimestate.ErrNotFound), errors.Is(err, agentruntimestate.ErrInvalid),
		err == nil && computer.Owner.TenantID != tenantID:
		a.writeError(c, http.StatusNotFound, "LOCAL_COMPUTER_NOT_FOUND", "Local Computer was not found")
		return
	case err != nil:
		a.internalError(c, "read Local Computer for a speech action", err)
		return
	}
	if computer.Owner.OwnerActorID != viewerID {
		a.writeLocalSpeechError(c, httpapi.LOCALSPEECHACTIONFORBIDDEN)
		return
	}
	if !localComputerOnline(computer.Status, computer.LastSeenAt, time.Now()) {
		a.writeLocalSpeechError(c, httpapi.LOCALCOMPUTEROFFLINE)
		return
	}
	command.TenantID = tenantID
	command.OwnerActorID = viewerID
	command.ComputerID = computerID
	command.RequestID = ids.New("local_speech_action")
	command.ExpiresAt = time.Now().UTC().Add(localSpeechActionLifetime)

	refusal, err := speechGateway.ActOnLocalSpeech(c.Request.Context(), command)
	switch {
	case err == nil && refusal == nil:
		onAccepted(computerID)
	case err == nil:
		code, known := localSpeechRefusalCodes[refusal.Code]
		if !known {
			a.logger.Warn("local_speech.action_refused", "computer_id", computerID, "action", command.Action, "refusal_code", refusal.Code)
			code = httpapi.LOCALSPEECHACTIONFAILED
		}
		a.writeLocalSpeechError(c, code)
	case errors.Is(err, roomagent.ErrLocalComputerNotFound):
		a.writeError(c, http.StatusNotFound, "LOCAL_COMPUTER_NOT_FOUND", "Local Computer was not found")
	case errors.Is(err, roomagent.ErrLocalComputerOffline):
		a.writeLocalSpeechError(c, httpapi.LOCALCOMPUTEROFFLINE)
	case errors.Is(err, roomagent.ErrLocalSpeechTimeout):
		a.writeLocalSpeechError(c, httpapi.LOCALSPEECHACTIONUNCONFIRMED)
	case errors.Is(err, roomagent.ErrLocalSpeechUnsupported):
		a.writeLocalSpeechError(c, httpapi.LOCALSPEECHUNAVAILABLE)
	default:
		a.logger.Error("local_speech.action_failed", "computer_id", computerID, "action", command.Action, "error", err)
		a.writeLocalSpeechError(c, httpapi.LOCALSPEECHSERVICEUNAVAILABLE)
	}
}

func validLocalSpeechAction(request httpapi.LocalSpeechActionRequest) bool {
	if !request.Action.Valid() {
		return false
	}
	if request.ModelId != nil && !localSpeechModelIDPattern.MatchString(*request.ModelId) {
		return false
	}
	if request.Language != nil && (len(*request.Language) > 32 || !localSpeechLanguagePattern.MatchString(*request.Language)) {
		return false
	}
	if request.KeepLoadedSeconds != nil && (*request.KeepLoadedSeconds < -1 || *request.KeepLoadedSeconds > 86400) {
		return false
	}
	switch request.Action {
	case httpapi.LocalSpeechActionRequestDownload,
		httpapi.LocalSpeechActionRequestCancel,
		httpapi.LocalSpeechActionRequestRemove,
		httpapi.LocalSpeechActionRequestLoad:
		return request.ModelId != nil && *request.ModelId != ""
	case httpapi.LocalSpeechActionRequestUnload:
		return true
	case httpapi.LocalSpeechActionRequestConfigure:
		return request.ModelId != nil || request.UseGpu != nil || request.KeepLoadedSeconds != nil || request.Language != nil
	default:
		return false
	}
}

func (a *App) writeLocalSpeechError(c *gin.Context, code httpapi.LocalSpeechErrorCode) {
	status, found := localSpeechErrorStatuses[code]
	if !found {
		status = http.StatusConflict
	}
	a.writeError(c, status, string(code), localSpeechErrorMessages[code])
}

// recordAgentRuntimeLocalSpeech stores a Computer's latest local speech snapshot
// forwarded by the Agent Service.
func (a *App) recordAgentRuntimeLocalSpeech(c *gin.Context) {
	var request teamhubinternal.RecordLocalSpeechRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	sanitizeLocalSpeechSnapshot(&request.Snapshot)
	if !validLocalSpeechSnapshot(request.Snapshot) {
		a.writeAgentRuntimeStateError(c, "decode Local Computer speech", agentruntimestate.ErrInvalid)
		return
	}
	snapshot, err := json.Marshal(request.Snapshot)
	if err != nil {
		a.writeAgentRuntimeStateError(c, "encode Local Computer speech", err)
		return
	}
	becameAvailable, err := a.recordLocalSpeechSnapshot(c.Request.Context(), agentruntimestate.RecordLocalSpeechInput{
		ComputerID: request.ComputerId,
		Snapshot:   snapshot,
		ObservedAt: request.Snapshot.ObservedAt,
	})
	if a.writeAgentRuntimeStateError(c, "record Local Computer speech", err) {
		return
	}
	// Wake Node Services voice workers best-effort only when local speech
	// transitions from absent/unavailable to available, not on every progress
	// refresh during downloads.
	if becameAvailable {
		go a.awaitVoiceWorkers(context.Background())
	}
	c.Status(http.StatusNoContent)
}

func (a *App) recordLocalSpeechSnapshot(ctx context.Context, input agentruntimestate.RecordLocalSpeechInput) (bool, error) {
	if a.recordLocalSpeech != nil {
		return a.recordLocalSpeech(ctx, input)
	}
	return a.agentRuntimeState.RecordLocalSpeech(ctx, input)
}

func sanitizeLocalSpeechSnapshot(snapshot *teamhubinternal.LocalSpeechSnapshot) {
	if snapshot.Config != nil {
		if snapshot.Config.KeepLoadedSeconds < -1 || snapshot.Config.KeepLoadedSeconds > 86400 {
			snapshot.Config.KeepLoadedSeconds = 900
		}
		if !localSpeechLanguagePattern.MatchString(snapshot.Config.Language) {
			snapshot.Config.Language = "auto"
		}
		if snapshot.Config.ModelId != nil && !localSpeechModelIDPattern.MatchString(*snapshot.Config.ModelId) {
			snapshot.Config.ModelId = nil
		}
	}
	if snapshot.Runtime != nil {
		rt := snapshot.Runtime
		if !rt.State.Valid() {
			rt.State = teamhubinternal.LocalSpeechRuntimeStateError
		}
		if !rt.RequestedDevice.Valid() {
			rt.RequestedDevice = teamhubinternal.LocalSpeechRequestedDeviceCpu
		}
		if rt.Engine != nil && !rt.Engine.Valid() {
			rt.Engine = nil
		}
		if rt.EffectiveDevice != nil && !rt.EffectiveDevice.Valid() {
			rt.EffectiveDevice = nil
		}
		if rt.FallbackReason != nil && !rt.FallbackReason.Valid() {
			rt.FallbackReason = nil
		}
		if rt.KeepLoadedSeconds < -1 || rt.KeepLoadedSeconds > 86400 {
			rt.KeepLoadedSeconds = 900
		}
	}
	for i := range snapshot.Models {
		model := &snapshot.Models[i]
		if model.Download != nil && !model.Download.Step.Valid() {
			model.Download.Step = teamhubinternal.LocalSpeechDownloadStepDownload
		}
	}
}

func validLocalSpeechSnapshot(snapshot teamhubinternal.LocalSpeechSnapshot) bool {
	if snapshot.ObservedAt.IsZero() || len(snapshot.Models) > 64 ||
		snapshot.Available != (snapshot.Reason == nil) ||
		(snapshot.Reason != nil && !snapshot.Reason.Code.Valid()) {
		return false
	}
	seen := make(map[string]bool, len(snapshot.Models))
	for _, model := range snapshot.Models {
		if !localSpeechModelIDPattern.MatchString(model.Id) || seen[model.Id] ||
			!model.Engine.Valid() || !model.QualityRating.Valid() || !model.State.Valid() {
			return false
		}
		seen[model.Id] = true
	}
	return true
}
