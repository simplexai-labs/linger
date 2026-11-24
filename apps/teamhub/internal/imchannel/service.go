// Package imchannel manages network IM channel bindings between a Human Actor's
// Another Me direct Chat and external IM accounts (such as WeChat ClawBot,
// WhatsApp Agents, Telegram, Discord, and Slack). TeamHub stores sealed
// credentials and delivery cursors in PostgreSQL while Node Services runs the
// protocol adapters.
package imchannel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/secretbox"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// SupportedProviders lists network IM providers implemented by Node Services.
var SupportedProviders = []string{"wechat"}

// Domain errors mapped by HTTP handlers.
var (
	ErrUnavailable       = errors.New("IM channels are unavailable in this deployment")
	ErrUnsupported       = errors.New("IM channel provider is not supported")
	ErrInvalid           = errors.New("IM channel request is invalid")
	ErrNotFound          = errors.New("IM channel resource was not found")
	ErrNodeServicesError = errors.New("Node Services IM channel call failed")
)

const (
	pairingTTL        = 15 * time.Minute
	maxIdempotencyLen = 128
)

var (
	radioNumberRe    = regexp.MustCompile(`^\d+$`)
	checkboxNumberRe = regexp.MustCompile(`^\d+(\s*,\s*\d+)*$`)
	keyUnsafeRe      = regexp.MustCompile(`[^A-Za-z0-9._:-]`)
)

// Store is the persistence surface imchannel reads and writes; *store.Queries implements it.
type Store interface {
	ListIMChannelBindingsForActor(ctx context.Context, arg store.ListIMChannelBindingsForActorParams) ([]store.ImChannelBinding, error)
	GetIMChannelBindingForActor(ctx context.Context, arg store.GetIMChannelBindingForActorParams) (store.ImChannelBinding, error)
	GetIMChannelBindingByID(ctx context.Context, id string) (store.ImChannelBinding, error)
	ListEnabledIMChannelBindings(ctx context.Context) ([]store.ListEnabledIMChannelBindingsRow, error)
	HasEnabledIMChannelBindingForRoom(ctx context.Context, roomID string) (bool, error)
	UpsertIMChannelBinding(ctx context.Context, arg store.UpsertIMChannelBindingParams) (store.ImChannelBinding, error)
	SetIMChannelBindingEnabled(ctx context.Context, arg store.SetIMChannelBindingEnabledParams) (store.ImChannelBinding, error)
	DeleteIMChannelBinding(ctx context.Context, arg store.DeleteIMChannelBindingParams) (int64, error)
	UpdateIMChannelRuntimeState(ctx context.Context, arg store.UpdateIMChannelRuntimeStateParams) (store.ImChannelBinding, error)
	ClearIMChannelPendingCard(ctx context.Context, id string) error
	MergeIMChannelAdapterState(ctx context.Context, arg store.MergeIMChannelAdapterStateParams) error
	GetAnotherMeChat(ctx context.Context, arg store.GetAnotherMeChatParams) (store.GetAnotherMeChatRow, error)
}

// Collaboration is the room messaging and event-log surface used by imchannel.
type Collaboration interface {
	OpenAnotherMeChannel(ctx context.Context, accountID, tenantID string, channel httpapi.RoomChannel) (collaboration.DirectRoom, error)
	CreateMessage(ctx context.Context, accountID, roomID string, request httpapi.MessageCreateRequest, content collaboration.MessageContent, key string) (idempotency.Result, error)
	ListRoomEvents(ctx context.Context, accountID, roomID string, after int64, limit int32) (collaboration.RoomEventPage, error)
}

// Decisions is the typed-card decision surface used to answer question cards from IM.
type Decisions interface {
	DecideDecision(ctx context.Context, accountID, decisionID string, command typedcard.DecisionAnswerCommand) (typedcard.CreateResult, error)
}

// NodePairingResult is returned by Node Services during interactive pairing.
type NodePairingResult struct {
	PairingID   string
	Provider    string
	Status      string
	QRCodeURL   string
	ErrorCode   string
	Credentials map[string]any
	Config      map[string]any
}

// NodeClient talks to the Node Services channels role over node-services-internal.
type NodeClient interface {
	Reconcile(ctx context.Context) (int, error)
	WakeRoom(ctx context.Context, roomID string) error
	StartPairing(ctx context.Context, provider string, localTokens []string) (NodePairingResult, error)
	PollPairing(ctx context.Context, pairingID string) (NodePairingResult, error)
	SubmitPairingVerifyCode(ctx context.Context, pairingID, verifyCode string) (NodePairingResult, error)
}

