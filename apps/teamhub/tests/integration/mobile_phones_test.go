package integration_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/flynn/noise"
	"github.com/gorilla/websocket"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

// mobilePhone is a test phone speaking the Mobile App session protocol of
// docs/mobile.md to the real Gateway over a loopback socket.
type mobilePhone struct {
	t      *testing.T
	conn   *websocket.Conn
	send   *noise.CipherState
	recv   *noise.CipherState
	hello  map[string]any
	stream uint32
}

var mobileSuite = noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashSHA256)

func dialMobilePhone(t *testing.T, lanURL string, hostKey []byte, static noise.DHKey, hello map[string]any) *mobilePhone {
	t.Helper()
	sum := sha256Prefix(hostKey)
	conn, response, err := websocket.DefaultDialer.Dial(lanURL+"/v1/connect/"+sum, nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		t.Fatalf("dial gateway: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	prologue := append([]byte("linger-mobile/1"), hostKey...)
	state, err := noise.NewHandshakeState(noise.Config{
		CipherSuite: mobileSuite, Pattern: noise.HandshakeXK, Initiator: true,
		Prologue: prologue, StaticKeypair: static, PeerStatic: hostKey,
	})
	if err != nil {
		t.Fatal(err)
	}
	first, _, _, err := state.WriteMessage(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	writeBinary(t, conn, first)
	second := readBinary(t, conn)
	if _, _, _, err := state.ReadMessage(nil, second); err != nil {
		t.Fatalf("read handshake reply: %v", err)
	}
	payload, _ := json.Marshal(hello)
	third, send, recv, err := state.WriteMessage(nil, payload)
	if err != nil {
		t.Fatal(err)
	}
	writeBinary(t, conn, third)
	welcome, err := recv.Decrypt(nil, nil, readBinary(t, conn))
	if err != nil {
		t.Fatalf("decrypt welcome: %v", err)
	}
	phone := &mobilePhone{t: t, conn: conn, send: send, recv: recv, stream: 1}
	if err := json.Unmarshal(welcome, &phone.hello); err != nil {
		t.Fatal(err)
	}
	return phone
}

func sha256Prefix(key []byte) string {
	// Host ID: lowercase hex of the first 16 bytes of SHA-256(public key).
	sum := sha256.Sum256(key)
	return hex.EncodeToString(sum[:16])
}

func writeBinary(t *testing.T, conn *websocket.Conn, message []byte) {
	t.Helper()
	if err := conn.WriteMessage(websocket.BinaryMessage, message); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func readBinary(t *testing.T, conn *websocket.Conn) []byte {
	t.Helper()
	_, message, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return message
}

func (p *mobilePhone) frame(kind byte, stream uint32, payload []byte) {
	p.t.Helper()
	plain := make([]byte, 5+len(payload))
	plain[0] = kind
	binary.BigEndian.PutUint32(plain[1:5], stream)
	copy(plain[5:], payload)
	ciphertext, err := p.send.Encrypt(nil, nil, plain)
	if err != nil {
		p.t.Fatal(err)
	}
	writeBinary(p.t, p.conn, ciphertext)
}

type mobileFrame struct {
	kind    byte
	stream  uint32
	payload []byte
}

func (p *mobilePhone) next() (mobileFrame, error) {
	_, message, err := p.conn.ReadMessage()
	if err != nil {
		return mobileFrame{}, err
	}
	plain, err := p.recv.Decrypt(nil, nil, message)
	if err != nil {
		return mobileFrame{}, err
	}
	return mobileFrame{kind: plain[0], stream: binary.BigEndian.Uint32(plain[1:5]), payload: plain[5:]}, nil
}

// do sends one request and returns its status and body, or the reset code.
func (p *mobilePhone) do(method, path string, body any) (int, []byte, string) {
	p.t.Helper()
	stream := p.stream
	p.stream += 2
	head, _ := json.Marshal(map[string]any{"method": method, "path": path, "headers": map[string][]string{"Content-Type": {"application/json"}}})
	p.frame(1, stream, head)
	if body != nil {
		encoded, _ := json.Marshal(body)
		p.frame(2, stream, encoded)
	}
	p.frame(3, stream, nil)
	status := 0
	var out bytes.Buffer
	for {
		f, err := p.next()
		if err != nil {
			p.t.Fatalf("read frame: %v", err)
		}
		if f.stream != stream {
			continue
		}
		switch f.kind {
		case 4:
			var head struct {
				Status int `json:"status"`
			}
			_ = json.Unmarshal(f.payload, &head)
			status = head.Status
		case 2:
			out.Write(f.payload)
		case 3:
			return status, out.Bytes(), ""
		case 5:
			var reset struct {
				Code string `json:"code"`
			}
			_ = json.Unmarshal(f.payload, &reset)
			return 0, nil, reset.Code
		}
	}
}

func (p *mobilePhone) awaitControl(kind string) {
	p.t.Helper()
	for {
		f, err := p.next()
		if err != nil {
			p.t.Fatalf("waiting for %s: %v", kind, err)
		}
		if f.kind == 8 && f.stream == 0 && strings.Contains(string(f.payload), `"`+kind+`"`) {
			return
		}
	}
}

type pairingCode struct {
	Version   int      `json:"v"`
	HostKey   string   `json:"host_key"`
	Invite    string   `json:"invite"`
	LAN       []string `json:"lan"`
	ExpiresAt string   `json:"expires_at"`
}

func TestMobilePhonePairsActsAndIsRemoved(t *testing.T) {
	allowParallelIntegrationTest(t)
	settings := config.ForTest()
	secret := make([]byte, 32)
	_, _ = rand.Read(secret)
	settings.Mobile = config.MobileConfig{StaticKeySecret: secret, LANAddress: "127.0.0.1:0", PushServiceURL: "https://push.example.com"}
	env := newPersistentSessionEnvWithConfig(t, settings)
	alice := env.login("alice", alicePassword)

	// The Gateway binds its listener in a worker; wait until a code lists it.
	var code pairingCode
	deadline := time.Now().Add(10 * time.Second)
	for {
		status, _, body := env.request(alice, http.MethodPost, "/v0/me/phone-pairings", nil, "")
		if status != http.StatusCreated {
			t.Fatalf("pairing code status=%d body=%s", status, body)
		}
		var response struct {
			PairingURI string `json:"pairing_uri"`
		}
		decode(t, body, &response)
		raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(response.PairingURI, "linger://pair?d="))
		if err != nil {
			t.Fatal(err)
		}
		decode(t, raw, &code)
		if len(code.LAN) > 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if code.Version != 1 || len(code.LAN) != 1 || code.Invite == "" {
		t.Fatalf("pairing code = %+v", code)
	}
	hostKey, err := base64.RawURLEncoding.DecodeString(code.HostKey)
	if err != nil {
		t.Fatal(err)
	}
	static, err := noise.DH25519.GenerateKeypair(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	phone := dialMobilePhone(t, code.LAN[0], hostKey, static, map[string]any{"type": "pair", "invite": code.Invite, "name": "Test Pixel", "platform": "android"})
	if phone.hello["type"] != "pending" {
		t.Fatalf("pair welcome = %v", phone.hello)
	}
	confirmation, _ := phone.hello["code"].(string)
	phoneID, _ := phone.hello["phone_id"].(string)
	status, _, body := env.request(alice, http.MethodGet, "/v0/me/phones", nil, "")
	if status != 200 || !strings.Contains(string(body), `"confirmation_code":"`+confirmation+`"`) || !strings.Contains(string(body), `"status":"pending"`) {
		t.Fatalf("phones while pending = %d %s", status, body)
	}
	if _, _, reset := phone.do(http.MethodGet, "/v0/me", nil); reset != "PAIRING_PENDING" {
		t.Fatalf("pending request reset = %q", reset)
	}

	// The spent invite cannot pair a second phone.
	other, _ := noise.DH25519.GenerateKeypair(rand.Reader)
	stranger := dialMobilePhone(t, code.LAN[0], hostKey, other, map[string]any{"type": "pair", "invite": code.Invite, "name": "Other", "platform": "ios"})
	if stranger.hello["code"] != "INVITE_INVALID" {
		t.Fatalf("second pair = %v", stranger.hello)
	}

	if status, _, body := env.request(alice, http.MethodPost, "/v0/me/phones/"+phoneID+"/approve", nil, ""); status != http.StatusNoContent {
		t.Fatalf("approve = %d %s", status, body)
	}
	phone.awaitControl("approved")
	status, body, _ = phone.do(http.MethodGet, "/v0/me", nil)
	if status != 200 || !strings.Contains(string(body), "alice@example.com") {
		t.Fatalf("phone /v0/me = %d %s", status, body)
	}
	if status, _, _ := phone.do(http.MethodPost, "/v0/account/password", map[string]any{"current_password": alicePassword, "new_password": "replacement-password"}); status != http.StatusNotFound {
		t.Fatalf("password change from a phone = %d", status)
	}
	if status, _, _ := phone.do(http.MethodPost, "/v0/me/phone-pairings", nil); status != http.StatusNotFound {
		t.Fatalf("pairing administration from a phone = %d", status)
	}
	// A phone may not point the computer into its own network.
	private := map[string]any{"url": "ws://127.0.0.1:7787"}
	if status, body, _ := phone.do(http.MethodPost, "/v0/mobile/relays", private); status != http.StatusForbidden || !strings.Contains(string(body), "RELAY_PRIVATE_FROM_PHONE") {
		t.Fatalf("private relay from the phone = %d %s", status, body)
	}
	elsewhere := map[string]any{"grant": "sealed-grant", "service_url": "https://push.attacker.example"}
	if status, body, _ := phone.do(http.MethodPut, "/v0/me/phone/push-grant", elsewhere); status != http.StatusBadRequest || !strings.Contains(string(body), "PUSH_SERVICE_NOT_ALLOWED") {
		t.Fatalf("push grant naming another service = %d %s", status, body)
	}
	preferences := map[string]any{"replies": false, "decisions": true, "when_active": true}
	if status, body, _ := phone.do(http.MethodPut, "/v0/me/phone/push-preferences", preferences); status != http.StatusNoContent {
		t.Fatalf("push preferences from the phone = %d %s", status, body)
	}
	if status, _, _ := env.request(alice, http.MethodPut, "/v0/me/phone/push-preferences", preferences, ""); status != http.StatusForbidden {
		t.Fatalf("push preferences from a browser = %d", status)
	}
	grant := map[string]any{"grant": "sealed-grant", "service_url": "https://push.example.com"}
	if status, body, _ := phone.do(http.MethodPut, "/v0/me/phone/push-grant", grant); status != http.StatusNoContent {
		t.Fatalf("push grant from the phone = %d %s", status, body)
	}
	if status, _, body := env.request(alice, http.MethodPut, "/v0/me/phone/push-grant", grant, ""); status != http.StatusForbidden || !strings.Contains(string(body), "PHONE_ONLY") {
		t.Fatalf("push grant from a browser = %d %s", status, body)
	}

	// A published Message enqueues one push job in its own transaction.
	roomID := env.createRoom(alice, acmeTenant, "Mobile push", "mobile-push-room")
	env.createMessage(alice, roomID, "hello", "mobile-push-message")
	var jobs int
	if err := env.pool.QueryRow(context.Background(), `select count(*) from river_job where kind = 'mobile.push' and args->>'tenant_id' = $1`, acmeTenant).Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if jobs < 1 {
		t.Fatalf("mobile.push jobs = %d", jobs)
	}

	// A paired phone resumes on its key alone.
	resumed := dialMobilePhone(t, code.LAN[0], hostKey, static, map[string]any{"type": "resume"})
	if resumed.hello["type"] != "welcome" || resumed.hello["phone_id"] != phoneID {
		t.Fatalf("resume = %v", resumed.hello)
	}

	if status, _, body := env.request(alice, http.MethodDelete, "/v0/me/phones/"+phoneID, nil, ""); status != http.StatusNoContent {
		t.Fatalf("remove = %d %s", status, body)
	}
	if _, err := resumed.next(); err == nil {
		// Drain a frame that raced the close; the next read must fail.
		if _, err := resumed.next(); err == nil {
			t.Fatal("removed phone's session stayed open")
		}
	}
	var revoked int
	if err := env.pool.QueryRow(context.Background(), `select count(*) from auth_sessions s join paired_phones p on p.session_id = s.id where p.id = $1 and s.revoked_reason = 'phone_removed'`, phoneID).Scan(&revoked); err != nil {
		t.Fatal(err)
	}
	if revoked != 1 {
		t.Fatalf("revoked device sessions = %d", revoked)
	}
	again := dialMobilePhone(t, code.LAN[0], hostKey, static, map[string]any{"type": "resume"})
	if again.hello["code"] != "PHONE_REMOVED" {
		t.Fatalf("removed phone resume = %v", again.hello)
	}
}
