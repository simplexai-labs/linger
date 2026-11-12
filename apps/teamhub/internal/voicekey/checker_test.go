package voicekey

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPCheckerAsksEachProviderWithTheKey(t *testing.T) {
	for _, tc := range []struct {
		provider Provider
		path     string
	}{{Soniox, "/v1/files"}, {XAI, "/v1/api-key"}} {
		t.Run(string(tc.provider), func(t *testing.T) {
			for _, status := range []struct {
				code int
				want error
			}{
				{http.StatusOK, nil},
				{http.StatusBadRequest, ErrRejected},
				{http.StatusUnauthorized, ErrRejected},
				{http.StatusForbidden, ErrRejected},
				{http.StatusTooManyRequests, ErrProviderUnavailable},
				{http.StatusInternalServerError, ErrProviderUnavailable},
				{http.StatusBadGateway, ErrProviderUnavailable},
			} {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Method != http.MethodGet || r.URL.Path != tc.path || r.Header.Get("Authorization") != "Bearer provider-secret" {
						t.Errorf("request %s %s auth=%q", r.Method, r.URL.Path, r.Header.Get("Authorization"))
					}
					w.WriteHeader(status.code)
				}))
				checker := &HTTPChecker{SonioxBaseURL: server.URL, XAIBaseURL: server.URL, Client: server.Client()}
				if err := checker.Check(t.Context(), tc.provider, "provider-secret"); !errors.Is(err, status.want) || (status.want == nil && err != nil) {
					t.Fatalf("HTTP %d: Check = %v, want %v", status.code, err, status.want)
				}
				server.Close()
			}
		})
	}
}

func TestHTTPCheckerUnreachableProvider(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	server.Close()
	checker := &HTTPChecker{SonioxBaseURL: server.URL, XAIBaseURL: server.URL, Client: http.DefaultClient}
	err := checker.Check(t.Context(), Soniox, "provider-secret")
	if !errors.Is(err, ErrProviderUnavailable) || err.Error() != ErrProviderUnavailable.Error() {
		t.Fatalf("Check = %v, want only ErrProviderUnavailable", err)
	}
}

func TestNewHTTPCheckerUsesTheProviderAPIs(t *testing.T) {
	checker := NewHTTPChecker()
	if checker.SonioxBaseURL != "https://api.soniox.com" || checker.XAIBaseURL != "https://api.x.ai" || checker.Client.Timeout == 0 {
		t.Fatalf("checker = %+v", checker)
	}
}

// xAI describes a blocked or disabled key with 200; only its flags are read.
func TestHTTPCheckerRejectsBlockedXAIKeys(t *testing.T) {
	for _, tc := range []struct {
		body string
		want error
	}{
		{`{"api_key_blocked":true,"name":"k"}`, ErrRejected},
		{`{"api_key_disabled":true}`, ErrRejected},
		{`{"team_blocked":true}`, ErrRejected},
		{`{"api_key_blocked":false,"api_key_disabled":false,"team_blocked":false}`, nil},
		{`{"name":"k"}`, nil},
		{`not json`, nil},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(tc.body))
		}))
		checker := &HTTPChecker{XAIBaseURL: server.URL, Client: server.Client()}
		err := checker.Check(t.Context(), XAI, "provider-secret")
		server.Close()
		if !errors.Is(err, tc.want) || (tc.want == nil && err != nil) {
			t.Fatalf("%s: Check = %v, want %v", tc.body, err, tc.want)
		}
	}
}
