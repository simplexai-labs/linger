package imchannel

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/secretbox"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

type fakeStore struct {
	bindings       map[string]store.ImChannelBinding
	anotherMeRoom  string
	anotherMeActor string
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		bindings:       map[string]store.ImChannelBinding{},
		anotherMeRoom:  "room_am",
		anotherMeActor: "act_am",
	}
}

func (f *fakeStore) ListIMChannelBindingsForActor(_ context.Context, arg store.ListIMChannelBindingsForActorParams) ([]store.ImChannelBinding, error) {
	var out []store.ImChannelBinding
	for _, b := range f.bindings {
		if b.TenantID == arg.TenantID && b.HumanActorID == arg.HumanActorID {
			out = append(out, b)
		}
	}
	return out, nil
}

func (f *fakeStore) GetIMChannelBindingForActor(_ context.Context, arg store.GetIMChannelBindingForActorParams) (store.ImChannelBinding, error) {
	for _, b := range f.bindings {
		if b.TenantID == arg.TenantID && b.HumanActorID == arg.HumanActorID && b.Provider == arg.Provider {
			return b, nil
		}
	}
	return store.ImChannelBinding{}, pgx.ErrNoRows
}

func (f *fakeStore) GetIMChannelBindingByID(_ context.Context, id string) (store.ImChannelBinding, error) {
	b, ok := f.bindings[id]
	if !ok {
		return store.ImChannelBinding{}, pgx.ErrNoRows
	}
	return b, nil
}

func (f *fakeStore) ListEnabledIMChannelBindings(_ context.Context) ([]store.ListEnabledIMChannelBindingsRow, error) {
	var out []store.ListEnabledIMChannelBindingsRow
	for _, b := range f.bindings {
		if !b.Enabled {
			continue
		}
		out = append(out, store.ListEnabledIMChannelBindingsRow{
			ID:                b.ID,
			TenantID:          b.TenantID,
			AccountID:         b.AccountID,
			HumanActorID:      b.HumanActorID,
			Provider:          b.Provider,
			Enabled:           b.Enabled,
			SealedCredentials: b.SealedCredentials,
			ConfigJson:        b.ConfigJson,
			AdapterStateJson:  b.AdapterStateJson,
			OutboundRoomID:    b.OutboundRoomID,
			OutboundRoomSeq:   b.OutboundRoomSeq,
			PendingCardJson:   b.PendingCardJson,
			RuntimeStatus:     b.RuntimeStatus,
			RuntimeErrorCode:  b.RuntimeErrorCode,
			CooldownUntil:     b.CooldownUntil,
			AnotherMeActorID:  pgtype.Text{String: f.anotherMeActor, Valid: f.anotherMeActor != ""},
			AnotherMeRoomID:   pgtype.Text{String: f.anotherMeRoom, Valid: f.anotherMeRoom != ""},
		})
	}
	return out, nil
}

func (f *fakeStore) HasEnabledIMChannelBindingForRoom(_ context.Context, roomID string) (bool, error) {
	for _, b := range f.bindings {
		if b.Enabled && (b.OutboundRoomID.String == roomID || f.anotherMeRoom == roomID) {
			return true, nil
		}
	}
	return false, nil
}

