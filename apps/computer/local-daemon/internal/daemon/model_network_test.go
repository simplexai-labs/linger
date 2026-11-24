package daemon

import (
	"context"
	"errors"
	"net/url"
	"slices"
	"sync"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

// fixedModelInvoker answers every call with one result.
type fixedModelInvoker struct{ result provider.ModelInvokeResult }

func (f fixedModelInvoker) Invoke(context.Context, provider.ModelInvokeRequest) provider.ModelInvokeResult {
	return f.result
}

func (fixedModelInvoker) Close() {}

// recordedDials answers each reachability connection as reachable or not and
// keeps the addresses it was asked for.
type recordedDials struct {
	mu        sync.Mutex
	addresses []string
	reachable func(network, address string) bool
}

func (r *recordedDials) dial(_ context.Context, network, address string) error {
	r.mu.Lock()
	r.addresses = append(r.addresses, network+" "+address)
	r.mu.Unlock()
	if r.reachable(network, address) {
		return nil
	}
	return errors.New("connect: network is unreachable")
}

func (r *recordedDials) snapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.addresses)
}

func clearProxyEnvironment(t *testing.T) {
	t.Helper()
	for _, name := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "REQUEST_METHOD"} {
		t.Setenv(name, "")
	}
}

// A failed or timed-out model call made while the Computer cannot reach the
// network is reported unavailable; a call that failed for another reason, or
// with the network up, keeps its own outcome and reason.
func TestModelInvokeReportsAFailureWithoutNetworkAsUnavailable(t *testing.T) {
	clearProxyEnvironment(t)
	for _, tc := range []struct {
		name, outcome   string
		online          bool
		wantOutcome     string
		wantReason      string
		wantNetworkDial bool
	}{
		{"failed offline", provider.ModelInvokeFailed, false, "unavailable", modelNetworkUnavailableReason, true},
		{"timed out offline", provider.ModelInvokeTimedOut, false, "unavailable", modelNetworkUnavailableReason, true},
		{"failed online", provider.ModelInvokeFailed, true, "failed", "Runtime exited", true},
		{"sign-in offline", provider.ModelInvokeAuthRequired, false, "auth_required", "Runtime exited", false},
		{"incompatible offline", provider.ModelInvokeRuntimeIncompatible, false, "runtime_incompatible", "Runtime exited", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d, stream := modelInvokeFixture(t, fixedModelInvoker{result: provider.ModelInvokeResult{
				Outcome: tc.outcome, Reason: "Runtime exited",
			}})
			dials := &recordedDials{reachable: func(string, string) bool { return tc.online }}
			d.dialNetwork = dials.dial
			if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand("invoke-1", nil)); err != nil {
				t.Fatal(err)
			}
			payload := waitForModelInvoked(t, stream, "invoke-1")
			if payload["outcome"] != tc.wantOutcome || payload["reason"] != tc.wantReason {
				t.Fatalf("payload = %v", payload)
			}
			if got := len(dials.snapshot()) > 0; got != tc.wantNetworkDial {
				t.Fatalf("dials = %v, want a check %v", dials.snapshot(), tc.wantNetworkDial)
			}
		})
	}
}

// A completed call never checks the network.
func TestModelInvokeChecksNoNetworkForACompletedCall(t *testing.T) {
	d, stream := modelInvokeFixture(t, fixedModelInvoker{result: provider.ModelInvokeResult{
		Outcome: provider.ModelInvokeCompleted, Text: `{"answer":"ok"}`,
	}})
	dials := &recordedDials{reachable: func(string, string) bool { return false }}
	d.dialNetwork = dials.dial
	if err := d.handleModelInvoke(context.Background(), stream, modelInvokeCommand("invoke-1", nil)); err != nil {
		t.Fatal(err)
	}
	if payload := waitForModelInvoked(t, stream, "invoke-1"); payload["outcome"] != "completed" {
		t.Fatalf("payload = %v", payload)
	}
	if got := dials.snapshot(); len(got) != 0 {
		t.Fatalf("dials = %v, want none", got)
	}
}

// endpointModelInvoker names fixed endpoints for every Runtime.
type endpointModelInvoker struct {
	fixedModelInvoker
	endpoints []string
}

// The Daemon's real invoker names its Runtimes' endpoints; without that the
// check would silently fall back to the route.
var _ modelEndpointResolver = provider.ModelInvoker{}

func (e endpointModelInvoker) ModelEndpoints(context.Context, string, string) []*url.URL {
	var parsed []*url.URL
	for _, endpoint := range e.endpoints {
		value, _ := url.Parse(endpoint)
		parsed = append(parsed, value)
	}
	return parsed
}

