package app

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicekey"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// getVoiceMediaPolicy reports what voice can do now: each provider's key and
// owned online local speech readiness are read at request time, so a key save
// or speech model download already counts.
func (a *App) getVoiceMediaPolicy(c *gin.Context) {
	accountID := currentPrincipal(c).Session.AccountID
	tenantID := c.Param("tenantId")
	policy, err := a.voice.MediaPolicy(c.Request.Context(), store.GetVoiceMediaPolicyForAccountParams{
		AccountID: accountID, TenantID: tenantID,
		AuthSessionID: currentPrincipal(c).Session.ID,
	})
	if a.writeVoiceMediaError(c, "resolve Voice media policy", err) {
		return
	}
	soniox, err := a.voiceKeys.Status(c.Request.Context(), voicekey.Soniox)
	if a.writeVoiceMediaError(c, "resolve Soniox key status", err) {
		return
	}
	xai, err := a.voiceKeys.Status(c.Request.Context(), voicekey.XAI)
	if a.writeVoiceMediaError(c, "resolve xAI key status", err) {
		return
	}
	available := a.voiceMedia != nil && a.voiceKeys.Enabled()
	sonioxConfigured := soniox.Source != voicekey.SourceNone
	speech, err := a.voice.ResolveSpeechState(
		c.Request.Context(), accountID, tenantID, policy.ActorID,
		sonioxConfigured, a.voiceLocalASRURL, time.Now(),
	)
	if a.writeVoiceMediaError(c, "resolve local speech state", err) {
		return
	}
	activeProvider := httpapi.VoiceMediaActiveSpeechProviderNone
	if available {
		switch speech.ActiveSpeechProvider {
		case "local":
			activeProvider = httpapi.VoiceMediaActiveSpeechProviderLocal
		case "cloud":
			activeProvider = httpapi.VoiceMediaActiveSpeechProviderCloud
		}
	}
	transcription := available && activeProvider != httpapi.VoiceMediaActiveSpeechProviderNone
	localSpeechAvailable := available && speech.LocalSpeechAvailable
	localSpeechReady := available && speech.LocalSpeechReady
	live := available && xai.Source != voicekey.SourceNone
	sonioxStatus, xaiStatus := voiceProviderKeyModel(soniox), voiceProviderKeyModel(xai)
	response := httpapi.VoiceMediaPolicy{
		LiveSupported:        &live,
		LiveEnabled:          &live,
		VoiceMediaSupported:  transcription,
		ActiveSpeechProvider: &activeProvider,
		LocalSpeechAvailable: &localSpeechAvailable,
		LocalSpeechReady:     &localSpeechReady,
		VoiceAvailable:       &available,
		SonioxKey:            &sonioxStatus,
		XaiKey:               &xaiStatus,
	}
	if policy.LivekitRoomID != "" {
		response.ActiveRoomId = &policy.LivekitRoomID
	}
	c.JSON(http.StatusOK, response)
}
