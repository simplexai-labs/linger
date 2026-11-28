package permission

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Requester carries one review to Agent Service and back. The Daemon's
// HumanInteractionBridge implements it: Request emits the review as a
// human_interaction.requested event, and Agent Service answers with a
// runtime_response that reaches respond.
type Requester interface {
	Request(id string, request map[string]any, respond func(json.RawMessage) error) error
	Forget(id string)
}

// DefaultTimeout leaves time for TeamHub's human fallback and Agent Service's
// reply while bounding each tool's wait for a permission decision.
const DefaultTimeout = 20 * time.Second

// Reviewer judges the calls a Runtime adapter hands it. One Reviewer serves
// one Run, so the navigation verdicts it reuses never outlive the Run.
type Reviewer struct {
	Requester   Requester
	Timeout     time.Duration
	Environment Environment
	// TeamHubCommands are the TeamHub CLI commands that run without review.
	TeamHubCommands []TeamHubCommand
	// LocalEvidence collects the page or window a browser or desktop action
	// targets, or returns nil. It is nil when the Run has no local tools.
	LocalEvidence func(ctx context.Context, tool, input string) *Evidence
	// LocalAllowed reports whether a browser or desktop call follows from
	// what the Agent has seen, such as following a link of its page, and
	// runs without review. It is nil when the Run has no local tools.
	LocalAllowed func(tool, input string) bool
	// ResolveComputerTarget resolves the macOS application target (bundle_id,
	// app, window_title) for a computer tool call. When non-nil, per-app
	// gating applies to all app-targeted computer tools.
	ResolveComputerTarget func(ctx context.Context, tool, input string) *Desktop
	// ApprovedComputerApps seeds bundle IDs already granted for this Run.
	// Runtime approvals in this Run are added live under mu.
	ApprovedComputerApps map[string]bool
	// Now is the clock of verdict reuse; nil means time.Now.
	Now func() time.Time
	// ScriptScope is the ScriptScope of the Run's Agent and Context; a Skill
	// script run_script allows runs only in that scope.
	ScriptScope string

	mu sync.Mutex
	// reuse holds the desktop navigation shapes (GUIReuseKey) the judge
	// allowed, by expiry.
	reuse map[string]time.Time
}

// ApproveComputerApp records bundleID as approved for the remainder of this Run.
func (r *Reviewer) ApproveComputerApp(bundleID string) {
	bundleID = strings.TrimSpace(bundleID)
	if r == nil || bundleID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.ApprovedComputerApps == nil {
		r.ApprovedComputerApps = map[string]bool{}
	}
	r.ApprovedComputerApps[strings.ToLower(bundleID)] = true
}

// ComputerAppApproved reports whether bundleID is approved for this Run.
func (r *Reviewer) ComputerAppApproved(bundleID string) bool {
	bundleID = strings.TrimSpace(bundleID)
	if r == nil || bundleID == "" {
		return false
	}
	lower := strings.ToLower(bundleID)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.ApprovedComputerApps[bundleID] || r.ApprovedComputerApps[lower] {
		return true
	}
	for granted := range r.ApprovedComputerApps {
		if strings.EqualFold(granted, bundleID) {
			return true
		}
	}
	return false
}

// ApprovedComputerAppList returns a snapshot of approved bundle IDs for this Run.
func (r *Reviewer) ApprovedComputerAppList() []string {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.ApprovedComputerApps) == 0 {
		return nil
	}
	out := make([]string, 0, len(r.ApprovedComputerApps))
	for bundleID, allowed := range r.ApprovedComputerApps {
		if allowed {
			out = append(out, bundleID)
		}
	}
	return out
}

