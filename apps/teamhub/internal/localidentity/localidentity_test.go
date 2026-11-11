package localidentity

import (
	"encoding/base64"
	"strings"
	"testing"
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
