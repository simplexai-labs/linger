// Package relay joins a phone's WebSocket to a data WebSocket the computer
// dials on demand and forwards binary messages both ways without reading them.
// All state lives in memory: online hosts, pending connections, and rate-limit
// counters.
package relay

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/curve25519"
)

// Limits and timeouts. docs/mobile.md "Relay protocol" is the contract the
// Mobile Gateway and the Mobile App rely on.
const (
	// MaxMessageBytes caps one forwarded message; the session layer never
	// sends more.
	MaxMessageBytes = 70000
	// MaxPendingBytes caps what a phone may send before its host data socket
	// arrives.
	MaxPendingBytes = 256 * 1024
	// MaxLinksPerHost caps phone links, waiting or spliced, per Host ID.
	MaxLinksPerHost = 16
	// PhoneDialsPerMinute and HostDialsPerMinute are per client address.
	PhoneDialsPerMinute = 30
	HostDialsPerMinute  = 10

	// maxControlBytes caps one message on a host control link; the only
	// message a host sends there is a short hello.
	maxControlBytes = 4096
	writeTimeout    = 10 * time.Second
)

// Close codes the Relay sends. Codes from 4000 are application codes the
// Mobile App interprets.
const (
	CloseHostOffline  = 4404
	CloseHostSilent   = 4408
	CloseRateLimited  = 4429
	CloseTooLarge     = 4413
	closeReplacedHost = websocket.CloseNormalClosure
)

// Options configures a Server.
type Options struct {
	Logger *slog.Logger
	// TrustedProxies lists the networks whose X-Forwarded-For is believed.
	TrustedProxies []netip.Prefix
}

// Server is the Relay's HTTP and WebSocket handler.
type Server struct {
	logger         *slog.Logger
	trustedProxies []netip.Prefix
	phoneDials     *limiter
	hostDials      *limiter
	upgrader       websocket.Upgrader

	// Tests shorten these.
	helloTimeout   time.Duration
	openTimeout    time.Duration
	pingInterval   time.Duration
	silenceTimeout time.Duration
	closeGrace     time.Duration

	mu      sync.Mutex
	hosts   map[string]*host
	links   map[string]int
	pending map[string]*pendingLink
	sockets map[*socket]struct{}
	open    sync.WaitGroup
}

type host struct {
	id      string
	control *socket
	// spares is set when the host's hello offered to hold a spare data
	// socket; spare is the one it holds now, which a phone takes at once
	// instead of waiting for an open and a fresh dial.
	spares bool
	spare  *socket
}

// pendingLink is a phone waiting for its host's data socket.
type pendingLink struct {
	ticket string
	// data hands the host data socket to the waiting phone; it is unbuffered
	// so a hand-off either reaches the phone or sees gone.
	data chan *socket
	gone chan struct{}
}

type controlMessage struct {
	Type     string `json:"type"`
	RelayKey string `json:"relay_key,omitempty"`
	Nonce    string `json:"nonce,omitempty"`
	HostKey  string `json:"host_key,omitempty"`
	Proof    string `json:"proof,omitempty"`
	Conn     string `json:"conn,omitempty"`
	Ticket   string `json:"ticket,omitempty"`
	Code     string `json:"code,omitempty"`
	// Spares in a hello says the host keeps a spare data socket when the
	// Relay offers one; a Relay that does not know it ignores it.
	Spares bool `json:"spares,omitempty"`
}

// New returns a Server with the documented limits.
func New(options Options) *Server {
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Server{
		logger:         logger,
		trustedProxies: options.TrustedProxies,
		phoneDials:     newLimiter(PhoneDialsPerMinute),
		hostDials:      newLimiter(HostDialsPerMinute),
		upgrader: websocket.Upgrader{
			ReadBufferSize:  16 * 1024,
			WriteBufferSize: 16 * 1024,
			// Every byte after the upgrade is either a host proof or an
			// end-to-end encrypted message, so a browser page gains nothing.
			CheckOrigin: func(*http.Request) bool { return true },
		},
		helloTimeout:   10 * time.Second,
		openTimeout:    10 * time.Second,
		pingInterval:   20 * time.Second,
		silenceTimeout: 60 * time.Second,
		closeGrace:     time.Second,
		hosts:          map[string]*host{},
		links:          map[string]int{},
		pending:        map[string]*pendingLink{},
		sockets:        map[*socket]struct{}{},
	}
}

