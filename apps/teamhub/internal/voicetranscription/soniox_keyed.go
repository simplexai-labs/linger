package voicetranscription

import (
	"context"
	"errors"
)

// ErrProviderNotConfigured is returned while no Soniox key is in effect.
var ErrProviderNotConfigured = errors.New("voice transcription provider has no API key")

// KeyedSonioxTranscriber reads the Soniox key at each call, so a key saved
// while TeamHub runs applies to the next block and every replica agrees.
type KeyedSonioxTranscriber struct {
	key func(context.Context) (string, error)
	cfg SonioxConfig
}

// NewKeyedSonioxTranscriber transcribes with cfg and the key key returns; an
// empty key means Soniox is not configured. cfg.APIKey is ignored.
func NewKeyedSonioxTranscriber(key func(context.Context) (string, error), cfg SonioxConfig) *KeyedSonioxTranscriber {
	return &KeyedSonioxTranscriber{key: key, cfg: cfg}
}

// Ready reports whether a Soniox key is in effect now. A failed key read is
// an error, not "no key", so the caller retries instead of giving up on
// archive recovery.
func (t *KeyedSonioxTranscriber) Ready(ctx context.Context) (bool, error) {
	key, err := t.key(ctx)
	if err != nil {
		return false, err
	}
	return key != "", nil
}

// TranscribeArchivePCM transcribes one block with the key in effect now.
func (t *KeyedSonioxTranscriber) TranscribeArchivePCM(ctx context.Context, pcm []byte) ([]StreamingResult, error) {
	key, err := t.key(ctx)
	if err != nil {
		return nil, errors.Join(ErrProviderFailure, err)
	}
	if key == "" {
		return nil, ErrProviderNotConfigured
	}
	cfg := t.cfg
	cfg.APIKey = key
	transcriber, err := NewSonioxTranscriber(cfg)
	if err != nil {
		return nil, err
	}
	return transcriber.TranscribeArchivePCM(ctx, pcm)
}
