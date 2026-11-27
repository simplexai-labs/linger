package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func TestLocalDictationState(t *testing.T) {
	answers := map[string]struct {
		status int
		body   string
		state  httpapi.VoiceDictationSettingsLocalModel
	}{
		"ready":                {http.StatusOK, `{"workers":["asr","live"],"local_asr":"ready"}`, httpapi.Ready},
		"model without worker": {http.StatusOK, `{"workers":["live"],"local_asr":"ready"}`, httpapi.Unavailable},
		"downloading":          {http.StatusOK, `{"workers":[],"local_asr":"downloading"}`, httpapi.Downloading},
		"turned off":           {http.StatusOK, `{"workers":[],"local_asr":"disabled"}`, httpapi.Unavailable},
		"older Node Services":  {http.StatusOK, `{"workers":["asr"]}`, httpapi.Unavailable},
		"server error":         {http.StatusInternalServerError, `{}`, httpapi.Unavailable},
		"not JSON":             {http.StatusOK, `ok`, httpapi.Unavailable},
	}
	for name, answer := range answers {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/voice/health" {
					t.Errorf("path = %s", r.URL.Path)
				}
				w.WriteHeader(answer.status)
				_, _ = w.Write([]byte(answer.body))
			}))
			defer server.Close()
			app := &App{cfg: config.Config{NodeServicesURL: server.URL + "/"}}
			if got := app.localDictationState(context.Background()); got != answer.state {
				t.Fatalf("state = %v, want %v", got, answer.state)
			}
		})
	}
}

// A page load or a dictation session must not wait on Node Services each time.
func TestLocalDictationStateIsReusedForAFewSeconds(t *testing.T) {
	var asked int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked++
		_, _ = w.Write([]byte(`{"workers":["asr"],"local_asr":"ready"}`))
	}))
	defer server.Close()
	app := &App{cfg: config.Config{NodeServicesURL: server.URL}}
	for range 5 {
		if app.localDictationState(context.Background()) != httpapi.Ready {
			t.Fatal("not ready")
		}
	}
	if asked != 1 {
		t.Fatalf("Node Services was asked %d times", asked)
	}
	app.localASR.at = time.Now().Add(-2 * localASRCacheTTL)
	if app.localDictationState(context.Background()) != httpapi.Ready || asked != 2 {
		t.Fatalf("an old answer was reused: asked %d times", asked)
	}
}

// A caller that leaves mid-probe must not cache "unavailable" for the others.
func TestLocalDictationStateIgnoresTheCallersCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"workers":["asr"],"local_asr":"ready"}`))
	}))
	defer server.Close()
	app := &App{cfg: config.Config{NodeServicesURL: server.URL}}
	gone, cancel := context.WithCancel(context.Background())
	cancel()
	if got := app.localDictationState(gone); got != httpapi.Ready {
		t.Fatalf("state = %v", got)
	}
	if got := app.localDictationState(context.Background()); got != httpapi.Ready {
		t.Fatalf("cached state = %v", got)
	}
}

func TestLocalDictationStateWithoutNodeServices(t *testing.T) {
	if (&App{}).localDictationState(context.Background()) != httpapi.Unavailable {
		t.Fatal("available without a Node Services URL")
	}
	closed := httptest.NewServer(http.NotFoundHandler())
	url := closed.URL
	closed.Close()
	if (&App{cfg: config.Config{NodeServicesURL: url}}).localDictationState(context.Background()) != httpapi.Unavailable {
		t.Fatal("available with Node Services unreachable")
	}
}
