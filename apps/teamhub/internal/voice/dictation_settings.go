package voice

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicedictation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicekey"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

// DictationAPI rewrites dictated text on a deployment's own OpenAI-compatible
// API, checks a key against it and lists the models it offers.
type DictationAPI interface {
	Polish(ctx context.Context, config voicedictation.APIConfig, text string) (string, error)
	Probe(ctx context.Context, config voicedictation.APIConfig) error
	ListModels(ctx context.Context, config voicedictation.APIConfig) ([]string, error)
}

// dictationStore is the part of the store the dictation settings use, so their
// rules are tested without a database.
type dictationStore interface {
	GetVoiceDictationSettings(ctx context.Context) (store.GetVoiceDictationSettingsRow, error)
	SaveVoiceDictationCLI(ctx context.Context, polishModel string) error
	SaveVoiceDictationAPI(ctx context.Context, arg store.SaveVoiceDictationAPIParams) error
	GetVoiceRuntimeSessionContext(ctx context.Context, id string) (store.GetVoiceRuntimeSessionContextRow, error)
}

// Sources of the text rewrite: the connected CLI, or the deployment's own API.
const (
	DictationSourceCLI = "cli"
	DictationSourceAPI = "api"
)

// Refusals of a dictation settings save; the handler maps each to its code.
var (
	// ErrInvalidPolishModel reports a CLI model name the Claude CLI could not take.
	ErrInvalidPolishModel = errors.New("dictation polish model is invalid")
	// ErrInvalidPolishAPI reports an API address, model or key that cannot be used.
	ErrInvalidPolishAPI = errors.New("dictation polish API is invalid")
	// ErrDictationKeyStorage reports a deployment with no secret encryption key.
	ErrDictationKeyStorage = errors.New("the deployment cannot store an API key")
	// ErrDictationPolishUnavailable reports that nothing can rewrite a dictated
	// passage now. The runtime keeps the recognized text.
	ErrDictationPolishUnavailable = errors.New("dictation polish is unavailable")
)

// DictationAPISettings is the deployment's own API for rewriting text. The key
// is never part of it.
type DictationAPISettings struct {
	BaseURL, Model string
	KeySaved       bool
}

// DictationSettings is how the deployment rewrites dictated text.
type DictationSettings struct {
	// Chosen reports whether a person chose: a CLI model, or an API whose key
	// can be read. Dictation on the downloaded speech model stays off until then.
	Chosen bool
	// Source is DictationSourceCLI or DictationSourceAPI; empty until chosen.
	Source string
	// PolishModel is the CLI model, whatever the source, so switching back keeps it.
	PolishModel string
	API         *DictationAPISettings
	// CanSaveAPIKey is false when the deployment has no secret encryption key.
	CanSaveAPIKey bool
}

// DictationSettings reads how dictated text is rewritten.
func (s *Service) DictationSettings(ctx context.Context) (DictationSettings, error) {
	settings := DictationSettings{CanSaveAPIKey: s.dictationBox != nil}
	row, err := s.dictationStore.GetVoiceDictationSettings(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return settings, nil
	}
	if err != nil {
		return settings, fmt.Errorf("read dictation settings: %w", err)
	}
	settings.PolishModel = row.PolishModel
	settings.Source = row.PolishSource
	settings.Chosen = true
	if len(row.PolishApiKeyCiphertext) > 0 {
		settings.API = &DictationAPISettings{BaseURL: row.PolishApiBaseUrl.String, Model: row.PolishApiModel.String, KeySaved: true}
	}
	// A key sealed under another encryption key is unusable, so the API source
	// is not chosen until a new save replaces it.
	if row.PolishSource == DictationSourceAPI {
		if _, err := s.dictationAPIConfig(row); err != nil {
			settings.Chosen = false
		}
	}
	return settings, nil
}

// SaveDictationCLI chooses the connected CLI, and the model it runs on.
func (s *Service) SaveDictationCLI(ctx context.Context, model string) error {
	if !voicedictation.ValidModel(model) {
		return ErrInvalidPolishModel
	}
	if err := s.dictationStore.SaveVoiceDictationCLI(ctx, model); err != nil {
		return fmt.Errorf("save dictation CLI settings: %w", err)
	}
	return nil
}

// DictationAPIInput is what a person typed for the deployment's own API.
type DictationAPIInput struct {
	BaseURL, Model string
	// Key is empty to keep the key already saved.
	Key string
}

