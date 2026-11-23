package feishu

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/mail"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

// MailAddress is one address of a message.
type MailAddress struct {
	MailAddress string `json:"mail_address"`
	Name        string `json:"name"`
}

// MailAttachment describes one attachment of a received message.
type MailAttachment struct {
	ID             string `json:"id"`
	Filename       string `json:"filename"`
	AttachmentType int    `json:"attachment_type"`
	IsInline       bool   `json:"is_inline"`
	CID            string `json:"cid"`
}

// MailMessage is a message as the mail API returns it. Bodies and raw are
// base64url; InternalDate is epoch milliseconds.
type MailMessage struct {
	MessageID     string           `json:"message_id"`
	ThreadID      string           `json:"thread_id"`
	SMTPMessageID string           `json:"smtp_message_id"`
	Subject       string           `json:"subject"`
	HeadFrom      MailAddress      `json:"head_from"`
	To            []MailAddress    `json:"to"`
	Cc            []MailAddress    `json:"cc"`
	Bcc           []MailAddress    `json:"bcc"`
	BodyHTML      string           `json:"body_html"`
	BodyPlainText string           `json:"body_plain_text"`
	BodyPreview   string           `json:"body_preview"`
	InternalDate  string           `json:"internal_date"`
	MessageState  int              `json:"message_state"`
	InReplyTo     string           `json:"in_reply_to"`
	References    string           `json:"references"`
	ReplyTo       string           `json:"reply_to"`
	FolderID      string           `json:"folder_id"`
	LabelIDs      []string         `json:"label_ids"`
	Attachments   []MailAttachment `json:"attachments"`
	Raw           string           `json:"raw"`
}

// System folders and labels of a Feishu mailbox.
const (
	FolderInbox    = "INBOX"
	FolderSent     = "SENT"
	FolderArchived = "ARCHIVED"
	LabelUnread    = "UNREAD"
)

// ErrSendDisabled reports a draft send Feishu accepted but did not perform,
// such as one its automation policy blocks: nothing was sent.
var ErrSendDisabled = errors.New("Feishu did not send the draft")

// MaxAttachmentBytes bounds one attachment TeamHub downloads for an Agent.
const MaxAttachmentBytes = 25 << 20

// ReceivedAt is when the message arrived, from its internal date.
func (m MailMessage) ReceivedAt() (time.Time, bool) {
	millis, err := strconv.ParseInt(strings.TrimSpace(m.InternalDate), 10, 64)
	if err != nil {
		return time.Time{}, false
	}
	return time.UnixMilli(millis), true
}

// InboxSince reads the inbox newest first, from pageToken and at most pages
// pages of 20, and returns the messages received at or after since. When the
// pages run out before mail older than since, next is the page to read on
// from: the rest of a backlog is still newer than since and must not be
// skipped. A message without a readable date is left out.
func (m Mailbox) InboxSince(ctx context.Context, since time.Time, pageToken string, pages int) (found []MailMessage, next string, err error) {
	token := pageToken
	for range pages {
		ids, following, err := m.ListMessageIDs(ctx, FolderInbox, false, 20, token)
		if err != nil {
			return nil, "", err
		}
		messages, err := m.BatchGetMessages(ctx, ids, "full")
		if err != nil {
			return nil, "", err
		}
		reachedOlder := false
		for _, message := range messages {
			received, ok := message.ReceivedAt()
			switch {
			case !ok:
			case received.Before(since):
				reachedOlder = true
			default:
				found = append(found, message)
			}
		}
		if following == "" || len(ids) == 0 || reachedOlder {
			return found, "", nil
		}
		token = following
	}
	return found, token, nil
}

