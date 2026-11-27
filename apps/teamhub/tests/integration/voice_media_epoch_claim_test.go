package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

const voiceEpochTestToken = "voice-test-service-token"

type voiceEpochHarness struct {
	t   *testing.T
	env *testEnv
}

func (h voiceEpochHarness) post(ctx context.Context, path string, payload any) (int, []byte) {
	h.t.Helper()
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			h.t.Fatal(err)
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, h.env.server.URL+path, body)
	if err != nil {
		h.t.Fatal(err)
	}
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set("Authorization", "Bearer "+voiceEpochTestToken)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		h.t.Fatal(err)
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(response.Body)
	return response.StatusCode, responseBody
}

func (h voiceEpochHarness) claim(ctx context.Context, voiceSessionID string) (int, int) {
	h.t.Helper()
	status, body := h.post(ctx, "/internal/v1/voice/sessions/"+voiceSessionID+"/media-epochs", nil)
	if status != http.StatusOK {
		return status, -1
	}
	var claim struct {
		MediaEpoch int `json:"media_epoch"`
	}
	if err := json.Unmarshal(body, &claim); err != nil {
		h.t.Fatalf("claim body %s: %v", body, err)
	}
	return status, claim.MediaEpoch
}

func (h voiceEpochHarness) progress(ctx context.Context, voiceSessionID string, epoch int, start, through int64) (int, string) {
	h.t.Helper()
	status, body := h.post(ctx, "/internal/v1/voice/observations", map[string]any{
		"event_id": fmt.Sprintf("voice_event_progress_%s_%d", voiceSessionID, epoch), "kind": "progress",
		"voice_session_id": voiceSessionID, "media_epoch": epoch, "lane": "live",
		"start_offset_ms": start, "end_offset_ms": through, "committed_through_ms": through,
	})
	return status, string(body)
}

