package externalsource

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/feishu"
)

// FeishuMailToolVersion is the one version of the Feishu Mail tools TeamHub
// serves; the CLI pins it like a Composio toolkit version.
const FeishuMailToolVersion = "20261121_00"

// The Feishu Mail tools. Their results are mail in the CLI's shape, so the
// CLI does not decode Feishu's own.
const (
	FeishuMailListMessages = "FEISHU_MAIL_LIST_MESSAGES"
	FeishuMailGetMessage   = "FEISHU_MAIL_GET_MESSAGE"
	FeishuMailGetThread    = "FEISHU_MAIL_GET_THREAD"
	FeishuMailGetDraft     = "FEISHU_MAIL_GET_DRAFT"
	FeishuMailGetAttach    = "FEISHU_MAIL_GET_ATTACHMENT"
	FeishuMailCreateDraft  = "FEISHU_MAIL_CREATE_DRAFT"
	FeishuMailUpdateDraft  = "FEISHU_MAIL_UPDATE_DRAFT"
	FeishuMailSendDraft    = "FEISHU_MAIL_SEND_DRAFT"
	FeishuMailArchive      = "FEISHU_MAIL_ARCHIVE"
)

type feishuMailTool struct {
	name, description string
	parameters        map[string]any
}

func jsonSchemaObject(required []string, properties map[string]any) map[string]any {
	return map[string]any{"type": "object", "additionalProperties": false, "required": required, "properties": properties}
}

var (
	idProperty      = map[string]any{"type": "string", "minLength": 1, "maxLength": 512}
	addressesSchema = map[string]any{"type": "array", "maxItems": 100, "items": map[string]any{"type": "string", "minLength": 3, "maxLength": 320}}
	draftFields     = map[string]any{
		"to": addressesSchema, "cc": addressesSchema, "bcc": addressesSchema,
		"subject":     map[string]any{"type": "string", "maxLength": 500},
		"body":        map[string]any{"type": "string", "maxLength": 1 << 20},
		"body_format": map[string]any{"enum": []any{"text", "html"}},
		"attachments": map[string]any{"type": "array", "maxItems": 20, "items": jsonSchemaObject(
			[]string{"name", "content_base64"}, map[string]any{
				"name":           map[string]any{"type": "string", "minLength": 1, "maxLength": 255},
				"content_type":   map[string]any{"type": "string", "maxLength": 255},
				"content_base64": map[string]any{"type": "string"},
			})},
	}
)

func withFields(base map[string]any, extra map[string]any) map[string]any {
	merged := map[string]any{}
	for key, value := range base {
		merged[key] = value
	}
	for key, value := range extra {
		merged[key] = value
	}
	return merged
}

var feishuMailTools = map[string]feishuMailTool{
	FeishuMailListMessages: {"List Feishu mail", "List a folder newest first, or search the mailbox.", jsonSchemaObject([]string{"folder", "page_size"}, map[string]any{
		"folder":      map[string]any{"enum": []any{"inbox", "sent", "all"}},
		"query":       map[string]any{"type": "string", "minLength": 1, "maxLength": 50},
		"unread_only": map[string]any{"type": "boolean"},
		"page_size":   map[string]any{"type": "integer", "minimum": 1, "maximum": 20},
		"page_token":  map[string]any{"type": "string", "minLength": 1},
	})},
	FeishuMailGetMessage: {"Read a Feishu message", "Read one message with its bodies and attachment list.", jsonSchemaObject([]string{"message_id"}, map[string]any{"message_id": idProperty})},
	FeishuMailGetThread: {"Read a Feishu thread", "Read a thread's messages oldest first.", jsonSchemaObject([]string{"thread_id"}, map[string]any{
		"thread_id": idProperty, "page_size": map[string]any{"type": "integer", "minimum": 1, "maximum": 20}, "page_token": map[string]any{"type": "string", "minLength": 1},
	})},
	FeishuMailGetDraft:  {"Read a Feishu draft", "Read a draft as the mail it will send.", jsonSchemaObject([]string{"draft_id"}, map[string]any{"draft_id": idProperty})},
	FeishuMailGetAttach: {"Download a Feishu attachment", "Return one attachment's bytes as base64.", jsonSchemaObject([]string{"message_id", "attachment_id"}, map[string]any{"message_id": idProperty, "attachment_id": idProperty})},
	FeishuMailCreateDraft: {"Create a Feishu draft", "Save a new message, or a reply to reply_to_message_id, as a draft without sending it.", jsonSchemaObject([]string{}, withFields(draftFields, map[string]any{
		"reply_to_message_id": idProperty, "reply_all": map[string]any{"type": "boolean"},
	}))},
	FeishuMailUpdateDraft: {"Update a Feishu draft", "Change the given fields of a draft and add attachments; other fields and attachments are kept.", jsonSchemaObject([]string{"draft_id"}, withFields(draftFields, map[string]any{"draft_id": idProperty}))},
	FeishuMailSendDraft:   {"Send a Feishu draft", "Send a saved draft now.", jsonSchemaObject([]string{"draft_id"}, map[string]any{"draft_id": idProperty})},
	FeishuMailArchive:     {"Archive a Feishu message", "Move a message to the archive folder.", jsonSchemaObject([]string{"message_id"}, map[string]any{"message_id": idProperty})},
}