// Binding is the public safe view of one IM channel binding (never carries credentials).
type Binding struct {
	ID               string
	Provider         string
	Enabled          bool
	DisplayLabel     string
	RemoteUserID     string
	RuntimeStatus    string
	RuntimeErrorCode string
	CooldownUntil    *time.Time
	LastInboundAt    *time.Time
	LastOutboundAt   *time.Time
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// ListResult is returned by ListForActor.
type ListResult struct {
	Available          bool
	SupportedProviders []string
	Bindings           []Binding
}

// PairingSession is the public view of an active or completed pairing session.
type PairingSession struct {
	PairingID string
	Provider  string
	Status    string
	QRCodeURL string
	ErrorCode string
	Binding   *Binding
}

// InternalBinding carries decrypted credentials and Another Me chat targets to Node Services.
type InternalBinding struct {
	ID               string
	TenantID         string
	AccountID        string
	HumanActorID     string
	Provider         string
	Enabled          bool
	Credentials      map[string]any
	Config           map[string]any
	AdapterState     map[string]any
	AnotherMeActorID string
	AnotherMeRoomID  string
	OutboundRoomID   string
	OutboundRoomSeq  int64
	PendingCard      map[string]any
	RuntimeStatus    string
	RuntimeErrorCode string
	CooldownUntil    *time.Time
}

// StatusUpdate records runtime state reported by Node Services.
type StatusUpdate struct {
	RuntimeStatus     *string
	RuntimeErrorCode  *string
	ClearErrorCode    bool
	CooldownUntil     *time.Time
	ClearCooldown     bool
	AdapterStatePatch map[string]any
	OutboundRoomID    *string
	OutboundRoomSeq   *int64
	PendingCard       map[string]any
	ClearPendingCard  bool
	TouchInbound      bool
	TouchOutbound     bool
}

// InboundInput is one normalized inbound IM message from Node Services.
type InboundInput struct {
	ExternalID          string
	SenderExternalID    string
	Text                string
	AttachmentUploadIDs []string
	AdapterStatePatch   map[string]any
}

// InboundResult reports how TeamHub handled an inbound IM message.
type InboundResult struct {
	Accepted      bool
	Kind          string
	RoomID        string
	ReplyHintCode string
	NextPrompt    string
}

// OutboundDocument describes a downloadable attachment or Document card on a Message.
type OutboundDocument struct {
	DocumentID string
	Filename   string
	MediaType  string
}

// OutboundEvent is one projected Room event ready for outbound IM formatting.
type OutboundEvent struct {
	RoomSeq         int64
	EventType       string
	MessageID       string
	AuthorActorID   string
	AuthorKind      string
	MessageKind     string
	RawMessage      string
	Card            map[string]any
	Documents       []OutboundDocument
	HasHTMLFragment bool
}

// OutboundPage is a bounded slice of Room events after a sequence watermark.
type OutboundPage struct {
	RoomID           string
	AnotherMeActorID string
	HumanActorID     string
	LatestRoomSeq    int64
	HasMore          bool
	Items            []OutboundEvent
}

type pairingOwner struct {
	tenantID     string
	accountID    string
	humanActorID string
	provider     string
	createdAt    time.Time
}

type pendingQuestionOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type pendingQuestionStep struct {
	ID      string                  `json:"id"`
	Prompt  string                  `json:"prompt"`
	Input   string                  `json:"input"`
	Options []pendingQuestionOption `json:"options"`
}

type pendingCardRecord struct {
	Kind         string                `json:"kind,omitempty"`
	DecisionID   string                `json:"decisionId"`
	Version      int64                 `json:"version"`
	Title        string                `json:"title,omitempty"`
	DecisionKind string                `json:"decisionKind,omitempty"`
	Questions    []pendingQuestionStep `json:"questions,omitempty"`
	CurrentIndex int                   `json:"currentIndex,omitempty"`
	Answers      map[string]any        `json:"answers,omitempty"`
	// Legacy single-question fields retained for stored bindings from older builds.
	QuestionID string   `json:"questionId,omitempty"`
	Input      string   `json:"input,omitempty"`
	OptionIDs  []string `json:"optionIds,omitempty"`
}

// Service coordinates IM channel bindings, pairing, inbound ingestion, and outbound reads.
type Service struct {
	store     Store
	collab    Collaboration
	decisions Decisions
	box       *secretbox.Box
	node      NodeClient
	logger    *slog.Logger
	now       func() time.Time

	mu       sync.Mutex
	pairings map[string]pairingOwner
}

// New builds an IM channel service. A nil box or node client keeps channels unavailable.
func New(s Store, collab Collaboration, decisions Decisions, box *secretbox.Box, node NodeClient, logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{
		store:     s,
		collab:    collab,
		decisions: decisions,
		box:       box,
		node:      node,
		logger:    logger,
		now:       time.Now,
		pairings:  make(map[string]pairingOwner),
	}
}

// Available reports whether secret encryption and Node Services channel supervision are configured.
func (s *Service) Available() bool {
	return s.box != nil && s.node != nil
}

// IsSupportedProvider reports whether provider is implemented in this build.
func IsSupportedProvider(provider string) bool {
	for _, p := range SupportedProviders {
		if p == provider {
			return true
		}
	}
	return false
}

// ListForActor returns supported providers and the Human Actor's current bindings.
func (s *Service) ListForActor(ctx context.Context, tenantID, humanActorID string) (ListResult, error) {
	rows, err := s.store.ListIMChannelBindingsForActor(ctx, store.ListIMChannelBindingsForActorParams{
		TenantID:     tenantID,
		HumanActorID: humanActorID,
	})
	if err != nil {
		return ListResult{}, err
	}
	bindings := make([]Binding, 0, len(rows))
	for _, row := range rows {
		bindings = append(bindings, bindingFromRow(row))
	}
	return ListResult{
		Available:          s.Available(),
		SupportedProviders: append([]string(nil), SupportedProviders...),
		Bindings:           bindings,
	}, nil
}

// StartPairing starts an interactive pairing session for provider under the signed-in Human.
func (s *Service) StartPairing(ctx context.Context, tenantID, accountID, humanActorID, provider string) (PairingSession, error) {
	if !IsSupportedProvider(provider) {
		return PairingSession{}, ErrUnsupported
	}
	if !s.Available() {
		return PairingSession{}, ErrUnavailable
	}
	localTokens := s.collectLocalBotTokens(ctx, tenantID, humanActorID, provider)
	result, err := s.node.StartPairing(ctx, provider, localTokens)
	if err != nil {
		return PairingSession{}, fmt.Errorf("%w: %w", ErrNodeServicesError, err)
	}
	s.mu.Lock()
	s.pruneExpiredPairingsLocked()
	s.pairings[result.PairingID] = pairingOwner{
		tenantID:     tenantID,
		accountID:    accountID,
		humanActorID: humanActorID,
		provider:     provider,
		createdAt:    s.now(),
	}
	s.mu.Unlock()
	return PairingSession{
		PairingID: result.PairingID,
		Provider:  result.Provider,
		Status:    result.Status,
		QRCodeURL: result.QRCodeURL,
		ErrorCode: result.ErrorCode,
	}, nil
}

// PollPairing polls an active pairing session owned by humanActorID and persists the binding on confirmation.
func (s *Service) PollPairing(ctx context.Context, tenantID, accountID, humanActorID, pairingID string) (PairingSession, error) {
	if !s.Available() {
		return PairingSession{}, ErrUnavailable
	}
	owner, ok := s.lookupPairingOwner(tenantID, accountID, humanActorID, pairingID)
	if !ok {
		return PairingSession{}, ErrNotFound
	}
	result, err := s.node.PollPairing(ctx, pairingID)
	if err != nil {
		return PairingSession{}, fmt.Errorf("%w: %w", ErrNodeServicesError, err)
	}
	return s.handlePairingOutcome(ctx, owner, result)
}

// SubmitPairingVerifyCode forwards a verification code for an active pairing session.
func (s *Service) SubmitPairingVerifyCode(ctx context.Context, tenantID, accountID, humanActorID, pairingID, verifyCode string) (PairingSession, error) {
	verifyCode = strings.TrimSpace(verifyCode)
	if verifyCode == "" || len(verifyCode) > 32 {
		return PairingSession{}, ErrInvalid
	}
	if !s.Available() {
		return PairingSession{}, ErrUnavailable
	}
	owner, ok := s.lookupPairingOwner(tenantID, accountID, humanActorID, pairingID)
	if !ok {
		return PairingSession{}, ErrNotFound
	}
	result, err := s.node.SubmitPairingVerifyCode(ctx, pairingID, verifyCode)
	if err != nil {
		return PairingSession{}, fmt.Errorf("%w: %w", ErrNodeServicesError, err)
	}
	return s.handlePairingOutcome(ctx, owner, result)
}

func (s *Service) handlePairingOutcome(ctx context.Context, owner pairingOwner, result NodePairingResult) (PairingSession, error) {
	session := PairingSession{
		PairingID: result.PairingID,
		Provider:  owner.provider,
		Status:    result.Status,
		QRCodeURL: result.QRCodeURL,
		ErrorCode: result.ErrorCode,
	}
	switch result.Status {
	case "confirmed":
		binding, err := s.persistConfirmedBinding(ctx, owner, result.Credentials, result.Config)
		if err != nil {
			return PairingSession{}, err
		}
		s.deletePairingOwner(result.PairingID)
		session.Binding = &binding
		s.reconcileBestEffort(ctx)
	case "already_connected":
		if existing, err := s.store.GetIMChannelBindingForActor(ctx, store.GetIMChannelBindingForActorParams{
			TenantID: owner.tenantID, HumanActorID: owner.humanActorID, Provider: owner.provider,
		}); err == nil {
			b := bindingFromRow(existing)
			session.Binding = &b
		}
		s.deletePairingOwner(result.PairingID)
	case "expired", "failed":
		s.deletePairingOwner(result.PairingID)
	}
	return session, nil
}

func (s *Service) persistConfirmedBinding(ctx context.Context, owner pairingOwner, credentials, cfg map[string]any) (Binding, error) {
	if len(credentials) == 0 {
		return Binding{}, ErrInvalid
	}
	rawCreds, err := json.Marshal(credentials)
	if err != nil {
		return Binding{}, err
	}
	sealed, err := s.box.Seal(rawCreds)
	if err != nil {
		return Binding{}, err
	}
	if cfg == nil {
		cfg = map[string]any{}
	}
	rawCfg, err := json.Marshal(cfg)
	if err != nil {
		return Binding{}, err
	}
	roomID, latestSeq := s.resolveOutboundWatermark(ctx, owner.tenantID, owner.accountID, owner.provider)
	row, err := s.store.UpsertIMChannelBinding(ctx, store.UpsertIMChannelBindingParams{
		ID:                idgen.New("imc"),
		TenantID:          owner.tenantID,
		AccountID:         owner.accountID,
		HumanActorID:      owner.humanActorID,
		Provider:          owner.provider,
		SealedCredentials: sealed,
		ConfigJson:        rawCfg,
		OutboundRoomID:    nullableText(roomID),
		OutboundRoomSeq:   latestSeq,
	})
	if err != nil {
		return Binding{}, err
	}
	return bindingFromRow(row), nil
}

// SetEnabled enables or disables an existing binding and resets the outbound watermark on re-enable.
func (s *Service) SetEnabled(ctx context.Context, tenantID, accountID, humanActorID, provider string, enabled bool) (Binding, error) {
	if !IsSupportedProvider(provider) {
		return Binding{}, ErrUnsupported
	}
	var roomID string
	var latestSeq int64
	if enabled {
		roomID, latestSeq = s.resolveOutboundWatermark(ctx, tenantID, accountID, provider)
	}
	row, err := s.store.SetIMChannelBindingEnabled(ctx, store.SetIMChannelBindingEnabledParams{
		Enabled:         enabled,
		OutboundRoomID:  nullableText(roomID),
		OutboundRoomSeq: latestSeq,
		TenantID:        tenantID,
		HumanActorID:    humanActorID,
		Provider:        provider,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Binding{}, ErrNotFound
	}
	if err != nil {
		return Binding{}, err
	}
	s.reconcileBestEffort(ctx)
	return bindingFromRow(row), nil
}

// Disconnect deletes an IM channel binding and reconciles Node Services.
func (s *Service) Disconnect(ctx context.Context, tenantID, humanActorID, provider string) error {
	if !IsSupportedProvider(provider) {
		return ErrUnsupported
	}
	affected, err := s.store.DeleteIMChannelBinding(ctx, store.DeleteIMChannelBindingParams{
		TenantID:     tenantID,
		HumanActorID: humanActorID,
		Provider:     provider,
	})
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrNotFound
	}
	s.reconcileBestEffort(ctx)
	return nil
}

// ListEnabledInternal decrypts all enabled bindings for Node Services channel supervision.
func (s *Service) ListEnabledInternal(ctx context.Context) ([]InternalBinding, error) {
	if s.box == nil {
		return []InternalBinding{}, nil
	}
	rows, err := s.store.ListEnabledIMChannelBindings(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]InternalBinding, 0, len(rows))
	for _, row := range rows {
		plaintext, err := s.box.Open(row.SealedCredentials)
		if err != nil {
			s.logger.Warn("imchannel.credentials_unreadable", "binding_id", row.ID, "provider", row.Provider)
			continue
		}
		var creds map[string]any
		if err := json.Unmarshal(plaintext, &creds); err != nil {
			s.logger.Warn("imchannel.credentials_malformed", "binding_id", row.ID, "provider", row.Provider)
			continue
		}
		items = append(items, InternalBinding{
			ID:               row.ID,
			TenantID:         row.TenantID,
			AccountID:        row.AccountID,
			HumanActorID:     row.HumanActorID,
			Provider:         row.Provider,
			Enabled:          row.Enabled,
			Credentials:      creds,
			Config:           decodeObjectJSON(row.ConfigJson),
			AdapterState:     decodeObjectJSON(row.AdapterStateJson),
			AnotherMeActorID: row.AnotherMeActorID.String,
			AnotherMeRoomID:  row.AnotherMeRoomID.String,
			OutboundRoomID:   row.OutboundRoomID.String,
			OutboundRoomSeq:  row.OutboundRoomSeq,
			PendingCard:      decodeOptionalObjectJSON(row.PendingCardJson),
			RuntimeStatus:    row.RuntimeStatus,
			RuntimeErrorCode: row.RuntimeErrorCode.String,
			CooldownUntil:    nullableTime(row.CooldownUntil),
		})
	}
	return items, nil
}

