package app

import (
	"context"
	"encoding/hex"
	"mime"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

func TestImmutableContentHeadersRequireRevalidation(t *testing.T) {
	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	app := &App{}
	app.writeImmutableObjectContentHeaders(context, immutableObjectContent{
		filename: "sample.mp4", mediaType: "video/mp4", sha256: strings.Repeat("a", 64), sizeBytes: 42,
	})
	if got := response.Header().Get("Cache-Control"); got != "private, no-cache" {
		t.Fatalf("Cache-Control=%q", got)
	}
	if got := response.Header().Get("ETag"); got != `"`+strings.Repeat("a", 64)+`"` {
		t.Fatalf("ETag=%q", got)
	}
}

func TestImmutableContentIfNoneMatch(t *testing.T) {
	store, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	object, err := store.Put(context.Background(), strings.NewReader("document bytes"))
	if err != nil {
		t.Fatal(err)
	}
	digest := hex.EncodeToString(object.SHA256[:])
	etag := `"` + digest + `"`
	app := &App{artifacts: store}
	tests := []struct {
		name, ifNoneMatch string
		wantStatus        int
		wantBody          string
	}{
		{name: "exact match", ifNoneMatch: etag, wantStatus: http.StatusNotModified},
		{name: "list match", ifNoneMatch: `"other", ` + etag, wantStatus: http.StatusNotModified},
		{name: "weak match", ifNoneMatch: "W/" + etag, wantStatus: http.StatusNotModified},
		{name: "wildcard", ifNoneMatch: "*", wantStatus: http.StatusNotModified},
		{name: "mismatch", ifNoneMatch: `"other"`, wantStatus: http.StatusOK, wantBody: "document bytes"},
		{name: "absent", wantStatus: http.StatusOK, wantBody: "document bytes"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(response)
			c.Request = httptest.NewRequest(http.MethodGet, "/content", nil)
			if test.ifNoneMatch != "" {
				c.Request.Header.Set("If-None-Match", test.ifNoneMatch)
			}
			app.writeImmutableObjectContent(c, immutableObjectContent{
				filename: "sample.pdf", mediaType: "application/pdf", objectKey: object.Key,
				sha256: digest, sizeBytes: object.Size,
			})
			c.Writer.WriteHeaderNow()
			if response.Code != test.wantStatus || response.Body.String() != test.wantBody {
				t.Fatalf("status=%d body=%q", response.Code, response.Body.String())
			}
			if got := response.Header().Get("ETag"); got != etag {
				t.Fatalf("ETag=%q", got)
			}
			if got := response.Header().Get("Cache-Control"); got != "private, no-cache" {
				t.Fatalf("Cache-Control=%q", got)
			}
			if test.wantStatus == http.StatusNotModified && response.Header().Get("Content-Length") != "" {
				t.Fatalf("Content-Length=%q", response.Header().Get("Content-Length"))
			}
		})
	}
}

func TestNonImmutableContentWritersIgnoreIfNoneMatch(t *testing.T) {
	store, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	object, err := store.Put(context.Background(), strings.NewReader("latest bytes"))
	if err != nil {
		t.Fatal(err)
	}
	app := &App{artifacts: store}
	content := immutableObjectContent{
		filename: "latest.md", mediaType: "text/markdown", objectKey: object.Key,
		sha256: hex.EncodeToString(object.SHA256[:]), sizeBytes: object.Size,
	}
	tests := []struct {
		name, method string
		write        func(*gin.Context)
	}{
		{name: "latest download", method: http.MethodGet, write: func(c *gin.Context) { app.writeLatestObjectContent(c, content) }},
		{name: "shared download", method: http.MethodPost, write: func(c *gin.Context) { app.writeLatestObjectContent(c, content) }},
		{name: "document preview", method: http.MethodGet, write: func(c *gin.Context) {
			app.writeImmutableObjectContentWithHeaders(c, content, writeDocumentPreviewHeaders)
		}},
		{name: "agent CLI read-only", method: http.MethodGet, write: func(c *gin.Context) {
			app.writeImmutableObjectContentWithHeaders(c, content, func(c *gin.Context, content immutableObjectContent) {
				app.writeLatestObjectContentHeaders(c, content)
				c.Writer.Header().Del("ETag")
			})
		}},
	}
	for _, test := range tests {
		for _, ifNoneMatch := range []string{`"` + content.sha256 + `"`, "*"} {
			t.Run(test.name+" "+ifNoneMatch, func(t *testing.T) {
				response := httptest.NewRecorder()
				c, _ := gin.CreateTestContext(response)
				c.Request = httptest.NewRequest(test.method, "/content", nil)
				c.Request.Header.Set("If-None-Match", ifNoneMatch)
				test.write(c)
				c.Writer.WriteHeaderNow()
				if response.Code != http.StatusOK || response.Body.String() != "latest bytes" {
					t.Fatalf("status=%d body=%q", response.Code, response.Body.String())
				}
			})
		}
	}
}