// Review allows the Daemon's own read-only tools, local calls that follow
// what the Agent has seen, the read-only and TeamHub commands the Runtime
// rules could not match, and a desktop navigation step whose shape the judge
// allowed earlier in this Run, and asks the permission review for
// everything else. Every failure answers Unavailable: the Runtime must not
// run a call nobody judged.
func (r *Reviewer) Review(ctx context.Context, request Request) Verdict {
	var computerTarget *Desktop
	perAppComputerGate := false
	if strings.HasPrefix(request.Action.Tool, "mcp__computer__") {
		if AppAgnosticComputerReadTool(request.Action.Tool) {
			return Verdict{Decision: Allow}
		}
		if r.ResolveComputerTarget != nil {
			perAppComputerGate = true
			computerTarget = r.ResolveComputerTarget(ctx, request.Action.Tool, request.Action.Input)
			if computerTarget != nil && computerTarget.DenyReason != "" {
				return Verdict{Decision: Deny, Message: computerTarget.DenyReason}
			}
			if computerTarget != nil && strings.TrimSpace(computerTarget.BundleID) != "" {
				if IsProtectedMacApp(computerTarget.BundleID) {
					name := computerTarget.App
					if name == "" {
						name = computerTarget.BundleID
					}
					return Verdict{
						Decision: Deny,
						Message:  fmt.Sprintf("Access to %s (%s) is blocked by system privacy policy. Ask the user to perform this step directly.", name, computerTarget.BundleID),
					}
				}
				if r.ComputerAppApproved(computerTarget.BundleID) {
					return Verdict{Decision: Allow}
				}
			}
		}
	}
	// When per-app macOS gating is active, an unresolved app target must fail
	// closed to TeamHub review rather than falling through to read-only allows.
	if !perAppComputerGate {
		if ReadOnlyLocalTool(request.Action.Tool, request.Action.Input) ||
			r.LocalAllowed != nil && r.LocalAllowed(request.Action.Tool, request.Action.Input) {
			return Verdict{Decision: Allow}
		}
	}
	if request.Action.Tool == "Bash" && SystemPrivacyUI(request.Action.Command) {
		return Verdict{Decision: Deny, Message: SystemPrivacyUIMessage}
	}
	switch request.Action.Tool {
	case "Bash":
		// Claude runs commands in its workspace; Codex may run one in any
		// workdir its hook does not report.
		cwd := r.Environment.Workspace
		if request.Action.Runtime == "codex" {
			cwd = ""
		}
		switch decision, confirm := Shell(request.Action.Command, cwd, r.Environment.Workspace, r.TeamHubCommands); decision {
		case ShellAllow:
			return Verdict{Decision: Allow}
		case ShellRunAlone:
			return Verdict{Decision: Deny, Message: RunAloneMessage(confirm)}
		}
	case "PowerShell":
		switch decision, confirm := ShellPowerShell(request.Action.Command, r.TeamHubCommands); decision {
		case ShellAllow:
			return Verdict{Decision: Allow}
		case ShellRunAlone:
			return Verdict{Decision: Deny, Message: RunAloneMessage(confirm)}
		}
	}
	reuseKey, reusable := GUIReuseKey(request.Action.Tool, request.Action.Input)
	if !perAppComputerGate && reusable && r.reused(reuseKey) {
		return Verdict{Decision: Allow}
	}
	if r.LocalEvidence != nil && request.Evidence == nil && (LocalWriteTool(request.Action.Tool, request.Action.Input) || perAppComputerGate) {
		request.Evidence = r.LocalEvidence(ctx, request.Action.Tool, request.Action.Input)
	}
	if computerTarget != nil && computerTarget.BundleID != "" {
		if request.Evidence == nil {
			request.Evidence = &Evidence{}
		}
		if request.Evidence.Desktop == nil {
			request.Evidence.Desktop = &Desktop{}
		}
		if request.Evidence.Desktop.BundleID == "" {
			request.Evidence.Desktop.BundleID = computerTarget.BundleID
		}
		if request.Evidence.Desktop.App == "" {
			request.Evidence.Desktop.App = computerTarget.App
		}
		if request.Evidence.Desktop.WindowTitle == "" {
			request.Evidence.Desktop.WindowTitle = computerTarget.WindowTitle
		}
	}
	request.Environment = r.Environment
	encoded, err := json.Marshal(request)
	if err != nil {
		return unavailable()
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		return unavailable()
	}
	payload["kind"] = "permission_review"
	id, err := reviewID()
	if err != nil {
		return unavailable()
	}
	answered := make(chan Verdict, 1)
	if err := r.Requester.Request(id, payload, func(raw json.RawMessage) error {
		var verdict Verdict
		if json.Unmarshal(raw, &verdict) != nil || !known(verdict.Decision) {
			verdict = unavailable()
		}
		select {
		case answered <- verdict:
		default:
		}
		return nil
	}); err != nil {
		return unavailable()
	}
	timeout := r.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case verdict := <-answered:
		if verdict.Decision != Allow && verdict.Message == "" {
			verdict.Message = UnavailableMessage
		}
		if reusable {
			r.remember(reuseKey, verdict.Decision)
		}
		if verdict.Decision == Allow {
			if computerTarget != nil && computerTarget.BundleID != "" &&
				(verdict.ApprovalScope == "task" || verdict.ApprovalScope == "always") {
				r.ApproveComputerApp(computerTarget.BundleID)
			}
			recordApprovedScript(r.ScriptScope, request, r.now())
		}
		return verdict
	case <-ctx.Done():
	case <-timer.C:
	}
	r.Requester.Forget(id)
	return unavailable()
}

func (r *Reviewer) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// reused reports whether the judge allowed this navigation shape within the
// reuse window.
func (r *Reviewer) reused(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	expiry, ok := r.reuse[key]
	if !ok {
		return false
	}
	if !r.now().Before(expiry) {
		delete(r.reuse, key)
		return false
	}
	return true
}

// remember keeps an allow for its shape and drops the shape on any other
// verdict: a denial or an approval card means the judge wants to see the
// next call of that shape too.
func (r *Reviewer) remember(key string, decision Decision) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if decision != Allow {
		delete(r.reuse, key)
		return
	}
	if r.reuse == nil {
		r.reuse = map[string]time.Time{}
	}
	r.reuse[key] = r.now().Add(guiReuseTTL)
}

func known(decision Decision) bool {
	switch decision {
	case Allow, NeedsApproval, Deny, Unavailable:
		return true
	}
	return false
}

func reviewID() (string, error) {
	var raw [12]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return "permission-" + hex.EncodeToString(raw[:]), nil
}
