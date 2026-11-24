package app

import (
	"net/http"

	"github.com/gin-gonic/gin"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// getURLPreviewFraming reads a page's framing rules for the Web link preview
// panel, which cannot read a cross-origin frame's response headers itself.
// Probe fails only for an invalid URL.
func (a *App) getURLPreviewFraming(c *gin.Context) {
	params := contractParams[httpapi.GetUrlPreviewFramingParams](c)
	pageScheme := ""
	if params.PageScheme != nil {
		pageScheme = string(*params.PageScheme)
	}
	framing, err := a.urlPreview.Probe(c.Request.Context(), params.Url, pageScheme)
	if err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "The URL must be an http or https page without credentials")
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, httpapi.UrlPreviewFraming{Framing: httpapi.UrlPreviewFramingFraming(framing)})
}