func (f *fakeStore) UpsertIMChannelBinding(_ context.Context, arg store.UpsertIMChannelBindingParams) (store.ImChannelBinding, error) {
	now := pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	for id, b := range f.bindings {
		if b.TenantID == arg.TenantID && b.HumanActorID == arg.HumanActorID && b.Provider == arg.Provider {
			b.Enabled = true
			b.SealedCredentials = arg.SealedCredentials
			b.ConfigJson = arg.ConfigJson
			b.AdapterStateJson = []byte(`{}`)
			b.OutboundRoomID = arg.OutboundRoomID
			b.OutboundRoomSeq = arg.OutboundRoomSeq
			b.PendingCardJson = nil
			b.RuntimeStatus = "starting"
			b.UpdatedAt = now
			f.bindings[id] = b
			return b, nil
		}
	}
	b := store.ImChannelBinding{
		ID:                arg.ID,
		TenantID:          arg.TenantID,
		AccountID:         arg.AccountID,
		HumanActorID:      arg.HumanActorID,
		Provider:          arg.Provider,
		Enabled:           true,
		SealedCredentials: arg.SealedCredentials,
		ConfigJson:        arg.ConfigJson,
		AdapterStateJson:  []byte(`{}`),
		OutboundRoomID:    arg.OutboundRoomID,
		OutboundRoomSeq:   arg.OutboundRoomSeq,
		RuntimeStatus:     "starting",
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	f.bindings[b.ID] = b
	return b, nil
}

func (f *fakeStore) SetIMChannelBindingEnabled(_ context.Context, arg store.SetIMChannelBindingEnabledParams) (store.ImChannelBinding, error) {
	for id, b := range f.bindings {
		if b.TenantID == arg.TenantID && b.HumanActorID == arg.HumanActorID && b.Provider == arg.Provider {
			b.Enabled = arg.Enabled
			b.OutboundRoomID = arg.OutboundRoomID
			b.OutboundRoomSeq = arg.OutboundRoomSeq
			b.PendingCardJson = nil
			if arg.Enabled {
				b.RuntimeStatus = "starting"
			} else {
				b.RuntimeStatus = "disconnected"
			}
			f.bindings[id] = b
			return b, nil
		}
	}
	return store.ImChannelBinding{}, pgx.ErrNoRows
}

func (f *fakeStore) DeleteIMChannelBinding(_ context.Context, arg store.DeleteIMChannelBindingParams) (int64, error) {
	for id, b := range f.bindings {
		if b.TenantID == arg.TenantID && b.HumanActorID == arg.HumanActorID && b.Provider == arg.Provider {
			delete(f.bindings, id)
			return 1, nil
		}
	}
	return 0, nil
}

func (f *fakeStore) UpdateIMChannelRuntimeState(_ context.Context, arg store.UpdateIMChannelRuntimeStateParams) (store.ImChannelBinding, error) {
	b, ok := f.bindings[arg.ID]
	if !ok {
		return store.ImChannelBinding{}, pgx.ErrNoRows
	}
	if arg.RuntimeStatus.Valid {
		b.RuntimeStatus = arg.RuntimeStatus.String
	}
	if arg.OutboundRoomSeq.Valid && arg.OutboundRoomSeq.Int64 > b.OutboundRoomSeq {
		b.OutboundRoomSeq = arg.OutboundRoomSeq.Int64
	}
	if arg.ClearPendingCard {
		b.PendingCardJson = nil
	} else if len(arg.PendingCardJson) > 0 {
		b.PendingCardJson = arg.PendingCardJson
	}
	f.bindings[arg.ID] = b
	return b, nil
}

func (f *fakeStore) ClearIMChannelPendingCard(_ context.Context, id string) error {
	if b, ok := f.bindings[id]; ok {
		b.PendingCardJson = nil
		f.bindings[id] = b
	}
	return nil
}

func (f *fakeStore) MergeIMChannelAdapterState(_ context.Context, arg store.MergeIMChannelAdapterStateParams) error {
	if b, ok := f.bindings[arg.ID]; ok {
		b.AdapterStateJson = arg.AdapterStatePatch
		f.bindings[arg.ID] = b
	}
	return nil
}

func (f *fakeStore) GetAnotherMeChat(_ context.Context, _ store.GetAnotherMeChatParams) (store.GetAnotherMeChatRow, error) {
	if f.anotherMeRoom == "" {
		return store.GetAnotherMeChatRow{}, pgx.ErrNoRows
	}
	return store.GetAnotherMeChatRow{
		AgentActorID: f.anotherMeActor,
		RoomID:       pgtype.Text{String: f.anotherMeRoom, Valid: true},
	}, nil
}

type fakeCollab struct {
	channelRoom string
	roomIDs     []string
	messages    []string
	keys        []string
	latest      int64
}

func (f *fakeCollab) OpenAnotherMeChannel(_ context.Context, _, _ string, channel httpapi.RoomChannel) (collaboration.DirectRoom, error) {
	roomID := f.channelRoom
	if roomID == "" {
		roomID = "room_channel_" + string(channel)
	}
	return collaboration.DirectRoom{Status: 200, Room: httpapi.Room{Id: roomID}}, nil
}

func (f *fakeCollab) CreateMessage(_ context.Context, _, roomID string, req httpapi.MessageCreateRequest, _ collaboration.MessageContent, key string) (idempotency.Result, error) {
	f.roomIDs = append(f.roomIDs, roomID)
	if req.RawMessage != "" {
		f.messages = append(f.messages, req.RawMessage)
	}
	f.keys = append(f.keys, key)
	return idempotency.Result{Status: 201}, nil
}

func (f *fakeCollab) ListRoomEvents(_ context.Context, _, _ string, _ int64, _ int32) (collaboration.RoomEventPage, error) {
	return collaboration.RoomEventPage{LatestRoomSeq: f.latest}, nil
}

type fakeDecisions struct {
	lastID   string
	lastCmd  typedcard.DecisionAnswerCommand
	returnEr error
}

func (f *fakeDecisions) DecideDecision(_ context.Context, _, decisionID string, cmd typedcard.DecisionAnswerCommand) (typedcard.CreateResult, error) {
	f.lastID = decisionID
	f.lastCmd = cmd
	return typedcard.CreateResult{Status: 200}, f.returnEr
}

type fakeNode struct {
	pollResult NodePairingResult
	reconciles int
	wakes      []string
}

func (f *fakeNode) Reconcile(_ context.Context) (int, error) {
	f.reconciles++
	return 1, nil
}

func (f *fakeNode) WakeRoom(_ context.Context, roomID string) error {
	f.wakes = append(f.wakes, roomID)
	return nil
}

func (f *fakeNode) StartPairing(_ context.Context, provider string, _ []string) (NodePairingResult, error) {
	return NodePairingResult{
		PairingID: "pair_1",
		Provider:  provider,
		Status:    "waiting_scan",
		QRCodeURL: "https://weixin.qq.com/qr/test",
	}, nil
}

func (f *fakeNode) PollPairing(_ context.Context, _ string) (NodePairingResult, error) {
	return f.pollResult, nil
}

func (f *fakeNode) SubmitPairingVerifyCode(_ context.Context, pairingID, _ string) (NodePairingResult, error) {
	return NodePairingResult{PairingID: pairingID, Provider: "wechat", Status: "scanned"}, nil
}

func testSecretBox(t *testing.T) *secretbox.Box {
	t.Helper()
	key := base64.StdEncoding.EncodeToString([]byte("01234567890123456789012345678901"))
	box, err := secretbox.New(key)
	if err != nil {
		t.Fatal(err)
	}
	return box
}

func TestPairingRoundTripSealsAndDecryptsCredentials(t *testing.T) {
	fs := newFakeStore()
	fc := &fakeCollab{latest: 42}
	fn := &fakeNode{
		pollResult: NodePairingResult{
			PairingID:   "pair_1",
			Provider:    "wechat",
			Status:      "confirmed",
			Credentials: map[string]any{"bot_token": "tok_secret", "base_url": "https://ilinkai.weixin.qq.com"},
			Config:      map[string]any{"bot_id": "bot@im.bot", "remote_user_id": "u@im.wechat", "display_label": "WeChat"},
		},
	}
	svc := New(fs, fc, &fakeDecisions{}, testSecretBox(t), fn, nil)

	started, err := svc.StartPairing(context.Background(), "ten_1", "acc_1", "act_1", "wechat")
	if err != nil || started.QRCodeURL != "https://weixin.qq.com/qr/test" {
		t.Fatalf("StartPairing = %+v, %v", started, err)
	}
	// Another actor must not see this pairing session.
	if _, err := svc.PollPairing(context.Background(), "ten_1", "acc_2", "act_2", "pair_1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound for non-owner, got %v", err)
	}

	polled, err := svc.PollPairing(context.Background(), "ten_1", "acc_1", "act_1", "pair_1")
	if err != nil || polled.Status != "confirmed" || polled.Binding == nil {
		t.Fatalf("PollPairing = %+v, %v", polled, err)
	}
	if polled.Binding.RemoteUserID != "u@im.wechat" {
		t.Fatalf("unexpected remote user id: %+v", polled.Binding)
	}

	internal, err := svc.ListEnabledInternal(context.Background())
	if err != nil || len(internal) != 1 {
		t.Fatalf("ListEnabledInternal = %+v, %v", internal, err)
	}
	if internal[0].Credentials["bot_token"] != "tok_secret" {
		t.Fatalf("expected decrypted bot_token, got %+v", internal[0].Credentials)
	}
	if internal[0].OutboundRoomID != "room_channel_wechat" {
		t.Fatalf("expected isolated channel room room_channel_wechat, got %q", internal[0].OutboundRoomID)
	}
	if internal[0].OutboundRoomSeq != 42 {
		t.Fatalf("expected initial watermark 42, got %d", internal[0].OutboundRoomSeq)
	}
}

