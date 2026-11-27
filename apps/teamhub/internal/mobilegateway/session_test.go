package mobilegateway

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/flynn/noise"
)

// pipeWire is an in-memory wire: one end is the Gateway, the other the test
// phone.
type pipeWire struct {
	in     chan []byte
	out    chan []byte
	closed chan struct{}
	code   chan int
}

func newPipe() (*pipeWire, *pipeWire) {
	ab, ba := make(chan []byte, 64), make(chan []byte, 64)
	closed := make(chan struct{})
	code := make(chan int, 2)
	return &pipeWire{in: ab, out: ba, closed: closed, code: code}, &pipeWire{in: ba, out: ab, closed: closed, code: code}
}

func (p *pipeWire) Read(ctx context.Context) ([]byte, error) {
	// A real WebSocket delivers queued messages before its close frame, so a
	// message already sent wins over a close that follows it.
	select {
	case m := <-p.in:
		return m, nil
	default:
	}
	select {
	case m := <-p.in:
		return m, nil
	case <-p.closed:
		return nil, io.EOF
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (p *pipeWire) Write(ctx context.Context, m []byte) error {
	select {
	case p.out <- append([]byte(nil), m...):
		return nil
	case <-p.closed:
		return io.EOF
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (p *pipeWire) Close(code int, _ string) {
	select {
	case p.code <- code:
	default:
	}
	select {
	case <-p.closed:
	default:
		close(p.closed)
	}
}

type fakePhones struct {
	known   map[string]Phone
	invites map[string]bool
	// pending makes Pair record phones that wait for approval.
	pending bool
}

func (f *fakePhones) Resume(_ context.Context, key []byte) (Phone, error) {
	phone, ok := f.known[string(key)]
	if !ok {
		return Phone{}, ErrUnknownPhone
	}
	return phone, nil
}

func (f *fakePhones) Pair(_ context.Context, request PairRequest) (Phone, error) {
	if !f.invites[request.Invite] {
		return Phone{}, ErrInviteInvalid
	}
	delete(f.invites, request.Invite)
	phone := Phone{ID: "phone_1", SessionDigest: []byte("digest-1")}
	if f.pending {
		phone = Phone{ID: "phone_1", Pending: true, ConfirmationCode: "042137"}
	}
	f.known[string(request.PublicKey)] = phone
	return phone, nil
}

type testPhone struct {
	t      *testing.T
	wire   *pipeWire
	send   *noise.CipherState
	recv   *noise.CipherState
	hello  welcomePayload
	frames chan frame
}

func dialPhone(t *testing.T, w *pipeWire, computer []byte, static noise.DHKey, hello helloPayload) *testPhone {
	t.Helper()
	state, err := noise.NewHandshakeState(noise.Config{
		CipherSuite: cipherSuite, Pattern: noise.HandshakeXK, Initiator: true,
		Prologue: prologue(computer), StaticKeypair: static, PeerStatic: computer,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	first, _, _, err := state.WriteMessage(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Write(ctx, first); err != nil {
		t.Fatal(err)
	}
	second, err := w.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := state.ReadMessage(nil, second); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(hello)
	third, send, recv, err := state.WriteMessage(nil, payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Write(ctx, third); err != nil {
		t.Fatal(err)
	}
	welcomeCiphertext, err := w.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	welcome, err := recv.Decrypt(nil, nil, welcomeCiphertext)
	if err != nil {
		t.Fatal(err)
	}
	p := &testPhone{t: t, wire: w, send: send, recv: recv, frames: make(chan frame, 256)}
	if err := json.Unmarshal(welcome, &p.hello); err != nil {
		t.Fatal(err)
	}
	go func() {
		defer close(p.frames)
		for {
			message, err := w.Read(context.Background())
			if err != nil {
				return
			}
			plain, err := p.recv.Decrypt(nil, nil, message)
			if err != nil {
				return
			}
			f, err := decodeFrame(plain)
			if err != nil {
				return
			}
			p.frames <- f
		}
	}()
	return p
}

func (p *testPhone) write(kind frameType, stream uint32, payload []byte) {
	p.t.Helper()
	encoded, err := encodeFrame(kind, stream, payload)
	if err != nil {
		p.t.Fatal(err)
	}
	ciphertext, err := p.send.Encrypt(nil, nil, encoded)
	if err != nil {
		p.t.Fatal(err)
	}
	if err := p.wire.Write(context.Background(), ciphertext); err != nil {
		p.t.Fatal(err)
	}
}

func (p *testPhone) next() frame {
	p.t.Helper()
	select {
	case f, ok := <-p.frames:
		if !ok {
			p.t.Fatal("session closed")
		}
		return f
	case <-time.After(5 * time.Second):
		p.t.Fatal("timed out waiting for a frame")
	}
	return frame{}
}

// response reads one stream's response head and body until end.
func (p *testPhone) response(stream uint32) (responseHead, string) {
	p.t.Helper()
	var head responseHead
	var body bytes.Buffer
	for {
		f := p.next()
		if f.stream != stream {
			continue
		}
		switch f.kind {
		case frameResponse:
			if err := json.Unmarshal(f.payload, &head); err != nil {
				p.t.Fatal(err)
			}
		case frameData:
			body.Write(f.payload)
		case frameEnd:
			return head, body.String()
		case frameReset:
			p.t.Fatalf("stream %d reset: %s", stream, f.payload)
		}
	}
}

func newTestGateway(t *testing.T, handler http.Handler, phones Phones) *Gateway {
	t.Helper()
	secret := make([]byte, 32)
	_, _ = rand.Read(secret)
	key, err := NewStaticKey(secret)
	if err != nil {
		t.Fatal(err)
	}
	return New(Config{Key: key, ComputerName: "Studio Mac"}, handler, phones, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func startSession(t *testing.T, g *Gateway, hello helloPayload, static noise.DHKey) (*testPhone, *pipeWire) {
	t.Helper()
	gatewayEnd, phoneEnd := newPipe()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go g.serve(ctx, gatewayEnd, "test")
	return dialPhone(t, phoneEnd, g.PublicKey(), static, hello), phoneEnd
}

func phoneKey(t *testing.T) noise.DHKey {
	t.Helper()
	key, err := noise.DH25519.GenerateKeypair(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func TestPairThenResumeCarriesTheDeviceSession(t *testing.T) {
	var seen []string
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		digest, ok := PhoneSession(r.Context())
		seen = append(seen, string(digest))
		if !ok || r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			t.Errorf("request identity: ok=%v cookie=%q auth=%q", ok, r.Header.Get("Cookie"), r.Header.Get("Authorization"))
		}
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("got:" + string(body)))
	})
	phones := &fakePhones{known: map[string]Phone{}, invites: map[string]bool{"invite-1": true}}
	g := newTestGateway(t, handler, phones)
	static := phoneKey(t)

	phone, _ := startSession(t, g, helloPayload{Type: "pair", Invite: "invite-1", Name: "Pixel", Platform: "android"}, static)
	if phone.hello.Type != "welcome" || phone.hello.PhoneID != "phone_1" || phone.hello.Name != "Studio Mac" {
		t.Fatalf("welcome = %+v", phone.hello)
	}
	head, _ := json.Marshal(requestHead{Method: "POST", Path: "/v0/rooms/r1/messages", Headers: map[string][]string{
		"Cookie": {"teamhub_session=stolen"}, "Authorization": {"Bearer x"}, "Content-Type": {"application/json"},
	}})
	phone.write(frameRequest, 1, head)
	phone.write(frameData, 1, []byte(`{"text":"hi"}`))
	phone.write(frameEnd, 1, nil)
	response, body := phone.response(1)
	if response.Status != 200 || body != `got:{"text":"hi"}` {
		t.Fatalf("response = %+v %q", response, body)
	}

	// The invite is spent; a second phone with it is refused with a code.
	refused, _ := startSession(t, g, helloPayload{Type: "pair", Invite: "invite-1"}, phoneKey(t))
	if refused.hello.Type != "error" || refused.hello.Code != "INVITE_INVALID" {
		t.Fatalf("second pair = %+v", refused.hello)
	}
	// The paired phone resumes with its key alone.
	resumed, _ := startSession(t, g, helloPayload{Type: "resume"}, static)
	if resumed.hello.Type != "welcome" || resumed.hello.PhoneID != "phone_1" {
		t.Fatalf("resume = %+v", resumed.hello)
	}
	// An unknown key cannot resume.
	stranger, _ := startSession(t, g, helloPayload{Type: "resume"}, phoneKey(t))
	if stranger.hello.Code != "PHONE_UNKNOWN" {
		t.Fatalf("stranger = %+v", stranger.hello)
	}
	if len(seen) != 1 || seen[0] != "digest-1" {
		t.Fatalf("handler saw %q", seen)
	}
}

func TestRoutesOutsideTheMobileAPIAreUnreachable(t *testing.T) {
	reached := false
	g := newTestGateway(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = true }),
		&fakePhones{known: map[string]Phone{}, invites: map[string]bool{"i": true}})
	phone, _ := startSession(t, g, helloPayload{Type: "pair", Invite: "i"}, phoneKey(t))
	for i, path := range []string{"/v0/auth/login", "/v0/account/password", "/v0/local/identity", "/api/agent/v1/x", "/internal/v1/voice/provider-keys", "/v0/agent-runtime/x"} {
		stream := uint32(2*i + 1)
		head, _ := json.Marshal(requestHead{Method: "POST", Path: path})
		phone.write(frameRequest, stream, head)
		phone.write(frameEnd, stream, nil)
		response, body := phone.response(stream)
		if response.Status != http.StatusNotFound || !strings.Contains(body, "NOT_AVAILABLE_ON_MOBILE") {
			t.Fatalf("%s: %+v %s", path, response, body)
		}
	}
	if reached {
		t.Fatal("a route outside the allowlist reached TeamHub")
	}
}

func TestStreamingResponsesArriveBeforeTheHandlerReturns(t *testing.T) {
	release := make(chan struct{})
	g := newTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("event: one\n\n"))
		w.(http.Flusher).Flush()
		<-release
	}), &fakePhones{known: map[string]Phone{}, invites: map[string]bool{"i": true}})
	phone, _ := startSession(t, g, helloPayload{Type: "pair", Invite: "i"}, phoneKey(t))
	head, _ := json.Marshal(requestHead{Method: "GET", Path: "/v0/events"})
	phone.write(frameRequest, 1, head)
	phone.write(frameEnd, 1, nil)
	if f := phone.next(); f.kind != frameResponse {
		t.Fatalf("first frame %v", f.kind)
	}
	if f := phone.next(); f.kind != frameData || string(f.payload) != "event: one\n\n" {
		t.Fatalf("second frame %v %q", f.kind, f.payload)
	}
	close(release)
	if f := phone.next(); f.kind != frameEnd {
		t.Fatalf("third frame %v", f.kind)
	}
}

func TestLargeUploadsFlowWithinTheWindow(t *testing.T) {
	var received int
	g := newTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, _ := io.Copy(io.Discard, r.Body)
		received = int(n)
		w.WriteHeader(http.StatusNoContent)
	}), &fakePhones{known: map[string]Phone{}, invites: map[string]bool{"i": true}})
	phone, _ := startSession(t, g, helloPayload{Type: "pair", Invite: "i"}, phoneKey(t))
	head, _ := json.Marshal(requestHead{Method: "POST", Path: "/v0/rooms/r/message-attachment-uploads"})
	phone.write(frameRequest, 1, head)
	window := streamWindow
	chunk := bytes.Repeat([]byte{7}, dataChunk)
	total := 2 * 1024 * 1024
	sent := 0
	var pending []frame
	for sent < total {
		for window < len(chunk) {
			f := phone.next()
			if f.kind == frameWindow && f.stream == 1 {
				window += int(binary.BigEndian.Uint32(f.payload))
			} else {
				pending = append(pending, f)
			}
		}
		phone.write(frameData, 1, chunk)
		window -= len(chunk)
		sent += len(chunk)
	}
	phone.write(frameEnd, 1, nil)
	for {
		f := phone.next()
		if f.kind == frameEnd {
			break
		}
	}
	_ = pending
	if received != sent {
		t.Fatalf("received %d of %d", received, sent)
	}
}

