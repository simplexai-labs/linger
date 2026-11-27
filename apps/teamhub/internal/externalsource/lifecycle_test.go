package externalsource

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
)

func TestConnectionIdentityFailurePolicyRequiresDiscordGuildWithoutRapidRetry(t *testing.T) {
	code, retryAfter, failConnection := connectionIdentityFailurePolicy("discord", composio.ErrDiscordGuildRequired)
	if code != "discord_guild_required" || retryAfter != 6*time.Hour || failConnection {
		t.Fatalf("policy=(%q,%s,%t) want discord_guild_required and 6h", code, retryAfter, failConnection)
	}
	code, retryAfter, failConnection = connectionIdentityFailurePolicy("google_calendar", errors.New("temporary"))
	if code != "provider_identity_unavailable" || retryAfter != time.Minute || failConnection {
		t.Fatalf("fallback policy=(%q,%s,%t)", code, retryAfter, failConnection)
	}
	refused := fmt.Errorf("Composio identify Discord installation failed: %w", composio.ErrDiscordToolRefused)
	code, retryAfter, failConnection = connectionIdentityFailurePolicy("discord", refused)
	if code != "provider_identity_unavailable" || retryAfter != time.Minute || failConnection {
		t.Fatalf("refused Discord tool policy=(%q,%s,%t)", code, retryAfter, failConnection)
	}
}

func TestConnectionIdentityFailurePolicyFailsInsufficientPermission(t *testing.T) {
	code, retryAfter, failConnection := connectionIdentityFailurePolicy("gmail", composio.RemoteStatusError("identify Gmail account", http.StatusForbidden))
	if code != "provider_auth_failed" || retryAfter != 6*time.Hour || !failConnection {
		t.Fatalf("gmail 403 policy=(%q,%s,%t)", code, retryAfter, failConnection)
	}
	code, retryAfter, failConnection = connectionIdentityFailurePolicy("slack", &composio.SlackAccessError{Operation: "identify Slack workspace"})
	if code != "provider_auth_failed" || !failConnection {
		t.Fatalf("slack missing scope policy=(%q,%s,%t)", code, retryAfter, failConnection)
	}
	code, retryAfter, failConnection = connectionIdentityFailurePolicy("github", composio.RemoteStatusError("identify GitHub account", http.StatusUnauthorized))
	if code != "provider_auth_failed" || !failConnection {
		t.Fatalf("github 401 policy=(%q,%s,%t)", code, retryAfter, failConnection)
	}
}

func TestValidateDiscordGuildID(t *testing.T) {
	if err := validateDiscordGuildID("1537440822578913330"); err != nil {
		t.Fatal(err)
	}
	for _, guildID := range []string{"", "REDACTED", "123/server", "123456789012345678901"} {
		if err := validateDiscordGuildID(guildID); !errors.Is(err, ErrInvalid) {
			t.Fatalf("guild id %q error=%v want ErrInvalid", guildID, err)
		}
	}
}

