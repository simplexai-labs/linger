package localmodels

import (
	"context"
	"net"
	"net/url"
	"strings"

	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

// parseLoopbackHTTPURL accepts only direct HTTP loopback URLs so probes never
// leave the Computer or resolve through proxies.
func parseLoopbackHTTPURL(raw string, requirePort bool) (*url.URL, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, false
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme != "http" || parsed.Host == "" || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, false
	}
	if requirePort && parsed.Port() == "" {
		return nil, false
	}
	host := parsed.Hostname()
	if !strings.EqualFold(host, "localhost") {
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			return nil, false
		}
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawPath = ""
	return parsed, true
}

// loopbackHealthURL parses rawURL as a loopback HTTP endpoint with an explicit
// port and returns its /health URL, or an empty string when rawURL is empty,
// invalid, or not on loopback. When stripV1 is true, a trailing /v1 segment is
// removed first, matching localmodels' own engine health check.
func loopbackHealthURL(rawURL string, stripV1 bool) string {
	parsed, ok := parseLoopbackHTTPURL(rawURL, true)
	if !ok {
		return ""
	}
	path := parsed.Path
	if stripV1 {
		path = strings.TrimSuffix(path, "/v1")
	}
	return parsed.Scheme + "://" + parsed.Host + path + "/health"
}

// localGatewayHealthURL returns the saved local Bifrost gateway's loopback
// /health URL when stateDir's model-source.json is in local mode, else "".
func localGatewayHealthURL(stateDir string) string {
	if stateDir == "" {
		return ""
	}
	overlay := ReadOverlay(stateDir)
	if overlay == nil || overlay.Mode != "local" {
		return ""
	}
	return loopbackHealthURL(overlay.GatewayURL, false)
}

// localGatewayHealthy reports whether the saved local Bifrost gateway answers
// /health on loopback. Returns true when no local loopback gateway is saved.
func (l *Library) localGatewayHealthy(ctx context.Context) bool {
	if l.tool == nil {
		return true
	}
	healthURL := localGatewayHealthURL(l.tool.StateDirectory)
	if healthURL == "" {
		return true
	}
	return l.healthCheck(ctx, healthURL)
}

// cachedLoadedHealthy probes a cached loaded model's loopback engine endpoint
// and, when model-source.json names a local loopback gateway, that gateway as
// well. Used only on the cached fast path to decide whether to run library
// status; the tool's own status decides whether the engine itself failed.
func (l *Library) cachedLoadedHealthy(ctx context.Context, row wire.LocalModel) bool {
	if row.Endpoint != nil && row.Endpoint.BaseURL != "" {
		if healthURL := loopbackHealthURL(row.Endpoint.BaseURL, true); healthURL != "" && !l.healthCheck(ctx, healthURL) {
			return false
		}
	}
	return l.localGatewayHealthy(ctx)
}

// needsUnloadBeforeLoad reports whether modelID holds a stale loaded record
// that must be reset to idle before loading: a server that library status
// reported as HEALTH_CHECK_FAILED, or a loaded server whose local Bifrost
// gateway stopped answering.
func (l *Library) needsUnloadBeforeLoad(ctx context.Context, modelID string) bool {
	l.mu.Lock()
	row := l.rowLocked(func(model wire.LocalModel) bool { return model.ID == modelID })
	l.mu.Unlock()
	if row == nil {
		return false
	}
	if row.State == "failed" && row.Error != nil && row.Error.Code == "HEALTH_CHECK_FAILED" {
		return true
	}
	return row.State == "loaded" && !l.localGatewayHealthy(ctx)
}
