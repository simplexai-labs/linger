package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/mobilegateway"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/mobilerelay"
)

// The Relay node list is deployment-wide, like the web search keys: any
// signed-in Human may change it. A node only forwards end-to-end encrypted
// bytes, and the Gateway dials it only on the fixed Relay paths.

func (a *App) mobileRelaysReady(c *gin.Context) bool {
	if a.mobileGateway == nil {
		a.writeError(c, http.StatusServiceUnavailable, "MOBILE_UNAVAILABLE", "Phones cannot connect: this deployment has no secret seed")
		return false
	}
	return true
}

func (a *App) relayNodeView(node mobilerelay.Node) httpapi.MobileRelayNode {
	return httpapi.MobileRelayNode{
		Id: node.ID, Url: node.URL, Label: node.Label, Kind: httpapi.MobileRelayNodeKind(node.Kind),
		Enabled: node.Enabled, Connected: node.Enabled && a.mobileGateway.RelayConnected(node.URL),
	}
}

func (a *App) listMobileRelayNodes(c *gin.Context) {
	if !a.mobileRelaysReady(c) {
		return
	}
	nodes, err := a.mobileRelays.List(c.Request.Context())
	if err != nil {
		a.internalError(c, "list relay nodes", err)
		return
	}
	items := make([]httpapi.MobileRelayNode, 0, len(nodes))
	for _, node := range nodes {
		items = append(items, a.relayNodeView(node))
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, httpapi.MobileRelayNodeList{Items: items, LinksOff: a.mobileRelayLinksOff})
}

func (a *App) createMobileRelayNode(c *gin.Context) {
	if !a.mobileRelaysReady(c) {
		return
	}
	var request httpapi.CreateMobileRelayNodeRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Relay node request is invalid")
		return
	}
	label := ""
	if request.Label != nil {
		label = *request.Label
	}
	var err error
	if _, phone := mobilegateway.PhoneSession(c.Request.Context()); phone {
		err = mobilerelay.CheckPublic(c.Request.Context(), request.Url)
	}
	var node mobilerelay.Node
	if err == nil {
		node, err = a.mobileRelays.Create(c.Request.Context(), request.Url, label)
	}
	switch {
	case errors.Is(err, mobilerelay.ErrPrivate):
		a.writeError(c, http.StatusForbidden, "RELAY_PRIVATE_FROM_PHONE", "A node on a private network can be added only on the computer")
		return
	case errors.Is(err, mobilerelay.ErrInvalidURL):
		a.writeError(c, http.StatusBadRequest, "INVALID_RELAY_URL", "A Relay node URL is a ws:// or wss:// origin with no path")
		return
	case errors.Is(err, mobilerelay.ErrExists):
		a.writeError(c, http.StatusConflict, "RELAY_EXISTS", "This Relay node is already listed")
		return
	case errors.Is(err, mobilerelay.ErrTooMany):
		a.writeError(c, http.StatusConflict, "TOO_MANY_RELAYS", "Remove a custom Relay node before adding another")
		return
	case err != nil:
		a.internalError(c, "create relay node", err)
		return
	}
	a.syncMobileRelays(c.Request.Context())
	c.JSON(http.StatusCreated, a.relayNodeView(node))
}

func (a *App) updateMobileRelayNode(c *gin.Context) {
	if !a.mobileRelaysReady(c) {
		return
	}
	var request httpapi.UpdateMobileRelayNodeRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Relay node update is invalid")
		return
	}
	node, err := a.mobileRelays.SetEnabled(c.Request.Context(), c.Param("relayId"), request.Enabled)
	if errors.Is(err, mobilerelay.ErrNotFound) {
		a.writeError(c, http.StatusNotFound, "RELAY_NOT_FOUND", "No Relay node has this ID")
		return
	}
	if err != nil {
		a.internalError(c, "update relay node", err)
		return
	}
	a.syncMobileRelays(c.Request.Context())
	c.JSON(http.StatusOK, a.relayNodeView(node))
}

func (a *App) removeMobileRelayNode(c *gin.Context) {
	if !a.mobileRelaysReady(c) {
		return
	}
	err := a.mobileRelays.Remove(c.Request.Context(), c.Param("relayId"))
	if errors.Is(err, mobilerelay.ErrOfficial) {
		a.writeError(c, http.StatusConflict, "RELAY_OFFICIAL", "Official Relay nodes can be turned off but not removed")
		return
	}
	if err != nil {
		a.internalError(c, "remove relay node", err)
		return
	}
	a.syncMobileRelays(c.Request.Context())
	c.Status(http.StatusNoContent)
}
