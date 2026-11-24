package urlpreview

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

func allowAll(netip.Addr) bool { return true }

func noProxy(*http.Request) (*url.URL, error) { return nil, nil }

type names map[string][]netip.Addr

func (n names) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	return n[host], nil
}

func localProber() *Prober {
	return newProber(settings{proxy: noProxy, allowed: allowAll, names: names{}, anyPort: true})
}

func TestProbeReadsTheFinalResponseWithHEAD(t *testing.T) {
	var methods []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		methods = append(methods, r.Method+" "+r.URL.Path)
		if r.Header.Get("Cookie") != "" {
			t.Errorf("probe sent cookies")
		}
		switch r.URL.Path {
		case "/start":
			http.Redirect(w, r, "/login", http.StatusFound)
		case "/login":
			w.Header().Set("X-Frame-Options", "DENY")
			w.WriteHeader(http.StatusForbidden)
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer server.Close()
	prober := localProber()

	framing, err := prober.Probe(context.Background(), server.URL+"/start#section", "https")
	if err != nil || framing != Refused {
		t.Fatalf("framing = %v, %v", framing, err)
	}
	framing, err = prober.Probe(context.Background(), server.URL+"/open", "")
	if err != nil || framing != Allowed {
		t.Fatalf("framing = %v, %v", framing, err)
	}
	want := "HEAD /start,HEAD /login,HEAD /open"
	if got := strings.Join(methods, ","); got != want {
		t.Fatalf("requests = %s, want %s", got, want)
	}
}

func TestProbeFallsBackToGETWhenHEADIsRefused(t *testing.T) {
	var methods []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		methods = append(methods, r.Method)
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'")
	}))
	defer server.Close()
	framing, err := localProber().Probe(context.Background(), server.URL, "")
	if err != nil || framing != Refused || strings.Join(methods, ",") != "HEAD,GET" {
		t.Fatalf("framing = %v, %v, requests = %v", framing, err, methods)
	}
}

func TestProbeGivesUpAfterTooManyRedirects(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, r.URL.Path+"x", http.StatusFound)
	}))
	defer server.Close()
	framing, err := localProber().Probe(context.Background(), server.URL+"/", "")
	if err != nil || framing != Unknown {
		t.Fatalf("framing = %v, %v", framing, err)
	}
}

func TestProbeIgnoresOversizedHeaders(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Padding", strings.Repeat("a", 2*maxHeaderBytes))
		w.Header().Set("X-Frame-Options", "DENY")
	}))
	defer server.Close()
	framing, err := localProber().Probe(context.Background(), server.URL, "")
	if err != nil || framing != Unknown {
		t.Fatalf("framing = %v, %v", framing, err)
	}
}

func TestProbeNeverConnectsToANonPublicAddress(t *testing.T) {
	var requested atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requested.Store(true)
		w.Header().Set("X-Frame-Options", "DENY")
	}))
	defer server.Close()
	prober := newProber(settings{proxy: noProxy, allowed: publicAddress, names: names{}, anyPort: true})
	framing, err := prober.Probe(context.Background(), server.URL, "")
	if err != nil || framing != Unknown || requested.Load() {
		t.Fatalf("framing = %v, %v, requested = %v", framing, err, requested.Load())
	}
}

func TestProbeRequestsOnlyStandardPorts(t *testing.T) {
	var requested atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requested.Store(true)
	}))
	defer server.Close()
	prober := newProber(settings{proxy: noProxy, allowed: allowAll, names: names{}})
	framing, err := prober.Probe(context.Background(), server.URL, "")
	if err != nil || framing != Unknown || requested.Load() {
		t.Fatalf("framing = %v, %v, requested = %v", framing, err, requested.Load())
	}
	for page, want := range map[string]bool{
		"https://a.example/": true, "http://a.example:80/": true, "https://a.example:443/": true,
		"http://a.example:443/": false, "https://a.example:8443/": false, "http://a.example:22/": false,
	} {
		parsed, _ := url.Parse(page)
		if got := standardPort(parsed); got != want {
			t.Errorf("standardPort(%s) = %v, want %v", page, got, want)
		}
	}
}

func TestProbeAnswersUnknownWhenBusy(t *testing.T) {
	prober := localProber()
	for range maxConcurrentProbes {
		prober.slots <- struct{}{}
	}
	framing, err := prober.Probe(context.Background(), "https://a.example/", "")
	if err != nil || framing != Unknown {
		t.Fatalf("framing = %v, %v", framing, err)
	}
}

func TestProbeChecksNamesBeforeAProxyRequest(t *testing.T) {
	var proxied atomic.Bool
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		proxied.Store(true)
		w.Header().Set("X-Frame-Options", "DENY")
	}))
	defer proxy.Close()
	proxyURL, _ := url.Parse(proxy.URL)
	viaProxy := func(*http.Request) (*url.URL, error) { return proxyURL, nil }
	resolved := names{
		"intranet.example": {netip.MustParseAddr("10.1.2.3")},
		"public.example":   {netip.MustParseAddr("93.184.215.14")},
	}
	prober := newProber(settings{proxy: viaProxy, allowed: publicAddress, names: resolved})

	for _, page := range []string{"http://intranet.example/", "http://127.0.0.1/", "http://unresolved.example/"} {
		framing, err := prober.Probe(context.Background(), page, "")
		if err != nil || framing != Unknown || proxied.Load() {
			t.Fatalf("%s: framing = %v, %v, proxied = %v", page, framing, err, proxied.Load())
		}
	}
	framing, err := prober.Probe(context.Background(), "http://public.example/", "")
	if err != nil || framing != Refused || !proxied.Load() {
		t.Fatalf("public: framing = %v, %v, proxied = %v", framing, err, proxied.Load())
	}
}

func TestProbeRejectsInvalidURLs(t *testing.T) {
	prober := localProber()
	for _, page := range []string{"ftp://a.example/", "https://user:pass@a.example/", "https:///path", "not a url", "javascript:alert(1)"} {
		if _, err := prober.Probe(context.Background(), page, ""); !errors.Is(err, ErrInvalidURL) {
			t.Fatalf("%s: err = %v", page, err)
		}
	}
}

func TestPublicAddress(t *testing.T) {
	for _, address := range []string{"93.184.215.14", "2606:4700::1111"} {
		if !publicAddress(netip.MustParseAddr(address)) {
			t.Errorf("%s should be public", address)
		}
	}
	for _, address := range []string{
		"127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254",
		"100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "224.0.0.1", "198.18.0.1",
		"64:ff9b::a00:1", "64:ff9b:1::1", "fec0::1",
	} {
		if publicAddress(netip.MustParseAddr(address)) {
			t.Errorf("%s should not be public", address)
		}
	}
}
