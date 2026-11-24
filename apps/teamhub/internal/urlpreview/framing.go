// Package urlpreview tells the Web link preview panel whether a site lets
// another site frame it. A browser cannot read a cross-origin frame's
// response headers, so TeamHub requests the page and reads them instead.
package urlpreview

import (
	"net/http"
	"strings"
)

// refusesFraming reports whether a response forbids framing by the Linger
// Web page served over pageScheme ("http", "https", or empty when unknown).
// CSP frame-ancestors, when present, overrides X-Frame-Options, as in
// browsers. Only *, a scheme source, or a host source with a wildcard host
// matching the page's scheme allows the frame; 'self' and named hosts never
// name the Linger server.
func refusesFraming(header http.Header, pageScheme string) bool {
	found := false
	for _, value := range header.Values("Content-Security-Policy") {
		// One header value may carry several policies separated by commas;
		// each is enforced.
		for _, policy := range strings.Split(value, ",") {
			sources, ok := frameAncestors(policy)
			if !ok {
				continue
			}
			found = true
			if !allowsOtherSites(sources, pageScheme) {
				return true
			}
		}
	}
	if found {
		return false
	}
	for _, value := range header.Values("X-Frame-Options") {
		for _, option := range strings.Split(value, ",") {
			switch strings.ToLower(strings.TrimSpace(option)) {
			case "deny", "sameorigin":
				return true
			}
		}
	}
	return false
}

// frameAncestors returns the sources of a policy's first frame-ancestors
// directive; browsers ignore repeated directives.
func frameAncestors(policy string) ([]string, bool) {
	for _, directive := range strings.Split(policy, ";") {
		fields := strings.Fields(directive)
		if len(fields) > 0 && strings.EqualFold(fields[0], "frame-ancestors") {
			return fields[1:], true
		}
	}
	return nil, false
}

func allowsOtherSites(sources []string, pageScheme string) bool {
	// An http source also matches https pages; an https source never
	// matches an http page. Without the page's scheme, either counts.
	matches := func(scheme string) bool {
		switch scheme {
		case "http":
			return true
		case "https":
			return pageScheme != "http"
		}
		return false
	}
	for _, source := range sources {
		source = strings.ToLower(source)
		if source == "*" {
			return true
		}
		scheme, rest, ok := strings.Cut(source, ":")
		if !ok || !matches(scheme) {
			continue
		}
		if rest == "" || rest == "//*" || strings.HasPrefix(rest, "//*:") || strings.HasPrefix(rest, "//*/") {
			return true
		}
	}
	return false
}