// Handler routes the Relay's endpoints.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("GET /v1/host", s.handleHost)
	mux.HandleFunc("GET /v1/host/data/{conn}", s.handleHostData)
	mux.HandleFunc("GET /v1/connect/{host_id}", s.handleConnect)
	return mux
}

// Shutdown closes every open socket with going away and waits for them to
// finish or for ctx to end. Call it after http.Server.Shutdown, which does not
// track upgraded connections.
func (s *Server) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	sockets := make([]*socket, 0, len(s.sockets))
	for k := range s.sockets {
		sockets = append(sockets, k)
	}
	s.mu.Unlock()
	for _, k := range sockets {
		k.close(websocket.CloseGoingAway)
	}
	done := make(chan struct{})
	go func() {
		s.open.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Server) track(k *socket) {
	s.mu.Lock()
	s.sockets[k] = struct{}{}
	s.open.Add(1)
	s.mu.Unlock()
}

func (s *Server) untrack(k *socket) {
	s.mu.Lock()
	delete(s.sockets, k)
	s.mu.Unlock()
	s.open.Done()
}

func (s *Server) accept(w http.ResponseWriter, r *http.Request, limit int) *socket {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return nil
	}
	return s.newSocket(conn, limit)
}

func (s *Server) rateLimited(w http.ResponseWriter, r *http.Request, dials *limiter, route string) bool {
	if dials.allow(clientAddress(r, s.trustedProxies), time.Now()) {
		return false
	}
	s.logger.Warn("relay.rate_limited", "route", route)
	http.Error(w, "rate limited", http.StatusTooManyRequests)
	return true
}

// handleHost runs one host control link: challenge, proof, then announcing
// phones until the link ends.
func (s *Server) handleHost(w http.ResponseWriter, r *http.Request) {
	if s.rateLimited(w, r, s.hostDials, "host") {
		return
	}
	control := s.accept(w, r, maxControlBytes)
	if control == nil {
		return
	}
	// A fresh relay key per link means a proof recorded on one link is
	// worthless on any other.
	relayPrivate := randomBytes(curve25519.ScalarSize)
	relayPublic, err := curve25519.X25519(relayPrivate, curve25519.Basepoint)
	if err != nil {
		control.close(websocket.CloseInternalServerErr)
		return
	}
	nonce := randomBytes(24)
	if err := control.writeJSON(controlMessage{
		Type:     "challenge",
		RelayKey: base64.RawURLEncoding.EncodeToString(relayPublic),
		Nonce:    base64.RawURLEncoding.EncodeToString(nonce),
	}); err != nil {
		control.close(websocket.CloseGoingAway)
		return
	}

	timer := time.NewTimer(s.helloTimeout)
	defer timer.Stop()
	var hello controlMessage
	select {
	case m, ok := <-control.messages:
		if !ok {
			return
		}
		_ = json.Unmarshal(m.data, &hello)
	case <-timer.C:
	}
	hostKey, keyErr := base64.RawURLEncoding.DecodeString(hello.HostKey)
	proof, proofErr := base64.RawURLEncoding.DecodeString(hello.Proof)
	if hello.Type != "hello" || keyErr != nil || proofErr != nil ||
		!verifyHostProof(relayPrivate, nonce, hostKey, proof) {
		s.logger.Warn("relay.host_rejected", "reason", "bad_proof")
		_ = control.writeJSON(controlMessage{Type: "error", Code: "BAD_PROOF"})
		control.close(websocket.ClosePolicyViolation)
		return
	}

	h := &host{id: hostID(hostKey), control: control, spares: hello.Spares}
	s.mu.Lock()
	previous := s.hosts[h.id]
	s.hosts[h.id] = h
	s.mu.Unlock()
	if previous != nil {
		previous.control.close(closeReplacedHost)
	}
	if err := control.writeJSON(controlMessage{Type: "ready"}); err != nil {
		control.close(websocket.CloseGoingAway)
	}
	s.logger.Info("relay.host_online", "host_id", h.id, "replaced", previous != nil, "spares", h.spares)
	if h.spares {
		go s.offerSpare(h)
	}

	// The host sends nothing after its hello; reading keeps pings, pongs and
	// the close handshake moving.
	for range control.messages {
	}
	s.mu.Lock()
	if s.hosts[h.id] == h {
		delete(s.hosts, h.id)
	}
	spare := h.spare
	h.spare = nil
	s.mu.Unlock()
	if spare != nil {
		spare.close(websocket.CloseGoingAway)
	}
	s.logger.Info("relay.host_offline", "host_id", h.id)
}

