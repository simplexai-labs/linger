package mobilegateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"time"

	"github.com/flynn/noise"
)

// wire is one WebSocket carrying a session: a LAN socket or a Relay data
// socket. Every message is binary.
type wire interface {
	Read(ctx context.Context) ([]byte, error)
	Write(ctx context.Context, message []byte) error
	Close(code int, reason string)
}

const (
	handshakeTimeout = 10 * time.Second
	writeTimeout     = 30 * time.Second
	sendQueueDepth   = 256
	// idleTimeout closes a session that sent nothing, not even a ping.
	idleTimeout = 90 * time.Second
)

// Close codes a session ends with; docs/mobile.md lists them.
const (
	closeNormal   = 1000
	closeProtocol = 4400
	closeRefused  = 4403
	closeIdle     = 4408
)

type helloPayload struct {
	Type     string `json:"type"`
	Invite   string `json:"invite,omitempty"`
	Name     string `json:"name,omitempty"`
	Platform string `json:"platform,omitempty"`
}

type welcomePayload struct {
	Type    string   `json:"type"`
	PhoneID string   `json:"phone_id,omitempty"`
	Name    string   `json:"name,omitempty"`
	LAN     []string `json:"lan"`
	// Relay is the first node, for phones that know only one.
	Relay  string  `json:"relay,omitempty"`
	Relays []Relay `json:"relays"`
	Code   string  `json:"code,omitempty"`
}

type controlMessage struct {
	Type string `json:"type"`
	Code string `json:"code,omitempty"`
}

// session is one authenticated phone connection.
type session struct {
	gateway *Gateway
	phone   Phone
	wire    wire
	recv    *noise.CipherState
	send    *noise.CipherState
	logger  *slog.Logger

	ctx    context.Context
	cancel context.CancelCauseFunc
	// out carries request frames; urgent carries socket and control frames,
	// which the writer sends first so a download never delays audio.
	out    chan []byte
	urgent chan []byte

	mu      sync.Mutex
	streams map[uint32]*stream
	closing bool
}

// serve runs the handshake on a fresh socket and then the session until the
// socket closes. It owns the socket.
func (g *Gateway) serve(parent context.Context, w wire, route string) {
	refuse := func(code int, reason string) { w.Close(code, reason) }
	ctx, cancel := context.WithTimeout(parent, handshakeTimeout)
	defer cancel()
	r, err := newResponder(g.key)
	if err != nil {
		g.logger.Error("mobile.handshake_setup_failed", "error", err)
		refuse(closeProtocol, "handshake")
		return
	}
	first, err := w.Read(ctx)
	if err != nil || r.readFirst(first) != nil {
		refuse(closeProtocol, "handshake")
		return
	}
	second, err := r.writeSecond()
	if err != nil || w.Write(ctx, second) != nil {
		refuse(closeProtocol, "handshake")
		return
	}
	third, err := w.Read(ctx)
	if err != nil {
		refuse(closeProtocol, "handshake")
		return
	}
	payload, phoneKey, recv, send, err := r.readThird(third)
	if err != nil {
		refuse(closeProtocol, "handshake")
		return
	}
	var hello helloPayload
	if err := json.Unmarshal(payload, &hello); err != nil {
		hello.Type = ""
	}
	phone, code := g.authenticate(parent, hello, phoneKey)
	relays := g.Relays()
	firstRelay := ""
	if len(relays) > 0 {
		firstRelay = relays[0].URL
	}
	welcome := welcomePayload{Type: "welcome", PhoneID: phone.ID, Name: g.computerName, LAN: g.lanEndpoints(), Relay: firstRelay, Relays: relays}
	switch {
	case code != "":
		welcome = welcomePayload{Type: "error", Code: code, LAN: []string{}}
	case phone.Pending:
		welcome = welcomePayload{Type: "pending", PhoneID: phone.ID, Name: g.computerName, Code: phone.ConfirmationCode, LAN: g.lanEndpoints(), Relay: firstRelay, Relays: relays}
	}
	encoded, err := json.Marshal(welcome)
	if err != nil {
		refuse(closeProtocol, "handshake")
		return
	}
	ciphertext, err := send.Encrypt(nil, nil, encoded)
	if err != nil || w.Write(ctx, ciphertext) != nil || code != "" {
		if code != "" {
			g.logger.Info("mobile.session_refused", "code", code, "route", route)
		}
		refuse(closeRefused, code)
		return
	}
	cancel()
	sessionCtx, sessionCancel := context.WithCancelCause(parent)
	s := &session{
		gateway: g, phone: phone, wire: w, recv: recv, send: send,
		logger: g.logger.With("phone_id", phone.ID, "route", route),
		ctx:    sessionCtx, cancel: sessionCancel,
		out:     make(chan []byte, sendQueueDepth),
		urgent:  make(chan []byte, sendQueueDepth),
		streams: map[uint32]*stream{},
	}
	g.track(s)
	defer g.untrack(s)
	// A removal or approval that landed between admission and track found no
	// session to act on, so the phone's state is read once more.
	latest, err := g.phones.Resume(parent, phoneKey)
	switch {
	case errors.Is(err, ErrPhoneRevoked) || errors.Is(err, ErrUnknownPhone):
		s.wire.Close(closeRefused, "PHONE_REMOVED")
		return
	case err == nil && phone.Pending && !latest.Pending:
		s.approve(latest.SessionDigest)
	}
	s.logger.Info("mobile.session_opened", "pending", phone.Pending)
	s.run()
	s.logger.Info("mobile.session_closed", "reason", context.Cause(sessionCtx))
}

