package app

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// requireVoiceRuntime authenticates the Voice Runtime. Its callbacks exist
// only with voice media on; without it they are not found.
func (a *App) requireVoiceRuntime() gin.HandlerFunc {
	return func(c *gin.Context) {
		if a.voiceMedia == nil {
			c.JSON(http.StatusNotFound, teamhubinternal.VoiceError{Code: "NOT_FOUND", Message: "Voice media is not configured"})
			c.Abort()
			return
		}
		a.authenticateVoiceRuntime(c)
	}
}

// authenticateVoiceRuntime checks the Voice Runtime credential. The provider
// key read uses it alone: Node Services asks whether to run voice workers
// whether or not voice media is on, and gets no key while it is off.
func (a *App) authenticateVoiceRuntime(c *gin.Context) {
	if a.cfg.Voice.RuntimeToken == "" {
		c.JSON(http.StatusServiceUnavailable, teamhubinternal.VoiceError{
			Code: "DEPENDENCY_UNAVAILABLE", Message: "Voice Runtime callback is not configured",
		})
		c.Abort()
		return
	}
	token, ok := strings.CutPrefix(c.GetHeader("Authorization"), "Bearer ")
	if !ok || token == "" || subtle.ConstantTimeCompare([]byte(token), []byte(a.cfg.Voice.RuntimeToken)) != 1 {
		c.JSON(http.StatusUnauthorized, teamhubinternal.VoiceError{
			Code: "UNAUTHENTICATED", Message: "Voice Runtime authentication is invalid",
		})
		c.Abort()
		return
	}
	c.Next()
}

func (a *App) reportVoiceObservationRoute(c *gin.Context) {
	var request teamhubinternal.VoiceObservation
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, teamhubinternal.VoiceError{Code: "INVALID_REQUEST", Message: "Voice observation is invalid"})
		return
	}
	a.reportVoiceObservation(c, request)
}

func (a *App) claimVoiceMediaEpoch(c *gin.Context) {
	epoch, err := a.voice.ClaimMediaEpoch(c.Request.Context(), c.Param("voiceSessionId"))
	switch {
	case errors.Is(err, voice.ErrVoiceSessionNotFound):
		c.JSON(http.StatusNotFound, teamhubinternal.VoiceError{Code: "NOT_FOUND", Message: "VoiceSession was not found"})
		return
	case err != nil:
		a.internalVoiceRuntimeError(c, "claim Voice media epoch", err)
		return
	}
	c.JSON(http.StatusOK, teamhubinternal.VoiceMediaEpochClaim{MediaEpoch: epoch})
}

// polishVoiceDictation rewrites one dictated passage on the session owner's
// connected CLI. The runtime keeps its recognized text on any error, so a
// failure here never fails dictation.
func (a *App) polishVoiceDictation(c *gin.Context) {
	var request teamhubinternal.VoiceDictationPolishRequest
	if err := c.ShouldBindJSON(&request); err != nil || strings.TrimSpace(request.Text) == "" {
		c.JSON(http.StatusBadRequest, teamhubinternal.VoiceError{Code: "INVALID_REQUEST", Message: "Dictation text is invalid"})
		return
	}
	text, err := a.voice.PolishDictation(c.Request.Context(), c.Param("voiceSessionId"), request.Text)
	switch {
	case errors.Is(err, voice.ErrVoiceSessionNotFound):
		c.JSON(http.StatusNotFound, teamhubinternal.VoiceError{Code: "NOT_FOUND", Message: "VoiceSession was not found"})
	case errors.Is(err, voice.ErrVoicePurposeConflict):
		c.JSON(http.StatusBadRequest, teamhubinternal.VoiceError{Code: "INVALID_REQUEST", Message: "Only a chat dictation session polishes text"})
	case errors.Is(err, voice.ErrDictationPolishUnavailable):
		c.JSON(http.StatusServiceUnavailable, teamhubinternal.VoiceError{Code: "VOICE_POLISH_UNAVAILABLE", Message: "The text could not be polished"})
	case err != nil:
		a.internalVoiceRuntimeError(c, "polish dictation", err)
	default:
		c.JSON(http.StatusOK, teamhubinternal.VoiceDictationPolishResult{Text: text})
	}
}

// reportVoiceObservation applies one Voice Runtime observation. Every write is
// keyed by the event ID, the transcript window or a monotonic offset, so a
// retried observation applies again without a receipt table.
func (a *App) reportVoiceObservation(c *gin.Context, request teamhubinternal.VoiceObservation) {
	if request.MediaEpoch < 0 || request.StartOffsetMs < 0 || request.EndOffsetMs < request.StartOffsetMs ||
		(request.Kind == teamhubinternal.Final &&
			(request.Text == nil || strings.TrimSpace(*request.Text) == "" || request.EndOffsetMs <= request.StartOffsetMs)) ||
		(request.Kind == teamhubinternal.TurnFinalized && (request.Text == nil ||
			(!voice.VoiceFinalIsFormattingOnly(*request.Text) && request.EndOffsetMs <= request.StartOffsetMs))) {
		c.JSON(http.StatusBadRequest, teamhubinternal.VoiceError{Code: "INVALID_REQUEST", Message: "Voice observation fields are invalid"})
		return
	}
	status, err := a.voice.ReportObservation(c.Request.Context(), request)
	switch {
	case errors.Is(err, voice.ErrVoiceSessionNotFound):
		c.JSON(http.StatusNotFound, teamhubinternal.VoiceError{Code: "NOT_FOUND", Message: "VoiceSession was not found"})
		return
	case errors.Is(err, voice.ErrVoicePurposeConflict):
		c.JSON(http.StatusConflict, teamhubinternal.VoiceError{Code: "VOICE_PURPOSE_CONFLICT", Message: "Dictation turns require a live chat dictation session"})
		return
	case errors.Is(err, voice.ErrVoiceEventConflict):
		c.JSON(http.StatusConflict, teamhubinternal.VoiceError{Code: "EVENT_CONFLICT", Message: "Voice event conflicts with existing evidence"})
		return
	case err != nil:
		a.internalVoiceRuntimeError(c, "apply Voice observation", err)
		return
	}
	receiptStatus := teamhubinternal.VoiceObservationReceiptStatusAccepted
	if status == "ignored" {
		receiptStatus = teamhubinternal.VoiceObservationReceiptStatusIgnored
	}
	c.JSON(http.StatusAccepted, teamhubinternal.VoiceObservationReceipt{
		EventId: request.EventId, Status: receiptStatus,
	})
}

func (a *App) internalVoiceRuntimeError(c *gin.Context, operation string, err error) {
	a.logger.Error(operation, "error", err)
	c.JSON(http.StatusInternalServerError, teamhubinternal.VoiceError{
		Code: "INTERNAL_ERROR", Message: "Voice observation could not be processed",
	})
}
