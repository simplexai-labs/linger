package voice

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentregistry"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

const (
	// SpeechProviderAuto prefers a ready local speech model and falls back to cloud Soniox.
	SpeechProviderAuto = "auto"
	// SpeechProviderLocal requires local speech transcription.
	SpeechProviderLocal = "local"
	// SpeechProviderCloud requires cloud Soniox transcription.
	SpeechProviderCloud = "cloud"

	// DefaultVoiceKeepLoadedSeconds is the unified 15-minute idle unload default.
	DefaultVoiceKeepLoadedSeconds = 900
	// DefaultVoiceLanguage auto-detects spoken language.
	DefaultVoiceLanguage = "auto"
)

var (
	// ErrInvalidVoiceSettings reports an invalid voice settings request field.
	ErrInvalidVoiceSettings = errors.New("voice settings are invalid")

	voiceLanguagePattern = regexp.MustCompile(`^(auto|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*)$`)
	voiceModelIDPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$`)
	voiceIDPattern       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
)

// Settings holds per-account, per-tenant voice transcription preferences.
type Settings struct {
	SpeechProvider  string
	LocalComputerID *string
	LocalModelID    *string
	Language        string
	// SilenceTimeoutSeconds is enforced client-side by the Web dictation client
	// so auto-stop behaves identically across local STT and cloud Soniox.
	SilenceTimeoutSeconds int
	UseGPU                bool
	KeepLoadedSeconds     int
	UpdatedAt             *time.Time
}

// SettingsUpdate describes fields to change on Settings. Set* booleans allow
// distinguishing an omitted field from an explicit null reset.
type SettingsUpdate struct {
	SpeechProvider        *string
	SetLocalComputerID    bool
	LocalComputerID       *string
	SetLocalModelID       bool
	LocalModelID          *string
	Language              *string
	SilenceTimeoutSeconds *int
	UseGPU                *bool
	KeepLoadedSeconds     *int
}

// SpeechResolution is the effective transcription backend for one Human Actor
// in one Tenant at a point in time.
type SpeechResolution struct {
	Settings             Settings
	LocalSpeechAvailable bool
	LocalSpeechReady     bool
	ActiveSpeechProvider string
	Dispatch             *voicemedia.SpeechDispatchConfig
}

type speechSnapshotSummary struct {
	Available bool `json:"available"`
	Config    *struct {
		ModelID *string `json:"model_id"`
	} `json:"config"`
	Models []struct {
		ID    string `json:"id"`
		State string `json:"state"`
	} `json:"models"`
}

func defaultVoiceSettings() Settings {
	return Settings{
		SpeechProvider:        SpeechProviderAuto,
		Language:              DefaultVoiceLanguage,
		SilenceTimeoutSeconds: 0,
		UseGPU:                true,
		KeepLoadedSeconds:     DefaultVoiceKeepLoadedSeconds,
	}
}

func settingsFromRow(row store.VoiceSetting) Settings {
	settings := Settings{
		SpeechProvider:        row.SpeechProvider,
		Language:              row.Language,
		SilenceTimeoutSeconds: int(row.SilenceTimeoutSeconds),
		UseGPU:                row.UseGpu,
		KeepLoadedSeconds:     int(row.KeepLoadedSeconds),
	}
	if row.LocalComputerID.Valid && row.LocalComputerID.String != "" {
		v := row.LocalComputerID.String
		settings.LocalComputerID = &v
	}
	if row.LocalModelID.Valid && row.LocalModelID.String != "" {
		v := row.LocalModelID.String
		settings.LocalModelID = &v
	}
	if row.UpdatedAt.Valid {
		t := row.UpdatedAt.Time.UTC()
		settings.UpdatedAt = &t
	}
	return settings
}

// VoiceSettings reads the caller's voice settings in tenantID, returning defaults
// when no row has been saved yet.
func (s *Service) VoiceSettings(ctx context.Context, accountID, tenantID string) (Settings, error) {
	row, err := s.queries.GetVoiceSettings(ctx, store.GetVoiceSettingsParams{
		AccountID: accountID,
		TenantID:  tenantID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return defaultVoiceSettings(), nil
	}
	if err != nil {
		return Settings{}, err
	}
	return settingsFromRow(row), nil
}

// UpdateVoiceSettings validates and saves the caller's voice settings in tenantID.
func (s *Service) UpdateVoiceSettings(ctx context.Context, accountID, tenantID string, update SettingsUpdate) (Settings, error) {
	current, err := s.VoiceSettings(ctx, accountID, tenantID)
	if err != nil {
		return Settings{}, err
	}
	if update.SpeechProvider != nil {
		provider := strings.TrimSpace(*update.SpeechProvider)
		if provider != SpeechProviderAuto && provider != SpeechProviderLocal && provider != SpeechProviderCloud {
			return Settings{}, ErrInvalidVoiceSettings
		}
		current.SpeechProvider = provider
	}
	if update.SetLocalComputerID {
		if update.LocalComputerID == nil || strings.TrimSpace(*update.LocalComputerID) == "" {
			current.LocalComputerID = nil
		} else {
			v := strings.TrimSpace(*update.LocalComputerID)
			if !voiceIDPattern.MatchString(v) {
				return Settings{}, ErrInvalidVoiceSettings
			}
			current.LocalComputerID = &v
		}
	}
	if update.SetLocalModelID {
		if update.LocalModelID == nil || strings.TrimSpace(*update.LocalModelID) == "" {
			current.LocalModelID = nil
		} else {
			v := strings.TrimSpace(*update.LocalModelID)
			if !voiceModelIDPattern.MatchString(v) {
				return Settings{}, ErrInvalidVoiceSettings
			}
			current.LocalModelID = &v
		}
	}
	if update.Language != nil {
		lang := strings.TrimSpace(*update.Language)
		if len(lang) > 32 || !voiceLanguagePattern.MatchString(lang) {
			return Settings{}, ErrInvalidVoiceSettings
		}
		current.Language = lang
	}
	// Enforced client-side by the Web dictation client across both local and
	// cloud transcription; 0 disables auto-stop.
	if update.SilenceTimeoutSeconds != nil {
		if *update.SilenceTimeoutSeconds < 0 || *update.SilenceTimeoutSeconds > 300 {
			return Settings{}, ErrInvalidVoiceSettings
		}
		current.SilenceTimeoutSeconds = *update.SilenceTimeoutSeconds
	}
	if update.UseGPU != nil {
		current.UseGPU = *update.UseGPU
	}
	if update.KeepLoadedSeconds != nil {
		if *update.KeepLoadedSeconds < -1 || *update.KeepLoadedSeconds > 86400 {
			return Settings{}, ErrInvalidVoiceSettings
		}
		current.KeepLoadedSeconds = *update.KeepLoadedSeconds
	}

	var localComputerID pgtype.Text
	if current.LocalComputerID != nil {
		localComputerID = pgtype.Text{String: *current.LocalComputerID, Valid: true}
	}
	var localModelID pgtype.Text
	if current.LocalModelID != nil {
		localModelID = pgtype.Text{String: *current.LocalModelID, Valid: true}
	}
	row, err := s.queries.UpsertVoiceSettings(ctx, store.UpsertVoiceSettingsParams{
		AccountID:             accountID,
		TenantID:              tenantID,
		SpeechProvider:        current.SpeechProvider,
		LocalComputerID:       localComputerID,
		LocalModelID:          localModelID,
		Language:              current.Language,
		SilenceTimeoutSeconds: int32(current.SilenceTimeoutSeconds),
		UseGpu:                current.UseGPU,
		KeepLoadedSeconds:     int32(current.KeepLoadedSeconds),
	})
	if err != nil {
		return Settings{}, err
	}
	return settingsFromRow(row), nil
}

// ResolveSpeechState computes whether local speech is available/ready and which
// transcription backend (local, cloud, or none) is active for the caller.
func (s *Service) ResolveSpeechState(
	ctx context.Context,
	accountID, tenantID, actorID string,
	sonioxConfigured bool,
	localASRURL string,
	now time.Time,
) (SpeechResolution, error) {
	settings, err := s.VoiceSettings(ctx, accountID, tenantID)
	if err != nil {
		return SpeechResolution{}, err
	}
	computers, err := s.queries.ListOwnedLocalSpeechComputers(ctx, store.ListOwnedLocalSpeechComputersParams{
		TenantID:     tenantID,
		OwnerActorID: actorID,
	})
	if err != nil {
		return SpeechResolution{}, err
	}
	return evaluateSpeechResolution(settings, computers, tenantID, actorID, sonioxConfigured, localASRURL, now), nil
}

// HasLocalSpeechEnabled reports whether any non-removed Computer has reported
// available local speech or any account selected local speech mode.
func (s *Service) HasLocalSpeechEnabled(ctx context.Context) (bool, error) {
	enabled, err := s.queries.HasAnyAvailableLocalSpeechComputer(ctx)
	if err != nil {
		return false, err
	}
	return enabled.Valid && enabled.Bool, nil
}

// RoomAccountContext resolves the Tenant and Human Actor ID for an authorized Room.
func (s *Service) RoomAccountContext(ctx context.Context, accountID, roomID string) (tenantID, actorID string, err error) {
	row, err := s.queries.GetRoomForAccount(ctx, store.GetRoomForAccountParams{
		ID:        roomID,
		AccountID: pgtype.Text{String: accountID, Valid: true},
	})
	if err != nil {
		return "", "", err
	}
	policy, err := s.queries.GetVoiceMediaPolicyForAccount(ctx, store.GetVoiceMediaPolicyForAccountParams{
		AccountID:     accountID,
		TenantID:      row.TenantID,
		AuthSessionID: "",
	})
	if err != nil {
		return "", "", err
	}
	return row.TenantID, policy.ActorID, nil
}

func evaluateSpeechResolution(
	settings Settings,
	computers []store.ListOwnedLocalSpeechComputersRow,
	tenantID, actorID string,
	sonioxConfigured bool,
	localASRURL string,
	now time.Time,
) SpeechResolution {
	res := SpeechResolution{
		Settings:             settings,
		ActiveSpeechProvider: "none",
	}

	preferredComputerID := ""
	if settings.LocalComputerID != nil {
		preferredComputerID = *settings.LocalComputerID
	}
	preferredModelID := ""
	if settings.LocalModelID != nil {
		preferredModelID = *settings.LocalModelID
	}

	var chosenComputerID, chosenModelID string
	for _, computer := range computers {
		if !computerIsOnline(computer.Status, computer.LastSeenAt, now) || len(computer.SpeechSnapshot) == 0 {
			continue
		}
		var snap speechSnapshotSummary
		if err := json.Unmarshal(computer.SpeechSnapshot, &snap); err != nil || !snap.Available {
			continue
		}
		res.LocalSpeechAvailable = true
		if preferredComputerID != "" && computer.ComputerID != preferredComputerID {
			continue
		}
		modelID := pickDownloadedSpeechModel(snap, preferredModelID)
		if modelID == "" {
			continue
		}
		if chosenComputerID == "" {
			chosenComputerID = computer.ComputerID
			chosenModelID = modelID
		}
	}

	if chosenComputerID != "" {
		res.LocalSpeechReady = true
	} else if strings.TrimSpace(localASRURL) != "" {
		// Headless server-level override allows local speech without an enrolled Computer.
		res.LocalSpeechAvailable = true
		res.LocalSpeechReady = true
		chosenModelID = preferredModelID
		if chosenModelID == "" {
			chosenModelID = "default"
		}
	}

	switch settings.SpeechProvider {
	case SpeechProviderLocal:
		if res.LocalSpeechReady {
			res.ActiveSpeechProvider = "local"
		}
	case SpeechProviderCloud:
		if sonioxConfigured {
			res.ActiveSpeechProvider = "cloud"
		}
	default:
		if res.LocalSpeechReady {
			res.ActiveSpeechProvider = "local"
		} else if sonioxConfigured {
			res.ActiveSpeechProvider = "cloud"
		}
	}

	useGPU := settings.UseGPU
	keepLoaded := settings.KeepLoadedSeconds
	switch res.ActiveSpeechProvider {
	case "local":
		res.Dispatch = &voicemedia.SpeechDispatchConfig{
			Provider:          "local",
			ComputerID:        chosenComputerID,
			ModelID:           chosenModelID,
			Language:          settings.Language,
			UseGPU:            &useGPU,
			KeepLoadedSeconds: &keepLoaded,
			TenantID:          tenantID,
			OwnerActorID:      actorID,
		}
	case "cloud":
		res.Dispatch = &voicemedia.SpeechDispatchConfig{
			Provider: "cloud",
			Language: settings.Language,
		}
	}
	return res
}

func computerIsOnline(status string, lastSeen pgtype.Timestamptz, now time.Time) bool {
	if status != "online" || !lastSeen.Valid {
		return false
	}
	t := lastSeen.Time
	return !t.After(now) && now.Sub(t) <= agentregistry.LocalComputerObservationFreshness
}

func speechModelDownloaded(state string) bool {
	return state == "idle" || state == "loading" || state == "loaded"
}

func pickDownloadedSpeechModel(snap speechSnapshotSummary, preferredModelID string) string {
	if preferredModelID != "" {
		for _, m := range snap.Models {
			if m.ID == preferredModelID && speechModelDownloaded(m.State) {
				return m.ID
			}
		}
		return ""
	}
	if snap.Config != nil && snap.Config.ModelID != nil && *snap.Config.ModelID != "" {
		for _, m := range snap.Models {
			if m.ID == *snap.Config.ModelID && speechModelDownloaded(m.State) {
				return m.ID
			}
		}
	}
	for _, m := range snap.Models {
		if speechModelDownloaded(m.State) {
			return m.ID
		}
	}
	return ""
}
