package mobilegateway

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/curve25519"
)

// relayMaxMessage matches the Relay's per-message limit.
const relayMaxMessage = 70000

// wsWire adapts a gorilla WebSocket to wire.
type wsWire struct {
	conn      *websocket.Conn
	writeMu   sync.Mutex
	closeOnce sync.Once
}

func newWSWire(conn *websocket.Conn) *wsWire {
	conn.SetReadLimit(relayMaxMessage)
	return &wsWire{conn: conn}
}

func (w *wsWire) Read(ctx context.Context) ([]byte, error) {
	if d, ok := ctx.Deadline(); ok {
		_ = w.conn.SetReadDeadline(d)
	} else {
		_ = w.conn.SetReadDeadline(time.Time{})
	}
	stop := context.AfterFunc(ctx, func() { _ = w.conn.SetReadDeadline(time.Now()) })
	defer stop()
	for {
		kind, message, err := w.conn.ReadMessage()
		if err != nil {
			if ctx.Err() != nil {
				return nil, context.Cause(ctx)
			}
			return nil, err
		}
		if kind == websocket.BinaryMessage {
			return message, nil
		}
	}
}

func (w *wsWire) Write(ctx context.Context, message []byte) error {
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	if d, ok := ctx.Deadline(); ok {
		_ = w.conn.SetWriteDeadline(d)
	}
	return w.conn.WriteMessage(websocket.BinaryMessage, message)
}

func (w *wsWire) Close(code int, reason string) {
	w.closeOnce.Do(func() {
		w.writeMu.Lock()
		_ = w.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), deadline(time.Second))
		w.writeMu.Unlock()
		_ = w.conn.Close()
	})
}

var upgrader = websocket.Upgrader{
	ReadBufferSize: 16 * 1024, WriteBufferSize: 16 * 1024,
	// Every byte after the upgrade is a Noise message bound to this
	// computer's key, so a page in a browser gains nothing by connecting.
	CheckOrigin: func(*http.Request) bool { return true },
}

// serveLAN binds the LAN listener and serves it.
func (g *Gateway) serveLAN(ctx context.Context) {
	listener, err := net.Listen("tcp", g.lanAddress)
	if err != nil {
		host, _, splitErr := net.SplitHostPort(g.lanAddress)
		if splitErr != nil {
			g.logger.Error("mobile.lan_listen_failed", "error", err)
			return
		}
		// The preferred port is taken, for example by a second instance;
		// any free port works because pairing codes carry the real one.
		listener, err = net.Listen("tcp", net.JoinHostPort(host, "0"))
		if err != nil {
			g.logger.Error("mobile.lan_listen_failed", "error", err)
			return
		}
	}
	address := listener.Addr().(*net.TCPAddr)
	if address.IP.IsUnspecified() {
		g.setLANPort(address.Port)
	} else {
		// A listener bound to one address is reachable only there.
		g.setLANEndpoints([]string{"ws://" + address.String()})
	}
	port := address.Port
	g.logger.Info("mobile.lan_listening", "port", port)
	g.ServeLAN(ctx, listener)
}

// ServeLAN answers GET /v1/connect/<host_id> on listener until ctx ends.
func (g *Gateway) ServeLAN(ctx context.Context, listener net.Listener) {
	mux := http.NewServeMux()
	limits := newLANLimits()
	mux.HandleFunc("GET /v1/connect/{host}", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("host") != g.HostID() {
			http.NotFound(w, r)
			return
		}
		// Limits apply before the upgrade, so a flood of handshakes costs no
		// WebSocket or key agreement.
		release, ok := limits.admit(r.RemoteAddr)
		if !ok {
			http.Error(w, "too many connections", http.StatusTooManyRequests)
			return
		}
		defer release()
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		g.serve(ctx, newWSWire(conn), "lan")
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	stop := context.AfterFunc(ctx, func() { _ = server.Close() })
	defer stop()
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		g.logger.Error("mobile.lan_serve_failed", "error", err)
	}
}

// lanURLs lists ws:// origins on every private IPv4 address of this machine.
func lanURLs(port int) []string {
	interfaces, err := net.Interfaces()
	if err != nil {
		return []string{}
	}
	urls := []string{}
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, address := range addresses {
			ipNet, ok := address.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipNet.IP.To4()
			if ip == nil || !ip.IsPrivate() {
				continue
			}
			urls = append(urls, "ws://"+net.JoinHostPort(ip.String(), strconv.Itoa(port)))
		}
	}
	return urls
}