func TestImmutableContentRoutesRequireSessionBeforeRevalidation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	a := &App{cfg: config.ForTest(func(c *config.Config) {
		c.CookieName = "teamhub_session"
	})}
	engine := gin.New()
	engine.Use(gin.Recovery())
	engine.Use(func(c *gin.Context) { c.Set("request_id", "request_test") })
	a.registerContractRoutes(engine)
	for _, path := range []string{
		"/v0/document-versions/version_existing/content",
	} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.Header.Set("If-None-Match", `"`+strings.Repeat("a", 64)+`"`)
		response := httptest.NewRecorder()
		engine.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("GET %s status=%d body=%s", path, response.Code, response.Body)
		}
	}
}

func TestLatestContentHeadersDisableBrowserReuse(t *testing.T) {
	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	app := &App{}
	app.writeLatestObjectContentHeaders(context, immutableObjectContent{
		filename: "latest.pdf", mediaType: "application/pdf", sha256: strings.Repeat("b", 64), sizeBytes: 42,
	})
	if got := response.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control=%q", got)
	}
	if got := response.Header().Get("ETag"); got != `"`+strings.Repeat("b", 64)+`"` {
		t.Fatalf("ETag=%q", got)
	}
	if got := response.Header().Get("X-Content-SHA256"); got != strings.Repeat("b", 64) {
		t.Fatalf("X-Content-SHA256=%q", got)
	}
}

func TestLatestContentCacheHeadersApplyToUnavailableResponses(t *testing.T) {
	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	writeLatestContentCacheHeaders(context)
	context.Status(503)
	if got := response.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control=%q", got)
	}
}

func TestParseArtifactByteRange(t *testing.T) {
	tests := []struct {
		name   string
		header string
		size   int64
		want   artifactByteRange
		valid  bool
	}{
		{name: "bounded", header: "bytes=2-8", size: 20, want: artifactByteRange{start: 2, end: 8}, valid: true},
		{name: "open ended", header: "bytes=7-", size: 20, want: artifactByteRange{start: 7, end: 19}, valid: true},
		{name: "suffix", header: "bytes=-4", size: 20, want: artifactByteRange{start: 16, end: 19}, valid: true},
		{name: "clamps end", header: "bytes=18-30", size: 20, want: artifactByteRange{start: 18, end: 19}, valid: true},
		{name: "suffix larger than file", header: "bytes=-30", size: 20, want: artifactByteRange{start: 0, end: 19}, valid: true},
		{name: "multiple unsupported", header: "bytes=0-1,4-5", size: 20},
		{name: "past end", header: "bytes=20-21", size: 20},
		{name: "reverse", header: "bytes=8-2", size: 20},
		{name: "zero suffix", header: "bytes=-0", size: 20},
		{name: "empty file", header: "bytes=0-", size: 0},
		{name: "wrong unit", header: "items=0-1", size: 20},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := parseArtifactByteRange(test.header, test.size)
			if (err == nil) != test.valid {
				t.Fatalf("parseArtifactByteRange(%q, %d) err=%v", test.header, test.size, err)
			}
			if test.valid && !reflect.DeepEqual(got, test.want) {
				t.Fatalf("parseArtifactByteRange(%q, %d)=%+v want=%+v", test.header, test.size, got, test.want)
			}
		})
	}
}

