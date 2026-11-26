package app

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

const (
	systemTelemetryKeepaliveInterval = 15 * time.Second
	maxSystemTelemetrySSELineBytes   = 2 << 20
)

var systemTelemetryErrorMessages = map[httpapi.SystemTelemetryErrorCode]string{
	httpapi.SystemTelemetryErrorCodeLocalComputerOffline: "Local Computer is offline",
	httpapi.SystemTelemetryErrorCodeUnsupported:          "This Local Computer does not support live system telemetry",
	httpapi.SystemTelemetryErrorCodeUnavailable:          "System telemetry is temporarily unavailable",
	httpapi.SystemTelemetryErrorCodeTimeout:              "Local Computer did not emit a system telemetry snapshot in time",
	httpapi.SystemTelemetryErrorCodeForbidden:            "Only the Computer's owner can read live system telemetry",
}

var systemTelemetryErrorStatuses = map[httpapi.SystemTelemetryErrorCode]int{
	httpapi.SystemTelemetryErrorCodeLocalComputerOffline: http.StatusServiceUnavailable,
	httpapi.SystemTelemetryErrorCodeUnsupported:          http.StatusConflict,
	httpapi.SystemTelemetryErrorCodeUnavailable:          http.StatusServiceUnavailable,
	httpapi.SystemTelemetryErrorCodeTimeout:              http.StatusGatewayTimeout,
	httpapi.SystemTelemetryErrorCodeForbidden:            http.StatusForbidden,
}

func (a *App) writeSystemTelemetryCode(c *gin.Context, code httpapi.SystemTelemetryErrorCode) {
	status, found := systemTelemetryErrorStatuses[code]
	if !found {
		status = http.StatusServiceUnavailable
	}
	a.writeError(c, status, string(code), systemTelemetryErrorMessages[code])
}

func (a *App) writeSystemTelemetryGatewayError(c *gin.Context, computerID string, err error) {
	switch {
	case errors.Is(err, roomagent.ErrLocalComputerNotFound):
		a.writeError(c, http.StatusNotFound, "LOCAL_COMPUTER_NOT_FOUND", "Local Computer was not found")
	case errors.Is(err, roomagent.ErrLocalComputerOffline):
		a.writeSystemTelemetryCode(c, httpapi.SystemTelemetryErrorCodeLocalComputerOffline)
	case errors.Is(err, roomagent.ErrSystemTelemetryUnsupported):
		a.writeSystemTelemetryCode(c, httpapi.SystemTelemetryErrorCodeUnsupported)
	case errors.Is(err, roomagent.ErrSystemTelemetryTimeout):
		a.writeSystemTelemetryCode(c, httpapi.SystemTelemetryErrorCodeTimeout)
	case errors.Is(err, roomagent.ErrSystemTelemetryUnavailable):
		a.writeSystemTelemetryCode(c, httpapi.SystemTelemetryErrorCodeUnavailable)
	default:
		a.logger.Error("system_telemetry.proxy_failed", "computer_id", computerID, "error", err)
		a.writeSystemTelemetryCode(c, httpapi.SystemTelemetryErrorCodeUnavailable)
	}
}

func (a *App) authorizeSystemTelemetry(c *gin.Context) (agentruntimestate.LocalComputer, roomagent.SystemTelemetryManagement, bool) {
	if a.agentRuntimeState == nil {
		if _, ok := a.spaceHuman(c, c.Param("tenantId")); !ok {
			return agentruntimestate.LocalComputer{}, nil, false
		}
		a.writeSystemTelemetryCode(c, httpapi.SystemTelemetryErrorCodeUnavailable)
		return agentruntimestate.LocalComputer{}, nil, false
	}
	return a.authorizeSystemTelemetryWithLookup(c, a.agentRuntimeState.GetLocalComputer)
}