type relayMessage struct {
	Type     string `json:"type"`
	RelayKey string `json:"relay_key,omitempty"`
	Nonce    string `json:"nonce,omitempty"`
	HostKey  string `json:"host_key,omitempty"`
	Proof    string `json:"proof,omitempty"`
	Conn     string `json:"conn,omitempty"`
	Ticket   string `json:"ticket,omitempty"`
	Code     string `json:"code,omitempty"`
	// Spares in the hello offers to hold a spare data socket, which a Relay
	// that knows it then requests with "spare" messages.
	Spares bool `json:"spares,omitempty"`
}

// relayProofLabel domain-separates the host proof; the Relay computes the
// same value.
const relayProofLabel = "linger-relay-host/1"

func relayProof(private, relayKey, nonce, hostKey []byte) ([]byte, error) {
	shared, err := curve25519.X25519(private, relayKey)
	if err != nil {
		return nil, err
	}
	mac := hmac.New(sha256.New, shared)
	mac.Write([]byte(relayProofLabel))
	mac.Write(nonce)
	mac.Write(hostKey)
	return mac.Sum(nil), nil
}

// runRelayLink keeps the control link to one Relay node open, redialing with
// jittered backoff, and dials a data socket for every phone it announces.
func (g *Gateway) runRelayLink(ctx context.Context, link *relayLink) {
	attempt := 0
	for ctx.Err() == nil {
		started := time.Now()
		err := g.relayControl(ctx, link)
		link.ready.Store(false)
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) > time.Minute {
			attempt = 0
		}
		ceiling := time.Second << min(attempt, 5)
		wait := ceiling/2 + rand.N(ceiling/2+1) //nolint:gosec // retry jitter needs no secrecy
		attempt++
		g.logger.Warn("mobile.relay_disconnected", "relay", link.url, "error", err, "retry_in", wait.String())
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

func relayEndpoint(base, path string) (string, error) {
	parsed, err := url.Parse(strings.TrimRight(base, "/"))
	if err != nil {
		return "", err
	}
	switch parsed.Scheme {
	case "wss", "ws":
	default:
		return "", fmt.Errorf("relay URL scheme %q is not ws or wss", parsed.Scheme)
	}
	return parsed.String() + path, nil
}

func (g *Gateway) relayControl(ctx context.Context, link *relayLink) error {
	base := link.url
	endpoint, err := relayEndpoint(base, "/v1/host")
	if err != nil {
		return err
	}
	dialer := relayDialer()
	conn, response, err := dialer.DialContext(ctx, endpoint, nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		return err
	}
	defer conn.Close()
	conn.SetReadLimit(4096)
	// Data sockets belong to this control connection: when it ends, spares
	// waiting on it close and no announced phone is still dialed.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	var spareHeld atomic.Bool
	dataSlots := make(chan struct{}, maxRelayDataSockets)
	withSlot := func(run func()) {
		select {
		case dataSlots <- struct{}{}:
		default:
			g.logger.Warn("mobile.relay_data_refused", "relay", base, "reason", "too_many_sockets")
			return
		}
		go func() {
			defer func() { <-dataSlots }()
			run()
		}()
	}
	alive := func() { _ = conn.SetReadDeadline(deadline(60 * time.Second)) }
	alive()
	conn.SetPingHandler(func(data string) error {
		alive()
		return conn.WriteControl(websocket.PongMessage, []byte(data), deadline(5*time.Second))
	})
	var writeMu sync.Mutex
	send := func(message relayMessage) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(deadline(writeTimeout))
		return conn.WriteJSON(message)
	}
	for {
		var message relayMessage
		if err := conn.ReadJSON(&message); err != nil {
			return err
		}
		alive()
		switch message.Type {
		case "challenge":
			relayKey, err1 := base64.RawURLEncoding.DecodeString(message.RelayKey)
			nonce, err2 := base64.RawURLEncoding.DecodeString(message.Nonce)
			if err1 != nil || err2 != nil || len(relayKey) != 32 || len(nonce) < 16 {
				return errors.New("relay sent a malformed challenge")
			}
			proof, err := relayProof(g.key.pair.Private, relayKey, nonce, g.key.pair.Public)
			if err != nil {
				return err
			}
			if err := send(relayMessage{
				Type:    "hello",
				HostKey: base64.RawURLEncoding.EncodeToString(g.key.pair.Public),
				Proof:   base64.RawURLEncoding.EncodeToString(proof),
				Spares:  true,
			}); err != nil {
				return err
			}
		case "ready":
			link.ready.Store(true)
			g.logger.Info("mobile.relay_connected", "relay", base, "host_id", g.HostID())
		case "open":
			withSlot(func() { g.dialRelayData(ctx, base, message.Conn, message.Ticket) })
		case "spare":
			// One spare at a time; a Relay asking for more is ignored.
			if !spareHeld.CompareAndSwap(false, true) {
				continue
			}
			withSlot(func() { g.holdRelaySpare(ctx, base, message.Conn, message.Ticket, &spareHeld) })
		case "error":
			return fmt.Errorf("relay refused the host: %s", message.Code)
		}
	}
}

