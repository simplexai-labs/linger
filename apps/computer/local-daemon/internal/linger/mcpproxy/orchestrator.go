package mcpproxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
)

// ToolEndpoint identifies an Operation-local driver kept outside the JavaScript context.
type ToolEndpoint struct {
	Name string
	URL  string
}

type toolOrchestrator struct {
	mu                      sync.Mutex
	required, ready, closed bool
	reviewer                *permission.Reviewer
	identity                OperationIdentity
}

// ComputerEndpoints returns the original drivers, not the orchestration tool.
func (s *Set) ComputerEndpoints() []ToolEndpoint {
	if s == nil {
		return nil
	}
	var endpoints []ToolEndpoint
	for _, b := range s.local {
		if (b.Name == "computer" || b.Name == "browser") && !s.hidden[b.URL] {
			endpoints = append(endpoints, ToolEndpoint{Name: b.Name, URL: b.URL})
		}
	}
	return endpoints
}

// PrivatizeComputerTools retains driver lifecycle and evidence collection, but
// removes their public decision surface. Only trusted composition calls this.
func (s *Set) PrivatizeComputerTools(identity OperationIdentity, required bool) error {
	if s == nil || s.ui != nil || identity.OperationID == "" || identity.ExecutionLeaseID == "" {
		return errors.New("invalid UI orchestration identity")
	}
	var config struct {
		Servers map[string]json.RawMessage `json:"mcpServers"`
	}
	if err := json.Unmarshal(s.config, &config); err != nil {
		return err
	}
	s.hidden = map[string]bool{}
	for _, endpoint := range s.ComputerEndpoints() {
		s.hidden[endpoint.URL] = true
		delete(config.Servers, endpoint.Name)
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		return err
	}
	s.config = encoded
	s.ui = &toolOrchestrator{required: required, identity: identity}
	return nil
}

// RegisterToolReviewer binds the Run's reviewer to this exact Operation and
// lease. The closure cannot be supplied by a wire request or another Set.
func (s *Set) RegisterToolReviewer(reviewer *permission.Reviewer) (func(), error) {
	if s == nil || s.ui == nil {
		return func() {}, nil
	}
	u := s.ui
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closed || u.ready || u.required && reviewer == nil {
		return nil, errors.New("UI action reviewer is unavailable for this Operation")
	}
	u.reviewer, u.ready = reviewer, true
	return func() { s.closeToolReviewer() }, nil
}

func (s *Set) closeToolReviewer() {
	if s == nil || s.ui == nil {
		return
	}
	s.ui.mu.Lock()
	s.ui.closed, s.ui.ready, s.ui.reviewer = true, false, nil
	s.ui.mu.Unlock()
}

// ApprovedComputerApps returns the desktop bundle IDs currently approved by
// this Operation's reviewer, or nil when none is bound.
func (s *Set) ApprovedComputerApps() []string {
	if s == nil || s.ui == nil {
		return nil
	}
	s.ui.mu.Lock()
	reviewer := s.ui.reviewer
	s.ui.mu.Unlock()
	if reviewer == nil {
		return nil
	}
	return reviewer.ApprovedComputerAppList()
}

// ToolReviewerReady reports whether this operation can review nested UI calls.
func (s *Set) ToolReviewerReady() bool {
	if s == nil || s.ui == nil {
		return false
	}
	s.ui.mu.Lock()
	defer s.ui.mu.Unlock()
	return s.ui.ready && !s.ui.closed
}

// ReviewTool runs before dispatch, using the original method and real values.
// The original HTTP driver checks lease authority again at dispatch.
func (s *Set) ReviewTool(ctx context.Context, server, name string, args json.RawMessage) error {
	if s == nil || s.ui == nil {
		return errors.New("UI action reviewer is unavailable")
	}
	u := s.ui
	u.mu.Lock()
	ready, reviewer, identity := u.ready && !u.closed, u.reviewer, u.identity
	u.mu.Unlock()
	if !ready {
		return errors.New("UI action reviewer is not ready")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if identity.BeforeToolCall != nil {
		if err := identity.BeforeToolCall(); err != nil {
			return err
		}
	}
	if identity.BeforeRequest != nil {
		if err := identity.BeforeRequest(ctx); err != nil {
			return err
		}
	}
	if reviewer == nil {
		return nil
	}
	tool := "mcp__" + server + "__" + name
	var input map[string]any
	if json.Unmarshal(args, &input) != nil || input == nil {
		return errors.New("invalid UI action arguments")
	}
	request := permission.Request{Action: permission.Action{Runtime: identity.RuntimeType, Surface: permission.Surface(tool, ""), Tool: tool, Input: string(args)}, Evidence: permission.RunScriptEvidence(tool, input)}
	verdict := reviewer.Review(ctx, request)
	if verdict.Decision != permission.Allow {
		return fmt.Errorf("UI action was not dispatched: %s", verdict.Message)
	}
	if !s.ToolReviewerReady() {
		return errors.New("UI action authority ended during review")
	}
	return ctx.Err()
}
