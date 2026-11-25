package mobilegateway

import "strings"

// mobileRoutes is the Mobile API: every TeamHub route a phone may call. A
// pattern segment ":" matches one path segment. Anything else answers 404
// inside the Gateway, so sign-in, password, logout, local identity, Computer
// enrollment, Agent Runtime, internal and Agent API routes are unreachable
// from a phone.
var mobileRoutes = []struct {
	method  string
	pattern string
}{
	{"GET", "/v0/me"},
	{"GET", "/v0/session"},
	{"GET", "/v0/events"},
	{"GET", "/v0/tenants/:/rooms"},
	{"GET", "/v0/tenants/:/another-me"},
	{"GET", "/v0/tenants/:/agent-availability"},
	{"GET", "/v0/tenants/:/agents"},
	{"GET", "/v0/tenants/:/agents/:/avatar-image"},
	{"GET", "/v0/rooms/:"},
	{"GET", "/v0/rooms/:/events"},
	{"GET", "/v0/rooms/:/members"},
	{"GET", "/v0/rooms/:/messages"},
	{"GET", "/v0/rooms/:/messages/:"},
	{"POST", "/v0/rooms/:/messages"},
	{"PUT", "/v0/rooms/:/read-state"},
	{"POST", "/v0/rooms/:/message-attachment-uploads"},
	{"DELETE", "/v0/rooms/:/message-attachment-uploads/:"},
	{"GET", "/v0/rooms/:/run-statuses"},
	{"GET", "/v0/rooms/:/runtime-presentation-runs"},
	{"GET", "/v0/rooms/:/runs/:/runtime-presentation-events"},
	{"POST", "/v0/rooms/:/runs/:/cancel"},
	{"GET", "/v0/rooms/:/runs/:/activities"},
	{"POST", "/v0/decisions/:"},
	{"GET", "/v0/decisions/:/screenshot"},
	{"POST", "/v0/rooms/:/voice-sessions"},
	{"GET", "/v0/voice-sessions/:"},
	{"POST", "/v0/voice-sessions/:/connection-credentials"},
	{"POST", "/v0/voice-sessions/:/dictation-commit"},
	{"POST", "/v0/voice-sessions/:/captures"},
	{"POST", "/v0/voice-captures/:/stop"},
	{"GET", "/v0/voice-captures/:"},
	{"GET", "/v0/voice-sessions/:/events"},
	{"GET", "/v0/voice-sessions/:/events/stream"},
	{"GET", "/v0/voice-sessions/:/transcript-events"},
	{"DELETE", "/v0/voice-sessions/:"},
	{"GET", "/v0/tenants/:/memory"},
	{"GET", "/v0/tenants/:/memory/:"},
	{"GET", "/v0/documents/:"},
	{"GET", "/v0/documents/:/downloads"},
	{"GET", "/v0/document-versions/:"},
	{"GET", "/v0/document-versions/:/content"},
	{"GET", "/v0/document-assets/:/content"},
	{"GET", "/v0/tenants/:/personal-wiki/documents"},
	{"GET", "/v0/library/documents"},
	{"PUT", "/v0/me/phone/push-grant"},
	{"DELETE", "/v0/me/phone/push-grant"},
	{"PUT", "/v0/me/phone/push-preferences"},
	// The phone says it is looking at a Room, which holds back its pushes.
	{"POST", "/v0/rooms/:/presence"},
	{"GET", "/v0/mobile/relays"},
	{"GET", "/v0/rooms/:/routines"},
	{"GET", "/v0/external-apps"},
	{"GET", "/v0/external-connections"},
	{"GET", "/v0/external-connections/:/agent-grants"},
	{"POST", "/v0/mobile/relays"},
}

func allowed(method, path string) bool {
	segments := strings.Split(strings.Trim(path, "/"), "/")
	for _, route := range mobileRoutes {
		if route.method != method {
			continue
		}
		pattern := strings.Split(strings.Trim(route.pattern, "/"), "/")
		if len(pattern) != len(segments) {
			continue
		}
		matched := true
		for i, part := range pattern {
			if part == ":" {
				if segments[i] == "" {
					matched = false
					break
				}
				continue
			}
			if part != segments[i] {
				matched = false
				break
			}
		}
		if matched {
			return true
		}
	}
	return false
}

// Route is one Mobile API operation: an HTTP method and a path pattern whose
// ":" segments match any single segment.
type Route struct {
	Method  string
	Pattern string
}

// Routes lists the Mobile API, so TeamHub can check that every entry is a
// real public operation.
func Routes() []Route {
	out := make([]Route, 0, len(mobileRoutes))
	for _, route := range mobileRoutes {
		out = append(out, Route{Method: route.method, Pattern: route.pattern})
	}
	return out
}
