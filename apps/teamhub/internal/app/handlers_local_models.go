package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentregistry"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// localModelActionLifetime bounds how long the Computer may take to accept
// an action; it matches the Agent Service's 30-second ack budget and stays
// inside HTTPGateway's local-models client timeout.
const localModelActionLifetime = 30 * time.Second

var (
	localModelIDPattern        = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$`)
	localModelPoolIDPattern    = regexp.MustCompile(`^(gpu:(0|[1-9][0-9]{0,2})|system|unified)$`)
	localModelSourceURLPattern = regexp.MustCompile(`^https://[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+$`)
)

// localModelRefusalCodes maps the Computer's refusals a Human can act on to
// their own public code; every other refusal is LOCAL_MODEL_ACTION_FAILED.
var localModelRefusalCodes = map[string]httpapi.LocalModelsErrorCode{
	"TOOL_NOT_INSTALLED":         httpapi.LocalModelsErrorCodeLOCALMODELSUNAVAILABLE,
	"TOOL_FAILED":                httpapi.LocalModelsErrorCodeLOCALMODELSUNAVAILABLE,
	"MODEL_UNKNOWN":              httpapi.LocalModelsErrorCodeLOCALMODELUNKNOWN,
	"INVALID_STATE":              httpapi.LocalModelsErrorCodeLOCALMODELINVALIDSTATE,
	"JOB_RUNNING":                httpapi.LocalModelsErrorCodeLOCALMODELJOBRUNNING,
	"LOAD_NO_ROOM":               httpapi.LocalModelsErrorCodeLOCALMODELNOROOM,
	"MEMORY_INSUFFICIENT":        httpapi.LocalModelsErrorCodeLOCALMODELMEMORYINSUFFICIENT,
	"DISK_INSUFFICIENT":          httpapi.LocalModelsErrorCodeLOCALMODELDISKINSUFFICIENT,
	"PLATFORM_UNSUPPORTED":       httpapi.LocalModelsErrorCodeLOCALMODELPLATFORMUNSUPPORTED,
	"GPU_UNSUPPORTED":            httpapi.LocalModelsErrorCodeLOCALMODELGPUUNSUPPORTED,
	"DRIVER_UPDATE_REQUIRED":     httpapi.LocalModelsErrorCodeLOCALMODELDRIVERUPDATEREQUIRED,
	"RUNTIME_DEPENDENCY_MISSING": httpapi.LocalModelsErrorCodeLOCALMODELRUNTIMEDEPENDENCYMISSING,
	"HUB_AUTH_REQUIRED":          httpapi.LocalModelsErrorCodeLOCALMODELHUBAUTHREQUIRED,
	"HUB_FORBIDDEN":              httpapi.LocalModelsErrorCodeLOCALMODELHUBFORBIDDEN,
	"HUB_REPO_NOT_FOUND":         httpapi.LocalModelsErrorCodeLOCALMODELHUBREPONOTFOUND,
	"HUB_FORMAT_UNSUPPORTED":     httpapi.LocalModelsErrorCodeLOCALMODELHUBFORMATUNSUPPORTED,
	"HUB_UNREACHABLE":            httpapi.LocalModelsErrorCodeLOCALMODELHUBUNREACHABLE,
	"NETWORK_UNAVAILABLE":        httpapi.LocalModelsErrorCodeLOCALMODELHUBUNREACHABLE,
	"UNSUPPORTED_ARCHITECTURE":   httpapi.LocalModelsErrorCodeLOCALMODELUNSUPPORTEDARCHITECTURE,
	"CORRUPT_WEIGHTS":            httpapi.LocalModelsErrorCodeLOCALMODELCORRUPTWEIGHTS,
}

var localModelsErrorMessages = map[httpapi.LocalModelsErrorCode]string{
	httpapi.LocalModelsErrorCodeLOCALCOMPUTEROFFLINE:               "Local Computer is offline",
	httpapi.LocalModelsErrorCodeLOCALMODELACTIONFORBIDDEN:          "Only the Computer's owner can change its models",
	httpapi.LocalModelsErrorCodeLOCALMODELSUNAVAILABLE:             "The Computer has no usable model library",
	httpapi.LocalModelsErrorCodeLOCALMODELSCUSTOMUNSUPPORTED:       "Update Linger on this Computer to install custom hub models",
	httpapi.LocalModelsErrorCodeLOCALMODELUNKNOWN:                  "The Computer does not know this model",
	httpapi.LocalModelsErrorCodeLOCALMODELINVALIDSTATE:             "The model cannot do that in its current state",
	httpapi.LocalModelsErrorCodeLOCALMODELJOBRUNNING:               "The Computer is already working on this model",
	httpapi.LocalModelsErrorCodeLOCALMODELNOROOM:                   "There is not enough free memory to load this model",
	httpapi.LocalModelsErrorCodeLOCALMODELMEMORYINSUFFICIENT:       "The Computer does not have enough memory for this model",
	httpapi.LocalModelsErrorCodeLOCALMODELDISKINSUFFICIENT:         "The Computer does not have enough disk space for this model",
	httpapi.LocalModelsErrorCodeLOCALMODELPLATFORMUNSUPPORTED:      "The model does not run on this Computer",
	httpapi.LocalModelsErrorCodeLOCALMODELGPUUNSUPPORTED:           "This Computer's GPU is not supported for local models",
	httpapi.LocalModelsErrorCodeLOCALMODELDRIVERUPDATEREQUIRED:     "Update the NVIDIA driver on this Computer to run local models",
	httpapi.LocalModelsErrorCodeLOCALMODELRUNTIMEDEPENDENCYMISSING: "This Computer is missing required system runtime libraries for local models",
	httpapi.LocalModelsErrorCodeLOCALMODELHUBAUTHREQUIRED:          "The model hub requires an access token for this repository",
	httpapi.LocalModelsErrorCodeLOCALMODELHUBFORBIDDEN:             "Access to this hub repository was denied",
	httpapi.LocalModelsErrorCodeLOCALMODELHUBREPONOTFOUND:          "The requested repository was not found on the model hub",
	httpapi.LocalModelsErrorCodeLOCALMODELHUBFORMATUNSUPPORTED:     "This repository format is not supported on this Computer",
	httpapi.LocalModelsErrorCodeLOCALMODELHUBUNREACHABLE:           "The Computer could not reach the model hub",
	httpapi.LocalModelsErrorCodeLOCALMODELUNSUPPORTEDARCHITECTURE:  "This model architecture is not supported by the installed inference engine",
	httpapi.LocalModelsErrorCodeLOCALMODELCORRUPTWEIGHTS:           "The downloaded model weights appear corrupted",
	httpapi.LocalModelsErrorCodeLOCALMODELACTIONFAILED:             "The Computer could not start this action",
	httpapi.LocalModelsErrorCodeLOCALMODELACTIONUNCONFIRMED:        "The Computer did not confirm the action in time",
	httpapi.LocalModelsErrorCodeLOCALMODELSSERVICEUNAVAILABLE:      "Local models are unavailable",
}

