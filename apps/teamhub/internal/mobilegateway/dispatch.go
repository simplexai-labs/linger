package mobilegateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

type requestHead struct {
	Method  string              `json:"method"`
	Path    string              `json:"path"`
	Headers map[string][]string `json:"headers"`
}

type responseHead struct {
	Status  int                 `json:"status"`
	Headers map[string][]string `json:"headers"`
}

type resetPayload struct {
	Code string `json:"code"`
}

// strippedRequestHeaders never reach TeamHub from a phone: identity comes only
// from the session, and hop-by-hop headers describe a socket that does not
// exist here.
var strippedRequestHeaders = []string{
	"Authorization", "Cookie", "Origin", "Referer", "Host", "Connection",
	// The phone reads bodies as sent; TeamHub compresses only when asked.
	"Accept-Encoding",
	"Upgrade", "Te", "Trailer", "Transfer-Encoding", "Keep-Alive",
	"Proxy-Authorization", "Proxy-Connection", "X-Forwarded-For",
	"X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-Ip", "Forwarded",
}

func (s *session) dispatchRequest(st *stream, raw []byte) {
	defer st.finish()
	var head requestHead
	if err := json.Unmarshal(raw, &head); err != nil || head.Method == "" || !strings.HasPrefix(head.Path, "/") {
		_ = s.emitJSON(st.ctx, frameReset, st.id, resetPayload{Code: "BAD_REQUEST"})
		return
	}
	target, err := url.ParseRequestURI(head.Path)
	if err != nil || target.Host != "" {
		_ = s.emitJSON(st.ctx, frameReset, st.id, resetPayload{Code: "BAD_REQUEST"})
		return
	}
	method := strings.ToUpper(head.Method)
	writer := &responseWriter{session: s, stream: st, header: http.Header{}}
	if !allowed(method, target.Path) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusNotFound)
		_, _ = writer.Write([]byte(`{"error":{"code":"NOT_AVAILABLE_ON_MOBILE","message":"This operation is not available from a phone.","request_id":""}}`))
		writer.end()
		return
	}
	phone := s.currentPhone()
	request, err := http.NewRequestWithContext(
		WithPhoneSession(st.ctx, phone.SessionDigest),
		method, "http://mobile.invalid"+target.RequestURI(), &bodyReader{stream: st},
	)
	if err != nil {
		_ = s.emitJSON(st.ctx, frameReset, st.id, resetPayload{Code: "BAD_REQUEST"})
		return
	}
	for name, values := range head.Headers {
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	for _, name := range strippedRequestHeaders {
		request.Header.Del(name)
	}
	request.RemoteAddr = "phone:" + phone.ID
	if length := request.Header.Get("Content-Length"); length == "" {
		request.ContentLength = -1
	}
	s.gateway.handler.ServeHTTP(writer, request)
	writer.end()
}

// responseWriter streams a TeamHub response back as frames as it is written,
// so Server-Sent Events and large downloads never buffer whole.
type responseWriter struct {
	session *session
	stream  *stream
	header  http.Header

	mu          sync.Mutex
	wroteHeader bool
	failed      error
	closeNotify chan bool
}

func (w *responseWriter) Header() http.Header { return w.header }

func (w *responseWriter) WriteHeader(status int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.writeHeaderLocked(status)
}

func (w *responseWriter) writeHeaderLocked(status int) {
	if w.wroteHeader || w.failed != nil {
		return
	}
	w.wroteHeader = true
	headers := map[string][]string{}
	for name, values := range w.header {
		headers[name] = append([]string(nil), values...)
	}
	if err := w.session.emitJSON(w.stream.ctx, frameResponse, w.stream.id, responseHead{Status: status, Headers: headers}); err != nil {
		w.failed = err
	}
}

func (w *responseWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.writeHeaderLocked(http.StatusOK)
	if w.failed != nil {
		return 0, w.failed
	}
	written := 0
	for len(p) > 0 {
		chunk := p
		if len(chunk) > dataChunk {
			chunk = chunk[:dataChunk]
		}
		if err := w.session.emit(w.stream.ctx, frameData, w.stream.id, chunk); err != nil {
			w.failed = err
			return written, err
		}
		written += len(chunk)
		p = p[len(chunk):]
	}
	return written, nil
}

// Flush is a no-op: every Write already left as a frame.
func (w *responseWriter) Flush() {}

// CloseNotify reports a stream the phone abandoned; gin's responseWriter
// forwards CloseNotify to the writer it wraps.
func (w *responseWriter) CloseNotify() <-chan bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closeNotify == nil {
		w.closeNotify = make(chan bool, 1)
		go func(ctx context.Context, notify chan bool) {
			<-ctx.Done()
			notify <- true
		}(w.stream.ctx, w.closeNotify)
	}
	return w.closeNotify
}

func (w *responseWriter) end() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.writeHeaderLocked(http.StatusOK)
	if w.failed != nil {
		if !errors.Is(w.failed, context.Canceled) {
			_ = w.session.emitJSON(w.session.ctx, frameReset, w.stream.id, resetPayload{Code: "ABORTED"})
		}
		return
	}
	_ = w.session.emit(w.stream.ctx, frameEnd, w.stream.id, nil)
}
