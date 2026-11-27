package composio

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
)

// Each chunk is a multiple of Gmail's 256 KiB granularity and stays below
// the proxy's request-body limit even after base64 encoding.
const gmailDraftChunkBytes = 1 << 20

func (c *Client) uploadGmailDraft(ctx context.Context, accountID, endpoint, method, raw string) (json.RawMessage, error) {
	message, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, errors.New("Gmail draft contains invalid encoded MIME")
	}
	response, err := c.gmailUploadProxy(ctx, proxyRequest{
		ConnectedAccountID: accountID, Endpoint: "/upload" + endpoint, Method: method,
		Parameters: []proxyParameter{
			{Name: "uploadType", Value: "resumable", Type: "query"},
			{Name: "X-Upload-Content-Type", Value: "message/rfc822", Type: "header"},
			{Name: "X-Upload-Content-Length", Value: strconv.Itoa(len(message)), Type: "header"},
		},
	})
	if err != nil {
		return nil, err
	}
	if response.Status != http.StatusOK {
		return nil, &remoteError{operation: "start Gmail draft upload", status: response.Status, source: ErrorSourceProvider}
	}
	session := headerValue(response.Headers, "location")
	parsed, err := url.Parse(session)
	if err != nil || parsed.Scheme != "https" || (parsed.Host != "www.googleapis.com" && parsed.Host != "gmail.googleapis.com") ||
		parsed.User != nil || parsed.Fragment != "" || parsed.Path != "/upload"+endpoint || parsed.Query().Get("upload_id") == "" {
		return nil, errors.New("Gmail returned an invalid draft upload location")
	}
	for start := 0; start < len(message); start += gmailDraftChunkBytes {
		end := min(start+gmailDraftChunkBytes, len(message))
		response, err = c.gmailUploadProxy(ctx, proxyRequest{
			ConnectedAccountID: accountID, Endpoint: session, Method: http.MethodPut,
			BinaryBody: &proxyBinaryBody{Base64: base64.StdEncoding.EncodeToString(message[start:end]), ContentType: "message/rfc822"},
			Parameters: []proxyParameter{{Name: "Content-Range", Value: fmt.Sprintf("bytes %d-%d/%d", start, end-1, len(message)), Type: "header"}},
		})
		if err != nil {
			return nil, err
		}
		if end == len(message) {
			if response.Status != http.StatusOK && response.Status != http.StatusCreated {
				return nil, &remoteError{operation: "finish Gmail draft upload", status: response.Status, source: ErrorSourceProvider}
			}
			return response.Data, nil
		}
		if response.Status != http.StatusPermanentRedirect {
			return nil, &remoteError{operation: "upload Gmail draft chunk", status: response.Status, source: ErrorSourceProvider}
		}
		if headerValue(response.Headers, "range") != fmt.Sprintf("bytes=0-%d", end-1) {
			return nil, errors.New("Gmail did not acknowledge the complete draft chunk")
		}
	}
	return nil, errors.New("Gmail draft upload was empty")
}

func (c *Client) gmailUploadProxy(ctx context.Context, request proxyRequest) (proxyResponse, error) {
	binding, err := c.authorizeConnection(ctx, request.ConnectedAccountID)
	if err != nil {
		return proxyResponse{}, err
	}
	request.UserID = binding.UserID
	var response proxyResponse
	// A failed final chunk may already have saved the draft. Never replay it.
	err = c.requestJSONOnce(ctx, http.MethodPost, "/api/v3.1/tools/execute/proxy", request, &response, "upload Gmail draft")
	return response, err
}
