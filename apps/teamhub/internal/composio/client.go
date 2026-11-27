// Package composio adapts Managed Auth and authenticated provider proxy requests.
package composio

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

const (
	defaultBaseURL          = "https://backend.composio.dev"
	defaultRetryLimit       = 2
	defaultFetchConcurrency = 4
	defaultMaxThreadBytes   = 1 << 20
	defaultMaxBodyBytes     = 256 << 10
	defaultMaxBatchBytes    = 10 << 20
	defaultMaxRetryAfter    = 10 * time.Second
)

type Config struct {
	EnvironmentKey   string
	BaseURL          string
	APIKey           string
	CallbackURL      string
	HTTPClient       *http.Client
	RetryLimit       int
	FetchConcurrency int
	MaxThreadBytes   int
	MaxBodyBytes     int
	MaxBatchBytes    int
	MaxRetryAfter    time.Duration
}

type Client struct {
	environmentKey      string
	connectionAuthority ConnectionAuthority
	baseURL             string
	// apiKey can be set after start, when a deployment saves its key in the product.
	apiKey           atomic.Pointer[string]
	callbackURL      string
	httpClient       *http.Client
	retryLimit       int
	fetchConcurrency int
	maxThreadBytes   int
	maxBodyBytes     int
	maxBatchBytes    int
	maxRetryAfter    time.Duration
}

type ConnectionStatus string

const (
	ConnectionPending ConnectionStatus = "pending"
	ConnectionActive  ConnectionStatus = "active"
	ConnectionExpired ConnectionStatus = "expired"
	ConnectionFailed  ConnectionStatus = "failed"
)

// ConnectionStatusReason classifies why Composio reported a connection status.
type ConnectionStatusReason string

const (
	// ConnectionStatusReasonActive means Composio reported an active connection.
	ConnectionStatusReasonActive ConnectionStatusReason = "active"
	// ConnectionStatusReasonPending means Composio reported an in-progress authorization.
	ConnectionStatusReasonPending ConnectionStatusReason = "pending"
	// ConnectionStatusReasonExpired means Composio reported an expired connection.
	ConnectionStatusReasonExpired ConnectionStatusReason = "expired"
	// ConnectionStatusReasonDisabled means Composio marked the connected account disabled.
	ConnectionStatusReasonDisabled ConnectionStatusReason = "disabled"
	// ConnectionStatusReasonToolkitMismatch means the connected account's toolkit did not match the expected toolkit.
	ConnectionStatusReasonToolkitMismatch ConnectionStatusReason = "toolkit_mismatch"
	// ConnectionStatusReasonFailed means Composio reported a failed connection.
	ConnectionStatusReasonFailed ConnectionStatusReason = "failed"
	// ConnectionStatusReasonRevoked means Composio reported a revoked connection.
	ConnectionStatusReasonRevoked ConnectionStatusReason = "revoked"
	// ConnectionStatusReasonInactive means Composio reported an inactive connection.
	ConnectionStatusReasonInactive ConnectionStatusReason = "inactive"
	// ConnectionStatusReasonUnknown means Composio reported an unrecognized status value.
	ConnectionStatusReasonUnknown ConnectionStatusReason = "unknown"
)

// ConnectionStatusReport pairs a normalized ConnectionStatus with its closed diagnostic reason.
type ConnectionStatusReport struct {
	Status ConnectionStatus
	Reason ConnectionStatusReason
}

// ErrorSource identifies whether a remote HTTP failure originated from Composio's
// own API or from an upstream provider behind Composio's proxy endpoint.
type ErrorSource string

const (
	// ErrorSourceComposio marks an HTTP error returned directly by Composio's API.
	ErrorSourceComposio ErrorSource = "composio"
	// ErrorSourceProvider marks an HTTP error returned by an upstream provider
	// inside Composio's proxy response envelope.
	ErrorSourceProvider ErrorSource = "provider"
)

type Link struct {
	AuthConfigID       string
	ConnectedAccountID string
	RedirectURL        string
	ExpiresAt          time.Time
}

