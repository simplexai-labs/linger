package relay

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// limiter is a token bucket per client address that refills perMinute tokens
// each minute up to a burst of perMinute.
type limiter struct {
	perMinute float64

	mu        sync.Mutex
	buckets   map[string]*bucket
	lastSweep time.Time
}

type bucket struct {
	tokens  float64
	updated time.Time
}

func newLimiter(perMinute int) *limiter {
	return &limiter{perMinute: float64(perMinute), buckets: map[string]*bucket{}}
}

func (l *limiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	// A bucket untouched for a minute is full again, the same as no bucket,
	// so dropping it keeps memory proportional to recent clients.
	if now.Sub(l.lastSweep) >= time.Minute {
		for k, b := range l.buckets {
			if now.Sub(b.updated) >= time.Minute {
				delete(l.buckets, k)
			}
		}
		l.lastSweep = now
	}
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.perMinute, updated: now}
		l.buckets[key] = b
	}
	b.tokens = min(l.perMinute, b.tokens+now.Sub(b.updated).Minutes()*l.perMinute)
	b.updated = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// clientAddress returns the address rate limits apply to. X-Forwarded-For is
// read right to left, and only while each hop is a trusted proxy, so a client
// cannot pick its own key by sending the header itself.
func clientAddress(r *http.Request, trusted []netip.Prefix) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	addr = addr.Unmap()
	hops := []string{}
	for _, value := range r.Header.Values("X-Forwarded-For") {
		hops = append(hops, strings.Split(value, ",")...)
	}
	for i := len(hops) - 1; i >= 0 && isTrusted(addr, trusted); i-- {
		hop, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			break
		}
		addr = hop.Unmap()
	}
	return addr.String()
}

func isTrusted(addr netip.Addr, trusted []netip.Prefix) bool {
	for _, prefix := range trusted {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

// ClientAddress is the rate-limit key the Relay uses for a request, so the
// Push Service limits clients the same way.
func (s *Server) ClientAddress(r *http.Request) string {
	return clientAddress(r, s.trustedProxies)
}
