package agentconnectedapps

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// CanvasSourceReader reads the current, authorized source of a saved draft.
type CanvasSourceReader interface {
	SourceDigest(context.Context, string, string, string) (string, error)
}

// SetCanvasReader enables source checks before a canvas draft is confirmed or sent.
func (s *Service) SetCanvasReader(reader CanvasSourceReader) { s.canvasSource = reader }

// SourceDigest fingerprints mail content while ignoring delivery bookkeeping.
func (s *Canvas) SourceDigest(ctx context.Context, tenantID, agentID, documentID string) (string, error) {
	content, err := s.CanvasExport(ctx, tenantID, agentID, documentID, "blocks")
	if err != nil {
		return "", err
	}
	return canvasSourceDigest(content)
}

func canvasSourceDigest(content []byte) (string, error) {
	var typed struct {
		Blocks []CanvasBlock `json:"blocks"`
	}
	var source struct {
		Blocks []map[string]any `json:"blocks"`
	}
	if json.Unmarshal(content, &typed) != nil || json.Unmarshal(content, &source) != nil || len(source.Blocks) == 0 {
		return "", document.ErrInvalidInput
	}
	header, canvas := ReadCanvasHeader(typed.Blocks)
	if canvas {
		fields := map[string]string{}
		for _, key := range []string{"to", "cc", "subject"} {
			fields[key] = header.Fields[key]
		}
		source.Blocks[0] = map[string]any{"target": header.Target, "fields": fields}
	}
	return digestOf(source.Blocks), nil
}

// draftLeaseDuration bounds one draft save; its upload gets a minute less.
const draftLeaseDuration = 10 * time.Minute

// draftLeaseWait bounds how long a save waits for another save of the same
// connection, including a lease a crashed process left until it expires.
const draftLeaseWait = 30 * time.Second

// acquireDraftLease waits until no other save of this connection holds it.
func (s *Service) acquireDraftLease(ctx context.Context, connectionID, holder string) error {
	ctx, cancel := context.WithTimeout(ctx, draftLeaseWait)
	defer cancel()
	for {
		taken, err := store.New(s.pool).AcquireGmailCanvasDraftLease(ctx, store.AcquireGmailCanvasDraftLeaseParams{
			ConnectionID: connectionID, Holder: holder, Seconds: draftLeaseDuration.Seconds(),
		})
		if err == nil && taken == 1 {
			return nil
		}
		if err != nil && ctx.Err() == nil {
			return unavailableError(err)
		}
		select {
		case <-ctx.Done():
			return &Error{Code: "provider_unavailable", Message: "Another draft save on this mail connection is still running; try again shortly.", Retryable: true, cause: ctx.Err()}
		case <-time.After(250 * time.Millisecond):
		}
	}
}

// SaveGmailCanvasDraft binds the saved draft to the exact canvas source it used.
func (s *Service) SaveGmailCanvasDraft(ctx context.Context, token, connectionID, draftID string, built CanvasDraft) (composio.GmailDraft, error) {
	return s.SaveMailCanvasDraft(ctx, token, connectionID, MailCanvasGmail, draftID, built)
}

// SaveMailCanvasDraft saves a canvas built for target as a draft of the
// connection's mail app and binds it to the exact canvas source it used.
func (s *Service) SaveMailCanvasDraft(ctx context.Context, token, connectionID, target, draftID string, built CanvasDraft) (composio.GmailDraft, error) {
	if built.DocumentID == "" || built.SourceDigest == "" {
		return composio.GmailDraft{}, ErrInvalid
	}
	if s == nil || s.pool == nil {
		return composio.GmailDraft{}, unavailableError(nil)
	}
	// Saves of one connection run one at a time, so the binding always names
	// what the mailbox holds. The lease holds no database connection while
	// the upload runs; the upload ends before the lease can expire.
	holder := ids.New("draft_lease")
	if err := s.acquireDraftLease(ctx, connectionID, holder); err != nil {
		return composio.GmailDraft{}, err
	}
	defer func() {
		release, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = store.New(s.pool).ReleaseGmailCanvasDraftLease(release, store.ReleaseGmailCanvasDraftLeaseParams{ConnectionID: connectionID, Holder: holder})
	}()
	upload, cancel := context.WithTimeout(ctx, draftLeaseDuration-time.Minute)
	var draft composio.GmailDraft
	var err error
	if target == MailCanvasOutlook {
		authorizedTarget, authErr := s.MailCanvasTargetOf(ctx, token, connectionID)
		if authErr != nil || authorizedTarget != target {
			cancel()
			if authErr != nil {
				return composio.GmailDraft{}, authErr
			}
			return composio.GmailDraft{}, ErrInvalid
		}
		// Invalidate the old binding before a multi-request replacement, so a
		// partial attachment upload cannot be sent through an earlier confirmation.
		if draftID != "" {
			err = store.New(s.pool).UpsertGmailCanvasDraft(ctx, store.UpsertGmailCanvasDraftParams{ConnectionID: connectionID, DraftID: draftID, DocumentID: built.DocumentID, SourceDigest: digestOf(holder)})
			if err != nil {
				cancel()
				return composio.GmailDraft{}, err
			}
		}
		draft, err = s.saveOutlookDraft(upload, token, connectionID, draftID, built.Outlook)
	} else if target == MailCanvasFeishu {
		raw, decodeErr := base64.URLEncoding.DecodeString(built.Raw)
		if decodeErr != nil {
			cancel()
			return composio.GmailDraft{}, ErrInvalid
		}
		draft, err = s.saveFeishuDraft(upload, token, connectionID, draftID, raw)
	} else {
		draft, err = s.SaveGmailDraft(upload, token, connectionID, draftID, built.Raw)
	}
	cancel()
	if err != nil {
		return draft, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return composio.GmailDraft{}, uncertainExecutionError(err)
	}
	defer tx.Rollback(ctx)
	q := store.New(tx)
	// A lease lost to expiry leaves the draft unbound, so no send trusts it.
	if _, err := q.HoldGmailCanvasDraftLease(ctx, store.HoldGmailCanvasDraftLeaseParams{ConnectionID: connectionID, Holder: holder}); err != nil {
		return composio.GmailDraft{}, uncertainExecutionError(err)
	}
	err = q.UpsertGmailCanvasDraft(ctx, store.UpsertGmailCanvasDraftParams{
		ConnectionID: connectionID, DraftID: draft.DraftID, DocumentID: built.DocumentID, SourceDigest: built.SourceDigest,
	})
	if err != nil {
		return composio.GmailDraft{}, uncertainExecutionError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return composio.GmailDraft{}, uncertainExecutionError(err)
	}
	return draft, nil
}