var localModelsErrorStatuses = map[httpapi.LocalModelsErrorCode]int{
	httpapi.LocalModelsErrorCodeLOCALCOMPUTEROFFLINE:          http.StatusServiceUnavailable,
	httpapi.LocalModelsErrorCodeLOCALMODELACTIONFORBIDDEN:     http.StatusForbidden,
	httpapi.LocalModelsErrorCodeLOCALMODELHUBUNREACHABLE:      http.StatusBadGateway,
	httpapi.LocalModelsErrorCodeLOCALMODELACTIONFAILED:        http.StatusBadGateway,
	httpapi.LocalModelsErrorCodeLOCALMODELACTIONUNCONFIRMED:   http.StatusGatewayTimeout,
	httpapi.LocalModelsErrorCodeLOCALMODELSSERVICEUNAVAILABLE: http.StatusServiceUnavailable,
}

// storedLocalModelsSnapshot reads a stored snapshot into the public shapes,
// which match the internal ones field for field.
type storedLocalModelsSnapshot struct {
	Available   bool                                      `json:"available"`
	Reason      *httpapi.LocalModelsViewUnavailableReason `json:"reason"`
	ObservedAt  *time.Time                                `json:"observed_at"`
	ToolVersion *string                                   `json:"tool_version"`
	Pools       []httpapi.LocalModelPool                  `json:"pools"`
	Models      []httpapi.LocalModel                      `json:"models"`
	Debug       *httpapi.LocalModelsDebugInfo             `json:"debug,omitempty"`
}

// getLocalComputerModels shows a Computer's last reported model library to
// any member of its Tenant; only the owner may act on it.
func (a *App) getLocalComputerModels(c *gin.Context) {
	tenantID, computerID := c.Param("tenantId"), c.Param("computerId")
	viewerID, ok := a.spaceHuman(c, tenantID)
	if !ok {
		return
	}
	if a.agentRuntimeState == nil {
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALMODELSSERVICEUNAVAILABLE)
		return
	}
	record, err := a.agentRuntimeState.LocalModels(c.Request.Context(), tenantID, viewerID, computerID)
	switch {
	case errors.Is(err, agentruntimestate.ErrNotFound), errors.Is(err, agentruntimestate.ErrInvalid):
		a.writeError(c, http.StatusNotFound, "LOCAL_COMPUTER_NOT_FOUND", "Local Computer was not found")
		return
	case err != nil:
		a.internalError(c, "read Local Computer models", err)
		return
	}
	view, err := localModelsView(record, viewerID, time.Now())
	if err != nil {
		a.internalError(c, "project Local Computer models", err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, view)
}

func localModelsView(record agentruntimestate.LocalModelsRecord, viewerID string, now time.Time) (httpapi.LocalModelsView, error) {
	view := httpapi.LocalModelsView{
		Computer: httpapi.LocalModelsComputer{
			ComputerId: record.ComputerID, DisplayName: record.DisplayName,
			Status: httpapi.LocalModelsComputerOffline, LastSeenAt: record.LastSeenAt,
		},
		ViewerIsOwner: record.Owner.OwnerActorID == viewerID,
		Pools:         []httpapi.LocalModelPool{}, Models: []httpapi.LocalModelView{},
	}
	if localComputerOnline(record.Status, record.LastSeenAt, now) {
		view.Computer.Status = httpapi.LocalModelsComputerOnline
	}
	if len(record.Host) > 0 {
		var host httpapi.LocalModelHost
		if err := json.Unmarshal(record.Host, &host); err != nil {
			return httpapi.LocalModelsView{}, err
		}
		if !view.ViewerIsOwner {
			host.ModelsDir = nil
			host.ModelsDirExists = nil
		}
		view.Computer.Host = &host
	}
	if len(record.Snapshot) == 0 {
		view.Reason = &httpapi.LocalModelsViewUnavailableReason{Code: httpapi.LocalModelsViewNotReported}
		return view, nil
	}
	var snapshot storedLocalModelsSnapshot
	if err := json.Unmarshal(record.Snapshot, &snapshot); err != nil {
		return httpapi.LocalModelsView{}, err
	}
	view.Available, view.Reason, view.ObservedAt, view.ToolVersion = snapshot.Available, snapshot.Reason, snapshot.ObservedAt, snapshot.ToolVersion
	if snapshot.Debug != nil {
		debugCopy := *snapshot.Debug
		if !view.ViewerIsOwner {
			debugCopy.ConfigPath = nil
		}
		view.Debug = &debugCopy
	}
	if snapshot.Pools != nil {
		view.Pools = snapshot.Pools
	}
	for _, model := range snapshot.Models {
		users := []httpapi.LocalModelUser{}
		// An Agent on runtime pi stores the model's pi_model, which the model
		// keeps while it is on the Computer, loaded or not.
		if model.PiModel != nil {
			for _, user := range record.Users {
				if user.RuntimeModel == *model.PiModel {
					users = append(users, httpapi.LocalModelUser{AgentId: user.AgentID, Name: user.Name})
				}
			}
		}
		// Host filesystem paths belong to the owner's machine; only they see them.
		if !view.ViewerIsOwner {
			if model.Error != nil {
				errCopy := *model.Error
				errCopy.Path = nil
				model.Error = &errCopy
			}
			model.Storage = nil
			if model.Verification != nil && model.Verification.Failure != nil && model.Verification.Failure.DiagnosticLog != nil {
				verCopy := *model.Verification
				failCopy := *model.Verification.Failure
				failCopy.DiagnosticLog = nil
				verCopy.Failure = &failCopy
				model.Verification = &verCopy
			}
		}
		view.Models = append(view.Models, httpapi.LocalModelView{Model: model, UsedBy: users})
	}
	return view, nil
}