func (g *Gateway) authenticate(ctx context.Context, hello helloPayload, phoneKey []byte) (Phone, string) {
	switch hello.Type {
	case "resume":
		phone, err := g.phones.Resume(ctx, phoneKey)
		return phone, phoneErrorCode(err, g.logger)
	case "pair":
		if !g.pairing.Allow() {
			return Phone{}, "RATE_LIMITED"
		}
		phone, err := g.phones.Pair(ctx, PairRequest{
			PublicKey: phoneKey, Invite: hello.Invite, Name: hello.Name, Platform: hello.Platform,
		})
		return phone, phoneErrorCode(err, g.logger)
	default:
		return Phone{}, "BAD_HELLO"
	}
}

func phoneErrorCode(err error, logger *slog.Logger) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrUnknownPhone):
		return "PHONE_UNKNOWN"
	case errors.Is(err, ErrPhoneRevoked):
		return "PHONE_REMOVED"
	case errors.Is(err, ErrInviteInvalid):
		return "INVITE_INVALID"
	case errors.Is(err, ErrBadPairRequest):
		return "BAD_HELLO"
	case errors.Is(err, ErrPairingExpired):
		return "PAIRING_EXPIRED"
	default:
		logger.Error("mobile.authenticate_failed", "error", err)
		return "UNAVAILABLE"
	}
}

func (s *session) run() {
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.writeLoop()
	}()
	err := s.readLoop()
	s.shutdown(err)
	<-done
	s.wire.Close(closeNormal, "")
}

func (s *session) shutdown(cause error) {
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		return
	}
	s.closing = true
	streams := make([]*stream, 0, len(s.streams))
	for _, st := range s.streams {
		streams = append(streams, st)
	}
	s.mu.Unlock()
	if cause == nil {
		cause = io.EOF
	}
	s.cancel(cause)
	for _, st := range streams {
		st.abort(cause)
	}
}

func (s *session) writeLoop() {
	for {
		var plaintext []byte
		select {
		case plaintext = <-s.urgent:
		default:
			select {
			case <-s.ctx.Done():
				return
			case plaintext = <-s.urgent:
			case plaintext = <-s.out:
			}
		}
		{
			ciphertext, err := s.send.Encrypt(nil, nil, plaintext)
			if err != nil {
				s.shutdown(fmt.Errorf("encrypt: %w", err))
				return
			}
			ctx, cancel := context.WithTimeout(s.ctx, writeTimeout)
			err = s.wire.Write(ctx, ciphertext)
			cancel()
			if err != nil {
				s.shutdown(fmt.Errorf("write: %w", err))
				return
			}
		}
	}
}

func (s *session) readLoop() error {
	for {
		ctx, cancel := context.WithTimeout(s.ctx, idleTimeout)
		ciphertext, err := s.wire.Read(ctx)
		cancel()
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				s.wire.Close(closeIdle, "idle")
			}
			return err
		}
		plaintext, err := s.recv.Decrypt(nil, nil, ciphertext)
		if err != nil {
			return fmt.Errorf("decrypt: %w", err)
		}
		f, err := decodeFrame(plaintext)
		if err != nil {
			return err
		}
		if err := s.handle(f); err != nil {
			return err
		}
	}
}

