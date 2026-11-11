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
)

const label = "linger-local-identity"

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