func (a *App) authorizeSystemTelemetryWithLookup(
	c *gin.Context,
	lookup func(ctx context.Context, computerID string) (agentruntimestate.LocalComputer, error),
) (agentruntimestate.LocalComputer, roomagent.SystemTelemetryManagement, bool) {
	tenantID, computerID := c.Param("tenantId"), c.Param("computerId")
	viewerID, ok := a.spaceHuman(c, tenantID)
	if !ok {
		return agentruntimestate.LocalComputer{}, nil, false
	}
	computer, err := lookup(c.Request.Context(), computerID)
	switch {
	case errors.Is(err, agentruntimestate.ErrNotFound), errors.Is(err, agentruntimestate.ErrInvalid),
		err == nil && computer.Owner.TenantID != tenantID:
		a.writeError(c, http.StatusNotFound, "LOCAL_COMPUTER_NOT_FOUND", "Local Computer was not found")
		return agentruntimestate.LocalComputer{}, nil, false
	case err != nil:
		a.internalError(c, "read Local Computer for system telemetry", err)
		return agentruntimestate.LocalComputer{}, nil, false
	}
	if computer.Owner.OwnerActorID != viewerID {
		a.writeSystemTelemetryCode(c, httpapi.SystemTelemetryErrorCodeForbidden)
		return agentruntimestate.LocalComputer{}, nil, false
	}
	if !localComputerOnline(computer.Status, computer.LastSeenAt, time.Now()) {
		a.writeSystemTelemetryCode(c, httpapi.SystemTelemetryErrorCodeLocalComputerOffline)
		return agentruntimestate.LocalComputer{}, nil, false
	}
	management, ok := a.localComputers.(roomagent.SystemTelemetryManagement)
	if !ok || management == nil {
		a.writeSystemTelemetryCode(c, httpapi.SystemTelemetryErrorCodeUnavailable)
		return agentruntimestate.LocalComputer{}, nil, false
	}
	return computer, management, true
}

func systemTelemetryComputerMeta(computer agentruntimestate.LocalComputer, now time.Time) httpapi.SystemTelemetryComputer {
	status := httpapi.SystemTelemetryComputerOffline
	if localComputerOnline(computer.Status, computer.LastSeenAt, now) {
		status = httpapi.SystemTelemetryComputerOnline
	}
	return httpapi.SystemTelemetryComputer{
		ComputerId:  computer.ComputerID,
		DisplayName: computer.DisplayName,
		Status:      status,
		LastSeenAt:  computer.LastSeenAt,
	}
}

func projectSystemTelemetryView(computer agentruntimestate.LocalComputer, envelope nodeservicesinternal.SystemTelemetryEnvelope, now time.Time) (httpapi.SystemTelemetryView, error) {
	encoded, err := json.Marshal(envelope.Snapshot)
	if err != nil {
		return httpapi.SystemTelemetryView{}, err
	}
	var snapshot httpapi.SystemTelemetrySnapshot
	if err := json.Unmarshal(encoded, &snapshot); err != nil {
		return httpapi.SystemTelemetryView{}, err
	}
	return httpapi.SystemTelemetryView{
		Computer:      systemTelemetryComputerMeta(computer, now),
		ViewerIsOwner: true,
		Revision:      envelope.Revision,
		ObservedAt:    envelope.ObservedAt,
		Snapshot:      snapshot,
	}, nil
}

// getLocalComputerSystemTelemetry proxies one live system telemetry snapshot
// for the authenticated owner's Local Computer.
func (a *App) getLocalComputerSystemTelemetry(c *gin.Context) {
	computer, management, ok := a.authorizeSystemTelemetry(c)
	if !ok {
		return
	}
	a.serveSystemTelemetrySnapshot(c, computer, management)
}