// localComputerOnline applies the Computers page rule: online only while the
// Runner Gateway's last observation is fresh.
func localComputerOnline(status string, lastSeenAt *time.Time, now time.Time) bool {
	return status == "online" && lastSeenAt != nil && !lastSeenAt.After(now) &&
		now.Sub(*lastSeenAt) <= agentregistry.LocalComputerObservationFreshness
}

// actOnLocalComputerModel forwards the owner's action to their connected
// Computer and answers with the Computer's immediate accept or refusal.
func (a *App) actOnLocalComputerModel(c *gin.Context) {
	var request httpapi.LocalModelActionRequest
	modelID := c.Param("modelId")
	if err := decodeJSON(c, &request); err != nil || !validLocalModelAction(modelID, request) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Local model action is invalid")
		return
	}
	var unloadFirst []string
	if request.UnloadFirst != nil {
		unloadFirst = *request.UnloadFirst
	}
	a.forwardLocalModelAction(c, string(request.Action), modelID, unloadFirst, request.Force, request.ContextTokens, func(computerID string) {
		c.JSON(http.StatusAccepted, httpapi.LocalModelActionAccepted{
			ComputerId: computerID, ModelId: modelID, Action: httpapi.LocalModelActionAcceptedAction(request.Action),
		})
	})
}

// refreshLocalComputerModels asks an owned connected Computer to recheck
// free memory and models and report a fresh library snapshot.
func (a *App) refreshLocalComputerModels(c *gin.Context) {
	a.forwardLocalModelAction(c, "refresh", "", nil, nil, nil, func(computerID string) {
		c.JSON(http.StatusAccepted, httpapi.LocalModelsRefreshAccepted{
			ComputerId: computerID, Action: httpapi.LocalModelsRefreshAcceptedRefresh,
		})
	})
}

func (a *App) ownedOnlineLocalModelsComputer(c *gin.Context) (agentruntimestate.LocalComputer, string, bool) {
	tenantID, computerID := c.Param("tenantId"), c.Param("computerId")
	viewerID, ok := a.spaceHuman(c, tenantID)
	if !ok {
		return agentruntimestate.LocalComputer{}, "", false
	}
	if a.agentRuntimeState == nil || a.localComputers == nil {
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALMODELSSERVICEUNAVAILABLE)
		return agentruntimestate.LocalComputer{}, "", false
	}
	computer, err := a.agentRuntimeState.GetLocalComputer(c.Request.Context(), computerID)
	switch {
	case errors.Is(err, agentruntimestate.ErrNotFound), errors.Is(err, agentruntimestate.ErrInvalid),
		err == nil && computer.Owner.TenantID != tenantID:
		a.writeError(c, http.StatusNotFound, "LOCAL_COMPUTER_NOT_FOUND", "Local Computer was not found")
		return agentruntimestate.LocalComputer{}, "", false
	case err != nil:
		a.internalError(c, "read Local Computer for a model action", err)
		return agentruntimestate.LocalComputer{}, "", false
	}
	if computer.Owner.OwnerActorID != viewerID {
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALMODELACTIONFORBIDDEN)
		return agentruntimestate.LocalComputer{}, "", false
	}
	if !localComputerOnline(computer.Status, computer.LastSeenAt, time.Now()) {
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALCOMPUTEROFFLINE)
		return agentruntimestate.LocalComputer{}, "", false
	}
	return computer, viewerID, true
}

// searchLocalComputerCustomModels searches Hugging Face or ModelScope via the
// owner's connected Computer.
func (a *App) searchLocalComputerCustomModels(c *gin.Context) {
	var request httpapi.LocalModelCustomSearchRequest
	if err := decodeJSON(c, &request); err != nil || !validCustomSearchRequest(request) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Custom model search request is invalid")
		return
	}
	computer, _, ok := a.ownedOnlineLocalModelsComputer(c)
	if !ok {
		return
	}
	customMgmt, ok := a.localComputers.(roomagent.LocalModelsCustomManagement)
	if !ok {
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALMODELSSERVICEUNAVAILABLE)
		return
	}
	internalReq, err := reencodeJSON[nodeservicesinternal.LocalModelCustomSearchRequest](request)
	if err != nil {
		a.internalError(c, "encode custom model search", err)
		return
	}
	result, err := customMgmt.SearchLocalComputerCustomModels(c.Request.Context(), modelSourceTarget(computer), internalReq)
	if err != nil {
		a.writeLocalModelsCustomFailure(c, computer.ComputerID, "search", err)
		return
	}
	public, err := reencodeJSON[httpapi.LocalModelCustomSearchResponse](result)
	if err != nil {
		a.internalError(c, "project custom model search", err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, public)
}

// probeLocalComputerCustomModel probes a Hugging Face or ModelScope repository
// from the owner's connected Computer. Classified outcomes including gated
// (hub_http_status 401/403) always answer HTTP 200 so browser sessions never
// confuse hub auth with session expiry.
func (a *App) probeLocalComputerCustomModel(c *gin.Context) {
	var request httpapi.LocalModelCustomProbeRequest
	if err := decodeJSON(c, &request); err != nil || !validCustomProbeRequest(request) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Custom model probe request is invalid")
		return
	}
	computer, _, ok := a.ownedOnlineLocalModelsComputer(c)
	if !ok {
		return
	}
	customMgmt, ok := a.localComputers.(roomagent.LocalModelsCustomManagement)
	if !ok {
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALMODELSSERVICEUNAVAILABLE)
		return
	}
	internalReq, err := reencodeJSON[nodeservicesinternal.LocalModelCustomProbeRequest](request)
	if err != nil {
		a.internalError(c, "encode custom model probe", err)
		return
	}
	result, err := customMgmt.ProbeLocalComputerCustomModel(c.Request.Context(), modelSourceTarget(computer), internalReq)
	if err != nil {
		a.writeLocalModelsCustomFailure(c, computer.ComputerID, "probe", err)
		return
	}
	public, err := reencodeJSON[httpapi.LocalModelCustomProbeResponse](result)
	if err != nil {
		a.internalError(c, "project custom model probe", err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, public)
}