// FeishuMailTools serves the Feishu Mail tools to Agents through the same
// admission, confirmation and logging as Composio's tools.
type FeishuMailTools struct{ service *Service }

// FeishuMailTools returns the Feishu Mail tool provider.
func (s *Service) FeishuMailTools() FeishuMailTools { return FeishuMailTools{service: s} }

// Toolkit is the toolkit slug Feishu connections record.
func (FeishuMailTools) Toolkit() string { return feishuToolkit }

// Owns reports whether slug is a Feishu Mail tool.
func (FeishuMailTools) Owns(slug string) bool {
	_, ok := feishuMailTools[slug]
	return ok
}

// GetTool describes a tool at the one version TeamHub serves.
func (FeishuMailTools) GetTool(_ context.Context, slug, _ string) (composio.Tool, error) {
	definition, ok := feishuMailTools[slug]
	if !ok {
		return composio.Tool{}, ErrNotFound
	}
	tool := composio.Tool{Slug: slug, Name: definition.name, Description: definition.description, InputParameters: definition.parameters, Version: FeishuMailToolVersion}
	tool.Toolkit.Slug = feishuToolkit
	return tool, nil
}

// ConnectionStatus reports an Agent's active connection as active without a
// Computer call, which would add a lark-cli run to every tool call: the
// connection's own checks follow the owner's login, and a call that finds it
// broken fails as not active.
func (FeishuMailTools) ConnectionStatus(context.Context, string) (composio.ConnectionStatus, error) {
	return composio.ConnectionActive, nil
}

// ExecuteTool runs one call. Malformed arguments fail with ErrInvalid before
// Feishu is called; a refusal from Feishu is an unsuccessful execution with
// its reason, and anything else may have taken effect.
func (t FeishuMailTools) ExecuteTool(ctx context.Context, upstreamID, slug, version string, arguments map[string]any) (composio.ToolExecution, error) {
	if !t.Owns(slug) || version != FeishuMailToolVersion {
		return composio.ToolExecution{}, ErrNotFound
	}
	var data map[string]any
	mailbox, err := t.service.feishuMailbox(ctx, upstreamID)
	if err == nil {
		call := feishuMailCall{service: t.service, mailbox: mailbox, upstreamID: upstreamID, args: arguments}
		data, err = call.run(ctx, slug)
	}
	var apiErr *feishu.APIError
	var computer *feishu.ComputerError
	switch {
	case err == nil:
		return composio.ToolExecution{Successful: true, Data: data}, nil
	case errors.Is(err, feishu.ErrMailboxChanged):
		return refusal("lark-cli on the Computer that runs your Another Me is logged in to a different Feishu mailbox than this connection, so nothing was read or sent. Log lark-cli back in to the connected mailbox, or connect the other mailbox."), nil
	case feishu.IsAuthFailure(err):
		// lark-cli refused before Feishu acted: the owner's login no longer works.
		return composio.ToolExecution{}, errors.Join(ErrNotActive, err)
	case errors.As(err, &apiErr):
		return refusal(fmt.Sprintf("Feishu refused the call (code %d): %s", apiErr.Code, apiErr.Message)), nil
	case errors.As(err, &computer) && computer.Status == feishu.StatusNotInstalled:
		return refusal("lark-cli is not installed on the Computer that runs your Another Me. Install it, sign in, and try again."), nil
	case errors.As(err, &computer) && computer.Status == feishu.StatusComputerOffline:
		return refusal("Feishu Mail runs through lark-cli on the Computer that runs your Another Me, and that Computer is offline."), nil
	case errors.Is(err, feishu.ErrSendDisabled), errors.Is(err, feishu.ErrAttachmentTooLarge), errors.Is(err, feishu.ErrMalformedMessage):
		return refusal(err.Error()), nil
	default:
		return composio.ToolExecution{}, err
	}
}