// canvasSend is the canvas a confirmed mail draft send was bound to; both
// fields are empty for a draft that came from no canvas.
type canvasSend struct{ digest, documentID string }

// recordCanvasSend marks a canvas sent, or possibly sent, by an Agent's
// confirmed send, so its chat card never sends it again.
func (s *Service) recordCanvasSend(ctx context.Context, connection externalsource.AgentToolConnection, send canvasSend, status, message string) {
	if send.documentID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if err := store.New(s.pool).RecordAgentMailCanvasSend(ctx, store.RecordAgentMailCanvasSendParams{
		DocumentID: send.documentID, ID: ids.New("mail_delivery"), AccountID: connection.AccountID,
		ConnectionID: pgtype.Text{String: connection.ID, Valid: true}, SourceDigest: send.digest,
		Status: status, ErrorMessage: message,
	}); err != nil && s.logger != nil {
		s.logger.Error("connected_apps.canvas_send_record_failed", "document_id", send.documentID, "error", err)
	}
}

func (s *Service) checkedCanvasSource(ctx context.Context, connection externalsource.AgentToolConnection, action confirmationAction) (canvasSend, error) {
	if action.ToolSlug != "GMAIL_SEND_DRAFT" && action.ToolSlug != "FEISHU_MAIL_SEND_DRAFT" && action.ToolSlug != "OUTLOOK_SEND_DRAFT" || s.pool == nil {
		return canvasSend{}, nil
	}
	name, command := "Gmail", "gmail canvas-draft --update"
	if action.ToolSlug == "FEISHU_MAIL_SEND_DRAFT" {
		name, command = "Feishu Mail", "feishu-mail canvas-draft --update"
	}
	draftKey := "draft_id"
	if action.ToolSlug == "OUTLOOK_SEND_DRAFT" {
		name, command, draftKey = "Outlook", "outlook canvas-draft --update", "message_id"
	}
	q := store.New(s.pool)
	saved, err := q.GetGmailCanvasDraft(ctx, store.GetGmailCanvasDraftParams{ConnectionID: connection.ID, DraftID: str(action.Arguments, draftKey)})
	if errors.Is(err, pgx.ErrNoRows) {
		if action.CanvasSourceDigest != "" {
			return canvasSend{}, unavailableError(err)
		}
		return canvasSend{}, nil
	}
	if err != nil {
		return canvasSend{}, unavailableError(err)
	}
	if s.canvasSource == nil {
		return canvasSend{}, unavailableError(nil)
	}
	held, err := q.MailCanvasDeliveryHolds(ctx, saved.DocumentID)
	if err != nil {
		return canvasSend{}, unavailableError(err)
	}
	if held {
		return canvasSend{}, &Error{Code: "invalid_input", Message: "The Human is sending or already sent this email from its card in the chat; do not send it again."}
	}
	registration, err := q.GetAgentRegistrationByActor(ctx, store.GetAgentRegistrationByActorParams{TenantID: saved.TenantID, ActorID: connection.AgentActorID})
	if err != nil {
		return canvasSend{}, unavailableError(err)
	}
	current, err := s.canvasSource.SourceDigest(ctx, saved.TenantID, registration.AgentManagementID.String, saved.DocumentID)
	if err != nil {
		return canvasSend{}, &Error{Code: "invalid_input", Message: "The email canvas could not be checked. Update the " + name + " draft from the canvas and request a new confirmation before sending.", cause: err}
	}
	if current != saved.SourceDigest || (action.CanvasSourceDigest != "" && current != action.CanvasSourceDigest) {
		return canvasSend{}, &Error{Code: "invalid_input", Message: "The email canvas changed after the " + name + " draft was saved. Update that draft with " + command + " and request a new send confirmation; the old draft was not sent.", Issues: []Issue{{Path: "draft_id", Code: "canvas_draft_stale", Message: "Update the draft from the current canvas, including its attachments, before sending."}}}
	}
	return canvasSend{digest: current, documentID: saved.DocumentID}, nil
}
