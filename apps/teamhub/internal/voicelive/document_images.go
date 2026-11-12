package voicelive

import (
	"slices"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	goldmarktext "github.com/yuin/goldmark/text"
)

// PlaygroundImages returns the files under ./playground that Markdown shows
// as images, each once, as written. Other images, such as web links, are
// left to the Document import.
func PlaygroundImages(markdown string) []string {
	source := []byte(markdown)
	root := goldmark.New(goldmark.WithExtensions(extension.GFM)).Parser().Parse(goldmarktext.NewReader(source))
	var found []string
	_ = ast.Walk(root, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		image, ok := node.(*ast.Image)
		if !entering || !ok {
			return ast.WalkContinue, nil
		}
		destination := string(image.Destination)
		parsed, ok := ParsePlaygroundPath(destination)
		if ok && parsed.Folder != "" && parsed.Inside != "" && !slices.Contains(found, destination) {
			found = append(found, destination)
		}
		return ast.WalkContinue, nil
	})
	return found
}

// InlineImages points each image at the data URI given for its destination.
// Text inside code spans and code blocks is left as written.
func InlineImages(markdown string, uris map[string]string) string {
	source := []byte(markdown)
	root := goldmark.New(goldmark.WithExtensions(extension.GFM)).Parser().Parse(goldmarktext.NewReader(source))
	var code [][2]int
	_ = ast.Walk(root, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch node.(type) {
		case *ast.FencedCodeBlock, *ast.CodeBlock:
			lines := node.Lines()
			if lines.Len() > 0 {
				code = append(code, [2]int{lines.At(0).Start, lines.At(lines.Len() - 1).Stop})
			}
			return ast.WalkSkipChildren, nil
		case *ast.CodeSpan:
			for child := node.FirstChild(); child != nil; child = child.NextSibling() {
				if text, ok := child.(*ast.Text); ok {
					code = append(code, [2]int{text.Segment.Start, text.Segment.Stop})
				}
			}
			return ast.WalkSkipChildren, nil
		}
		return ast.WalkContinue, nil
	})
	inCode := func(at int) bool {
		return slices.ContainsFunc(code, func(span [2]int) bool { return at >= span[0] && at < span[1] })
	}
	type edit struct {
		at, end int
		uri     string
	}
	var edits []edit
	for destination, uri := range uris {
		target := "](" + destination
		for from := 0; ; {
			index := strings.Index(markdown[from:], target)
			if index < 0 {
				break
			}
			at := from + index
			end := at + len(target)
			from = end
			// The destination ends here, not inside a longer path.
			if end < len(markdown) && !strings.ContainsRune(") \t\n", rune(markdown[end])) {
				continue
			}
			if !inCode(at) {
				edits = append(edits, edit{at + 2, end, uri})
			}
		}
	}
	slices.SortFunc(edits, func(a, b edit) int { return a.at - b.at })
	var out strings.Builder
	last := 0
	for _, e := range edits {
		out.WriteString(markdown[last:e.at])
		out.WriteString(e.uri)
		last = e.end
	}
	out.WriteString(markdown[last:])
	return out.String()
}
