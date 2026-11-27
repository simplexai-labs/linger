// Package push is the Push Service: it seals push grants for phones and
// delivers content-free alerts to them through Expo. Only the official
// deployment configures it, because only it holds the provider credentials;
// a self-hosted Relay leaves it off. docs/mobile.md describes the flow.
package push

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/chacha20poly1305"
)

const (
	// GrantLifetime is how long a grant works; the phone renews it well
	// before then.
	GrantLifetime = 30 * 24 * time.Hour
	// PerDevicePerMinute and PerDevicePerDay bound what reaches one device,
	// however many grants name it: asking for more grants buys no more.
	PerDevicePerMinute = 30
	PerDevicePerDay    = 300
	// GrantsPerMinute bounds grant requests per client address.
	GrantsPerMinute = 20
	grantLabel      = "linger-push-grant/1"
	maxBody         = 8 << 10
)

var (
	expoToken = regexp.MustCompile(`^Expo(nent)?PushToken\[[A-Za-z0-9_\-]{8,128}\]$`)
	hostIDRE  = regexp.MustCompile(`^[0-9a-f]{32}$`)
	idRE      = regexp.MustCompile(`^[A-Za-z0-9_\-]{1,128}$`)
)

// Alert texts per kind and interface language. They name the kind of event,
// never its content. A decision interrupts more than a reply where the app
// holds the time-sensitive entitlement; elsewhere iOS shows it as active.
// English is the fallback for a grant that names no language, or one this
// service does not know; Chinese is written as escaped code points because
// the repository keeps other languages to translation catalogs.
var alerts = map[string]struct {
	level string
	body  map[string]string
}{
	"message": {"active", map[string]string{
		"en":    "You have a new reply",
		"zh-CN": "\u4f60\u6536\u5230\u4e00\u6761\u65b0\u56de\u590d",
	}},
	"decision": {"time-sensitive", map[string]string{
		"en":    "Linger needs your decision",
		"zh-CN": "Linger \u9700\u8981\u4f60\u505a\u51b3\u5b9a",
	}},
}

const alertTitle = "Linger"

// alertBody is the kind's text in the grant's language, or in English.
func alertBody(kind, language string) string {
	if body, ok := alerts[kind].body[language]; ok {
		return body
	}
	return alerts[kind].body["en"]
}

// Options configures the Push Service.
type Options struct {
	// SealKey seals grants; rotating it invalidates every grant, and phones
	// get new ones the next time they connect.
	SealKey []byte
	// ExpoAccessToken authenticates sends when Expo enhanced push security is
	// on, which makes a leaked Expo token useless without this service.
	ExpoAccessToken string
	ExpoURL         string
	Client          *http.Client
	Logger          *slog.Logger
	// ClientAddress picks the rate-limit key of a request.
	ClientAddress func(*http.Request) string
	Now           func() time.Time
}

// Service handles /v1/push/*.
type Service struct {
	key      []byte
	options  Options
	mu       sync.Mutex
	counters map[string]*counter
	grants   map[string]*counter
}

type counter struct {
	minute      time.Time
	minuteCount int
	day         time.Time
	dayCount    int
}

type sealedGrant struct {
	Token     string `json:"t"`
	HostID    string `json:"h"`
	ExpiresAt int64  `json:"e"`
	// Language is the phone's interface language for alert text; a grant
	// sealed before phones sent one has none and gets English.
	Language string `json:"l,omitempty"`
}

// New builds the Service; SealKey must be 32 bytes.
func New(options Options) (*Service, error) {
	if len(options.SealKey) != chacha20poly1305.KeySize {
		return nil, fmt.Errorf("push seal key has %d bytes, want %d", len(options.SealKey), chacha20poly1305.KeySize)
	}
	if _, err := chacha20poly1305.NewX(options.SealKey); err != nil {
		return nil, err
	}
	if options.Client == nil {
		options.Client = &http.Client{Timeout: 15 * time.Second}
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	return &Service{key: append([]byte(nil), options.SealKey...), options: options,
		counters: map[string]*counter{}, grants: map[string]*counter{}}, nil
}

// Register mounts the Push Service routes.
func (s *Service) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/push/grants", s.handleGrant)
	mux.HandleFunc("POST /v1/push/send", s.handleSend)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code}})
}

