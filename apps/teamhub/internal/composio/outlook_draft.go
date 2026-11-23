package composio

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// ErrOutlookDraftNotEditable means the message is no longer an unsent draft.
var ErrOutlookDraftNotEditable = errors.New("Outlook message is no longer a draft")

// OutlookDraftMessage is the complete content of a canvas-backed Outlook draft.
type OutlookDraftMessage struct {
	To, Cc        []string
	Subject, HTML string
	Attachments   []OutlookDraftAttachment
}

// OutlookDraftAttachment carries a file or a CID-referenced inline image.
type OutlookDraftAttachment struct {
	Name, ContentType, ContentID string
	Bytes                        []byte
}

type outlookSavedDraft struct {
	ID             string `json:"id"`
	IsDraft        bool   `json:"isDraft"`
	ConversationID string `json:"conversationId"`
}

// SaveOutlookDraft replaces the reviewed content and attachments without sending.
// Writes are attempted once; a partial update is never reported as a saved draft.
func (c *Client) SaveOutlookDraft(ctx context.Context, accountID, draftID string, message OutlookDraftMessage) (GmailDraft, error) {
	endpoint, method := "/v1.0/me/messages", http.MethodPost
	if draftID != "" {
		endpoint += "/" + url.PathEscape(draftID)
		if err := c.outlookEditableDraft(ctx, accountID, endpoint); err != nil {
			return GmailDraft{}, err
		}
		method = http.MethodPatch
	}
	recipients := func(addresses []string) []any {
		result := make([]any, 0, len(addresses))
		for _, address := range addresses {
			result = append(result, map[string]any{"emailAddress": map[string]string{"address": address}})
		}
		return result
	}
	body := map[string]any{"subject": message.Subject, "body": map[string]string{"contentType": "HTML", "content": message.HTML}, "toRecipients": recipients(message.To), "ccRecipients": recipients(message.Cc), "bccRecipients": []any{}}
	response, err := c.outlookDraftRequest(ctx, accountID, endpoint, method, body)
	if err != nil {
		return GmailDraft{}, err
	}
	var saved outlookSavedDraft
	if json.Unmarshal(response.Data, &saved) != nil || saved.ID == "" || !saved.IsDraft || draftID != "" && saved.ID != draftID {
		return GmailDraft{}, errors.New("Outlook draft response was invalid")
	}
	endpoint = "/v1.0/me/messages/" + url.PathEscape(saved.ID)
	if draftID != "" {
		attachments, err := c.outlookDraftAttachments(ctx, accountID, endpoint)
		if err != nil {
			return GmailDraft{}, err
		}
		for _, id := range attachments {
			if _, err := c.outlookDraftRequest(ctx, accountID, endpoint+"/attachments/"+url.PathEscape(id), http.MethodDelete, nil); err != nil {
				return GmailDraft{}, err
			}
		}
	}
	for _, attachment := range message.Attachments {
		if err := c.uploadOutlookDraftAttachment(ctx, accountID, endpoint, attachment); err != nil {
			if draftID == "" {
				// The new draft is never reported, so each retry would leave
				// another partial draft in Drafts: remove it, best effort.
				_, _ = c.outlookDraftRequest(context.WithoutCancel(ctx), accountID, endpoint, http.MethodDelete, nil)
			}
			return GmailDraft{}, err
		}
	}
	return GmailDraft{DraftID: saved.ID, MessageID: saved.ID, ThreadID: saved.ConversationID}, nil
}

// SendOutlookDraft accepts Graph's empty 202 response without inventing a sent ID.
// A missing response is unknown and this operation never retries a send.
func (c *Client) SendOutlookDraft(ctx context.Context, accountID, draftID string) (string, error) {
	endpoint := "/v1.0/me/messages/" + url.PathEscape(draftID)
	if err := c.outlookEditableDraft(ctx, accountID, endpoint); err != nil {
		return "", err
	}
	response, err := c.outlookDraftRequest(ctx, accountID, endpoint+"/send", http.MethodPost, nil)
	if err != nil {
		return "", err
	}
	if response.Status != http.StatusAccepted {
		return "", errors.New("Outlook did not acknowledge the send")
	}
	return "", nil
}

func (c *Client) outlookEditableDraft(ctx context.Context, accountID, endpoint string) error {
	response, err := c.outlookDraftRequest(ctx, accountID, endpoint, http.MethodGet, nil)
	if err != nil {
		return err
	}
	var draft outlookSavedDraft
	if json.Unmarshal(response.Data, &draft) != nil || draft.ID == "" {
		return errors.New("Outlook draft response was invalid")
	}
	if !draft.IsDraft {
		return ErrOutlookDraftNotEditable
	}
	return nil
}