// ReportStatus updates runtime observability, adapter state, and outbound progress for one binding.
func (s *Service) ReportStatus(ctx context.Context, bindingID string, update StatusUpdate) error {
	var patchBytes []byte
	if len(update.AdapterStatePatch) > 0 {
		encoded, err := json.Marshal(update.AdapterStatePatch)
		if err != nil {
			return ErrInvalid
		}
		patchBytes = encoded
	}
	var pendingCardBytes []byte
	if len(update.PendingCard) > 0 {
		encoded, err := json.Marshal(update.PendingCard)
		if err != nil {
			return ErrInvalid
		}
		pendingCardBytes = encoded
	}
	params := store.UpdateIMChannelRuntimeStateParams{
		ID:                bindingID,
		ClearCooldown:     update.ClearCooldown,
		ClearPendingCard:  update.ClearPendingCard,
		TouchInbound:      update.TouchInbound,
		TouchOutbound:     update.TouchOutbound,
		AdapterStatePatch: patchBytes,
		PendingCardJson:   pendingCardBytes,
	}
	if update.RuntimeStatus != nil {
		params.RuntimeStatus = pgtype.Text{String: *update.RuntimeStatus, Valid: true}
	}
	if update.ClearErrorCode {
		params.SetRuntimeErrorCode = true
	} else if update.RuntimeErrorCode != nil {
		params.SetRuntimeErrorCode = true
		params.RuntimeErrorCode = pgtype.Text{String: *update.RuntimeErrorCode, Valid: true}
	}
	if update.CooldownUntil != nil {
		params.CooldownUntil = pgtype.Timestamptz{Time: update.CooldownUntil.UTC(), Valid: true}
	}
	if update.OutboundRoomID != nil {
		params.OutboundRoomID = pgtype.Text{String: *update.OutboundRoomID, Valid: true}
	}
	if update.OutboundRoomSeq != nil {
		params.OutboundRoomSeq = pgtype.Int8{Int64: *update.OutboundRoomSeq, Valid: true}
	}
	_, err := s.store.UpdateIMChannelRuntimeState(ctx, params)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

// ResolveBindingAccess validates an enabled binding and returns its owner
// account ID and isolated Channel Room ID for media downloads and uploads.
func (s *Service) ResolveBindingAccess(ctx context.Context, bindingID string) (string, string, error) {
	binding, err := s.store.GetIMChannelBindingByID(ctx, bindingID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", ErrNotFound
	}
	if err != nil {
		return "", "", err
	}
	if !binding.Enabled {
		return "", "", ErrNotFound
	}
	opened, err := s.collab.OpenAnotherMeChannel(ctx, binding.AccountID, binding.TenantID, httpapi.RoomChannel(binding.Provider))
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", ErrNotFound
	}
	if err != nil {
		return "", "", err
	}
	return binding.AccountID, opened.Room.Id, nil
}

