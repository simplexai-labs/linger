package app

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

type voiceSettingsPatchBody struct {
	SpeechProvider        *string         `json:"speech_provider"`
	LocalComputerID       json.RawMessage `json:"local_computer_id"`
	LocalModelID          json.RawMessage `json:"local_model_id"`
	Language              *string         `json:"language"`
	SilenceTimeoutSeconds *int            `json:"silence_timeout_seconds"`
	UseGPU                *bool           `json:"use_gpu"`
	KeepLoadedSeconds     *int            `json:"keep_loaded_seconds"`
}

// getVoiceSettings returns the caller's voice transcription settings in one Tenant.
func (a *App) getVoiceSettings(c *gin.Context) {
	tenantID := c.Param("tenantId")
	if _, ok := a.spaceHuman(c, tenantID); !ok {
		return
	}
	settings, err := a.voice.VoiceSettings(c.Request.Context(), currentPrincipal(c).Session.AccountID, tenantID)
	if a.writeVoiceMediaError(c, "read voice settings", err) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, voiceSettingsModel(settings))
}

// updateVoiceSettings updates the caller's voice transcription settings in one
// Tenant and wakes Node Services voice workers when local speech mode changes.
func (a *App) updateVoiceSettings(c *gin.Context) {
	tenantID := c.Param("tenantId")
	if _, ok := a.spaceHuman(c, tenantID); !ok {
		return
	}
	var raw map[string]json.RawMessage
	if decodeJSON(c, &raw) != nil || raw == nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Voice settings request must be a JSON object")
		return
	}
	allowed := map[string]bool{
		"speech_provider":         true,
		"local_computer_id":       true,
		"local_model_id":          true,
		"language":                true,
		"silence_timeout_seconds": true,
		"use_gpu":                 true,
		"keep_loaded_seconds":     true,
	}
	for key := range raw {
		if !allowed[key] {
			a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Voice settings request contains an unknown field")
			return
		}
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Voice settings request is invalid")
		return
	}
	var body voiceSettingsPatchBody
	if err := json.Unmarshal(encoded, &body); err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Voice settings request is invalid")
		return
	}
	update := voice.SettingsUpdate{
		SpeechProvider:        body.SpeechProvider,
		Language:              body.Language,
		SilenceTimeoutSeconds: body.SilenceTimeoutSeconds,
		UseGPU:                body.UseGPU,
		KeepLoadedSeconds:     body.KeepLoadedSeconds,
	}
	if _, hasComputer := raw["local_computer_id"]; hasComputer {
		update.SetLocalComputerID = true
		value, ok := decodeNullableString(body.LocalComputerID)
		if !ok {
			a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "local_computer_id must be a string or null")
			return
		}
		update.LocalComputerID = value
	}
	if _, hasModel := raw["local_model_id"]; hasModel {
		update.SetLocalModelID = true
		value, ok := decodeNullableString(body.LocalModelID)
		if !ok {
			a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "local_model_id must be a string or null")
			return
		}
		update.LocalModelID = value
	}

	accountID := currentPrincipal(c).Session.AccountID
	before, err := a.voice.VoiceSettings(c.Request.Context(), accountID, tenantID)
	if a.writeVoiceMediaError(c, "read previous voice settings", err) {
		return
	}
	updated, err := a.voice.UpdateVoiceSettings(c.Request.Context(), accountID, tenantID, update)
	if errors.Is(err, voice.ErrInvalidVoiceSettings) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Voice settings are invalid")
		return
	}
	if a.writeVoiceMediaError(c, "update voice settings", err) {
		return
	}
	if before.SpeechProvider != updated.SpeechProvider ||
		updated.SpeechProvider == voice.SpeechProviderLocal ||
		updated.SpeechProvider == voice.SpeechProviderAuto {
		a.awaitVoiceWorkers(c.Request.Context())
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, voiceSettingsModel(updated))
}

func decodeNullableString(raw json.RawMessage) (*string, bool) {
	if string(raw) == "null" {
		return nil, true
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, false
	}
	return &value, true
}

func voiceSettingsModel(settings voice.Settings) httpapi.VoiceSettings {
	return httpapi.VoiceSettings{
		SpeechProvider:        httpapi.VoiceSpeechProvider(settings.SpeechProvider),
		LocalComputerId:       settings.LocalComputerID,
		LocalModelId:          settings.LocalModelID,
		Language:              settings.Language,
		SilenceTimeoutSeconds: settings.SilenceTimeoutSeconds,
		UseGpu:                settings.UseGPU,
		KeepLoadedSeconds:     settings.KeepLoadedSeconds,
		UpdatedAt:             settings.UpdatedAt,
	}
}
