package native

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"sync"
)

// Antigravity speaks the Agent Client Protocol (ACP): JSON-RPC 2.0, one
// object per line, over the stdio of `agy acp`.
const (
	acpProtocolVersion = 1
	// acpAuthRequired is the error code ACP reserves for a request that needs
	// the client to authenticate first.
	acpAuthRequired = -32000
)

var errACPClosed = errors.New("Antigravity ACP stream closed")

// acpError is a JSON-RPC error object.
type acpError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *acpError) Error() string {
	return fmt.Sprintf("Antigravity ACP error %d: %s", e.Code, e.Message)
}

// acpFrame is the union of the request, response and notification fields.
type acpFrame struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *acpError       `json:"error,omitempty"`
}

// acpConn is one ACP client connection. Responses go to the call that sent
// the request; notifications and agent requests go to handle, in stream
// order, on the reader goroutine.
type acpConn struct {
	writer io.Writer
	handle func(acpFrame)

	writeMu sync.Mutex
	mu      sync.Mutex
	nextID  int64
	pending map[string]chan acpFrame
	closed  chan struct{}
	readErr error
}

func newACPConn(writer io.Writer, handle func(acpFrame)) *acpConn {
	return &acpConn{writer: writer, handle: handle, pending: map[string]chan acpFrame{}, closed: make(chan struct{})}
}

// serve reads frames until the stream ends. It returns after closed is
// closed, so a pending call never waits on a dead stream.
func (c *acpConn) serve(reader io.Reader) {
	defer close(c.closed)
	scanner := newFrameScanner(reader)
	for scanner.Scan() {
		var frame acpFrame
		if json.Unmarshal(scanner.Bytes(), &frame) != nil {
			continue
		}
		if frame.Method == "" && len(frame.ID) > 0 {
			c.mu.Lock()
			pending := c.pending[string(frame.ID)]
			delete(c.pending, string(frame.ID))
			c.mu.Unlock()
			if pending != nil {
				pending <- frame
			}
			continue
		}
		if frame.Method != "" && c.handle != nil {
			c.handle(frame)
		}
	}
	c.readErr = scanner.Err()
}

func (c *acpConn) write(value any) error {
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err := c.writer.Write(encoded.Bytes())
	return err
}

// call sends one request and waits for its response. A JSON-RPC error is
// returned as *acpError.
func (c *acpConn) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	reply, release, err := c.sendRequest(method, params)
	if err != nil {
		return nil, err
	}
	return c.awaitReply(ctx, reply, release)
}

// sendRequest writes one request synchronously and returns its single-reply
// channel plus a cleanup callback to unregister it.
func (c *acpConn) sendRequest(method string, params any) (<-chan acpFrame, func(), error) {
	c.mu.Lock()
	c.nextID++
	id := strconv.FormatInt(c.nextID, 10)
	reply := make(chan acpFrame, 1)
	c.pending[id] = reply
	c.mu.Unlock()
	release := func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}
	if err := c.write(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(id), "method": method, "params": params}); err != nil {
		release()
		return nil, func() {}, err
	}
	return reply, release, nil
}

func (c *acpConn) awaitReply(ctx context.Context, reply <-chan acpFrame, release func()) (json.RawMessage, error) {
	defer release()
	select {
	case frame := <-reply:
		if frame.Error != nil {
			return nil, frame.Error
		}
		return frame.Result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.closed:
		select {
		case frame := <-reply:
			if frame.Error != nil {
				return nil, frame.Error
			}
			return frame.Result, nil
		default:
		}
		return nil, errACPClosed
	}
}