// downloadLocalComputerCustomModel starts a Standby-First custom model download
// on the owner's connected Computer.
func (a *App) downloadLocalComputerCustomModel(c *gin.Context) {
	var request httpapi.LocalModelCustomDownloadInput
	if err := decodeJSON(c, &request); err != nil || !validCustomDownloadInput(request) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Custom model download request is invalid")
		return
	}
	computer, viewerID, ok := a.ownedOnlineLocalModelsComputer(c)
	if !ok {
		return
	}
	customMgmt, ok := a.localComputers.(roomagent.LocalModelsCustomManagement)
	if !ok {
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALMODELSSERVICEUNAVAILABLE)
		return
	}
	internalInput, err := reencodeJSON[nodeservicesinternal.LocalModelCustomDownloadInput](request)
	if err != nil {
		a.internalError(c, "encode custom model download", err)
		return
	}
	command := roomagent.LocalModelCustomDownloadCommand{
		TenantID:       computer.Owner.TenantID,
		OwnerActorID:   viewerID,
		ComputerID:     computer.ComputerID,
		RequestID:      ids.New("local_model_action"),
		CustomDownload: internalInput,
		ExpiresAt:      time.Now().UTC().Add(localModelActionLifetime),
	}
	modelID, refusal, err := customMgmt.DownloadLocalComputerCustomModel(c.Request.Context(), command)
	switch {
	case err == nil && refusal == nil:
		accepted := httpapi.LocalModelCustomDownloadAccepted{
			ComputerId: computer.ComputerID,
			Action:     httpapi.LocalModelCustomDownloadAcceptedCustomDownload,
		}
		if modelID != "" && localModelIDPattern.MatchString(modelID) {
			accepted.ModelId = &modelID
		}
		c.JSON(http.StatusAccepted, accepted)
	case err == nil:
		a.writeMappedLocalModelRefusal(c, computer.ComputerID, "custom_download", refusal)
	default:
		a.writeLocalModelsActionTransportError(c, computer.ComputerID, "custom_download", err)
	}
}

func (a *App) forwardLocalModelAction(c *gin.Context, action string, modelID string, unloadFirst []string, force *bool, contextTokens *int64, onAccepted func(computerID string)) {
	computer, viewerID, ok := a.ownedOnlineLocalModelsComputer(c)
	if !ok {
		return
	}
	command := roomagent.LocalModelActionCommand{
		TenantID: computer.Owner.TenantID, OwnerActorID: viewerID, ComputerID: computer.ComputerID,
		RequestID: ids.New("local_model_action"), Action: action, ModelID: modelID,
		UnloadFirst: unloadFirst, Force: force, ContextTokens: contextTokens,
		ExpiresAt: time.Now().UTC().Add(localModelActionLifetime),
	}
	refusal, err := a.localComputers.ActOnLocalModels(c.Request.Context(), command)
	switch {
	case err == nil && refusal == nil:
		onAccepted(computer.ComputerID)
	case err == nil:
		a.writeMappedLocalModelRefusal(c, computer.ComputerID, command.Action, refusal)
	default:
		a.writeLocalModelsActionTransportError(c, computer.ComputerID, command.Action, err)
	}
}

func (a *App) writeMappedLocalModelRefusal(c *gin.Context, computerID, action string, refusal *roomagent.LocalModelActionRefusal) {
	code, known := localModelRefusalCodes[refusal.Code]
	if !known {
		a.logger.Warn("local_models.action_refused", "computer_id", computerID, "action", action, "refusal_code", refusal.Code)
		code = httpapi.LocalModelsErrorCodeLOCALMODELACTIONFAILED
	}
	a.writeLocalModelsRefusal(c, code, refusal)
}

func (a *App) writeLocalModelsActionTransportError(c *gin.Context, computerID, action string, err error) {
	switch {
	case errors.Is(err, roomagent.ErrLocalComputerNotFound):
		a.writeError(c, http.StatusNotFound, "LOCAL_COMPUTER_NOT_FOUND", "Local Computer was not found")
	case errors.Is(err, roomagent.ErrLocalComputerOffline):
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALCOMPUTEROFFLINE)
	case errors.Is(err, roomagent.ErrLocalModelsTimeout):
		// The Computer is connected but had not decided; it may still act.
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALMODELACTIONUNCONFIRMED)
	case errors.Is(err, roomagent.ErrLocalModelsCustomUnsupported):
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALMODELSCUSTOMUNSUPPORTED)
	case errors.Is(err, roomagent.ErrLocalModelsUnsupported):
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALMODELSUNAVAILABLE)
	default:
		a.logger.Error("local_models.action_failed", "computer_id", computerID, "action", action, "error", err)
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALMODELSSERVICEUNAVAILABLE)
	}
}

func (a *App) writeLocalModelsCustomFailure(c *gin.Context, computerID, action string, err error) {
	var customErr *roomagent.LocalModelsCustomError
	switch {
	case errors.Is(err, roomagent.ErrLocalComputerNotFound):
		a.writeError(c, http.StatusNotFound, "LOCAL_COMPUTER_NOT_FOUND", "Local Computer was not found")
	case errors.Is(err, roomagent.ErrLocalComputerOffline):
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALCOMPUTEROFFLINE)
	case errors.Is(err, roomagent.ErrLocalModelsTimeout), errors.Is(err, context.DeadlineExceeded):
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALMODELACTIONUNCONFIRMED)
	case errors.Is(err, roomagent.ErrLocalModelsCustomUnsupported):
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALMODELSCUSTOMUNSUPPORTED)
	case errors.Is(err, roomagent.ErrLocalModelsUnsupported):
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALMODELSUNAVAILABLE)
	case errors.As(err, &customErr):
		if customErr.Code == "INVALID_REPO_SPEC" {
			a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Custom repository specification is invalid")
			return
		}
		code, known := localModelRefusalCodes[customErr.Code]
		if !known {
			a.logger.Warn("local_models_custom.failed", "computer_id", computerID, "action", action, "refusal_code", customErr.Code)
			code = httpapi.LocalModelsErrorCodeLOCALMODELACTIONFAILED
		}
		a.writeLocalModelsError(c, code)
	default:
		a.logger.Error("local_models_custom.failed", "computer_id", computerID, "action", action, "error", err)
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALMODELSSERVICEUNAVAILABLE)
	}
}

