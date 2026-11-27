package app

import (
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/mobilegateway"
)

// Every Mobile API entry must name a real public operation, so a typo cannot
// silently leave a phone without a route, and no entry may reach a route a
// phone must never call.
func TestMobileAllowlistNamesPublicOperations(t *testing.T) {
	public := map[string]bool{}
	for _, route := range (&App{}).publicRoutes() {
		segments := strings.Split(strings.Trim(route.path, "/"), "/")
		for i, segment := range segments {
			if strings.HasPrefix(segment, ":") {
				segments[i] = ":"
			}
		}
		public[route.method+" /"+strings.Join(segments, "/")] = true
	}
	forbidden := []string{"/v0/auth/", "/v0/account/", "/v0/local/", "/v0/agent-runtime/", "/api/", "/internal/", "/v0/me/phone-pairings", "/v0/me/phones", "/v0/voice-provider-keys", "/collaboration-credentials", "/local-computer-enrollments"}
	for _, route := range mobilegateway.Routes() {
		if !public[route.Method+" "+route.Pattern] {
			t.Errorf("%s %s is not a teamhub-public operation", route.Method, route.Pattern)
		}
		for _, prefix := range forbidden {
			if strings.Contains(route.Pattern, prefix) {
				t.Errorf("%s %s reaches a route a phone must never call (%s)", route.Method, route.Pattern, prefix)
			}
		}
	}
}