// offerSpare asks a host that offered spares to dial one more data socket
// and holds it for the next phone. It is offered again when that phone takes
// it or when it dies, so a host keeps at most one.
func (s *Server) offerSpare(h *host) {
	connID := hex.EncodeToString(randomBytes(16))
	link := &pendingLink{
		ticket: base64.RawURLEncoding.EncodeToString(randomBytes(32)),
		data:   make(chan *socket),
		gone:   make(chan struct{}),
	}
	s.mu.Lock()
	if s.hosts[h.id] != h || h.spare != nil {
		s.mu.Unlock()
		return
	}
	s.pending[connID] = link
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.pending, connID)
		s.mu.Unlock()
		close(link.gone)
	}()
	if err := h.control.writeJSON(controlMessage{Type: "spare", Conn: connID, Ticket: link.ticket}); err != nil {
		return
	}
	timer := time.NewTimer(s.openTimeout)
	defer timer.Stop()
	var data *socket
	select {
	case data = <-link.data:
	case <-timer.C:
		// A host that was slow once may be quick later: ask again, slowly.
		go s.offerSpareAfter(h, spareRetryDelay)
		return
	case <-h.control.closing:
		return
	}
	s.mu.Lock()
	if s.hosts[h.id] != h || h.spare != nil {
		s.mu.Unlock()
		data.close(websocket.CloseGoingAway)
		return
	}
	h.spare = data
	s.mu.Unlock()
	go s.watchSpare(h, data)
}

// watchSpare offers a new spare when an unused one dies.
func (s *Server) watchSpare(h *host, data *socket) {
	<-data.closing
	s.mu.Lock()
	unused := h.spare == data
	if unused {
		h.spare = nil
	}
	s.mu.Unlock()
	if unused {
		s.offerSpareAfter(h, time.Second)
	}
}

// spareRetryDelay spaces the offers to a host that let one time out.
const spareRetryDelay = 30 * time.Second

func (s *Server) offerSpareAfter(h *host, delay time.Duration) {
	select {
	case <-time.After(delay):
		s.offerSpare(h)
	case <-h.control.closing:
	}
}

// handleHostData accepts the data socket a host dials for one announced phone.
// The match happens before the upgrade so an unknown or used ticket costs no
// WebSocket.
func (s *Server) handleHostData(w http.ResponseWriter, r *http.Request) {
	connID := r.PathValue("conn")
	ticket := r.URL.Query().Get("ticket")
	s.mu.Lock()
	link := s.pending[connID]
	if link == nil || subtle.ConstantTimeCompare([]byte(ticket), []byte(link.ticket)) != 1 {
		s.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	delete(s.pending, connID)
	s.mu.Unlock()

	data := s.accept(w, r, MaxMessageBytes)
	if data == nil {
		return
	}
	select {
	case link.data <- data:
	case <-link.gone:
		data.close(websocket.CloseGoingAway)
	}
}

// handleConnect runs one phone link from dial to the end of its splice.
func (s *Server) handleConnect(w http.ResponseWriter, r *http.Request) {
	if s.rateLimited(w, r, s.phoneDials, "connect") {
		return
	}
	id := r.PathValue("host_id")
	phone := s.accept(w, r, MaxMessageBytes)
	if phone == nil {
		return
	}

	connID := hex.EncodeToString(randomBytes(16))
	link := &pendingLink{
		ticket: base64.RawURLEncoding.EncodeToString(randomBytes(32)),
		data:   make(chan *socket),
		gone:   make(chan struct{}),
	}
	s.mu.Lock()
	h := s.hosts[id]
	switch {
	case h == nil:
		s.mu.Unlock()
		phone.close(CloseHostOffline)
		return
	case s.links[id] >= MaxLinksPerHost:
		s.mu.Unlock()
		s.logger.Warn("relay.phone_rejected", "host_id", id, "reason", "link_limit")
		phone.close(CloseRateLimited)
		return
	}
	s.links[id]++
	spare := h.spare
	h.spare = nil
	if spare == nil {
		s.pending[connID] = link
	}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.pending, connID)
		if s.links[id]--; s.links[id] <= 0 {
			delete(s.links, id)
		}
		s.mu.Unlock()
	}()

	if spare != nil {
		close(link.gone)
		go s.offerSpare(h)
		s.splice(id, connID, phone, spare, nil)
		return
	}
	data, held := s.awaitData(h, phone, connID, link)
	close(link.gone)
	if data == nil {
		return
	}
	s.splice(id, connID, phone, data, held)
}

