package composio

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"
)

func outlookDraftClient(t *testing.T, handler func(*http.Request) (*http.Response, error)) *Client {
	t.Helper()
	client, err := newTestClient(Config{APIKey: "test-key", HTTPClient: &http.Client{Transport: gmailDraftTransport(handler)}})
	if err != nil {
		t.Fatal(err)
	}
	client.SetConnectionAuthority(func(context.Context, string) (ConnectionBinding, error) {
		return ConnectionBinding{UserID: "owner", ToolkitSlug: "outlook"}, nil
	})
	return client
}

func outlookProxyResponse(status int, data any) *http.Response {
	body, _ := json.Marshal(map[string]any{"status": status, "data": data})
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(string(body))), Header: http.Header{}}
}

func TestOutlookCanvasDraftReplacesRecipientsAndAttachments(t *testing.T) {
	calls := []string{}
	client := outlookDraftClient(t, func(r *http.Request) (*http.Response, error) {
		var request proxyRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		if request.ConnectedAccountID != "ca_outlook" || request.UserID != "owner" {
			t.Fatalf("binding=%+v", request)
		}
		calls = append(calls, request.Method+" "+request.Endpoint)
		switch {
		case request.Method == http.MethodPatch:
			var body map[string]any
			_ = json.Unmarshal(request.Body, &body)
			if body["subject"] != "Updated" || len(body["ccRecipients"].([]any)) != 0 || len(body["bccRecipients"].([]any)) != 0 {
				t.Fatalf("body=%v", body)
			}
			if body["body"].(map[string]any)["content"] != `<p>Hello</p><img src="cid:logo">` {
				t.Fatalf("body=%v", body)
			}
			return outlookProxyResponse(http.StatusOK, map[string]any{"id": "draft1", "isDraft": true}), nil
		case request.Method == http.MethodGet && strings.HasSuffix(request.Endpoint, "/attachments"):
			return outlookProxyResponse(http.StatusOK, map[string]any{"value": []any{map[string]string{"id": "old-file"}, map[string]string{"id": "old-image"}}}), nil
		case request.Method == http.MethodDelete:
			return outlookProxyResponse(http.StatusNoContent, nil), nil
		case request.Method == http.MethodPost:
			var body map[string]any
			_ = json.Unmarshal(request.Body, &body)
			if body["contentId"] == "logo" && (body["isInline"] != true || body["contentBytes"] != "aW1hZ2U=") {
				t.Fatalf("inline=%v", body)
			}
			return outlookProxyResponse(http.StatusCreated, map[string]string{"id": "new-attachment"}), nil
		default:
			return outlookProxyResponse(http.StatusOK, map[string]any{"id": "draft1", "isDraft": true}), nil
		}
	})
	saved, err := client.SaveOutlookDraft(t.Context(), "ca_outlook", "draft1", OutlookDraftMessage{To: []string{"a@example.test"}, Subject: "Updated", HTML: `<p>Hello</p><img src="cid:logo">`, Attachments: []OutlookDraftAttachment{{Name: "logo.png", ContentType: "image/png", ContentID: "logo", Bytes: []byte("image")}, {Name: "file.txt", ContentType: "text/plain", Bytes: []byte("file")}}})
	if err != nil || saved.DraftID != "draft1" {
		t.Fatalf("saved=%+v err=%v", saved, err)
	}
	want := []string{"GET /v1.0/me/messages/draft1", "PATCH /v1.0/me/messages/draft1", "GET /v1.0/me/messages/draft1/attachments", "DELETE /v1.0/me/messages/draft1/attachments/old-file", "DELETE /v1.0/me/messages/draft1/attachments/old-image", "POST /v1.0/me/messages/draft1/attachments", "POST /v1.0/me/messages/draft1/attachments"}
	if strings.Join(calls, "\n") != strings.Join(want, "\n") {
		t.Fatalf("calls=%v", calls)
	}
}

