package websearch

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"iter"
	"net/http"
	"slices"
	"strings"
)

// mcpProtocolVersion is the MCP revision TeamHub speaks to You.com's keyless
// server.
const mcpProtocolVersion = "2025-06-18"

// runKeyless runs a request on You.com's free MCP server, which needs no key.
// Its searches are a limited trial: HTTP 429 means the free allowance is used
// up. TeamHub keeps no count of its own.
func (p *providers) runKeyless(ctx context.Context, request Request) (Outcome, error) {
	if !supports(You, request) {
		return Outcome{}, &Failure{Code: CodeUnsupported, Backend: You}
	}
	timeout := searchTimeout
	if request.Command == CommandOpen {
		timeout = openTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	session, err := p.mcpInitialize(ctx)
	if err != nil {
		return Outcome{}, err
	}
	tool, arguments := "you-search", youSearchBody(request)
	if request.Command == CommandOpen {
		tool, arguments = "you-extract", map[string]any{"url": request.URL}
	}
	result, err := p.mcpCall(ctx, session, 2, "tools/call", map[string]any{"name": tool, "arguments": arguments})
	if err != nil {
		return Outcome{}, err
	}
	var called struct {
		IsError           bool            `json:"isError"`
		StructuredContent json.RawMessage `json:"structuredContent"`
		Content           []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if json.Unmarshal(result, &called) != nil {
		return Outcome{}, &Failure{Code: CodeProviderUnavailable, Backend: You}
	}
	if called.IsError {
		if request.Command == CommandOpen {
			return Outcome{}, &Failure{Code: CodePageUnreadable, Backend: You}
		}
		return Outcome{}, &Failure{Code: CodeProviderUnavailable, Backend: You}
	}
	structured := called.StructuredContent
	if len(structured) == 0 && len(called.Content) > 0 && called.Content[0].Type == "text" {
		structured = json.RawMessage(called.Content[0].Text)
	}
	if request.Command == CommandSearch {
		var decoded youWebResults
		if json.Unmarshal(structured, &decoded) != nil {
			return Outcome{}, &Failure{Code: CodeProviderUnavailable, Backend: You}
		}
		return decoded.outcome(request.Limit), nil
	}
	page, ok := keylessPage(structured)
	if !ok {
		return Outcome{}, &Failure{Code: CodePageUnreadable, Backend: You}
	}
	outcome, err := pageOutcome(request.URL, page.URL, page.Title, page.markdown())
	if failure := (*Failure)(nil); errors.As(err, &failure) {
		failure.Backend = You
	}
	return outcome, err
}

// keylessPage reads the extract tool's output: the page itself, a list of
// pages, or the Markdown alone.
func keylessPage(structured json.RawMessage) (youPage, bool) {
	var wrapper struct {
		Output json.RawMessage `json:"output"`
	}
	if json.Unmarshal(structured, &wrapper) == nil && len(wrapper.Output) > 0 {
		structured = wrapper.Output
	}
	var text string
	if json.Unmarshal(structured, &text) == nil {
		return youPage{Markdown: text}, text != ""
	}
	var pages []youPage
	if json.Unmarshal(structured, &pages) == nil {
		return firstPage(pages)
	}
	var page youPage
	if json.Unmarshal(structured, &page) == nil {
		return page, page.markdown() != ""
	}
	return youPage{}, false
}

func firstPage(pages []youPage) (youPage, bool) {
	if len(pages) == 0 {
		return youPage{}, false
	}
	return pages[0], pages[0].markdown() != ""
}

// mcpInitialize opens a session; a stateless server returns no session ID.
func (p *providers) mcpInitialize(ctx context.Context) (string, error) {
	session, _, err := p.mcpPost(ctx, "", map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{
			"protocolVersion": mcpProtocolVersion, "capabilities": map[string]any{},
			"clientInfo": map[string]any{"name": "teamhub", "version": "1"},
		},
	}, 1)
	if err != nil {
		return "", err
	}
	if _, _, err := p.mcpPost(ctx, session, map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}, 0); err != nil {
		return "", err
	}
	return session, nil
}

func (p *providers) mcpCall(ctx context.Context, session string, id int, method string, params any) (json.RawMessage, error) {
	_, result, err := p.mcpPost(ctx, session, map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}, id)
	return result, err
}

// mcpPost sends one JSON-RPC message and, for a request (id > 0), returns the
// result whose id matches, from a JSON or an event-stream answer.
func (p *providers) mcpPost(ctx context.Context, session string, message any, id int) (string, json.RawMessage, error) {
	encoded, err := json.Marshal(message)
	if err != nil {
		return "", nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoints.YouMCP, bytes.NewReader(encoded))
	if err != nil {
		return "", nil, &Failure{Code: CodeProviderUnavailable, Backend: You}
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("MCP-Protocol-Version", mcpProtocolVersion)
	if session != "" {
		request.Header.Set("Mcp-Session-Id", session)
	}
	response, err := p.client.Do(request)
	if err != nil {
		return "", nil, &Failure{Code: CodeProviderUnavailable, Backend: You}
	}
	defer response.Body.Close()
	switch {
	case response.StatusCode == http.StatusTooManyRequests:
		return "", nil, &Failure{Code: CodeFreeLimit, Backend: You, RetryAfter: retryAfter(response.Header)}
	case response.StatusCode < 200 || response.StatusCode >= 300:
		return "", nil, &Failure{Code: CodeProviderUnavailable, Backend: You}
	}
	if session == "" {
		session = response.Header.Get("Mcp-Session-Id")
	}
	if id == 0 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBody))
		return session, nil, nil
	}
	body := io.LimitReader(response.Body, maxResponseBody)
	var messages iter.Seq[json.RawMessage]
	if strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		messages = eventStreamData(body)
	} else if read, err := io.ReadAll(body); err == nil {
		messages = slices.Values([]json.RawMessage{read})
	} else {
		return session, nil, &Failure{Code: CodeProviderUnavailable, Backend: You}
	}
	for raw := range messages {
		var reply struct {
			ID     json.RawMessage `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if json.Unmarshal(raw, &reply) != nil || string(reply.ID) != jsonNumber(id) {
			continue
		}
		if len(reply.Error) > 0 || len(reply.Result) == 0 {
			return session, nil, &Failure{Code: CodeProviderUnavailable, Backend: You}
		}
		return session, reply.Result, nil
	}
	return session, nil, &Failure{Code: CodeProviderUnavailable, Backend: You}
}

func jsonNumber(id int) string {
	encoded, _ := json.Marshal(id)
	return string(encoded)
}

// eventStreamData yields complete events so a matching result can end the
// call without waiting for the server to close the response stream.
func eventStreamData(body io.Reader) iter.Seq[json.RawMessage] {
	return func(yield func(json.RawMessage) bool) {
		scanner := bufio.NewScanner(body)
		scanner.Buffer(make([]byte, 64<<10), maxResponseBody)
		var data []string
		flush := func() bool {
			if len(data) == 0 {
				return true
			}
			event := json.RawMessage(strings.Join(data, "\n"))
			data = nil
			return yield(event)
		}
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				if !flush() {
					return
				}
				continue
			}
			if value, ok := strings.CutPrefix(line, "data:"); ok {
				data = append(data, strings.TrimPrefix(value, " "))
			}
		}
		flush()
	}
}