// IngestInbound writes an inbound IM message into the Human's isolated Channel
// Room or advances/submits the pending question or approval card.
func (s *Service) IngestInbound(ctx context.Context, bindingID string, input InboundInput) (InboundResult, error) {
	text := strings.TrimSpace(input.Text)
	if (text == "" && len(input.AttachmentUploadIDs) == 0) || strings.TrimSpace(input.ExternalID) == "" {
		return InboundResult{}, ErrInvalid
	}
	binding, err := s.store.GetIMChannelBindingByID(ctx, bindingID)
	if errors.Is(err, pgx.ErrNoRows) {
		return InboundResult{}, ErrNotFound
	}
	if err != nil {
		return InboundResult{}, err
	}
	if !binding.Enabled {
		return InboundResult{}, ErrNotFound
	}
	if len(input.AdapterStatePatch) > 0 {
		if encoded, err := json.Marshal(input.AdapterStatePatch); err == nil {
			_ = s.store.MergeIMChannelAdapterState(ctx, store.MergeIMChannelAdapterStateParams{
				ID:                binding.ID,
				AdapterStatePatch: encoded,
			})
		}
	}
	opened, err := s.collab.OpenAnotherMeChannel(ctx, binding.AccountID, binding.TenantID, httpapi.RoomChannel(binding.Provider))
	if errors.Is(err, pgx.ErrNoRows) {
		return InboundResult{Accepted: false, Kind: "no_another_me"}, nil
	}
	if err != nil {
		return InboundResult{}, err
	}
	roomID := opened.Room.Id

	// Only pure text replies (no attachments) interact with the active pending card.
	if text != "" && len(input.AttachmentUploadIDs) == 0 {
		if handled, result, err := s.tryAnswerPendingCard(ctx, binding, roomID, text); err != nil {
			return InboundResult{}, err
		} else if handled {
			return result, nil
		}
	}

	segments := []httpapi.MessageSegment{}
	if text != "" {
		var textSeg httpapi.MessageSegment
		if err := textSeg.FromTextSegment(httpapi.TextSegment{Type: "text", Content: text}); err != nil {
			return InboundResult{}, ErrInvalid
		}
		segments = append(segments, textSeg)
	}
	req := httpapi.MessageCreateRequest{
		RawMessage: text,
		Segments:   segments,
	}
	if len(input.AttachmentUploadIDs) > 0 {
		ids := append([]string(nil), input.AttachmentUploadIDs...)
		req.AttachmentUploadIds = &ids
	}
	content, err := collaboration.NormalizeMessageCreateRequest(req)
	if err != nil {
		return InboundResult{}, ErrInvalid
	}
	key := buildInboundIdempotencyKey(binding.Provider, input.ExternalID)
	if _, err := s.collab.CreateMessage(ctx, binding.AccountID, roomID, req, content, key); err != nil {
		if errors.Is(err, idempotency.ErrConflict) {
			return InboundResult{Accepted: true, Kind: "message", RoomID: roomID}, nil
		}
		return InboundResult{}, err
	}
	return InboundResult{Accepted: true, Kind: "message", RoomID: roomID}, nil
}

