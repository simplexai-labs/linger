package app

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/localidentity"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// proveLocalIdentity answers the desktop app's challenge on a local
// installation; other servers have no key and do not offer it.
func (a *App) proveLocalIdentity(c *gin.Context) {
	if a.cfg.LocalIdentityKey == "" {
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "not a local installation")
		return
	}
	key, err := localidentity.DecodeKey(a.cfg.LocalIdentityKey)
	if err != nil {
		a.internalError(c, "decode local identity key", err)
		return
	}
	var request httpapi.LocalIdentityChallenge
	if err := decodeJSON(c, &request); err != nil || !localidentity.ValidNonce(request.Nonce) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "nonce must be 32 bytes in unpadded base64url")
		return
	}
	c.JSON(http.StatusOK, httpapi.LocalIdentityProof{
		Proof: localidentity.Proof(key, request.Nonce, a.cfg.PublicWebURL),
	})
}
