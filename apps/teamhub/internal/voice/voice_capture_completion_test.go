package voice

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestLiveKitCaptureCompletionFailureCode(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct {
		name string
		err  error
		want string
	}{
		{name: "success", err: nil},
		{name: "document not found", err: document.ErrNotFound, want: liveKitCaptureCompletionFailureDocumentNotFound},
		{name: "wrapped document not found", err: fmt.Errorf("load version: %w", document.ErrNotFound), want: liveKitCaptureCompletionFailureDocumentNotFound},
		{name: "authority incomplete", err: errLiveKitCaptureCompletionAuthorityIncomplete, want: liveKitCaptureCompletionFailureAuthorityIncomplete},
		{name: "retryable", err: errors.New("Capture Direct Room Agent is unavailable")},
		{name: "incomplete transcript", err: errCaptureTranscriptIncomplete},
		{name: "canceled", err: context.Canceled},
		{name: "deadline exceeded", err: context.DeadlineExceeded},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := liveKitCaptureCompletionFailureCode(tt.err); got != tt.want {
				t.Fatalf("failure code=%q want=%q", got, tt.want)
			}
		})
	}
}

func TestLiveKitCaptureCompletionShouldDelay(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct {
		name      string
		cause     error
		workerErr error
		delay     bool
	}{
		{name: "incomplete transcript", cause: errCaptureTranscriptIncomplete, delay: true},
		{name: "worker canceled", cause: context.Canceled, workerErr: context.Canceled, delay: true},
		{name: "worker deadline", cause: context.DeadlineExceeded, workerErr: context.DeadlineExceeded, delay: true},
		{name: "downstream canceled", cause: context.Canceled},
		{name: "downstream deadline", cause: context.DeadlineExceeded},
		{name: "wrapped downstream deadline", cause: fmt.Errorf("get version: %w", context.DeadlineExceeded)},
		{name: "unrelated worker error", cause: errors.New("Capture Direct Room Agent is unavailable"), workerErr: errors.New("pool exhausted")},
		{name: "document not found", cause: document.ErrNotFound},
		{name: "retryable", cause: errors.New("Capture Direct Room Agent is unavailable")},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := liveKitCaptureCompletionShouldDelay(tt.cause, tt.workerErr); got != tt.delay {
				t.Fatalf("delay=%v want=%v", got, tt.delay)
			}
		})
	}
}

func TestLiveKitCaptureCompletionRetryDelay(t *testing.T) {
	t.Parallel()
	want := []time.Duration{
		5 * time.Second,
		10 * time.Second,
		20 * time.Second,
		40 * time.Second,
		80 * time.Second,
		160 * time.Second,
		5 * time.Minute,
		5 * time.Minute,
	}
	for attempts, delay := range want {
		if got := liveKitCaptureCompletionRetryDelay(int32(attempts)); got != delay {
			t.Fatalf("attempts=%d delay=%s want=%s", attempts, got, delay)
		}
	}
	if got := liveKitCaptureCompletionRetryDelay(-1); got != 5*time.Second {
		t.Fatalf("negative attempts delay=%s", got)
	}
	if LiveKitCaptureCompletionMaxAttempts < 1 {
		t.Fatal("max attempts must fail a retryable Capture")
	}
}

func TestCaptureCompletionSegmentsPutQuickNotesAfterTheFiles(t *testing.T) {
	t.Parallel()
	audio := document.Version{DocumentID: "document_audio", Filename: "source.m4a"}
	transcript := document.Version{DocumentID: "document_transcript", Filename: "transcript.md"}
	plain, err := messagecreation.Normalize(captureCompletionSegments("capture_1", &audio, transcript, false))
	if err != nil || plain.Segments[0].Content != captureCompletionMessage+"\n" || len(plain.Segments) != 4 {
		t.Fatalf("without notes: %+v err=%v", plain, err)
	}
	content, err := messagecreation.Normalize(captureCompletionSegments("capture_1", &audio, transcript, true))
	if err != nil {
		t.Fatal(err)
	}
	last := content.Segments[len(content.Segments)-1]
	if len(content.Segments) != 6 || content.Segments[1].DocumentID != "document_audio" || content.Segments[3].DocumentID != "document_transcript" ||
		last.Type != "meeting_notes" || last.CaptureID != "capture_1" || last.Content == "" {
		t.Fatalf("with notes: %+v", content.Segments)
	}
}

func TestCaptureCompletionWithoutAudioOffersOnlyTheTranscript(t *testing.T) {
	t.Parallel()
	transcript := document.Version{ID: "version_transcript", DocumentID: "document_transcript", Filename: "transcript.md"}
	content, err := messagecreation.Normalize(captureCompletionSegments("capture_1", nil, transcript, true))
	if err != nil {
		t.Fatal(err)
	}
	if len(content.Segments) != 4 || content.Segments[0].Content != captureCompletionWithoutAudioMessage+"\n" ||
		content.Segments[1].DocumentID != "document_transcript" || content.Segments[3].Type != "meeting_notes" {
		t.Fatalf("segments: %+v", content.Segments)
	}
	if got := captureCompletionAttachments(nil, transcript); len(got) != 1 || got[0] != "version_transcript" {
		t.Fatalf("attachments=%v", got)
	}
}

func TestCaptureAudioMatchesRequiresTheSameAudioOrNone(t *testing.T) {
	t.Parallel()
	audio := document.Version{ID: "version_audio", DocumentID: "document_audio"}
	withAudio := store.CaptureSession{Status: "finalized",
		DocumentID:        pgtype.Text{String: "document_audio", Valid: true},
		DocumentVersionID: pgtype.Text{String: "version_audio", Valid: true}}
	withoutAudio := store.CaptureSession{Status: "finalized"}
	for _, scenario := range []struct {
		name    string
		session store.CaptureSession
		audio   *document.Version
		want    bool
	}{
		{"same audio", withAudio, &audio, true},
		{"no audio on either", withoutAudio, nil, true},
		{"audio expected but missing", withoutAudio, &audio, false},
		{"audio present but not passed", withAudio, nil, false},
		{"not finalized", store.CaptureSession{Status: "finalizing"}, nil, false},
	} {
		if got := captureAudioMatches(scenario.session, scenario.audio); got != scenario.want {
			t.Errorf("%s: got %v, want %v", scenario.name, got, scenario.want)
		}
	}
}