func validCustomSearchRequest(request httpapi.LocalModelCustomSearchRequest) bool {
	if request.Hub != nil && !request.Hub.Valid() {
		return false
	}
	if request.Format != nil && !request.Format.Valid() {
		return false
	}
	if request.Query != nil && len(*request.Query) > 256 {
		return false
	}
	if request.Limit != nil && (*request.Limit < 1 || *request.Limit > 50) {
		return false
	}
	if request.Token != nil && len(*request.Token) > 4096 {
		return false
	}
	return true
}

func validCustomProbeRequest(request httpapi.LocalModelCustomProbeRequest) bool {
	if strings.TrimSpace(request.Target) == "" || len(request.Target) > 2048 {
		return false
	}
	if request.Hub != nil && !request.Hub.Valid() {
		return false
	}
	if request.Revision != nil && (strings.TrimSpace(*request.Revision) == "" || len(*request.Revision) > 128) {
		return false
	}
	if request.FileName != nil && (strings.TrimSpace(*request.FileName) == "" || len(*request.FileName) > 512) {
		return false
	}
	if request.Token != nil && len(*request.Token) > 4096 {
		return false
	}
	return true
}

func validCustomDownloadInput(request httpapi.LocalModelCustomDownloadInput) bool {
	if !request.Hub.Valid() || strings.TrimSpace(request.RepoId) == "" || len(request.RepoId) > 256 ||
		strings.TrimSpace(request.VariantId) == "" || len(request.VariantId) > 128 {
		return false
	}
	if request.Revision != nil && (strings.TrimSpace(*request.Revision) == "" || len(*request.Revision) > 128) {
		return false
	}
	if request.Files != nil {
		if len(*request.Files) > 256 {
			return false
		}
		for _, f := range *request.Files {
			if strings.TrimSpace(f) == "" || len(f) > 512 {
				return false
			}
		}
	}
	if request.Mmproj != nil && (strings.TrimSpace(*request.Mmproj) == "" || len(*request.Mmproj) > 512) {
		return false
	}
	if request.Token != nil && len(*request.Token) > 4096 {
		return false
	}
	return true
}

func validLocalModelAction(modelID string, request httpapi.LocalModelActionRequest) bool {
	if !localModelIDPattern.MatchString(modelID) || !request.Action.Valid() {
		return false
	}
	if request.Force != nil && request.Action != httpapi.LocalModelActionRequestLoad {
		return false
	}
	if request.ContextTokens != nil {
		ctxTokens := *request.ContextTokens
		switch request.Action {
		case httpapi.LocalModelActionRequestSmokeTest:
			if ctxTokens != 2048 && ctxTokens != 4096 {
				return false
			}
		case httpapi.LocalModelActionRequestLoad:
			if ctxTokens < 512 || ctxTokens > 1_048_576 {
				return false
			}
		default:
			return false
		}
	}
	if request.UnloadFirst == nil {
		return true
	}
	unloadFirst := *request.UnloadFirst
	if request.Action != httpapi.LocalModelActionRequestLoad || len(unloadFirst) == 0 || len(unloadFirst) > 64 {
		return false
	}
	for index, id := range unloadFirst {
		if !localModelIDPattern.MatchString(id) || id == modelID || slices.Contains(unloadFirst[:index], id) {
			return false
		}
	}
	return true
}

func localModelRefusalDetails(refusal *roomagent.LocalModelActionRefusal) []httpapi.ErrorDetail {
	if refusal == nil {
		return nil
	}
	var details []httpapi.ErrorDetail
	if refusal.Pool != "" {
		details = append(details, httpapi.ErrorDetail{Field: "pool", Reason: refusal.Pool})
	}
	if refusal.NeedBytes != nil && *refusal.NeedBytes >= 0 {
		details = append(details, httpapi.ErrorDetail{Field: "need_bytes", Reason: strconv.FormatInt(*refusal.NeedBytes, 10)})
	}
	if refusal.FreeBytes != nil && *refusal.FreeBytes >= 0 {
		details = append(details, httpapi.ErrorDetail{Field: "free_bytes", Reason: strconv.FormatInt(*refusal.FreeBytes, 10)})
	}
	if refusal.ShortfallBytes != nil && *refusal.ShortfallBytes >= 0 {
		details = append(details, httpapi.ErrorDetail{Field: "shortfall_bytes", Reason: strconv.FormatInt(*refusal.ShortfallBytes, 10)})
	}
	if refusal.CanForce != nil {
		details = append(details, httpapi.ErrorDetail{Field: "can_force", Reason: strconv.FormatBool(*refusal.CanForce)})
	}
	return details
}

func (a *App) writeLocalModelsError(c *gin.Context, code httpapi.LocalModelsErrorCode) {
	a.writeLocalModelsErrorDetails(c, code, nil)
}

func (a *App) writeLocalModelsErrorDetails(c *gin.Context, code httpapi.LocalModelsErrorCode, details []httpapi.ErrorDetail) {
	status, found := localModelsErrorStatuses[code]
	if !found {
		status = http.StatusConflict
	}
	a.writeErrorWithDetails(c, status, string(code), localModelsErrorMessages[code], details)
}

