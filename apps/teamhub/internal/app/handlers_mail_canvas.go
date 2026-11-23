package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/mailcanvas"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// writeMailCanvasNotReady answers 503 while the email's latest content is
// being rendered: the shared Document mapping answers 202, which a client
// would read as a mail state.
func (a *App) writeMailCanvasNotReady(c *gin.Context, err error) bool {
	if !errors.Is(err, document.ErrLatestProjectionNotReady) {
		return false
	}
	c.Header("Retry-After", "1")
	a.writeError(c, http.StatusServiceUnavailable, "DOCUMENT_LATEST_NOT_READY", "The email is being saved; retry")
	return true
}

func (a *App) getMailCanvas(c *gin.Context) {
	state, err := a.mailCanvas.Get(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("documentId"))
	if a.writeMailCanvasNotReady(c, err) || a.writeUnifiedDocumentError(c, "read email canvas", err) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, state)
}

func (a *App) sendMailCanvas(c *gin.Context) {
	var input httpapi.SendMailCanvasRequest
	if decodeJSON(c, &input) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Email delivery input is invalid")
		return
	}
	state, err := a.mailCanvas.Send(c.Request.Context(), mailcanvas.SendInput{
		AccountID: currentPrincipal(c).Session.AccountID, DocumentID: c.Param("documentId"),
		ConnectionID: input.ConnectionId, RequestID: input.RequestId, SourceDigest: input.SourceDigest,
	})
	if a.writeMailCanvasError(c, err) {
		return
	}
	if a.writeMailCanvasNotReady(c, err) || a.writeUnifiedDocumentError(c, "send email canvas", err) {
		return
	}
	c.JSON(http.StatusAccepted, state)
}

func (a *App) declineMailCanvas(c *gin.Context) {
	state, err := a.mailCanvas.Decline(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("documentId"))
	if a.writeMailCanvasError(c, err) {
		return
	}
	if a.writeMailCanvasNotReady(c, err) || a.writeUnifiedDocumentError(c, "decline email canvas", err) {
		return
	}
	c.JSON(http.StatusOK, state)
}

// writeMailCanvasError answers the delivery outcomes a Human can act on.
func (a *App) writeMailCanvasError(c *gin.Context, err error) bool {
	switch {
	case errors.Is(err, mailcanvas.ErrAlreadySent):
		a.writeError(c, http.StatusConflict, "CONFLICT", "This email was already sent.")
	case errors.Is(err, mailcanvas.ErrConflict):
		a.writeError(c, http.StatusConflict, "CONFLICT", "The email changed or is already being sent. Review it and try again.")
	case errors.Is(err, mailcanvas.ErrForbidden):
		a.writeError(c, http.StatusForbidden, "FORBIDDEN", "You cannot send or change this email.")
	case errors.Is(err, mailcanvas.ErrConnectionUnavailable):
		a.writeError(c, http.StatusForbidden, "FORBIDDEN", "The mail account is unavailable. Reconnect it before sending.")
	default:
		return false
	}
	return true
}