func TestRetryDisconnectTransactionSucceedsAfterDeadlocks(t *testing.T) {
	calls := 0
	want := Connection{ID: "external_connection_1"}

	got, err := retryDisconnectTransaction(func() (Connection, error) {
		calls++
		if calls < disconnectTransactionMaxAttempts {
			return Connection{}, &pgconn.PgError{Code: "40P01"}
		}
		return want, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("cleanup=%+v want=%+v", got, want)
	}
	if calls != disconnectTransactionMaxAttempts {
		t.Fatalf("calls=%d want=%d", calls, disconnectTransactionMaxAttempts)
	}
}

func TestRetryDisconnectTransactionDoesNotRetryOtherErrors(t *testing.T) {
	want := errors.New("database unavailable")
	calls := 0

	_, err := retryDisconnectTransaction(func() (Connection, error) {
		calls++
		return Connection{}, want
	})
	if !errors.Is(err, want) {
		t.Fatalf("error=%v want=%v", err, want)
	}
	if calls != 1 {
		t.Fatalf("calls=%d want=1", calls)
	}
}

func TestRetryDisconnectTransactionReturnsFinalDeadlock(t *testing.T) {
	deadlocks := make([]error, disconnectTransactionMaxAttempts)
	for index := range deadlocks {
		deadlocks[index] = fmt.Errorf("attempt %d: %w", index+1, &pgconn.PgError{Code: "40P01"})
	}
	calls := 0

	_, err := retryDisconnectTransaction(func() (Connection, error) {
		result := deadlocks[calls]
		calls++
		return Connection{}, result
	})
	if !errors.Is(err, deadlocks[len(deadlocks)-1]) {
		t.Fatalf("error=%v want final deadlock=%v", err, deadlocks[len(deadlocks)-1])
	}
	if calls != disconnectTransactionMaxAttempts {
		t.Fatalf("calls=%d want=%d", calls, disconnectTransactionMaxAttempts)
	}
}

func TestConnectionIdentityFailurePolicyRateLimit(t *testing.T) {
	code, delay, failed := connectionIdentityFailurePolicy("gmail", &composio.RateLimitError{RetryAfter: time.Hour})
	if code != "provider_rate_limited" || delay != time.Hour || failed {
		t.Fatalf("policy=%s %s %t", code, delay, failed)
	}
}

func TestConnectionCheckRetryDelayBoundedAndHonorsProviderFloor(t *testing.T) {
	previous := time.Duration(0)
	for attempts := 1; attempts <= 40; attempts++ {
		delay := connectionCheckRetryDelay("ca_retry", attempts, 0)
		if delay < time.Minute || delay > 6*time.Hour || delay < previous {
			t.Fatalf("attempt=%d delay=%s previous=%s", attempts, delay, previous)
		}
		previous = delay
	}
	if delay := connectionCheckRetryDelay("ca_retry", 1, 24*time.Hour); delay != 24*time.Hour {
		t.Fatalf("provider floor truncated to %s", delay)
	}
}

func TestConnectionCheckRetryDelayHourlyFloorAfterThreshold(t *testing.T) {
	if delay := connectionReconcileRetryDelay("ca_retry", connectionCheckHourlyRetryAttempt-1, 0); delay >= time.Hour {
		t.Fatalf("attempt %d already hourly: %s", connectionCheckHourlyRetryAttempt-1, delay)
	}
	if delay := connectionReconcileRetryDelay("ca_retry", connectionCheckHourlyRetryAttempt, 0); delay < time.Hour {
		t.Fatalf("attempt %d missing hourly floor: %s", connectionCheckHourlyRetryAttempt, delay)
	}
	if delay := connectionReconcileRetryDelay("ca_retry", connectionCheckHourlyRetryAttempt, 24*time.Hour); delay != 24*time.Hour {
		t.Fatalf("hourly floor overrode provider Retry-After: %s", delay)
	}
	if delay := connectionCheckRetryDelay("ca_retry", connectionCheckHourlyRetryAttempt, 0); delay >= time.Hour {
		t.Fatalf("shared delay applied hourly floor: %s", delay)
	}
}

func TestConnectionCheckFailureDoesNotExposeProviderPayload(t *testing.T) {
	cause := &composio.RateLimitError{Operation: "token=private-provider-payload", RetryAfter: time.Hour}
	failure := &connectionCheckFailure{connectionID: "connection_1", phase: "identity_refresh", code: "provider_rate_limited", retryDelay: time.Hour, cause: cause}
	if text := failure.Error(); strings.Contains(text, "private-provider-payload") || !strings.Contains(text, "identity_refresh") || !strings.Contains(text, "next_attempt_in=") {
		t.Fatalf("unsafe or incomplete diagnostic: %s", text)
	}
	var limited *composio.RateLimitError
	if !errors.As(failure, &limited) || limited.RetryAfter != time.Hour {
		t.Fatal("rate limit cause was lost")
	}
	if !failure.RetryableJobFailure() {
		t.Fatal("rate limited check should be retryable")
	}
}

func TestConnectionCheckFailureRetryableCodes(t *testing.T) {
	for _, code := range []string{"provider_identity_unavailable", "provider_status_unavailable", "provider_rate_limited", "discord_guild_required"} {
		failure := &connectionCheckFailure{code: code}
		if !failure.RetryableJobFailure() {
			t.Fatalf("%s should be retryable", code)
		}
	}
	if (&connectionCheckFailure{code: "provider_auth_failed"}).RetryableJobFailure() {
		t.Fatal("auth failure should not be retryable")
	}
}

func TestConnectionCheckErrorClassOmitsPayload(t *testing.T) {
	payload := "token=private-provider-payload"
	tests := []struct {
		name  string
		err   error
		want  string
		avoid string
	}{
		{name: "canceled", err: context.Canceled, want: "canceled"},
		{name: "timeout", err: context.DeadlineExceeded, want: "timeout"},
		{name: "rate limit", err: &composio.RateLimitError{Operation: payload, RetryAfter: time.Second}, want: "http_429", avoid: payload},
		{name: "http 503", err: composio.RemoteStatusError(payload, http.StatusServiceUnavailable), want: "http_503", avoid: payload},
		{name: "http 403", err: composio.RemoteStatusError(payload, http.StatusForbidden), want: "http_403", avoid: payload},
		{name: "network", err: &net.DNSError{Err: payload, Name: "secret.example", IsTimeout: false}, want: "network", avoid: payload},
		{name: "wrapped timeout", err: fmt.Errorf("identify: %w", context.DeadlineExceeded), want: "timeout"},
		{name: "type name", err: errors.New(payload), want: "*errors.errorString", avoid: payload},
		{name: "fmt request failed", err: fmt.Errorf("Composio %s request failed", payload), avoid: payload},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := connectionCheckErrorClass(test.err)
			if test.want != "" && got != test.want {
				t.Fatalf("class=%q want=%q", got, test.want)
			}
			if strings.Contains(got, payload) || (test.avoid != "" && strings.Contains(got, test.avoid)) {
				t.Fatalf("class leaked payload: %q", got)
			}
		})
	}
}

