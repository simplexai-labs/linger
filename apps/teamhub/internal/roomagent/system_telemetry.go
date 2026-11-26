package roomagent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

// localSystemTelemetrySnapshotTimeout bounds one-shot telemetry snapshot reads
// at the Agent Service gateway (covering its 10-second tick wait plus headroom).
const localSystemTelemetrySnapshotTimeout = 15 * time.Second

// Errors returned by system telemetry gateway operations.
var (
	// ErrSystemTelemetryUnsupported reports that the connected Computer Daemon
	// or its localmodels kit does not support live-tick system telemetry.
	ErrSystemTelemetryUnsupported = errors.New("Local Computer does not support live system telemetry")
	// ErrSystemTelemetryUnavailable reports a transient telemetry collector or
	// gateway outage.
	ErrSystemTelemetryUnavailable = errors.New("Local Computer system telemetry is unavailable")
	// ErrSystemTelemetryTimeout reports that the Computer did not emit a live
	// telemetry snapshot before the request deadline.
	ErrSystemTelemetryTimeout = errors.New("Local Computer did not emit a system telemetry snapshot in time")
)

// SystemTelemetryTarget identifies an owned Local Computer for live telemetry.
type SystemTelemetryTarget struct {
	TenantID, OwnerActorID, ComputerID string
}

// SystemTelemetryManagement reads live snapshots and opens live SSE streams for
// an owned Local Computer through Agent Service.
type SystemTelemetryManagement interface {
	GetLocalComputerSystemTelemetry(ctx context.Context, target SystemTelemetryTarget) (nodeservicesinternal.SystemTelemetryEnvelope, error)
	StreamLocalComputerSystemTelemetry(ctx context.Context, target SystemTelemetryTarget) (*http.Response, error)
}

func validSystemTelemetryTarget(target SystemTelemetryTarget) bool {
	return opaqueIDPattern.MatchString(target.TenantID) &&
		opaqueIDPattern.MatchString(target.OwnerActorID) &&
		opaqueIDPattern.MatchString(target.ComputerID)
}

// GetLocalComputerSystemTelemetry fetches one live telemetry snapshot from the
// owner's connected Computer via Agent Service.
func (g *HTTPGateway) GetLocalComputerSystemTelemetry(ctx context.Context, target SystemTelemetryTarget) (nodeservicesinternal.SystemTelemetryEnvelope, error) {
	if !validSystemTelemetryTarget(target) {
		return nodeservicesinternal.SystemTelemetryEnvelope{}, ErrLocalComputerNotFound
	}
	response, err := g.telemetrySnapshotClient.GetLocalComputerSystemTelemetryWithResponse(
		ctx, target.TenantID, target.OwnerActorID, target.ComputerID,
	)
	if err != nil {
		return nodeservicesinternal.SystemTelemetryEnvelope{}, fmt.Errorf("system telemetry snapshot: %w", err)
	}
	if response.StatusCode() == http.StatusOK && response.JSON200 != nil {
		return *response.JSON200, nil
	}
	return nodeservicesinternal.SystemTelemetryEnvelope{}, systemTelemetryGatewayError(response.StatusCode(), response.Body)
}

// StreamLocalComputerSystemTelemetry opens a live SSE stream from Agent Service
// for the owner's connected Computer. On success (HTTP 200), the caller owns
// closing the returned response body.
func (g *HTTPGateway) StreamLocalComputerSystemTelemetry(ctx context.Context, target SystemTelemetryTarget) (*http.Response, error) {
	if !validSystemTelemetryTarget(target) {
		return nil, ErrLocalComputerNotFound
	}
	response, err := g.telemetryStreamClient.StreamLocalComputerSystemTelemetry(
		ctx, target.TenantID, target.OwnerActorID, target.ComputerID,
	)
	if err != nil {
		return nil, fmt.Errorf("system telemetry stream: %w", err)
	}
	if response.StatusCode == http.StatusOK {
		return response, nil
	}
	body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	_ = response.Body.Close()
	return nil, systemTelemetryGatewayError(response.StatusCode, body)
}

func systemTelemetryGatewayError(status int, body []byte) error {
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &envelope)
	switch status {
	case http.StatusNotFound:
		return ErrLocalComputerNotFound
	case http.StatusConflict:
		return ErrSystemTelemetryUnsupported
	case http.StatusGatewayTimeout:
		return ErrSystemTelemetryTimeout
	case http.StatusServiceUnavailable:
		if envelope.Error.Code == "LOCAL_COMPUTER_OFFLINE" {
			return ErrLocalComputerOffline
		}
		return ErrSystemTelemetryUnavailable
	default:
		return fmt.Errorf("AgentManagement returned status %d for system telemetry", status)
	}
}
