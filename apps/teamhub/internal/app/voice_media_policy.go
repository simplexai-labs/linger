package app

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicekey"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// getVoiceMediaPolicy reports what voice can do now: each provider's key is
// read at request time, so a key saved a moment ago already counts.
func (a *App) getVoiceMediaPolicy(c *gin.Context) {
	policy, err := a.voice.MediaPolicy(c.Request.Context(), store.GetVoiceMediaPolicyForAccountParams{
		AccountID: currentPrincipal(c).Session.AccountID, TenantID: c.Param("tenantId"),
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
	transcription := available && soniox.Source != voicekey.SourceNone
	live := available && xai.Source != voicekey.SourceNone
	sonioxStatus, xaiStatus := voiceProviderKeyModel(soniox), voiceProviderKeyModel(xai)
	// The downloaded speech model serves dictation only when no Soniox key
	// exists; it labels no speakers, so recording stays on Soniox.
	// It also waits for a person to choose the model that rewrites the text.
	localReady, err := a.localDictationEnabled(c.Request.Context())
	if a.writeVoiceMediaError(c, "resolve dictation settings", err) {
		return
	}
	local := available && soniox.Source == voicekey.SourceNone && localReady
	response := httpapi.VoiceMediaPolicy{
		LiveSupported: &live, LiveEnabled: &live,
		VoiceMediaSupported:     transcription,
		VoiceAvailable:          &available,
		LocalDictationSupported: &local,
		SonioxKey:               &sonioxStatus, XaiKey: &xaiStatus,
	}
	if policy.LivekitRoomID != "" {
		response.ActiveRoomId = &policy.LivekitRoomID
	}
	c.JSON(http.StatusOK, response)
}