// RateLimitError reports an HTTP 429 response from Composio or a proxied upstream provider.
type RateLimitError struct {
	Operation  string
	RetryAfter time.Duration
	Source     ErrorSource
}

func (e *RateLimitError) Error() string { return "Composio " + e.Operation + " was rate limited" }

type Tool struct {
	Slug            string         `json:"slug"`
	Name            string         `json:"name"`
	Description     string         `json:"description"`
	InputParameters map[string]any `json:"input_parameters"`
	Version         string         `json:"version"`
	IsDeprecated    bool           `json:"is_deprecated"`
	Toolkit         struct {
		Slug string `json:"slug"`
	} `json:"toolkit"`
}

type ToolExecution struct {
	Data       any  `json:"data"`
	Successful bool `json:"successful"`
	// Error is the provider's reason when Successful is false, kept raw
	// because its shape varies by tool.
	Error json.RawMessage `json:"error,omitempty"`
}

var ErrProviderCallBudgetExhausted = errors.New("Composio provider call budget was exhausted")

type providerAttemptBudgetKey struct{}
type providerAttemptReservationKey struct{}

type providerAttemptBudget struct {
	limit int64
	used  atomic.Int64
}

// WithProviderAttemptBudget makes the caller authoritative for HTTP attempts.
// Requests made with the returned context never retry internally.
func WithProviderAttemptBudget(ctx context.Context, limit int) (context.Context, func() int) {
	budget := &providerAttemptBudget{limit: int64(max(limit, 0))}
	return context.WithValue(ctx, providerAttemptBudgetKey{}, budget), func() int {
		return int(budget.used.Load())
	}
}

func providerAttemptBudgetFromContext(ctx context.Context) *providerAttemptBudget {
	budget, _ := ctx.Value(providerAttemptBudgetKey{}).(*providerAttemptBudget)
	return budget
}

// WithProviderAttemptReservation installs the durable authority that must
// reserve one provider attempt before the corresponding HTTP request is sent.
func WithProviderAttemptReservation(ctx context.Context, reserve func(context.Context) error) context.Context {
	return context.WithValue(ctx, providerAttemptReservationKey{}, reserve)
}

func providerAttemptReservationFromContext(ctx context.Context) func(context.Context) error {
	reserve, _ := ctx.Value(providerAttemptReservationKey{}).(func(context.Context) error)
	return reserve
}

// UsesProviderAttemptReservation lets workers distinguish the real Client from
// injected providers that need one logical-call reservation before invocation.
func (c *Client) UsesProviderAttemptReservation() bool { return c != nil }

type requestAuthorizationKey struct{}

// WithRequestAuthorization checks each HTTP admission without changing the
// caller's retry policy. Already admitted calls do not hold authorization locks.
func WithRequestAuthorization(ctx context.Context, authorize func(context.Context) error) context.Context {
	return context.WithValue(ctx, requestAuthorizationKey{}, authorize)
}

func reserveProviderAttempt(ctx context.Context) error {
	if authorize, ok := ctx.Value(requestAuthorizationKey{}).(func(context.Context) error); ok {
		if err := authorize(ctx); err != nil {
			return err
		}
	}
	if reserve := providerAttemptReservationFromContext(ctx); reserve != nil {
		return reserve(ctx)
	}
	budget := providerAttemptBudgetFromContext(ctx)
	if budget == nil {
		return nil
	}
	for {
		used := budget.used.Load()
		if used >= budget.limit {
			return ErrProviderCallBudgetExhausted
		}
		if budget.used.CompareAndSwap(used, used+1) {
			return nil
		}
	}
}

func providerAttemptAuthorityFromContext(ctx context.Context) bool {
	return providerAttemptReservationFromContext(ctx) != nil || providerAttemptBudgetFromContext(ctx) != nil
}

type proxyParameter struct {
	Name  string `json:"name"`
	Value string `json:"value"`
	Type  string `json:"type"`
}

