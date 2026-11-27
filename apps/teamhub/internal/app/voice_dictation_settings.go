package app

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicedictation"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// getVoiceDictationSettings reports how this deployment dictates without a
// Soniox key: the state of the speech model and what rewrites the text.
func (a *App) getVoiceDictationSettings(c *gin.Context) {
	settings, err := a.voiceDictationSettings(c)
	if err != nil {
		a.internalError(c, "read voice dictation settings", err)
		return
	}
	c.JSON(http.StatusOK, settings)
}

// saveVoiceDictationSettings records what rewrites dictated text: the
// connected CLI and its model, or the deployment's own API. Any signed-in
// Human may save it, as for the voice provider keys. The API key is checked
// with the API, stored encrypted and never returned.
func (a *App) saveVoiceDictationSettings(c *gin.Context) {
	var request httpapi.SaveVoiceDictationSettingsRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, string(httpapi.VoiceProviderKeyErrorCodeInvalidRequest), "Voice dictation settings are invalid")
		return
	}
	var err error
	switch request.PolishSource {
	case httpapi.SaveVoiceDictationSettingsRequestPolishSourceCli:
		if request.PolishModel == nil {
			err = voice.ErrInvalidPolishModel
			break
		}
		err = a.voice.SaveDictationCLI(c.Request.Context(), *request.PolishModel)
	case httpapi.SaveVoiceDictationSettingsRequestPolishSourceApi:
		if request.PolishApi == nil {
			err = voice.ErrInvalidPolishAPI
			break
		}
		input := voice.DictationAPIInput{BaseURL: request.PolishApi.BaseUrl, Model: request.PolishApi.Model}
		if request.PolishApi.ApiKey != nil {
			input.Key = *request.PolishApi.ApiKey
		}
		err = a.voice.SaveDictationAPI(c.Request.Context(), input)
	default:
		err = voice.ErrInvalidPolishModel
	}
	if err == nil {
		a.getVoiceDictationSettings(c)
		return
	}
	a.writeVoiceDictationError(c, "save voice dictation settings", err)
}

// listVoiceDictationModels lists the models of the OpenAI-compatible API a
// person is about to save, so they pick one instead of typing it. The key is
// the one typed or, left empty, the saved one for that same address.
func (a *App) listVoiceDictationModels(c *gin.Context) {
	var request httpapi.ListVoiceDictationModelsRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, string(httpapi.VoiceProviderKeyErrorCodeInvalidRequest), "The API address is invalid")
		return
	}
	key := ""
	if request.ApiKey != nil {
		key = *request.ApiKey
	}
	models, err := a.voice.ListDictationModels(c.Request.Context(), request.BaseUrl, key)
	if err != nil {
		a.writeVoiceDictationError(c, "list voice dictation models", err)
		return
	}
	c.JSON(http.StatusOK, httpapi.VoiceDictationModels{Models: models})
}

// writeVoiceDictationError maps what the dictation settings refuse to the
// codes a client words; anything else is an internal error.
func (a *App) writeVoiceDictationError(c *gin.Context, operation string, err error) {
	switch {
	case errors.Is(err, voice.ErrInvalidPolishModel), errors.Is(err, voice.ErrInvalidPolishAPI):
		a.writeError(c, http.StatusBadRequest, string(httpapi.VoiceProviderKeyErrorCodeInvalidRequest), "The rewrite settings are invalid")
	case errors.Is(err, voicedictation.ErrAPIRejected):
		a.writeError(c, http.StatusBadRequest, string(httpapi.VoiceProviderKeyErrorCodeVoiceKeyRejected), "The API rejected this key")
	case errors.Is(err, voicedictation.ErrAPIUnreachable):
		a.writeError(c, http.StatusServiceUnavailable, string(httpapi.VoiceProviderKeyErrorCodeVoiceProviderUnavailable), "The API could not be reached; try again")
	case errors.Is(err, voice.ErrDictationKeyStorage):
		a.writeError(c, http.StatusServiceUnavailable, string(httpapi.VoiceProviderKeyErrorCodeVoiceKeyStorageUnavailable), "This deployment cannot store an API key")
	default:
		a.internalError(c, operation, err)
	}
}

func (a *App) voiceDictationSettings(c *gin.Context) (httpapi.VoiceDictationSettings, error) {
	settings, err := a.voice.DictationSettings(c.Request.Context())
	if err != nil {
		return httpapi.VoiceDictationSettings{}, err
	}
	response := httpapi.VoiceDictationSettings{
		LocalModel:         a.localDictationState(c.Request.Context()),
		DefaultPolishModel: voicedictation.DefaultPolishModel,
		CanSaveApiKey:      settings.CanSaveAPIKey,
	}
	if settings.PolishModel != "" {
		response.PolishModel = &settings.PolishModel
	}
	if settings.Chosen {
		source := httpapi.VoiceDictationSettingsPolishSource(settings.Source)
		response.PolishSource = &source
	}
	if settings.API != nil {
		response.PolishApi = &httpapi.VoiceDictationPolishApi{
			BaseUrl: settings.API.BaseURL, Model: settings.API.Model, KeySaved: settings.API.KeySaved,
		}
	}
	return response, nil
}
