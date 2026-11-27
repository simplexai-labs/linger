package mobilegateway

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/flynn/noise"
	"golang.org/x/crypto/curve25519"
)

// vectorsPath holds handshake and transport vectors that the Mobile App's
// TypeScript session must reproduce byte for byte. Regenerate it with
// LINGER_UPDATE_MOBILE_VECTORS=1 only when the protocol changes on purpose.
var vectorsPath = filepath.Join("..", "..", "..", "..", "contracts", "mobile-session", "vectors.json")

type sessionVectors struct {
	Protocol          string            `json:"protocol"`
	Prologue          string            `json:"prologue_hex"`
	ComputerStatic    string            `json:"computer_static_private_hex"`
	ComputerPublic    string            `json:"computer_static_public_hex"`
	ComputerEphemeral string            `json:"computer_ephemeral_private_hex"`
	PhoneStatic       string            `json:"phone_static_private_hex"`
	PhoneEphemeral    string            `json:"phone_ephemeral_private_hex"`
	HostID            string            `json:"host_id"`
	FirstMessage      string            `json:"first_message_hex"`
	SecondMessage     string            `json:"second_message_hex"`
	HelloPayload      string            `json:"hello_payload_hex"`
	ThirdMessage      string            `json:"third_message_hex"`
	WelcomePayload    string            `json:"welcome_payload_hex"`
	WelcomeMessage    string            `json:"welcome_message_hex"`
	PhoneToComputer   []transportVector `json:"phone_to_computer"`
	ComputerToPhone   []transportVector `json:"computer_to_phone"`
	RelayProof        relayProofVector  `json:"relay_proof"`
}

type transportVector struct {
	Plaintext  string `json:"plaintext_hex"`
	Ciphertext string `json:"ciphertext_hex"`
}

type relayProofVector struct {
	RelayPrivate string `json:"relay_private_hex"`
	RelayPublic  string `json:"relay_public_hex"`
	Nonce        string `json:"nonce_hex"`
	Proof        string `json:"proof_hex"`
}

func fixed(fill byte) []byte { return bytes.Repeat([]byte{fill}, 32) }

