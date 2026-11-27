// Package mobilerelay owns the list of Relay nodes this computer keeps a link
// to. Every enabled node gets its own link, so a paired phone reaches the
// computer through whichever node is fastest where the phone is. The official
// nodes ship with Linger and can be turned off but not removed; the Human adds
// custom ones. A node only forwards end-to-end encrypted bytes, so adding one
// never exposes content.
package mobilerelay

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Kinds of node.
const (
	KindOfficial = "official"
	KindCustom   = "custom"
)

// Official is one Relay node Linger runs.
type Official struct {
	ID, URL, Label string
}

// Officials are the nodes every computer links to unless the Human turns
// them off: one abroad and one in mainland China, where the overseas path is
// slow. The mainland node serves plain ws on an IP address, which needs no
// domain filing; the Noise session through it stays end-to-end encrypted.
var Officials = []Official{
	{ID: "relay_official_global", URL: "wss://relay.heylinger.com", Label: "Linger Global"},
	{ID: "relay_official_mainland", URL: "ws://120.26.232.218:7787", Label: "Linger Mainland China"},
}

const maxLabelLength = 60

// Errors the API maps to codes.
var (
	ErrInvalidURL = errors.New("relay URL must be a ws or wss origin")
	ErrExists     = errors.New("relay node is already listed")
	ErrNotFound   = errors.New("relay node not found")
	ErrOfficial   = errors.New("official relay nodes cannot be removed")
	ErrTooMany    = errors.New("too many custom relay nodes")
	ErrPrivate    = errors.New("relay node is on a private network")
)

// MaxCustom bounds the custom nodes: the computer keeps a link open to each,
// and a phone ranks every one.
const MaxCustom = 8

// Node is one listed Relay node.
type Node struct {
	ID, URL, Label, Kind string
	Enabled              bool
}

// Service stores the node list.
type Service struct {
	pool    *pgxpool.Pool
	queries *store.Queries
}

// New builds the Service.
func New(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool, queries: store.New(pool)}
}

// NormalizeURL returns the canonical origin of a node URL: ws or wss, a host,
// and nothing after it, so the Gateway's fixed Relay paths are all it dials.
func NormalizeURL(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (parsed.Scheme != "ws" && parsed.Scheme != "wss") || parsed.Hostname() == "" ||
		parsed.User != nil || strings.Trim(parsed.Path, "/") != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", ErrInvalidURL
	}
	return parsed.Scheme + "://" + strings.ToLower(parsed.Host), nil
}

// CheckPublic refuses a node URL whose host is, or resolves to, a loopback,
// private, link-local or unspecified address. Only the computer itself may
// add such a node; a phone may not point the computer into its network.
func CheckPublic(ctx context.Context, rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return ErrInvalidURL
	}
	host := parsed.Hostname()
	addresses := []net.IP{net.ParseIP(host)}
	if addresses[0] == nil {
		resolved, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil || len(resolved) == 0 {
			return ErrInvalidURL
		}
		addresses = addresses[:0]
		for _, address := range resolved {
			addresses = append(addresses, address.IP)
		}
	}
	for _, ip := range addresses {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() ||
			ip.IsMulticast() || ip.IsLinkLocalMulticast() {
			return ErrPrivate
		}
	}
	return nil
}

// Prepare adds the official nodes and the node the environment names, once
// each. A custom node with an official node's URL gives way to it and hands
// on whether the Human had turned it off. The official nodes are committed
// before the environment's node is read, so a bad environment URL cannot
// undo them.
func (s *Service) Prepare(ctx context.Context, environmentURL string) error {
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		queries := s.queries.WithTx(tx)
		rows, err := queries.ListMobileRelayNodes(ctx)
		if err != nil {
			return err
		}
		for index, official := range Officials {
			turnedOff := false
			for _, row := range rows {
				if row.Url == official.URL && row.Kind != KindOfficial && !row.Enabled {
					turnedOff = true
				}
			}
			if err := queries.DeleteCustomMobileRelayNodeByURL(ctx, official.URL); err != nil {
				return err
			}
			if err := queries.EnsureOfficialMobileRelayNode(ctx, store.EnsureOfficialMobileRelayNodeParams{
				ID: official.ID, Url: official.URL, Label: official.Label, Position: int32(index + 1),
			}); err != nil {
				return err
			}
			if turnedOff {
				if _, err := queries.SetMobileRelayNodeEnabled(ctx, store.SetMobileRelayNodeEnabledParams{ID: official.ID}); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil || environmentURL == "" {
		return err
	}
	normalized, err := NormalizeURL(environmentURL)
	if err != nil {
		return fmt.Errorf("TEAMHUB_MOBILE_RELAY_URL: %w", err)
	}
	_, err = s.queries.CreateMobileRelayNode(ctx, store.CreateMobileRelayNodeParams{
		ID: idgen.New("relay"), Url: normalized, Label: labelFor("", normalized),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	return err
}

// List returns every node, official ones first.
func (s *Service) List(ctx context.Context) ([]Node, error) {
	rows, err := s.queries.ListMobileRelayNodes(ctx)
	if err != nil {
		return nil, err
	}
	nodes := make([]Node, 0, len(rows))
	for _, row := range rows {
		nodes = append(nodes, fromRow(row))
	}
	return nodes, nil
}

// Create adds an enabled custom node.
func (s *Service) Create(ctx context.Context, rawURL, label string) (Node, error) {
	normalized, err := NormalizeURL(rawURL)
	if err != nil {
		return Node{}, err
	}
	rows, err := s.queries.ListMobileRelayNodes(ctx)
	if err != nil {
		return Node{}, err
	}
	custom := 0
	for _, row := range rows {
		if row.Url == normalized {
			return Node{}, ErrExists
		}
		if row.Kind != KindOfficial {
			custom++
		}
	}
	if custom >= MaxCustom {
		return Node{}, ErrTooMany
	}
	row, err := s.queries.CreateMobileRelayNode(ctx, store.CreateMobileRelayNodeParams{
		ID: idgen.New("relay"), Url: normalized, Label: labelFor(label, normalized),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Node{}, ErrExists
	}
	if err != nil {
		return Node{}, err
	}
	return fromRow(row), nil
}

// SetEnabled turns a node on or off.
func (s *Service) SetEnabled(ctx context.Context, id string, enabled bool) (Node, error) {
	row, err := s.queries.SetMobileRelayNodeEnabled(ctx, store.SetMobileRelayNodeEnabledParams{ID: id, Enabled: enabled})
	if errors.Is(err, pgx.ErrNoRows) {
		return Node{}, ErrNotFound
	}
	if err != nil {
		return Node{}, err
	}
	return fromRow(row), nil
}

// Remove deletes a custom node; a missing one is already gone.
func (s *Service) Remove(ctx context.Context, id string) error {
	deleted, err := s.queries.DeleteCustomMobileRelayNode(ctx, id)
	if err != nil || deleted > 0 {
		return err
	}
	kind, err := s.queries.GetMobileRelayNodeKind(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if kind == KindOfficial {
		return ErrOfficial
	}
	return nil
}

func fromRow(row store.MobileRelayNode) Node {
	return Node{ID: row.ID, URL: row.Url, Label: row.Label, Kind: row.Kind, Enabled: row.Enabled}
}

// labelFor is the Human's label, or the node's host when they gave none.
func labelFor(label, normalized string) string {
	label = strings.TrimSpace(label)
	if label == "" {
		label = strings.SplitN(normalized, "://", 2)[1]
	}
	if utf8.RuneCountInString(label) > maxLabelLength {
		label = string([]rune(label)[:maxLabelLength])
	}
	return label
}