func (c *Client) outlookDraftRequest(ctx context.Context, accountID, endpoint, method string, body any) (proxyResponse, error) {
	binding, err := c.authorizeConnection(ctx, accountID)
	if err != nil {
		return proxyResponse{}, err
	}
	if binding.ToolkitSlug != "outlook" {
		return proxyResponse{}, ErrConnectionScope
	}
	request, err := graphPollRequest(accountID, endpoint)
	if err != nil {
		return proxyResponse{}, err
	}
	request.UserID, request.Method = binding.UserID, method
	if body != nil {
		request.Body, err = json.Marshal(body)
		if err != nil {
			return proxyResponse{}, err
		}
		request.Parameters = append(request.Parameters, proxyParameter{Name: "Content-Type", Value: "application/json", Type: "header"})
	}
	var response proxyResponse
	if err = c.requestJSONOnce(ctx, http.MethodPost, "/api/v3.1/tools/execute/proxy", request, &response, "Outlook draft"); err != nil {
		return response, err
	}
	if response.Status < 200 || response.Status >= 300 {
		return response, &remoteError{operation: "Outlook draft", status: response.Status}
	}
	// Some proxy responses wrap the provider's JSON in a string.
	var encoded string
	if len(response.Data) > 0 && response.Data[0] == '"' && json.Unmarshal(response.Data, &encoded) == nil {
		response.Data = json.RawMessage(encoded)
	}
	return response, nil
}

func (c *Client) outlookDraftAttachments(ctx context.Context, accountID, endpoint string) ([]string, error) {
	ids := []string{}
	next := endpoint + "/attachments?$select=id&$top=100"
	seen := map[string]bool{}
	for next != "" {
		parsed, err := url.Parse(next)
		if err != nil || parsed.EscapedPath() != endpoint+"/attachments" || seen[next] {
			return nil, errors.New("invalid Outlook attachment continuation")
		}
		seen[next] = true
		response, err := c.outlookDraftRequest(ctx, accountID, next, http.MethodGet, nil)
		if err != nil {
			return nil, err
		}
		var page struct {
			Value []struct {
				ID string `json:"id"`
			} `json:"value"`
			Next string `json:"@odata.nextLink"`
		}
		if json.Unmarshal(response.Data, &page) != nil {
			return nil, errors.New("invalid Outlook attachments")
		}
		for _, item := range page.Value {
			if item.ID == "" {
				return nil, errors.New("invalid Outlook attachment ID")
			}
			ids = append(ids, item.ID)
		}
		next = page.Next
	}
	return ids, nil
}

func (c *Client) uploadOutlookDraftAttachment(ctx context.Context, accountID, endpoint string, attachment OutlookDraftAttachment) error {
	if len(attachment.Bytes) < 3<<20 {
		response, err := c.outlookDraftRequest(ctx, accountID, endpoint+"/attachments", http.MethodPost, map[string]any{
			"@odata.type": "#microsoft.graph.fileAttachment", "name": attachment.Name, "contentType": attachment.ContentType, "contentId": attachment.ContentID, "isInline": attachment.ContentID != "", "contentBytes": base64.StdEncoding.EncodeToString(attachment.Bytes),
		})
		if err != nil {
			return err
		}
		var saved struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(response.Data, &saved) != nil || saved.ID == "" {
			return errors.New("Outlook did not acknowledge the attachment")
		}
		return nil
	}
	response, err := c.outlookDraftRequest(ctx, accountID, endpoint+"/attachments/createUploadSession", http.MethodPost, map[string]any{"AttachmentItem": map[string]any{
		"attachmentType": "file", "name": attachment.Name, "size": len(attachment.Bytes), "contentType": attachment.ContentType, "contentId": attachment.ContentID, "isInline": attachment.ContentID != "",
	}})
	if err != nil {
		return err
	}
	var session struct {
		URL string `json:"uploadUrl"`
	}
	if json.Unmarshal(response.Data, &session) != nil {
		return errors.New("invalid Outlook upload session")
	}
	location, err := url.Parse(session.URL)
	if err != nil || location.Scheme != "https" || location.User != nil || location.Fragment != "" || (location.Host != "outlook.office.com" && location.Host != "outlook.office365.com") {
		return errors.New("invalid Outlook upload location")
	}
	// The opaque upload URL carries its own authorization. No Composio key,
	// cookies, redirects, or retries may accompany these byte transfers.
	client := &http.Client{Transport: c.httpClient.Transport, Timeout: c.httpClient.Timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for start := 0; start < len(attachment.Bytes); {
		end := min(start+2<<20, len(attachment.Bytes))
		request, err := http.NewRequestWithContext(ctx, http.MethodPut, session.URL, bytes.NewReader(attachment.Bytes[start:end]))
		if err != nil {
			return errors.New("invalid Outlook upload request")
		}
		request.Header.Set("Content-Type", "application/octet-stream")
		request.Header.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end-1, len(attachment.Bytes)))
		result, err := client.Do(request)
		if err != nil {
			return errors.New("Outlook attachment upload was interrupted")
		}
		data, readErr := io.ReadAll(io.LimitReader(result.Body, 1<<20))
		_ = result.Body.Close()
		if readErr != nil {
			return errors.New("Outlook attachment upload response was interrupted")
		}
		if end == len(attachment.Bytes) {
			if result.StatusCode != http.StatusCreated {
				return errors.New("Outlook did not acknowledge the complete attachment")
			}
			return nil
		}
		var progress struct {
			Ranges []string `json:"nextExpectedRanges"`
		}
		if result.StatusCode != http.StatusOK || json.Unmarshal(data, &progress) != nil || len(progress.Ranges) != 1 || strings.TrimSuffix(progress.Ranges[0], "-") != strconv.Itoa(end) {
			return errors.New("Outlook did not acknowledge the attachment chunk")
		}
		start = end
	}
	return errors.New("Outlook attachment upload was empty")
}
