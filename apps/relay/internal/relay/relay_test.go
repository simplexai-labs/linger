package relay

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/curve25519"
)

func newTestServer(t *testing.T, tune func(*Server)) (*Server, string) {
	t.Helper()
	server := New(Options{Logger: slog.New(slog.NewJSONHandler(io.Discard, nil))})
	if tune != nil {
		tune(server)
	}
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)
	return server, "ws" + strings.TrimPrefix(httpServer.URL, "http")
}

// fakeHost speaks the host side of the protocol the way the Mobile Gateway
// does; the proof math is repeated here because apps may not import each
// other.
type fakeHost struct {
	t       *testing.T
	base    string
	private []byte
	public  []byte
	id      string
	control *websocket.Conn
	opens   chan controlMessage
	spares  chan controlMessage
	ended   chan error
}

func newHostKey(t *testing.T) []byte {
	t.Helper()
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	return key
}

func gatewayProof(private, relayKey, nonce, hostKey []byte) []byte {
	shared, err := curve25519.X25519(private, relayKey)
	if err != nil {
		panic(err)
	}
	mac := hmac.New(sha256.New, shared)
	mac.Write([]byte("linger-relay-host/1"))
	mac.Write(nonce)
	mac.Write(hostKey)
	return mac.Sum(nil)
}

func dial(t *testing.T, url string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	conn, response, err := websocket.DefaultDialer.Dial(url, nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if conn != nil {
		t.Cleanup(func() { _ = conn.Close() })
	}
	return conn, response, err
}

func readJSON(t *testing.T, conn *websocket.Conn) controlMessage {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var message controlMessage
	if err := conn.ReadJSON(&message); err != nil {
		t.Fatalf("read control message: %v", err)
	}
	return message
}

func connectHost(t *testing.T, base string, private []byte) *fakeHost {
	t.Helper()
	return connectHostWith(t, base, private, false)
}

func connectHostWith(t *testing.T, base string, private []byte, spares bool) *fakeHost {
	t.Helper()
	public, err := curve25519.X25519(private, curve25519.Basepoint)
	if err != nil {
		t.Fatal(err)
	}
	control, _, err := dial(t, base+"/v1/host")
	if err != nil {
		t.Fatalf("dial host: %v", err)
	}
	challenge := readJSON(t, control)
	relayKey, _ := base64.RawURLEncoding.DecodeString(challenge.RelayKey)
	nonce, _ := base64.RawURLEncoding.DecodeString(challenge.Nonce)
	if challenge.Type != "challenge" || len(relayKey) != 32 || len(nonce) != 24 {
		t.Fatalf("unexpected challenge %+v", challenge)
	}
	if err := control.WriteJSON(controlMessage{
		Type:    "hello",
		HostKey: base64.RawURLEncoding.EncodeToString(public),
		Proof:   base64.RawURLEncoding.EncodeToString(gatewayProof(private, relayKey, nonce, public)),
		Spares:  spares,
	}); err != nil {
		t.Fatal(err)
	}
	if ready := readJSON(t, control); ready.Type != "ready" {
		t.Fatalf("expected ready, got %+v", ready)
	}
	_ = control.SetReadDeadline(time.Time{})
	h := &fakeHost{
		t: t, base: base, private: private, public: public, id: hostID(public),
		control: control, opens: make(chan controlMessage, 64), spares: make(chan controlMessage, 64), ended: make(chan error, 1),
	}
	go func() {
		for {
			var message controlMessage
			if err := control.ReadJSON(&message); err != nil {
				h.ended <- err
				return
			}
			switch message.Type {
			case "open":
				h.opens <- message
			case "spare":
				h.spares <- message
			}
		}
	}()
	return h
}

func (h *fakeHost) nextOpen() controlMessage {
	h.t.Helper()
	select {
	case open := <-h.opens:
		return open
	case <-time.After(5 * time.Second):
		h.t.Fatal("no open message")
		return controlMessage{}
	}
}

func (h *fakeHost) dialData(open controlMessage) (*websocket.Conn, *http.Response, error) {
	h.t.Helper()
	return dial(h.t, h.base+"/v1/host/data/"+open.Conn+"?ticket="+open.Ticket)
}

func dialPhone(t *testing.T, base, id string) *websocket.Conn {
	t.Helper()
	phone, _, err := dial(t, base+"/v1/connect/"+id)
	if err != nil {
		t.Fatalf("dial phone: %v", err)
	}
	return phone
}

func expectClose(t *testing.T, conn *websocket.Conn, code int) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		_, _, err := conn.ReadMessage()
		if err == nil {
			continue
		}
		var closeErr *websocket.CloseError
		if !errors.As(err, &closeErr) {
			t.Fatalf("expected close %d, got %v", code, err)
		}
		if closeErr.Code != code {
			t.Fatalf("expected close %d, got %d", code, closeErr.Code)
		}
		return
	}
}

