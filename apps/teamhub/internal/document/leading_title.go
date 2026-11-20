package document

import (
	"bytes"
	"regexp"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

// setextH1Underline is the line under a setext level-one heading.
var setextH1Underline = regexp.MustCompile(`^ {0,3}=+[ \t]*$`)

// stripLeadingTitle removes a level-one heading that opens an Agent's
// Markdown body. The Document's title is its page heading, so a body that
// repeats it as its first block would show the title twice. Only that
// structural position counts; the heading's text is never compared with the
// title, because an Agent often rewords it.
func stripLeadingTitle(source string) string {
	raw := []byte(source)
	root := markdown.Parser().Parse(text.NewReader(raw))
	heading, ok := root.FirstChild().(*ast.Heading)
	if !ok || heading.Level != 1 || heading.Lines().Len() == 0 {
		return source
	}
	end := lineEnd(raw, heading.Lines().At(heading.Lines().Len()-1).Stop)
	if next := lineEnd(raw, end); next > end && setextH1Underline.Match(bytes.TrimRight(raw[end:next], "\r\n")) {
		end = next
	}
	return string(bytes.TrimLeft(raw[end:], " \t\r\n"))
}

// lineEnd returns the offset just past the line holding offset.
func lineEnd(source []byte, offset int) int {
	if offset >= len(source) {
		return len(source)
	}
	if i := bytes.IndexByte(source[offset:], '\n'); i >= 0 {
		return offset + i + 1
	}
	return len(source)
}