func decodePendingCard(raw []byte) (pendingCardRecord, bool) {
	if len(raw) == 0 {
		return pendingCardRecord{}, false
	}
	var card pendingCardRecord
	if err := json.Unmarshal(raw, &card); err != nil || card.DecisionID == "" {
		return pendingCardRecord{}, false
	}
	if card.Kind == "approval" {
		return card, true
	}
	if len(card.Questions) > 0 {
		card.Kind = "question"
		if card.CurrentIndex < 0 || card.CurrentIndex >= len(card.Questions) {
			return pendingCardRecord{}, false
		}
		return card, true
	}
	// Legacy single-question format compatibility.
	if card.QuestionID != "" && len(card.OptionIDs) > 0 && (card.Input == "radio" || card.Input == "checkbox") {
		opts := make([]pendingQuestionOption, 0, len(card.OptionIDs))
		for _, id := range card.OptionIDs {
			opts = append(opts, pendingQuestionOption{ID: id, Label: id})
		}
		card.Kind = "question"
		card.Questions = []pendingQuestionStep{{
			ID:      card.QuestionID,
			Input:   card.Input,
			Options: opts,
		}}
		card.CurrentIndex = 0
		return card, true
	}
	return pendingCardRecord{}, false
}

func formatQuestionStepPrompt(card pendingCardRecord) string {
	if card.CurrentIndex < 0 || card.CurrentIndex >= len(card.Questions) {
		return ""
	}
	q := card.Questions[card.CurrentIndex]
	title := strings.TrimSpace(card.Title)
	header := title
	if len(card.Questions) > 1 {
		if header != "" {
			header = fmt.Sprintf("%s (%d/%d)", header, card.CurrentIndex+1, len(card.Questions))
		} else {
			header = fmt.Sprintf("(%d/%d)", card.CurrentIndex+1, len(card.Questions))
		}
	}
	lines := make([]string, 0, len(q.Options)+3)
	if header != "" {
		lines = append(lines, header)
	}
	prompt := strings.TrimSpace(q.Prompt)
	if prompt != "" && prompt != title {
		lines = append(lines, prompt)
	}
	for i, opt := range q.Options {
		lines = append(lines, fmt.Sprintf("%d. %s", i+1, opt.Label))
	}
	if q.Input == "checkbox" {
		lines = append(lines, "Reply with numbers (e.g. 1,3), or type your own answer.")
	} else {
		lines = append(lines, "Reply with a number, or type your own answer.")
	}
	return strings.Join(lines, "\n")
}

