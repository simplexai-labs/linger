package app

import (
	"crypto/rand"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
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

// createLocalSession mints a Session for the local installation's owner account
// after verifying the desktop app's time-bounded, single-use HMAC proof.
func (a *App) createLocalSession(c *gin.Context) {
	if a.cfg.LocalIdentityKey == "" {
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "not a local installation")
		return
	}
	key, err := localidentity.DecodeKey(a.cfg.LocalIdentityKey)
	if err != nil {
		a.internalError(c, "decode local identity key", err)
		return
	}
	var request httpapi.LocalSessionRequest
	if err := decodeJSON(c, &request); err != nil || !localidentity.ValidNonce(request.Nonce) || request.Proof == "" {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "nonce, timestamp, and proof are required")
		return
	}
	now := time.Now().UTC()
	windowSeconds := int64(localidentity.SessionProofWindow.Seconds())
	if delta := now.Unix() - request.Timestamp; delta < -windowSeconds || delta > windowSeconds {
		a.writeError(c, http.StatusUnauthorized, "UNAUTHENTICATED", "local session proof is invalid or expired")
		return
	}
	if !localidentity.VerifySessionProof(key, request.Nonce, request.Timestamp, a.cfg.PublicWebURL, request.Proof) {
		a.writeError(c, http.StatusUnauthorized, "UNAUTHENTICATED", "local session proof is invalid or expired")
		return
	}
	// Add one second to cover subsecond truncation in now.Unix() across the window.
	if !a.localSessionNonces.Consume(request.Nonce, now, 2*localidentity.SessionProofWindow+time.Second) {
		a.writeError(c, http.StatusUnauthorized, "UNAUTHENTICATED", "local session proof is invalid or expired")
		return
	}
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		a.internalError(c, "generate session token", err)
		return
	}
	expiresAt := now.Add(a.cfg.EffectiveSessionTTL())
	session, err := a.sessions.CreateLocalOwnerSession(c.Request.Context(), tokenDigest(token), expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "owner account is not provisioned")
		return
	}
	if err != nil {
		a.internalError(c, "create local session", err)
		return
	}
	c.Header("Cache-Control", "no-store")
	a.writeAuthenticatedSession(c, http.StatusOK, session, token)
}
