package localidentity

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func TestProofMatchesTheDesktopVector(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	nonce := strings.Repeat("A", 43)
	// The desktop app computes the same value (local-server.test.ts).
	const want = "eKUTsEU-NZv-SW4c6jF3nCKa44wHETVelI_1rT6yu9w"
	if got := Proof(key, nonce, "http://localhost:3000"); got != want {
		t.Fatalf("proof=%s want=%s", got, want)
	}
	if Proof(key, nonce, "http://localhost:3001") == want {
		t.Fatal("proof ignores the origin")
	}
	if Proof(key, strings.Repeat("B", 43), "http://localhost:3000") == want {
		t.Fatal("proof ignores the nonce")
	}
}

func TestDecodeKeyRequires32Bytes(t *testing.T) {
	if _, err := DecodeKey(base64.StdEncoding.EncodeToString(make([]byte, 32))); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"", "short", base64.StdEncoding.EncodeToString(make([]byte, 31)), base64.RawURLEncoding.EncodeToString(make([]byte, 32))} {
		if _, err := DecodeKey(value); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
}

func TestValidNonce(t *testing.T) {
	if !ValidNonce(base64.RawURLEncoding.EncodeToString(make([]byte, 32))) {
		t.Fatal("rejected a 32-byte nonce")
	}
	for _, nonce := range []string{"", strings.Repeat("A", 42), strings.Repeat("A", 44), strings.Repeat("+", 43)} {
		if ValidNonce(nonce) {
			t.Fatalf("accepted %q", nonce)
		}
	}
}

func TestSessionProofAndDomainSeparation(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	nonce := strings.Repeat("A", 43)
	const timestamp int64 = 1700000000
	const origin = "http://localhost:3000"

	proof := SessionProof(key, nonce, timestamp, origin)
	// packages/local-installation/src/account.test.ts asserts the same vector.
	const want = "LmNSpGCat3lst1DZM0RLuGzYzU-FzqRoVKwGq2LjGB4"
	if proof != want {
		t.Fatalf("sessionProof=%s want=%s", proof, want)
	}
	if !VerifySessionProof(key, nonce, timestamp, origin, proof) {
		t.Fatalf("VerifySessionProof rejected valid proof %q", proof)
	}
	if VerifySessionProof(key, nonce, timestamp+1, origin, proof) {
		t.Fatal("VerifySessionProof ignored timestamp")
	}
	if VerifySessionProof(key, nonce, timestamp, "http://localhost:3001", proof) {
		t.Fatal("VerifySessionProof ignored origin")
	}
	if VerifySessionProof(key, strings.Repeat("B", 43), timestamp, origin, proof) {
		t.Fatal("VerifySessionProof ignored nonce")
	}
	// Domain separation: an identity proof must never be accepted as a session proof.
	identityProof := Proof(key, nonce, origin)
	if identityProof == proof || VerifySessionProof(key, nonce, timestamp, origin, identityProof) {
		t.Fatal("identity proof was accepted as a session proof")
	}
}

func TestNonceCacheRejectsReplayAndExpires(t *testing.T) {
	cache := NewNonceCache()
	base := time.Unix(1700000000, 0).UTC()
	nonce := strings.Repeat("A", 43)

	if !cache.Consume(nonce, base, 2*time.Minute) {
		t.Fatal("first consume rejected")
	}
	if cache.Consume(nonce, base.Add(time.Minute), 2*time.Minute) {
		t.Fatal("replayed nonce accepted before expiry")
	}
	if !cache.Consume(nonce, base.Add(2*time.Minute), 2*time.Minute) {
		t.Fatal("expired nonce was not pruned")
	}
}