func TestIngestInboundAnswersPendingCardOrCreatesMessage(t *testing.T) {
	fs := newFakeStore()
	fc := &fakeCollab{}
	fd := &fakeDecisions{}
	svc := New(fs, fc, fd, testSecretBox(t), &fakeNode{}, nil)

	pendingJSON, _ := json.Marshal(pendingCardRecord{
		DecisionID: "dec_1",
		Version:    3,
		QuestionID: "q_1",
		Input:      "radio",
		OptionIDs:  []string{"opt_a", "opt_b"},
	})
	fs.bindings["imc_1"] = store.ImChannelBinding{
		ID:              "imc_1",
		TenantID:        "ten_1",
		AccountID:       "acc_1",
		HumanActorID:    "act_1",
		Provider:        "wechat",
		Enabled:         true,
		PendingCardJson: pendingJSON,
	}

	// Numbered reply submits the decision card.
	res, err := svc.IngestInbound(context.Background(), "imc_1", InboundInput{
		ExternalID:       "9001",
		SenderExternalID: "u@im.wechat",
		Text:             "2",
	})
	if err != nil || res.Kind != "decision" {
		t.Fatalf("decision IngestInbound = %+v, %v", res, err)
	}
	if fd.lastID != "dec_1" || fd.lastCmd.Answers["q_1"] != "opt_b" {
		t.Fatalf("unexpected decision command: %+v", fd.lastCmd)
	}

	// Ordinary text posts a Room message with a safe idempotency key.
	res, err = svc.IngestInbound(context.Background(), "imc_1", InboundInput{
		ExternalID:       "9002",
		SenderExternalID: "u@im.wechat",
		Text:             "hello another me",
	})
	if err != nil || res.Kind != "message" || len(fc.messages) != 1 || fc.messages[0] != "hello another me" {
		t.Fatalf("message IngestInbound = %+v, msgs=%v, err=%v", res, fc.messages, err)
	}
	if fc.keys[0] != "im:wechat:9002" {
		t.Fatalf("unexpected idempotency key: %s", fc.keys[0])
	}
	if fc.roomIDs[0] != "room_channel_wechat" {
		t.Fatalf("expected message in isolated channel room, got %s", fc.roomIDs[0])
	}
}