func TestOverrunningTheWindowClosesTheSession(t *testing.T) {
	block := make(chan struct{})
	t.Cleanup(func() { close(block) })
	g := newTestGateway(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-block }),
		&fakePhones{known: map[string]Phone{}, invites: map[string]bool{"i": true}})
	phone, phoneEnd := startSession(t, g, helloPayload{Type: "pair", Invite: "i"}, phoneKey(t))
	head, _ := json.Marshal(requestHead{Method: "POST", Path: "/v0/rooms/r/message-attachment-uploads"})
	phone.write(frameRequest, 1, head)
	chunk := bytes.Repeat([]byte{1}, dataChunk)
	for range streamWindow/dataChunk + 2 {
		encoded, _ := encodeFrame(frameData, 1, chunk)
		ciphertext, _ := phone.send.Encrypt(nil, nil, encoded)
		if err := phoneEnd.Write(context.Background(), ciphertext); err != nil {
			break
		}
	}
	select {
	case <-phoneEnd.closed:
	case <-time.After(5 * time.Second):
		t.Fatal("session stayed open after the window was exceeded")
	}
}

func TestAPendingPhoneCanDoNothingUntilApproved(t *testing.T) {
	var reached int
	g := newTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached++
		digest, _ := PhoneSession(r.Context())
		_, _ = w.Write(digest)
	}), &fakePhones{known: map[string]Phone{}, invites: map[string]bool{"i": true}, pending: true})
	phone, _ := startSession(t, g, helloPayload{Type: "pair", Invite: "i", Name: "Pixel", Platform: "android"}, phoneKey(t))
	if phone.hello.Type != "pending" || phone.hello.Code != "042137" {
		t.Fatalf("welcome = %+v", phone.hello)
	}
	head, _ := json.Marshal(requestHead{Method: "GET", Path: "/v0/me"})
	phone.write(frameRequest, 1, head)
	phone.write(frameEnd, 1, nil)
	if f := phone.next(); f.kind != frameReset || !strings.Contains(string(f.payload), "PAIRING_PENDING") {
		t.Fatalf("pending request answered %v %s", f.kind, f.payload)
	}
	g.Approve("phone_1", []byte("approved-digest"))
	if f := phone.next(); f.kind != frameControl || !strings.Contains(string(f.payload), "approved") {
		t.Fatalf("approval frame %v %s", f.kind, f.payload)
	}
	phone.write(frameRequest, 3, head)
	phone.write(frameEnd, 3, nil)
	if _, body := phone.response(3); body != "approved-digest" || reached != 1 {
		t.Fatalf("after approval body=%q reached=%d", body, reached)
	}
}