func (s *Service) tryAnswerPendingCard(ctx context.Context, binding store.ImChannelBinding, roomID, text string) (bool, InboundResult, error) {
	if s.decisions == nil {
		return false, InboundResult{}, nil
	}
	card, ok := decodePendingCard(binding.PendingCardJson)
	if !ok {
		return false, InboundResult{}, nil
	}
	trimmed := strings.TrimSpace(text)
	if card.Kind == "approval" {
		var decision string
		switch trimmed {
		case "1":
			decision = "approve"
		case "2":
			decision = "deny"
		default:
			return false, InboundResult{}, nil
		}
		_, err := s.decisions.DecideDecision(ctx, binding.AccountID, card.DecisionID, typedcard.DecisionAnswerCommand{
			ExpectedVersion: card.Version,
			Decision:        decision,
		})
		return s.finishDecisionAttempt(ctx, binding.ID, roomID, err)
	}

	step := card.Questions[card.CurrentIndex]
	var answerValue any
	picks := parseNumberedAnswer(trimmed, step.Input, len(step.Options))
	if len(picks) > 0 {
		if step.Input == "radio" {
			answerValue = step.Options[picks[0]-1].ID
		} else {
			selected := make([]string, 0, len(picks))
			for _, n := range picks {
				selected = append(selected, step.Options[n-1].ID)
			}
			answerValue = selected
		}
	} else {
		// Accept free-text "Other..." reply for any question card.
		if step.Input == "radio" {
			answerValue = truncateRunes(trimmed, 10000)
		} else {
			answerValue = []string{truncateRunes(trimmed, 200)}
		}
	}
	if card.Answers == nil {
		card.Answers = map[string]any{}
	}
	card.Answers[step.ID] = answerValue

	if card.CurrentIndex+1 < len(card.Questions) {
		card.CurrentIndex++
		encoded, err := json.Marshal(card)
		if err != nil {
			return false, InboundResult{}, err
		}
		if _, err := s.store.UpdateIMChannelRuntimeState(ctx, store.UpdateIMChannelRuntimeStateParams{
			ID:              binding.ID,
			PendingCardJson: encoded,
		}); err != nil {
			return false, InboundResult{}, err
		}
		return true, InboundResult{
			Accepted:   true,
			Kind:       "question_step",
			RoomID:     roomID,
			NextPrompt: formatQuestionStepPrompt(card),
		}, nil
	}

	_, err := s.decisions.DecideDecision(ctx, binding.AccountID, card.DecisionID, typedcard.DecisionAnswerCommand{
		ExpectedVersion: card.Version,
		Decision:        "submit",
		Answers:         card.Answers,
	})
	return s.finishDecisionAttempt(ctx, binding.ID, roomID, err)
}

func (s *Service) finishDecisionAttempt(ctx context.Context, bindingID, roomID string, err error) (bool, InboundResult, error) {
	if err == nil {
		_ = s.store.ClearIMChannelPendingCard(ctx, bindingID)
		return true, InboundResult{Accepted: true, Kind: "decision", RoomID: roomID}, nil
	}
	if errors.Is(err, typedcard.ErrConflict) {
		_ = s.store.ClearIMChannelPendingCard(ctx, bindingID)
		return true, InboundResult{Accepted: true, Kind: "decision_conflict", RoomID: roomID, ReplyHintCode: "CARD_CONFLICT"}, nil
	}
	if errors.Is(err, typedcard.ErrInvalid) || errors.Is(err, typedcard.ErrForbidden) || errors.Is(err, typedcard.ErrNotFound) {
		_ = s.store.ClearIMChannelPendingCard(ctx, bindingID)
		return true, InboundResult{Accepted: true, Kind: "decision_rejected", RoomID: roomID, ReplyHintCode: "CARD_OPEN_LINGER"}, nil
	}
	return false, InboundResult{}, err
}

func truncateRunes(s string, limit int) string {
	runes := []rune(s)
	if len(runes) <= limit {
		return s
	}
	return string(runes[:limit])
}

