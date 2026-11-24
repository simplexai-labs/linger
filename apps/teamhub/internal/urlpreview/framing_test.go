package urlpreview

import (
	"net/http"
	"testing"
)

func TestRefusesFraming(t *testing.T) {
	csp := func(values ...string) http.Header { return http.Header{"Content-Security-Policy": values} }
	cases := []struct {
		name   string
		header http.Header
		scheme string
		want   bool
	}{
		{"no rules", http.Header{}, "", false},
		{"deny", http.Header{"X-Frame-Options": {"DENY"}}, "", true},
		{"sameorigin in lower case", http.Header{"X-Frame-Options": {"sameorigin"}}, "", true},
		{"obsolete allow-from is ignored", http.Header{"X-Frame-Options": {"ALLOW-FROM https://a.example"}}, "", false},
		{"frame-ancestors overrides X-Frame-Options", http.Header{
			"X-Frame-Options":         {"DENY"},
			"Content-Security-Policy": {"default-src 'self'; frame-ancestors *"},
		}, "", false},
		{"frame-ancestors self", csp("frame-ancestors 'self'"), "", true},
		{"frame-ancestors none", csp("frame-ancestors 'none'"), "", true},
		{"named hosts never name Linger", csp("frame-ancestors https://a.example"), "https", true},
		{"https source for an https page", csp("FRAME-ANCESTORS HTTPS:"), "https", false},
		{"https source for an http page", csp("frame-ancestors https:"), "http", true},
		{"http source also matches https pages", csp("frame-ancestors http:"), "https", false},
		{"either source without the page's scheme", csp("frame-ancestors https:"), "", false},
		{"wildcard host source", csp("frame-ancestors https://*"), "https", false},
		{"wildcard host source of another scheme", csp("frame-ancestors https://*"), "http", true},
		{"every policy is enforced", csp("frame-ancestors *", "frame-ancestors 'self'"), "", true},
		{"comma separated policies", csp("frame-ancestors *, frame-ancestors 'none'"), "", true},
		{"policy without frame-ancestors keeps X-Frame-Options", http.Header{
			"X-Frame-Options":         {"SAMEORIGIN"},
			"Content-Security-Policy": {"default-src 'self'"},
		}, "", true},
		{"report-only is not enforced", http.Header{"Content-Security-Policy-Report-Only": {"frame-ancestors 'none'"}}, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := refusesFraming(tc.header, tc.scheme); got != tc.want {
				t.Fatalf("refusesFraming(%v, %q) = %v, want %v", tc.header, tc.scheme, got, tc.want)
			}
		})
	}
}