// The check connects only to what the call's model needs: the endpoints the
// Runtime's own configuration names, and the call is unavailable only when
// none of them answers; a route out of the machine for a BYOK gateway or a
// Runtime whose endpoints are unknown; nothing for local models.
func TestModelNetworkCheckFollowsWhatTheRuntimeReaches(t *testing.T) {
	clearProxyEnvironment(t)
	down := func(string, string) bool { return false }
	for _, tc := range []struct {
		name, mode      string
		endpoints       []string
		reachable       func(network, address string) bool
		wantUnavailable bool
		wantDials       []string
	}{
		{
			name: "custom provider down", endpoints: []string{"https://api.deepseek.com/v1"},
			reachable: down, wantUnavailable: true, wantDials: []string{"tcp api.deepseek.com:443"},
		},
		{
			name: "custom provider up while the vendor is unreachable", endpoints: []string{"https://open.bigmodel.cn/api"},
			reachable: func(_ string, address string) bool { return address == "open.bigmodel.cn:443" },
			wantDials: []string{"tcp open.bigmodel.cn:443"},
		},
		{
			name: "one built-in host still answers", endpoints: []string{"https://chatgpt.com", "https://api.openai.com"},
			reachable: func(_ string, address string) bool { return address == "api.openai.com:443" },
			wantDials: []string{"tcp chatgpt.com:443", "tcp api.openai.com:443"},
		},
		{
			name: "no built-in host answers", endpoints: []string{"https://chatgpt.com", "https://api.openai.com"},
			reachable: down, wantUnavailable: true, wantDials: []string{"tcp chatgpt.com:443", "tcp api.openai.com:443"},
		},
		{
			name: "local gateway on its own port", endpoints: []string{"http://127.0.0.1:11434/v1"},
			reachable: func(string, string) bool { return true }, wantDials: []string{"tcp 127.0.0.1:11434"},
		},
		{
			name:      "unknown endpoints with an IPv6 route",
			reachable: func(_ string, address string) bool { return address == "[2001:db8::1]:9" },
			wantDials: []string{"udp 192.0.2.1:9", "udp [2001:db8::1]:9"},
		},
		{
			name: "BYOK gateway without a route", mode: "byok", endpoints: []string{"http://127.0.0.1:43120"},
			reachable: down, wantUnavailable: true, wantDials: []string{"udp 192.0.2.1:9", "udp [2001:db8::1]:9"},
		},
		{
			name: "local models", mode: "local", endpoints: []string{"https://api.openai.com"},
			reachable: down,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dials := &recordedDials{reachable: tc.reachable}
			d := &Daemon{
				modelSource:  &fakeModelSourceManager{gatewayMode: tc.mode},
				modelInvoker: endpointModelInvoker{endpoints: tc.endpoints},
				dialNetwork:  dials.dial,
			}
			if got := d.modelNetworkUnavailable(context.Background(), "codex", ""); got != tc.wantUnavailable {
				t.Fatalf("unavailable = %v, want %v", got, tc.wantUnavailable)
			}
			if got := dials.snapshot(); !slices.Equal(got, tc.wantDials) {
				t.Fatalf("dials = %v, want %v", got, tc.wantDials)
			}
		})
	}
}

// The check connects where a request to the endpoint would first connect: the
// proxy the environment names for it, unless NO_PROXY exempts it.
func TestModelNetworkCheckConnectsThroughTheConfiguredProxy(t *testing.T) {
	for _, tc := range []struct {
		name, endpoint, variable, proxy, noProxy, want string
	}{
		{"https proxy with port", "https://api.openai.com", "HTTPS_PROXY", "http://proxy.internal:8080", "", "proxy.internal:8080"},
		{"https proxy without port", "https://api.openai.com", "HTTPS_PROXY", "https://proxy.internal", "", "proxy.internal:443"},
		{"exempt host", "https://api.openai.com", "HTTPS_PROXY", "http://proxy.internal:8080", ".openai.com", "api.openai.com:443"},
		{"http endpoint through HTTP_PROXY", "http://models.lan:8000", "HTTP_PROXY", "http://proxy.internal:3128", "", "proxy.internal:3128"},
		{"endpoint port without a proxy", "https://gw.example:8443", "HTTPS_PROXY", "", "", "gw.example:8443"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			clearProxyEnvironment(t)
			t.Setenv(tc.variable, tc.proxy)
			t.Setenv("NO_PROXY", tc.noProxy)
			endpoint, err := url.Parse(tc.endpoint)
			if err != nil {
				t.Fatal(err)
			}
			if got := endpointAddress(endpoint); got != tc.want {
				t.Fatalf("address = %q, want %q", got, tc.want)
			}
		})
	}
}