func expectBinary(t *testing.T, conn *websocket.Conn, want []byte) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	kind, got, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if kind != websocket.BinaryMessage || !bytes.Equal(got, want) {
		t.Fatalf("got kind %d len %d, want binary len %d", kind, len(got), len(want))
	}
}

func payload(n int, seed byte) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = seed + byte(i)
	}
	return b
}

func TestHostProofVector(t *testing.T) {
	raw, err := os.ReadFile("../../../../contracts/mobile-session/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		ComputerStaticPublicHex string `json:"computer_static_public_hex"`
		HostID                  string `json:"host_id"`
		RelayProof              struct {
			RelayPrivateHex string `json:"relay_private_hex"`
			RelayPublicHex  string `json:"relay_public_hex"`
			NonceHex        string `json:"nonce_hex"`
			ProofHex        string `json:"proof_hex"`
		} `json:"relay_proof"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	decode := func(s string) []byte {
		b, err := hex.DecodeString(s)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	relayPrivate := decode(vectors.RelayProof.RelayPrivateHex)
	relayPublic, _ := curve25519.X25519(relayPrivate, curve25519.Basepoint)
	if !bytes.Equal(relayPublic, decode(vectors.RelayProof.RelayPublicHex)) {
		t.Fatal("relay public key does not match the vector")
	}
	hostKey := decode(vectors.ComputerStaticPublicHex)
	nonce := decode(vectors.RelayProof.NonceHex)
	proof := decode(vectors.RelayProof.ProofHex)
	if !verifyHostProof(relayPrivate, nonce, hostKey, proof) {
		t.Fatal("vector proof rejected")
	}
	proof[0] ^= 1
	if verifyHostProof(relayPrivate, nonce, hostKey, proof) {
		t.Fatal("altered proof accepted")
	}
	if got := hostID(hostKey); got != vectors.HostID {
		t.Fatalf("host ID %s, want %s", got, vectors.HostID)
	}
}

func TestBadProofRejected(t *testing.T) {
	_, base := newTestServer(t, nil)
	for name, hostKey := range map[string][]byte{
		"wrong proof": newHostKey(t),
		"low order":   make([]byte, 32),
	} {
		t.Run(name, func(t *testing.T) {
			control, _, err := dial(t, base+"/v1/host")
			if err != nil {
				t.Fatal(err)
			}
			readJSON(t, control)
			if err := control.WriteJSON(controlMessage{
				Type:    "hello",
				HostKey: base64.RawURLEncoding.EncodeToString(hostKey),
				Proof:   base64.RawURLEncoding.EncodeToString(make([]byte, 32)),
			}); err != nil {
				t.Fatal(err)
			}
			if reply := readJSON(t, control); reply.Type != "error" || reply.Code != "BAD_PROOF" {
				t.Fatalf("expected BAD_PROOF, got %+v", reply)
			}
			expectClose(t, control, websocket.ClosePolicyViolation)
		})
	}
}

func TestHostOffline(t *testing.T) {
	_, base := newTestServer(t, nil)
	expectClose(t, dialPhone(t, base, "00112233445566778899aabbccddeeff"), CloseHostOffline)
}

func TestSpliceForwardsBothWays(t *testing.T) {
	_, base := newTestServer(t, nil)
	h := connectHost(t, base, newHostKey(t))
	phone := dialPhone(t, base, h.id)

	early := [][]byte{payload(100, 1), payload(65000, 2)}
	for _, m := range early {
		if err := phone.WriteMessage(websocket.BinaryMessage, m); err != nil {
			t.Fatal(err)
		}
	}
	open := h.nextOpen()
	// Give the Relay time to take the early messages into its hold.
	time.Sleep(100 * time.Millisecond)
	data, _, err := h.dialData(open)
	if err != nil {
		t.Fatalf("dial data: %v", err)
	}
	for _, m := range early {
		expectBinary(t, data, m)
	}

	big := payload(65000, 3)
	if err := data.WriteMessage(websocket.BinaryMessage, big); err != nil {
		t.Fatal(err)
	}
	expectBinary(t, phone, big)
	small := payload(10, 4)
	if err := phone.WriteMessage(websocket.BinaryMessage, small); err != nil {
		t.Fatal(err)
	}
	expectBinary(t, data, small)

	if err := phone.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "")); err != nil {
		t.Fatal(err)
	}
	expectClose(t, data, websocket.CloseNormalClosure)
}

func TestTextMessageEndsSplice(t *testing.T) {
	_, base := newTestServer(t, nil)
	h := connectHost(t, base, newHostKey(t))
	phone := dialPhone(t, base, h.id)
	data, _, err := h.dialData(h.nextOpen())
	if err != nil {
		t.Fatal(err)
	}
	if err := data.WriteMessage(websocket.TextMessage, []byte("{}")); err != nil {
		t.Fatal(err)
	}
	expectClose(t, phone, websocket.CloseProtocolError)
}

func TestHostSilent(t *testing.T) {
	_, base := newTestServer(t, func(s *Server) { s.openTimeout = 200 * time.Millisecond })
	h := connectHost(t, base, newHostKey(t))
	phone := dialPhone(t, base, h.id)
	open := h.nextOpen()
	expectClose(t, phone, CloseHostSilent)
	_, response, err := h.dialData(open)
	if err == nil || response == nil || response.StatusCode != http.StatusNotFound {
		t.Fatalf("expired ticket: expected 404, got %v %v", response, err)
	}
}

func TestTicketIsSingleUse(t *testing.T) {
	_, base := newTestServer(t, nil)
	h := connectHost(t, base, newHostKey(t))
	dialPhone(t, base, h.id)
	open := h.nextOpen()

	wrong := open
	wrong.Ticket = base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	if _, response, err := h.dialData(wrong); err == nil || response.StatusCode != http.StatusNotFound {
		t.Fatalf("wrong ticket: expected 404, got %v", err)
	}
	if _, _, err := h.dialData(open); err != nil {
		t.Fatalf("first use: %v", err)
	}
	if _, response, err := h.dialData(open); err == nil || response.StatusCode != http.StatusNotFound {
		t.Fatalf("reuse: expected 404, got %v", err)
	}
}

func TestNewerHostLinkReplacesOlder(t *testing.T) {
	_, base := newTestServer(t, nil)
	key := newHostKey(t)
	older := connectHost(t, base, key)
	newer := connectHost(t, base, key)
	select {
	case <-older.ended:
	case <-time.After(5 * time.Second):
		t.Fatal("older control link stayed open")
	}
	dialPhone(t, base, newer.id)
	newer.nextOpen()
}

func TestOversizeMessage(t *testing.T) {
	_, base := newTestServer(t, nil)
	h := connectHost(t, base, newHostKey(t))

	t.Run("spliced", func(t *testing.T) {
		phone := dialPhone(t, base, h.id)
		data, _, err := h.dialData(h.nextOpen())
		if err != nil {
			t.Fatal(err)
		}
		if err := phone.WriteMessage(websocket.BinaryMessage, payload(MaxMessageBytes+1, 5)); err != nil {
			t.Fatal(err)
		}
		expectClose(t, phone, CloseTooLarge)
		expectClose(t, data, CloseTooLarge)
	})

	t.Run("held before splice", func(t *testing.T) {
		phone := dialPhone(t, base, h.id)
		h.nextOpen()
		for range 4 {
			if err := phone.WriteMessage(websocket.BinaryMessage, payload(MaxMessageBytes, 6)); err != nil {
				t.Fatal(err)
			}
		}
		expectClose(t, phone, CloseTooLarge)
	})
}

func TestDialRateLimits(t *testing.T) {
	_, base := newTestServer(t, nil)
	for range PhoneDialsPerMinute {
		expectClose(t, dialPhone(t, base, "absent"), CloseHostOffline)
	}
	if _, response, err := dial(t, base+"/v1/connect/absent"); err == nil || response.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("phone dial over limit: expected 429, got %v", err)
	}
	for range HostDialsPerMinute {
		if _, _, err := dial(t, base+"/v1/host"); err != nil {
			t.Fatal(err)
		}
	}
	if _, response, err := dial(t, base+"/v1/host"); err == nil || response.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("host dial over limit: expected 429, got %v", err)
	}
}

func TestPhoneLinksPerHost(t *testing.T) {
	_, base := newTestServer(t, nil)
	h := connectHost(t, base, newHostKey(t))
	for range MaxLinksPerHost {
		dialPhone(t, base, h.id)
		h.nextOpen()
	}
	expectClose(t, dialPhone(t, base, h.id), CloseRateLimited)
}

func TestSilentHostGoesOffline(t *testing.T) {
	_, base := newTestServer(t, func(s *Server) {
		s.pingInterval = 50 * time.Millisecond
		s.silenceTimeout = 200 * time.Millisecond
		s.closeGrace = 50 * time.Millisecond
	})
	key := newHostKey(t)
	h := connectHost(t, base, key)
	// A host that answers pings stays online past the silence timeout.
	time.Sleep(400 * time.Millisecond)
	dialPhone(t, base, h.id)
	h.nextOpen()

	// A control link whose client never reads sends no pongs.
	public, _ := curve25519.X25519(key, curve25519.Basepoint)
	quiet, _, err := dial(t, base+"/v1/host")
	if err != nil {
		t.Fatal(err)
	}
	challenge := readJSON(t, quiet)
	relayKey, _ := base64.RawURLEncoding.DecodeString(challenge.RelayKey)
	nonce, _ := base64.RawURLEncoding.DecodeString(challenge.Nonce)
	if err := quiet.WriteJSON(controlMessage{
		Type:    "hello",
		HostKey: base64.RawURLEncoding.EncodeToString(public),
		Proof:   base64.RawURLEncoding.EncodeToString(gatewayProof(key, relayKey, nonce, public)),
	}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(600 * time.Millisecond)
	expectClose(t, dialPhone(t, base, h.id), CloseHostOffline)
}

func TestClientAddressHonorsTrustedProxies(t *testing.T) {
	trusted := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.RemoteAddr = "10.1.2.3:5000"
	request.Header.Set("X-Forwarded-For", "203.0.113.9, 198.51.100.7, 10.4.5.6")
	if got := clientAddress(request, trusted); got != "198.51.100.7" {
		t.Fatalf("trusted proxy: got %s", got)
	}
	request.RemoteAddr = "192.0.2.1:5000"
	if got := clientAddress(request, trusted); got != "192.0.2.1" {
		t.Fatalf("untrusted peer: got %s", got)
	}
}

func TestSpareDataSocketSplicesAtOnce(t *testing.T) {
	_, base := newTestServer(t, nil)
	h := connectHostWith(t, base, newHostKey(t), true)
	var offer controlMessage
	select {
	case offer = <-h.spares:
	case <-time.After(5 * time.Second):
		t.Fatal("no spare offered")
	}
	spare, _, err := h.dialData(offer)
	if err != nil {
		t.Fatalf("dial spare: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	phone := dialPhone(t, base, h.id)
	if err := phone.WriteMessage(websocket.BinaryMessage, []byte("hello host")); err != nil {
		t.Fatal(err)
	}
	expectBinary(t, spare, []byte("hello host"))
	if err := spare.WriteMessage(websocket.BinaryMessage, []byte("hello phone")); err != nil {
		t.Fatal(err)
	}
	expectBinary(t, phone, []byte("hello phone"))
	select {
	case open := <-h.opens:
		t.Fatalf("phone waited for an open: %+v", open)
	default:
	}
	select {
	case <-h.spares:
	case <-time.After(5 * time.Second):
		t.Fatal("the used spare was not replaced")
	}
}

func TestHostWithoutSparesGetsNone(t *testing.T) {
	_, base := newTestServer(t, nil)
	h := connectHost(t, base, newHostKey(t))
	select {
	case offer := <-h.spares:
		t.Fatalf("offered a spare to a host that did not ask: %+v", offer)
	case <-time.After(200 * time.Millisecond):
	}
}