type proxyRequest struct {
	ConnectedAccountID string           `json:"connected_account_id"`
	UserID             string           `json:"user_id,omitempty"`
	Endpoint           string           `json:"endpoint"`
	Method             string           `json:"method"`
	Parameters         []proxyParameter `json:"parameters,omitempty"`
	Body               json.RawMessage  `json:"body,omitempty"`
	BinaryBody         *proxyBinaryBody `json:"binary_body,omitempty"`
}

type proxyBinaryBody struct {
	Base64      string `json:"base64"`
	ContentType string `json:"content_type"`
}

type proxyResponse struct {
	Status  int               `json:"status"`
	Data    json.RawMessage   `json:"data"`
	Headers map[string]string `json:"headers"`
}

type remoteError struct {
	operation string
	status    int
	source    ErrorSource
}

type connectionScopeError struct {
	field string
}

func (e connectionScopeError) Error() string { return ErrConnectionScope.Error() }

func (e connectionScopeError) Unwrap() error { return ErrConnectionScope }

// ConnectionScopeMismatchField returns the closed field name that failed the
// upstream receipt check ("user_id", "toolkit_slug", or "auth_config_id"), or
// an empty string when err does not identify a specific field.
func ConnectionScopeMismatchField(err error) string {
	var mismatch connectionScopeError
	if errors.As(err, &mismatch) {
		return mismatch.field
	}
	return ""
}

func (e *remoteError) Error() string {
	return fmt.Sprintf("Composio %s failed with status %d", e.operation, e.status)
}

func New(cfg Config) (*Client, error) {
	baseURL := strings.TrimRight(cfg.BaseURL, "/")
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("Composio base URL must be an absolute URL without credentials, query, or fragment")
	}
	if !environmentKeyPattern.MatchString(cfg.EnvironmentKey) {
		return nil, errors.New("invalid Composio environment key")
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: 20 * time.Second}
	}
	if cfg.RetryLimit == 0 {
		cfg.RetryLimit = defaultRetryLimit
	}
	if cfg.FetchConcurrency <= 0 {
		cfg.FetchConcurrency = defaultFetchConcurrency
	}
	if cfg.MaxThreadBytes <= 0 {
		cfg.MaxThreadBytes = defaultMaxThreadBytes
	}
	if cfg.MaxBodyBytes <= 0 {
		cfg.MaxBodyBytes = defaultMaxBodyBytes
	}
	if cfg.MaxBatchBytes <= 0 {
		cfg.MaxBatchBytes = defaultMaxBatchBytes
	}
	if cfg.MaxRetryAfter <= 0 {
		cfg.MaxRetryAfter = defaultMaxRetryAfter
	}
	client := &Client{
		environmentKey: cfg.EnvironmentKey,
		baseURL:        baseURL,
		callbackURL:    strings.TrimSpace(cfg.CallbackURL),
		httpClient:     cfg.HTTPClient, retryLimit: cfg.RetryLimit, fetchConcurrency: cfg.FetchConcurrency,
		maxThreadBytes: cfg.MaxThreadBytes, maxBodyBytes: cfg.MaxBodyBytes, maxBatchBytes: cfg.MaxBatchBytes,
		maxRetryAfter: cfg.MaxRetryAfter,
	}
	client.SetAPIKey(cfg.APIKey)
	return client, nil
}

// ErrNotConfigured is returned by every request while the client has no API key.
var ErrNotConfigured = errors.New("Composio API key is not configured")

func (c *Client) SetAPIKey(key string) {
	key = strings.TrimSpace(key)
	c.apiKey.Store(&key)
}

func (c *Client) Configured() bool {
	return c.key() != ""
}

func (c *Client) key() string {
	if key := c.apiKey.Load(); key != nil {
		return *key
	}
	return ""
}

// WithAPIKey returns a copy that uses key, so a candidate key can be checked
// without changing the live client.
func (c *Client) WithAPIKey(key string) *Client {
	clone := &Client{
		environmentKey: c.environmentKey, connectionAuthority: c.connectionAuthority, baseURL: c.baseURL,
		callbackURL: c.callbackURL, httpClient: c.httpClient, retryLimit: c.retryLimit, fetchConcurrency: c.fetchConcurrency,
		maxThreadBytes: c.maxThreadBytes, maxBodyBytes: c.maxBodyBytes, maxBatchBytes: c.maxBatchBytes, maxRetryAfter: c.maxRetryAfter,
	}
	clone.SetAPIKey(key)
	return clone
}

