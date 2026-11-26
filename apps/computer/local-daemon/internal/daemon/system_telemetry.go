package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/localmodels"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

// serviceFeatureSystemTelemetry in runner.welcome's service_features says the
// Agent Service accepts runner.system_telemetry frames and sends on-demand
// system telemetry subscribe/unsubscribe leases.
const serviceFeatureSystemTelemetry = "system_telemetry"

const systemTelemetryWriteTimeout = 5 * time.Second

// SystemTelemetryProvider runs on-demand live system telemetry collection for
// this Computer only while a lease is active.
type SystemTelemetryProvider interface {
	Subscribe(leaseTTL time.Duration, interval time.Duration)
	Unsubscribe()
}

// PublishSystemTelemetry emits one revision-stamped runner.system_telemetry
// frame on the live connection when its Agent Service declared
// serviceFeatureSystemTelemetry.
func (d *Daemon) PublishSystemTelemetry(update localmodels.TelemetryUpdate) {
	d.systemTelemetryMu.Lock()
	defer d.systemTelemetryMu.Unlock()
	d.connectionMu.Lock()
	stream := d.systemTelemetryStream
	epoch := d.systemTelemetryEpoch
	d.connectionMu.Unlock()
	if stream == nil || epoch == 0 {
		return
	}
	d.systemTelemetryRevision++
	sentAt := time.Now().UTC()
	frame := wire.RunnerSystemTelemetry{
		Type:            wire.TypeRunnerSystemTelemetry,
		ProtocolVersion: d.protocolVersion,
		RunnerID:        d.computerID,
		ConnectionEpoch: epoch,
		SentAt:          sentAt.Format(time.RFC3339Nano),
		Revision:        d.systemTelemetryRevision,
		Status:          update.Status,
		Snapshot:        update.Snapshot,
		Reason:          update.Reason,
	}
	payload, err := json.Marshal(frame)
	if err == nil {
		sendCtx, cancel := context.WithTimeout(context.Background(), systemTelemetryWriteTimeout)
		defer cancel()
		err = stream.Send(sendCtx, protocol.Event{
			Type:            protocol.EventSystemTelemetry,
			ProtocolVersion: d.protocolVersion,
			RunnerID:        d.computerID,
			ConnectionEpoch: epoch,
			Revision:        d.systemTelemetryRevision,
			SentAt:          sentAt,
			Payload:         payload,
		})
	}
	if err != nil {
		slog.Warn("system_telemetry.frame_not_sent", "revision", d.systemTelemetryRevision, "error", err)
	}
}

func (d *Daemon) handleSystemTelemetrySubscribe(stream transport.Stream, command protocol.Command) error {
	var request wire.CapabilitySystemTelemetrySubscribe
	if err := json.Unmarshal(command.Payload, &request); err != nil {
		return errors.New("invalid system telemetry subscribe command")
	}
	if request.RunnerID != d.computerID {
		slog.Warn("system_telemetry.subscribe_rejected", "reason", "runner_id")
		return nil
	}
	if !d.acceptsSystemTelemetry(stream) {
		slog.Warn("system_telemetry.subscribe_rejected", "reason", "service_features")
		return nil
	}
	if d.systemTelemetry == nil {
		d.PublishSystemTelemetry(localmodels.TelemetryUpdate{
			Status: localmodels.TelemetryStatusUnsupported,
			Reason: &wire.SystemTelemetryUnavailableReason{
				Code:   localmodels.CodeTelemetryToolNotInstalled,
				Detail: "system telemetry collector is not configured on this Computer",
			},
		})
		return nil
	}
	leaseTTL := time.Duration(request.LeaseTtlMs) * time.Millisecond
	var interval time.Duration
	if request.IntervalMs != nil {
		interval = time.Duration(*request.IntervalMs) * time.Millisecond
	}
	d.systemTelemetry.Subscribe(leaseTTL, interval)
	return nil
}

func (d *Daemon) handleSystemTelemetryUnsubscribe(stream transport.Stream, command protocol.Command) error {
	var request wire.CapabilitySystemTelemetryUnsubscribe
	if err := json.Unmarshal(command.Payload, &request); err != nil {
		return errors.New("invalid system telemetry unsubscribe command")
	}
	if request.RunnerID != d.computerID {
		return nil
	}
	if !d.acceptsSystemTelemetry(stream) {
		return nil
	}
	if d.systemTelemetry != nil {
		d.systemTelemetry.Unsubscribe()
	}
	return nil
}

func (d *Daemon) acceptsSystemTelemetry(stream transport.Stream) bool {
	d.connectionMu.Lock()
	defer d.connectionMu.Unlock()
	return d.systemTelemetryStream != nil && d.systemTelemetryStream == stream
}
