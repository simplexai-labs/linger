package custommcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCallSeparatesHandshakeAndToolDeadlines(t *testing.T) {
	client := NewClient()
	client.http.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		var request struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			return nil, err
		}
		deadline, ok := r.Context().Deadline()
		if !ok {
			t.Fatalf("no deadline for %s", request.Method)
		}
		remaining := time.Until(deadline)
		reply := &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": {"application/json"}},
			Body:       http.NoBody,
		}
		result := `{"protocolVersion":"2025-11-25","capabilities":{"tools":{}}}`
		if request.Method == "tools/call" {
			if remaining <= requestTimeout || remaining > toolTimeout {
				t.Fatalf("tool deadline = %s", remaining)
			}
			result = `{"content":[]}`
		} else {
			if remaining <= 0 || remaining > requestTimeout {
				t.Fatalf("handshake deadline = %s", remaining)
			}
			if request.Method == "notifications/initialized" {
				reply.StatusCode = http.StatusAccepted
				return reply, nil
			}
		}
		reply.Body = io.NopCloser(strings.NewReader(fmt.Sprintf(
			`{"jsonrpc":"2.0","id":%d,"result":%s}`, request.ID, result,
		)))
		return reply, nil
	})
	if _, err := client.Call(t.Context(), "https://example.com/mcp", "", "echo", nil); err != nil {
		t.Fatal(err)
	}
}

func TestCallClassifiesHandshakeFailureBeforeDispatch(t *testing.T) {
	client := NewClient()
	client.http.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusUnauthorized, Body: http.NoBody}, nil
	})
	_, err := client.Call(t.Context(), "https://example.com/mcp", "", "echo", nil)
	if !errors.Is(err, ErrUnauthorized) || !errors.Is(err, ErrNotDispatched) {
		t.Fatalf("expected authentication failure before dispatch, got %v", err)
	}
}

func TestDiscoverAndCallStreamableHTTP(t *testing.T) {
	var mu sync.Mutex
	var methods []string
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Error("missing bearer credentials")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		var request struct {
			ID     int            `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		methods = append(methods, request.Method)
		mu.Unlock()
		if request.Method != "initialize" &&
			(r.Header.Get("MCP-Session-Id") != "fixture-session" || r.Header.Get("MCP-Protocol-Version") != "2025-06-18") {
			t.Error("session headers do not reflect negotiated session")
		}
		w.Header().Set("Content-Type", "application/json")
		result := ""
		switch request.Method {
		case "initialize":
			w.Header().Set("MCP-Session-Id", "fixture-session")
			result = `{"protocolVersion":"2025-06-18","capabilities":{"tools":{}}}`
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
			return
		case "tools/list":
			if request.Params["cursor"] == nil {
				result = `{"tools":[],"nextCursor":"second"}`
			} else {
				if request.Params["cursor"] != "second" {
					t.Error("unexpected cursor")
				}
				result = `{"tools":[{"name":"echo","inputSchema":{"type":"object"}}]}`
			}
		case "tools/call":
			if request.Params["name"] != "echo" || !reflect.DeepEqual(request.Params["arguments"], map[string]any{"text": "hello"}) {
				t.Errorf("unexpected call parameters: %#v", request.Params)
			}
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n")
			fmt.Fprintf(w, "data: {\"jsonrpc\":\"2.0\",\"id\":%d,\ndata: \"result\":{\"content\":[]}}\n\n", request.ID)
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			return
		default:
			t.Errorf("unexpected method %s", request.Method)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%d,"result":%s}`, request.ID, result)
	}))
	defer server.Close()
	// Only the fixture bypasses the production public-address dialer.
	client := &Client{http: server.Client()}
	client.http.Transport.(*http.Transport).DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
	endpoint := strings.Replace(server.URL, "127.0.0.1", "example.com", 1)
	tools, err := client.Discover(t.Context(), endpoint, "test-token")
	if err != nil || len(tools) != 1 || tools[0].Name != "echo" {
		t.Fatalf("discover = %v, %v", tools, err)
	}
	result, err := client.Call(t.Context(), endpoint, "test-token", "echo", map[string]any{"text": "hello"})
	if err != nil || string(result) != `{"content":[]}` {
		t.Fatalf("call = %s, %v", result, err)
	}
	mu.Lock()
	defer mu.Unlock()
	want := []string{"initialize", "notifications/initialized", "tools/list", "tools/list", "initialize", "notifications/initialized", "tools/call"}
	if !reflect.DeepEqual(methods, want) {
		t.Errorf("methods = %v, want %v", methods, want)
	}
}

