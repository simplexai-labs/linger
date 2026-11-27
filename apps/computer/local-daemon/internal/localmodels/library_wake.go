package localmodels

import (
	"context"
	"log/slog"
	"slices"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/awaketime"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

func (l *Library) awakeNow() time.Duration {
	if l.awakeClock != nil {
		return l.awakeClock()
	}
	return awaketime.Now()
}

func (l *Library) withAwakeTimeout(ctx context.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
	return awaketime.WithTimeoutClockCause(ctx, timeout, nil, l.awakeClock)
}

func (l *Library) markUserStopped(modelID string, stopped bool) {
	if modelID == "" {
		return
	}
	l.mu.Lock()
	if stopped {
		l.userStopped[modelID] = true
	} else {
		delete(l.userStopped, modelID)
	}
	l.mu.Unlock()
}

func (l *Library) isUserStopped(modelID string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.userStopped[modelID]
}

// RecoverAfterWake checks the health of previously loaded local models and the
// local Bifrost gateway after system wake, refreshing any active download or
// load jobs and reloading only models that were loaded before sleep and became
// unhealthy. It never loads models that were idle, absent, or explicitly
// stopped by the user. Callers serialize concurrent wakes (see Daemon.HandlePowerResume).
//
// When previously loaded models or the local gateway are confirmed unhealthy
// after refreshing library status, onUnhealthy is invoked before reloading so
// the Daemon can settle in-flight local-model Runs cleanly.
func (l *Library) RecoverAfterWake(ctx context.Context, onUnhealthy func(modelIDs, piModels []string, gatewayUnhealthy bool)) {
	if l.tool == nil || !l.tool.installed() {
		return
	}
	l.mu.Lock()
	closed := l.closed
	l.mu.Unlock()
	if closed || ctx.Err() != nil || l.ctx.Err() != nil {
		return
	}
	if !l.settled() {
		if err := l.awaitSettled(ctx); err != nil {
			return
		}
	}

	l.mu.Lock()
	hasCurrent := l.current != nil && l.current.Available
	var previouslyLoaded []wire.LocalModel
	hasActiveJobs := len(l.jobs) > 0
	if hasCurrent {
		for _, model := range l.current.Models {
			switch model.State {
			case "loaded":
				if !l.userStopped[model.ID] {
					previouslyLoaded = append(previouslyLoaded, model)
				}
			case "downloading", "loading":
				hasActiveJobs = true
			}
		}
	}
	l.mu.Unlock()

	if !hasCurrent {
		// No baseline snapshot yet: refresh so the library state is current
		// without guessing which models should be loaded.
		l.Refresh(ctx)
		return
	}

	gatewayHealthy := l.localGatewayHealthy(ctx)
	if len(previouslyLoaded) == 0 {
		if hasActiveJobs || !gatewayHealthy {
			l.Refresh(ctx)
		}
		slog.Info("local_models.wake_check", "outcome", "idle", "active_jobs", hasActiveJobs, "gateway_healthy", gatewayHealthy)
		return
	}

	var unhealthyEngines []string
	for _, row := range previouslyLoaded {
		if row.Endpoint != nil && row.Endpoint.BaseURL != "" {
			if healthURL := loopbackHealthURL(row.Endpoint.BaseURL, true); healthURL != "" && !l.healthCheck(ctx, healthURL) {
				unhealthyEngines = append(unhealthyEngines, row.ID)
			}
		}
	}
	if ctx.Err() != nil || l.ctx.Err() != nil {
		return
	}

	if len(unhealthyEngines) == 0 && gatewayHealthy {
		if hasActiveJobs {
			l.Refresh(ctx)
		}
		slog.Info("local_models.wake_check", "outcome", "healthy", "loaded_models", len(previouslyLoaded), "active_jobs", hasActiveJobs)
		return
	}

	slog.Warn("local_models.wake_check", "outcome", "unhealthy",
		"unhealthy_engines", unhealthyEngines, "gateway_unhealthy", !gatewayHealthy)
	snapshot := l.Refresh(ctx)
	if ctx.Err() != nil || l.ctx.Err() != nil || !snapshot.Available {
		return
	}

	gatewayHealthy = l.localGatewayHealthy(ctx)
	type recoveryTarget struct {
		row   wire.LocalModel
		state string
	}
	var targets []recoveryTarget
	var targetIDs []string
	var targetPiModels []string
	for _, prev := range previouslyLoaded {
		if l.isUserStopped(prev.ID) {
			continue
		}
		index := slices.IndexFunc(snapshot.Models, func(model wire.LocalModel) bool { return model.ID == prev.ID })
		if index < 0 {
			continue
		}
		row := snapshot.Models[index]
		state := loadState(row)
		switch state {
		case "loaded":
			if gatewayHealthy {
				// Engine answered library status and gateway is healthy.
				continue
			}
			// Engine answered status, but the local gateway is down; reset and reload.
			targets = append(targets, recoveryTarget{row: row, state: "failed"})
		case "failed", "idle":
			targets = append(targets, recoveryTarget{row: row, state: state})
		default:
			// absent, downloading, loading, download_stopped: do not interfere.
			continue
		}
		targetIDs = append(targetIDs, row.ID)
		if row.PiModel != "" {
			targetPiModels = append(targetPiModels, row.PiModel)
		} else if prev.PiModel != "" {
			targetPiModels = append(targetPiModels, prev.PiModel)
		}
	}

	if len(targets) == 0 {
		slog.Info("local_models.wake_check", "outcome", "healthy_after_refresh", "loaded_models", len(previouslyLoaded))
		return
	}

	if onUnhealthy != nil {
		onUnhealthy(targetIDs, targetPiModels, !gatewayHealthy)
	}

	var recovered, failed []string
	for _, target := range targets {
		if ctx.Err() != nil || l.ctx.Err() != nil {
			break
		}
		if l.isUserStopped(target.row.ID) {
			continue
		}
		err := l.ensureByID(ctx, target.row.ID, target.state, l.now())
		if err != nil {
			failed = append(failed, target.row.ID)
			slog.Warn("local_models.wake_recovery_failed", "model", target.row.ID, "error", err)
			continue
		}
		recovered = append(recovered, target.row.ID)
	}
	slog.Info("local_models.wake_recovery", "recovered", recovered, "failed", failed)
}
