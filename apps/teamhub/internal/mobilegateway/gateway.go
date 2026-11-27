// Package mobilegateway is the computer's end of the Mobile App session: it
// holds the computer's static key, accepts sessions from the LAN listener and
// the Relay, authenticates Paired Phones, and dispatches their requests into
// TeamHub's own HTTP handler in process. docs/mobile.md describes the wire
// protocol.
package mobilegateway

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// Phone is an authenticated Paired Phone.
type Phone struct {
	ID string
	// SessionDigest names the phone's device Session; the Gateway attaches it
	// to every request it dispatches for the phone. It is empty while the
	// phone is pending.
	SessionDigest []byte
	// Pending phones wait for the Human to approve them; they may send only
	// control frames.
	Pending          bool
	ConfirmationCode string
}

// PairRequest is the first handshake payload of a phone that pairs.
type PairRequest struct {
	PublicKey []byte
	Invite    string
	Name      string
	Platform  string
}

// Errors a Phones implementation reports; the Gateway turns them into the
// codes a phone shows.
var (
	ErrUnknownPhone   = errors.New("phone is not paired")
	ErrPhoneRevoked   = errors.New("phone was removed")
	ErrInviteInvalid  = errors.New("pairing invite is invalid, used or expired")
	ErrBadPairRequest = errors.New("pairing request is malformed")
	ErrPairingExpired = errors.New("pairing was not approved in time")
)

// Phones authenticates Paired Phones by the static key their handshake
// proved.
type Phones interface {
	// Resume returns the phone that owns publicKey with a live device Session.
	Resume(ctx context.Context, publicKey []byte) (Phone, error)
	// Pair consumes an invite and records a new phone.
	Pair(ctx context.Context, request PairRequest) (Phone, error)
}

// Relay is a Relay node the Gateway keeps a link to.
type Relay struct {
	ID    string `json:"id"`
	URL   string `json:"url"`
	Label string `json:"label"`
}

// relayLink is the Gateway's control link to one Relay node.
type relayLink struct {
	// url never changes: a node with a new URL is a new link.
	url    string
	cancel context.CancelFunc
	ready  atomic.Bool
}

// Config is everything the Gateway needs; the app builds it from config.
type Config struct {
	Key          StaticKey
	ComputerName string
	// LANAddress is where the LAN listener binds; empty turns it off.
	LANAddress string
	// Relays are the nodes to link to from the start; SetRelays replaces them.
	Relays []Relay
	// VoiceBridgeURL is the Voice Bridge websocket on Node Services.
	VoiceBridgeURL   string
	VoiceBridgeToken string
}

// Gateway owns every live phone session.
type Gateway struct {
	key              StaticKey
	computerName     string
	lanAddress       string
	voiceBridgeURL   string
	voiceBridgeToken string
	handler          http.Handler
	phones           Phones
	logger           *slog.Logger

	pairing *rateLimiter

	mu       sync.Mutex
	sessions map[*session]struct{}
	lanURLs  []string
	// lanPort is set when the listener takes every address; the URLs are then
	// read from the interfaces each time, since the machine's IP can change.
	lanPort int
	// relays is the node list in order; links holds one link per node URL
	// once Run has started.
	relays  []Relay
	links   map[string]*relayLink
	runCtx  context.Context
	relayWG sync.WaitGroup
}

// New builds a Gateway that dispatches into handler. It starts nothing.
func New(cfg Config, handler http.Handler, phones Phones, logger *slog.Logger) *Gateway {
	return &Gateway{
		key: cfg.Key, computerName: cfg.ComputerName, lanAddress: cfg.LANAddress,
		relays: append([]Relay(nil), cfg.Relays...), voiceBridgeURL: cfg.VoiceBridgeURL,
		voiceBridgeToken: cfg.VoiceBridgeToken, handler: handler, phones: phones,
		logger: logger, sessions: map[*session]struct{}{}, links: map[string]*relayLink{},
		pairing: newRateLimiter(pairingPerMinute, time.Minute),
	}
}

// HostID names this computer on the Relay.
func (g *Gateway) HostID() string { return g.key.HostID() }

// PublicKey is the computer's static public key a pairing code carries.
func (g *Gateway) PublicKey() []byte { return g.key.Public() }

// Relays lists the nodes the Gateway links to, in order; a pairing code and
// the welcome carry them so a phone can use any.
func (g *Gateway) Relays() []Relay {
	g.mu.Lock()
	defer g.mu.Unlock()
	// Never nil: an empty list is sent as [] and tells a phone every node
	// is off, where a missing one would leave it on its old list.
	return append([]Relay{}, g.relays...)
}

// RelayConnected reports whether the link to the node at url is up now.
func (g *Gateway) RelayConnected(url string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	link := g.links[url]
	return link != nil && link.ready.Load()
}

