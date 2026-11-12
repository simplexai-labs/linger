package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/permissionreview"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/retention"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicekey"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

// registeredKinds reads the job kinds registered in workers. River keeps its
// worker map unexported, so the test reads the field directly.
func registeredKinds(workers *river.Workers) []string {
	kinds := reflect.ValueOf(workers).Elem().FieldByName("workersMap").MapKeys()
	names := make([]string, 0, len(kinds))
	for _, kind := range kinds {
		names = append(names, kind.String())
	}
	slices.Sort(names)
	return names
}

func retentionTables(rules []retention.Rule) []string {
	tables := make([]string, 0, len(rules))
	for _, rule := range rules {
		tables = append(tables, rule.Table)
	}
	return tables
}

// Every deployment registers the connected app jobs, because a Composio key
// can be saved at run time; each job checks for the key when it runs.
var externalAppKinds = []string{
	"external.connection_cleanup", "external.connection_reconcile", "external.connection_reconcile_sweep",
	"external.mail_connection", "external.mail_import", "external.mail_sync", "external.mail_sync_sweep",
	"external.reauthorization",
	"listener.poll", "listener.sweep", "maintenance.proactive_listener_sweep",
	"typedcard.connection_auth_reconcile", "typedcard.connection_auth_settle",
}

var voiceRetentionTables = []string{
	"voice_transcript_segments",
	"voice_sessions", "voice_transcript_uncertainties",
}

// The optional features a configuration turns on register their River kinds,
// periodic jobs, retention rules, routes and loops; a feature whose startup
// configuration is missing registers none of them.
func TestOptionalFeaturesRegisterFromConfiguration(t *testing.T) {
	for _, tc := range []struct {
		name      string
		judge     bool
		voice     bool
		kinds     []string
		retention []string
		periodic  int
		resume    int
	}{
		{
			// The injected plane has no LiveKit provider, materializer or archive
			// ASR, so only the recording completion job is registered.
			name: "full configuration", judge: true, voice: true,
			kinds:     slices.Concat(externalAppKinds, []string{"voice_capture_completion"}),
			retention: voiceRetentionTables, periodic: 5, resume: 1,
		},
		{
			// .env.example: a judge model, no Soniox or Composio key.
			name: "default deployment", judge: true,
			kinds: externalAppKinds, periodic: 5,
		},
		{name: "nothing configured", kinds: externalAppKinds, periodic: 5},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := &App{cfg: config.ForTest()}
			features := newFeatureSet()
			var plane voicemedia.Plane
			if tc.voice {
				plane = voicemedia.New(nil, nil, nil)
			}
			if err := a.registerVoice(config.ForTest(), Deps{VoiceMedia: plane}, nil); err != nil {
				t.Fatal(err)
			}
			a.addVoiceJobs(features)
			var judge permissionreview.Judge
			if tc.judge {
				judge = allowingJudge{}
			}
			a.registerPermissionReview(config.PermissionReviewConfig{}, nil, judge)
			a.addExternalAppJobs(features, true)

			want := slices.Clone(tc.kinds)
			slices.Sort(want)
			if got := registeredKinds(features.workers); !slices.Equal(got, want) {
				t.Fatalf("River kinds:\n got %v\nwant %v", got, want)
			}
			if len(features.periodic) != tc.periodic {
				t.Fatalf("periodic jobs = %d, want %d", len(features.periodic), tc.periodic)
			}
			wantRetention := slices.Concat(retentionTables(retention.Core), tc.retention)
			if got := retentionTables(a.retentionRules()); !slices.Equal(got, wantRetention) {
				t.Fatalf("retention rules = %v, want %v", got, wantRetention)
			}
			if len(features.resume) != tc.resume {
				t.Fatalf("resume steps = %d, want %d", len(features.resume), tc.resume)
			}
			if (a.voiceMedia != nil) != tc.voice || a.permissionReviewEnabled() != tc.judge {
				t.Fatalf("voice=%v judge=%v", a.voiceMedia != nil, a.permissionReviewEnabled())
			}
		})
	}
}

// Without app listeners (Reminder jobs skipped) the listener jobs stay out.
func TestExternalAppJobsWithoutListeners(t *testing.T) {
	features := newFeatureSet()
	(&App{cfg: config.ForTest()}).addExternalAppJobs(features, false)
	got := registeredKinds(features.workers)
	for _, kind := range []string{"listener.poll", "listener.sweep", "maintenance.proactive_listener_sweep"} {
		if slices.Contains(got, kind) {
			t.Fatalf("%s registered without app listeners", kind)
		}
	}
	if len(features.periodic) != 3 {
		t.Fatalf("periodic jobs = %d, want the 3 connected app sweeps", len(features.periodic))
	}
}

// The Voice Runtime callbacks answer only with voice media on.
func TestVoiceRuntimeCallbacksNeedVoiceMedia(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, tc := range []struct {
		name  string
		media voicemedia.Plane
		want  int
	}{
		{"voice off", nil, http.StatusNotFound},
		{"voice on", voicemedia.New(nil, nil, nil), http.StatusNoContent},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := &App{}
			a.cfg.Voice.RuntimeToken = "voice-token"
			if err := a.registerVoice(config.ForTest(), Deps{VoiceMedia: tc.media}, nil); err != nil {
				t.Fatal(err)
			}
			engine := gin.New()
			engine.POST("/internal/v1/voice/observations", a.requireVoiceRuntime(), func(c *gin.Context) { c.Status(http.StatusNoContent) })
			request := httptest.NewRequest(http.MethodPost, "/internal/v1/voice/observations", nil)
			request.Header.Set("Authorization", "Bearer voice-token")
			response := httptest.NewRecorder()
			engine.ServeHTTP(response, request)
			if response.Code != tc.want {
				t.Fatalf("status = %d, want %d", response.Code, tc.want)
			}
		})
	}
}

