package voice

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/secretbox"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicedictation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

const (
	savedAddress = "https://api.deepseek.com/v1"
	otherAddress = "https://attacker.example/v1"
	savedKey     = "sk-saved"
)

func testBox(t *testing.T, fill byte) *secretbox.Box {
	t.Helper()
	box, err := secretbox.New(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{fill}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	return box
}

// fakeStore is one settings row and one voice session in memory.
type fakeStore struct {
	row        store.GetVoiceDictationSettingsRow
	empty      bool
	session    store.GetVoiceRuntimeSessionContextRow
	sessionErr error
	savedCLI   *string
	savedAPI   *store.SaveVoiceDictationAPIParams
}

func (f *fakeStore) GetVoiceDictationSettings(context.Context) (store.GetVoiceDictationSettingsRow, error) {
	if f.empty {
		return store.GetVoiceDictationSettingsRow{}, pgx.ErrNoRows
	}
	return f.row, nil
}

func (f *fakeStore) SaveVoiceDictationCLI(_ context.Context, model string) error {
	f.savedCLI = &model
	return nil
}

func (f *fakeStore) SaveVoiceDictationAPI(_ context.Context, arg store.SaveVoiceDictationAPIParams) error {
	f.savedAPI = &arg
	return nil
}

func (f *fakeStore) GetVoiceRuntimeSessionContext(context.Context, string) (store.GetVoiceRuntimeSessionContextRow, error) {
	return f.session, f.sessionErr
}

// fakeAPI records which key went to which address, and answers as told.
type fakeAPI struct {
	probes, lists, polishes []voicedictation.APIConfig
	probeErr, listErr       error
	models                  []string
	polished                string
	polishErr               error
}

func (f *fakeAPI) Probe(_ context.Context, config voicedictation.APIConfig) error {
	f.probes = append(f.probes, config)
	return f.probeErr
}

func (f *fakeAPI) ListModels(_ context.Context, config voicedictation.APIConfig) ([]string, error) {
	f.lists = append(f.lists, config)
	return f.models, f.listErr
}

func (f *fakeAPI) Polish(_ context.Context, config voicedictation.APIConfig, _ string) (string, error) {
	f.polishes = append(f.polishes, config)
	return f.polished, f.polishErr
}

type fakePolisher struct {
	models []string
	owner  roomagent.ModelCallOwner
	text   string
	err    error
}

func (f *fakePolisher) Polish(_ context.Context, owner roomagent.ModelCallOwner, _, model, _ string) (string, error) {
	f.models, f.owner = append(f.models, model), owner
	return f.text, f.err
}

// savedAPIRow is a deployment that chose the API at savedAddress with savedKey.
func savedAPIRow(t *testing.T, box *secretbox.Box) store.GetVoiceDictationSettingsRow {
	t.Helper()
	sealed, err := box.Seal([]byte(savedKey))
	if err != nil {
		t.Fatal(err)
	}
	return store.GetVoiceDictationSettingsRow{
		PolishModel: "haiku", PolishSource: DictationSourceAPI,
		PolishApiBaseUrl: pgtype.Text{String: savedAddress, Valid: true}, PolishApiModel: pgtype.Text{String: "deepseek-chat", Valid: true},
		PolishApiKeyCiphertext: sealed,
	}
}

func newDictationService(rows *fakeStore, api *fakeAPI, box *secretbox.Box) *Service {
	return &Service{dictationStore: rows, dictationAPI: api, dictationBox: box}
}

func TestSaveDictationAPIUsesASavedKeyOnlyAtItsOwnAddress(t *testing.T) {
	box := testBox(t, 1)
	rows := &fakeStore{row: savedAPIRow(t, box)}
	api := &fakeAPI{}
	s := newDictationService(rows, api, box)

	// A new address with no new key must not carry the saved key anywhere.
	err := s.SaveDictationAPI(context.Background(), DictationAPIInput{BaseURL: otherAddress, Model: "m"})
	if !errors.Is(err, ErrInvalidPolishAPI) {
		t.Fatalf("err = %v", err)
	}
	if len(api.probes) != 0 || rows.savedAPI != nil {
		t.Fatalf("the saved key left for %v and was stored %v", api.probes, rows.savedAPI)
	}

	// The same address, written another way, keeps the saved key.
	if err := s.SaveDictationAPI(context.Background(), DictationAPIInput{BaseURL: savedAddress + "/", Model: "deepseek-flash"}); err != nil {
		t.Fatal(err)
	}
	if len(api.probes) != 1 || api.probes[0].BaseURL != savedAddress || api.probes[0].Key != savedKey {
		t.Fatalf("probes = %+v", api.probes)
	}
	if rows.savedAPI == nil || rows.savedAPI.PolishApiModel.String != "deepseek-flash" || !bytes.Equal(rows.savedAPI.PolishApiKeyCiphertext, rows.row.PolishApiKeyCiphertext) {
		t.Fatalf("saved = %+v", rows.savedAPI)
	}
}

func TestSaveDictationAPIChecksANewKeyAtTheNewAddressThenSealsIt(t *testing.T) {
	box := testBox(t, 1)
	rows := &fakeStore{row: savedAPIRow(t, box)}
	api := &fakeAPI{}
	s := newDictationService(rows, api, box)

	if err := s.SaveDictationAPI(context.Background(), DictationAPIInput{BaseURL: otherAddress, Model: "m", Key: "  sk-new  "}); err != nil {
		t.Fatal(err)
	}
	if len(api.probes) != 1 || api.probes[0].BaseURL != otherAddress || api.probes[0].Key != "sk-new" {
		t.Fatalf("probes = %+v", api.probes)
	}
	opened, err := box.Open(rows.savedAPI.PolishApiKeyCiphertext)
	if err != nil || string(opened) != "sk-new" {
		t.Fatalf("stored key = %q, %v", opened, err)
	}
	if bytes.Contains(rows.savedAPI.PolishApiKeyCiphertext, []byte("sk-new")) {
		t.Fatal("the key is stored in the clear")
	}
	if rows.savedAPI.PolishModel != "haiku" {
		t.Fatalf("the CLI model was lost: %q", rows.savedAPI.PolishModel)
	}
}

func TestSaveDictationAPIRefusesWhatCannotBeSavedAndStoresNothing(t *testing.T) {
	box := testBox(t, 1)
	for name, test := range map[string]struct {
		service *Service
		rows    *fakeStore
		input   DictationAPIInput
		probe   error
		want    error
	}{
		"no key saved or given": {
			rows: &fakeStore{empty: true}, input: DictationAPIInput{BaseURL: savedAddress, Model: "m"}, want: ErrInvalidPolishAPI,
		},
		"private address": {
			rows: &fakeStore{empty: true}, input: DictationAPIInput{BaseURL: "https://10.0.0.5/v1", Model: "m", Key: "k"}, want: ErrInvalidPolishAPI,
		},
		"model with a space": {
			rows: &fakeStore{empty: true}, input: DictationAPIInput{BaseURL: savedAddress, Model: "a b", Key: "k"}, want: ErrInvalidPolishAPI,
		},
		"key refused by the API": {
			rows: &fakeStore{empty: true}, input: DictationAPIInput{BaseURL: savedAddress, Model: "m", Key: "k"}, probe: voicedictation.ErrAPIRejected, want: voicedictation.ErrAPIRejected,
		},
		"API unreachable": {
			rows: &fakeStore{empty: true}, input: DictationAPIInput{BaseURL: savedAddress, Model: "m", Key: "k"}, probe: voicedictation.ErrAPIUnreachable, want: voicedictation.ErrAPIUnreachable,
		},
		"key sealed under another encryption key": {
			rows: &fakeStore{row: savedAPIRow(t, testBox(t, 2))}, input: DictationAPIInput{BaseURL: savedAddress, Model: "m"}, want: ErrInvalidPolishAPI,
		},
		"no encryption key on this server": {
			service: &Service{dictationAPI: &fakeAPI{}}, rows: &fakeStore{empty: true}, input: DictationAPIInput{BaseURL: savedAddress, Model: "m", Key: "k"}, want: ErrDictationKeyStorage,
		},
	} {
		t.Run(name, func(t *testing.T) {
			s := test.service
			if s == nil {
				s = newDictationService(test.rows, &fakeAPI{probeErr: test.probe}, box)
			}
			s.dictationStore = test.rows
			if err := s.SaveDictationAPI(context.Background(), test.input); !errors.Is(err, test.want) {
				t.Fatalf("err = %v, want %v", err, test.want)
			}
			if test.rows.savedAPI != nil {
				t.Fatalf("saved %+v", test.rows.savedAPI)
			}
		})
	}
}

func TestSaveDictationCLIKeepsOnlyAModelTheCLICanTake(t *testing.T) {
	rows := &fakeStore{}
	s := newDictationService(rows, &fakeAPI{}, nil)
	for _, model := range []string{"", "--model", "-p", "two words", strings.Repeat("a", 101)} {
		if err := s.SaveDictationCLI(context.Background(), model); !errors.Is(err, ErrInvalidPolishModel) {
			t.Fatalf("%q: err = %v", model, err)
		}
	}
	if rows.savedCLI != nil {
		t.Fatalf("saved %q", *rows.savedCLI)
	}
	if err := s.SaveDictationCLI(context.Background(), "haiku"); err != nil || rows.savedCLI == nil || *rows.savedCLI != "haiku" {
		t.Fatalf("err = %v, saved = %v", err, rows.savedCLI)
	}
}

func TestListDictationModelsUsesASavedKeyOnlyAtItsOwnAddress(t *testing.T) {
	box := testBox(t, 1)
	rows := &fakeStore{row: savedAPIRow(t, box)}
	api := &fakeAPI{models: []string{"a", "b"}}
	s := newDictationService(rows, api, box)

	if _, err := s.ListDictationModels(context.Background(), otherAddress, ""); !errors.Is(err, ErrInvalidPolishAPI) {
		t.Fatalf("err = %v", err)
	}
	if len(api.lists) != 0 {
		t.Fatalf("the saved key left for %+v", api.lists)
	}
	models, err := s.ListDictationModels(context.Background(), savedAddress+"/", "")
	if err != nil || len(models) != 2 {
		t.Fatalf("models = %v, err = %v", models, err)
	}
	if api.lists[0].BaseURL != savedAddress || api.lists[0].Key != savedKey {
		t.Fatalf("lists = %+v", api.lists)
	}
	// A key typed for another address is that address's own.
	if _, err := s.ListDictationModels(context.Background(), otherAddress, " sk-typed "); err != nil {
		t.Fatal(err)
	}
	if api.lists[1].BaseURL != otherAddress || api.lists[1].Key != "sk-typed" {
		t.Fatalf("lists = %+v", api.lists)
	}
}

func TestListDictationModelsWithNothingSavedNeedsAKey(t *testing.T) {
	api := &fakeAPI{}
	s := newDictationService(&fakeStore{empty: true}, api, testBox(t, 1))
	if _, err := s.ListDictationModels(context.Background(), savedAddress, ""); !errors.Is(err, ErrInvalidPolishAPI) {
		t.Fatalf("err = %v", err)
	}
	if _, err := s.ListDictationModels(context.Background(), "http://api.example.com/v1", "k"); !errors.Is(err, ErrInvalidPolishAPI) {
		t.Fatalf("an http address: err = %v", err)
	}
	if len(api.lists) != 0 {
		t.Fatalf("listed %+v", api.lists)
	}
}

func TestDictationSettingsAreChosenOnlyWhenTheyCanBeUsed(t *testing.T) {
	box := testBox(t, 1)
	for name, test := range map[string]struct {
		rows       *fakeStore
		box        *secretbox.Box
		chosen     bool
		keySaved   bool
		canSaveKey bool
	}{
		"nothing chosen yet":              {rows: &fakeStore{empty: true}, box: box, canSaveKey: true},
		"a CLI model":                     {rows: &fakeStore{row: store.GetVoiceDictationSettingsRow{PolishModel: "haiku", PolishSource: DictationSourceCLI}}, box: box, chosen: true, canSaveKey: true},
		"an API with a readable key":      {rows: &fakeStore{row: savedAPIRow(t, box)}, box: box, chosen: true, keySaved: true, canSaveKey: true},
		"an API sealed under another key": {rows: &fakeStore{row: savedAPIRow(t, testBox(t, 2))}, box: box, keySaved: true, canSaveKey: true},
		"an API on a server with no box":  {rows: &fakeStore{row: savedAPIRow(t, box)}, keySaved: true},
		"a CLI choice beside an unusable key": {rows: &fakeStore{row: func() store.GetVoiceDictationSettingsRow {
			row := savedAPIRow(t, testBox(t, 2))
			row.PolishSource = DictationSourceCLI
			return row
		}()}, box: box, chosen: true, keySaved: true, canSaveKey: true},
	} {
		t.Run(name, func(t *testing.T) {
			settings, err := newDictationService(test.rows, &fakeAPI{}, test.box).DictationSettings(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if settings.Chosen != test.chosen || (settings.API != nil) != test.keySaved || settings.CanSaveAPIKey != test.canSaveKey {
				t.Fatalf("settings = %+v", settings)
			}
			if settings.API != nil && settings.API.BaseURL != savedAddress {
				t.Fatalf("API = %+v", settings.API)
			}
		})
	}
}

func dictationSession() store.GetVoiceRuntimeSessionContextRow {
	return store.GetVoiceRuntimeSessionContextRow{ID: "voice_session_1", TenantID: "tenant_1", CreatedByActorID: "actor_1", Purpose: voicemedia.PurposeChatDictation}
}

func TestPolishDictationRunsOnTheChosenRoute(t *testing.T) {
	box := testBox(t, 1)
	t.Run("API", func(t *testing.T) {
		rows := &fakeStore{row: savedAPIRow(t, box), session: dictationSession()}
		api, polisher := &fakeAPI{polished: "Open the file."}, &fakePolisher{text: "from the CLI"}
		s := newDictationService(rows, api, box)
		s.dictationPolisher = polisher
		text, err := s.PolishDictation(context.Background(), "voice_session_1", "open the uh file")
		if err != nil || text != "Open the file." {
			t.Fatalf("text = %q, err = %v", text, err)
		}
		if len(api.polishes) != 1 || api.polishes[0].Key != savedKey || api.polishes[0].BaseURL != savedAddress || len(polisher.models) != 0 {
			t.Fatalf("api = %+v, cli = %v", api.polishes, polisher.models)
		}
	})
	t.Run("CLI as the session owner's, on the chosen model", func(t *testing.T) {
		rows := &fakeStore{row: store.GetVoiceDictationSettingsRow{PolishModel: "sonnet", PolishSource: DictationSourceCLI}, session: dictationSession()}
		api, polisher := &fakeAPI{}, &fakePolisher{text: "From the CLI."}
		s := newDictationService(rows, api, box)
		s.dictationPolisher = polisher
		text, err := s.PolishDictation(context.Background(), "voice_session_1", "from the cli")
		if err != nil || text != "From the CLI." {
			t.Fatalf("text = %q, err = %v", text, err)
		}
		if len(api.polishes) != 0 || len(polisher.models) != 1 || polisher.models[0] != "sonnet" ||
			polisher.owner.TenantID != "tenant_1" || polisher.owner.OwnerActorID != "actor_1" {
			t.Fatalf("api = %+v, cli = %v for %+v", api.polishes, polisher.models, polisher.owner)
		}
	})
	t.Run("CLI on the default model when none was saved", func(t *testing.T) {
		rows := &fakeStore{empty: true, session: dictationSession()}
		polisher := &fakePolisher{text: "Hi."}
		s := newDictationService(rows, &fakeAPI{}, box)
		s.dictationPolisher = polisher
		if _, err := s.PolishDictation(context.Background(), "voice_session_1", "hi"); err != nil {
			t.Fatal(err)
		}
		if len(polisher.models) != 1 || polisher.models[0] != voicedictation.DefaultPolishModel {
			t.Fatalf("models = %v", polisher.models)
		}
	})
}

func TestPolishDictationFailsSoTheRuntimeKeepsTheRecognizedText(t *testing.T) {
	box := testBox(t, 1)
	long := strings.Repeat("a", voicedictation.MaxTextBytes+1)
	for name, test := range map[string]struct {
		rows     *fakeStore
		api      *fakeAPI
		polisher voicedictation.Polisher
		text     string
		want     error
	}{
		"session not found": {
			rows: &fakeStore{sessionErr: pgx.ErrNoRows}, api: &fakeAPI{}, text: "hi", want: ErrVoiceSessionNotFound,
		},
		"not a dictation session": {
			rows: &fakeStore{session: store.GetVoiceRuntimeSessionContextRow{Purpose: voicemedia.PurposeChatLive}}, api: &fakeAPI{}, text: "hi", want: ErrVoicePurposeConflict,
		},
		"passage too long": {
			rows: &fakeStore{session: dictationSession()}, api: &fakeAPI{}, text: long, want: ErrDictationPolishUnavailable,
		},
		"API refuses": {
			rows: &fakeStore{row: savedAPIRow(t, box), session: dictationSession()}, api: &fakeAPI{polishErr: errors.New("status 429")}, text: "hi", want: ErrDictationPolishUnavailable,
		},
		"API answers without text": {
			rows: &fakeStore{row: savedAPIRow(t, box), session: dictationSession()}, api: &fakeAPI{}, text: "hi", want: ErrDictationPolishUnavailable,
		},
		"API key sealed under another encryption key": {
			rows: &fakeStore{row: savedAPIRow(t, testBox(t, 2)), session: dictationSession()}, api: &fakeAPI{polished: "x"}, text: "hi", want: ErrDictationPolishUnavailable,
		},
		"no CLI polisher configured": {
			rows: &fakeStore{empty: true, session: dictationSession()}, api: &fakeAPI{}, text: "hi", want: ErrDictationPolishUnavailable,
		},
		"CLI offline": {
			rows: &fakeStore{empty: true, session: dictationSession()}, api: &fakeAPI{}, polisher: &fakePolisher{err: errors.New("offline")}, text: "hi", want: ErrDictationPolishUnavailable,
		},
	} {
		t.Run(name, func(t *testing.T) {
			s := newDictationService(test.rows, test.api, box)
			s.dictationPolisher = test.polisher
			text, err := s.PolishDictation(context.Background(), "voice_session_1", test.text)
			if !errors.Is(err, test.want) || text != "" {
				t.Fatalf("text = %q, err = %v, want %v", text, err, test.want)
			}
		})
	}
}
