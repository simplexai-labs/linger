package daemon

import (
	"context"
	"log/slog"
	"net"
	"net/url"
	"time"

	"golang.org/x/net/http/httpproxy"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

// modelNetworkProbeTimeout bounds each connection the reachability check
// opens after a failed model call.
const modelNetworkProbeTimeout = 3 * time.Second

// modelNetworkUnavailableReason is the receipt reason of a model call this
// Computer could not complete because it cannot reach the network.
const modelNetworkUnavailableReason = "The Local Computer cannot reach the network its model needs"

// modelEndpointResolver is implemented by an invoker that can name the
// endpoints a model call on a Runtime connects to, read from that Runtime's
// own configuration.
type modelEndpointResolver interface {
	ModelEndpoints(ctx context.Context, runtimeType, model string) []*url.URL
}

// routeProbeAddresses are documentation addresses (RFC 5737 and RFC 3849).
// Connecting a UDP socket to one needs a route out of the machine and sends
// no packet.
var routeProbeAddresses = []string{"192.0.2.1:9", "[2001:db8::1]:9"}

// networkUnavailableModelInvoke reports a failed or timed-out model call as
// unavailable when this Computer cannot reach the network the call needed,
// so the caller waits for the Computer as it does for a disconnected one
// instead of spending attempts. Any other result is returned unchanged.
func (d *Daemon) networkUnavailableModelInvoke(ctx context.Context, invokeID, runtimeType, model string, result provider.ModelInvokeResult) provider.ModelInvokeResult {
	if ctx.Err() != nil ||
		(result.Outcome != provider.ModelInvokeFailed && result.Outcome != provider.ModelInvokeTimedOut) ||
		!d.modelNetworkUnavailable(ctx, runtimeType, model) {
		return result
	}
	slog.Warn("runner.model.invoke", "phase", "network_unavailable", "invoke_id", invokeID,
		"runtime_type", runtimeType, "outcome", result.Outcome)
	result.Outcome = provider.ModelInvokeUnavailable
	result.Reason = modelNetworkUnavailableReason
	return result
}

// modelNetworkUnavailable reports whether runtimeType's model is out of this
// Computer's reach. Local models never are. A Runtime on the BYOK gateway,
// whose endpoint the tool probes when it mounts, is when no route leaves the
// machine. Any other Runtime is when none of the endpoints its own
// configuration names (a custom provider's or gateway's base URL, else the
// vendor's hosts), nor the proxy the environment chooses for each, accepts a
// connection; a Runtime whose endpoints are unknown falls back to the route.
func (d *Daemon) modelNetworkUnavailable(ctx context.Context, runtimeType, model string) bool {
	mode := ""
	if d.modelSource != nil {
		mode = d.modelSource.GatewayMode(runtimeType)
	}
	switch mode {
	case "local":
		return false
	case "byok":
		return !d.routeAvailable(ctx)
	}
	var endpoints []*url.URL
	if resolver, ok := d.modelInvoker.(modelEndpointResolver); ok {
		endpoints = resolver.ModelEndpoints(ctx, runtimeType, model)
	}
	if len(endpoints) == 0 {
		return !d.routeAvailable(ctx)
	}
	for _, endpoint := range endpoints {
		if d.dial(ctx, "tcp", endpointAddress(endpoint)) == nil {
			return false
		}
	}
	return true
}

// routeAvailable reports whether a route leaves the machine over IPv4 or IPv6.
func (d *Daemon) routeAvailable(ctx context.Context) bool {
	for _, address := range routeProbeAddresses {
		if d.dial(ctx, "udp", address) == nil {
			return true
		}
	}
	return false
}

// endpointAddress is where a request to endpoint first connects: the proxy
// HTTPS_PROXY, HTTP_PROXY and NO_PROXY choose for it, or the endpoint's own
// host and port.
func endpointAddress(endpoint *url.URL) string {
	address := url.URL{Scheme: endpoint.Scheme, Host: endpoint.Host}
	if proxy, err := httpproxy.FromEnvironment().ProxyFunc()(&address); err == nil && proxy != nil && proxy.Hostname() != "" {
		address = *proxy
	}
	port := address.Port()
	if port == "" {
		switch address.Scheme {
		case "https":
			port = "443"
		case "socks5", "socks5h":
			port = "1080"
		default:
			port = "80"
		}
	}
	return net.JoinHostPort(address.Hostname(), port)
}

func (d *Daemon) dial(ctx context.Context, network, address string) error {
	if d.dialNetwork != nil {
		return d.dialNetwork(ctx, network, address)
	}
	dialer := net.Dialer{Timeout: modelNetworkProbeTimeout}
	conn, err := dialer.DialContext(ctx, network, address)
	if err != nil {
		return err
	}
	return conn.Close()
}
