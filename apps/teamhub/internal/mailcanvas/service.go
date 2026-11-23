// Package mailcanvas delivers a Human-reviewed canvas only after Send is clicked.
package mailcanvas

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentconnectedapps"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/feishu"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// ErrConflict means the reviewed canvas changed or a delivery already started.
var ErrConflict = errors.New("mail canvas changed or delivery already started")

// ErrForbidden means the caller cannot change this canvas.
var ErrForbidden = errors.New("mail canvas delivery is not allowed")

// ErrAlreadySent means the canvas went out by another path.
var ErrAlreadySent = errors.New("mail canvas was already sent")

// ErrConnectionUnavailable means the chosen mail connection cannot send.
var ErrConnectionUnavailable = errors.New("mail connection is unavailable")

// Provider uploads and sends drafts under a currently authorized Gmail connection.
type Provider interface {
	SaveGmailDraft(context.Context, string, string, string) (composio.GmailDraft, error)
	SendGmailDraft(context.Context, string, string) (string, error)
}

type outlookProvider interface {
	SaveOutlookDraft(context.Context, string, string, composio.OutlookDraftMessage) (composio.GmailDraft, error)
	SendOutlookDraft(context.Context, string, string) (string, error)
}

// Service owns the delivery receipt shown in the editor and its queued execution.
type Service struct {
	pool        *pgxpool.Pool
	documents   *document.Service
	canvas      *agentconnectedapps.Canvas
	connections *externalsource.Service
	provider    Provider
}

// New constructs the Human mail delivery service.
func New(pool *pgxpool.Pool, documents *document.Service, canvas *agentconnectedapps.Canvas, connections *externalsource.Service, provider Provider) *Service {
	return &Service{pool: pool, documents: documents, canvas: canvas, connections: connections, provider: provider}
}

// State is the current local draft or persisted delivery receipt.
type State struct {
	Status string `json:"status"`
	// Target is the canvas's mail app, which the sending account must match.
	Target       string `json:"target"`
	Subject      string `json:"subject"`
	To           string `json:"to"`
	Error        string `json:"error,omitempty"`
	MessageID    string `json:"message_id,omitempty"`
	SourceDigest string `json:"source_digest"`
	CanEdit      bool   `json:"can_edit"`
}

// SendInput pins the durable version the Human reviewed before clicking Send.
type SendInput struct {
	AccountID, DocumentID, ConnectionID, RequestID, SourceDigest string
}

func (s *Service) read(ctx context.Context, accountID, documentID string) (document.Document, agentconnectedapps.CanvasHeader, error) {
	doc, err := s.documents.Get(ctx, accountID, documentID)
	if err != nil {
		return doc, agentconnectedapps.CanvasHeader{}, err
	}
	content, err := s.canvas.ForAccount(accountID).CanvasExport(ctx, "", "", documentID, "blocks")
	if err != nil {
		return doc, agentconnectedapps.CanvasHeader{}, err
	}
	var source struct {
		Blocks []agentconnectedapps.CanvasBlock `json:"blocks"`
	}
	if err := json.Unmarshal(content, &source); err != nil {
		return doc, agentconnectedapps.CanvasHeader{}, err
	}
	header, ok := agentconnectedapps.ReadCanvasHeader(source.Blocks)
	if !ok || !agentconnectedapps.IsMailCanvasTarget(header.Target) {
		return doc, header, document.ErrInvalidInput
	}
	return doc, header, nil
}

// Get reads editor status without contacting Gmail or changing an external draft.
func (s *Service) Get(ctx context.Context, accountID, documentID string) (State, error) {
	doc, header, err := s.read(ctx, accountID, documentID)
	if err != nil {
		return State{}, err
	}
	digest, err := s.canvas.ForAccount(accountID).SourceDigest(ctx, "", "", documentID)
	if err != nil {
		return State{}, err
	}
	state := State{Status: "draft", Target: header.Target, Subject: header.Fields["subject"], To: header.Fields["to"], SourceDigest: digest, CanEdit: doc.CanEditNativeContent}
	row, err := store.New(s.pool).GetMailCanvasDelivery(ctx, documentID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return State{}, err
	}
	found := err == nil
	// A send by any path writes sent into the header, which outranks an
	// older card receipt such as declined or failed.
	if header.Fields["status"] == "sent" {
		state.Status = "sent"
		if found && row.Status == "sent" {
			state.MessageID = row.MessageID
		}
		return state, nil
	}
	if found {
		state.Status, state.Error, state.MessageID = row.Status, row.ErrorMessage, row.MessageID
	}
	return state, nil
}