func (g *Gateway) dialRelayData(ctx context.Context, base, connID, ticket string) {
	wire := g.dialRelaySocket(ctx, base, connID, ticket)
	if wire == nil {
		return
	}
	g.serve(ctx, wire, "relay")
}

// holdRelaySpare dials a data socket before any phone needs it and waits,
// without a deadline, for the Relay to splice a phone onto it; the handshake
// clock starts with the phone's first message. The Relay pings it while idle.
func (g *Gateway) holdRelaySpare(ctx context.Context, base, connID, ticket string, held *atomic.Bool) {
	wire := g.dialRelaySocket(ctx, base, connID, ticket)
	if wire == nil {
		held.Store(false)
		return
	}
	first, err := wire.Read(ctx)
	held.Store(false)
	if err != nil {
		wire.Close(websocket.CloseGoingAway, "")
		return
	}
	g.serve(ctx, &primedWire{wire: wire, first: first}, "relay")
}

func (g *Gateway) dialRelaySocket(ctx context.Context, base, connID, ticket string) *wsWire {
	if connID == "" || ticket == "" || strings.ContainsAny(connID, "/?#") {
		return nil
	}
	endpoint, err := relayEndpoint(base, "/v1/host/data/"+url.PathEscape(connID)+"?ticket="+url.QueryEscape(ticket))
	if err != nil {
		return nil
	}
	dialer := relayDialer()
	conn, response, err := dialer.DialContext(ctx, endpoint, nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		g.logger.Warn("mobile.relay_data_dial_failed", "relay", base, "error", err)
		return nil
	}
	return newWSWire(conn)
}

// maxRelayDataSockets bounds the data sockets one control connection may have
// dialed or open at once, spares included.
const maxRelayDataSockets = 32

// errRelayAddress refuses a Relay that resolves to an address no Relay can
// legitimately have.
var errRelayAddress = errors.New("relay resolves to a link-local, multicast or unspecified address")

// relayDialer dials Relay nodes and checks the address actually dialed, after
// DNS, so a node URL cannot aim the computer at cloud metadata or a link-local
// device. Loopback and private addresses stay allowed for local and LAN
// Relays.
func relayDialer() *websocket.Dialer {
	dialer := &net.Dialer{
		Timeout: handshakeTimeout,
		Control: func(_, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			ip := net.ParseIP(host)
			if ip == nil || ip.IsUnspecified() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
				ip.IsInterfaceLocalMulticast() || ip.IsMulticast() {
				return errRelayAddress
			}
			return nil
		},
	}
	return &websocket.Dialer{HandshakeTimeout: handshakeTimeout, NetDialContext: dialer.DialContext}
}

// primedWire hands out a message already read from the wire before reading
// on.
type primedWire struct {
	wire  *wsWire
	first []byte
}

func (p *primedWire) Read(ctx context.Context) ([]byte, error) {
	if first := p.first; first != nil {
		p.first = nil
		return first, nil
	}
	return p.wire.Read(ctx)
}

func (p *primedWire) Write(ctx context.Context, message []byte) error {
	return p.wire.Write(ctx, message)
}

func (p *primedWire) Close(code int, reason string) { p.wire.Close(code, reason) }