// emit queues one request frame for the writer. It blocks while the queue is
// full, which is how a fast response waits for a slow socket.
func (s *session) emit(ctx context.Context, kind frameType, streamID uint32, payload []byte) error {
	return s.enqueue(ctx, s.out, kind, streamID, payload)
}

// emitUrgent queues a socket or control frame ahead of request frames.
func (s *session) emitUrgent(ctx context.Context, kind frameType, streamID uint32, payload []byte) error {
	return s.enqueue(ctx, s.urgent, kind, streamID, payload)
}

func (s *session) enqueue(ctx context.Context, queue chan []byte, kind frameType, streamID uint32, payload []byte) error {
	encoded, err := encodeFrame(kind, streamID, payload)
	if err != nil {
		return err
	}
	select {
	case queue <- encoded:
		return nil
	case <-ctx.Done():
		return context.Cause(ctx)
	case <-s.ctx.Done():
		return context.Cause(s.ctx)
	}
}

func (s *session) emitJSON(ctx context.Context, kind frameType, streamID uint32, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return s.emit(ctx, kind, streamID, encoded)
}

func (s *session) handle(f frame) error {
	if f.stream == controlStream {
		if f.kind != frameControl {
			return errMalformedFrame
		}
		var message controlMessage
		if err := json.Unmarshal(f.payload, &message); err != nil {
			return errMalformedFrame
		}
		if message.Type == "ping" {
			go func() { _ = s.emitControl(controlMessage{Type: "pong"}) }()
		}
		return nil
	}
	if s.pending() {
		if f.kind != frameRequest && f.kind != frameSocket {
			return nil
		}
		go func() {
			_ = s.emitJSON(s.ctx, frameReset, f.stream, resetPayload{Code: "PAIRING_PENDING"})
		}()
		return nil
	}
	switch f.kind {
	case frameRequest, frameSocket:
		return s.open(f)
	case frameData, frameText:
		st := s.lookup(f.stream)
		if st == nil {
			return nil // a late frame for a stream that already ended
		}
		return st.deliver(f.kind, f.payload)
	case frameEnd:
		if st := s.lookup(f.stream); st != nil {
			st.finishInput()
		}
		return nil
	case frameReset:
		if st := s.lookup(f.stream); st != nil {
			st.abort(errStreamReset)
		}
		return nil
	default:
		return errMalformedFrame
	}
}

func (s *session) emitControl(message controlMessage) error {
	encoded, err := json.Marshal(message)
	if err != nil {
		return err
	}
	return s.emitUrgent(s.ctx, frameControl, controlStream, encoded)
}

func (s *session) pending() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.phone.Pending
}

// currentPhone returns the phone as approval may have updated it.
func (s *session) currentPhone() Phone {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.phone
}

// approve turns a pending session into a working one.
func (s *session) approve(digest []byte) {
	s.mu.Lock()
	if !s.phone.Pending {
		s.mu.Unlock()
		return
	}
	s.phone.Pending = false
	s.phone.ConfirmationCode = ""
	s.phone.SessionDigest = append([]byte(nil), digest...)
	s.mu.Unlock()
	_ = s.emitControl(controlMessage{Type: "approved"})
}

func (s *session) lookup(id uint32) *stream {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.streams[id]
}

func (s *session) open(f frame) error {
	if f.stream%2 == 0 {
		return errMalformedFrame
	}
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		return nil
	}
	if _, exists := s.streams[f.stream]; exists {
		s.mu.Unlock()
		return errMalformedFrame
	}
	if len(s.streams) >= maxOpenStreams {
		s.mu.Unlock()
		go func() {
			_ = s.emitJSON(s.ctx, frameReset, f.stream, controlMessage{Type: "reset", Code: "TOO_MANY_STREAMS"})
		}()
		return nil
	}
	st := newStream(s, f.stream)
	s.streams[f.stream] = st
	s.mu.Unlock()
	if f.kind == frameRequest {
		go s.dispatchRequest(st, f.payload)
	} else {
		go s.dispatchSocket(st, f.payload)
	}
	return nil
}

func (s *session) release(id uint32) {
	s.mu.Lock()
	delete(s.streams, id)
	s.mu.Unlock()
}