func TestConnectionCheckResultKeepsWriteError(t *testing.T) {
	failure := &connectionCheckFailure{code: "provider_identity_unavailable", cause: errors.New("temporary")}
	writeErr := errors.New("database unavailable")
	if got := connectionCheckResult(writeErr, failure); !errors.Is(got, writeErr) {
		t.Fatalf("write error became %v", got)
	}
	if got := connectionCheckResult(failure.cause, failure); !errors.Is(got, failure) {
		t.Fatalf("check failure became %v", got)
	}
}

func testComposioStatusError(t *testing.T, source composio.ErrorSource, status int) error {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if source == composio.ErrorSourceProvider {
			_, _ = fmt.Fprintf(w, `{"status":%d,"data":{"error":"upstream"}}`, status)
			return
		}
		w.WriteHeader(status)
	}))
	defer server.Close()
	client, err := composio.New(composio.Config{
		BaseURL:        server.URL,
		APIKey:         "key",
		EnvironmentKey: "test",
		HTTPClient:     server.Client(),
		RetryLimit:     0,
	})
	if err != nil {
		t.Fatal(err)
	}
	client.SetConnectionAuthority(func(context.Context, string) (composio.ConnectionBinding, error) {
		return composio.ConnectionBinding{}, nil
	})
	ctx, _ := composio.WithProviderAttemptBudget(context.Background(), 1)
	if source == composio.ErrorSourceProvider {
		_, err = client.IdentifyGmail(ctx, "ca_1")
		return err
	}
	_, err = client.GetConnectionStatus(ctx, "ca_1")
	return err
}

func TestConnectionCheckErrorSource(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{name: "composio status", err: testComposioStatusError(t, composio.ErrorSourceComposio, http.StatusForbidden), want: "composio"},
		{name: "composio rate limit", err: &composio.RateLimitError{Operation: "op", Source: composio.ErrorSourceComposio}, want: "composio"},
		{name: "provider status", err: testComposioStatusError(t, composio.ErrorSourceProvider, http.StatusForbidden), want: "provider"},
		{name: "provider rate limit", err: &composio.RateLimitError{Operation: "op", Source: composio.ErrorSourceProvider}, want: "provider"},
		{name: "legacy status", err: composio.RemoteStatusError("op", http.StatusForbidden), want: ""},
		{name: "generic", err: errors.New("boom"), want: ""},
		{name: "nil", err: nil, want: ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := connectionCheckErrorSource(tc.err); got != tc.want {
				t.Fatalf("source=%q want %q", got, tc.want)
			}
		})
	}
}

