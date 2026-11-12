package voicemedia

import (
	"context"
	"errors"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicetranscription"
)

// A transient key-read failure must fail the materialize step so River
// retries it; reading it as "no key" would skip saving the source audio and
// lose archive recovery for good.
func TestArchiveTranscriberReadinessReturnsKeyReadFailures(t *testing.T) {
	readFailure := errors.New("database unavailable")
	for _, tc := range []struct {
		name  string
		key   func(context.Context) (string, error)
		ready bool
		err   error
	}{
		{"saved key", func(context.Context) (string, error) { return "key", nil }, true, nil},
		{"no key", func(context.Context) (string, error) { return "", nil }, false, nil},
		{"key read failed", func(context.Context) (string, error) { return "", readFailure }, false, readFailure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service := New(nil, nil, nil)
			service.SetArchiveTranscriber(voicetranscription.NewKeyedSonioxTranscriber(tc.key, voicetranscription.SonioxConfig{}), func(text string) string { return text })
			ready, err := service.archiveTranscriberReady(t.Context())
			if ready != tc.ready || !errors.Is(err, tc.err) {
				t.Fatalf("ready=%v err=%v", ready, err)
			}
		})
	}
	if ready, err := New(nil, nil, nil).archiveTranscriberReady(t.Context()); ready || err != nil {
		t.Fatalf("without a transcriber: ready=%v err=%v", ready, err)
	}
}
