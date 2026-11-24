package integration_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

// A recorder that never saved audio must not cost the meeting its transcript:
// a stopped Capture whose live transcript covers it finalizes without audio and
// completes like any other recording. Without speech, or with a transcript that
// lost input, it still fails.
func TestLiveKitCaptureWithoutAudioFinalizesFromLiveTranscript(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, name := range []string{"complete-transcript", "no-speech", "integrity-lost"} {
		t.Run(name, func(t *testing.T) {
			env, alice, _ := newVoiceServiceEnv(t, nil, starting(app.JobQueue))
			q := store.New(env.pool)
			ctx := t.Context()
			direct := requestDirectRoom(alice, env.server.URL, "actor_acme_official")
			if direct.err != nil || (direct.status != http.StatusCreated && direct.status != http.StatusOK) {
				t.Fatalf("direct Room status=%d err=%v", direct.status, direct.err)
			}
			voice, err := q.CreateVoiceSession(ctx, store.CreateVoiceSessionParams{ID: "voice_without_audio", AccountID: "account_alice", AuthSessionID: loginSessionOf(t, env, "account_alice"), RoomID: direct.roomID, ProviderRoomName: "without-audio", ParticipantIdentity: "without-audio", Purpose: "hardware_control"})
			if err != nil {
				t.Fatal(err)
			}
			const startMS, inputEndMS int64 = 1_000, 9_000
			capture, err := q.CreateLiveKitCaptureSession(ctx, store.CreateLiveKitCaptureSessionParams{ID: "capture_without_audio", AccountID: "account_alice", RoomID: direct.roomID, VoiceSessionID: voice.ID, StartOffsetMs: startMS})
			if err != nil {
				t.Fatal(err)
			}
			if name != "no-speech" {
				if _, err = createCaptureSpeech(ctx, q, captureSpeech{ID: "without_audio_speech", SessionID: capture.ID, AccountID: "account_alice", RoomID: direct.roomID, StartOffsetMs: 1_500, EndOffsetMs: 3_000, Text: "kept-live-speech", NormalizedText: "kept-live-speech", Kind: "speech"}); err != nil {
					t.Fatal(err)
				}
			}
			if _, err = q.TransitionLiveKitCaptureStatus(ctx, store.TransitionLiveKitCaptureStatusParams{ID: capture.ID, Status: "finalizing"}); err != nil {
				t.Fatal(err)
			}
			if _, err = q.RequestVoiceCaptureStop(ctx, capture.ID); err != nil {
				t.Fatal(err)
			}
			// Stop came ten seconds into the Capture; the input track ended a
			// second before it, after which the Runtime confirmed its coverage.
			if _, err = env.pool.Exec(ctx, "UPDATE capture_sessions SET stop_requested_at=created_at+interval '10 seconds',transcript_integrity_lost=$2 WHERE id=$1", capture.ID, name == "integrity-lost"); err != nil {
				t.Fatal(err)
			}
			if _, err = env.pool.Exec(ctx, "UPDATE voice_sessions SET last_input_started_ms=500,last_input_ended_ms=$2 WHERE id=$1", voice.ID, inputEndMS); err != nil {
				t.Fatal(err)
			}
			if _, err = q.AdvanceCaptureTranscriptCoverage(ctx, store.AdvanceCaptureTranscriptCoverageParams{SessionID: capture.ID, AccountID: "account_alice", RoomID: direct.roomID, StreamID: "without-audio", Lane: "live", StartOffsetMs: startMS, EndOffsetMs: inputEndMS}); err != nil {
				t.Fatal(err)
			}
			epoch, err := q.CreateVoiceMediaEpoch(ctx, store.CreateVoiceMediaEpochParams{ID: "epoch_without_audio", VoiceSessionID: voice.ID, CaptureSessionID: capture.ID, StagingPrefix: "voice-staging/capture_without_audio/epoch-0"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = q.RequestSealVoiceMediaEpoch(ctx, epoch.ID); err != nil {
				t.Fatal(err)
			}
			if _, err = q.MarkVoiceMediaEpochFailed(ctx, store.MarkVoiceMediaEpochFailedParams{ID: epoch.ID, LastFailureCode: textForVoiceTest("egress_failed_without_media")}); err != nil {
				t.Fatal(err)
			}
			if _, err = env.pool.Exec(ctx, "UPDATE voice_media_epochs SET updated_at=clock_timestamp()-interval '5 seconds' WHERE id=$1", epoch.ID); err != nil {
				t.Fatal(err)
			}
			recorder := newVoiceRecorderRoom(t, env.pool)
			service := voicemedia.New(env.pool, recorder.provider(voicemedia.LiveKitConfig{}, env.pool), absentMediaInspector{})
			if _, err = service.RunJobStepForTest(ctx, voicemedia.CaptureReconcileArgs{CaptureSessionID: capture.ID}); err != nil {
				t.Fatalf("reconcile the recorder that saved no audio: %v", err)
			}
			if _, err = service.RunJobStepForTest(ctx, voicemedia.CaptureMaterializeArgs{CaptureSessionID: capture.ID}); err != nil {
				t.Fatalf("materialize without audio: %v", err)
			}
			current, err := q.GetCaptureSessionForAccount(ctx, store.GetCaptureSessionForAccountParams{ID: capture.ID, AccountID: textForVoiceTest("account_alice")})
			if err != nil {
				t.Fatal(err)
			}
			if name != "complete-transcript" {
				if current.Status != "failed" {
					t.Fatalf("Capture without audio or a whole transcript status=%s", current.Status)
				}
				return
			}
			if current.Status != "finalized" || current.DocumentVersionID.Valid || current.TranscriptEndOffsetMs.Int64 != inputEndMS {
				t.Fatalf("Capture status=%s audio=%v transcript end=%v", current.Status, current.DocumentVersionID.Valid, current.TranscriptEndOffsetMs)
			}
			deadline := time.Now().Add(10 * time.Second)
			for !current.TranscriptDocumentVersionID.Valid {
				if time.Now().After(deadline) {
					t.Fatal("completion did not publish the transcript of a Capture without audio")
				}
				time.Sleep(20 * time.Millisecond)
				if current, err = q.GetCaptureSessionForAccount(ctx, store.GetCaptureSessionForAccountParams{ID: capture.ID, AccountID: textForVoiceTest("account_alice")}); err != nil {
					t.Fatal(err)
				}
			}
			status, _, transcript := env.request(alice, http.MethodGet, "/v0/document-versions/"+current.TranscriptDocumentVersionID.String+"/content", nil, "")
			if status != http.StatusOK || !strings.Contains(string(transcript), "kept-live-speech") || !strings.Contains(string(transcript), "could not be saved") {
				t.Fatalf("transcript status=%d body=%q", status, transcript)
			}
			if countRows(t, env, "SELECT count(*) FROM messages WHERE room_id=$1 AND author_actor_id='actor_acme_official'", direct.roomID) != 1 {
				t.Fatal("completion must publish exactly one Room message")
			}
			// The Meeting Wiki ingests a finalized Capture through its transcript.
			if countRows(t, env, "SELECT count(*) FROM capture_sessions capture WHERE capture.id=$1 AND capture.status='finalized' AND capture.transcript_start_offset_ms IS NOT NULL AND capture.transcript_end_offset_ms IS NOT NULL AND capture.transcript_document_version_id IS NOT NULL", capture.ID) != 1 {
				t.Fatal("Capture without audio is not ready for the Meeting Wiki")
			}
		})
	}
}