func refusal(reason string) composio.ToolExecution {
	encoded, _ := json.Marshal(reason)
	return composio.ToolExecution{Successful: false, Error: encoded}
}

type feishuMailCall struct {
	service    *Service
	mailbox    feishu.Mailbox
	upstreamID string
	args       map[string]any
}

func (c feishuMailCall) run(ctx context.Context, slug string) (map[string]any, error) {
	switch slug {
	case FeishuMailListMessages:
		return c.list(ctx)
	case FeishuMailGetMessage:
		message, err := c.mailbox.GetMessage(ctx, c.str("message_id"))
		if err != nil {
			return nil, err
		}
		return map[string]any{"message": cliMail(message, false)}, nil
	case FeishuMailGetThread:
		return c.thread(ctx)
	case FeishuMailGetDraft:
		return c.draft(ctx)
	case FeishuMailGetAttach:
		data, err := c.mailbox.DownloadAttachment(ctx, c.str("message_id"), c.str("attachment_id"))
		if err != nil {
			return nil, err
		}
		return map[string]any{"attachment_id": c.str("attachment_id"), "size_bytes": len(data), "content_base64": base64.StdEncoding.EncodeToString(data)}, nil
	case FeishuMailCreateDraft:
		return c.createDraft(ctx)
	case FeishuMailUpdateDraft:
		return c.updateDraft(ctx)
	case FeishuMailSendDraft:
		messageID, threadID, err := c.mailbox.SendDraft(ctx, c.str("draft_id"))
		if err != nil {
			return nil, err
		}
		return withoutEmpty(map[string]any{"draft_id": c.str("draft_id"), "message_id": messageID, "thread_id": threadID}), nil
	default:
		if err := c.mailbox.MoveMessages(ctx, []string{c.str("message_id")}, feishu.FolderArchived); err != nil {
			return nil, err
		}
		return map[string]any{"message_id": c.str("message_id")}, nil
	}
}

func (c feishuMailCall) list(ctx context.Context) (map[string]any, error) {
	folder, query := c.str("folder"), strings.TrimSpace(c.str("query"))
	unread, _ := c.args["unread_only"].(bool)
	pageSize := c.integer("page_size", 20)
	var ids []string
	var next string
	var err error
	if query != "" {
		searchFolder := map[string]string{"inbox": "inbox", "sent": "sent"}[folder]
		ids, next, err = c.mailbox.SearchMessageIDs(ctx, query, searchFolder, unread, min(pageSize, 15), c.str("page_token"))
	} else {
		folderID := map[string]string{"inbox": feishu.FolderInbox, "sent": feishu.FolderSent}[folder]
		if folderID == "" {
			return nil, errors.Join(ErrInvalid, errors.New("Feishu lists one folder at a time"))
		}
		ids, next, err = c.mailbox.ListMessageIDs(ctx, folderID, unread, pageSize, c.str("page_token"))
	}
	if err != nil {
		return nil, err
	}
	messages, err := c.mailbox.BatchGetMessages(ctx, ids, "metadata")
	if err != nil {
		return nil, err
	}
	summaries := make([]any, 0, len(messages))
	for _, message := range messages {
		summaries = append(summaries, cliMail(message, true))
	}
	return withoutEmpty(map[string]any{"messages": summaries, "next_page_token": next}), nil
}

