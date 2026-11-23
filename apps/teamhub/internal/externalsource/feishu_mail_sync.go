package externalsource

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/feishu"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
)

// mailRenderer renders a message into the Wiki document every mailbox's mail
// becomes; the Composio client does it for Gmail and Outlook too.
type mailRenderer interface {
	RenderImportedMail(provider string, mail composio.ImportedMail) (composio.AppDocument, bool, error)
}

// feishuSyncFolders are the folders a Feishu mailbox syncs into the Wiki,
// mail received and mail sent, read one after the other.
var feishuSyncFolders = []string{feishu.FolderInbox, feishu.FolderSent}

type feishuSyncCursor struct {
	Folder int    `json:"f"`
	Token  string `json:"t,omitempty"`
}

// isNoBackfillMailProvider reports a mail provider whose connection starts
// syncing from the moment it connects instead of importing past mail first.
func isNoBackfillMailProvider(provider string) bool { return isFeishuApp(provider) }

// fetchMailImportPage reads one page of a mailbox window: Feishu's here,
// every other provider's through Composio.
func (s *Service) fetchMailImportPage(ctx context.Context, upstreamID, provider string, options composio.MailImportPageOptions) (composio.MailImportPage, error) {
	if isFeishuApp(provider) {
		return s.fetchFeishuMailPage(ctx, upstreamID, options)
	}
	return s.provider.FetchMailImportPage(ctx, upstreamID, provider, options)
}

// fetchFeishuMailPage lists each sync folder newest first and keeps the mail
// inside the window. Feishu lists have no time filter, so a folder ends at the
// first page whose every message is older than the window.
func (s *Service) fetchFeishuMailPage(ctx context.Context, upstreamID string, options composio.MailImportPageOptions) (composio.MailImportPage, error) {
	if s.feishu == nil || s.feishu.renderer == nil {
		return composio.MailImportPage{}, ErrUnavailable
	}
	var cursor feishuSyncCursor
	if options.Cursor != "" {
		if err := json.Unmarshal([]byte(options.Cursor), &cursor); err != nil || cursor.Folder < 0 || cursor.Folder >= len(feishuSyncFolders) {
			return composio.MailImportPage{}, errors.New("invalid Feishu mail cursor")
		}
	}
	before := func(operation string) error {
		if options.BeforeProviderCall != nil {
			return options.BeforeProviderCall(ctx, operation)
		}
		return nil
	}
	if err := before("reach the Feishu mailbox"); err != nil {
		return composio.MailImportPage{}, err
	}
	mailbox, err := s.feishuMailbox(ctx, upstreamID)
	if err != nil {
		return composio.MailImportPage{}, err
	}
	for {
		folder := feishuSyncFolders[cursor.Folder]
		if err = before("list Feishu mail"); err != nil {
			return composio.MailImportPage{}, err
		}
		ids, next, err := mailbox.ListMessageIDs(ctx, folder, false, min(options.Limit, 20), cursor.Token)
		if err != nil {
			return composio.MailImportPage{}, err
		}
		var messages []feishu.MailMessage
		if len(ids) > 0 {
			if err = before("read Feishu mail"); err != nil {
				return composio.MailImportPage{}, err
			}
			if messages, err = mailbox.BatchGetMessages(ctx, ids, "full"); err != nil {
				return composio.MailImportPage{}, err
			}
		}
		page := composio.MailImportPage{Read: len(ids)}
		older := 0
		for _, message := range messages {
			millis, err := strconv.ParseInt(message.InternalDate, 10, 64)
			if err != nil {
				page.Skipped++
				continue
			}
			received := time.UnixMilli(millis)
			if received.Before(options.Start) {
				older++
				continue
			}
			// Drafts never enter; a draft that lands in a folder is no mail yet.
			if !received.Before(options.End) || message.MessageState == 3 {
				continue
			}
			document, ok, err := s.feishu.renderer.RenderImportedMail(FeishuMailAppKey, importedFeishuMail(message, folder == feishu.FolderSent || message.MessageState == 2))
			if err != nil {
				page.Skipped++
				continue
			}
			if ok {
				page.Documents = append(page.Documents, document)
			}
		}
		// The folder ends when Feishu has no more, or this whole page is older.
		if next == "" || len(messages) > 0 && older == len(messages) {
			cursor = feishuSyncCursor{Folder: cursor.Folder + 1}
		} else {
			cursor.Token = next
		}
		if cursor.Folder >= len(feishuSyncFolders) {
			return page, nil
		}
		// An empty folder moves on in this call: a page must read mail or end.
		if page.Read == 0 {
			continue
		}
		encoded, _ := json.Marshal(cursor)
		page.NextCursor = string(encoded)
		return page, nil
	}
}

func importedFeishuMail(message feishu.MailMessage, outbound bool) composio.ImportedMail {
	millis, _ := strconv.ParseInt(message.InternalDate, 10, 64)
	mail := composio.ImportedMail{
		ID: message.MessageID, ThreadID: message.ThreadID, Subject: message.Subject,
		From: headerAddress(message.HeadFrom), To: headerAddresses(message.To), Cc: headerAddresses(message.Cc),
		Received: time.UnixMilli(millis), Body: decodedText(message.BodyPlainText), Outbound: outbound,
	}
	if html := decodedText(message.BodyHTML); html != "" {
		mail.Body, mail.HTML = html, true
	}
	return mail
}

func headerAddress(address feishu.MailAddress) string {
	if address.Name == "" {
		return address.MailAddress
	}
	return strings.ReplaceAll(address.Name, `"`, "") + " <" + address.MailAddress + ">"
}

func headerAddresses(addresses []feishu.MailAddress) string {
	values := make([]string, 0, len(addresses))
	for _, address := range addresses {
		values = append(values, headerAddress(address))
	}
	return strings.Join(values, ", ")
}

// feishuListenerPages bounds how far one listener poll reads back through the
// inbox; a larger backlog is read on from where the poll stopped.
const feishuListenerPages = 3

// FeishuInboxSince returns inbox mail received at or after since, newest
// first, for a Feishu Mail listener, reading from pageToken. next is where the
// next poll reads on when the backlog was larger than one poll reads. A page
// token Feishu no longer accepts starts over from the newest mail; the
// listener drops what it already reported.
func (s *Service) FeishuInboxSince(ctx context.Context, upstreamID string, since time.Time, pageToken string) ([]reminder.FeishuInboxMessage, string, error) {
	if s.feishu == nil {
		return nil, "", ErrUnavailable
	}
	mailbox, err := s.feishuMailbox(ctx, upstreamID)
	if err != nil {
		return nil, "", err
	}
	messages, next, err := mailbox.InboxSince(ctx, since, pageToken, feishuListenerPages)
	var refused *feishu.APIError
	if pageToken != "" && errors.As(err, &refused) && !feishu.IsAuthFailure(err) {
		messages, next, err = mailbox.InboxSince(ctx, since, "", feishuListenerPages)
	}
	if err != nil {
		return nil, "", err
	}
	found := make([]reminder.FeishuInboxMessage, 0, len(messages))
	for _, message := range messages {
		mail := importedFeishuMail(message, false)
		found = append(found, reminder.FeishuInboxMessage{
			ID: message.MessageID, ThreadID: message.ThreadID, From: mail.From, To: mail.To, Subject: mail.Subject,
			Body: composio.PollMailBody(mail.Body, mail.HTML), Received: mail.Received,
		})
	}
	return found, next, nil
}
