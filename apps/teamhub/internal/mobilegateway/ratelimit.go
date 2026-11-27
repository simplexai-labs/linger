package mobilegateway

import (
	"net"
	"sync"
	"time"
)

// pairingPerMinute bounds pairing attempts on one computer. Pairing is rare,
// and every attempt spends a database transaction, so this is independent of
// the password login limit.
const pairingPerMinute = 10

// LAN admission: each client address may start lanPerClientPerMinute
// connections a minute, and the listener holds at most lanMaxOpen at once.
const (
	lanPerClientPerMinute = 30
	lanMaxOpen            = 64
	lanMaxTracked         = 1024
)

type lanLimits struct {
	mu      sync.Mutex
	open    int
	clients map[string]*rateLimiter
}

func newLANLimits() *lanLimits { return &lanLimits{clients: map[string]*rateLimiter{}} }

// admit takes a connection slot for the client at remoteAddr; release frees
// it once the connection ends.
func (l *lanLimits) admit(remoteAddr string) (release func(), ok bool) {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.open >= lanMaxOpen {
		return nil, false
	}
	limiter := l.clients[host]
	if limiter == nil {
		if len(l.clients) >= lanMaxTracked {
			// Forgetting every bucket at once only resets their counts.
			l.clients = map[string]*rateLimiter{}
		}
		limiter = newRateLimiter(lanPerClientPerMinute, time.Minute)
		l.clients[host] = limiter
	}
	if !limiter.Allow() {
		return nil, false
	}
	l.open++
	return func() {
		l.mu.Lock()
		l.open--
		l.mu.Unlock()
	}, true
}

// rateLimiter is a token bucket refilled evenly over its period.
type rateLimiter struct {
	mu       sync.Mutex
	capacity float64
	tokens   float64
	perNanos float64
	last     time.Time
	now      func() time.Time
}

func newRateLimiter(capacity int, period time.Duration) *rateLimiter {
	return &rateLimiter{
		capacity: float64(capacity), tokens: float64(capacity),
		perNanos: float64(capacity) / float64(period.Nanoseconds()),
		last:     time.Now(), now: time.Now,
	}
}

// Allow spends one token when one is available.
func (r *rateLimiter) Allow() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	r.tokens = min(r.capacity, r.tokens+float64(now.Sub(r.last).Nanoseconds())*r.perNanos)
	r.last = now
	if r.tokens < 1 {
		return false
	}
	r.tokens--
	return true
}
