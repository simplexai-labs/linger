package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// localASRClient bounds the readiness probe: the policy answers for every page
// load, so a stuck Node Services must not hold it.
var localASRClient = &http.Client{Timeout: time.Second}

// localASRCacheTTL is how long Node Services' answer is reused: the policy is
// read on every page load and every dictation session, and a model changes
// state in minutes, not seconds.
const localASRCacheTTL = 3 * time.Second

// localASRCache holds the last answer of the readiness probe.
type localASRCache struct {
	mu    sync.Mutex
	at    time.Time
	state httpapi.VoiceDictationSettingsLocalModel
}

// localDictationState reports whether Node Services runs the speech model it
// downloaded, so dictation works without a Soniox key. The answer is reused for
// a few seconds, so a slow or restarting Node Services holds up one reader in
// a few seconds, not every one.
func (a *App) localDictationState(ctx context.Context) httpapi.VoiceDictationSettingsLocalModel {
	a.localASR.mu.Lock()
	defer a.localASR.mu.Unlock()
	if !a.localASR.at.IsZero() && time.Since(a.localASR.at) < localASRCacheTTL {
		return a.localASR.state
	}
	// The answer is everyone's, so one caller going away must not decide it;
	// the client's timeout bounds the probe.
	state := a.probeLocalDictation(context.WithoutCancel(ctx))
	a.localASR.state, a.localASR.at = state, time.Now()
	return state
}

// probeLocalDictation asks Node Services. Any failure to ask counts as
// unavailable, which only keeps the entry hidden.
func (a *App) probeLocalDictation(ctx context.Context) httpapi.VoiceDictationSettingsLocalModel {
	if a.cfg.NodeServicesURL == "" {
		return httpapi.Unavailable
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(a.cfg.NodeServicesURL, "/")+"/voice/health", nil)
	if err != nil {
		return httpapi.Unavailable
	}
	response, err := localASRClient.Do(request)
	if err != nil {
		return httpapi.Unavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return httpapi.Unavailable
	}
	var health struct {
		Workers  []string `json:"workers"`
		LocalASR string   `json:"local_asr"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&health) != nil {
		return httpapi.Unavailable
	}
	switch {
	case health.LocalASR == "ready" && slices.Contains(health.Workers, "asr"):
		return httpapi.Ready
	case health.LocalASR == "downloading":
		return httpapi.Downloading
	default:
		return httpapi.Unavailable
	}
}

// localDictationEnabled reports whether dictation can run on the downloaded
// speech model: it is ready and a person chose what rewrites the text. It
// decides the same for the policy a client reads and for the session it then
// asks for. Without a voice service nothing can rewrite, so it is off.
func (a *App) localDictationEnabled(ctx context.Context) (bool, error) {
	if a.voice == nil {
		return false, nil
	}
	settings, err := a.voice.DictationSettings(ctx)
	if err != nil || !settings.Chosen {
		return false, err
	}
	return a.localDictationState(ctx) == httpapi.Ready, nil
}
