package app

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// saveVoiceProviderKey stores the deployment's API key for one voice provider.
func (a *App) saveVoiceProviderKey(c *gin.Context) {
	// Replaced by the voice provider key store.
	a.writeError(c, http.StatusNotImplemented, "NOT_IMPLEMENTED", "Saving voice provider keys is not implemented")
}

// getVoiceProviderKeys returns the effective voice provider keys to the Voice Runtime.
func (a *App) getVoiceProviderKeys(c *gin.Context) {
	// Replaced by the voice provider key store.
	a.writeError(c, http.StatusNotImplemented, "NOT_IMPLEMENTED", "Reading voice provider keys is not implemented")
}
