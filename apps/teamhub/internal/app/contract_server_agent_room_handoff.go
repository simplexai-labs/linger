package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentroomhandoff"
	teamhubagentapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

const agentRoomHandoffRequestMaxBytes = 64 << 10

type agentRoomHandoffService interface {
	HandOff(context.Context, string, agentroomhandoff.Input) (agentroomhandoff.Result, error)
}

func (a *App) handOffAgentRoomWork(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var request teamhubagentapi.AgentRoomHandoffRequest
	body := http.MaxBytesReader(c.Writer, c.Request.Body, agentRoomHandoffRequestMaxBytes)
	if err := decodeStrictJSON(body, &request, "request body must contain one JSON object"); err != nil {
		a.writeAgentAPIError(c, http.StatusBadRequest, teamhubagentapi.AgentApiErrorCodeInvalidRequest, "Room handoff request is invalid")
		return
	}
	handoffID := ""
	if request.HandoffId != nil {
		handoffID = *request.HandoffId
	}
	result, err := a.agentRoomHandoffs.HandOff(c.Request.Context(), token, agentroomhandoff.Input{
		InvocationID: request.InvocationId, HandoffID: handoffID, RoomID: request.RoomId, Instruction: request.Instruction,
	})
	if a.writeAgentRoomHandoffError(c, err) {
		return
	}
	c.JSON(http.StatusOK, agentMessageReceipt(gin.H{"accepted": true, "inbox_id": result.InboxID, "handoff_id": result.HandoffID}, result.Replay,
		"This operation was already completed. The original handoff is returned; nothing new was posted."))
}

// writeRoomHandoffRefusal carries the refusal's reason in a model-safe issue,
// which the CLI shows the Agent, so it can tell the Human what really
// happened instead of guessing.
func (a *App) writeRoomHandoffRefusal(c *gin.Context, code teamhubagentapi.AgentApiErrorCode, path, reason, message string) {
	a.writeAgentAPIErrorWithIssues(c, http.StatusForbidden, code, "Room handoff was refused",
		[]teamhubagentapi.AgentApiErrorIssue{{Path: path, Code: reason, Message: message}})
}

func (a *App) writeAgentRoomHandoffError(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, agentroomhandoff.ErrInvalid), errors.Is(err, agentauth.ErrInvalid):
		a.writeAgentAPIError(c, http.StatusBadRequest, teamhubagentapi.AgentApiErrorCodeInvalidRequest, "Room handoff request is invalid")
	case errors.Is(err, agentauth.ErrCredentialInvalid):
		a.writeAgentAPIError(c, http.StatusUnauthorized, teamhubagentapi.AgentApiErrorCodeAgentCredentialInvalid, "Agent credential is invalid or expired")
	case errors.Is(err, agentroomhandoff.ErrNotRequestedByHuman):
		a.writeRoomHandoffRefusal(c, teamhubagentapi.AgentApiErrorCodeOperationForbidden, "run", "not_requested_by_human",
			"Hand off only in a turn your Human started in this direct chat, by writing to you or deciding one of your cards. In a proactive wake, Routine or Task report, tell your Human here and let them ask.")
	case errors.Is(err, agentroomhandoff.ErrNotFromDirectChat), errors.Is(err, agentauth.ErrForbidden):
		a.writeRoomHandoffRefusal(c, teamhubagentapi.AgentApiErrorCodeOperationForbidden, "context", "not_direct_chat",
			"Only Another Me hands off, from its direct chat with its Human. In any other Room, work in that Room itself.")
	case errors.Is(err, agentroomhandoff.ErrRoomUnavailable):
		a.writeRoomHandoffRefusal(c, teamhubagentapi.AgentApiErrorCodeForbidden, "room_id", "room_unavailable",
			"The target must be another live Room, not a Thread or this chat, where both you and your Human are members; run teamhub message read --list-inboxes to find the target Room's room:<room-id> by name.")
	case errors.Is(err, agentroomhandoff.ErrIdempotencyConflict):
		a.writeAgentAPIError(c, http.StatusConflict, teamhubagentapi.AgentApiErrorCodeIdempotencyConflict, "Room handoff invocation was reused with different input")
	case errors.Is(err, agentroomhandoff.ErrUnavailable):
		a.writeAgentAPIError(c, http.StatusServiceUnavailable, teamhubagentapi.AgentApiErrorCodeDependencyUnavailable, "Room handoff service is unavailable")
	default:
		if a.logger != nil {
			a.logger.Error("agent.room_handoff_failed", "request_id", c.GetString("request_id"), "error_type", fmt.Sprintf("%T", err))
		}
		a.writeAgentAPIError(c, http.StatusInternalServerError, teamhubagentapi.AgentApiErrorCodeInternalError, "Room handoff service could not complete the request")
	}
	return true
}