// ListOutbound reads Room events in the bound Human's isolated Channel Room after afterSeq.
func (s *Service) ListOutbound(ctx context.Context, bindingID string, afterSeq int64, limit int32) (OutboundPage, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	binding, err := s.store.GetIMChannelBindingByID(ctx, bindingID)
	if errors.Is(err, pgx.ErrNoRows) {
		return OutboundPage{}, ErrNotFound
	}
	if err != nil {
		return OutboundPage{}, err
	}
	chat, err := s.store.GetAnotherMeChat(ctx, store.GetAnotherMeChatParams{
		TenantID:     binding.TenantID,
		HumanActorID: binding.HumanActorID,
	})
	if errors.Is(err, pgx.ErrNoRows) || chat.AgentActorID == "" {
		return OutboundPage{}, ErrNotFound
	}
	if err != nil {
		return OutboundPage{}, err
	}
	opened, err := s.collab.OpenAnotherMeChannel(ctx, binding.AccountID, binding.TenantID, httpapi.RoomChannel(binding.Provider))
	if errors.Is(err, pgx.ErrNoRows) {
		return OutboundPage{}, ErrNotFound
	}
	if err != nil {
		return OutboundPage{}, err
	}
	roomID := opened.Room.Id
	page, err := s.collab.ListRoomEvents(ctx, binding.AccountID, roomID, afterSeq, limit)
	if errors.Is(err, pgx.ErrNoRows) {
		return OutboundPage{}, ErrNotFound
	}
	if err != nil {
		return OutboundPage{}, err
	}
	items := make([]OutboundEvent, 0, len(page.Items))
	for _, env := range page.Items {
		if projected, ok := projectRoomEvent(env.RoomSeq, env.EventType, env.Payload); ok {
			items = append(items, projected)
		}
	}
	return OutboundPage{
		RoomID:           roomID,
		AnotherMeActorID: chat.AgentActorID,
		HumanActorID:     binding.HumanActorID,
		LatestRoomSeq:    page.LatestRoomSeq,
		HasMore:          page.HasMore,
		Items:            items,
	}, nil
}

// HasEnabledBindingForRoom reports whether roomID has at least one enabled IM channel binding.
func (s *Service) HasEnabledBindingForRoom(ctx context.Context, roomID string) (bool, error) {
	return s.store.HasEnabledIMChannelBindingForRoom(ctx, roomID)
}

// WakeRoom notifies Node Services to drain outbound events for roomID if any binding watches it.
func (s *Service) WakeRoom(ctx context.Context, roomID string) {
	if s.node == nil || roomID == "" {
		return
	}
	hasBinding, err := s.store.HasEnabledIMChannelBindingForRoom(ctx, roomID)
	if err != nil || !hasBinding {
		return
	}
	if err := s.node.WakeRoom(ctx, roomID); err != nil {
		s.logger.Debug("imchannel.wake_failed", "room_id", roomID, "error", err)
	}
}

func (s *Service) resolveOutboundWatermark(ctx context.Context, tenantID, accountID, provider string) (string, int64) {
	opened, err := s.collab.OpenAnotherMeChannel(ctx, accountID, tenantID, httpapi.RoomChannel(provider))
	if err != nil || opened.Room.Id == "" {
		return "", 0
	}
	page, err := s.collab.ListRoomEvents(ctx, accountID, opened.Room.Id, 0, 1)
	if err != nil {
		return opened.Room.Id, 0
	}
	return opened.Room.Id, page.LatestRoomSeq
}

func (s *Service) collectLocalBotTokens(ctx context.Context, tenantID, humanActorID, provider string) []string {
	if s.box == nil {
		return nil
	}
	row, err := s.store.GetIMChannelBindingForActor(ctx, store.GetIMChannelBindingForActorParams{
		TenantID:     tenantID,
		HumanActorID: humanActorID,
		Provider:     provider,
	})
	if err != nil {
		return nil
	}
	plaintext, err := s.box.Open(row.SealedCredentials)
	if err != nil {
		return nil
	}
	var creds map[string]any
	if json.Unmarshal(plaintext, &creds) != nil {
		return nil
	}
	if token, ok := creds["bot_token"].(string); ok && strings.TrimSpace(token) != "" {
		return []string{strings.TrimSpace(token)}
	}
	return nil
}

func (s *Service) reconcileBestEffort(ctx context.Context) {
	if s.node == nil {
		return
	}
	reconcileCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	go func() {
		defer cancel()
		if _, err := s.node.Reconcile(reconcileCtx); err != nil {
			s.logger.Warn("imchannel.reconcile_failed", "error", err)
		}
	}()
}

func (s *Service) lookupPairingOwner(tenantID, accountID, humanActorID, pairingID string) (pairingOwner, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneExpiredPairingsLocked()
	owner, ok := s.pairings[pairingID]
	if !ok {
		return pairingOwner{}, false
	}
	if owner.tenantID != tenantID || owner.accountID != accountID || owner.humanActorID != humanActorID {
		return pairingOwner{}, false
	}
	return owner, true
}

func (s *Service) deletePairingOwner(pairingID string) {
	s.mu.Lock()
	delete(s.pairings, pairingID)
	s.mu.Unlock()
}

func (s *Service) pruneExpiredPairingsLocked() {
	cutoff := s.now().Add(-pairingTTL)
	for id, owner := range s.pairings {
		if owner.createdAt.Before(cutoff) {
			delete(s.pairings, id)
		}
	}
}