// SaveDictationAPI chooses the deployment's own API. The key is checked against
// the API first, then sealed; the voicedictation errors say what it refused.
func (s *Service) SaveDictationAPI(ctx context.Context, input DictationAPIInput) error {
	baseURL, err := voicedictation.NormalizeAPIBaseURL(input.BaseURL)
	if err != nil || !voicedictation.ValidAPIModel(input.Model) || len(input.Key) > voicekey.MaxKeyBytes {
		return ErrInvalidPolishAPI
	}
	if s.dictationBox == nil {
		return ErrDictationKeyStorage
	}
	existing, err := s.dictationStore.GetVoiceDictationSettings(ctx)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("read dictation settings: %w", err)
	}
	key := strings.TrimSpace(input.Key)
	var sealed []byte
	if key != "" {
		if sealed, err = s.dictationBox.Seal([]byte(key)); err != nil {
			return fmt.Errorf("seal dictation API key: %w", err)
		}
	} else {
		if key, err = s.savedAPIKey(existing, baseURL); err != nil {
			return ErrInvalidPolishAPI
		}
		sealed = existing.PolishApiKeyCiphertext
	}
	config := voicedictation.APIConfig{BaseURL: baseURL, Model: input.Model, Key: key}
	if err := s.dictationAPI.Probe(ctx, config); err != nil {
		return err
	}
	cliModel := existing.PolishModel
	if cliModel == "" {
		cliModel = voicedictation.DefaultPolishModel
	}
	if err := s.dictationStore.SaveVoiceDictationAPI(ctx, store.SaveVoiceDictationAPIParams{
		PolishModel: cliModel, PolishApiBaseUrl: pgtype.Text{String: baseURL, Valid: true},
		PolishApiModel: pgtype.Text{String: input.Model, Valid: true}, PolishApiKeyCiphertext: sealed,
	}); err != nil {
		return fmt.Errorf("save dictation API settings: %w", err)
	}
	return nil
}

// savedAPIKey opens the key saved in row for the API at baseURL. The saved key
// goes only to the address it was saved for, whether it is then probed, used to
// list models or stored again: otherwise a person could send it to a host of
// their choosing.
func (s *Service) savedAPIKey(row store.GetVoiceDictationSettingsRow, baseURL string) (string, error) {
	config, err := s.dictationAPIConfig(row)
	if err != nil || config.BaseURL != baseURL {
		return "", ErrInvalidPolishAPI
	}
	return config.Key, nil
}

// ListDictationModels lists the models the API at baseURL offers. An empty key
// stands for the one saved for that same address.
func (s *Service) ListDictationModels(ctx context.Context, baseURL, key string) ([]string, error) {
	baseURL, err := voicedictation.NormalizeAPIBaseURL(baseURL)
	key = strings.TrimSpace(key)
	if err != nil || len(key) > voicekey.MaxKeyBytes {
		return nil, ErrInvalidPolishAPI
	}
	if key == "" {
		row, err := s.dictationStore.GetVoiceDictationSettings(ctx)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrInvalidPolishAPI
		}
		if err != nil {
			return nil, fmt.Errorf("read dictation settings: %w", err)
		}
		if key, err = s.savedAPIKey(row, baseURL); err != nil {
			return nil, ErrInvalidPolishAPI
		}
	}
	return s.dictationAPI.ListModels(ctx, voicedictation.APIConfig{BaseURL: baseURL, Key: key})
}

// dictationAPIConfig opens the saved key of an API row.
func (s *Service) dictationAPIConfig(row store.GetVoiceDictationSettingsRow) (voicedictation.APIConfig, error) {
	if s.dictationBox == nil || len(row.PolishApiKeyCiphertext) == 0 {
		return voicedictation.APIConfig{}, ErrDictationPolishUnavailable
	}
	key, err := s.dictationBox.Open(row.PolishApiKeyCiphertext)
	if err != nil {
		return voicedictation.APIConfig{}, ErrDictationPolishUnavailable
	}
	return voicedictation.APIConfig{BaseURL: row.PolishApiBaseUrl.String, Model: row.PolishApiModel.String, Key: string(key)}, nil
}

// PolishDictation rewrites one dictated passage of a live chat dictation
// session: on the deployment's own API when one was chosen, else on the
// session owner's connected CLI.
func (s *Service) PolishDictation(ctx context.Context, voiceSessionID, text string) (string, error) {
	if len(text) > voicedictation.MaxTextBytes {
		return "", ErrDictationPolishUnavailable
	}
	session, err := s.dictationStore.GetVoiceRuntimeSessionContext(ctx, voiceSessionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrVoiceSessionNotFound
	}
	if err != nil {
		return "", fmt.Errorf("resolve Voice Runtime session: %w", err)
	}
	if session.Purpose != voicemedia.PurposeChatDictation {
		return "", ErrVoicePurposeConflict
	}
	row, err := s.dictationStore.GetVoiceDictationSettings(ctx)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", errors.Join(ErrDictationPolishUnavailable, err)
	}
	var polished string
	if row.PolishSource == DictationSourceAPI {
		config, configErr := s.dictationAPIConfig(row)
		if configErr != nil {
			return "", configErr
		}
		polished, err = s.dictationAPI.Polish(ctx, config, text)
	} else {
		if s.dictationPolisher == nil {
			return "", ErrDictationPolishUnavailable
		}
		model := row.PolishModel
		if model == "" {
			model = voicedictation.DefaultPolishModel
		}
		polished, err = s.dictationPolisher.Polish(ctx,
			roomagent.ModelCallOwner{TenantID: session.TenantID, OwnerActorID: session.CreatedByActorID}, session.ID, model, text)
	}
	if err != nil || polished == "" {
		return "", errors.Join(ErrDictationPolishUnavailable, err)
	}
	return polished, nil
}