// thread pages through a thread oldest first; Feishu returns it whole, so
// the page token is an offset.
func (c feishuMailCall) thread(ctx context.Context) (map[string]any, error) {
	messages, err := c.mailbox.ThreadMessages(ctx, c.str("thread_id"))
	if err != nil {
		return nil, err
	}
	slices.SortStableFunc(messages, func(a, b feishu.MailMessage) int {
		first, _ := strconv.ParseInt(a.InternalDate, 10, 64)
		second, _ := strconv.ParseInt(b.InternalDate, 10, 64)
		return int(min(max(first-second, -1), 1))
	})
	offset := 0
	if token := c.str("page_token"); token != "" {
		if offset, err = strconv.Atoi(token); err != nil || offset < 0 || offset > len(messages) {
			return nil, errors.Join(ErrInvalid, errors.New("the thread page token is invalid"))
		}
	}
	end := min(offset+c.integer("page_size", 20), len(messages))
	page := make([]any, 0, end-offset)
	for _, message := range messages[offset:end] {
		page = append(page, cliMail(message, false))
	}
	next := ""
	if end < len(messages) {
		next = strconv.Itoa(end)
	}
	return withoutEmpty(map[string]any{"messages": page, "next_page_token": next}), nil
}

func (c feishuMailCall) draft(ctx context.Context) (map[string]any, error) {
	raw, messageID, err := c.mailbox.GetDraft(ctx, c.str("draft_id"))
	if err != nil {
		return nil, err
	}
	message, err := feishu.ParseMessage(raw)
	if err != nil {
		return nil, err
	}
	mail := map[string]any{"messageId": firstNonEmpty(messageID, c.str("draft_id")), "subject": message.Subject,
		"to": cliAddresses(message.To), "cc": cliAddresses(message.Cc), "bcc": cliAddresses(message.Bcc), "bodyText": message.Text}
	if message.HTML != "" {
		mail["bodyHtml"] = message.HTML
	}
	attachments := make([]any, 0, len(message.Attachments))
	for _, attachment := range message.Attachments {
		attachments = append(attachments, map[string]any{"name": attachment.Name, "mimeType": attachment.ContentType, "sizeBytes": len(attachment.Data), "isInline": attachment.Inline, "type": "file"})
	}
	mail["attachments"] = attachments
	return map[string]any{"draft_id": c.str("draft_id"), "message": mail}, nil
}

func (c feishuMailCall) createDraft(ctx context.Context) (map[string]any, error) {
	message := feishu.Message{}
	if replyTo := c.str("reply_to_message_id"); replyTo != "" {
		original, err := c.mailbox.GetMessage(ctx, replyTo)
		if err != nil {
			return nil, err
		}
		replyAll, _ := c.args["reply_all"].(bool)
		message = c.service.feishuReply(ctx, c.upstreamID, original, replyAll)
	}
	if err := c.apply(&message); err != nil {
		return nil, err
	}
	if len(message.To)+len(message.Cc)+len(message.Bcc) == 0 {
		return nil, errors.Join(ErrInvalid, errors.New("a draft needs at least one recipient"))
	}
	raw, err := feishu.BuildMessage(message)
	if err != nil {
		return nil, err
	}
	draftID, err := c.mailbox.CreateDraft(ctx, raw)
	if err != nil {
		return nil, err
	}
	return map[string]any{"draft_id": draftID}, nil
}

