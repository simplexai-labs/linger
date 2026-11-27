package app

import (
	"context"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicekey"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// saveVoiceProviderKey stores the deployment's API key for one voice provider
// after the provider accepts it. Any signed-in Human may save, as for
// Composio. The key is never returned, logged or echoed in an error.
func (a *App) saveVoiceProviderKey(c *gin.Context) {
	provider := voicekey.Provider(c.Param("provider"))
	var request httpapi.SaveVoiceProviderKeyRequest
	if !provider.Valid() || decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, string(httpapi.VoiceProviderKeyErrorCodeInvalidRequest), "Voice provider key request is invalid")
		return
	}
	err := a.voiceKeys.Save(c.Request.Context(), provider, request.ApiKey)
	switch {
	case errors.Is(err, voicekey.ErrInvalid):
		a.writeError(c, http.StatusBadRequest, string(httpapi.VoiceProviderKeyErrorCodeInvalidRequest), "Voice provider API key is invalid")
	case errors.Is(err, voicekey.ErrRejected):
		a.writeError(c, http.StatusBadRequest, string(httpapi.VoiceProviderKeyErrorCodeVoiceKeyRejected), "The voice provider rejected this API key")
	case errors.Is(err, voicekey.ErrNoBalance):
		a.writeError(c, http.StatusBadRequest, string(httpapi.VoiceProviderKeyErrorCodeVoiceKeyNoBalance), "The voice provider account has no balance or budget left")
	case errors.Is(err, voicekey.ErrNoRealtime):
		a.writeError(c, http.StatusBadRequest, string(httpapi.VoiceProviderKeyErrorCodeVoiceKeyNoRealtimePermission), "This API key may not use the voice provider's realtime transcription")
	case errors.Is(err, voicekey.ErrFromEnvironment):
		a.writeError(c, http.StatusConflict, string(httpapi.VoiceProviderKeyErrorCodeVoiceKeyFromEnvironment), "This deployment sets this voice provider's API key")
	case errors.Is(err, voicekey.ErrVoiceOff):
		a.writeError(c, http.StatusServiceUnavailable, string(httpapi.VoiceProviderKeyErrorCodeVoiceMediaOff), "Voice is off in this deployment")
	case errors.Is(err, voicekey.ErrStorageMissing):
		a.writeError(c, http.StatusServiceUnavailable, string(httpapi.VoiceProviderKeyErrorCodeVoiceKeyStorageUnavailable), "This deployment cannot store a voice provider API key")
	case errors.Is(err, voicekey.ErrProviderUnavailable):
		a.writeError(c, http.StatusServiceUnavailable, string(httpapi.VoiceProviderKeyErrorCodeVoiceProviderUnavailable), "The voice provider could not be reached; try again")
	case err != nil:
		a.internalError(c, "save voice provider key", err)
	default:
		status, err := a.voiceKeys.Status(c.Request.Context(), provider)
		if err != nil {
			a.internalError(c, "resolve voice provider key status", err)
			return
		}
		a.awaitVoiceWorkers(c.Request.Context())
		c.JSON(http.StatusOK, voiceProviderKeyModel(status))
	}
}

// awaitVoiceWorkers asks Node Services to start the voice workers the saved
// key enables and waits until they are registered with LiveKit, so a voice
// session the client starts right after the save finds a worker to dispatch
// to. A failure only logs: the save stands and Node Services' periodic
// reconcile picks the key up.
func (a *App) awaitVoiceWorkers(requestContext context.Context) {
	if a.reconcileVoiceWorkers == nil {
		return
	}
	ctx, cancel := context.WithTimeout(requestContext, voiceReconcileTimeout)
	defer cancel()
	ready, err := a.reconcileVoiceWorkers(ctx)
	var statusErr voiceReconcileStatusError
	switch {
	case errors.As(err, &statusErr):
		a.logger.Warn("voice.workers_not_ready", "reason", "status", "status", statusErr.status)
	case err != nil:
		a.logger.Warn("voice.workers_not_ready", "reason", "error", "error", err)
	case !ready:
		a.logger.Warn("voice.workers_not_ready", "reason", "not_ready")
	}
}

func voiceProviderKeyModel(status voicekey.Status) httpapi.VoiceProviderKeyStatus {
	return httpapi.VoiceProviderKeyStatus{Source: httpapi.VoiceProviderKeyStatusSource(status.Source), CanSave: status.CanSave}
}

// getVoiceProviderKeys returns the effective voice provider keys and local ASR
// enablement to Node Services; a provider without a key is absent, and all
// voice capabilities are off while voice media is off.
func (a *App) getVoiceProviderKeys(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	var keys teamhubinternal.VoiceRuntimeProviderKeys
	for provider, target := range map[voicekey.Provider]**string{voicekey.Soniox: &keys.SonioxApiKey, voicekey.XAI: &keys.XaiApiKey} {
		key, err := a.voiceKeys.Effective(c.Request.Context(), provider)
		if err != nil {
			a.logger.Error("voice.provider_keys_read_failed", "provider", string(provider), "error", err)
			c.JSON(http.StatusInternalServerError, teamhubinternal.VoiceError{Code: "INTERNAL_ERROR", Message: "Voice provider keys could not be read"})
			return
		}
		if key != "" {
			*target = &key
		}
	}
	if a.voiceMedia != nil && a.voiceKeys.Enabled() {
		localEnabled := a.voiceLocalASRURL != ""
		if !localEnabled && a.voice != nil {
			enabled, err := a.voice.HasLocalSpeechEnabled(c.Request.Context())
			if err != nil {
				a.logger.Error("voice.local_speech_state_read_failed", "error", err)
				c.JSON(http.StatusInternalServerError, teamhubinternal.VoiceError{Code: "INTERNAL_ERROR", Message: "Voice local speech state could not be read"})
				return
			}
			localEnabled = enabled
		}
		if localEnabled {
			keys.LocalAsrEnabled = &localEnabled
		}
		if a.voiceLocalASRURL != "" {
			url := a.voiceLocalASRURL
			keys.LocalAsrUrl = &url
		}
	}
	c.JSON(http.StatusOK, keys)
}