// ListMessageIDs lists one folder newest first, as message IDs.
func (m Mailbox) ListMessageIDs(ctx context.Context, folderID string, onlyUnread bool, pageSize int, pageToken string) ([]string, string, error) {
	query := map[string]any{"page_size": pageSize, "folder_id": folderID}
	if onlyUnread {
		query["only_unread"] = true
	}
	if pageToken != "" {
		query["page_token"] = pageToken
	}
	var response struct {
		Data struct {
			Items     []string `json:"items"`
			HasMore   bool     `json:"has_more"`
			PageToken string   `json:"page_token"`
		} `json:"data"`
	}
	if err := m.do(ctx, "message list", http.MethodGet, "messages", query, nil, &response); err != nil {
		return nil, "", err
	}
	return response.Data.Items, nextToken(response.Data.HasMore, response.Data.PageToken), nil
}

// SearchMessageIDs searches the mailbox; folder is a lowercase folder name or
// empty for every folder.
func (m Mailbox) SearchMessageIDs(ctx context.Context, text, folder string, onlyUnread bool, pageSize int, pageToken string) ([]string, string, error) {
	query := map[string]any{"page_size": pageSize}
	if pageToken != "" {
		query["page_token"] = pageToken
	}
	filter := map[string]any{}
	if folder != "" {
		filter["folder"] = []string{folder}
	}
	if onlyUnread {
		filter["is_unread"] = true
	}
	var response struct {
		Data struct {
			Items []struct {
				MetaData struct {
					MessageBizID string `json:"message_biz_id"`
				} `json:"meta_data"`
			} `json:"items"`
			HasMore   bool   `json:"has_more"`
			PageToken string `json:"page_token"`
		} `json:"data"`
	}
	if err := m.do(ctx, "message search", http.MethodPost, "search", query, map[string]any{"query": text, "filter": filter}, &response); err != nil {
		return nil, "", err
	}
	ids := make([]string, 0, len(response.Data.Items))
	for _, item := range response.Data.Items {
		if item.MetaData.MessageBizID != "" {
			ids = append(ids, item.MetaData.MessageBizID)
		}
	}
	return ids, nextToken(response.Data.HasMore, response.Data.PageToken), nil
}

// BatchGetMessages reads up to 20 messages in format, in the order of ids;
// Feishu returns them in any order.
func (m Mailbox) BatchGetMessages(ctx context.Context, ids []string, format string) ([]MailMessage, error) {
	if len(ids) == 0 {
		return []MailMessage{}, nil
	}
	var response struct {
		Data struct {
			Messages []MailMessage `json:"messages"`
		} `json:"data"`
	}
	if err := m.do(ctx, "message batch read", http.MethodPost, "messages/batch_get", nil, map[string]any{"format": format, "message_ids": ids}, &response); err != nil {
		return nil, err
	}
	byID := make(map[string]MailMessage, len(response.Data.Messages))
	for _, message := range response.Data.Messages {
		byID[message.MessageID] = message
	}
	ordered := make([]MailMessage, 0, len(ids))
	for _, id := range ids {
		if message, ok := byID[id]; ok {
			ordered = append(ordered, message)
		}
	}
	return ordered, nil
}

// GetMessage reads one message with its bodies.
func (m Mailbox) GetMessage(ctx context.Context, messageID string) (MailMessage, error) {
	var response struct {
		Data struct {
			Message MailMessage `json:"message"`
		} `json:"data"`
	}
	err := m.do(ctx, "message read", http.MethodGet, "messages/"+url.PathEscape(messageID), map[string]any{"format": "full"}, nil, &response)
	return response.Data.Message, err
}

// ThreadMessages reads every message of a thread with its bodies.
func (m Mailbox) ThreadMessages(ctx context.Context, threadID string) ([]MailMessage, error) {
	var response struct {
		Data struct {
			Thread struct {
				Messages []MailMessage `json:"messages"`
			} `json:"thread"`
		} `json:"data"`
	}
	err := m.do(ctx, "thread read", http.MethodGet, "threads/"+url.PathEscape(threadID), map[string]any{"format": "full"}, nil, &response)
	return response.Data.Thread.Messages, err
}

