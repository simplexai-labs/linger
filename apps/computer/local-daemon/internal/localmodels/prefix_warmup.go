package localmodels

import (
	"context"
	"log/slog"

	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

// PrefixWarmupTarget identifies a loaded local model eligible for post-load
// static system-prompt prefix warm-up and KV pinning.
type PrefixWarmupTarget struct {
	ModelID         string
	PiModel         string
	Engine          string
	EngineLabel     string
	Pool            string
	ContextTokens   uint64
	EndpointBaseURL string
}

type prefixWarmupFingerprint struct {
	ModelID         string
	PiModel         string
	Engine          string
	EngineLabel     string
	Pool            string
	ContextTokens   uint64
	EndpointBaseURL string
	ToolVersion     string
}

type activePrefixWarmup struct {
	fp     prefixWarmupFingerprint
	cancel context.CancelFunc
}

func isPolyStrataEngine(engine string) bool {
	return engine == "polystrata" || engine == "strata"
}

func prefixWarmupFingerprintFor(toolVersion string, target PrefixWarmupTarget) prefixWarmupFingerprint {
	return prefixWarmupFingerprint{
		ModelID:         target.ModelID,
		PiModel:         target.PiModel,
		Engine:          target.Engine,
		EngineLabel:     target.EngineLabel,
		Pool:            target.Pool,
		ContextTokens:   target.ContextTokens,
		EndpointBaseURL: target.EndpointBaseURL,
		ToolVersion:     toolVersion,
	}
}

// reconcilePrefixWarmups schedules one-shot background prefix warm-ups for
// loaded PolyStrata models without delaying availability or changing model.State.
func (l *Library) reconcilePrefixWarmups(snapshot *wire.LocalModelsSnapshot) {
	if l.warmupPrefix == nil || !snapshot.Available {
		return
	}
	type pendingWarmup struct {
		target PrefixWarmupTarget
		fp     prefixWarmupFingerprint
	}
	desired := make(map[string]pendingWarmup)
	for i := range snapshot.Models {
		model := &snapshot.Models[i]
		if model.State != "loaded" || !isPolyStrataEngine(model.Engine) || model.PiModel == "" {
			continue
		}
		endpointURL := ""
		if model.Endpoint != nil {
			endpointURL = model.Endpoint.BaseURL
		}
		target := PrefixWarmupTarget{
			ModelID:         model.ID,
			PiModel:         model.PiModel,
			Engine:          model.Engine,
			EngineLabel:     model.EngineLabel,
			Pool:            model.Pool,
			ContextTokens:   model.ContextTokens,
			EndpointBaseURL: endpointURL,
		}
		desired[model.ID] = pendingWarmup{
			target: target,
			fp:     prefixWarmupFingerprintFor(snapshot.ToolVersion, target),
		}
	}

	l.mu.Lock()
	for id, fp := range l.prefixWarmed {
		if want, ok := desired[id]; !ok || want.fp != fp {
			delete(l.prefixWarmed, id)
		}
	}
	for id, active := range l.prefixWarmups {
		if want, ok := desired[id]; !ok || active.fp != want.fp {
			active.cancel()
			delete(l.prefixWarmups, id)
		}
	}
	if l.closed || l.ctx.Err() != nil {
		l.mu.Unlock()
		return
	}
	for _, pending := range desired {
		id := pending.target.ModelID
		if warmedFP, ok := l.prefixWarmed[id]; ok && warmedFP == pending.fp {
			continue
		}
		if _, running := l.prefixWarmups[id]; running {
			continue
		}
		l.wg.Add(1)
		warmupCtx, warmupCancel := context.WithCancel(l.ctx)
		active := &activePrefixWarmup{fp: pending.fp, cancel: warmupCancel}
		l.prefixWarmups[id] = active
		go l.runPrefixWarmup(warmupCtx, active, pending.target, pending.fp)
	}
	l.mu.Unlock()
}

func (l *Library) runPrefixWarmup(
	ctx context.Context,
	active *activePrefixWarmup,
	target PrefixWarmupTarget,
	fp prefixWarmupFingerprint,
) {
	defer l.wg.Done()
	defer active.cancel()

	done, err := l.warmupPrefix(ctx, target)

	l.mu.Lock()
	current := l.prefixWarmups[target.ModelID]
	if current == active {
		delete(l.prefixWarmups, target.ModelID)
		if ctx.Err() == nil && !l.closed && (done || err != nil) {
			l.prefixWarmed[target.ModelID] = fp
		}
	}
	l.mu.Unlock()

	if ctx.Err() != nil {
		return
	}
	if err != nil {
		slog.Warn("local_models.prefix_warmup_failed", "model", target.ModelID, "pi_model", target.PiModel, "error", err)
		return
	}
	if done {
		slog.Info("local_models.prefix_warmed", "model", target.ModelID, "pi_model", target.PiModel)
	}
}

func (l *Library) cancelPrefixWarmup(modelID string) {
	if modelID == "" {
		return
	}
	l.mu.Lock()
	l.cancelPrefixWarmupLocked(modelID)
	l.mu.Unlock()
}

func (l *Library) cancelPrefixWarmupLocked(modelID string) {
	if modelID == "" {
		return
	}
	delete(l.prefixWarmed, modelID)
	if active, ok := l.prefixWarmups[modelID]; ok {
		active.cancel()
		delete(l.prefixWarmups, modelID)
	}
}

func (l *Library) cancelAllPrefixWarmups() {
	l.mu.Lock()
	l.cancelAllPrefixWarmupsLocked()
	l.mu.Unlock()
}

func (l *Library) cancelAllPrefixWarmupsLocked() {
	for id, active := range l.prefixWarmups {
		active.cancel()
		delete(l.prefixWarmups, id)
	}
	clear(l.prefixWarmed)
}