// IsUnauthorized reports whether Composio rejected the API key. Proxied
// upstream provider 401/403 responses are excluded.
func IsUnauthorized(err error) bool {
	var remote *remoteError
	return errors.As(err, &remote) &&
		remote.source != ErrorSourceProvider &&
		(remote.status == http.StatusUnauthorized || remote.status == http.StatusForbidden)
}

const OAuthCallbackPath = "/oauth/composio-complete"

func OAuthCallbackURL(publicWebURL string) string {
	return strings.TrimRight(publicWebURL, "/") + OAuthCallbackPath
}

func (c *Client) CreateConnectionLink(ctx context.Context, authConfigID, accountID string) (Link, error) {
	if authConfigID == "" {
		return Link{}, errors.New("Composio auth config ID is required")
	}
	body := map[string]string{"auth_config_id": authConfigID, "user_id": c.UserIDForAccount(accountID)}
	callback := c.callbackURL
	if desktop, ok := ctx.Value(desktopCallbackKey{}).(string); ok {
		callback = desktop
	}
	if callback != "" {
		body["callback_url"] = callback
	}
	var response struct {
		ConnectedAccountID string `json:"connected_account_id"`
		RedirectURL        string `json:"redirect_url"`
		ExpiresAt          string `json:"expires_at"`
	}
	if err := c.requestJSONOnce(ctx, http.MethodPost, "/api/v3.1/connected_accounts/link", body, &response, "create connection link"); err != nil {
		return Link{}, err
	}
	expiresAt, err := time.Parse(time.RFC3339, response.ExpiresAt)
	if err != nil || response.ConnectedAccountID == "" || response.RedirectURL == "" {
		return Link{}, errors.New("Composio create connection link returned an invalid response")
	}
	return Link{ConnectedAccountID: response.ConnectedAccountID, RedirectURL: response.RedirectURL, ExpiresAt: expiresAt, AuthConfigID: authConfigID}, nil
}

func (c *Client) GetConnectionStatus(ctx context.Context, connectedAccountID string) (ConnectionStatus, error) {
	return c.GetConnectionStatusForToolkit(ctx, connectedAccountID, "")
}

// GetConnectionStatusForToolkit checks a connection's normalized status against toolkitSlug.
func (c *Client) GetConnectionStatusForToolkit(ctx context.Context, connectedAccountID, toolkitSlug string) (ConnectionStatus, error) {
	report, err := c.InspectConnectionStatusForToolkit(ctx, connectedAccountID, toolkitSlug)
	return report.Status, err
}

// InspectConnectionStatusForToolkit checks a connection's normalized status and
// closed diagnostic reason against toolkitSlug.
func (c *Client) InspectConnectionStatusForToolkit(ctx context.Context, connectedAccountID, toolkitSlug string) (ConnectionStatusReport, error) {
	binding, err := c.authorizeConnection(ctx, connectedAccountID)
	if err != nil {
		return ConnectionStatusReport{}, err
	}
	var response struct {
		UserID     string `json:"user_id"`
		AuthConfig struct {
			ID string `json:"id"`
		} `json:"auth_config"`
		Status     string `json:"status"`
		IsDisabled bool   `json:"is_disabled"`
		Toolkit    struct {
			Slug string `json:"slug"`
		} `json:"toolkit"`
	}
	endpoint := "/api/v3.1/connected_accounts/" + url.PathEscape(connectedAccountID)
	if err := c.requestJSON(ctx, http.MethodGet, endpoint, nil, &response, "get connection status"); err != nil {
		return ConnectionStatusReport{}, err
	}
	if binding.UserID != "" {
		switch {
		case response.UserID != binding.UserID:
			return ConnectionStatusReport{}, connectionScopeError{field: "user_id"}
		case response.Toolkit.Slug != binding.ToolkitSlug:
			return ConnectionStatusReport{}, connectionScopeError{field: "toolkit_slug"}
		case response.AuthConfig.ID != binding.AuthConfigID:
			return ConnectionStatusReport{}, connectionScopeError{field: "auth_config_id"}
		}
	}
	if toolkitSlug != "" && response.Toolkit.Slug != toolkitSlug {
		return ConnectionStatusReport{Status: ConnectionFailed, Reason: ConnectionStatusReasonToolkitMismatch}, nil
	}
	if toolkitSlug == "" && response.Toolkit.Slug != "gmail" && response.Toolkit.Slug != "slack" {
		return ConnectionStatusReport{Status: ConnectionFailed, Reason: ConnectionStatusReasonToolkitMismatch}, nil
	}
	return classifyConnectionStatus(response.Status, response.IsDisabled), nil
}

