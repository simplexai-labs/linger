package voice

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestEvaluateSpeechResolution(t *testing.T) {
	now := time.Date(2026, 11, 26, 14, 0, 0, 0, time.UTC)
	fresh := pgtype.Timestamptz{Time: now.Add(-10 * time.Second), Valid: true}
	stale := pgtype.Timestamptz{Time: now.Add(-5 * time.Minute), Valid: true}

	readySnap := json.RawMessage(`{"available":true,"config":{"model_id":"sensevoice-small"},"models":[{"id":"sensevoice-small","state":"idle"},{"id":"whisper-large-v3-turbo","state":"absent"}]}`)
	absentSnap := json.RawMessage(`{"available":true,"models":[{"id":"sensevoice-small","state":"absent"}]}`)
	unsupportedSnap := json.RawMessage(`{"available":false,"models":[]}`)

	t.Run("auto prefers ready local model over cloud soniox", func(t *testing.T) {
		res := evaluateSpeechResolution(defaultVoiceSettings(), []store.ListOwnedLocalSpeechComputersRow{
			{ComputerID: "comp_1", Status: "online", LastSeenAt: fresh, SpeechSnapshot: readySnap},
		}, "ten_1", "act_1", true, "", now)
		if !res.LocalSpeechAvailable || !res.LocalSpeechReady || res.ActiveSpeechProvider != "local" {
			t.Fatalf("unexpected resolution: %+v", res)
		}
		if res.Dispatch == nil || res.Dispatch.Provider != "local" || res.Dispatch.ComputerID != "comp_1" || res.Dispatch.ModelID != "sensevoice-small" {
			t.Fatalf("unexpected dispatch: %+v", res.Dispatch)
		}
		if res.Dispatch.KeepLoadedSeconds == nil || *res.Dispatch.KeepLoadedSeconds != 900 {
			t.Fatalf("expected default keep_loaded_seconds=900, got %+v", res.Dispatch)
		}
	})

	t.Run("auto falls back to cloud when no local model downloaded", func(t *testing.T) {
		res := evaluateSpeechResolution(defaultVoiceSettings(), []store.ListOwnedLocalSpeechComputersRow{
			{ComputerID: "comp_1", Status: "online", LastSeenAt: fresh, SpeechSnapshot: absentSnap},
		}, "ten_1", "act_1", true, "", now)
		if !res.LocalSpeechAvailable || res.LocalSpeechReady || res.ActiveSpeechProvider != "cloud" {
			t.Fatalf("unexpected resolution: %+v", res)
		}
		if res.Dispatch == nil || res.Dispatch.Provider != "cloud" || res.Dispatch.Language != "auto" {
			t.Fatalf("unexpected dispatch: %+v", res.Dispatch)
		}
	})

	t.Run("local mode stays none when target computer is offline or unsupported", func(t *testing.T) {
		settings := defaultVoiceSettings()
		settings.SpeechProvider = SpeechProviderLocal
		res := evaluateSpeechResolution(settings, []store.ListOwnedLocalSpeechComputersRow{
			{ComputerID: "comp_offline", Status: "online", LastSeenAt: stale, SpeechSnapshot: readySnap},
			{ComputerID: "comp_unsup", Status: "online", LastSeenAt: fresh, SpeechSnapshot: unsupportedSnap},
		}, "ten_1", "act_1", true, "", now)
		if res.LocalSpeechAvailable || res.LocalSpeechReady || res.ActiveSpeechProvider != "none" || res.Dispatch != nil {
			t.Fatalf("expected none, got %+v", res)
		}
	})

	t.Run("cloud mode uses cloud even when local model is ready", func(t *testing.T) {
		settings := defaultVoiceSettings()
		settings.SpeechProvider = SpeechProviderCloud
		settings.Language = "ja"
		res := evaluateSpeechResolution(settings, []store.ListOwnedLocalSpeechComputersRow{
			{ComputerID: "comp_1", Status: "online", LastSeenAt: fresh, SpeechSnapshot: readySnap},
		}, "ten_1", "act_1", true, "", now)
		if !res.LocalSpeechReady || res.ActiveSpeechProvider != "cloud" {
			t.Fatalf("unexpected resolution: %+v", res)
		}
		if res.Dispatch == nil || res.Dispatch.Provider != "cloud" || res.Dispatch.Language != "ja" {
			t.Fatalf("expected cloud with ja language, got %+v", res.Dispatch)
		}
	})

	t.Run("headless local ASR URL satisfies local readiness without computer", func(t *testing.T) {
		settings := defaultVoiceSettings()
		settings.SpeechProvider = SpeechProviderLocal
		res := evaluateSpeechResolution(settings, nil, "ten_1", "act_1", false, "http://speech:8080", now)
		if !res.LocalSpeechAvailable || !res.LocalSpeechReady || res.ActiveSpeechProvider != "local" {
			t.Fatalf("unexpected headless resolution: %+v", res)
		}
		if res.Dispatch == nil || res.Dispatch.ComputerID != "" || res.Dispatch.ModelID != "default" {
			t.Fatalf("unexpected headless dispatch: %+v", res.Dispatch)
		}
	})
}
