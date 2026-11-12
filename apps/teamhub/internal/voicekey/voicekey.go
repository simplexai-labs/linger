// Package voicekey resolves the Soniox and xAI keys voice runs on: a
// deployment's environment key, else one saved in the product, sealed with the
// secret box. Keys are read from the database at each use, so a save takes
// effect at once on every TeamHub replica without a restart.
package voicekey

import (
	"context"
	"crypto/sha256"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/secretbox"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Provider names one voice provider; the values are the contract's.
type Provider string

// The providers: Soniox transcribes, xAI runs Live.
const (
	Soniox Provider = "soniox"
	XAI    Provider = "xai"
)

// Valid reports whether p is a known provider.
func (p Provider) Valid() bool { return p == Soniox || p == XAI }

// Where a provider's effective key comes from.
const (
	SourceNone        = "none"
	SourceEnvironment = "environment"
	SourceStored      = "stored"
)

// MaxKeyBytes bounds a saved key.
const MaxKeyBytes = 512

// Save's refusals; the handler maps each to its error code.
var (
	ErrInvalid             = errors.New("the voice provider API key is invalid")
	ErrFromEnvironment     = errors.New("the voice provider API key is set by the deployment")
	ErrStorageMissing      = errors.New("the deployment has no secret encryption key")
	ErrVoiceOff            = errors.New("voice media is off in this deployment")
	ErrRejected            = errors.New("the voice provider rejected the API key")
	ErrProviderUnavailable = errors.New("the voice provider could not be reached")
)

// Status reports where a provider's key comes from and whether a user may save
// one. The key itself is never part of it.
type Status struct {
	Source  string
	CanSave bool
}

// Checker asks a provider whether it accepts key, with one cheap
// authenticated request. It returns ErrRejected or ErrProviderUnavailable.
type Checker interface {
	Check(ctx context.Context, provider Provider, key string) error
}

// Store is the key table; *store.Queries implements it.
type Store interface {
	GetVoiceProviderKey(ctx context.Context, provider string) ([]byte, error)
	UpsertVoiceProviderKey(ctx context.Context, arg store.UpsertVoiceProviderKeyParams) error
}

// Config is what the deployment decides about voice keys.
type Config struct {
	// Enabled is TEAMHUB_VOICE_MEDIA; off resolves no key at all.
	Enabled bool
	// Environment holds each provider's environment key; empty is unset.
	Environment map[Provider]string
	// Box seals saved keys; nil means keys cannot be saved or read.
	Box *secretbox.Box
}

// Service resolves and saves voice provider keys.
type Service struct {
	store   Store
	checker Checker
	cfg     Config
	logger  *slog.Logger

	mu sync.Mutex
	// unreadable is the digest of the last row per provider that would not
	// open, so its warning is logged once.
	unreadable map[Provider][sha256.Size]byte
}

// New returns a Service over keys. A nil logger logs to slog.Default.
func New(keys Store, checker Checker, cfg Config, logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{store: keys, checker: checker, cfg: cfg, logger: logger, unreadable: map[Provider][sha256.Size]byte{}}
}

// Enabled reports whether this deployment can run voice.
func (s *Service) Enabled() bool { return s.cfg.Enabled }

// Effective returns the key provider runs on now, or "" when it has none.
func (s *Service) Effective(ctx context.Context, provider Provider) (string, error) {
	key, _, err := s.resolve(ctx, provider)
	return key, err
}

// Status reports where provider's key comes from and whether one can be saved.
func (s *Service) Status(ctx context.Context, provider Provider) (Status, error) {
	_, source, err := s.resolve(ctx, provider)
	if err != nil {
		return Status{}, err
	}
	return Status{Source: source, CanSave: s.cfg.Enabled && s.cfg.Box != nil && source != SourceEnvironment}, nil
}

func (s *Service) resolve(ctx context.Context, provider Provider) (string, string, error) {
	if !s.cfg.Enabled || !provider.Valid() {
		return "", SourceNone, nil
	}
	if key := strings.TrimSpace(s.cfg.Environment[provider]); key != "" {
		return key, SourceEnvironment, nil
	}
	if s.cfg.Box == nil {
		return "", SourceNone, nil
	}
	sealed, err := s.store.GetVoiceProviderKey(ctx, string(provider))
	if errors.Is(err, pgx.ErrNoRows) {
		return "", SourceNone, nil
	}
	if err != nil {
		return "", "", err
	}
	if key, openErr := s.cfg.Box.Open(sealed); openErr == nil {
		return string(key), SourceStored, nil
	}
	// A key sealed under another encryption key is unusable; voice treats the
	// provider as unconfigured so a new save replaces it. Keys are read on
	// every use, so each unreadable row is logged once, not on every read.
	digest := sha256.Sum256(sealed)
	s.mu.Lock()
	logged := s.unreadable[provider] == digest
	s.unreadable[provider] = digest
	s.mu.Unlock()
	if !logged {
		s.logger.Warn("voice.provider_key_unreadable", "provider", string(provider))
	}
	return "", SourceNone, nil
}

// Save checks key with the provider, then seals and stores it. Saving the same
// key again rewrites the one row; of concurrent saves the last one wins.
func (s *Service) Save(ctx context.Context, provider Provider, key string) error {
	key = strings.TrimSpace(key)
	switch {
	case !provider.Valid() || key == "" || len(key) > MaxKeyBytes || strings.IndexFunc(key, unicode.IsSpace) >= 0 || strings.IndexFunc(key, unicode.IsControl) >= 0:
		return ErrInvalid
	case !s.cfg.Enabled:
		return ErrVoiceOff
	case strings.TrimSpace(s.cfg.Environment[provider]) != "":
		return ErrFromEnvironment
	case s.cfg.Box == nil:
		return ErrStorageMissing
	}
	if err := s.checker.Check(ctx, provider, key); err != nil {
		return err
	}
	sealed, err := s.cfg.Box.Seal([]byte(key))
	if err != nil {
		return err
	}
	return s.store.UpsertVoiceProviderKey(ctx, store.UpsertVoiceProviderKeyParams{Provider: string(provider), ApiKeyCiphertext: sealed})
}