func TestIngestInboundMultiQuestionOtherAndApproval(t *testing.T) {
	fs := newFakeStore()
	fc := &fakeCollab{}
	fd := &fakeDecisions{}
	svc := New(fs, fc, fd, testSecretBox(t), &fakeNode{}, nil)

	multiJSON, _ := json.Marshal(pendingCardRecord{
		Kind:       "question",
		DecisionID: "dec_multi",
		Version:    1,
		Title:      "Trip Deck",
		Questions: []pendingQuestionStep{
			{
				ID: "q1", Prompt: "Audience?", Input: "radio",
				Options: []pendingQuestionOption{{ID: "o1", Label: "Friends"}, {ID: "o2", Label: "Team"}},
			},
			{
				ID: "q2", Prompt: "Pages?", Input: "radio",
				Options: []pendingQuestionOption{{ID: "p1", Label: "5"}, {ID: "p2", Label: "10"}},
			},
		},
	})
	fs.bindings["imc_multi"] = store.ImChannelBinding{
		ID: "imc_multi", TenantID: "ten_1", AccountID: "acc_1",
		HumanActorID: "act_1", Provider: "wechat", Enabled: true,
		PendingCardJson: multiJSON,
	}

	// First answer advances to question 2.
	step1, err := svc.IngestInbound(context.Background(), "imc_multi", InboundInput{
		ExternalID: "m1", SenderExternalID: "u@im.wechat", Text: "1",
	})
	if err != nil || step1.Kind != "question_step" || step1.NextPrompt == "" {
		t.Fatalf("step1 = %+v, %v", step1, err)
	}
	// Second answer uses custom "Other" text and submits both answers.
	step2, err := svc.IngestInbound(context.Background(), "imc_multi", InboundInput{
		ExternalID: "m2", SenderExternalID: "u@im.wechat", Text: "8 pages",
	})
	if err != nil || step2.Kind != "decision" {
		t.Fatalf("step2 = %+v, %v", step2, err)
	}
	if fd.lastID != "dec_multi" || fd.lastCmd.Answers["q1"] != "o1" || fd.lastCmd.Answers["q2"] != "8 pages" {
		t.Fatalf("unexpected multi answers: %+v", fd.lastCmd)
	}

	// Approval card accepts "1" as approve.
	approvalJSON, _ := json.Marshal(pendingCardRecord{
		Kind: "approval", DecisionID: "dec_perm", Version: 2, Title: "Run script", DecisionKind: "runtime_permission",
	})
	fs.bindings["imc_multi"] = store.ImChannelBinding{
		ID: "imc_multi", TenantID: "ten_1", AccountID: "acc_1",
		HumanActorID: "act_1", Provider: "wechat", Enabled: true,
		PendingCardJson: approvalJSON,
	}
	approved, err := svc.IngestInbound(context.Background(), "imc_multi", InboundInput{
		ExternalID: "m3", SenderExternalID: "u@im.wechat", Text: "1",
	})
	if err != nil || approved.Kind != "decision" || fd.lastID != "dec_perm" || fd.lastCmd.Decision != "approve" {
		t.Fatalf("approval = %+v, cmd=%+v, err=%v", approved, fd.lastCmd, err)
	}
}