func TestImmutableContentDisposition(t *testing.T) {
	tests := []struct {
		name      string
		filename  string
		mediaType string
		want      string
	}{
		{name: "video", filename: "demo.mp4", mediaType: "video/mp4", want: "inline"},
		{name: "audio with parameter", filename: "voice.mp3", mediaType: "audio/mpeg; charset=binary", want: "inline"},
		{name: "html active content", filename: "page.html", mediaType: "text/html", want: "attachment"},
		{name: "svg active content", filename: "diagram.svg", mediaType: "image/svg+xml", want: "attachment"},
		{name: "conflicting media type", filename: "page.html", mediaType: "video/mp4", want: "attachment"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := immutableContentDisposition(immutableContentMetadata{Filename: test.filename, MediaType: test.mediaType})
			if !strings.HasPrefix(got, test.want+";") {
				t.Fatalf("immutableContentDisposition(%q, %q)=%q want %q", test.filename, test.mediaType, got, test.want)
			}
		})
	}
}

func TestImmutableContentDispositionSupportsASCIIAndUTF8RFC5987(t *testing.T) {
	tests := []struct {
		name             string
		filename         string
		wantSubstring    string
		wantRFC5987      bool
		wantASCIIPart    string
		wantParsedResult string
	}{
		{
			name:             "ascii markdown title",
			filename:         "WIN015-DOC-TITLE.md",
			wantSubstring:    "WIN015-DOC-TITLE.md",
			wantRFC5987:      false,
			wantParsedResult: "WIN015-DOC-TITLE.md",
		},
		{
			name:             "pure utf8 cjk title",
			filename:         "\u4e2d\u6587\u6587\u6863.md",
			wantSubstring:    "filename*=utf-8''%E4%B8%AD%E6%96%87%E6%96%87%E6%A1%A3.md",
			wantRFC5987:      true,
			wantASCIIPart:    `filename="document.md"`,
			wantParsedResult: "\u4e2d\u6587\u6587\u6863.md",
		},
		{
			name:             "mixed ascii and utf8 cjk title",
			filename:         "WIN015 \u4e2d\u6587.md",
			wantSubstring:    "filename*=utf-8''WIN015%20%E4%B8%AD%E6%96%87.md",
			wantRFC5987:      true,
			wantASCIIPart:    `filename="WIN015.md"`,
			wantParsedResult: "WIN015 \u4e2d\u6587.md",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := immutableContentDisposition(immutableContentMetadata{
				Filename:  tc.filename,
				MediaType: "text/markdown",
			})
			if !strings.HasPrefix(got, "attachment;") {
				t.Fatalf("disposition=%q want attachment prefix", got)
			}
			if !strings.Contains(got, tc.wantSubstring) {
				t.Fatalf("disposition=%q missing %q", got, tc.wantSubstring)
			}
			if tc.wantRFC5987 && !strings.Contains(got, tc.wantASCIIPart) {
				t.Fatalf("disposition=%q missing ASCII fallback %q", got, tc.wantASCIIPart)
			}
			mediaType, params, err := mime.ParseMediaType(got)
			if err != nil {
				t.Fatalf("mime.ParseMediaType(%q): %v", got, err)
			}
			if mediaType != "attachment" || params["filename"] != tc.wantParsedResult {
				t.Fatalf("parsed=(%q, %v) want filename=%q", mediaType, params, tc.wantParsedResult)
			}
		})
	}
}