func TestConnectionCheckErrorClassClosedSentinels(t *testing.T) {
	payload := "secret-provider-payload"
	scopeMismatchErr := func(body string) error {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(body))
		}))
		defer server.Close()
		client, err := composio.New(composio.Config{BaseURL: server.URL, APIKey: "key", EnvironmentKey: "ci", HTTPClient: server.Client()})
		if err != nil {
			t.Fatal(err)
		}
		client.SetConnectionAuthority(func(context.Context, string) (composio.ConnectionBinding, error) {
			return composio.ConnectionBinding{UserID: "expected-user", ToolkitSlug: "gmail", AuthConfigID: "ac_expected"}, nil
		})
		_, err = client.InspectConnectionStatusForToolkit(context.Background(), "ca_1", "gmail")
		return err
	}
	tests := []struct {
		name string
		err  error
		want string
	}{
		{name: "connection scope plain", err: composio.ErrConnectionScope, want: "connection_scope"},
		{name: "connection scope user_id", err: scopeMismatchErr(`{"status":"ACTIVE","user_id":"other","toolkit":{"slug":"gmail"},"auth_config":{"id":"ac_expected"}}`), want: "connection_scope_user_id"},
		{name: "connection scope toolkit_slug", err: scopeMismatchErr(`{"status":"ACTIVE","user_id":"expected-user","toolkit":{"slug":"slack"},"auth_config":{"id":"ac_expected"}}`), want: "connection_scope_toolkit_slug"},
		{name: "connection scope auth_config_id", err: scopeMismatchErr(`{"status":"ACTIVE","user_id":"expected-user","toolkit":{"slug":"gmail"},"auth_config":{"id":"ac_other"}}`), want: "connection_scope_auth_config_id"},
		{name: "not configured", err: composio.ErrNotConfigured, want: "provider_not_configured"},
		{name: "response too large", err: composio.ErrResponseTooLarge, want: "response_too_large"},
		{name: "call budget exhausted", err: composio.ErrProviderCallBudgetExhausted, want: "call_budget_exhausted"},
		{name: "discord guild required", err: composio.ErrDiscordGuildRequired, want: "discord_guild_required"},
		{name: "discord guild not accessible", err: composio.ErrDiscordGuildNotAccessible, want: "discord_guild_not_accessible"},
		{name: "discord tool refused", err: composio.ErrDiscordToolRefused, want: "discord_tool_refused"},
		{name: "slack access", err: &composio.SlackAccessError{Operation: payload}, want: "slack_access"},
		{name: "invalid identity", err: ErrInvalid, want: "invalid_identity"},
		{name: "provider unavailable", err: ErrUnavailable, want: "provider_unavailable"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := connectionCheckErrorClass(tc.err)
			if got != tc.want {
				t.Fatalf("class=%q want %q", got, tc.want)
			}
			if strings.Contains(got, payload) {
				t.Fatalf("class leaked payload: %q", got)
			}
		})
	}
}

func TestConnectionCheckLogTerminalFailureKeepsNilResult(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil))
	check := &connectionCheck{
		service:    &Service{logger: logger},
		connection: Connection{ID: "conn_1", Provider: "gmail"},
		attempt:    1,
	}
	check.logTerminalFailure("identity_refresh", "provider_auth_failed", testComposioStatusError(t, composio.ErrorSourceProvider, http.StatusForbidden))
	if check.failure != nil {
		t.Fatalf("check.failure=%v want nil so finish preserves a nil result", check.failure)
	}
	var record map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &record); err != nil {
		t.Fatalf("unmarshal log %q: %v", buf.String(), err)
	}
	if record["level"] != "WARN" ||
		record["msg"] != "external connection check failed" ||
		record["connection_id"] != "conn_1" ||
		record["provider"] != "gmail" ||
		record["phase"] != "identity_refresh" ||
		record["error_code"] != "provider_auth_failed" ||
		record["error_class"] != "http_403" ||
		record["error_source"] != "provider" ||
		record["terminal"] != true {
		t.Fatalf("unexpected log record: %#v", record)
	}
}
