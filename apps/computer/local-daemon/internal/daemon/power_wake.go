package daemon

import (
	"context"
	"log/slog"
	"slices"
	"time"
)

const (
	// wakeGatewayProbeTimeout bounds the immediate WebSocket Ping/Pong check
	// after system wake so a connection dropped during sleep redials quickly.
	wakeGatewayProbeTimeout = 5 * time.Second

	sleepInterruptedLocalModelReason = "Local model run was interrupted by system sleep"
	sleepInterruptedGatewayReason    = "Model gateway run was interrupted by system sleep"
)

// wakeProber is implemented by transport streams that can run an immediate
// Ping/Pong liveness check after system wake.
type wakeProber interface {
	ProbeLiveness(timeout time.Duration) error
}

// localModelWakeRecoverer is implemented by localmodels.Library to check and
// recover previously loaded local models and the local Bifrost gateway on wake.
type localModelWakeRecoverer interface {
	RecoverAfterWake(ctx context.Context, onUnhealthy func(modelIDs, piModels []string, gatewayUnhealthy bool))
}

// modelSourceWakeRecoverer is implemented by localmodels.ModelSource to check
// and remount a saved BYOK Bifrost gateway on wake.
type modelSourceWakeRecoverer interface {
	RecoverGatewayAfterWake(ctx context.Context, onUnhealthy func(runtimeType string)) error
}

// HandlePowerResume probes the live Runner Gateway connection and runs a
// deduplicated post-wake health check on the local model stack and BYOK
// gateway. Unhealthy components are recovered automatically without loading
// models the user stopped, and pre-wake in-flight local-model or gateway Runs
// backed by an unhealthy component are interrupted cleanly instead of hanging.
func (d *Daemon) HandlePowerResume(ctx context.Context, sleepDuration time.Duration) {
	if ctx.Err() != nil {
		return
	}
	d.admissionMu.Lock()
	closing := d.closing
	d.admissionMu.Unlock()
	if closing {
		return
	}
	d.wakeMu.Lock()
	if d.wakeRunning {
		d.wakePending = true
		d.wakeSleep = sleepDuration
		d.wakeMu.Unlock()
		return
	}
	d.wakeRunning = true
	d.wakePending = false
	d.wakeMu.Unlock()

	currentSleep := sleepDuration
	for {
		d.handlePowerResumeOnce(ctx, currentSleep)
		d.wakeMu.Lock()
		d.admissionMu.Lock()
		closing = d.closing
		d.admissionMu.Unlock()
		pending := d.wakePending && !closing && ctx.Err() == nil
		currentSleep = d.wakeSleep
		d.wakePending = false
		if !pending {
			d.wakeRunning = false
			d.wakeMu.Unlock()
			return
		}
		d.wakeMu.Unlock()
	}
}

func (d *Daemon) handlePowerResumeOnce(ctx context.Context, sleepDuration time.Duration) {
	wakeAt := d.now()
	slog.Info("daemon.power_resume", "sleep_ms", sleepDuration.Milliseconds())

	// Probe the live Gateway stream first so a half-open remote connection
	// dropped during sleep fails fast and reconnects.
	d.connectionMu.Lock()
	stream := d.operationStream
	d.connectionMu.Unlock()
	if prober, ok := stream.(wakeProber); ok {
		if err := prober.ProbeLiveness(wakeGatewayProbeTimeout); err != nil {
			slog.Warn("runner.gateway.wake_probe_failed", "error", err)
		}
	}

	if ctx.Err() != nil {
		return
	}
	if recoverer, ok := d.localModels.(localModelWakeRecoverer); ok {
		recoverer.RecoverAfterWake(ctx, func(_ []string, piModels []string, gatewayUnhealthy bool) {
			d.interruptOperationsForWake(wakeAt, "local", piModels, gatewayUnhealthy)
		})
	}

	if ctx.Err() != nil {
		return
	}
	if recoverer, ok := d.modelSource.(modelSourceWakeRecoverer); ok {
		if err := recoverer.RecoverGatewayAfterWake(ctx, func(runtimeType string) {
			d.interruptOperationsForWake(wakeAt, "byok", []string{runtimeType}, true)
		}); err != nil && ctx.Err() == nil {
			slog.Warn("model_source.wake_recovery_failed", "error", err)
		}
	}
}

// interruptOperationsForWake cancels pre-wake active Operations and background
// model invocations whose backing local model or gateway became unhealthy
// during sleep, so they settle cleanly instead of hanging indefinitely.
func (d *Daemon) interruptOperationsForWake(wakeAt time.Time, mode string, targets []string, gatewayUnhealthy bool) {
	reason := sleepInterruptedLocalModelReason
	if mode == "byok" {
		reason = sleepInterruptedGatewayReason
	}
	localGatewayForPi := mode == "local" && d.modelSource != nil && d.modelSource.GatewayMode("pi") == "local"
	matches := func(runtimeType, model string) bool {
		if mode == "byok" {
			return slices.Contains(targets, runtimeType)
		}
		if runtimeType != "pi" {
			return false
		}
		if gatewayUnhealthy && (model == "" || localGatewayForPi || slices.Contains(targets, model)) {
			return true
		}
		if model != "" && slices.Contains(targets, model) {
			return true
		}
		return model == "" && localGatewayForPi
	}

	d.activeMu.Lock()
	for _, active := range d.activeOperations {
		if active.terminalCommitted || active.reason != "" || !active.running || !active.startedAt.Before(wakeAt) {
			continue
		}
		if !matches(active.identity.RuntimeType, active.model) {
			continue
		}
		active.reason = reason
		slog.Warn("runner.operation.sleep_interrupted",
			"operation_id", active.identity.OperationID,
			"runtime_type", active.identity.RuntimeType,
			"mode", mode)
		active.cancel()
	}
	d.activeMu.Unlock()

	d.modelInvokeMu.Lock()
	for _, entry := range d.modelInvokes {
		if !entry.startedAt.Before(wakeAt) {
			continue
		}
		if !matches(entry.runtimeType, entry.model) {
			continue
		}
		slog.Warn("runner.model.invoke", "phase", "cancel_requested",
			"invoke_id", entry.id, "cancellation_source", "power_resume")
		entry.cancel()
	}
	d.modelInvokeMu.Unlock()
}