func createRecordingVoiceSession(t *testing.T, env *testEnv, q *store.Queries, roomID, id string) store.VoiceSession {
	t.Helper()
	ctx := t.Context()
	voice, err := q.CreateVoiceSession(ctx, store.CreateVoiceSessionParams{Client: "web", ID: id, AccountID: "account_alice", AuthSessionID: loginSessionOf(t, env, "account_alice"), RoomID: roomID, ProviderRoomName: "room-" + id, ParticipantIdentity: "publisher-" + id, Purpose: "hardware_control"})
	if err != nil {
		t.Fatal(err)
	}
	capture, err := q.CreateLiveKitCaptureSession(ctx, store.CreateLiveKitCaptureSessionParams{ID: "capture_" + id, AccountID: "account_alice", RoomID: roomID, VoiceSessionID: voice.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = env.pool.Exec(ctx, "UPDATE capture_sessions SET status='recording',transcript_start_offset_ms=0 WHERE id=$1", capture.ID); err != nil {
		t.Fatal(err)
	}
	return voice
}

// A runtime job restarted mid-recording claims a new epoch, so its progress
// opens a new coverage stream instead of colliding with the earlier job's.
// Claims never repeat under concurrency, leave the publisher-activity clock
// alone, and end with the session.
func TestVoiceMediaEpochClaimsSurviveRuntimeRestart(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, _ := newVoiceServiceEnv(t, func(cfg *config.Config) { cfg.Voice.RuntimeToken = voiceEpochTestToken })
	ctx := t.Context()
	q := store.New(env.pool)
	h := voiceEpochHarness{t: t, env: env}
	roomID := env.createRoom(alice, acmeTenant, "Voice epochs", "voice-epochs")
	voice := createRecordingVoiceSession(t, env, q, roomID, "voice_epochs")

	if status, epoch := h.claim(ctx, voice.ID); status != http.StatusOK || epoch != 0 {
		t.Fatalf("first claim=%d epoch=%d", status, epoch)
	}
	if status, body := h.progress(ctx, voice.ID, 0, 100, 500); status != http.StatusAccepted {
		t.Fatalf("first job progress=%d %s", status, body)
	}
	// The restarted job starts its track later on the session clock.
	status, restarted := h.claim(ctx, voice.ID)
	if status != http.StatusOK || restarted != 1 {
		t.Fatalf("restart claim=%d epoch=%d", status, restarted)
	}
	if status, body := h.progress(ctx, voice.ID, restarted, 2000, 2500); status != http.StatusAccepted {
		t.Fatalf("restarted job progress=%d %s", status, body)
	}
	var streams []string
	rows, err := env.pool.Query(ctx, "SELECT stream_id FROM capture_transcript_coverage WHERE session_id=$1 ORDER BY stream_id", "capture_"+voice.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var stream string
		if err = rows.Scan(&stream); err != nil {
			t.Fatal(err)
		}
		streams = append(streams, stream)
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	want := []string{"voice-runtime-v2:" + voice.ID + ":0", "voice-runtime-v2:" + voice.ID + ":1"}
	if strings.Join(streams, ",") != strings.Join(want, ",") {
		t.Fatalf("coverage streams=%v want %v", streams, want)
	}

	updatedAt := func() time.Time {
		t.Helper()
		var at time.Time
		if err := env.pool.QueryRow(ctx, "SELECT updated_at FROM voice_sessions WHERE id=$1", voice.ID).Scan(&at); err != nil {
			t.Fatal(err)
		}
		return at
	}
	before := updatedAt()
	const concurrent = 20
	claimed := make([]int, concurrent)
	var wait sync.WaitGroup
	for index := range concurrent {
		wait.Add(1)
		go func() {
			defer wait.Done()
			if status, epoch := h.claim(ctx, voice.ID); status == http.StatusOK {
				claimed[index] = epoch
			} else {
				claimed[index] = -status
			}
		}()
	}
	wait.Wait()
	sort.Ints(claimed)
	for index, epoch := range claimed {
		if epoch != index+2 {
			t.Fatalf("concurrent claims=%v", claimed)
		}
	}
	if after := updatedAt(); !after.Equal(before) {
		t.Fatalf("claims moved updated_at from %v to %v", before, after)
	}

	if _, err = env.pool.Exec(ctx, "UPDATE voice_sessions SET status='closed',closed_at=clock_timestamp() WHERE id=$1", voice.ID); err != nil {
		t.Fatal(err)
	}
	if status, _ := h.claim(ctx, voice.ID); status != http.StatusNotFound {
		t.Fatalf("closed session claim=%d", status)
	}
	if status, _ := h.claim(ctx, "voice_missing"); status != http.StatusNotFound {
		t.Fatalf("missing session claim=%d", status)
	}
}

// The migration resumes each open session after the highest epoch it already
// used in segments or coverage, and leaves closed and unused sessions at 0.
func TestVoiceMediaEpochMigrationResumesOpenSessions(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, _ := newVoiceServiceEnv(t, func(cfg *config.Config) { cfg.Voice.RuntimeToken = voiceEpochTestToken })
	ctx := t.Context()
	q := store.New(env.pool)
	h := voiceEpochHarness{t: t, env: env}
	roomID := env.createRoom(alice, acmeTenant, "Voice epoch backfill", "voice-epoch-backfill")
	// One login holds one active VoiceSession; the runtime callbacks used here
	// do not read that link, so each seeded session releases it.
	openSession := func(id string) store.VoiceSession {
		t.Helper()
		voice := createRecordingVoiceSession(t, env, q, roomID, id)
		if _, err := env.pool.Exec(ctx, "UPDATE voice_sessions SET auth_session_id=NULL WHERE id=$1", voice.ID); err != nil {
			t.Fatal(err)
		}
		return voice
	}
	used := openSession("voice_backfill_used")
	unused := openSession("voice_backfill_unused")
	closed := openSession("voice_backfill_closed")

	final := func(voiceSessionID string, epoch int) {
		t.Helper()
		status, body := h.post(ctx, "/internal/v1/voice/observations", map[string]any{
			"event_id": "voice_event_final_" + voiceSessionID, "kind": "final", "voice_session_id": voiceSessionID,
			"media_epoch": epoch, "lane": "live", "start_offset_ms": 100, "end_offset_ms": 400, "text": "Hello",
		})
		if status != http.StatusAccepted {
			t.Fatalf("final=%d %s", status, body)
		}
	}
	final(used.ID, 3)
	if status, body := h.progress(ctx, used.ID, 5, 100, 400); status != http.StatusAccepted {
		t.Fatalf("progress=%d %s", status, body)
	}
	final(closed.ID, 2)
	if _, err := env.pool.Exec(ctx, "UPDATE voice_sessions SET status='closed',closed_at=clock_timestamp() WHERE id=$1", closed.ID); err != nil {
		t.Fatal(err)
	}

	migration, err := os.ReadFile(filepath.Join(teamHubMigrationDirectory(t), "00873_claim_voice_transcript_epochs.sql"))
	if err != nil {
		t.Fatal(err)
	}
	_, backfill, found := strings.Cut(string(migration), "UPDATE voice_sessions voice")
	if !found {
		t.Fatal("migration has no voice_sessions backfill")
	}
	if _, err = env.pool.Exec(ctx, "UPDATE voice_sessions SET next_media_epoch=0 WHERE room_id=$1", roomID); err != nil {
		t.Fatal(err)
	}
	if _, err = env.pool.Exec(ctx, "UPDATE voice_sessions voice"+backfill); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]int32{used.ID: 6, unused.ID: 0, closed.ID: 0} {
		var next int32
		if err = env.pool.QueryRow(ctx, "SELECT next_media_epoch FROM voice_sessions WHERE id=$1", id).Scan(&next); err != nil {
			t.Fatal(err)
		}
		if next != want {
			t.Fatalf("%s next_media_epoch=%d want %d", id, next, want)
		}
	}
}