func (a *App) writeLocalModelsRefusal(c *gin.Context, code httpapi.LocalModelsErrorCode, refusal *roomagent.LocalModelActionRefusal) {
	status, found := localModelsErrorStatuses[code]
	if !found {
		status = http.StatusConflict
	}
	requestID, _ := c.Get("request_id")
	reqIDStr, _ := requestID.(string)
	body := httpapi.LocalModelsError{
		Code:      code,
		Message:   localModelsErrorMessages[code],
		RequestId: reqIDStr,
		Details: func() *[]httpapi.ErrorDetail {
			details := localModelRefusalDetails(refusal)
			if len(details) == 0 {
				return nil
			}
			return &details
		}(),
	}
	if refusal != nil && status == http.StatusConflict {
		if refusal.NeedBytes != nil && *refusal.NeedBytes >= 0 {
			need := *refusal.NeedBytes
			body.NeedBytes = &need
		}
		if refusal.FreeBytes != nil && *refusal.FreeBytes >= 0 {
			free := *refusal.FreeBytes
			body.FreeBytes = &free
		}
		if refusal.Pool != "" && localModelPoolIDPattern.MatchString(refusal.Pool) {
			pool := refusal.Pool
			body.Pool = &pool
		}
	}
	c.JSON(status, httpapi.LocalModelsErrorResponse{Error: body})
}

// recordAgentRuntimeLocalModels stores a Computer's latest model library as
// the Agent Service forwarded it.
func (a *App) recordAgentRuntimeLocalModels(c *gin.Context) {
	var request teamhubinternal.RecordLocalModelsRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	sanitizeLocalModelsSnapshot(&request.Snapshot)
	if !validLocalModelsSnapshot(request.Snapshot) {
		a.writeAgentRuntimeStateError(c, "decode Local Computer models", agentruntimestate.ErrInvalid)
		return
	}
	snapshot, err := json.Marshal(request.Snapshot)
	var host []byte
	if err == nil && request.Snapshot.Host != nil {
		host, err = json.Marshal(request.Snapshot.Host)
	}
	if err != nil {
		a.writeAgentRuntimeStateError(c, "encode Local Computer models", err)
		return
	}
	err = a.agentRuntimeState.RecordLocalModels(c.Request.Context(), agentruntimestate.RecordLocalModelsInput{
		ComputerID: request.ComputerId, Snapshot: snapshot, Host: host, ObservedAt: request.Snapshot.ObservedAt,
	})
	if a.writeAgentRuntimeStateError(c, "record Local Computer models", err) {
		return
	}
	c.Status(http.StatusNoContent)
}

