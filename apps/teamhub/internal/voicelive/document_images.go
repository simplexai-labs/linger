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
func InlineImages(markdown string, uris map[string]string) string {
	pairs := make([]string, 0, 2*len(uris))
	for destination, uri := range uris {
		pairs = append(pairs, "]("+destination, "]("+uri)
	}
	return strings.NewReplacer(pairs...).Replace(markdown)
}
