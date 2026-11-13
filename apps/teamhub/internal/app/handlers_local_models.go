package app

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// The Local models endpoints are mounted so the route table matches the
// contracts; they answer NOT_IMPLEMENTED until TeamHub stores snapshots and
// forwards actions.

func (a *App) getLocalComputerModels(c *gin.Context) {
	a.writeLocalModelsNotImplemented(c)
}

func (a *App) actOnLocalComputerModel(c *gin.Context) {
	a.writeLocalModelsNotImplemented(c)
}

func (a *App) recordAgentRuntimeLocalModels(c *gin.Context) {
	a.writeLocalModelsNotImplemented(c)
}

func (a *App) writeLocalModelsNotImplemented(c *gin.Context) {
	a.writeError(c, http.StatusNotImplemented, "NOT_IMPLEMENTED", "Local models are not available yet")
}
