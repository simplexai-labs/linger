package app

import (
	"net/http"

	"github.com/gin-gonic/gin"

	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// getTaskConversation returns what a Task's Agent was told and the cards its
// AlterEgo raised, to a person who can read the Task.
func (a *App) getTaskConversation(c *gin.Context) {
	conversation, err := a.taskExecutions.GetConversationForHuman(
		c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("taskId"),
	)
	if a.writeTaskExecutionError(c, "get Task conversation", err) {
		return
	}
	model := httpapi.TaskConversation{
		Inputs: make([]httpapi.TaskConversationInput, len(conversation.Inputs)),
		Cards:  make([]httpapi.TaskConversationCard, len(conversation.Cards)),
	}
	for index, input := range conversation.Inputs {
		model.Inputs[index] = httpapi.TaskConversationInput{
			Id: input.ID, Body: input.Body, CreatedAt: input.CreatedAt.Time,
			Source: httpapi.TaskConversationInputSource(input.Source),
			Author: httpapi.ActorRef{
				Id: input.AuthorActorID, TenantId: conversation.TenantID,
				Kind: httpapi.ActorKind(input.AuthorKind), DisplayName: input.AuthorDisplayName,
			},
		}
	}
	for index, card := range conversation.Cards {
		model.Cards[index] = httpapi.TaskConversationCard{
			DecisionId: card.ID, RoomId: card.RoomID, MessageId: card.MessageID, CreatedAt: card.CreatedAt.Time,
		}
	}
	c.JSON(http.StatusOK, model)
}