// awaitData announces the phone to its host and holds the phone's early
// messages until the host's data socket arrives.
func (s *Server) awaitData(h *host, phone *socket, connID string, link *pendingLink) (*socket, [][]byte) {
	if err := h.control.writeJSON(controlMessage{Type: "open", Conn: connID, Ticket: link.ticket}); err != nil {
		phone.close(CloseHostSilent)
		return nil, nil
	}
	timer := time.NewTimer(s.openTimeout)
	defer timer.Stop()
	held := [][]byte{}
	heldBytes := 0
	for {
		select {
		case data := <-link.data:
			return data, held
		case m, ok := <-phone.messages:
			if !ok {
				return nil, nil
			}
			if m.kind != websocket.BinaryMessage {
				phone.close(websocket.CloseProtocolError)
				return nil, nil
			}
			heldBytes += len(m.data)
			if heldBytes > MaxPendingBytes {
				phone.close(CloseTooLarge)
				return nil, nil
			}
			held = append(held, m.data)
		case <-timer.C:
			s.logger.Info("relay.host_silent", "host_id", h.id, "conn", connID)
			phone.close(CloseHostSilent)
			return nil, nil
		}
	}
}

func (s *Server) splice(hostID, connID string, phone, data *socket, held [][]byte) {
	started := time.Now()
	s.logger.Info("relay.splice_opened", "host_id", hostID, "conn", connID)
	var toHost int64
	for _, message := range held {
		if err := data.writeBinary(message); err != nil {
			phone.close(websocket.CloseGoingAway)
			data.close(websocket.CloseGoingAway)
			break
		}
		toHost += int64(len(message))
	}
	var toPhone atomic.Int64
	done := make(chan struct{})
	go func() {
		defer close(done)
		toPhone.Store(forward(data, phone))
	}()
	toHost += forward(phone, data)
	<-done
	s.logger.Info("relay.splice_closed",
		"host_id", hostID,
		"conn", connID,
		"bytes_to_host", toHost,
		"bytes_to_phone", toPhone.Load(),
		"phone_close_code", int(phone.closeCode.Load()),
		"host_close_code", int(data.closeCode.Load()),
		"duration_ms", time.Since(started).Milliseconds(),
	)
}

// forward copies binary messages from src to dst until src starts closing or
// ends, then closes dst with the code src closed with, and returns the bytes
// copied. Watching src.closing passes the code on without waiting for src's
// peer to finish the close handshake; src's reader discards from then on.
func forward(src, dst *socket) int64 {
	var copied int64
	for {
		select {
		case <-src.closing:
			dst.close(src.endCode())
			return copied
		case m, ok := <-src.messages:
			if !ok {
				dst.close(src.endCode())
				return copied
			}
			if m.kind != websocket.BinaryMessage {
				src.close(websocket.CloseProtocolError)
				continue
			}
			if err := dst.writeBinary(m.data); err != nil {
				src.close(websocket.CloseGoingAway)
				continue
			}
			copied += int64(len(m.data))
		}
	}
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b
}
