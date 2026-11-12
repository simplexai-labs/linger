package voicekey

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// The provider APIs a saved key is checked against. Tests point an
// HTTPChecker at fakes instead.
const (
	DefaultSonioxBaseURL = "https://api.soniox.com"
	DefaultXAIBaseURL    = "https://api.x.ai"
	checkTimeout         = 10 * time.Second
)

// HTTPChecker checks a key with one authenticated read: Soniox lists one
// uploaded file, xAI describes the key itself. Neither costs usage.
type HTTPChecker struct {
	SonioxBaseURL string
	XAIBaseURL    string
	Client        *http.Client
}

// NewHTTPChecker checks keys against the real provider APIs.
func NewHTTPChecker() *HTTPChecker {
	return &HTTPChecker{
		SonioxBaseURL: DefaultSonioxBaseURL, XAIBaseURL: DefaultXAIBaseURL,
		// A key never follows a redirect to another host.
		Client: &http.Client{Timeout: checkTimeout, CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}},
	}
}

// Check returns nil when provider accepts key, ErrRejected when it refuses it
// and ErrProviderUnavailable otherwise. Errors never carry the key or the
// provider's response.
func (c *HTTPChecker) Check(ctx context.Context, provider Provider, key string) error {
	var endpoint string
	switch provider {
	case Soniox:
		endpoint = strings.TrimRight(c.SonioxBaseURL, "/") + "/v1/files?limit=1"
	case XAI:
		endpoint = strings.TrimRight(c.XAIBaseURL, "/") + "/v1/api-key"
	default:
		return ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, checkTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return ErrProviderUnavailable
	}
	request.Header.Set("Authorization", "Bearer "+key)
	request.Header.Set("Accept", "application/json")
	response, err := c.Client.Do(request)
	if err != nil {
		return ErrProviderUnavailable
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	switch {
	case response.StatusCode >= 200 && response.StatusCode < 300:
		if provider == XAI && xaiKeyBlocked(body) {
			return ErrRejected
		}
		return nil
	// The request carries nothing but the key, so xAI's 400 for a malformed
	// key is a refusal like 401 and 403.
	case response.StatusCode == http.StatusBadRequest || response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
		return ErrRejected
	default:
		return ErrProviderUnavailable
	}
}

// xaiKeyBlocked reads only the flags xAI sets on a key it would refuse: a key
// can be described with 200 and still be blocked or disabled. An unreadable
// body or absent flags accept the key; the body is never logged or returned.
func xaiKeyBlocked(body []byte) bool {
	var flags struct {
		APIKeyBlocked  bool `json:"api_key_blocked"`
		APIKeyDisabled bool `json:"api_key_disabled"`
		TeamBlocked    bool `json:"team_blocked"`
	}
	if json.Unmarshal(body, &flags) != nil {
		return false
	}
	return flags.APIKeyBlocked || flags.APIKeyDisabled || flags.TeamBlocked
}
