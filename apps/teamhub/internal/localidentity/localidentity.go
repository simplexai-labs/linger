// Package localidentity lets the desktop app check that the server on a local
// installation's port is that installation before it sends the owner's
// password: both sides hold a per-installation key, and the server answers a
// fresh nonce with an HMAC only the key can produce.
package localidentity

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"regexp"
	"strconv"
	"sync"
	"time"
)

const (
	label                = "linger-local-identity"
	sessionLabel         = "linger-local-session"
	maxNonceCacheEntries = 1024
)

// SessionProofWindow is the maximum allowed clock skew in either direction for
// a local session proof timestamp.
const SessionProofWindow = 60 * time.Second

var noncePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// DecodeKey reads TEAMHUB_LOCAL_IDENTITY_KEY: 32 bytes in standard base64.
func DecodeKey(value string) ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(key) != 32 {
		return nil, errors.New("TEAMHUB_LOCAL_IDENTITY_KEY must be 32 bytes in standard base64")
	}
	return key, nil
}

// ValidNonce reports whether nonce is 32 bytes in unpadded base64url.
func ValidNonce(nonce string) bool {
	return noncePattern.MatchString(nonce)
}

// Proof is the unpadded base64url HMAC-SHA256 of the label, the nonce and the
// server's web origin, joined with newlines.
func Proof(key []byte, nonce, origin string) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(label + "\n" + nonce + "\n" + origin))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// SessionProof is the unpadded base64url HMAC-SHA256 of the session label, the
// nonce, the Unix timestamp in seconds UTC, and the server's web origin, joined
// with newlines.
func SessionProof(key []byte, nonce string, timestamp int64, origin string) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(sessionLabel + "\n" + nonce + "\n" + strconv.FormatInt(timestamp, 10) + "\n" + origin))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// VerifySessionProof compares proof against SessionProof in constant time.
func VerifySessionProof(key []byte, nonce string, timestamp int64, origin, proof string) bool {
	expected := SessionProof(key, nonce, timestamp, origin)
	return hmac.Equal([]byte(expected), []byte(proof))
}

// NonceCache tracks recently used local session nonces to reject replays.
type NonceCache struct {
	mu      sync.Mutex
	entries map[string]time.Time
}

// NewNonceCache returns an empty NonceCache.
func NewNonceCache() *NonceCache {
	return &NonceCache{entries: make(map[string]time.Time)}
}

// Consume records nonce until now+ttl and returns true if nonce was not already
// present and the cache has capacity. Expired entries are pruned on each call.
func (c *NonceCache) Consume(nonce string, now time.Time, ttl time.Duration) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = make(map[string]time.Time)
	}
	for k, expiresAt := range c.entries {
		if !expiresAt.After(now) {
			delete(c.entries, k)
		}
	}
	if _, exists := c.entries[nonce]; exists {
		return false
	}
	if len(c.entries) >= maxNonceCacheEntries {
		return false
	}
	c.entries[nonce] = now.Add(ttl)
	return true
}
