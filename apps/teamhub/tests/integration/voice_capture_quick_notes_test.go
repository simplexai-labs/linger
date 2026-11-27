package integration_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"
)

// A recording's quick notes are written by their own job: a failed call retries
// once, the last failure gives the notes up, and each Capture tells its Room
// exactly once.
func TestCaptureQuickNotesRetryOnceThenSettle(t *testing.T) {
	allowParallelIntegrationTest(t)
	var mu sync.Mutex
	calls := map[string]int{}
	agentService := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/model-calls" {
			http.NotFound(w, r)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var request struct {
			Kind  string `json:"kind"`
			Input string `json:"input"`
		}
		if err = json.Unmarshal(body, &request); err != nil || request.Kind != "meeting_notes" {
			t.Errorf("model call kind=%q err=%v", request.Kind, err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		marker := "always fails"
		if strings.Contains(request.Input, "fails once") {
			marker = "fails once"
		}
		mu.Lock()
		calls[marker]++
		attempt := calls[marker]
		mu.Unlock()
		if marker == "always fails" || attempt == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"model":"test-notes-model","output":{"title":"Launch review","sections":[{"heading":"Plan","bullets":["Ship Friday"]}]}}`))
	}))
	t.Cleanup(agentService.Close)
	env, alice, _ := newVoiceServiceEnv(t, func(cfg *config.Config) {
		cfg.NodeServicesURL = agentService.URL
	}, starting(app.JobQueue))
	q := store.New(env.pool)
	direct := requestDirectRoom(alice, env.server.URL, "actor_acme_official")
	if direct.err != nil || (direct.status != http.StatusCreated && direct.status != http.StatusOK) {
		t.Fatalf("Direct Room status=%d err=%v", direct.status, direct.err)
	}
	for _, id := range []string{"retried", "given_up"} {
		session, err := q.CreateVoiceSession(t.Context(), store.CreateVoiceSessionParams{Client: "web", ID: "voice_notes_" + id, AccountID: "account_alice", RoomID: direct.roomID, ProviderRoomName: "notes-" + id, ParticipantIdentity: id, Purpose: "hardware_control"})
		if err != nil {
			t.Fatal(err)
		}
		capture, err := q.CreateLiveKitCaptureSession(t.Context(), store.CreateLiveKitCaptureSessionParams{ID: "capture_notes_" + id, AccountID: "account_alice", RoomID: direct.roomID, VoiceSessionID: session.ID})
		if err != nil {
			t.Fatal(err)
		}
		text := map[string]string{"retried": "This meeting fails once.", "given_up": "This meeting always fails."}[id]
		if _, err = createCaptureSpeech(t.Context(), q, captureSpeech{ID: "notes_speech_" + id, SessionID: capture.ID, AccountID: "account_alice", RoomID: direct.roomID, StartOffsetMs: 100, EndOffsetMs: 900, Text: text, NormalizedText: text, Kind: "speech"}); err != nil {
			t.Fatal(err)
		}
		if _, err = env.pool.Exec(t.Context(), `UPDATE capture_sessions SET transcript_start_offset_ms=0,transcript_end_offset_ms=1000,quick_notes_state='pending' WHERE id=$1`, capture.ID); err != nil {
			t.Fatal(err)
		}
		queueVoiceJob(t, env.pool, voice.CaptureQuickNotesArgs{CaptureSessionID: capture.ID})
	}

	// River schedules the retry about a second out and picks it up on its
	// next scheduler pass.
	settled := func(id string) string {
		deadline := time.Now().Add(20 * time.Second)
		for {
			var state string
			if err := env.pool.QueryRow(t.Context(), `SELECT quick_notes_state FROM capture_sessions WHERE id=$1`, id).Scan(&state); err != nil {
				t.Fatal(err)
			}
			if state != "pending" {
				return state
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s quick notes stayed pending", id)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	if state := settled("capture_notes_retried"); state != "ready" {
		t.Fatalf("retried notes state=%s", state)
	}
	if state := settled("capture_notes_given_up"); state != "failed" {
		t.Fatalf("given-up notes state=%s", state)
	}
	mu.Lock()
	if calls["fails once"] != 2 || calls["always fails"] != 2 {
		t.Fatalf("model calls=%v", calls)
	}
	mu.Unlock()

	code, _, body := env.request(alice, http.MethodGet, "/v0/voice-captures/capture_notes_retried", nil, "")
	if code != http.StatusOK || !strings.Contains(string(body), `"quick_notes":{"sections":[{"bullets":["Ship Friday"],"heading":"Plan"}],"state":"ready","title":"Launch review"}`) {
		t.Fatalf("ready Capture=%d %s", code, body)
	}
	code, _, body = env.request(alice, http.MethodGet, "/v0/voice-captures/capture_notes_given_up", nil, "")
	if code != http.StatusOK || !strings.Contains(string(body), `"quick_notes":{"state":"failed"}`) {
		t.Fatalf("failed Capture=%d %s", code, body)
	}

	// A job that runs again finds nothing pending and tells the Room nothing.
	// River records a job completed shortly after it settles the notes; until
	// then a second job for the same Capture would be folded into it.
	completedJobs := func(want int, step string) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for countRows(t, env, `SELECT count(*) FROM river_job WHERE kind=$1 AND args->>'capture_session_id'='capture_notes_retried' AND state='completed'`, voice.CaptureQuickNotesArgs{}.Kind()) < want {
			if time.Now().After(deadline) {
				t.Fatalf("%s did not complete", step)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	completedJobs(1, "the first job")
	queueVoiceJob(t, env.pool, voice.CaptureQuickNotesArgs{CaptureSessionID: "capture_notes_retried"})
	completedJobs(2, "the job that ran again")
	for _, id := range []string{"capture_notes_retried", "capture_notes_given_up"} {
		if got := countRows(t, env, `SELECT count(*) FROM room_events WHERE room_id=$1 AND event_type='capture.session.changed' AND resource_id=$2`, direct.roomID, id); got != 1 {
			t.Fatalf("%s Room events=%d", id, got)
		}
	}
}
