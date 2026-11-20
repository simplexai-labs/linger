package document

import "testing"

func TestStripLeadingTitle(t *testing.T) {
	for _, tc := range []struct{ name, in, want string }{
		{"atx", "# Launch plan\n\n## Goals\n\nShip it.\n", "## Goals\n\nShip it.\n"},
		{"atx reworded", "# Launch plan (draft)\nBody\n", "Body\n"},
		{"atx closing hashes", "  # Launch plan ##\n\nBody", "Body"},
		{"setext", "Launch plan\n===\n\nBody\n", "Body\n"},
		{"leading blank lines", "\n\n# Launch plan\n\nBody\n", "Body\n"},
		{"crlf", "# Launch plan\r\n\r\nBody\r\n", "Body\r\n"},
		{"only the heading", "# Launch plan\n", ""},
		{"starts with level two", "## Goals\n\nBody\n", "## Goals\n\nBody\n"},
		{"starts with text", "Intro\n\n# Later heading\n", "Intro\n\n# Later heading\n"},
		{"heading inside code", "```\n# not a heading\n```\n", "```\n# not a heading\n```\n"},
		{"empty heading", "#\n\nBody\n", "#\n\nBody\n"},
		{"empty body", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := stripLeadingTitle(tc.in); got != tc.want {
				t.Fatalf("stripLeadingTitle(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
