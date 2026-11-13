package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentregistry"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// localModelActionLifetime bounds how long the Computer may take to accept
// an action; it stays inside the Agent management client's timeout.
const localModelActionLifetime = 10 * time.Second

var localModelIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$`)

// localModelRefusalCodes maps the Computer's refusals a Human can act on to
// their own public code; every other refusal is LOCAL_MODEL_ACTION_FAILED.
var localModelRefusalCodes = map[string]httpapi.LocalModelsErrorCode{
	"TOOL_NOT_INSTALLED":   httpapi.LocalModelsErrorCodeLOCALMODELSUNAVAILABLE,
	"TOOL_FAILED":          httpapi.LocalModelsErrorCodeLOCALMODELSUNAVAILABLE,
	"MODEL_UNKNOWN":        httpapi.LocalModelsErrorCodeLOCALMODELUNKNOWN,
	"INVALID_STATE":        httpapi.LocalModelsErrorCodeLOCALMODELINVALIDSTATE,
	"JOB_RUNNING":          httpapi.LocalModelsErrorCodeLOCALMODELJOBRUNNING,
	"LOAD_NO_ROOM":         httpapi.LocalModelsErrorCodeLOCALMODELNOROOM,
	"MEMORY_INSUFFICIENT":  httpapi.LocalModelsErrorCodeLOCALMODELMEMORYINSUFFICIENT,
	"DISK_INSUFFICIENT":    httpapi.LocalModelsErrorCodeLOCALMODELDISKINSUFFICIENT,
	"PLATFORM_UNSUPPORTED": httpapi.LocalModelsErrorCodeLOCALMODELPLATFORMUNSUPPORTED,
}

var localModelsErrorMessages = map[httpapi.LocalModelsErrorCode]string{
	httpapi.LocalModelsErrorCodeLOCALCOMPUTEROFFLINE:          "Local Computer is offline",
	httpapi.LocalModelsErrorCodeLOCALMODELACTIONFORBIDDEN:     "Only the Computer's owner can change its models",
	httpapi.LocalModelsErrorCodeLOCALMODELSUNAVAILABLE:        "The Computer has no usable model library",
	httpapi.LocalModelsErrorCodeLOCALMODELUNKNOWN:             "The Computer does not know this model",
	httpapi.LocalModelsErrorCodeLOCALMODELINVALIDSTATE:        "The model cannot do that in its current state",
	httpapi.LocalModelsErrorCodeLOCALMODELJOBRUNNING:          "The Computer is already working on this model",
	httpapi.LocalModelsErrorCodeLOCALMODELNOROOM:              "There is not enough free memory to load this model",
	httpapi.LocalModelsErrorCodeLOCALMODELMEMORYINSUFFICIENT:  "The Computer does not have enough memory for this model",
	httpapi.LocalModelsErrorCodeLOCALMODELDISKINSUFFICIENT:    "The Computer does not have enough disk space for this model",
	httpapi.LocalModelsErrorCodeLOCALMODELPLATFORMUNSUPPORTED: "The model does not run on this Computer",
	httpapi.LocalModelsErrorCodeLOCALMODELACTIONFAILED:        "The Computer could not start this action",
	httpapi.LocalModelsErrorCodeLOCALMODELACTIONUNCONFIRMED:   "The Computer did not confirm the action in time",
	httpapi.LocalModelsErrorCodeLOCALMODELSSERVICEUNAVAILABLE: "Local models are unavailable",
}

var localModelsErrorStatuses = map[httpapi.LocalModelsErrorCode]int{
	httpapi.LocalModelsErrorCodeLOCALCOMPUTEROFFLINE:          http.StatusServiceUnavailable,
	httpapi.LocalModelsErrorCodeLOCALMODELACTIONFORBIDDEN:     http.StatusForbidden,
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
	tenantID, computerID := c.Param("tenantId"), c.Param("computerId")
	viewerID, ok := a.spaceHuman(c, tenantID)
	if !ok {
		return
	}
	if a.agentRuntimeState == nil || a.localComputers == nil {
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALMODELSSERVICEUNAVAILABLE)
		return
	}
	computer, err := a.agentRuntimeState.GetLocalComputer(c.Request.Context(), computerID)
	switch {
	case errors.Is(err, agentruntimestate.ErrNotFound), errors.Is(err, agentruntimestate.ErrInvalid),
		err == nil && computer.Owner.TenantID != tenantID:
		a.writeError(c, http.StatusNotFound, "LOCAL_COMPUTER_NOT_FOUND", "Local Computer was not found")
		return
	case err != nil:
		a.internalError(c, "read Local Computer for a model action", err)
		return
	}
	if computer.Owner.OwnerActorID != viewerID {
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALMODELACTIONFORBIDDEN)
		return
	}
	if !localComputerOnline(computer.Status, computer.LastSeenAt, time.Now()) {
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALCOMPUTEROFFLINE)
		return
	}
	command := roomagent.LocalModelActionCommand{
		TenantID: tenantID, OwnerActorID: viewerID, ComputerID: computerID,
		RequestID: ids.New("local_model_action"), Action: string(request.Action), ModelID: modelID,
		ExpiresAt: time.Now().UTC().Add(localModelActionLifetime),
	}
	if request.UnloadFirst != nil {
		command.UnloadFirst = *request.UnloadFirst
	}
	refusal, err := a.localComputers.ActOnLocalModels(c.Request.Context(), command)
	switch {
	case err == nil && refusal == nil:
		c.JSON(http.StatusAccepted, httpapi.LocalModelActionAccepted{
			ComputerId: computerID, ModelId: modelID, Action: httpapi.LocalModelActionAcceptedAction(request.Action),
		})
	case err == nil:
		code, known := localModelRefusalCodes[refusal.Code]
		if !known {
			a.logger.Warn("local_models.action_refused", "computer_id", computerID, "action", command.Action, "refusal_code", refusal.Code)
			code = httpapi.LocalModelsErrorCodeLOCALMODELACTIONFAILED
		}
		a.writeLocalModelsError(c, code)
	case errors.Is(err, roomagent.ErrLocalComputerNotFound):
		a.writeError(c, http.StatusNotFound, "LOCAL_COMPUTER_NOT_FOUND", "Local Computer was not found")
	case errors.Is(err, roomagent.ErrLocalComputerOffline):
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALCOMPUTEROFFLINE)
	case errors.Is(err, roomagent.ErrLocalModelsTimeout):
		// The Computer is connected but had not decided; it may still act.
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALMODELACTIONUNCONFIRMED)
	case errors.Is(err, roomagent.ErrLocalModelsUnsupported):
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALMODELSUNAVAILABLE)
	default:
		a.logger.Error("local_models.action_failed", "computer_id", computerID, "action", command.Action, "error", err)
		a.writeLocalModelsError(c, httpapi.LocalModelsErrorCodeLOCALMODELSSERVICEUNAVAILABLE)
	}
}

func validLocalModelAction(modelID string, request httpapi.LocalModelActionRequest) bool {
	if !localModelIDPattern.MatchString(modelID) || !request.Action.Valid() {
		return false
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

func (a *App) writeLocalModelsError(c *gin.Context, code httpapi.LocalModelsErrorCode) {
	status, found := localModelsErrorStatuses[code]
	if !found {
		status = http.StatusConflict
	}
	a.writeError(c, status, string(code), localModelsErrorMessages[code])
}

// recordAgentRuntimeLocalModels stores a Computer's latest model library as
// the Agent Service forwarded it.
func (a *App) recordAgentRuntimeLocalModels(c *gin.Context) {
	var request teamhubinternal.RecordLocalModelsRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
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

// validLocalModelsSnapshot checks what the public view relies on: the
// unavailable reason travels only with an unavailable library, and every
// enum the Web branches on is known.
func validLocalModelsSnapshot(snapshot teamhubinternal.LocalModelsSnapshot) bool {
	if snapshot.ObservedAt.IsZero() || len(snapshot.Pools) > 65 || len(snapshot.Models) > 256 ||
		snapshot.Available != (snapshot.Reason == nil) || (snapshot.Reason != nil && !snapshot.Reason.Code.Valid()) {
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
		seen[model.Id] = true
	}
	return true
}