// sanitizeLocalModelsSnapshot normalizes extensible display and diagnostic
// enums so a newer Computer Daemon or localmodels catalog never fails snapshot
// ingestion with HTTP 400 while preserving structural and security checks.
func sanitizeLocalModelsSnapshot(snapshot *teamhubinternal.LocalModelsSnapshot) {
	if snapshot.Host != nil && snapshot.Host.ModelsDir != nil {
		trimmed := clipLocalModelString(strings.TrimSpace(*snapshot.Host.ModelsDir), 4096)
		if trimmed == "" {
			snapshot.Host.ModelsDir = nil
		} else {
			snapshot.Host.ModelsDir = &trimmed
		}
	}
	if snapshot.Debug != nil && (!snapshot.Debug.Mode.Valid() || !snapshot.Debug.Source.Valid()) {
		snapshot.Debug = nil
	}
	if snapshot.Host != nil && snapshot.Host.SupportedFormats != nil {
		filtered := make([]teamhubinternal.LocalModelFormat, 0, min(len(*snapshot.Host.SupportedFormats), 8))
		for _, f := range *snapshot.Host.SupportedFormats {
			if f.Valid() && !slices.Contains(filtered, f) {
				filtered = append(filtered, f)
				if len(filtered) == 8 {
					break
				}
			}
		}
		if len(filtered) > 0 {
			snapshot.Host.SupportedFormats = &filtered
		} else {
			snapshot.Host.SupportedFormats = nil
		}
	}
	for i := range snapshot.Models {
		model := &snapshot.Models[i]
		if model.State == teamhubinternal.LocalModelStateAbsent {
			model.Storage = nil
		} else if model.Storage != nil {
			model.Storage = sanitizeLocalModelStorage(model.Storage)
		}
		if model.Family != nil && !model.Family.Valid() {
			other := teamhubinternal.LocalModelFamilyOther
			model.Family = &other
		}
		if model.Architecture != nil && !model.Architecture.Valid() {
			model.Architecture = nil
		}
		if model.Engine != nil && !model.Engine.Valid() {
			model.Engine = nil
		}
		if model.EngineLabel != nil && len(*model.EngineLabel) == 0 {
			model.EngineLabel = nil
		}
		if model.Concurrency != nil && (*model.Concurrency < 1 || *model.Concurrency > 64) {
			model.Concurrency = nil
		}
		if model.ConcurrencyProbing != nil && (!*model.ConcurrencyProbing || model.State != teamhubinternal.LocalModelStateLoading) {
			model.ConcurrencyProbing = nil
		}
		if model.HostRamBytes != nil && *model.HostRamBytes < 0 {
			model.HostRamBytes = nil
		}
		if model.MinimumMemoryBytes != nil && *model.MinimumMemoryBytes < 0 {
			model.MinimumMemoryBytes = nil
		}
		if model.State != teamhubinternal.LocalModelStateLoaded {
			model.Degraded = nil
			model.RequestedPosture = nil
			model.EffectivePosture = nil
			model.DegradationReason = nil
			model.MemoryPressureWarning = nil
			model.OomRetries = nil
			model.Forced = nil
		} else {
			if model.Degraded != nil && !*model.Degraded {
				model.Degraded = nil
			}
			sanitizeInternalPosture(&model.RequestedPosture)
			sanitizeInternalPosture(&model.EffectivePosture)
			if model.DegradationReason != nil && !model.DegradationReason.Valid() {
				model.DegradationReason = nil
			}
			if model.MemoryPressureWarning != nil && !model.MemoryPressureWarning.Level.Valid() {
				model.MemoryPressureWarning = nil
			} else if model.MemoryPressureWarning != nil {
				if model.MemoryPressureWarning.FreeBytes != nil && *model.MemoryPressureWarning.FreeBytes < 0 {
					model.MemoryPressureWarning.FreeBytes = nil
				}
				if model.MemoryPressureWarning.BudgetBytes != nil && *model.MemoryPressureWarning.BudgetBytes < 0 {
					model.MemoryPressureWarning.BudgetBytes = nil
				}
			}
			if model.OomRetries != nil && (*model.OomRetries <= 0 || *model.OomRetries > 64) {
				model.OomRetries = nil
			}
			if model.Forced != nil && !*model.Forced {
				model.Forced = nil
			}
		}
		if model.Download != nil {
			if model.Download.ShardIndex != nil && *model.Download.ShardIndex < 1 {
				model.Download.ShardIndex = nil
			}
			if model.Download.ShardCount != nil && *model.Download.ShardCount < 1 {
				model.Download.ShardCount = nil
			}
		}
		if model.Origin != nil && !model.Origin.Valid() {
			model.Origin = nil
		}
		if model.Custom != nil {
			custom := model.Custom
			if !custom.Hub.Valid() || !custom.Format.Valid() ||
				strings.TrimSpace(custom.RepoId) == "" || len(custom.RepoId) > 256 ||
				strings.TrimSpace(custom.VariantId) == "" || len(custom.VariantId) > 128 {
				model.Custom = nil
			} else {
				if custom.ShardCount < 1 {
					custom.ShardCount = 1
				} else if custom.ShardCount > 256 {
					custom.ShardCount = 256
				}
				if custom.Url != nil && (len(*custom.Url) > 2048 || !localModelSourceURLPattern.MatchString(*custom.Url)) {
					custom.Url = nil
				}
				if custom.MmprojBytes != nil && *custom.MmprojBytes < 0 {
					custom.MmprojBytes = nil
				}
			}
		}
		if model.Verification != nil {
			ver := model.Verification
			if !ver.Status.Valid() {
				model.Verification = nil
			} else {
				if ver.ContextTokens != nil && *ver.ContextTokens < 1 {
					ver.ContextTokens = nil
				}
				if ver.Failure != nil {
					fail := ver.Failure
					if !fail.Kind.Valid() {
						fail.Kind = teamhubinternal.LocalModelVerificationFailureKindUnknown
					}
					if !fail.Code.Valid() {
						fail.Code = teamhubinternal.UNKNOWNERROR
					}
					if fail.ContextTokens < 1 {
						fail.ContextTokens = 4096
					}
					if fail.DiagnosticLog != nil {
						scrubbed := safeDiagnosticLog(*fail.DiagnosticLog)
						fail.DiagnosticLog = &scrubbed
					}
				}
			}
		}

		if model.Capabilities != nil {
			filtered := make([]teamhubinternal.LocalModelCapability, 0, len(*model.Capabilities))
			for _, capability := range *model.Capabilities {
				if capability.Valid() && !slices.Contains(filtered, capability) {
					filtered = append(filtered, capability)
				}
			}
			if len(filtered) > 0 {
				model.Capabilities = &filtered
			} else {
				model.Capabilities = nil
			}
		}
		if reason := model.Availability.Reason; reason != nil {
			if !reason.Code.Valid() {
				model.Availability.Reason = &teamhubinternal.LocalModelAvailabilityReason{
					Code: teamhubinternal.LocalModelAvailabilityUnavailable,
				}
			} else {
				if reason.MemoryKind != nil && !reason.MemoryKind.Valid() {
					reason.MemoryKind = nil
				}
				if reason.GpuVendor != nil && !reason.GpuVendor.Valid() {
					reason.GpuVendor = nil
				}
			}
		}
		if model.Error != nil {
			if !model.Error.Code.Valid() {
				model.Error.Code = teamhubinternal.UNKNOWNERROR
				model.Error.Cause, model.Error.Path = nil, nil
				model.Error.Pool, model.Error.NeedBytes, model.Error.FreeBytes, model.Error.ShortfallBytes, model.Error.CanForce = nil, nil, nil, nil, nil
			} else {
				if model.Error.Cause != nil && !model.Error.Cause.Valid() {
					model.Error.Cause, model.Error.Path = nil, nil
				}
				if model.Error.NeedBytes != nil && *model.Error.NeedBytes < 0 {
					model.Error.NeedBytes = nil
				}
				if model.Error.FreeBytes != nil && *model.Error.FreeBytes < 0 {
					model.Error.FreeBytes = nil
				}
				if model.Error.ShortfallBytes != nil && *model.Error.ShortfallBytes < 0 {
					model.Error.ShortfallBytes = nil
				}
			}
		}
		if model.Note != nil && !model.Note.Code.Valid() {
			model.Note = nil
		}
	}
}

func sanitizeLocalModelStorage(raw *teamhubinternal.LocalModelStorage) *teamhubinternal.LocalModelStorage {
	dir := clipLocalModelString(strings.TrimSpace(raw.Dir), 4096)
	primaryPath := clipLocalModelString(strings.TrimSpace(raw.PrimaryPath), 4096)
	if dir == "" || primaryPath == "" || len(raw.Files) == 0 {
		return nil
	}
	files := make([]teamhubinternal.LocalModelStorageFile, 0, min(len(raw.Files), 256))
	for _, entry := range raw.Files {
		if len(files) >= 256 {
			break
		}
		filePath := clipLocalModelString(strings.TrimSpace(entry.Path), 4096)
		if filePath == "" {
			continue
		}
		role := entry.Role
		if !role.Valid() {
			role = teamhubinternal.LocalModelStorageFileRoleOther
		}
		files = append(files, teamhubinternal.LocalModelStorageFile{
			Path:      filePath,
			Role:      role,
			SizeBytes: max(entry.SizeBytes, int64(0)),
			Present:   entry.Present,
			Shared:    entry.Shared,
		})
	}
	if len(files) == 0 {
		return nil
	}
	return &teamhubinternal.LocalModelStorage{
		Dir:          dir,
		PrimaryPath:  primaryPath,
		DedicatedDir: raw.DedicatedDir,
		DiskBytes:    max(raw.DiskBytes, int64(0)),
		FilesPresent: raw.FilesPresent,
		Files:        files,
	}
}

func clipLocalModelString(text string, limit int) string {
	if utf8.RuneCountInString(text) <= limit {
		return text
	}
	return string([]rune(text)[:limit])
}

