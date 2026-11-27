package voicedictation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"sort"
	"strings"
	"syscall"
	"time"
)

// APITimeout bounds one rewrite on a deployment's own API. A hosted model
// answers a short passage in a second or two; the person is waiting.
const APITimeout = 8 * time.Second

// Errors of the API route; the caller maps each to what the person sees.
var (
	// ErrAPIRejected reports that the API refused the key.
	ErrAPIRejected = errors.New("the API refused the key")
	// ErrAPIUnreachable reports that the API did not answer.
	ErrAPIUnreachable = errors.New("the API could not be reached")
	// ErrInvalidAPI reports a base URL or model that cannot be used.
	ErrInvalidAPI = errors.New("the API address or model is invalid")
)

// APIConfig names an OpenAI-compatible chat API: base URL, model and key.
type APIConfig struct {
	BaseURL string
	Model   string
	Key     string
}

// NormalizeAPIBaseURL checks a base URL a person typed and returns it without
// a trailing slash. Only https is accepted, with no credentials, query or
// fragment, and not a literal private address: TeamHub calls it from inside
// the deployment, so it must not become a way to reach the network around it.
// The connection itself refuses private addresses too, which covers a host
// name that resolves to one.
func NormalizeAPIBaseURL(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.Fragment != "" || len(raw) > 300 {
		return "", ErrInvalidAPI
	}
	if address, err := netip.ParseAddr(parsed.Hostname()); err == nil && !publicAddress(address) {
		return "", ErrInvalidAPI
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}

// ValidAPIModel reports whether name can be sent to the API as a model.
func ValidAPIModel(name string) bool {
	if name == "" || len(name) > 100 {
		return false
	}
	for _, character := range name {
		if character <= ' ' || character == 0x7f {
			return false
		}
	}
	return true
}

// publicAddress reports whether address is one the public internet routes.
func publicAddress(address netip.Addr) bool {
	address = address.Unmap()
	return address.IsValid() && !address.IsLoopback() && !address.IsPrivate() && !address.IsLinkLocalUnicast() &&
		!address.IsLinkLocalMulticast() && !address.IsMulticast() && !address.IsUnspecified() &&
		// Carrier-grade NAT, which cloud providers use inside their networks.
		!netip.MustParsePrefix("100.64.0.0/10").Contains(address)
}

// refusePrivateAddress runs on every connection, after the name has resolved,
// so a host that points inside the deployment is refused whatever it is called.
func refusePrivateAddress(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return ErrInvalidAPI
	}
	parsed, err := netip.ParseAddr(host)
	if err != nil || !publicAddress(parsed) {
		return ErrInvalidAPI
	}
	return nil
}

// APIPolisher rewrites dictated text on an OpenAI-compatible chat API.
type APIPolisher struct{ client *http.Client }

// NewAPIPolisher returns a polisher that connects only to public addresses and
// follows no redirect.
func NewAPIPolisher() *APIPolisher {
	dialer := &net.Dialer{Timeout: 5 * time.Second, Control: refusePrivateAddress}
	return NewAPIPolisherWithClient(&http.Client{
		Transport: &http.Transport{
			DialContext:           dialer.DialContext,
			TLSHandshakeTimeout:   5 * time.Second,
			ResponseHeaderTimeout: APITimeout,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	})
}

// NewAPIPolisherWithClient returns a polisher that sends through client.
func NewAPIPolisherWithClient(client *http.Client) *APIPolisher {
	return &APIPolisher{client: client}
}

// MaxListedModels caps how many model names a listing returns; hosted APIs
// list a few dozen, a gateway can list hundreds.
const MaxListedModels = 300

// modelsListing asks the API for its models and reports the status with the
// body, after the failures every caller treats alike: the key refused and the
// API not answering.
func (p *APIPolisher) modelsListing(ctx context.Context, config APIConfig) (int, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, APITimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, config.BaseURL+"/models", nil)
	if err != nil {
		return 0, nil, ErrInvalidAPI
	}
	request.Header.Set("Authorization", "Bearer "+config.Key)
	response, err := p.client.Do(request)
	if err != nil {
		return 0, nil, fmt.Errorf("%w: %w", ErrAPIUnreachable, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return 0, nil, fmt.Errorf("%w: %w", ErrAPIUnreachable, err)
	}
	switch {
	case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
		return response.StatusCode, nil, ErrAPIRejected
	case response.StatusCode >= 500:
		return response.StatusCode, nil, fmt.Errorf("%w: status %d", ErrAPIUnreachable, response.StatusCode)
	}
	return response.StatusCode, body, nil
}

// Probe checks the key against the API: a models listing is free and every
// OpenAI-compatible API answers one. An API that lacks the route is accepted,
// since the key cannot be judged by it.
func (p *APIPolisher) Probe(ctx context.Context, config APIConfig) error {
	_, _, err := p.modelsListing(ctx, config)
	return err
}

// ListModels returns the model names the API offers, sorted and without
// repeats, so a person can pick one instead of typing it. An API that lacks
// the route lists none; the person types a name.
func (p *APIPolisher) ListModels(ctx context.Context, config APIConfig) ([]string, error) {
	status, body, err := p.modelsListing(ctx, config)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound {
		return []string{}, nil
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("%w: status %d", ErrAPIUnreachable, status)
	}
	var listing struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &listing); err != nil {
		return nil, fmt.Errorf("%w: the models listing is not JSON", ErrAPIUnreachable)
	}
	seen := make(map[string]struct{}, len(listing.Data))
	names := make([]string, 0, len(listing.Data))
	for _, item := range listing.Data {
		if _, repeated := seen[item.ID]; repeated || !ValidAPIModel(item.ID) {
			continue
		}
		seen[item.ID] = struct{}{}
		names = append(names, item.ID)
	}
	sort.Strings(names)
	if len(names) > MaxListedModels {
		names = names[:MaxListedModels]
	}
	return names, nil
}

// Polish rewrites text on the API. It sends the same instructions the CLI gets
// and keeps SpeakMore's sampling: a low temperature, so a rewrite stays close
// to what was said.
func (p *APIPolisher) Polish(ctx context.Context, config APIConfig, text string) (string, error) {
	text = strings.TrimSpace(text)
	if text == "" || len(text) > MaxTextBytes {
		return "", errors.New("dictated passage is empty or too long")
	}
	body, err := json.Marshal(map[string]any{
		"model": config.Model,
		"messages": []map[string]string{
			{"role": "system", "content": instructions},
			{"role": "user", "content": text},
		},
		"temperature": 0.3,
		"max_tokens":  2048,
	})
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, APITimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, config.BaseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", ErrInvalidAPI
	}
	request.Header.Set("Authorization", "Bearer "+config.Key)
	request.Header.Set("Content-Type", "application/json")
	response, err := p.client.Do(request)
	if err != nil {
		return "", fmt.Errorf("%w: %w", ErrAPIUnreachable, err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("%w: %w", ErrAPIUnreachable, err)
	}
	if response.StatusCode != http.StatusOK {
		// The body can echo the prompt, so only the status is reported.
		return "", fmt.Errorf("the API answered status %d", response.StatusCode)
	}
	var answer struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &answer); err != nil || len(answer.Choices) == 0 {
		return "", errors.New("the API answered without text")
	}
	polished := strings.TrimSpace(answer.Choices[0].Message.Content)
	if polished == "" {
		return "", errors.New("the API answered without text")
	}
	return polished, nil
}
