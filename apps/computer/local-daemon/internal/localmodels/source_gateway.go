package localmodels

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"
)

// gatewayHealthTimeout bounds the loopback health check that runs before a
// Runtime on the BYOK gateway starts; a gateway that is up answers at once.
const gatewayHealthTimeout = 2 * time.Second

// GatewayMode names the managed gateway runtimeType reaches its model through,
// "local" or "byok", read from the saved source; it is empty when runtimeType
// reaches its own provider.
func (m *ModelSource) GatewayMode(runtimeType string) string {
	if m.tool == nil || !m.tool.installed() {
		return ""
	}
	overlay := ReadOverlay(m.tool.StateDirectory)
	if overlay == nil || (overlay.Mode != "local" && overlay.Mode != "byok") ||
		!GatewayRuntime(overlay.Environment, m.tool.StateDirectory, runtimeType) {
		return ""
	}
	return overlay.Mode
}

// EnsureGateway brings back the Bifrost gateway of the saved BYOK source
// before runtimeType runs on it. A source applied while its endpoint was
// down, or a gateway a quit stopped, otherwise leaves every Run refused at
// the gateway's port until the source is applied again. A gateway that
// answers costs one loopback request; one that does not is mounted again
// from the configuration localmodels saved, which probes the endpoint
// first. It returns nil when runtimeType does not run on a BYOK gateway.
func (m *ModelSource) EnsureGateway(ctx context.Context, runtimeType string) error {
	if m.tool == nil || !m.tool.installed() {
		return nil
	}
	if _, healthURL := byokGateway(m.tool.StateDirectory, runtimeType); healthURL == "" || gatewayAnswers(ctx, healthURL) {
		return nil
	}
	waitedFrom := time.Now()
	if m.waiting != nil {
		m.waiting()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	// Another Run or an Apply may have mounted the gateway, or switched the
	// source away from BYOK, while this one waited.
	runtime, healthURL := byokGateway(m.tool.StateDirectory, runtimeType)
	if healthURL == "" || gatewayAnswers(ctx, healthURL) {
		return nil
	}
	// A remount that finished while this Run waited failed just now; running
	// it again would probe the endpoint once more for each waiting Run.
	if m.remountedAt.After(waitedFrom) {
		return m.remountErr
	}
	slog.Info("model_source.gateway_remount", "phase", "started", "runtime_type", runtimeType)
	err := m.remount(ctx, runtime)
	if ctx.Err() == nil {
		m.remountedAt, m.remountErr = time.Now(), err
	}
	if err == nil {
		slog.Info("model_source.gateway_remount", "phase", "succeeded", "runtime_type", runtimeType)
	} else if sourceErr := (*ModelSourceError)(nil); errors.As(err, &sourceErr) {
		slog.Warn("model_source.gateway_remount", "phase", "failed", "runtime_type", runtimeType, "code", sourceErr.Code)
	}
	return err
}

// remount mounts the saved BYOK source on Bifrost again. The caller holds mu.
func (m *ModelSource) remount(ctx context.Context, runtime string) error {
	previousPaths := m.readExecutableRuntimePaths()
	runCtx, cancel := context.WithTimeout(ctx, m.applyTimeout)
	defer cancel()
	stdout, exitCode, err := m.runTool(runCtx, "source_remount", m.applyArgs("byok", runtime, "", false), nil)
	if err != nil {
		if ctx.Err() != nil {
			return errors.Join(ctx.Err(), err)
		}
		return &ModelSourceError{
			Code:      CodeToolFailed,
			Message:   "The BYOK gateway could not be started on this Computer.",
			Retryable: true,
		}
	}
	if exitCode != 0 {
		if unsupported := unsupportedSourceCommand(exitCode, stdout); unsupported != nil {
			return unsupported
		}
		return parseToolFailure(stdout, "BYOK_GATEWAY_FAILED", "The BYOK gateway could not be started on this Computer.", "")
	}
	// The tool rewrites model-source.json without the Runtime paths.
	m.persistRuntimePaths(stdout, previousPaths)
	return nil
}

// byokGateway returns the Runtime the saved BYOK source drives and its
// gateway's health URL when runtimeType reaches its model through that
// gateway, else an empty URL. Only a loopback gateway counts, so a tampered
// state file cannot point the check at another host.
func byokGateway(stateDir, runtimeType string) (runtime, healthURL string) {
	overlay := ReadOverlay(stateDir)
	if overlay == nil || overlay.Mode != "byok" || !GatewayRuntime(overlay.Environment, stateDir, runtimeType) {
		return "", ""
	}
	healthURL = loopbackHealthURL(overlay.GatewayURL, false)
	if healthURL == "" {
		return "", ""
	}
	return overlay.Runtime, healthURL
}

func gatewayAnswers(ctx context.Context, healthURL string) bool {
	requestCtx, cancel := context.WithTimeout(ctx, gatewayHealthTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, healthURL, nil)
	if err != nil {
		return false
	}
	client := http.Client{
		Transport:     &http.Transport{Proxy: nil, DisableKeepAlives: true},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	response, err := client.Do(request)
	if err != nil {
		return false
	}
	_ = response.Body.Close()
	return response.StatusCode == http.StatusOK
}