// attachmentHostDomains are where Feishu and Lark serve attachment
// downloads. TeamHub fetches the link itself from inside its own network, and
// the link comes through the owner's Computer, so it may reach no other host.
var attachmentHostDomains = []string{"feishu.cn", "larksuite.com", "larkoffice.com", "feishucdn.com", "larksuitecdn.com"}

// maxAttachmentRedirects bounds the redirects an attachment download follows.
const maxAttachmentRedirects = 3

// attachmentHost reports whether link is an https URL on Feishu's or Lark's
// attachment domains, on the default port.
func attachmentHost(link *url.URL) bool {
	if link.Scheme != "https" || link.User != nil || (link.Port() != "" && link.Port() != "443") {
		return false
	}
	host := strings.ToLower(link.Hostname())
	return slices.ContainsFunc(attachmentHostDomains, func(domain string) bool {
		return host == domain || strings.HasSuffix(host, "."+domain)
	})
}

// DownloadAttachment returns one attachment's bytes. Feishu hands out a
// presigned URL, which TeamHub fetches itself: it needs no login.
func (m Mailbox) DownloadAttachment(ctx context.Context, messageID, attachmentID string) ([]byte, error) {
	var response struct {
		Data struct {
			DownloadURLs []struct {
				AttachmentID string `json:"attachment_id"`
				DownloadURL  string `json:"download_url"`
			} `json:"download_urls"`
		} `json:"data"`
	}
	path := "messages/" + url.PathEscape(messageID) + "/attachments/download_url"
	if err := m.do(ctx, "attachment link", http.MethodGet, path, map[string]any{"attachment_ids": []string{attachmentID}}, nil, &response); err != nil {
		return nil, err
	}
	link := ""
	for _, item := range response.Data.DownloadURLs {
		if item.AttachmentID == attachmentID {
			link = item.DownloadURL
		}
	}
	parsed, err := url.Parse(link)
	if link == "" || err != nil || !attachmentHost(parsed) {
		return nil, errors.New("Feishu returned no usable attachment link")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
	if err != nil {
		return nil, err
	}
	downloads := *m.downloads
	downloads.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		if len(via) >= maxAttachmentRedirects || !attachmentHost(next.URL) {
			return errors.New("the Feishu attachment link redirected away from Feishu")
		}
		return nil
	}
	response2, err := downloads.Do(request)
	if err != nil {
		return nil, err
	}
	defer response2.Body.Close()
	if response2.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Feishu attachment download answered HTTP %d", response2.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response2.Body, MaxAttachmentBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > MaxAttachmentBytes {
		return nil, ErrAttachmentTooLarge
	}
	return data, nil
}

// ErrAttachmentTooLarge reports an attachment over MaxAttachmentBytes.
var ErrAttachmentTooLarge = errors.New("the Feishu attachment exceeds the download limit")

type draftResponse struct {
	Data struct {
		Draft struct {
			ID      string      `json:"id"`
			Message MailMessage `json:"message"`
		} `json:"draft"`
	} `json:"data"`
}

// Address returns the address of the mailbox's primary mailbox, the identity
// of a mail connection.
func (m Mailbox) Address(ctx context.Context) (string, error) {
	var response struct {
		Data struct {
			PrimaryEmailAddress string `json:"primary_email_address"`
		} `json:"data"`
	}
	if err := m.request(ctx, "mailbox profile", http.MethodGet, "profile", nil, nil, &response); err != nil {
		return "", err
	}
	address := strings.ToLower(strings.TrimSpace(response.Data.PrimaryEmailAddress))
	if address == "" {
		return "", errors.New("the Feishu mailbox has no primary address")
	}
	return address, nil
}

