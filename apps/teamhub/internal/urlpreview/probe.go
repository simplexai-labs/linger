package urlpreview

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"syscall"
	"time"
)

// Framing is what a probe learned about framing a page.
type Framing string

// Probe outcomes; they match the contract's UrlPreviewFraming values.
const (
	Allowed Framing = "allowed"
	Refused Framing = "refused"
	// Unknown means TeamHub did not read the page: it was unreachable, too
	// slow, redirected too often, busy with other probes, or on an address or
	// port TeamHub never requests.
	Unknown Framing = "unknown"
)

// ErrInvalidURL marks a URL that is not http or https, has no host, or
// carries credentials.
var ErrInvalidURL = errors.New("url is not an http or https page without credentials")

var errNotProbed = errors.New("page is not on a public address and standard port")

const (
	maxRedirects = 5
	probeTimeout = 5 * time.Second
	// Framing rules sit in a few headers; a site sending more is not read.
	maxHeaderBytes = 64 << 10
	// Probes in flight across all callers; more answer Unknown at once, so
	// TeamHub cannot be turned into a request amplifier.
	maxConcurrentProbes = 8
	// Sites may send other headers to clients they do not recognize, so the
	// probe presents itself as a mainstream browser.
	userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

type resolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

type settings struct {
	proxy   func(*http.Request) (*url.URL, error)
	allowed func(netip.Addr) bool
	names   resolver
	// anyPort lets tests reach local servers on their random ports.
	anyPort bool
}

// Prober requests pages for their framing rules. It sends HEAD, and GET
// only to a server that refuses HEAD, so following a one-time link rarely
// spends it. It requests only public addresses on the standard http and
// https ports. Without a proxy it checks the address it connects to, so a
// name that resolves elsewhere later cannot reach a private address. Through
// the environment's proxy, which resolves names itself, it checks the name's
// addresses before the request.
type Prober struct {
	settings
	slots   chan struct{}
	direct  *http.Client
	proxied *http.Client
}

// New returns a Prober that honors the environment's HTTP(S)_PROXY and
// NO_PROXY.
func New() *Prober {
	return newProber(settings{proxy: http.ProxyFromEnvironment, allowed: publicAddress, names: net.DefaultResolver})
}

func newProber(s settings) *Prober {
	guarded := &net.Dialer{
		Timeout: probeTimeout,
		Control: func(_, address string, _ syscall.RawConn) error {
			addrPort, err := netip.ParseAddrPort(address)
			if err != nil || !s.allowed(addrPort.Addr().Unmap()) {
				return errNotProbed
			}
			return nil
		},
	}
	// Redirects are followed by Probe so each hop is checked.
	lastResponse := func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	transport := func(proxy func(*http.Request) (*url.URL, error), dial func(context.Context, string, string) (net.Conn, error)) *http.Transport {
		return &http.Transport{
			Proxy:                  proxy,
			DialContext:            dial,
			TLSHandshakeTimeout:    probeTimeout,
			ResponseHeaderTimeout:  probeTimeout,
			MaxResponseHeaderBytes: maxHeaderBytes,
			MaxIdleConnsPerHost:    1,
			IdleConnTimeout:        30 * time.Second,
		}
	}
	return &Prober{
		settings: s,
		slots:    make(chan struct{}, maxConcurrentProbes),
		direct:   &http.Client{Transport: transport(nil, guarded.DialContext), CheckRedirect: lastResponse},
		proxied: &http.Client{
			Transport:     transport(s.proxy, (&net.Dialer{Timeout: probeTimeout}).DialContext),
			CheckRedirect: lastResponse,
		},
	}
}

// Probe reads the framing rules of the page at rawURL for a Linger page
// served over pageScheme ("http" or "https"; empty when unknown). It fails
// only for an invalid URL; a page it did not read is Unknown.
func (p *Prober) Probe(ctx context.Context, rawURL, pageScheme string) (Framing, error) {
	target, err := parsePage(rawURL)
	if err != nil {
		return "", err
	}
	select {
	case p.slots <- struct{}{}:
		defer func() { <-p.slots }()
	default:
		return Unknown, nil
	}
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	for hop := 0; hop <= maxRedirects; hop++ {
		header, location, err := p.headers(ctx, target)
		if err != nil {
			return Unknown, nil
		}
		if location == "" {
			if refusesFraming(header, pageScheme) {
				return Refused, nil
			}
			return Allowed, nil
		}
		next, err := target.Parse(location)
		if err != nil {
			return Unknown, nil
		}
		if target, err = checkPage(next); err != nil {
			return Unknown, nil
		}
	}
	return Unknown, nil
}

// headers returns a page's response headers, or the redirect it answers
// with.
func (p *Prober) headers(ctx context.Context, target *url.URL) (http.Header, string, error) {
	if !p.anyPort && !standardPort(target) {
		return nil, "", errNotProbed
	}
	response, err := p.send(ctx, http.MethodHead, target)
	if err == nil && (response.StatusCode == http.StatusMethodNotAllowed || response.StatusCode == http.StatusNotImplemented) {
		_ = response.Body.Close()
		response, err = p.send(ctx, http.MethodGet, target)
	}
	if err != nil {
		return nil, "", err
	}
	// The body is never read; closing it ends the request.
	_ = response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		return response.Header, response.Header.Get("Location"), nil
	}
	return response.Header, "", nil
}

func (p *Prober) send(ctx context.Context, method string, target *url.URL) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, method, target.String(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", userAgent)
	request.Header.Set("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8")
	proxyURL, err := p.proxy(request)
	if err != nil {
		return nil, err
	}
	if proxyURL == nil {
		return p.direct.Do(request)
	}
	if err := p.checkName(ctx, target.Hostname()); err != nil {
		return nil, err
	}
	return p.proxied.Do(request)
}

// checkName requires every address of host to be public. The proxy resolves
// the name again, so a name that changes its answer in between can still
// reach the proxy's private network; certificates stop that for https.
func (p *Prober) checkName(ctx context.Context, host string) error {
	if addr, err := netip.ParseAddr(host); err == nil {
		if !p.allowed(addr.Unmap()) {
			return errNotProbed
		}
		return nil
	}
	addrs, err := p.names.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return err
	}
	if len(addrs) == 0 {
		return errNotProbed
	}
	for _, addr := range addrs {
		if !p.allowed(addr.Unmap()) {
			return errNotProbed
		}
	}
	return nil
}

// standardPort keeps the probe off other services on public hosts, so it
// cannot be used to tell which of their ports are open.
func standardPort(page *url.URL) bool {
	switch page.Port() {
	case "":
		return true
	case "80":
		return page.Scheme == "http"
	case "443":
		return page.Scheme == "https"
	}
	return false
}

func parsePage(rawURL string) (*url.URL, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, ErrInvalidURL
	}
	return checkPage(parsed)
}

func checkPage(page *url.URL) (*url.URL, error) {
	if (page.Scheme != "http" && page.Scheme != "https") || page.Hostname() == "" || page.User != nil {
		return nil, ErrInvalidURL
	}
	page.Fragment = ""
	page.RawFragment = ""
	return page, nil
}

// Ranges that are not public beyond what netip's predicates cover.
var nonPublicPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("64:ff9b::/96"),
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("fec0::/10"),
}

// publicAddress reports whether addr is a public unicast address, never a
// loopback, private, link-local, shared, documentation, translated or
// reserved one.
func publicAddress(addr netip.Addr) bool {
	if !addr.IsGlobalUnicast() || addr.IsPrivate() {
		return false
	}
	for _, prefix := range nonPublicPrefixes {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}
