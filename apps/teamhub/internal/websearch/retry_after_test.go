package websearch

import (
	"errors"
	"net/http"
	"testing"
	"time"
)

func TestRunPreservesRetryAfterDates(t *testing.T) {
	for _, backend := range []Backend{Tavily, DuckDuckGo, You} {
		for _, format := range []struct{ name, layout string }{
			{"http", http.TimeFormat},
			{"rfc850", time.RFC850},
			{"asctime", time.ANSIC},
		} {
			t.Run(string(backend)+"/"+format.name, func(t *testing.T) {
				deadline := time.Now().In(time.FixedZone("GMT", 0)).Truncate(time.Second).Add(2 * time.Minute)
				fake := newFakeProviders(t, func(w http.ResponseWriter, _ seen) {
					w.Header().Set("Retry-After", deadline.Format(format.layout))
					writeJSON(w, http.StatusTooManyRequests, `{}`)
				})
				s, keys := newTestService(t, fake)
				if backend == Tavily {
					saveRaw(t, s, keys, backend, "test-key", "verified")
				}
				request := search("test query")
				request.Backend = backend
				before := time.Now()
				_, err := s.Run(t.Context(), request)
				after := time.Now()
				var failure *Failure
				wantCode := CodeRateLimited
				if backend == You {
					wantCode = CodeFreeLimit
				}
				if !errors.As(err, &failure) || failure.Code != wantCode || failure.Backend != backend {
					t.Fatalf("Run = %#v", err)
				}
				// The API exposes whole seconds: rounding must not recommend an early retry.
				if failure.RetryAfter < deadline.Sub(after) || failure.RetryAfter >= deadline.Sub(before)+time.Second {
					t.Fatalf("retry wait = %s, deadline in [%s, %s]", failure.RetryAfter, deadline.Sub(after), deadline.Sub(before))
				}
				if failure.RetryAfter%time.Second != 0 {
					t.Fatalf("retry wait must survive whole-second API projection: %s", failure.RetryAfter)
				}
				if len(fake.seen()) != 1 {
					t.Fatalf("provider calls = %d, want one", len(fake.seen()))
				}
			})
		}
	}
}

func TestRetryAfterPreservesSecondsAndFallback(t *testing.T) {
	for _, tc := range []struct {
		name, value, fallback string
		want                  time.Duration
	}{
		{"seconds", "7", "", 7 * time.Second},
		{"spaces", " 7 ", "", 7 * time.Second},
		{"reset window", "", "1, 999", time.Second},
		{"explicit precedence", "9", "3, 999", 9 * time.Second},
		{"zero precedence", "0", "3, 999", 0},
		{"missing", "", "", 0},
		{"invalid", "later", "3", 0},
		{"negative", "-1", "", 0},
		{"past date", "Sun, 06 Nov 1994 08:49:37 GMT", "", 0},
		{"seconds overflow", "10000000000", "", time.Duration(1<<63 - 1)},
		{"far future date", "Fri, 31 Dec 9999 23:59:59 GMT", "", time.Duration(1<<63 - 1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			header := http.Header{}
			header.Set("Retry-After", tc.value)
			header.Set("X-RateLimit-Reset", tc.fallback)
			if got := retryAfter(header); got != tc.want {
				t.Fatalf("retryAfter = %s, want %s", got, tc.want)
			}
		})
	}
}
