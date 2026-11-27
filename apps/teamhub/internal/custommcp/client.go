// Package custommcp connects to user-configured public MCP servers.
package custommcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"syscall"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/publicnet"
)

const (
	requestTimeout = 15 * time.Second
	toolTimeout    = 55 * time.Second
	maxResponse    = 1 << 20
	maxTools       = 200
	protocol       = "2025-11-25"
)

var (
	// ErrInvalid identifies a configuration that cannot be used.
	ErrInvalid = errors.New("invalid public MCP endpoint or credentials")
	// ErrUnauthorized identifies rejected credentials.
	ErrUnauthorized = errors.New("the MCP server rejected authentication")
	// ErrUnavailable identifies an unreachable or incompatible MCP server.
	ErrUnavailable = errors.New("the MCP server is unavailable or returned an invalid response")
	// ErrNotDispatched means the session failed before tools/call was sent.
	ErrNotDispatched = errors.New("the MCP tool call was not dispatched")
)

// Tool is the remote name, description and input schema discovered from MCP.
type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

// Client opens short-lived Streamable HTTP sessions against public endpoints.
type Client struct {
	http *http.Client
}

// NewClient validates the actual dial destination and does not follow redirects.
func NewClient() *Client {
	dialer := &net.Dialer{
		Timeout: 5 * time.Second,
		Control: func(_, address string, _ syscall.RawConn) error {
			target, err := netip.ParseAddrPort(address)
			if err != nil || !publicnet.IsPublic(target.Addr()) {
				return ErrInvalid
			}
			return nil
		},
	}
	return &Client{http: &http.Client{
		Transport: &http.Transport{
			DialContext:            dialer.DialContext,
			ForceAttemptHTTP2:      true,
			TLSHandshakeTimeout:    5 * time.Second,
			MaxResponseHeaderBytes: 64 << 10,
			MaxIdleConns:           16,
			IdleConnTimeout:        30 * time.Second,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

// Discover returns the tools a server exposes without invoking them.
func (c *Client) Discover(ctx context.Context, endpoint, token string) ([]Tool, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	session, err := c.open(ctx, endpoint, token)
	if err != nil {
		return nil, err
	}
	defer session.close(ctx)
	tools := make([]Tool, 0)
	seen := make(map[string]bool)
	cursor := ""
	for id := 2; id <= 21; id++ {
		params := map[string]string{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		var page struct {
			Tools      []Tool `json:"tools"`
			NextCursor string `json:"nextCursor"`
		}
		if err := session.post(ctx, id, "tools/list", params, &page); err != nil {
			return nil, err
		}
		if page.Tools == nil || len(tools)+len(page.Tools) > maxTools {
			return nil, ErrUnavailable
		}
		for _, tool := range page.Tools {
			var schema struct{ Type string }
			if tool.Name == "" || len(tool.Name) > 128 || strings.ContainsAny(tool.Name, "\x00\r\n") ||
				len(tool.Description) > 8192 || len(tool.InputSchema) > 32<<10 ||
				json.Unmarshal(tool.InputSchema, &schema) != nil || schema.Type != "object" || seen[tool.Name] ||
				containsToken(tool.Name, token) || containsToken(tool.Description, token) || replyContainsToken(tool.InputSchema, token) {
				return nil, ErrUnavailable
			}
			seen[tool.Name] = true
			tools = append(tools, tool)
		}
		if page.NextCursor == "" {
			return tools, nil
		}
		if page.NextCursor == cursor || len(page.NextCursor) > 4096 {
			return nil, ErrUnavailable
		}
		cursor = page.NextCursor
	}
	return nil, ErrUnavailable
}

// Call invokes one tool without retrying an operation that may have run.
func (c *Client) Call(ctx context.Context, endpoint, token, name string, arguments map[string]any) (json.RawMessage, error) {
	handshake, cancelHandshake := context.WithTimeout(ctx, requestTimeout)
	session, err := c.open(handshake, endpoint, token)
	cancelHandshake()
	if err != nil {
		return nil, errors.Join(ErrNotDispatched, err)
	}
	defer session.close(ctx)
	call, cancelCall := context.WithTimeout(ctx, toolTimeout)
	defer cancelCall()
	if err := call.Err(); err != nil {
		return nil, errors.Join(ErrNotDispatched, err)
	}
	var result json.RawMessage
	err = session.post(call, 2, "tools/call", map[string]any{"name": name, "arguments": arguments}, &result)
	if err == nil && replyContainsToken(result, token) {
		return nil, ErrUnavailable
	}
	return result, err
}

func containsToken(value, token string) bool {
	return token != "" && strings.Contains(value, token)
}

func replyContainsToken(payload json.RawMessage, token string) bool {
	if token == "" {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	for {
		value, err := decoder.Token()
		if err != nil {
			return false
		}
		if value, ok := value.(string); ok && containsToken(value, token) {
			return true
		}
	}
}

type session struct {
	http                *http.Client
	endpoint, token     string
	id, protocolVersion string
}

func (c *Client) open(ctx context.Context, endpoint, token string) (*session, error) {
	target, err := url.Parse(endpoint)
	if err != nil || len(endpoint) > 2048 || target.Hostname() == "" || target.User != nil ||
		target.Fragment != "" || target.RawQuery != "" || target.ForceQuery ||
		(target.Scheme != "https" && (target.Scheme != "http" || token != "")) ||
		len(token) > 8192 || strings.ContainsAny(token, " \r\n\t") {
		return nil, ErrInvalid
	}
	if address, err := netip.ParseAddr(target.Hostname()); err == nil && !publicnet.IsPublic(address) {
		return nil, ErrInvalid
	}
	s := &session{http: c.http, endpoint: target.String(), token: token}
	var initialized struct {
		ProtocolVersion string `json:"protocolVersion"`
		Capabilities    struct {
			Tools json.RawMessage `json:"tools"`
		} `json:"capabilities"`
	}
	err = s.post(ctx, 1, "initialize", map[string]any{
		"protocolVersion": protocol,
		"capabilities":    struct{}{},
		"clientInfo":      map[string]string{"name": "linger", "version": "1"},
	}, &initialized)
	if err != nil {
		return nil, err
	}
	switch initialized.ProtocolVersion {
	case protocol, "2025-06-18", "2025-03-26":
		s.protocolVersion = initialized.ProtocolVersion
	default:
		s.close(ctx)
		return nil, ErrUnavailable
	}
	if len(initialized.Capabilities.Tools) == 0 || bytes.Equal(initialized.Capabilities.Tools, []byte("null")) {
		s.close(ctx)
		return nil, ErrUnavailable
	}
	if err = s.post(ctx, 0, "notifications/initialized", nil, nil); err != nil {
		s.close(ctx)
		return nil, err
	}
	return s, nil
}

func (s *session) request(ctx context.Context, method string, body io.Reader) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, method, s.endpoint, body)
	if err != nil {
		return nil, ErrInvalid
	}
	request.Header.Set("Accept", "application/json, text/event-stream")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if s.token != "" {
		request.Header.Set("Authorization", "Bearer "+s.token)
	}
	if s.id != "" {
		request.Header.Set("MCP-Session-Id", s.id)
	}
	if s.protocolVersion != "" {
		request.Header.Set("MCP-Protocol-Version", s.protocolVersion)
	}
	response, err := s.http.Do(request)
	if err != nil {
		if errors.Is(err, ErrInvalid) {
			return nil, ErrInvalid
		}
		return nil, ErrUnavailable
	}
	return response, nil
}

func (s *session) close(ctx context.Context) {
	if s.id == "" {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	if response, err := s.request(ctx, http.MethodDelete, nil); err == nil {
		response.Body.Close()
	}
}

func (s *session) post(ctx context.Context, id int, method string, params, result any) error {
	payload, err := json.Marshal(struct {
		JSONRPC string `json:"jsonrpc"`
		ID      int    `json:"id,omitempty"`
		Method  string `json:"method"`
		Params  any    `json:"params,omitempty"`
	}{"2.0", id, method, params})
	if err != nil {
		return ErrInvalid
	}
	response, err := s.request(ctx, http.MethodPost, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return ErrUnauthorized
	case http.StatusAccepted:
		if id == 0 {
			return nil
		}
	case http.StatusOK:
		if id != 0 {
			if err := decodeReply(response, id, result); err != nil {
				return err
			}
			if method == "initialize" {
				s.id = response.Header.Get("MCP-Session-Id")
				if len(s.id) > 1024 || strings.ContainsFunc(s.id, func(r rune) bool { return r < 0x21 || r > 0x7e }) {
					return ErrUnavailable
				}
			}
			return nil
		}
	}
	return ErrUnavailable
}

func decodeReply(response *http.Response, id int, result any) error {
	decode := func(raw []byte) (bool, error) {
		var reply struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      int             `json:"id"`
			Result  json.RawMessage `json:"result"`
			Error   json.RawMessage `json:"error"`
		}
		if json.Unmarshal(raw, &reply) != nil || reply.JSONRPC != "2.0" || reply.ID != id {
			return false, nil
		}
		if len(reply.Error) != 0 || len(reply.Result) == 0 || bytes.Equal(reply.Result, []byte("null")) ||
			json.Unmarshal(reply.Result, result) != nil {
			return true, ErrUnavailable
		}
		return true, nil
	}
	body := io.LimitReader(response.Body, maxResponse+1)
	mediaType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	switch mediaType {
	case "application/json":
		raw, err := io.ReadAll(body)
		if err == nil && len(raw) <= maxResponse {
			if matched, err := decode(raw); matched {
				return err
			}
		}
	case "text/event-stream":
		// A server may keep the stream open after the matching reply.
		scanner := bufio.NewScanner(body)
		scanner.Buffer(make([]byte, 4096), maxResponse)
		var event bytes.Buffer
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				if matched, err := decode(event.Bytes()); matched {
					return err
				}
				event.Reset()
			} else if data, ok := strings.CutPrefix(line, "data:"); ok {
				event.WriteString(strings.TrimPrefix(data, " "))
				event.WriteByte('\n')
			}
		}
	}
	return ErrUnavailable
}
