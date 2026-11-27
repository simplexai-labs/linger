package relay

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"

	"golang.org/x/crypto/curve25519"
)

// proofLabel domain-separates the host proof; the Mobile Gateway computes the
// same value from its side of the X25519 exchange.
const proofLabel = "linger-relay-host/1"

// hostProof returns HMAC-SHA256(X25519(relayPrivate, hostKey), label || nonce
// || hostKey). X25519 fails for low-order host keys, which therefore never
// prove anything.
func hostProof(relayPrivate, nonce, hostKey []byte) ([]byte, error) {
	shared, err := curve25519.X25519(relayPrivate, hostKey)
	if err != nil {
		return nil, err
	}
	mac := hmac.New(sha256.New, shared)
	mac.Write([]byte(proofLabel))
	mac.Write(nonce)
	mac.Write(hostKey)
	return mac.Sum(nil), nil
}

// verifyHostProof reports whether proof shows possession of the private key
// behind hostKey.
func verifyHostProof(relayPrivate, nonce, hostKey, proof []byte) bool {
	if len(hostKey) != curve25519.PointSize {
		return false
	}
	expected, err := hostProof(relayPrivate, nonce, hostKey)
	if err != nil {
		return false
	}
	return hmac.Equal(expected, proof)
}

// hostID is the lowercase hex of the first 16 bytes of SHA-256(hostKey).
func hostID(hostKey []byte) string {
	sum := sha256.Sum256(hostKey)
	return hex.EncodeToString(sum[:16])
}
