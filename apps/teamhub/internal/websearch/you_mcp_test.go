package websearch

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestKeylessMCPIncludesProtocolVersionWithoutSession(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests.Add(1)
		var message struct {
			Method string `json:"method"`
		}
		if err := json.NewDecoder(request.Body).Decode(&message); err != nil {
			t.Error(err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		if request.Header.Get("Mcp-Session-Id") != "" {
			t.Error("stateless server received an invented session ID")
		}
		if message.Method != "initialize" && request.Header.Get("MCP-Protocol-Version") != mcpProtocolVersion {
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		switch message.Method {
		case "initialize":
			writeJSON(writer, http.StatusOK, `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{}}}`)
		case "notifications/initialized":
			writer.WriteHeader(http.StatusAccepted)
		case "tools/call":
			writeJSON(writer, http.StatusOK, `{"jsonrpc":"2.0","id":2,"result":{"structuredContent":{"results":{"web":[{"title":"Result","url":"https://result.example","description":"stateless"}]}}}}`)
		default:
			t.Errorf("unexpected method %q", message.Method)
			writer.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()
	provider := newProviders(Endpoints{YouMCP: server.URL, Client: server.Client()})
	outcome, err := provider.runKeyless(t.Context(), search("query"))
	if err != nil || len(outcome.Results) != 1 || outcome.Results[0].Snippet != "stateless" {
		t.Fatalf("stateless search = %+v, %v", outcome, err)
	}
	if count := requests.Load(); count != 3 {
		t.Fatalf("stateless requests = %d, want 3", count)
	}
}

func TestMCPStopsReadingAfterMatchingStreamReply(t *testing.T) {
	for _, test := range []struct {
		name    string
		stream  string
		want    string
		wantErr bool
	}{
		{
			name: "result after notifications and unrelated reply",
			stream: ": keepalive\n\n" +
				"data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\"}\n\n" +
				"data: {\"jsonrpc\":\"2.0\",\"id\":99,\"result\":{}}\n\n" +
				"data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"ok\":true}}\n\n",
			want: `{"ok":true}`,
		},
		{
			name: "multiline result with CRLF",
			stream: "event: message\r\ndata: {\"jsonrpc\":\"2.0\",\r\n" +
				"data: \"id\":2,\"result\":{\"ok\":true}}\r\n\r\n",
			want: `{"ok":true}`,
		},
		{
			name:    "RPC error",
			stream:  "data: {\"jsonrpc\":\"2.0\",\"id\":2,\"error\":{\"code\":-32603}}\n\n",
			wantErr: true,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			body := &mcpReplyBody{reader: strings.NewReader(test.stream)}
			provider := newProviders(Endpoints{YouMCP: "http://mcp.example", Client: &http.Client{Transport: mcpRoundTripper(func(request *http.Request) (*http.Response, error) {
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     http.Header{"Content-Type": {"text/event-stream; charset=utf-8"}},
					Body:       body,
					Request:    request,
				}, nil
			})}})
			result, err := provider.mcpCall(t.Context(), "session-1", 2, "tools/call", map[string]any{})
			if (err != nil) != test.wantErr || string(result) != test.want {
				t.Fatalf("reply = %s, %v; want %s, error=%v", result, err, test.want, test.wantErr)
			}
			if body.readPastReply {
				t.Error("read from the connection after receiving the complete matching reply")
			}
			if !body.closed {
				t.Error("reply body was not closed")
			}
		})
	}
}

type mcpReplyBody struct {
	reader        *strings.Reader
	readPastReply bool
	closed        bool
}

func (body *mcpReplyBody) Read(buffer []byte) (int, error) {
	if body.reader.Len() == 0 {
		body.readPastReply = true
		return 0, io.ErrUnexpectedEOF
	}
	return body.reader.Read(buffer)
}

func (body *mcpReplyBody) Close() error {
	body.closed = true
	return nil
}

type mcpRoundTripper func(*http.Request) (*http.Response, error)

func (transport mcpRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}
