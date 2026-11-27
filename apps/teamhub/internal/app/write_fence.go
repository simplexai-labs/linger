package app

import (
	"context"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	writeFenceRetryAfterSeconds = "5"
	writeFenceErrorCode         = "service_upgrading"
	writeFenceErrorMessage      = "Service upgrade in progress; please retry shortly"
	defaultWriteFencePollPeriod = 100 * time.Millisecond
)

func writeFenceActive(fenceFile string) bool {
	if fenceFile == "" {
		return false
	}
	_, err := os.Stat(fenceFile)
	return err == nil
}

func isWriteFenceExempt(method, reqPath string) bool {
	if reqPath == "/healthz" && (method == http.MethodGet || method == http.MethodHead) {
		return true
	}
	return reqPath == "/v0/local/identity" && method == http.MethodPost
}

// writeFenceMiddleware rejects all non-probe HTTP requests with 503 Service
// Unavailable + Retry-After while TEAMHUB_WRITE_FENCE_FILE exists on disk.
// When TEAMHUB_WRITE_FENCE_FILE is unset, it adds zero filesystem overhead.
func (a *App) writeFenceMiddleware() gin.HandlerFunc {
	fenceFile := strings.TrimSpace(a.cfg.WriteFenceFile)
	if fenceFile == "" {
		return func(c *gin.Context) {
			c.Next()
		}
	}
	return func(c *gin.Context) {
		if writeFenceActive(fenceFile) && !isWriteFenceExempt(c.Request.Method, c.Request.URL.Path) {
			c.Header("Retry-After", writeFenceRetryAfterSeconds)
			a.writeRetryableError(c, http.StatusServiceUnavailable, writeFenceErrorCode, writeFenceErrorMessage)
			c.Abort()
			return
		}
		c.Next()
	}
}

// waitForWriteFence polls until fenceFile is removed or ctx/workerCtx ends,
// then invokes start to launch background DB writers.
func waitForWriteFence(ctx, workerCtx context.Context, fenceFile string, pollInterval time.Duration, start func() error, onError func(error)) bool {
	if pollInterval <= 0 {
		pollInterval = defaultWriteFencePollPeriod
	}
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		if !writeFenceActive(fenceFile) {
			if ctx.Err() != nil || workerCtx.Err() != nil {
				return false
			}
			if err := start(); err != nil && onError != nil && workerCtx.Err() == nil {
				onError(err)
			}
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-workerCtx.Done():
			return false
		case <-ticker.C:
		}
	}
}