// withSender gives raw a From header naming the mailbox when it has none.
// Feishu refuses a draft without one as an invalid MIME message, and the
// messages TeamHub builds, shared with Gmail, which fills it in, carry none.
func (m Mailbox) withSender(ctx context.Context, raw []byte) ([]byte, error) {
	parsed, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return nil, ErrMalformedMessage
	}
	if parsed.Header.Get("From") != "" {
		return raw, nil
	}
	if err = m.checkIdentity(ctx); err != nil {
		return nil, err
	}
	address := ""
	if m.identity != nil {
		address = m.identity.address
	}
	if address == "" {
		if address, err = m.Address(ctx); err != nil {
			return nil, err
		}
	}
	return append([]byte("From: "+address+"\r\n"), raw...), nil
}

// CreateDraft saves raw, a whole RFC 5322 message, as a new draft.
func (m Mailbox) CreateDraft(ctx context.Context, raw []byte) (string, error) {
	raw, err := m.withSender(ctx, raw)
	if err != nil {
		return "", err
	}
	var response draftResponse
	if err := m.do(ctx, "draft create", http.MethodPost, "drafts", nil, map[string]string{"raw": base64.URLEncoding.EncodeToString(raw)}, &response); err != nil {
		return "", err
	}
	if response.Data.Draft.ID == "" {
		return "", errors.New("Feishu returned no draft ID")
	}
	return response.Data.Draft.ID, nil
}

// UpdateDraft replaces the whole draft with raw.
func (m Mailbox) UpdateDraft(ctx context.Context, draftID string, raw []byte) error {
	raw, err := m.withSender(ctx, raw)
	if err != nil {
		return err
	}
	return m.do(ctx, "draft update", http.MethodPut, "drafts/"+url.PathEscape(draftID), nil, map[string]string{"raw": base64.URLEncoding.EncodeToString(raw)}, nil)
}

// GetDraft reads a draft as its whole message, and its message ID.
func (m Mailbox) GetDraft(ctx context.Context, draftID string) ([]byte, string, error) {
	var response draftResponse
	if err := m.do(ctx, "draft read", http.MethodGet, "drafts/"+url.PathEscape(draftID), map[string]any{"format": "raw"}, nil, &response); err != nil {
		return nil, "", err
	}
	raw, err := DecodeBase64URL(response.Data.Draft.Message.Raw)
	if err != nil || len(raw) == 0 {
		return nil, "", errors.New("Feishu returned no readable draft")
	}
	return raw, response.Data.Draft.Message.MessageID, nil
}

// SendDraft sends a draft now and returns the sent message's IDs.
func (m Mailbox) SendDraft(ctx context.Context, draftID string) (string, string, error) {
	var response struct {
		Data struct {
			MessageID             string `json:"message_id"`
			ThreadID              string `json:"thread_id"`
			AutomationSendDisable *struct {
				Reason string `json:"reason"`
			} `json:"automation_send_disable"`
		} `json:"data"`
	}
	if err := m.do(ctx, "draft send", http.MethodPost, "drafts/"+url.PathEscape(draftID)+"/send", nil, map[string]any{}, &response); err != nil {
		return "", "", err
	}
	if disabled := response.Data.AutomationSendDisable; disabled != nil {
		return "", "", fmt.Errorf("%w: %s", ErrSendDisabled, disabled.Reason)
	}
	return response.Data.MessageID, response.Data.ThreadID, nil
}

// MoveMessages moves messages to a folder, such as FolderArchived.
func (m Mailbox) MoveMessages(ctx context.Context, messageIDs []string, folderID string) error {
	return m.do(ctx, "message move", http.MethodPost, "messages/batch_modify", nil, map[string]any{"message_ids": messageIDs, "add_folder": folderID}, nil)
}

// DecodeBase64URL decodes the base64url Feishu uses, with or without padding.
func DecodeBase64URL(value string) ([]byte, error) {
	value = strings.TrimSpace(value)
	if decoded, err := base64.URLEncoding.DecodeString(value); err == nil {
		return decoded, nil
	}
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(value, "="))
}

func nextToken(hasMore bool, token string) string {
	if !hasMore {
		return ""
	}
	return token
}
