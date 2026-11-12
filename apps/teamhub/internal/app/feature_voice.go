package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicekey"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicetranscription"
)

// voiceReconcileTimeout bounds the best-effort wake of the Node Services voice
// workers after a key is saved; their own periodic reconcile covers a miss.
const voiceReconcileTimeout = 5 * time.Second

// registerVoice builds voice media while TEAMHUB_VOICE_MEDIA is on, or takes
// the plane a test injects; without LINGER_SECRET_SEED or ffmpeg it runs
// with voice off. Whether a provider can be used is decided at each
// use from the key in effect then: the environment key, else the one saved in
// the product. Soniox enables transcription (Recording, dictation and Pocket
// Notes) with archive recovery; xAI enables Live alone. With voice media off
// voice stays off: the Voice Runtime callbacks answer not found, the Voice
// media policy reports nothing available, and no voice retention rule or job
// exists. With voice on and no key the voice jobs and rules are registered
// but find no work, because no voice session can start without a key.
func (a *App) registerVoice(cfg config.Config, deps Deps, objects artifactstore.ObjectStore) error {
	box, err := secretBox(cfg.ExternalApps.SecretEncryptionKey)
	if err != nil {
		return err
	}
	checker := deps.VoiceKeyChecker
	if checker == nil {
		checker = voicekey.NewHTTPChecker()
	}
	if cfg.NodeServicesURL != "" && cfg.NodeServicesInternalToken != "" {
		if a.reconcileVoiceWorkers, err = newVoiceWorkerReconciler(cfg.NodeServicesURL, cfg.NodeServicesInternalToken); err != nil {
			return err
		}
	}
	media, err := a.buildVoiceMedia(cfg, deps.VoiceMedia, objects)
	if err != nil {
		return err
	}
	// This is the one place voice is decided on or off for the process: the
	// key service's Enabled drives the policy, saves and the key read.
	a.voiceMedia = media
	a.voiceKeys = voicekey.New(a.queries, checker, voicekey.Config{
		Enabled: media != nil,
		Environment: map[voicekey.Provider]string{
			voicekey.Soniox: cfg.Voice.SonioxAPIKey, voicekey.XAI: cfg.Voice.XaiAPIKey,
		},
		Box: box,
	}, a.logger)
	return nil
}

// newVoiceMediaPlane builds the production plane; a test replaces it to
// inject a build failure.
var newVoiceMediaPlane = newVoiceMedia

// buildVoiceMedia returns the plane voice runs on, or nil with voice off.
// Like every other service link, voice stays off without LINGER_SECRET_SEED,
// and a computer without ffmpeg runs without voice rather than not at all;
// any other build error still stops startup.
func (a *App) buildVoiceMedia(cfg config.Config, injected voicemedia.Plane, objects artifactstore.ObjectStore) (voicemedia.Plane, error) {
	if injected != nil {
		return injected, nil
	}
	if !cfg.Voice.MediaEnabled {
		return nil, nil
	}
	if cfg.Voice.RuntimeToken == "" {
		a.logger.Warn("voice.media_unavailable", "reason", "secret_seed_missing")
		return nil, nil
	}
	service, recordings, err := newVoiceMediaPlane(a.pool, objects, cfg.ArtifactStorageRoot, a.documents, cfg.Voice, func(ctx context.Context) (string, error) {
		return a.voiceKeys.Effective(ctx, voicekey.Soniox)
	})
	if errors.Is(err, voicemedia.ErrMediaToolsMissing) {
		a.logger.Warn("voice.media_unavailable", "reason", "ffmpeg_missing")
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	a.voiceRecordings = recordings
	return service, nil
}

// newVoiceWorkerReconciler asks Node Services to start or stop its voice
// workers for the keys now in effect. The request carries no key.
func newVoiceWorkerReconciler(baseURL, token string) (func(context.Context) error, error) {
	client, err := roomagent.NewAgentManagementClient(baseURL, token, &http.Client{Timeout: voiceReconcileTimeout})
	if err != nil {
		return nil, fmt.Errorf("configure Node Services voice reconcile: %w", err)
	}
	return func(ctx context.Context) error {
		response, err := client.ReconcileVoiceWorkersWithResponse(ctx)
		if err != nil {
			return err
		}
		if response.StatusCode() != http.StatusAccepted {
			return fmt.Errorf("Node Services voice reconcile returned HTTP %d", response.StatusCode())
		}
		return nil
	}, nil
}

// addVoiceJobs registers the voice River jobs when the voice media plane has
// them.
func (a *App) addVoiceJobs(features *featureSet) {
	service, ok := a.voiceMedia.(*voicemedia.Service)
	if !ok {
		return
	}
	service.AddWorkers(features.workers, features.queues, a.logger, func(ctx context.Context, captureID string) (time.Duration, error) {
		return a.voice.CompleteCaptureStep(ctx, captureID)
	})
	features.resume = append(features.resume, func(ctx context.Context) error {
		return voicemedia.ResumeJobs(ctx, a.pool)
	})
}

// newVoiceMedia builds voice media over LiveKit. Archive recovery reads the
// Soniox key at each use, so it starts working as soon as a key is saved. The
// recorder's HLS staging files live under stagingRoot.
func newVoiceMedia(pool *pgxpool.Pool, objects artifactstore.ObjectStore, stagingRoot string, documents *document.Service, cfg config.VoiceConfig, sonioxKey func(context.Context) (string, error)) (*voicemedia.Service, *voicemedia.LocalStagingStore, error) {
	liveKitProvider, err := voicemedia.NewLiveKitProvider(voicemedia.LiveKitConfig{
		APIURL: cfg.LiveKitAPIURL, PublicURL: cfg.LiveKitURL,
		APIKey: cfg.LiveKitAPIKey, APISecret: cfg.LiveKitAPISecret,
		CredentialTTL:   config.VoiceMediaCredentialTTL,
		SegmentDuration: uint32(config.VoiceMediaSegmentDurationSeconds),
		StartTimeout:    config.VoiceMediaStartTimeout, StopTimeout: config.VoiceMediaStopTimeout,
	}, pool)
	if err != nil {
		return nil, nil, fmt.Errorf("configure LiveKit voice media provider: %w", err)
	}
	recordings := voicemedia.NewLocalStagingStore(pool, stagingRoot)
	materializer, err := voicemedia.NewHLSMaterializer(pool, objects, recordings)
	if err != nil {
		return nil, nil, fmt.Errorf("configure voice media materializer: %w", err)
	}
	service := voicemedia.NewWithDocuments(pool, liveKitProvider, materializer, documents)
	archiveTranscriber := voicetranscription.NewKeyedSonioxTranscriber(sonioxKey, voicetranscription.SonioxConfig{LanguageHints: voicetranscription.SonioxLanguageHints})
	service.SetArchiveTranscriber(archiveTranscriber, voice.NormalizeCaptureTranscript)
	service.SetArchiveRecoveryConcurrency(config.VoiceArchiveRecoveryConcurrency)
	return service, recordings, nil
}
