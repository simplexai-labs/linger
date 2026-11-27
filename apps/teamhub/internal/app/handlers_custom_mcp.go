package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/custommcp"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) listCustomMCP(c *gin.Context) {
	session := currentPrincipal(c).Session
	items, err := a.externalSources.ListCustomMCP(c.Request.Context(), session.HumanTenantID, session.HumanActorID)
	if a.writeCustomMCPError(c, err) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"connections": items})
}

func (a *App) saveCustomMCP(c *gin.Context) {
	var input httpapi.SaveCustomMcpConnectionJSONRequestBody
	if decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 24<<10), &input, "invalid MCP connector") != nil ||
		(input.Id == nil) != (input.Revision == nil) ||
		input.Revision != nil && (*input.Revision < 1 || *input.Id == "") {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Invalid custom connector configuration")
		return
	}
	session := currentPrincipal(c).Session
	config := externalsource.CustomMCPConnection{Name: input.Name, Endpoint: input.Endpoint}
	if input.Id != nil {
		config.ID, config.Revision = *input.Id, *input.Revision
	}
	item, err := a.externalSources.SaveCustomMCP(c.Request.Context(), session.AccountID, session.HumanTenantID, session.HumanActorID,
		config, input.Token)
	if a.writeCustomMCPError(c, err) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, item)
}

func (a *App) testCustomMCP(c *gin.Context) {
	var input httpapi.TestCustomMcpConnectionJSONRequestBody
	if decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 24<<10), &input, "invalid MCP test request") != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Invalid custom connector test request")
		return
	}
	var token string
	if input.Token != nil {
		token = *input.Token
	}
	tools, err := a.externalSources.TestCustomMCP(c.Request.Context(), input.Endpoint, token)
	if a.writeCustomMCPError(c, err) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"tools": tools})
}

func (a *App) deleteCustomMCP(c *gin.Context) {
	session := currentPrincipal(c).Session
	err := a.externalSources.DeleteCustomMCP(c.Request.Context(), session.HumanTenantID, session.HumanActorID, c.Param("connectionId"))
	if !a.writeCustomMCPError(c, err) {
		c.Status(http.StatusNoContent)
	}
}

func (a *App) writeCustomMCPError(c *gin.Context, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, custommcp.ErrInvalid), errors.Is(err, externalsource.ErrInvalid):
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Enter a public MCP URL and use HTTPS for a bearer token")
	case errors.Is(err, custommcp.ErrUnauthorized):
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "The MCP server rejected authentication")
	case errors.Is(err, custommcp.ErrUnavailable):
		a.writeError(c, http.StatusBadGateway, "EXTERNAL_SOURCE_UNAVAILABLE", "The MCP server could not complete the connection test")
	case errors.Is(err, externalsource.ErrManagedKeyStorageMissing):
		a.writeError(c, http.StatusServiceUnavailable, "EXTERNAL_SOURCE_UNAVAILABLE", "This deployment cannot save MCP tokens")
	default:
		return a.writeExternalSourceError(c, "manage custom MCP connector", err)
	}
	return true
}