// validLocalModelsSnapshot checks what the public view relies on: the
// unavailable reason travels only with an unavailable library, and every
// enum the Web branches on is known.
func validLocalModelsSnapshot(snapshot teamhubinternal.LocalModelsSnapshot) bool {
	if snapshot.ObservedAt.IsZero() || len(snapshot.Pools) > 65 || len(snapshot.Models) > 256 ||
		snapshot.Available != (snapshot.Reason == nil) || (snapshot.Reason != nil && !snapshot.Reason.Code.Valid()) {
		return false
	}
	if snapshot.Host != nil && snapshot.Host.ModelsDir != nil &&
		(*snapshot.Host.ModelsDir == "" || utf8.RuneCountInString(*snapshot.Host.ModelsDir) > 4096) {
		return false
	}
	for _, pool := range snapshot.Pools {
		if !pool.Kind.Valid() {
			return false
		}
	}
	seen := make(map[string]bool, len(snapshot.Models))
	for _, model := range snapshot.Models {
		if !localModelIDPattern.MatchString(model.Id) || seen[model.Id] || !model.State.Valid() || !model.Fit.Valid() {
			return false
		}
		if model.Family != nil && !model.Family.Valid() {
			return false
		}
		if model.Architecture != nil && !model.Architecture.Valid() {
			return false
		}
		if model.Engine != nil && !model.Engine.Valid() {
			return false
		}
		if model.Concurrency != nil && (*model.Concurrency < 1 || *model.Concurrency > 64) {
			return false
		}
		if model.ConcurrencyProbing != nil && *model.ConcurrencyProbing && model.State != teamhubinternal.LocalModelStateLoading {
			return false
		}
		if model.HostRamBytes != nil && *model.HostRamBytes < 0 {
			return false
		}
		if model.Storage != nil {
			if model.State == teamhubinternal.LocalModelStateAbsent ||
				model.Storage.Dir == "" || utf8.RuneCountInString(model.Storage.Dir) > 4096 ||
				model.Storage.PrimaryPath == "" || utf8.RuneCountInString(model.Storage.PrimaryPath) > 4096 ||
				model.Storage.DiskBytes < 0 || len(model.Storage.Files) == 0 || len(model.Storage.Files) > 256 {
				return false
			}
			for _, file := range model.Storage.Files {
				if file.Path == "" || utf8.RuneCountInString(file.Path) > 4096 || !file.Role.Valid() || file.SizeBytes < 0 {
					return false
				}
			}
		}
		if model.MinimumMemoryBytes != nil && *model.MinimumMemoryBytes < 0 {
			return false
		}
		if model.RequestedPosture != nil && !validInternalPosture(*model.RequestedPosture) {
			return false
		}
		if model.EffectivePosture != nil && !validInternalPosture(*model.EffectivePosture) {
			return false
		}
		if model.DegradationReason != nil && !model.DegradationReason.Valid() {
			return false
		}
		if model.MemoryPressureWarning != nil && !model.MemoryPressureWarning.Level.Valid() {
			return false
		}
		if model.OomRetries != nil && (*model.OomRetries < 0 || *model.OomRetries > 64) {
			return false
		}
		if model.Capabilities != nil {
			for index, capability := range *model.Capabilities {
				if !capability.Valid() || slices.Contains((*model.Capabilities)[:index], capability) {
					return false
				}
			}
		}
		if model.SourceUrl != nil && (len(*model.SourceUrl) > 2048 || !localModelSourceURLPattern.MatchString(*model.SourceUrl)) {
			return false
		}
		if model.PromptTokensPerSecond != nil && *model.PromptTokensPerSecond < 0 {
			return false
		}
		if model.Error != nil && model.Error.Cause != nil && !model.Error.Cause.Valid() {
			return false
		}
		if model.Origin != nil && !model.Origin.Valid() {
			return false
		}
		if model.Custom != nil && (!model.Custom.Hub.Valid() || !model.Custom.Format.Valid() ||
			strings.TrimSpace(model.Custom.RepoId) == "" || strings.TrimSpace(model.Custom.VariantId) == "" ||
			model.Custom.ShardCount < 1 || model.Custom.ShardCount > 256) {
			return false
		}
		if model.Verification != nil {
			if !model.Verification.Status.Valid() {
				return false
			}
			if model.Verification.Failure != nil && (!model.Verification.Failure.Kind.Valid() || !model.Verification.Failure.Code.Valid() || model.Verification.Failure.ContextTokens < 1) {
				return false
			}
		}
		seen[model.Id] = true
	}
	return true
}

func sanitizeInternalPosture(posture **teamhubinternal.LocalModelPosture) {
	if *posture == nil {
		return
	}
	if (*posture).ContextTokens < 1 || (*posture).Slots < 1 || (*posture).Slots > 64 {
		*posture = nil
		return
	}
	if (*posture).KvCacheQuant != nil && !(*posture).KvCacheQuant.Valid() {
		(*posture).KvCacheQuant = nil
	}
}

func validInternalPosture(posture teamhubinternal.LocalModelPosture) bool {
	if posture.ContextTokens < 1 || posture.Slots < 1 || posture.Slots > 64 {
		return false
	}
	if posture.KvCacheQuant != nil && !posture.KvCacheQuant.Valid() {
		return false
	}
	return true
}

func safeDiagnosticLog(raw string) string {
	scrubbed := computerMessageURLQueryPattern.ReplaceAllString(raw, "${1}?[REDACTED]")
	scrubbed = computerMessageURLUserinfoPattern.ReplaceAllString(scrubbed, "${1}[REDACTED]@")
	scrubbed = computerMessageBearerPattern.ReplaceAllString(scrubbed, "${1} [REDACTED]")
	scrubbed = computerMessageSecretAssignPattern.ReplaceAllString(scrubbed, "${1}${2}[REDACTED]")
	scrubbed = computerMessageTokenPattern.ReplaceAllString(scrubbed, "[REDACTED]")
	runes := []rune(scrubbed)
	if len(runes) > 4000 {
		return string(runes[:4000])
	}
	return scrubbed
}
