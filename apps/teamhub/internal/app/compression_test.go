package app

import (
	"bufio"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestCompressResponsesCompressesLargeJSONOnly(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	large := strings.Repeat(`{"skill_bindings":"same text again and again"},`, 200)
	engine.GET("/large", func(c *gin.Context) { c.Data(http.StatusOK, "application/json; charset=utf-8", []byte(large)) })
	engine.GET("/small", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	engine.GET("/file", func(c *gin.Context) {
		c.Header("Content-Range", "bytes 0-9999/20000")
		c.Data(http.StatusPartialContent, "application/json", []byte(large))
	})
	engine.GET("/pdf", func(c *gin.Context) { c.Data(http.StatusOK, "application/pdf", []byte(large)) })
	handler := compressResponses(engine)
	get := func(path string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.Header.Set("Accept-Encoding", "gzip")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder
	}

	compressed := get("/large")
	if compressed.Header().Get("Content-Encoding") != "gzip" || compressed.Body.Len() >= len(large)/5 {
		t.Fatalf("large JSON: encoding %q, %d bytes of %d", compressed.Header().Get("Content-Encoding"), compressed.Body.Len(), len(large))
	}
	reader, err := gzip.NewReader(compressed.Body)
	if err != nil {
		t.Fatal(err)
	}
	if body, _ := io.ReadAll(reader); string(body) != large {
		t.Fatal("large JSON does not decompress to the original")
	}
	// A browser that offers zstd gets it.
	request := httptest.NewRequest(http.MethodGet, "/large", nil)
	request.Header.Set("Accept-Encoding", "gzip, deflate, br, zstd")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Header().Get("Content-Encoding") != "zstd" {
		t.Fatalf("zstd offered: encoding %q", recorder.Header().Get("Content-Encoding"))
	}
	// A short body, a ranged read and a file keep their bytes as they are.
	for _, path := range []string{"/small", "/file", "/pdf"} {
		if encoding := get(path).Header().Get("Content-Encoding"); encoding != "" {
			t.Fatalf("%s is encoded %q", path, encoding)
		}
	}
	// A client that does not ask for it gets the plain body.
	request = httptest.NewRequest(http.MethodGet, "/large", nil)
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Header().Get("Content-Encoding") != "" || recorder.Body.String() != large {
		t.Fatal("a client without Accept-Encoding got a compressed body")
	}
}

func TestCompressResponsesLeavesEventStreamsFlushing(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	release := make(chan struct{})
	engine.GET("/events", func(c *gin.Context) {
		c.Header("Content-Type", "text/event-stream")
		c.Status(http.StatusOK)
		_, _ = io.WriteString(c.Writer, ": connected\n\n")
		c.Writer.Flush()
		<-release
	})
	server := httptest.NewServer(compressResponses(engine))
	defer server.Close()
	defer close(release)
	request, _ := http.NewRequest(http.MethodGet, server.URL+"/events", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if encoding := response.Header.Get("Content-Encoding"); encoding != "" {
		t.Fatalf("event stream is encoded %q", encoding)
	}
	// The first event arrives while the stream is still open.
	line := make(chan string, 1)
	go func() {
		text, _ := bufio.NewReader(response.Body).ReadString('\n')
		line <- text
	}()
	select {
	case text := <-line:
		if text != ": connected\n" {
			t.Fatalf("first line %q", text)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the event stream was held back")
	}
}