// Live runs on xAI alone; dictation and Recording transcribe with Soniox.
func TestVoiceSessionPurposeNeedsItsProvider(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, tc := range []struct {
		name, purpose, xai string
		transcription      bool
	}{
		{"dictation without Soniox", "chat_dictation", "xai-key", false},
		{"recording without Soniox", "hardware_control", "xai-key", false},
		{"live without xAI", "chat_live", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			environment := map[voicekey.Provider]string{voicekey.XAI: tc.xai}
			if tc.transcription {
				environment[voicekey.Soniox] = "soniox-key"
			}
			a := &App{voiceMedia: voicemedia.New(nil, nil, nil), voiceKeys: voicekey.New(nil, nil, voicekey.Config{Enabled: true, Environment: environment}, nil)}
			engine := gin.New()
			engine.POST("/v0/rooms/:roomId/voice-sessions", func(c *gin.Context) {
				c.Set("request_id", "request")
				a.createVoiceSession(c)
			})
			request := httptest.NewRequest(http.MethodPost, "/v0/rooms/room/voice-sessions", strings.NewReader(`{"purpose":"`+tc.purpose+`"}`))
			response := httptest.NewRecorder()
			engine.ServeHTTP(response, request)
			if response.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusServiceUnavailable, response.Body)
			}
		})
	}
}

// With TEAMHUB_VOICE_MEDIA on and no key anywhere the full voice plane is
// built and its jobs and retention rules registered; they only find work once
// a voice session exists, and none can start without a key.
func TestVoiceMediaOnWithoutKeysRegistersTheVoicePlane(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg required to build the voice media materializer")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe required to build the voice media materializer")
	}
	cfg := voiceOnConfig()
	a := &App{cfg: cfg, logger: slog.Default()}
	if err := a.registerVoice(cfg, Deps{}, nil); err != nil {
		t.Fatal(err)
	}
	if a.voiceMedia == nil || a.voiceRecordings == nil || !a.voiceKeys.Enabled() {
		t.Fatal("voice media on did not build the voice plane")
	}
	features := newFeatureSet()
	a.addVoiceJobs(features)
	// The bare App has no Document service, so materialization stays out.
	want := []string{
		"voice_capture_completion", "voice_capture_reconcile", "voice_capture_stop",
		"voice_session_reconcile", "voice_staging_cleanup", "voice_transcript_recovery",
	}
	if got := registeredKinds(features.workers); !slices.Equal(got, want) {
		t.Fatalf("River kinds:\n got %v\nwant %v", got, want)
	}
	if len(features.periodic) != 0 || len(features.resume) != 1 {
		t.Fatalf("periodic=%d resume=%d, want no periodic voice job and one resume", len(features.periodic), len(features.resume))
	}
	if got := retentionTables(a.retentionRules()); !slices.Equal(got, slices.Concat(retentionTables(retention.Core), voiceRetentionTables)) {
		t.Fatalf("retention rules = %v", got)
	}
}

func voiceOnConfig() config.Config {
	return config.ForTest(func(cfg *config.Config) {
		cfg.Voice.MediaEnabled = true
		cfg.Voice.RuntimeToken = "voice-token"
		cfg.Voice.LiveKitAPIURL = "http://127.0.0.1:17880"
	})
}

// Voice that cannot run here leaves TeamHub up with voice off and one
// warning: without LINGER_SECRET_SEED, or without ffmpeg. Any other build
// failure still stops startup.
func TestVoiceMediaThatCannotRunTurnsVoiceOff(t *testing.T) {
	for _, tc := range []struct {
		name, reason string
		seed         bool
		build        error
		fails        bool
	}{
		{name: "no secret seed", reason: "secret_seed_missing"},
		{name: "no ffmpeg", reason: "ffmpeg_missing", seed: true, build: fmt.Errorf("ffprobe: %w", voicemedia.ErrMediaToolsMissing)},
		{name: "bad LiveKit configuration", seed: true, build: errors.New("configure LiveKit voice media provider"), fails: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			built := false
			original := newVoiceMediaPlane
			t.Cleanup(func() { newVoiceMediaPlane = original })
			newVoiceMediaPlane = func(*pgxpool.Pool, artifactstore.ObjectStore, string, *document.Service, config.VoiceConfig, func(context.Context) (string, error)) (*voicemedia.Service, *voicemedia.LocalStagingStore, error) {
				built = true
				return nil, nil, tc.build
			}
			cfg := voiceOnConfig()
			if !tc.seed {
				cfg.Voice.RuntimeToken = ""
			}
			var logs bytes.Buffer
			a := &App{cfg: cfg, logger: slog.New(slog.NewJSONHandler(&logs, nil))}
			err := a.registerVoice(cfg, Deps{}, nil)
			if tc.fails {
				if err == nil {
					t.Fatal("a broken voice configuration started")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if built != tc.seed || a.voiceMedia != nil || a.voiceKeys.Enabled() {
				t.Fatalf("built=%v media=%v enabled=%v", built, a.voiceMedia != nil, a.voiceKeys.Enabled())
			}
			if !strings.Contains(logs.String(), `"msg":"voice.media_unavailable"`) || !strings.Contains(logs.String(), `"reason":"`+tc.reason+`"`) {
				t.Fatalf("logs = %s", logs.String())
			}
			if status, _ := a.voiceKeys.Status(t.Context(), voicekey.Soniox); status.CanSave {
				t.Fatal("a key can be saved with voice off")
			}
			if err := a.voiceKeys.Save(t.Context(), voicekey.Soniox, "key"); !errors.Is(err, voicekey.ErrVoiceOff) {
				t.Fatalf("Save = %v", err)
			}
		})
	}
}