// SetRelays replaces the node list: a new node gets its own link at once and
// a dropped node's link closes, while links to unchanged nodes stay up.
func (g *Gateway) SetRelays(relays []Relay) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.relays = append([]Relay(nil), relays...)
	g.reconcileRelaysLocked()
}

func (g *Gateway) reconcileRelaysLocked() {
	if g.runCtx == nil {
		return
	}
	wanted := map[string]Relay{}
	for _, relay := range g.relays {
		wanted[relay.URL] = relay
	}
	for url, link := range g.links {
		if _, ok := wanted[url]; !ok {
			link.cancel()
			delete(g.links, url)
		}
	}
	for url, relay := range wanted {
		if _, ok := g.links[url]; ok {
			continue
		}
		ctx, cancel := context.WithCancel(g.runCtx)
		link := &relayLink{url: relay.URL, cancel: cancel}
		g.links[url] = link
		g.relayWG.Add(1)
		go func() {
			defer g.relayWG.Done()
			g.runRelayLink(ctx, link)
		}()
	}
}

// ComputerName is the name a phone shows for this computer.
func (g *Gateway) ComputerName() string { return g.computerName }

// Run serves the LAN listener and one link per Relay node until ctx ends. It
// is a long-lived connection owner, which is why it is not a River job.
func (g *Gateway) Run(ctx context.Context) {
	g.mu.Lock()
	g.runCtx = ctx
	g.reconcileRelaysLocked()
	g.mu.Unlock()
	defer g.relayWG.Wait()
	var wg sync.WaitGroup
	if g.lanAddress != "" {
		wg.Add(1)
		go func() {
			defer wg.Done()
			g.serveLAN(ctx)
		}()
	}
	wg.Wait()
	<-ctx.Done()
}

// Approve lets a pending phone's live sessions work with its new device
// Session.
func (g *Gateway) Approve(phoneID string, digest []byte) {
	g.mu.Lock()
	var matched []*session
	for s := range g.sessions {
		if s.currentPhone().ID == phoneID {
			matched = append(matched, s)
		}
	}
	g.mu.Unlock()
	for _, s := range matched {
		s.approve(digest)
	}
}

// Disconnect closes every live session of a phone, for example after it was
// removed. Its device Session is already revoked, so a session that races
// this call still cannot reach TeamHub.
func (g *Gateway) Disconnect(phoneID string) {
	g.mu.Lock()
	var matched []*session
	for s := range g.sessions {
		if s.currentPhone().ID == phoneID {
			matched = append(matched, s)
		}
	}
	g.mu.Unlock()
	for _, s := range matched {
		s.shutdown(ErrPhoneRevoked)
		s.wire.Close(closeRefused, "PHONE_REMOVED")
	}
}

func (g *Gateway) track(s *session) {
	g.mu.Lock()
	g.sessions[s] = struct{}{}
	g.mu.Unlock()
}

func (g *Gateway) untrack(s *session) {
	g.mu.Lock()
	delete(g.sessions, s)
	g.mu.Unlock()
}

// LANEndpoints lists the ws:// URLs the LAN listener answers on now.
func (g *Gateway) LANEndpoints() []string { return g.lanEndpoints() }

func (g *Gateway) lanEndpoints() []string {
	g.mu.Lock()
	port, urls := g.lanPort, append([]string{}, g.lanURLs...)
	g.mu.Unlock()
	if port != 0 {
		return lanURLs(port)
	}
	return urls
}

func (g *Gateway) setLANEndpoints(urls []string) {
	g.mu.Lock()
	g.lanURLs, g.lanPort = urls, 0
	g.mu.Unlock()
}

// setLANPort records a listener on every address at port.
func (g *Gateway) setLANPort(port int) {
	g.mu.Lock()
	g.lanURLs, g.lanPort = nil, port
	g.mu.Unlock()
}

func deadline(d time.Duration) time.Time { return time.Now().Add(d) }

type phoneSessionKey struct{}

// WithPhoneSession marks a request the Gateway dispatches for a Paired Phone.
// Only in-process code can set it, so no network request can claim it.
func WithPhoneSession(ctx context.Context, digest []byte) context.Context {
	return context.WithValue(ctx, phoneSessionKey{}, append([]byte(nil), digest...))
}

// PhoneSession returns the device Session digest of a dispatched request.
func PhoneSession(ctx context.Context) ([]byte, bool) {
	digest, ok := ctx.Value(phoneSessionKey{}).([]byte)
	return digest, ok && len(digest) > 0
}

// Connected reports which phones hold a live session now.
func (g *Gateway) Connected() map[string]bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	connected := map[string]bool{}
	for s := range g.sessions {
		connected[s.currentPhone().ID] = true
	}
	return connected
}