func projectRoomEvent(roomSeq int64, eventType string, rawPayload json.RawMessage) (OutboundEvent, bool) {
	switch eventType {
	case "message.created":
		var payload struct {
			Message struct {
				ID          string         `json:"id"`
				MessageKind string         `json:"message_kind"`
				RawMessage  string         `json:"raw_message"`
				Card        map[string]any `json:"card"`
				Attachments []struct {
					DocumentID string `json:"document_id"`
					Filename   string `json:"filename"`
					MediaType  string `json:"media_type"`
					Available  bool   `json:"available"`
				} `json:"attachments"`
				Segments []struct {
					Type         string `json:"type"`
					Content      string `json:"content"`
					DocumentID   string `json:"document_id"`
					Presentation string `json:"presentation"`
				} `json:"segments"`
				Author struct {
					ID   string `json:"id"`
					Kind string `json:"kind"`
				} `json:"author"`
			} `json:"message"`
		}
		if json.Unmarshal(rawPayload, &payload) != nil || payload.Message.ID == "" {
			return OutboundEvent{}, false
		}
		seenDocs := map[string]struct{}{}
		docs := make([]OutboundDocument, 0)
		for _, att := range payload.Message.Attachments {
			if !att.Available || att.DocumentID == "" {
				continue
			}
			if _, dup := seenDocs[att.DocumentID]; dup {
				continue
			}
			seenDocs[att.DocumentID] = struct{}{}
			docs = append(docs, OutboundDocument{
				DocumentID: att.DocumentID,
				Filename:   att.Filename,
				MediaType:  att.MediaType,
			})
		}
		hasHTML := false
		omittedCard := false
		bodyParts := make([]string, 0, len(payload.Message.Segments))
		for _, seg := range payload.Message.Segments {
			if seg.Type == "html_fragment" {
				hasHTML = true
			}
			if seg.Type == "document" && seg.DocumentID != "" {
				if _, dup := seenDocs[seg.DocumentID]; !dup {
					seenDocs[seg.DocumentID] = struct{}{}
					docs = append(docs, OutboundDocument{
						DocumentID: seg.DocumentID,
						Filename:   seg.Content,
					})
				}
				if seg.Presentation == "card" || seg.Presentation == "canvas" {
					omittedCard = true
					continue
				}
			}
			bodyParts = append(bodyParts, seg.Content)
		}
		rawMsg := payload.Message.RawMessage
		if omittedCard {
			rawMsg = strings.TrimSpace(strings.Join(bodyParts, ""))
		}
		return OutboundEvent{
			RoomSeq:         roomSeq,
			EventType:       "message_created",
			MessageID:       payload.Message.ID,
			AuthorActorID:   payload.Message.Author.ID,
			AuthorKind:      payload.Message.Author.Kind,
			MessageKind:     payload.Message.MessageKind,
			RawMessage:      rawMsg,
			Card:            payload.Message.Card,
			Documents:       docs,
			HasHTMLFragment: hasHTML,
		}, true
	case "card.changed":
		var payload struct {
			MessageID string         `json:"message_id"`
			Card      map[string]any `json:"card"`
		}
		if json.Unmarshal(rawPayload, &payload) != nil || payload.MessageID == "" {
			return OutboundEvent{}, false
		}
		return OutboundEvent{
			RoomSeq:   roomSeq,
			EventType: "card_changed",
			MessageID: payload.MessageID,
			Card:      payload.Card,
		}, true
	default:
		return OutboundEvent{}, false
	}
}

func parseNumberedAnswer(text, input string, optionCount int) []int {
	if optionCount < 1 {
		return nil
	}
	trimmed := strings.TrimSpace(text)
	switch input {
	case "radio":
		if !radioNumberRe.MatchString(trimmed) {
			return nil
		}
	case "checkbox":
		if !checkboxNumberRe.MatchString(trimmed) {
			return nil
		}
	default:
		return nil
	}
	parts := strings.Split(trimmed, ",")
	seen := make(map[int]struct{}, len(parts))
	out := make([]int, 0, len(parts))
	for _, part := range parts {
		n, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil || n < 1 || n > optionCount {
			return nil
		}
		if _, dup := seen[n]; dup {
			return nil
		}
		seen[n] = struct{}{}
		out = append(out, n)
	}
	return out
}

func buildInboundIdempotencyKey(provider, externalID string) string {
	safeProvider := strings.TrimLeft(keyUnsafeRe.ReplaceAllString(provider, "-"), "-._:")
	if safeProvider == "" {
		safeProvider = "im"
	}
	safeID := keyUnsafeRe.ReplaceAllString(externalID, "-")
	if safeID == "" {
		safeID = "msg"
	}
	key := "im:" + safeProvider + ":" + safeID
	for len(key) < 8 {
		key += "0"
	}
	if len(key) > maxIdempotencyLen {
		key = key[:maxIdempotencyLen]
	}
	return key
}

func bindingFromRow(row store.ImChannelBinding) Binding {
	cfg := decodeObjectJSON(row.ConfigJson)
	displayLabel, _ := cfg["display_label"].(string)
	remoteUserID, _ := cfg["remote_user_id"].(string)
	return Binding{
		ID:               row.ID,
		Provider:         row.Provider,
		Enabled:          row.Enabled,
		DisplayLabel:     displayLabel,
		RemoteUserID:     remoteUserID,
		RuntimeStatus:    row.RuntimeStatus,
		RuntimeErrorCode: row.RuntimeErrorCode.String,
		CooldownUntil:    nullableTime(row.CooldownUntil),
		LastInboundAt:    nullableTime(row.LastInboundAt),
		LastOutboundAt:   nullableTime(row.LastOutboundAt),
		CreatedAt:        row.CreatedAt.Time.UTC(),
		UpdatedAt:        row.UpdatedAt.Time.UTC(),
	}
}

func decodeObjectJSON(raw []byte) map[string]any {
	if len(raw) == 0 {
		return map[string]any{}
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) != nil || obj == nil {
		return map[string]any{}
	}
	return obj
}

func decodeOptionalObjectJSON(raw []byte) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) != nil || len(obj) == 0 {
		return nil
	}
	return obj
}

func nullableText(value string) pgtype.Text {
	if value == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: value, Valid: true}
}

func nullableTime(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	t := value.Time.UTC()
	return &t
}
