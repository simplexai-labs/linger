package app

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/klauspost/compress/gzhttp"
)

// compressedContentTypes are the API bodies worth compressing: JSON and the
// Wiki graph's HTML shrink ten times or more, which matters on slow links.
// Event streams, ranged reads and stored files (sendAsStored) go out as they
// are.
var compressedContentTypes = []string{"application/json", "application/problem+json", "text/html"}

// sendAsStored keeps a stored file out of compression whatever its media
// type, such as an uploaded JSON or HTML file: it goes out with its own length
// and ETag, so downloads show progress and validators match its bytes.
func sendAsStored(c *gin.Context) {
	c.Header(gzhttp.HeaderNoCompression, "1")
}

// compressResponses compresses JSON and HTML responses, with zstd or gzip as
// the client accepts.
func compressResponses(handler http.Handler) http.Handler {
	wrap, err := gzhttp.NewWrapper(gzhttp.ContentTypes(compressedContentTypes))
	if err != nil {
		panic(err)
	}
	return wrap(handler)
}