func (c *Client) RevokeConnection(ctx context.Context, connectedAccountID string) error {
	if _, err := c.authorizeConnection(ctx, connectedAccountID); err != nil {
		return err
	}
	var response map[string]any
	endpoint := "/api/v3.1/connected_accounts/" + url.PathEscape(connectedAccountID)
	return c.requestJSON(ctx, http.MethodDelete, endpoint, nil, &response, "revoke connection")
}

func (c *Client) GetTool(ctx context.Context, toolSlug, version string) (Tool, error) {
	parameters := url.Values{}
	parameters.Set("version", version)
	var response Tool
	endpoint := "/api/v3/tools/" + url.PathEscape(toolSlug) + "?" + parameters.Encode()
	if err := c.requestJSON(ctx, http.MethodGet, endpoint, nil, &response, "get tool"); err != nil {
		return Tool{}, err
	}
	return response, nil
}

func (c *Client) ExecuteTool(ctx context.Context, connectedAccountID, userID, toolSlug, version string, arguments map[string]any) (ToolExecution, error) {
	binding, err := c.authorizeConnection(ctx, connectedAccountID)
	if err != nil {
		return ToolExecution{}, err
	}
	if binding.UserID != "" && binding.UserID != userID {
		return ToolExecution{}, ErrConnectionScope
	}
	// Composio rejects "arguments": null, and a persisted no-argument action
	// decodes back as a nil map, so a tool without arguments sends {}.
	if arguments == nil {
		arguments = map[string]any{}
	}
	request := struct {
		ConnectedAccountID string         `json:"connected_account_id"`
		UserID             string         `json:"user_id"`
		Version            string         `json:"version"`
		Arguments          map[string]any `json:"arguments"`
	}{ConnectedAccountID: connectedAccountID, UserID: userID, Version: version, Arguments: arguments}
	var response ToolExecution
	endpoint := "/api/v3.1/tools/execute/" + url.PathEscape(toolSlug)
	if err := c.requestJSONOnce(ctx, http.MethodPost, endpoint, request, &response, "execute tool"); err != nil {
		return ToolExecution{}, err
	}
	return response, nil
}

func ErrorStatus(err error) (int, bool) {
	var remote *remoteError
	if !errors.As(err, &remote) {
		return 0, false
	}
	return remote.status, true
}

// ErrorSourceOf reports whether err originated from Composio's API or from an
// upstream provider behind Composio's proxy.
func ErrorSourceOf(err error) (ErrorSource, bool) {
	var remote *remoteError
	if errors.As(err, &remote) && remote.source != "" {
		return remote.source, true
	}
	var limited *RateLimitError
	if errors.As(err, &limited) && limited.Source != "" {
		return limited.Source, true
	}
	return "", false
}

func RemoteStatusError(operation string, status int) error {
	return &remoteError{operation: operation, status: status}
}

func IsAuthFailure(err error) bool {
	status, ok := ErrorStatus(err)
	if !ok {
		return false
	}
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusGone:
		return true
	default:
		return false
	}
}