func TestProjectRoomEventStripsFileSegments(t *testing.T) {
	payload := json.RawMessage(`{
		"kind": "message.created",
		"message": {
			"id": "msg_1",
			"message_kind": "conversation",
			"raw_message": "Your slides are ready.trip.pptx",
			"author": {"id": "act_am", "kind": "agent"},
			"attachments": [
				{"document_id": "doc_1", "filename": "trip.pptx", "media_type": "application/vnd.openxmlformats-officedocument.presentationml.presentation", "available": true}
			],
			"segments": [
				{"type": "text", "content": "Your slides are ready."},
				{"type": "file", "content": "trip.pptx", "filename": "trip.pptx", "media_type": "application/vnd.openxmlformats-officedocument.presentationml.presentation", "document_id": "doc_1"}
			]
		}
	}`)
	ev, ok := projectRoomEvent(61, "message.created", payload)
	if !ok {
		t.Fatal("expected event to project")
	}
	if ev.RawMessage != "Your slides are ready." {
		t.Fatalf("expected file segment stripped from RawMessage, got %q", ev.RawMessage)
	}
	if len(ev.Documents) != 1 || ev.Documents[0].DocumentID != "doc_1" || ev.Documents[0].Filename != "trip.pptx" {
		t.Fatalf("unexpected projected documents: %+v", ev.Documents)
	}
}
