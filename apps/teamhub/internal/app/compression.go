package app

import (
	"net/http"

	"github.com/klauspost/compress/gzhttp"
)

// compressedContentTypes are the API bodies worth compressing: JSON and the
// Wiki graph's HTML shrink ten times or more, which matters on slow links.
// Event streams, files and ranged reads go out as they are.
var compressedContentTypes = []string{"application/json", "application/problem+json", "text/html"}

// compressResponses compresses JSON and HTML responses, with zstd or gzip as
// the client accepts.
func compressResponses(handler http.Handler) http.Handler {
	wrap, err := gzhttp.NewWrapper(gzhttp.ContentTypes(compressedContentTypes))
	if err != nil {
		panic(err)
	}
	return wrap(handler)
}