func classifyConnectionStatus(status string, disabled bool) ConnectionStatusReport {
	if disabled {
		return ConnectionStatusReport{Status: ConnectionFailed, Reason: ConnectionStatusReasonDisabled}
	}
	switch strings.ToUpper(strings.TrimSpace(status)) {
	case "ACTIVE":
		return ConnectionStatusReport{Status: ConnectionActive, Reason: ConnectionStatusReasonActive}
	case "EXPIRED":
		return ConnectionStatusReport{Status: ConnectionExpired, Reason: ConnectionStatusReasonExpired}
	case "INITIALIZING", "INITIATED", "PENDING":
		return ConnectionStatusReport{Status: ConnectionPending, Reason: ConnectionStatusReasonPending}
	case "FAILED":
		return ConnectionStatusReport{Status: ConnectionFailed, Reason: ConnectionStatusReasonFailed}
	case "REVOKED":
		return ConnectionStatusReport{Status: ConnectionFailed, Reason: ConnectionStatusReasonRevoked}
	case "INACTIVE":
		return ConnectionStatusReport{Status: ConnectionFailed, Reason: ConnectionStatusReasonInactive}
	default:
		return ConnectionStatusReport{Status: ConnectionFailed, Reason: ConnectionStatusReasonUnknown}
	}
}

func (c *Client) proxy(ctx context.Context, request proxyRequest, target any, operation string) error {
	binding, err := c.authorizeConnection(ctx, request.ConnectedAccountID)
	if err != nil {
		return err
	}
	// Composio requires the owning user for proxy calls when project 2FA is enabled.
	// Derive it from our connection authority, never from the caller.
	request.UserID = binding.UserID
	retryLimit := c.retryLimit
	if providerAttemptAuthorityFromContext(ctx) {
		retryLimit = 0
	}
	for attempt := 0; ; attempt++ {
		var response proxyResponse
		if err := c.requestJSON(ctx, http.MethodPost, "/api/v3.1/tools/execute/proxy", request, &response, operation); err != nil {
			return err
		}
		if response.Status == http.StatusTooManyRequests && attempt < retryLimit {
			delay := parseRetryAfter(time.Now(), headerValue(response.Headers, "retry-after"), c.maxRetryAfter)
			if err := waitRetry(ctx, delay); err != nil {
				return err
			}
			continue
		}
		if response.Status == http.StatusTooManyRequests {
			return &RateLimitError{Operation: operation, RetryAfter: parseRetryAfter(time.Now(), headerValue(response.Headers, "retry-after"), 0), Source: ErrorSourceProvider}
		}
		if response.Status < 200 || response.Status >= 300 {
			return &remoteError{operation: operation, status: response.Status, source: ErrorSourceProvider}
		}
		payload := response.Data
		if text, ok := target.(*string); ok {
			if err := json.Unmarshal(payload, text); err != nil {
				return fmt.Errorf("Composio %s returned invalid text", operation)
			}
			return nil
		}
		var encoded string
		if len(payload) > 0 && payload[0] == '"' && json.Unmarshal(payload, &encoded) == nil {
			payload = []byte(encoded)
		}
		if err := json.Unmarshal(payload, target); err != nil {
			return fmt.Errorf("Composio %s returned an invalid response", operation)
		}
		return nil
	}
}