func (a *App) serveSystemTelemetrySnapshot(c *gin.Context, computer agentruntimestate.LocalComputer, management roomagent.SystemTelemetryManagement) {
	target := roomagent.SystemTelemetryTarget{
		TenantID:     computer.Owner.TenantID,
		OwnerActorID: computer.Owner.OwnerActorID,
		ComputerID:   computer.ComputerID,
	}
	envelope, err := management.GetLocalComputerSystemTelemetry(c.Request.Context(), target)
	if err != nil {
		a.writeSystemTelemetryGatewayError(c, computer.ComputerID, err)
		return
	}
	view, err := projectSystemTelemetryView(computer, envelope, time.Now())
	if err != nil {
		a.internalError(c, "project Local Computer system telemetry", err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, view)
}

type upstreamSSEFrame struct {
	event string
	data  string
}

// streamLocalComputerSystemTelemetry proxies a live 1 Hz system telemetry SSE
// stream from Agent Service with immediate client-disconnect cancellation and
// 15-second keepalive comments.
func (a *App) streamLocalComputerSystemTelemetry(c *gin.Context) {
	computer, management, ok := a.authorizeSystemTelemetry(c)
	if !ok {
		return
	}
	a.serveSystemTelemetryStream(c, computer, management)
}

func (a *App) serveSystemTelemetryStream(c *gin.Context, computer agentruntimestate.LocalComputer, management roomagent.SystemTelemetryManagement) {
	principal := currentPrincipal(c)
	streamCtx, cancelStream := context.WithCancel(c.Request.Context())
	defer cancelStream()
	if a.streamsDone != nil {
		go func() {
			select {
			case <-a.streamsDone.Done():
				cancelStream()
			case <-streamCtx.Done():
			}
		}()
	}

	target := roomagent.SystemTelemetryTarget{
		TenantID:     computer.Owner.TenantID,
		OwnerActorID: computer.Owner.OwnerActorID,
		ComputerID:   computer.ComputerID,
	}
	upstream, err := management.StreamLocalComputerSystemTelemetry(streamCtx, target)
	if err != nil {
		a.writeSystemTelemetryGatewayError(c, computer.ComputerID, err)
		return
	}
	stopClose := context.AfterFunc(streamCtx, func() { _ = upstream.Body.Close() })
	defer func() {
		stopClose()
		_ = upstream.Body.Close()
	}()

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache, no-transform")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")
	c.Status(http.StatusOK)
	c.Writer.Flush()

	response := http.NewResponseController(c.Writer)
	defer func() { _ = response.SetWriteDeadline(time.Time{}) }()

	frames := make(chan upstreamSSEFrame, 4)
	go readUpstreamSSEFrames(streamCtx, upstream.Body, frames)

	keepaliveInterval := systemTelemetryKeepaliveInterval
	if a.cfg.SSEHeartbeatInterval > 0 && a.cfg.SSEHeartbeatInterval < keepaliveInterval {
		keepaliveInterval = a.cfg.SSEHeartbeatInterval
	}
	keepalive := time.NewTicker(keepaliveInterval)
	defer keepalive.Stop()

	var expiryC <-chan time.Time
	var expiry *time.Timer
	if !principal.Session.ExpiresAt.Time.IsZero() {
		expiry = time.NewTimer(max(time.Millisecond, time.Until(principal.Session.ExpiresAt.Time)))
		defer expiry.Stop()
		expiryC = expiry.C
	}

	writeSSE := func(eventName string, payload []byte) bool {
		_ = response.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if _, writeErr := fmt.Fprintf(c.Writer, "event: %s\ndata: %s\n\n", eventName, payload); writeErr != nil {
			return false
		}
		c.Writer.Flush()
		return streamCtx.Err() == nil
	}

	for {
		select {
		case <-streamCtx.Done():
			return
		case frame, open := <-frames:
			if !open {
				return
			}
			switch frame.event {
			case "telemetry.snapshot":
				var envelope nodeservicesinternal.SystemTelemetryEnvelope
				if unmarshalErr := json.Unmarshal([]byte(frame.data), &envelope); unmarshalErr != nil {
					a.logger.Warn("system_telemetry.stream_decode_failed", "computer_id", computer.ComputerID, "error", unmarshalErr)
					continue
				}
				view, projErr := projectSystemTelemetryView(computer, envelope, time.Now())
				if projErr != nil {
					continue
				}
				encoded, marshalErr := json.Marshal(view)
				if marshalErr != nil {
					continue
				}
				if !writeSSE("telemetry.snapshot", encoded) {
					return
				}
			case "telemetry.status":
				if !writeSSE("telemetry.status", []byte(frame.data)) {
					return
				}
			}
		case <-keepalive.C:
			if len(principal.Token) > 0 && !a.ensureStreamSession(c, c.Writer, principal.Token) {
				return
			}
			_ = response.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if _, writeErr := io.WriteString(c.Writer, ": keepalive\n\n"); writeErr != nil {
				return
			}
			c.Writer.Flush()
		case <-expiryC:
			if expiry != nil && len(principal.Token) > 0 && !a.resetStreamSessionExpiry(c, c.Writer, principal.Token, expiry) {
				return
			}
		}
	}
}

func readUpstreamSSEFrames(ctx context.Context, body io.Reader, out chan<- upstreamSSEFrame) {
	defer close(out)
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64*1024), maxSystemTelemetrySSELineBytes)
	var eventName string
	var dataLines []string
	flush := func() bool {
		if len(dataLines) == 0 {
			eventName = ""
			return true
		}
		name := eventName
		if name == "" {
			name = "message"
		}
		frame := upstreamSSEFrame{
			event: name,
			data:  strings.Join(dataLines, "\n"),
		}
		eventName = ""
		dataLines = dataLines[:0]
		select {
		case out <- frame:
			return true
		case <-ctx.Done():
			return false
		}
	}
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			if !flush() {
				return
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		if value, ok := strings.CutPrefix(line, "event:"); ok {
			eventName = strings.TrimSpace(value)
		} else if value, ok := strings.CutPrefix(line, "data:"); ok {
			dataLines = append(dataLines, strings.TrimPrefix(value, " "))
		}
	}
	flush()
}