func TestOutlookCanvasRemovesANewDraftWhoseAttachmentFailed(t *testing.T) {
	for _, existing := range []string{"", "draft1"} {
		calls := []string{}
		client := outlookDraftClient(t, func(r *http.Request) (*http.Response, error) {
			var request proxyRequest
			_ = json.NewDecoder(r.Body).Decode(&request)
			calls = append(calls, request.Method+" "+request.Endpoint)
			switch {
			case strings.HasSuffix(request.Endpoint, "/attachments") && request.Method == http.MethodPost:
				return outlookProxyResponse(http.StatusServiceUnavailable, map[string]any{"error": map[string]string{"code": "ServiceUnavailable"}}), nil
			case strings.HasSuffix(request.Endpoint, "/attachments"):
				return outlookProxyResponse(http.StatusOK, map[string]any{"value": []any{}}), nil
			case request.Method == http.MethodDelete:
				return outlookProxyResponse(http.StatusNoContent, nil), nil
			default:
				return outlookProxyResponse(http.StatusOK, map[string]any{"id": "draft1", "isDraft": true}), nil
			}
		})
		_, err := client.SaveOutlookDraft(t.Context(), "ca", existing, OutlookDraftMessage{To: []string{"a@example.test"}, Attachments: []OutlookDraftAttachment{{Name: "file.txt", ContentType: "text/plain", Bytes: []byte("file")}}})
		deleted := slices.Contains(calls, "DELETE /v1.0/me/messages/draft1")
		// Only a draft this save created is removed; an existing one stays the
		// canvas's draft.
		if err == nil || deleted != (existing == "") {
			t.Fatalf("existing=%q err=%v calls=%v", existing, err, calls)
		}
	}
}

func TestOutlookCanvasDoesNotOverwriteSentMailOrRetryUnknownSends(t *testing.T) {
	for _, mode := range []string{"sent", "accepted", "lost"} {
		t.Run(mode, func(t *testing.T) {
			sends, writes := 0, 0
			client := outlookDraftClient(t, func(r *http.Request) (*http.Response, error) {
				var request proxyRequest
				_ = json.NewDecoder(r.Body).Decode(&request)
				if request.Method == http.MethodGet {
					return outlookProxyResponse(http.StatusOK, map[string]any{"id": "draft1", "isDraft": mode != "sent"}), nil
				}
				writes++
				if strings.HasSuffix(request.Endpoint, "/send") {
					sends++
					if mode == "lost" {
						return nil, errors.New("connection lost")
					}
					return outlookProxyResponse(http.StatusAccepted, nil), nil
				}
				t.Fatal("unexpected write")
				return nil, errors.New("unexpected")
			})
			if mode == "sent" {
				_, err := client.SaveOutlookDraft(t.Context(), "ca", "draft1", OutlookDraftMessage{})
				if !errors.Is(err, ErrOutlookDraftNotEditable) || writes != 0 {
					t.Fatalf("err=%v writes=%d", err, writes)
				}
				return
			}
			id, err := client.SendOutlookDraft(t.Context(), "ca", "draft1")
			if sends != 1 || id != "" || (mode == "accepted" && err != nil) || (mode == "lost" && err == nil) {
				t.Fatalf("id=%s err=%v sends=%d", id, err, sends)
			}
		})
	}
}

func TestOutlookCanvasLargeAttachmentChecksAcknowledgedRanges(t *testing.T) {
	for _, mode := range []string{"complete", "bad-range", "lost", "foreign-host"} {
		t.Run(mode, func(t *testing.T) {
			puts := 0
			client := outlookDraftClient(t, func(r *http.Request) (*http.Response, error) {
				if r.Method == http.MethodPut {
					puts++
					if r.Header.Get("Authorization") != "" || r.Header.Get("x-api-key") != "" {
						t.Fatal("credential on signed upload")
					}
					if mode == "lost" {
						return nil, errors.New("lost")
					}
					if puts == 1 {
						ranges := `{"nextExpectedRanges":["2097152"]}`
						if mode == "bad-range" {
							ranges = `{"nextExpectedRanges":["0"]}`
						}
						return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(ranges))}, nil
					}
					if r.Header.Get("Content-Range") != "bytes 2097152-3145727/3145728" {
						t.Fatalf("range=%s", r.Header.Get("Content-Range"))
					}
					return &http.Response{StatusCode: http.StatusCreated, Body: io.NopCloser(strings.NewReader(""))}, nil
				}
				var request proxyRequest
				_ = json.NewDecoder(r.Body).Decode(&request)
				if strings.HasSuffix(request.Endpoint, "createUploadSession") {
					host := "outlook.office.com"
					if mode == "foreign-host" {
						host = "example.com"
					}
					return outlookProxyResponse(http.StatusCreated, map[string]string{"uploadUrl": "https://" + host + "/upload?token=opaque"}), nil
				}
				return outlookProxyResponse(http.StatusCreated, map[string]any{"id": "draft1", "isDraft": true}), nil
			})
			_, err := client.SaveOutlookDraft(t.Context(), "ca", "", OutlookDraftMessage{Subject: "Large", HTML: "Hi", Attachments: []OutlookDraftAttachment{{Name: "file.pdf", Bytes: make([]byte, 3<<20)}}})
			if mode == "complete" {
				if err != nil || puts != 2 {
					t.Fatalf("err=%v puts=%d", err, puts)
				}
			} else if err == nil || puts > 1 {
				t.Fatalf("err=%v puts=%d", err, puts)
			}
		})
	}
}
