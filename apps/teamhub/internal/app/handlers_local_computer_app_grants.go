package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// listLocalComputerAppGrants returns every active per-app desktop grant on one
// of the signed-in human's Local Computers.
func (a *App) listLocalComputerAppGrants(c *gin.Context) {
	tenantID := c.Param("tenantId")
	ownerID, ok := a.spaceHuman(c, tenantID)
	if !ok {
		return
	}
	grants, err := a.typedCards.ListLocalComputerAppGrants(c.Request.Context(), tenantID, ownerID, c.Param("computerId"))
	if errors.Is(err, typedcard.ErrLocalComputerNotFound) {
		a.writeError(c, http.StatusNotFound, "LOCAL_COMPUTER_NOT_FOUND", "Local Computer was not found")
		return
	}
	if err != nil {
		a.internalError(c, "list local computer app grants", err)
		return
	}
	items := make([]httpapi.LocalComputerAppGrant, 0, len(grants))
	for _, grant := range grants {
		items = append(items, httpapi.LocalComputerAppGrant{
			Id:               grant.ID,
			ComputerId:       grant.ComputerID,
			AgentActorId:     grant.AgentActorID,
			AgentDisplayName: grant.AgentDisplayName,
			BundleId:         grant.BundleID,
			AppName:          grant.AppName,
			CreatedAt:        grant.CreatedAt,
		})
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, httpapi.LocalComputerAppGrantList{Items: items})
}

// revokeLocalComputerAppGrant revokes one persistent per-app desktop grant on
// the signed-in human's Local Computer.
func (a *App) revokeLocalComputerAppGrant(c *gin.Context) {
	tenantID := c.Param("tenantId")
	ownerID, ok := a.spaceHuman(c, tenantID)
	if !ok {
		return
	}
	err := a.typedCards.RevokeLocalComputerAppGrant(c.Request.Context(), tenantID, ownerID, c.Param("computerId"), c.Param("grantId"))
	if errors.Is(err, typedcard.ErrLocalComputerNotFound) {
		a.writeError(c, http.StatusNotFound, "LOCAL_COMPUTER_NOT_FOUND", "Local Computer was not found")
		return
	}
	if errors.Is(err, typedcard.ErrNotFound) {
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "Local Computer app grant was not found")
		return
	}
	if err != nil {
		a.internalError(c, "revoke local computer app grant", err)
		return
	}
	c.Status(http.StatusNoContent)
}