func TestPairingIsRateLimited(t *testing.T) {
	g := newTestGateway(t, http.NotFoundHandler(), &fakePhones{known: map[string]Phone{}, invites: map[string]bool{}})
	codes := map[string]int{}
	for range pairingPerMinute + 2 {
		phone, _ := startSession(t, g, helloPayload{Type: "pair", Invite: "nope", Platform: "ios"}, phoneKey(t))
		codes[phone.hello.Code]++
	}
	if codes["INVITE_INVALID"] != pairingPerMinute || codes["RATE_LIMITED"] != 2 {
		t.Fatalf("codes = %v", codes)
	}
}

func TestAHandshakeForAnotherComputerFails(t *testing.T) {
	g := newTestGateway(t, http.NotFoundHandler(), &fakePhones{known: map[string]Phone{}, invites: map[string]bool{}})
	other := newTestGateway(t, http.NotFoundHandler(), &fakePhones{})
	gatewayEnd, phoneEnd := newPipe()
	go g.serve(context.Background(), gatewayEnd, "test")
	state, _ := noise.NewHandshakeState(noise.Config{
		CipherSuite: cipherSuite, Pattern: noise.HandshakeXK, Initiator: true,
		Prologue: prologue(other.PublicKey()), StaticKeypair: phoneKey(t), PeerStatic: other.PublicKey(),
	})
	first, _, _, _ := state.WriteMessage(nil, nil)
	_ = phoneEnd.Write(context.Background(), first)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := phoneEnd.Read(ctx); !errors.Is(err, io.EOF) {
		t.Fatalf("read after a wrong-key handshake = %v, want the socket closed", err)
	}
}