func TestImmutableContentDispositionAdversarialFilenames(t *testing.T) {
	tests := []struct {
		name             string
		filename         string
		wantASCIIPart    string
		wantRFC5987Part  string
		wantParsedResult string
	}{
		{
			name:             "ascii crlf uses rfc5987 without raw line breaks",
			filename:         "report\r\nX-Injected: 1.md",
			wantASCIIPart:    `filename="reportX-Injected: 1.md"`,
			wantRFC5987Part:  "filename*=utf-8''report%0D%0AX-Injected%3A%201.md",
			wantParsedResult: "report\r\nX-Injected: 1.md",
		},
		{
			name:             "utf8 crlf uses rfc5987 without raw line breaks",
			filename:         "\u4e2d\r\n\u6587.md",
			wantASCIIPart:    `filename="document.md"`,
			wantRFC5987Part:  "filename*=utf-8''%E4%B8%AD%0D%0A%E6%96%87.md",
			wantParsedResult: "\u4e2d\r\n\u6587.md",
		},
		{
			name:             "ascii quotes semicolons and backslashes",
			filename:         `report "Q1"; file.a\b`,
			wantParsedResult: `report "Q1"; file.a\b`,
		},
		{
			name:             "utf8 quotes semicolons and backslashes",
			filename:         "\u4e2d\"q\";s\\b.md",
			wantASCIIPart:    `filename="q s b.md"`,
			wantRFC5987Part:  "filename*=utf-8''%E4%B8%AD%22q%22%3Bs%5Cb.md",
			wantParsedResult: "\u4e2d\"q\";s\\b.md",
		},
		{
			name:             "utf8 backslash in extension strips unsafe extension from fallback",
			filename:         "\u4e2d.a\\b",
			wantASCIIPart:    `filename="a b"`,
			wantRFC5987Part:  "filename*=utf-8''%E4%B8%AD.a%5Cb",
			wantParsedResult: "\u4e2d.a\\b",
		},
		{
			name:             "non-ascii trailing dot never produces document dot fallback",
			filename:         "\u4e2d\u6587.",
			wantASCIIPart:    `filename="document"`,
			wantRFC5987Part:  "filename*=utf-8''%E4%B8%AD%E6%96%87.",
			wantParsedResult: "\u4e2d\u6587.",
		},
		{
			name:             "mixed ascii and non-ascii trailing dot trims trailing dot",
			filename:         "foo\u4e2d.",
			wantASCIIPart:    `filename="foo"`,
			wantRFC5987Part:  "filename*=utf-8''foo%E4%B8%AD.",
			wantParsedResult: "foo\u4e2d.",
		},
		{
			name:             "non-ascii double dot falls back to document",
			filename:         "\u4e2d..",
			wantASCIIPart:    `filename="document"`,
			wantRFC5987Part:  "filename*=utf-8''%E4%B8%AD..",
			wantParsedResult: "\u4e2d..",
		},
		{
			name:             "ascii trailing dot and dot names",
			filename:         "foo.",
			wantParsedResult: "foo.",
		},
		{
			name:             "ascii single dot",
			filename:         ".",
			wantParsedResult: ".",
		},
		{
			name:             "ascii double dot",
			filename:         "..",
			wantParsedResult: "..",
		},
		{
			name:             "utf8 with percent sign percent-encodes percent",
			filename:         "100% \u4e2d\u6587.md",
			wantASCIIPart:    `filename="100%.md"`,
			wantRFC5987Part:  "filename*=utf-8''100%25%20%E4%B8%AD%E6%96%87.md",
			wantParsedResult: "100% \u4e2d\u6587.md",
		},
		{
			name:             "ascii with percent sign",
			filename:         "100% report.md",
			wantParsedResult: "100% report.md",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := immutableContentDisposition(immutableContentMetadata{
				Filename:  tc.filename,
				MediaType: "text/markdown",
			})
			if strings.ContainsAny(got, "\r\n") {
				t.Fatalf("disposition=%q must not contain raw CR or LF", got)
			}
			if tc.wantASCIIPart != "" && !strings.Contains(got, tc.wantASCIIPart) {
				t.Fatalf("disposition=%q missing ASCII fallback %q", got, tc.wantASCIIPart)
			}
			if tc.wantRFC5987Part != "" && !strings.Contains(got, tc.wantRFC5987Part) {
				t.Fatalf("disposition=%q missing RFC 5987 part %q", got, tc.wantRFC5987Part)
			}
			mediaType, params, err := mime.ParseMediaType(got)
			if err != nil {
				t.Fatalf("mime.ParseMediaType(%q): %v", got, err)
			}
			if mediaType != "attachment" || params["filename"] != tc.wantParsedResult {
				t.Fatalf("parsed=(%q, %v) want filename=%q", mediaType, params, tc.wantParsedResult)
			}
		})
	}
}

func TestASCIIDispositionFallbackEdgeCases(t *testing.T) {
	tests := []struct {
		filename string
		want     string
	}{
		{filename: "\u4e2d\u6587.", want: "document"},
		{filename: "foo.", want: "foo"},
		{filename: ".", want: "document"},
		{filename: "..", want: "document"},
		{filename: `file.a\b`, want: "file.a b"},
		{filename: "\u4e2d.a\\b", want: "a b"},
	}
	for _, tc := range tests {
		if got := asciiDispositionFallback(tc.filename); got != tc.want {
			t.Fatalf("asciiDispositionFallback(%q)=%q want %q", tc.filename, got, tc.want)
		}
	}
}