func (s *Service) handleGrant(w http.ResponseWriter, r *http.Request) {
	if !s.allow(s.counters, "grant:"+s.options.ClientAddress(r), GrantsPerMinute, 0) {
		writeError(w, http.StatusTooManyRequests, "RATE_LIMITED")
		return
	}
	var request struct {
		ExpoToken string `json:"expo_token"`
		HostID    string `json:"host_id"`
		// Language is optional; an unknown one falls back to English.
		Language string `json:"language"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, maxBody)).Decode(&request) != nil ||
		!expoToken.MatchString(request.ExpoToken) || !hostIDRE.MatchString(request.HostID) {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST")
		return
	}
	expires := s.options.Now().Add(GrantLifetime).UTC().Truncate(time.Second)
	language := request.Language
	if _, known := alerts["message"].body[language]; !known {
		language = ""
	}
	grant, err := s.seal(sealedGrant{Token: request.ExpoToken, HostID: request.HostID, ExpiresAt: expires.Unix(), Language: language})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"grant": grant, "expires_at": expires.Format(time.RFC3339)})
}

type sendRequest struct {
	Grant  string `json:"grant"`
	Kind   string `json:"kind"`
	Handle struct {
		HostID  string `json:"host_id"`
		RoomID  string `json:"room_id"`
		EventID string `json:"event_id"`
	} `json:"handle"`
}

func (s *Service) handleSend(w http.ResponseWriter, r *http.Request) {
	var request sendRequest
	if json.NewDecoder(io.LimitReader(r.Body, maxBody)).Decode(&request) != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST")
		return
	}
	alert, ok := alerts[request.Kind]
	if !ok || !idRE.MatchString(request.Handle.RoomID) || !idRE.MatchString(request.Handle.EventID) {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST")
		return
	}
	grant, err := s.open(request.Grant)
	if err != nil || grant.HostID != request.Handle.HostID {
		writeError(w, http.StatusUnauthorized, "GRANT_INVALID")
		return
	}
	if s.options.Now().Unix() > grant.ExpiresAt {
		writeError(w, http.StatusGone, "GRANT_EXPIRED")
		return
	}
	digest := sha256.Sum256([]byte(grant.Token))
	if !s.allow(s.grants, hex.EncodeToString(digest[:]), PerDevicePerMinute, PerDevicePerDay) {
		writeError(w, http.StatusTooManyRequests, "RATE_LIMITED")
		return
	}
	status, err := s.deliver(r.Context(), grant.Token, alertTitle, alertBody(request.Kind, grant.Language), alert.level, map[string]string{
		"kind": request.Kind, "host_id": request.Handle.HostID, "room_id": request.Handle.RoomID, "event_id": request.Handle.EventID,
	})
	switch {
	case err != nil:
		s.options.Logger.Warn("push.delivery_failed", "error", err)
		writeError(w, http.StatusBadGateway, "DELIVERY_FAILED")
	case status == deliveryGone:
		writeError(w, http.StatusGone, "DEVICE_NOT_REGISTERED")
	default:
		s.options.Logger.Info("push.delivered", "kind", request.Kind)
		w.WriteHeader(http.StatusAccepted)
	}
}

const (
	deliveryOK = iota
	deliveryGone
)

// deliver sends one alert through Expo and reports whether the device is gone.
func (s *Service) deliver(ctx context.Context, token, title, body, level string, data map[string]string) (int, error) {
	// One notification per Room and kind: a new one replaces the last on
	// iOS (collapseId) and Android (tag), and a Room's alerts group together.
	room := data["kind"] + ":" + data["room_id"]
	payload, err := json.Marshal([]map[string]any{{
		"to": token, "title": title, "body": body, "data": data,
		"sound": "default", "priority": "high",
		"collapseId": room, "tag": room, "threadId": data["room_id"],
		"interruptionLevel": level,
	}})
	if err != nil {
		return 0, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.options.ExpoURL, bytes.NewReader(payload))
	if err != nil {
		return 0, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	if s.options.ExpoAccessToken != "" {
		request.Header.Set("Authorization", "Bearer "+s.options.ExpoAccessToken)
	}
	response, err := s.options.Client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	var result struct {
		Data []struct {
			Status  string `json:"status"`
			Details struct {
				Error string `json:"error"`
			} `json:"details"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&result); err != nil {
		return 0, fmt.Errorf("expo answered %d without a receipt", response.StatusCode)
	}
	if response.StatusCode >= 300 || len(result.Data) != 1 {
		return 0, fmt.Errorf("expo answered %d", response.StatusCode)
	}
	if result.Data[0].Status == "error" {
		if result.Data[0].Details.Error == "DeviceNotRegistered" {
			return deliveryGone, nil
		}
		return 0, fmt.Errorf("expo refused the alert: %s", result.Data[0].Details.Error)
	}
	return deliveryOK, nil
}

func (s *Service) seal(grant sealedGrant) (string, error) {
	plain, err := json.Marshal(grant)
	if err != nil {
		return "", err
	}
	aead, _ := chacha20poly1305.NewX(s.key)
	nonce := make([]byte, aead.NonceSize())
	_, _ = rand.Read(nonce)
	sealed := aead.Seal(nonce, nonce, plain, []byte(grantLabel))
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}

var errGrant = errors.New("grant is invalid")

func (s *Service) open(encoded string) (sealedGrant, error) {
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(encoded))
	aead, _ := chacha20poly1305.NewX(s.key)
	if err != nil || len(raw) < aead.NonceSize()+aead.Overhead() {
		return sealedGrant{}, errGrant
	}
	plain, err := aead.Open(nil, raw[:aead.NonceSize()], raw[aead.NonceSize():], []byte(grantLabel))
	if err != nil {
		return sealedGrant{}, errGrant
	}
	var grant sealedGrant
	if json.Unmarshal(plain, &grant) != nil || !expoToken.MatchString(grant.Token) || !hostIDRE.MatchString(grant.HostID) {
		return sealedGrant{}, errGrant
	}
	return grant, nil
}

// allow counts one event under key against a per-minute and, when perDay is
// positive, a per-day limit. Memory stays proportional to keys seen today.
func (s *Service) allow(counters map[string]*counter, key string, perMinute, perDay int) bool {
	now := s.options.Now()
	minute := now.Truncate(time.Minute)
	day := now.Truncate(24 * time.Hour)
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, c := range counters {
		if c.day.Before(day) && c.minute.Before(minute) {
			delete(counters, k)
		}
	}
	c := counters[key]
	if c == nil {
		c = &counter{}
		counters[key] = c
	}
	if !c.minute.Equal(minute) {
		c.minute, c.minuteCount = minute, 0
	}
	if !c.day.Equal(day) {
		c.day, c.dayCount = day, 0
	}
	if c.minuteCount >= perMinute || (perDay > 0 && c.dayCount >= perDay) {
		return false
	}
	c.minuteCount++
	c.dayCount++
	return true
}