func (c *Client) requestJSON(ctx context.Context, method, endpoint string, input, output any, operation string) error {
	apiKey := c.key()
	if apiKey == "" {
		return ErrNotConfigured
	}
	var encoded []byte
	var err error
	if input != nil {
		encoded, err = json.Marshal(input)
		if err != nil {
			return err
		}
	}
	retryLimit := c.retryLimit
	if providerAttemptAuthorityFromContext(ctx) {
		retryLimit = 0
	}
	for attempt := 0; ; attempt++ {
		request, err := http.NewRequestWithContext(ctx, method, c.baseURL+endpoint, bytes.NewReader(encoded))
		if err != nil {
			return err
		}
		request.Header.Set("x-api-key", apiKey)
		request.Header.Set("Content-Type", "application/json")
		if err := reserveProviderAttempt(ctx); err != nil {
			return err
		}
		response, err := c.httpClient.Do(request)
		if err != nil {
			return fmt.Errorf("Composio %s request failed", operation)
		}
		if response.StatusCode == http.StatusTooManyRequests && attempt < retryLimit {
			retryAfter := parseRetryAfter(time.Now(), response.Header.Get("Retry-After"), c.maxRetryAfter)
			_ = response.Body.Close()
			if err := waitRetry(ctx, retryAfter); err != nil {
				return err
			}
			continue
		}
		if response.StatusCode == http.StatusTooManyRequests {
			_ = response.Body.Close()
			return &RateLimitError{Operation: operation, RetryAfter: parseRetryAfter(time.Now(), response.Header.Get("Retry-After"), 0), Source: ErrorSourceComposio}
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			_ = response.Body.Close()
			return &remoteError{operation: operation, status: response.StatusCode, source: ErrorSourceComposio}
		}
		if response.StatusCode == http.StatusNoContent {
			_ = response.Body.Close()
			return nil
		}
		err = decodeResponseJSON(response.Body, output, int64(c.maxThreadBytes+c.maxBodyBytes+1<<20))
		closeErr := response.Body.Close()
		if errors.Is(err, ErrResponseTooLarge) {
			return err
		}
		if err != nil || closeErr != nil {
			return fmt.Errorf("Composio %s returned an invalid response", operation)
		}
		return nil
	}
}

func (c *Client) requestJSONOnce(ctx context.Context, method, endpoint string, input, output any, operation string) error {
	apiKey := c.key()
	if apiKey == "" {
		return ErrNotConfigured
	}
	var encoded []byte
	var err error
	if input != nil {
		encoded, err = json.Marshal(input)
		if err != nil {
			return err
		}
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+endpoint, bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	request.Header.Set("x-api-key", apiKey)
	request.Header.Set("Content-Type", "application/json")
	if err := reserveProviderAttempt(ctx); err != nil {
		return err
	}
	executionClient := &http.Client{
		Transport: c.httpClient.Transport,
		Timeout:   c.httpClient.Timeout,
		Jar:       c.httpClient.Jar,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	response, err := executionClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("Composio %s request failed", operation)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusTooManyRequests {
		return &RateLimitError{Operation: operation, RetryAfter: parseRetryAfter(time.Now(), response.Header.Get("Retry-After"), 0), Source: ErrorSourceComposio}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &remoteError{operation: operation, status: response.StatusCode, source: ErrorSourceComposio}
	}
	if err := decodeResponseJSON(response.Body, output, int64(c.maxThreadBytes+c.maxBodyBytes+1<<20)); err != nil {
		if errors.Is(err, ErrResponseTooLarge) {
			return err
		}
		return fmt.Errorf("Composio %s returned an invalid response", operation)
	}
	return nil
}

func parseRetryAfter(now time.Time, value string, maximum time.Duration) time.Duration {
	limit := func(value time.Duration) time.Duration {
		if maximum <= 0 {
			return value
		}
		return min(value, maximum)
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return limit(time.Second)
	}
	if seconds, err := strconv.Atoi(value); err == nil {
		if seconds < 0 {
			return 0
		}
		return limit(time.Duration(seconds) * time.Second)
	}
	if retryAt, err := http.ParseTime(value); err == nil && retryAt.After(now) {
		return limit(retryAt.Sub(now))
	}
	return limit(time.Second)
}

func waitRetry(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func headerValue(headers map[string]string, name string) string {
	for key, value := range headers {
		if strings.EqualFold(key, name) {
			return value
		}
	}
	return ""
}

// A deterministic oversized body is different from a transient or malformed response.
// ErrResponseTooLarge means a Composio response exceeded the read limit.
var ErrResponseTooLarge = errors.New("Composio response exceeds the read limit")

func decodeResponseJSON(reader io.Reader, output any, limit int64) error {
	bounded := &io.LimitedReader{R: reader, N: limit + 1}
	err := json.NewDecoder(bounded).Decode(output)
	if bounded.N == 0 {
		return ErrResponseTooLarge
	}
	return err
}