func (c *acpConn) notify(method string, params any) error {
	return c.write(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

// respond answers an agent request.
func (c *acpConn) respond(id json.RawMessage, result any) error {
	return c.write(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func (c *acpConn) respondError(id json.RawMessage, code int, message string) error {
	return c.write(map[string]any{"jsonrpc": "2.0", "id": id, "error": acpError{Code: code, Message: message}})
}

// acpCapabilities records the ACP session methods the server advertises during
// initialize.
type acpCapabilities struct {
	SessionList   bool
	SessionResume bool
}

func (c acpCapabilities) supportsResidency() bool {
	return c.SessionList && c.SessionResume
}

func acpCapabilityPresent(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null")) && !bytes.Equal(trimmed, []byte("false"))
}

// acpInitialize performs the ACP handshake, checks the protocol version, and
// returns the server's advertised session capabilities.
func acpInitialize(ctx context.Context, conn *acpConn) (acpCapabilities, error) {
	raw, err := conn.call(ctx, "initialize", map[string]any{
		"protocolVersion":    acpProtocolVersion,
		"clientCapabilities": map[string]any{"fs": map[string]any{"readTextFile": false, "writeTextFile": false}, "terminal": false},
		"clientInfo":         map[string]any{"name": "linger-computer", "version": "1.0.0"},
	})
	if err != nil {
		return acpCapabilities{}, err
	}
	type sessionCapabilities struct {
		List   json.RawMessage `json:"list"`
		Resume json.RawMessage `json:"resume"`
	}
	var result struct {
		ProtocolVersion   int `json:"protocolVersion"`
		AgentCapabilities *struct {
			SessionCapabilities      *sessionCapabilities `json:"sessionCapabilities"`
			SessionCapabilitiesSnake *sessionCapabilities `json:"session_capabilities"`
		} `json:"agentCapabilities"`
	}
	if json.Unmarshal(raw, &result) != nil || result.ProtocolVersion != acpProtocolVersion {
		return acpCapabilities{}, errors.New("Antigravity ACP protocol version is unsupported")
	}
	var caps acpCapabilities
	if result.AgentCapabilities != nil {
		sc := result.AgentCapabilities.SessionCapabilities
		if sc == nil {
			sc = result.AgentCapabilities.SessionCapabilitiesSnake
		}
		if sc != nil {
			caps.SessionList = acpCapabilityPresent(sc.List)
			caps.SessionResume = acpCapabilityPresent(sc.Resume)
		}
	}
	return caps, nil
}

// antigravityAPIKeyEnv are the variables Antigravity reads a Gemini API key
// from when the Google sign-in is absent.
var antigravityAPIKeyEnv = []string{"GEMINI_API_KEY", "GOOGLE_API_KEY"}

// acpOpenSession runs open; when Antigravity reports that it needs
// authentication and the environment carries a Gemini API key, it selects
// the API-key method once and runs open again. A Google sign-in is used
// as is, so a key in the environment never replaces it.
func acpOpenSession(ctx context.Context, conn *acpConn, env map[string]string, open func() (json.RawMessage, error)) (json.RawMessage, error) {
	raw, err := open()
	if !acpNeedsAuth(err) || !antigravityHasAPIKey(env) {
		return raw, err
	}
	if _, authErr := conn.call(ctx, "authenticate", map[string]any{"methodId": "gemini-api-key"}); authErr != nil {
		return nil, err
	}
	return open()
}

func acpNeedsAuth(err error) bool {
	var rpc *acpError
	return errors.As(err, &rpc) && rpc.Code == acpAuthRequired
}

func antigravityHasAPIKey(env map[string]string) bool {
	for _, key := range antigravityAPIKeyEnv {
		if env[key] != "" {
			return true
		}
	}
	return false
}

// acpSession is the part of a session/new or session/load result the
// adapter reads.
type acpSession struct {
	SessionID string `json:"sessionId"`
	Models    *struct {
		AvailableModels []struct {
			ModelID string `json:"modelId"`
			Name    string `json:"name"`
		} `json:"availableModels"`
		CurrentModelID string `json:"currentModelId"`
	} `json:"models"`
	ConfigOptions []acpConfigOption `json:"configOptions"`
}

type acpConfigOption struct {
	ID           string `json:"id"`
	Category     string `json:"category"`
	CurrentValue string `json:"currentValue"`
	Options      []struct {
		Value string `json:"value"`
		Name  string `json:"name"`
	} `json:"options"`
}

// acpConfigValue returns the CurrentValue of the config option matching id,
// falling back to matching Category == id.
func acpConfigValue(options []acpConfigOption, id string) string {
	for _, option := range options {
		if option.ID == id {
			return option.CurrentValue
		}
	}
	for _, option := range options {
		if option.Category == id {
			return option.CurrentValue
		}
	}
	return ""
}