func TestRejectPrivateEndpointsAndInsecureBearer(t *testing.T) {
	client := NewClient()
	for _, endpoint := range []string{"https://127.0.0.1/mcp", "https://[::ffff:127.0.0.1]/mcp", "https://169.254.169.254/mcp", "http://localhost/mcp"} {
		if _, err := client.Discover(t.Context(), endpoint, ""); !errors.Is(err, ErrInvalid) {
			t.Errorf("discover %s: %v, want invalid", endpoint, err)
		}
	}
	if _, err := client.Discover(t.Context(), "http://example.com/mcp", "test-token"); !errors.Is(err, ErrInvalid) {
		t.Errorf("insecure bearer: %v, want invalid", err)
	}
}

func TestAnonymousDiscoveryDoesNotSendAuthorization(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("anonymous request sent authorization")
		}
		var request struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch request.Method {
		case "initialize":
			fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%d,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}}}}`, request.ID)
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
		case "tools/list":
			if r.Header.Get("MCP-Protocol-Version") != protocol {
				t.Error("stateless requests must carry the negotiated protocol")
			}
			fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%d,"result":{"tools":[]}}`, request.ID)
		default:
			t.Errorf("unexpected method %s", request.Method)
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()
	client := NewClient()
	client.http.Transport.(*http.Transport).DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
	defer client.http.CloseIdleConnections()
	endpoint := strings.Replace(server.URL, "127.0.0.1", "example.com", 1)
	if tools, err := client.Discover(t.Context(), endpoint, ""); err != nil || len(tools) != 0 {
		t.Fatalf("discover = %v, %v", tools, err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestBearerCannotFollowRedirect(t *testing.T) {
	client := NewClient()
	var hosts []string
	client.http.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		hosts = append(hosts, r.URL.Host)
		if r.Header.Get("Authorization") != "Bearer fixture-token" {
			t.Error("the configured endpoint did not receive the expected authorization")
		}
		return &http.Response{
			StatusCode: http.StatusTemporaryRedirect,
			Header:     http.Header{"Location": {"https://other.example.com/mcp"}},
			Body:       http.NoBody,
		}, nil
	})
	if _, err := client.Discover(t.Context(), "https://example.com/mcp", "fixture-token"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("discover after redirect = %v", err)
	}
	if !reflect.DeepEqual(hosts, []string{"example.com"}) {
		t.Fatalf("contacted hosts = %v", hosts)
	}
}

func TestBearerIsNotReturnedFromUpstream(t *testing.T) {
	const token = "fixture-token"
	tests := []struct {
		name     string
		method   string
		status   int
		response string
		wantErr  error
	}{
		{"authentication rejection", "initialize", http.StatusUnauthorized, token, ErrUnauthorized},
		{"tool description", "tools/list", http.StatusOK, `{"tools":[{"name":"echo","description":"fixture-token","inputSchema":{"type":"object"}}]}`, ErrUnavailable},
		{"escaped schema key", "tools/list", http.StatusOK, `{"tools":[{"name":"echo","inputSchema":{"type":"object","properties":{"fixture\u002dtoken":{"type":"string"}}}}]}`, ErrUnavailable},
		{"escaped tool result", "tools/call", http.StatusOK, `{"content":[{"type":"text","text":"fixture\u002dtoken"}]}`, ErrUnavailable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := NewClient()
			client.http.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				var request struct {
					ID     int    `json:"id"`
					Method string `json:"method"`
				}
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					return nil, err
				}
				reply := &http.Response{
					StatusCode: http.StatusOK,
					Header:     http.Header{"Content-Type": {"application/json"}},
					Body:       http.NoBody,
				}
				result := `{"protocolVersion":"2025-11-25","capabilities":{"tools":{}}}`
				switch request.Method {
				case tt.method:
					reply.StatusCode = tt.status
					if tt.status != http.StatusOK {
						reply.Body = io.NopCloser(strings.NewReader(tt.response))
						return reply, nil
					}
					result = tt.response
				case "notifications/initialized":
					reply.StatusCode = http.StatusAccepted
					return reply, nil
				case "initialize":
				default:
					t.Errorf("unexpected method %s", request.Method)
					return nil, ErrUnavailable
				}
				reply.Body = io.NopCloser(strings.NewReader(fmt.Sprintf(
					`{"jsonrpc":"2.0","id":%d,"result":%s}`, request.ID, result,
				)))
				return reply, nil
			})
			const endpoint = "https://example.com/mcp"
			var err error
			if tt.method == "tools/call" {
				var result json.RawMessage
				result, err = client.Call(t.Context(), endpoint, token, "echo", map[string]any{})
				if result != nil {
					t.Error("received an upstream result that contains the bearer")
				}
			} else {
				var tools []Tool
				tools, err = client.Discover(t.Context(), endpoint, token)
				if tools != nil {
					t.Error("received upstream tools after credential rejection or disclosure")
				}
			}
			if !errors.Is(err, tt.wantErr) || strings.Contains(err.Error(), token) {
				t.Fatal("expected a sanitized error")
			}
		})
	}
}
