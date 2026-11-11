package app

import (
	"bytes"
	"errors"
	"mime"
	"mime/multipart"
	"net/http"

	"github.com/gin-gonic/gin"
)

func agentFileToolMultipartReader(c *gin.Context, maxBytes int64) (*multipart.Reader, error) {
	mediaType, parameters, err := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if err != nil || mediaType != "multipart/form-data" || parameters["boundary"] == "" {
		return nil, errors.New("request must be multipart/form-data with one boundary")
	}
	// Files of up to hundreds of MiB outlast the server's whole-request read timeout.
	if err := extendUploadReadDeadline(c); err != nil {
		return nil, err
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBytes)
	return multipart.NewReader(c.Request.Body, parameters["boundary"]), nil
}

func decodeStrictJSONBytes(body []byte, target any) error {
	return decodeStrictJSON(bytes.NewReader(body), target, "envelope must contain one JSON object")
}
