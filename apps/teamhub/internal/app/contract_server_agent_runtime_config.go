package app

import (
	"net/http"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

func (a *App) getAgentRuntimeConfigSnapshotRoute(c *gin.Context) {
	params := contractParams[teamhubinternal.GetAgentRuntimeConfigSnapshotParams](c)
	var requestedRevision int64
	if params.Revision != nil {
		var ok bool
		requestedRevision, ok = a.parseAgentRuntimePositiveInt64(c, *params.Revision)
		if !ok {
			return
		}
	}
	response, err := a.agents.RuntimeConfigSnapshot(c.Request.Context(), params.AgentId, requestedRevision, a.permissionReviewEnabled())
	if a.writeAgentRuntimeStateError(c, "get Agent Runtime configuration", err) {
		return
	}
	c.JSON(http.StatusOK, response)
}

// listAnotherMePlacements lets the Agent Service run a Human's background model
// calls on the Computer of that Human's Another Me.
func (a *App) listAnotherMePlacements(c *gin.Context) {
	params := contractParams[teamhubinternal.ListAnotherMePlacementsParams](c)
	var filter store.ListAnotherMePlacementsParams
	if params.TenantId != nil {
		filter.TenantID = *params.TenantId
	}
	if params.OwnerActorId != nil {
		filter.OwnerActorID = *params.OwnerActorId
	}
	response, err := a.agents.AnotherMePlacements(c.Request.Context(), filter)
	if a.writeAgentRuntimeStateError(c, "list Another Me placements", err) {
		return
	}
	c.JSON(http.StatusOK, response)
}

// anotherMeBackgroundReasonMaxLength is the contract's bound on a reported
// reason code.
const anotherMeBackgroundReasonMaxLength = 64

// recordAnotherMeBackgroundCall counts an Another Me's failed background model
// calls in a row so its Human can see them.
func (a *App) recordAnotherMeBackgroundCall(c *gin.Context) {
	var request teamhubinternal.RecordAnotherMeBackgroundCallRequest
	if !a.decodeAgentRuntimeStateBody(c, &request) {
		return
	}
	if !request.Outcome.Valid() || request.TenantId == "" || request.AgentActorId == "" ||
		utf8.RuneCountInString(optionalStringValue(request.Reason)) > anotherMeBackgroundReasonMaxLength {
		a.writeAgentRuntimeStateError(c, "decode Another Me background call", agentruntimestate.ErrInvalid)
		return
	}
	err := a.agents.RecordAnotherMeBackgroundCall(c.Request.Context(), request.TenantId, request.AgentActorId,
		request.Outcome == teamhubinternal.RecordAnotherMeBackgroundCallRequestOutcomeFailed, optionalStringValue(request.Reason))
	if a.writeAgentRuntimeStateError(c, "record Another Me background call", err) {
		return
	}
	c.Status(http.StatusNoContent)
}