func (c feishuMailCall) updateDraft(ctx context.Context) (map[string]any, error) {
	draftID := c.str("draft_id")
	raw, _, err := c.mailbox.GetDraft(ctx, draftID)
	if err != nil {
		return nil, err
	}
	message, err := feishu.ParseMessage(raw)
	if err != nil {
		return nil, err
	}
	if err = c.apply(&message); err != nil {
		return nil, err
	}
	if raw, err = feishu.BuildMessage(message); err != nil {
		return nil, err
	}
	if err = c.mailbox.UpdateDraft(ctx, draftID, raw); err != nil {
		return nil, err
	}
	return map[string]any{"draft_id": draftID}, nil
}

// apply sets the fields the call gives and appends its attachments.
func (c feishuMailCall) apply(message *feishu.Message) error {
	for name, target := range map[string]*[]string{"to": &message.To, "cc": &message.Cc, "bcc": &message.Bcc} {
		if values, ok := c.args[name]; ok {
			*target = stringList(values)
		}
	}
	if subject, ok := c.args["subject"].(string); ok {
		message.Subject = subject
	}
	if body, ok := c.args["body"].(string); ok {
		if c.str("body_format") == "html" {
			message.HTML, message.Text = body, ""
		} else {
			message.Text, message.HTML = body, ""
		}
	}
	files, _ := c.args["attachments"].([]any)
	for _, item := range files {
		file, _ := item.(map[string]any)
		name, _ := file["name"].(string)
		encoded, _ := file["content_base64"].(string)
		data, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || strings.TrimSpace(name) == "" || strings.ContainsAny(name, "\r\n") {
			return errors.Join(ErrInvalid, errors.New("an attachment is malformed"))
		}
		contentType, _ := file["content_type"].(string)
		message.Attachments = append(message.Attachments, feishu.Attachment{Name: name, ContentType: contentType, Data: data})
	}
	return nil
}

// feishuReply addresses a reply to original and threads it under it. A reply
// to all leaves out the replying mailbox itself.
func (s *Service) feishuReply(ctx context.Context, upstreamID string, original feishu.MailMessage, replyAll bool) feishu.Message {
	var own string
	_ = s.pool.QueryRow(ctx, `SELECT coalesce(identity_label,'') FROM external_connections WHERE upstream_connection_id=$1`, upstreamID).Scan(&own)
	own = strings.ToLower(own)
	sender := original.HeadFrom.MailAddress
	if replyTo := firstAddress(original.ReplyTo); replyTo != "" {
		sender = replyTo
	}
	seen := map[string]bool{own: true}
	add := func(list *[]string, address string) {
		address = strings.TrimSpace(address)
		if address != "" && !seen[strings.ToLower(address)] {
			seen[strings.ToLower(address)] = true
			*list = append(*list, address)
		}
	}
	reply := feishu.Message{Subject: original.Subject, InReplyTo: original.SMTPMessageID}
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(reply.Subject)), "re:") {
		reply.Subject = "Re: " + reply.Subject
	}
	reply.References = append(strings.Fields(original.References), original.SMTPMessageID)
	add(&reply.To, sender)
	if replyAll {
		for _, address := range original.To {
			add(&reply.To, address.MailAddress)
		}
		for _, address := range original.Cc {
			add(&reply.Cc, address.MailAddress)
		}
	}
	// Replying to one's own sent mail goes back to its recipients.
	if len(reply.To) == 0 {
		for _, address := range original.To {
			add(&reply.To, address.MailAddress)
		}
	}
	return reply
}

