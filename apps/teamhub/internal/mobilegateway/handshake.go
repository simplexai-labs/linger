package mobilegateway

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/flynn/noise"
	"golang.org/x/crypto/curve25519"
)

// protocolPrologue binds every handshake to this protocol version; the
// computer's public key follows it, so a phone can complete a handshake only
// with the key its pairing code named.
const protocolPrologue = "linger-mobile/1"

var cipherSuite = noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashSHA256)

// StaticKey is the computer's long-lived X25519 key pair.
type StaticKey struct {
	pair noise.DHKey
}

// NewStaticKey builds the key pair from 32 secret bytes, which the caller
// derives from the deployment's secret seed.
func NewStaticKey(secret []byte) (StaticKey, error) {
	if len(secret) != 32 {
		return StaticKey{}, fmt.Errorf("static key secret has %d bytes, want 32", len(secret))
	}
	private := append([]byte(nil), secret...)
	public, err := curve25519.X25519(private, curve25519.Basepoint)
	if err != nil {
		return StaticKey{}, fmt.Errorf("derive static public key: %w", err)
	}
	return StaticKey{pair: noise.DHKey{Private: private, Public: public}}, nil
}

// Public returns the 32-byte public key.
func (k StaticKey) Public() []byte { return append([]byte(nil), k.pair.Public...) }

// HostID is the lowercase hex of the first 16 bytes of SHA-256 over the
// public key; the Relay routes phones by it.
func (k StaticKey) HostID() string { return HostIDOf(k.pair.Public) }

// HostIDOf computes a Host ID from a public key.
func HostIDOf(public []byte) string {
	sum := sha256.Sum256(public)
	return hex.EncodeToString(sum[:16])
}

func prologue(public []byte) []byte {
	out := make([]byte, 0, len(protocolPrologue)+len(public))
	out = append(out, protocolPrologue...)
	return append(out, public...)
}

// responder runs the computer's side of Noise_XK: the phone knows the
// computer's key from its pairing code, and sends its own key and first data
// only in the third message, after two forward-secret messages. It is not
// safe for concurrent use.
type responder struct {
	state *noise.HandshakeState
}

func newResponder(key StaticKey) (*responder, error) {
	state, err := noise.NewHandshakeState(noise.Config{
		CipherSuite:   cipherSuite,
		Pattern:       noise.HandshakeXK,
		Initiator:     false,
		Prologue:      prologue(key.pair.Public),
		StaticKeypair: key.pair,
	})
	if err != nil {
		return nil, fmt.Errorf("start handshake: %w", err)
	}
	return &responder{state: state}, nil
}

var errHandshake = errors.New("handshake failed")

// readFirst consumes "-> e, es". Its payload must be empty: nothing the
// phone says is trusted before the handshake completes.
func (r *responder) readFirst(message []byte) error {
	payload, _, _, err := r.state.ReadMessage(nil, message)
	if err != nil || len(payload) != 0 {
		return errHandshake
	}
	return nil
}

// writeSecond produces "<- e, ee" with an empty payload.
func (r *responder) writeSecond() ([]byte, error) {
	message, _, _, err := r.state.WriteMessage(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("write handshake reply: %w", err)
	}
	return message, nil
}

// readThird consumes "-> s, se" and returns the hello, the phone's static
// key, and the transport ciphers: recv decrypts what the phone sends and
// send encrypts what the computer sends.
func (r *responder) readThird(message []byte) (hello, phoneKey []byte, recv, send *noise.CipherState, err error) {
	hello, phoneToComputer, computerToPhone, err := r.state.ReadMessage(nil, message)
	if err != nil || phoneToComputer == nil || computerToPhone == nil {
		return nil, nil, nil, nil, errHandshake
	}
	return hello, append([]byte(nil), r.state.PeerStatic()...), phoneToComputer, computerToPhone, nil
}