func buildVectors(t *testing.T) sessionVectors {
	t.Helper()
	computer, err := NewStaticKey(fixed(0x11))
	if err != nil {
		t.Fatal(err)
	}
	phonePublic, _ := curve25519.X25519(fixed(0x33), curve25519.Basepoint)
	phone := noise.DHKey{Private: fixed(0x33), Public: phonePublic}
	initiator, err := noise.NewHandshakeState(noise.Config{
		CipherSuite: cipherSuite, Pattern: noise.HandshakeXK, Initiator: true,
		Prologue: prologue(computer.Public()), StaticKeypair: phone, PeerStatic: computer.Public(),
		Random: bytes.NewReader(fixed(0x44)),
	})
	if err != nil {
		t.Fatal(err)
	}
	responderState, err := noise.NewHandshakeState(noise.Config{
		CipherSuite: cipherSuite, Pattern: noise.HandshakeXK, Initiator: false,
		Prologue: prologue(computer.Public()), StaticKeypair: computer.pair,
		Random: bytes.NewReader(fixed(0x22)),
	})
	if err != nil {
		t.Fatal(err)
	}
	first, _, _, err := initiator.WriteMessage(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := responderState.ReadMessage(nil, first); err != nil {
		t.Fatal(err)
	}
	second, _, _, err := responderState.WriteMessage(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := initiator.ReadMessage(nil, second); err != nil {
		t.Fatal(err)
	}
	hello := []byte(`{"type":"pair","invite":"aW52aXRl","name":"Pixel","platform":"android"}`)
	third, phoneSend, phoneRecv, err := initiator.WriteMessage(nil, hello)
	if err != nil || phoneSend == nil || phoneRecv == nil {
		t.Fatalf("initiator third message: %v", err)
	}
	if _, recv, send, err := responderState.ReadMessage(nil, third); err != nil || recv == nil || send == nil {
		t.Fatalf("responder third message: %v", err)
	}
	welcome := []byte(`{"type":"welcome","phone_id":"phone_1","name":"Studio Mac","lan":["ws://192.168.1.20:7787"]}`)
	welcomeMessage, err := phoneRecv.Encrypt(nil, nil, welcome)
	if err != nil {
		t.Fatal(err)
	}
	v := sessionVectors{
		Protocol:          "Noise_XK_25519_ChaChaPoly_SHA256",
		Prologue:          hex.EncodeToString(prologue(computer.Public())),
		ComputerStatic:    hex.EncodeToString(fixed(0x11)),
		ComputerPublic:    hex.EncodeToString(computer.Public()),
		ComputerEphemeral: hex.EncodeToString(fixed(0x22)),
		PhoneStatic:       hex.EncodeToString(fixed(0x33)),
		PhoneEphemeral:    hex.EncodeToString(fixed(0x44)),
		HostID:            computer.HostID(),
		FirstMessage:      hex.EncodeToString(first),
		SecondMessage:     hex.EncodeToString(second),
		HelloPayload:      hex.EncodeToString(hello),
		ThirdMessage:      hex.EncodeToString(third),
		WelcomePayload:    hex.EncodeToString(welcome),
		WelcomeMessage:    hex.EncodeToString(welcomeMessage),
	}
	// The phone's receive cipher shares the computer's send key; using a
	// copy on the phone side keeps the vectors' nonces aligned: the welcome
	// took nonce 0, so computer-to-phone frames below start at nonce 1.
	recv, send := phoneSend, phoneRecv
	for _, plain := range [][]byte{
		mustFrame(t, frameRequest, 1, []byte(`{"method":"GET","path":"/v0/me","headers":{}}`)),
		mustFrame(t, frameEnd, 1, nil),
	} {
		ct, err := recv.Encrypt(nil, nil, plain)
		if err != nil {
			t.Fatal(err)
		}
		v.PhoneToComputer = append(v.PhoneToComputer, transportVector{Plaintext: hex.EncodeToString(plain), Ciphertext: hex.EncodeToString(ct)})
	}
	for _, plain := range [][]byte{
		mustFrame(t, frameResponse, 1, []byte(`{"status":200,"headers":{}}`)),
		mustFrame(t, frameData, 1, []byte(`{"id":"account_1"}`)),
	} {
		ct, err := send.Encrypt(nil, nil, plain)
		if err != nil {
			t.Fatal(err)
		}
		v.ComputerToPhone = append(v.ComputerToPhone, transportVector{Plaintext: hex.EncodeToString(plain), Ciphertext: hex.EncodeToString(ct)})
	}
	relayPublic, _ := curve25519.X25519(fixed(0x55), curve25519.Basepoint)
	nonce := bytes.Repeat([]byte{0x66}, 24)
	proof, err := relayProof(fixed(0x11), relayPublic, nonce, computer.Public())
	if err != nil {
		t.Fatal(err)
	}
	v.RelayProof = relayProofVector{
		RelayPrivate: hex.EncodeToString(fixed(0x55)), RelayPublic: hex.EncodeToString(relayPublic),
		Nonce: hex.EncodeToString(nonce), Proof: hex.EncodeToString(proof),
	}
	return v
}

func mustFrame(t *testing.T, kind frameType, stream uint32, payload []byte) []byte {
	t.Helper()
	encoded, err := encodeFrame(kind, stream, payload)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestSessionVectorsAreCurrent(t *testing.T) {
	got := buildVectors(t)
	encoded, err := json.MarshalIndent(got, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	encoded = append(encoded, '\n')
	if os.Getenv("LINGER_UPDATE_MOBILE_VECTORS") == "1" {
		if err := os.WriteFile(vectorsPath, encoded, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(vectorsPath)
	if err != nil {
		t.Fatalf("read %s: %v (regenerate with LINGER_UPDATE_MOBILE_VECTORS=1)", vectorsPath, err)
	}
	if !bytes.Equal(want, encoded) {
		t.Fatalf("%s is stale; the protocol changed. Regenerate it with LINGER_UPDATE_MOBILE_VECTORS=1 on purpose", vectorsPath)
	}
}