// cliMail is a message in the CLI's mail shape; a summary leaves out
// recipients, bodies and attachments.
func cliMail(message feishu.MailMessage, summary bool) map[string]any {
	mail := withoutEmpty(map[string]any{"messageId": message.MessageID, "threadId": message.ThreadID, "subject": message.Subject})
	if message.HeadFrom.MailAddress != "" {
		mail["from"] = cliAddress(message.HeadFrom)
	}
	if millis, err := strconv.ParseInt(message.InternalDate, 10, 64); err == nil && millis > 0 {
		mail["receivedAt"] = time.UnixMilli(millis).UTC().Format(time.RFC3339)
	}
	mail["unread"] = slices.Contains(message.LabelIDs, feishu.LabelUnread)
	if preview := decodedText(message.BodyPreview); preview != "" {
		mail["snippet"] = preview
	}
	if summary {
		return mail
	}
	for name, list := range map[string][]feishu.MailAddress{"to": message.To, "cc": message.Cc, "bcc": message.Bcc} {
		addresses := make([]any, 0, len(list))
		for _, address := range list {
			addresses = append(addresses, cliAddress(address))
		}
		mail[name] = addresses
	}
	mail["bodyText"] = decodedText(message.BodyPlainText)
	if html := decodedText(message.BodyHTML); html != "" {
		mail["bodyHtml"] = html
	}
	attachments := make([]any, 0, len(message.Attachments))
	for _, attachment := range message.Attachments {
		attachments = append(attachments, withoutEmpty(map[string]any{
			"attachmentId": attachment.ID, "name": attachment.Filename, "isInline": attachment.IsInline, "type": "file",
		}))
	}
	mail["attachments"] = attachments
	return mail
}

func cliAddress(address feishu.MailAddress) map[string]any {
	return withoutEmpty(map[string]any{"email": address.MailAddress, "name": address.Name})
}

func cliAddresses(addresses []string) []any {
	list := make([]any, 0, len(addresses))
	for _, address := range addresses {
		list = append(list, map[string]any{"email": address})
	}
	return list
}

func decodedText(value string) string {
	if value == "" {
		return ""
	}
	decoded, err := feishu.DecodeBase64URL(value)
	if err != nil {
		return ""
	}
	return strings.ReplaceAll(string(decoded), "\r\n", "\n")
}

func firstAddress(header string) string {
	if start, end := strings.LastIndex(header, "<"), strings.LastIndex(header, ">"); start >= 0 && end > start {
		return strings.TrimSpace(header[start+1 : end])
	}
	return strings.TrimSpace(header)
}

func withoutEmpty(values map[string]any) map[string]any {
	for key, value := range values {
		if text, ok := value.(string); ok && text == "" {
			delete(values, key)
		}
	}
	return values
}

func stringList(value any) []string {
	items, _ := value.([]any)
	list := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
			list = append(list, strings.TrimSpace(text))
		}
	}
	return list
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func (c feishuMailCall) str(name string) string {
	value, _ := c.args[name].(string)
	return value
}

func (c feishuMailCall) integer(name string, fallback int) int {
	switch value := c.args[name].(type) {
	case float64:
		return int(value)
	case int:
		return value
	case json.Number:
		parsed, err := value.Int64()
		if err == nil {
			return int(parsed)
		}
	}
	return fallback
}

// SaveFeishuDraft saves raw, a whole message, as a new draft, or replaces
// draftID with it, and returns the draft's ID. It never sends.
func (s *Service) SaveFeishuDraft(ctx context.Context, upstreamID, draftID string, raw []byte) (string, error) {
	mailbox, err := s.feishuMailbox(ctx, upstreamID)
	if err != nil {
		return "", err
	}
	if draftID == "" {
		return mailbox.CreateDraft(ctx, raw)
	}
	return draftID, mailbox.UpdateDraft(ctx, draftID, raw)
}

// SendFeishuDraft sends a saved draft now and returns the sent message's ID.
func (s *Service) SendFeishuDraft(ctx context.Context, upstreamID, draftID string) (string, error) {
	mailbox, err := s.feishuMailbox(ctx, upstreamID)
	if err != nil {
		return "", err
	}
	messageID, _, err := mailbox.SendDraft(ctx, draftID)
	return messageID, err
}

// SaveDraftRaw saves a canvas draft for an Agent's canvas-draft command.
func (t FeishuMailTools) SaveDraftRaw(ctx context.Context, upstreamID, draftID string, raw []byte) (string, error) {
	saved, err := t.service.SaveFeishuDraft(ctx, upstreamID, draftID, raw)
	if feishu.IsAuthFailure(err) {
		// lark-cli refused before Feishu acted: nothing was saved.
		return "", errors.Join(ErrNotActive, err)
	}
	return saved, err
}