// Send queues exactly one upload and delivery after checking the reviewed version.
func (s *Service) Send(ctx context.Context, input SendInput) (State, error) {
	if len(input.RequestID) < 16 || len(input.RequestID) > 120 || input.SourceDigest == "" {
		return State{}, document.ErrInvalidInput
	}
	doc, header, err := s.read(ctx, input.AccountID, input.DocumentID)
	if err != nil {
		return State{}, err
	}
	if !doc.CanEditNativeContent {
		return State{}, ErrForbidden
	}
	if header.Fields["status"] == "sent" {
		return State{}, ErrAlreadySent
	}
	if strings.TrimSpace(header.Fields["subject"]) == "" {
		return State{}, document.ErrInvalidInput
	}
	if _, err := mail.ParseAddressList(header.Fields["to"]); err != nil {
		return State{}, document.ErrInvalidInput
	}
	if _, err := s.connection(ctx, input.AccountID, input.ConnectionID, header.Target); err != nil {
		return State{}, err
	}
	reader := s.canvas.ForAccount(input.AccountID)
	digest, err := reader.SourceDigest(ctx, "", "", input.DocumentID)
	if err != nil {
		return State{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return State{}, err
	}
	defer tx.Rollback(ctx)
	q := store.New(tx)
	if err := q.AcquireAdvisoryTransactionLock(ctx, "mail-canvas:"+input.DocumentID); err != nil {
		return State{}, err
	}
	if row, err := q.GetMailCanvasDelivery(ctx, input.DocumentID); err == nil {
		if row.ID == input.RequestID {
			return State{Status: row.Status, Target: header.Target, Subject: header.Fields["subject"], To: header.Fields["to"], Error: row.ErrorMessage, SourceDigest: digest, CanEdit: true}, nil
		}
		if !reopenable(row.Status) {
			return State{}, conflictFor(row.Status)
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return State{}, err
	}
	if digest != input.SourceDigest {
		return State{}, ErrConflict
	}
	row, err := q.StartMailCanvasDelivery(ctx, store.StartMailCanvasDeliveryParams{DocumentID: input.DocumentID, ID: input.RequestID, AccountID: input.AccountID, ConnectionID: pgtype.Text{String: input.ConnectionID, Valid: true}, SourceDigest: digest})
	if err != nil {
		return State{}, err
	}
	if err := jobs.InsertTx(ctx, tx, deliveryArgs{ID: row.ID}, nil); err != nil {
		return State{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return State{}, err
	}
	return State{Status: row.Status, Target: header.Target, Subject: header.Fields["subject"], To: header.Fields["to"], SourceDigest: digest, CanEdit: true}, nil
}

// reopenable says whether the Human may send or decline again: after a
// failure, or after an unknown result they checked in Gmail themselves.
func reopenable(status string) bool { return status == "failed" || status == "unknown" }

func conflictFor(status string) error {
	if status == "sent" {
		return ErrAlreadySent
	}
	return ErrConflict
}

// Decline records that the Human chose not to send; Send is refused afterwards.
func (s *Service) Decline(ctx context.Context, accountID, documentID string) (State, error) {
	doc, header, err := s.read(ctx, accountID, documentID)
	if err != nil {
		return State{}, err
	}
	if !doc.CanEditNativeContent {
		return State{}, ErrForbidden
	}
	if header.Fields["status"] == "sent" {
		return State{}, ErrAlreadySent
	}
	digest, err := s.canvas.ForAccount(accountID).SourceDigest(ctx, "", "", documentID)
	if err != nil {
		return State{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return State{}, err
	}
	defer tx.Rollback(ctx)
	q := store.New(tx)
	if err := q.AcquireAdvisoryTransactionLock(ctx, "mail-canvas:"+documentID); err != nil {
		return State{}, err
	}
	state := State{Status: "declined", Target: header.Target, Subject: header.Fields["subject"], To: header.Fields["to"], SourceDigest: digest, CanEdit: true}
	if row, err := q.GetMailCanvasDelivery(ctx, documentID); err == nil {
		if row.Status == "declined" {
			return state, nil
		}
		if !reopenable(row.Status) {
			return State{}, conflictFor(row.Status)
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return State{}, err
	}
	if _, err := q.DeclineMailCanvasDelivery(ctx, store.DeclineMailCanvasDeliveryParams{DocumentID: documentID, ID: ids.New("mail_delivery"), AccountID: accountID, SourceDigest: digest}); err != nil {
		return State{}, err
	}
	return state, tx.Commit(ctx)
}

// connection returns an active mail connection of the account; target, when
// set, is the canvas's mail app, which the connection must match.
func (s *Service) connection(ctx context.Context, accountID, connectionID, target string) (externalsource.Connection, error) {
	connection, err := s.connections.GetConnection(ctx, accountID, connectionID)
	if errors.Is(err, externalsource.ErrNotFound) {
		return connection, ErrConnectionUnavailable
	}
	if err != nil {
		return connection, err
	}
	if !agentconnectedapps.IsMailCanvasTarget(connection.Provider) || target != "" && connection.Provider != target || connection.Status != "active" {
		return connection, ErrConnectionUnavailable
	}
	return connection, nil
}

// appName names the mail app of a delivery's connection, for its messages.
func (s *Service) appName(ctx context.Context, row store.MailCanvasDelivery) string {
	connection, err := s.connections.GetConnection(ctx, row.AccountID, row.ConnectionID.String)
	if err != nil {
		return agentconnectedapps.MailCanvasAppName(agentconnectedapps.MailCanvasGmail)
	}
	return agentconnectedapps.MailCanvasAppName(connection.Provider)
}

// saveDraft uploads the rendered canvas as the connection's draft.
func (s *Service) saveDraft(ctx context.Context, connection externalsource.Connection, draftID string, built agentconnectedapps.CanvasDraft) (string, error) {
	raw := built.Raw
	if connection.Provider == agentconnectedapps.MailCanvasOutlook {
		provider, ok := s.provider.(outlookProvider)
		if !ok || built.Outlook == nil {
			return "", ErrConnectionUnavailable
		}
		saved, err := provider.SaveOutlookDraft(ctx, connection.UpstreamConnectionID, draftID, *built.Outlook)
		return saved.DraftID, err
	}
	if connection.Provider != agentconnectedapps.MailCanvasFeishu {
		saved, err := s.provider.SaveGmailDraft(ctx, connection.UpstreamConnectionID, draftID, raw)
		return saved.DraftID, err
	}
	message, err := base64.URLEncoding.DecodeString(raw)
	if err != nil {
		return "", err
	}
	return s.connections.SaveFeishuDraft(ctx, connection.UpstreamConnectionID, draftID, message)
}

func (s *Service) sendDraft(ctx context.Context, connection externalsource.Connection, draftID string) (string, error) {
	if connection.Provider == agentconnectedapps.MailCanvasOutlook {
		provider, ok := s.provider.(outlookProvider)
		if !ok {
			return "", ErrConnectionUnavailable
		}
		return provider.SendOutlookDraft(ctx, connection.UpstreamConnectionID, draftID)
	}
	if connection.Provider == agentconnectedapps.MailCanvasFeishu {
		return s.connections.SendFeishuDraft(ctx, connection.UpstreamConnectionID, draftID)
	}
	return s.provider.SendGmailDraft(ctx, connection.UpstreamConnectionID, draftID)
}

// feishuMailboxChanged explains a delivery the owner's lark-cli refused
// before Feishu acted, because it is logged in to another mailbox.
const feishuMailboxChanged = "lark-cli on your Computer is logged in to a different Feishu mailbox than this connection. Nothing was sent. Log lark-cli back in to the connected mailbox and send again."

// draftGone reports a saved draft the mail app no longer has.
func draftGone(err error) bool {
	if status, ok := composio.ErrorStatus(err); ok && status == http.StatusNotFound {
		return true
	}
	return feishu.IsNotFound(err) || errors.Is(err, composio.ErrOutlookDraftNotEditable)
}

type deliveryArgs struct {
	ID string `json:"id"`
}

func (deliveryArgs) Kind() string { return "mail.canvas_delivery" }
func (deliveryArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueueDefault, MaxAttempts: 3}
}

type deliveryWorker struct {
	river.WorkerDefaults[deliveryArgs]
	service *Service
}

func (*deliveryWorker) Timeout(*river.Job[deliveryArgs]) time.Duration { return 10 * time.Minute }

// AddWorker registers delivery and recovery of interrupted operations.
func (s *Service) AddWorker(workers *river.Workers) {
	river.AddWorker(workers, &deliveryWorker{service: s})
}

func (w *deliveryWorker) Work(ctx context.Context, job *river.Job[deliveryArgs]) error {
	s := w.service
	q := store.New(s.pool)
	row, err := q.GetMailCanvasDeliveryByID(ctx, job.Args.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	// Uploading only writes a draft, so an interrupted upload sent nothing;
	// an interrupted send may have gone out and is never replayed.
	if row.Status == "uploading" {
		return s.finish(ctx, row, "failed", "The upload was interrupted. Nothing was sent; send again.")
	}
	name := s.appName(ctx, row)
	if row.Status == "sending" {
		return s.finish(ctx, row, "unknown", "Sending was interrupted. Check Sent in "+name+" before trying again.")
	}
	if row.Status != "queued" {
		return nil
	}
	row, err = q.UpdateMailCanvasDelivery(ctx, store.UpdateMailCanvasDeliveryParams{ID: row.ID, ExpectedStatus: "queued", Status: "uploading", DraftID: row.DraftID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	connection, err := s.connection(ctx, row.AccountID, row.ConnectionID.String, "")
	if err != nil {
		return s.finish(ctx, row, "failed", "The "+name+" account is unavailable. Reconnect it before sending.")
	}
	reader := s.canvas.ForAccount(row.AccountID)
	draft, err := reader.MailCanvasDraftRaw(ctx, connection.Provider, "", "", row.DocumentID, nil, nil, nil)
	if err != nil {
		return s.finish(ctx, row, "failed", "The email could not be prepared. Check its recipients and attachments.")
	}
	if draft.SourceDigest != row.SourceDigest {
		return s.finish(ctx, row, "failed", "The email changed after Send was clicked. Review it and send again.")
	}
	savedID, err := s.saveDraft(ctx, connection, row.DraftID, draft)
	if draftGone(err) && row.DraftID != "" {
		// A mail app may delete a draft once it is sent, so a lost earlier
		// draft may mean an unconfirmed send went out. The next Send starts a
		// new draft.
		row.DraftID = ""
		return s.finish(ctx, row, "failed", "The earlier "+name+" draft is gone, so this email may already have been sent. Check Sent in "+name+"; send again only if it is not there.")
	}
	if errors.Is(err, feishu.ErrMailboxChanged) {
		return s.finish(ctx, row, "failed", feishuMailboxChanged)
	}
	if err != nil {
		return s.finish(ctx, row, "failed", name+" did not accept the upload. Nothing was sent; send again.")
	}
	row.DraftID = savedID
	current, err := reader.SourceDigest(ctx, "", "", row.DocumentID)
	if err != nil || current != row.SourceDigest {
		return s.finish(ctx, row, "failed", "The email changed during upload. Nothing was sent. Review it and send again.")
	}
	if _, err = s.connection(ctx, row.AccountID, row.ConnectionID.String, connection.Provider); err != nil {
		return s.finish(ctx, row, "failed", "The "+name+" account is no longer available. Nothing was sent.")
	}
	row, err = q.UpdateMailCanvasDelivery(ctx, store.UpdateMailCanvasDeliveryParams{ID: row.ID, ExpectedStatus: "uploading", Status: "sending", DraftID: row.DraftID})
	if err != nil {
		return err
	}
	messageID, err := s.sendDraft(ctx, connection, row.DraftID)
	if errors.Is(err, feishu.ErrMailboxChanged) {
		return s.finish(ctx, row, "failed", feishuMailboxChanged)
	}
	if err != nil {
		return s.finish(ctx, row, "unknown", name+" did not confirm delivery. Check Sent before trying again.")
	}
	row.MessageID = messageID
	return s.finish(ctx, row, "sent", "")
}

func (s *Service) finish(ctx context.Context, row store.MailCanvasDelivery, status, message string) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	_, err := store.New(s.pool).UpdateMailCanvasDelivery(ctx, store.UpdateMailCanvasDeliveryParams{ID: row.ID, ExpectedStatus: row.Status, Status: status, DraftID: row.DraftID, MessageID: row.MessageID, ErrorMessage: message})
	return err
}
