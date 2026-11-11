package native

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
)

const (
	claudeSteerNotConfirmed = "Claude steer submission was not confirmed; execution must not be retried"
	claudeSubmitFailed      = "Claude initialization or input submission failed"
	claudeAuthorizeFailed   = "Claude tool authorization failed"
	claudePermissionInvalid = "Claude permission request is invalid"
)

// submitFresh sends the first frames of a new process: initialize, then the
// user input.
func (t *claudeTurn) submitFresh(initialize []byte) {
	defer close(t.submitDone)
	ctx, cancel := context.WithTimeout(t.runCtx, claudeInitLimit)
	_, err := t.proc.conv.request(ctx, claudeInitializeRequestID, initialize)
	cancel()
	if err == nil {
		err = t.writeInput()
	}
	if err != nil {
		t.proc.closeStdin()
	}
	t.submitFailed(err)
}

// submitReused sends only the user input to an adopted process; its
// initialize frame is part of the resident shape.
func (t *claudeTurn) submitReused() {
	defer close(t.submitDone)
	err := t.writeInput()
	if err != nil {
		t.proc.closeStdin()
	}
	t.submitFailed(err)
}

func (t *claudeTurn) writeInput() error {
	native := t.proc.conv.current()
	t.proc.conv.markSubmitted(time.Now())
	if err := t.proc.write(t.runCtx, claudeUserFrame(native, t.prompt)); err != nil {
		t.inputErr = err
		return err
	}
	return nil
}

func (t *claudeTurn) submitFailed(err error) {
	t.submitErr = err
	if err == nil || t.runCtx.Err() != nil {
		return
	}
	t.proc.conv.abort(claudeSubmitFailed)
	t.runCancel()
}

// submittedOK checks without waiting that submission finished cleanly.
func (t *claudeTurn) submittedOK() bool {
	select {
	case <-t.submitDone:
		return t.submitErr == nil
	default:
		return false
	}
}

func claudeNotApplied(expected, actual string) *SteerError {
	return &SteerError{
		Effect: "definitely_not_applied", Reason: "no_active_turn",
		ExpectedTurnID: expected, ActualTurnID: actual,
		Message: "Claude turn is not accepting input",
	}
}

// steer holds input for the running turn, as Codex does: nothing is
// interrupted, and the main agent's next tool result carries the input to the
// model. A turn that ends without another tool result did not apply it, so
// the caller may run it as new input. The input stays in this process until
// it is written, so the outcome is only uncertain when that write fails.
// The acknowledgement names the stable run turn.
func (t *claudeTurn) steer(ctx context.Context, request SteerRequest) (SteerAck, error) {
	if err := ctx.Err(); err != nil {
		return SteerAck{}, err
	}
	conv := t.proc.conv
	steer, err := conv.enqueueSteer(t, request.ExpectedTurnID, request.Input)
	if err != nil {
		return SteerAck{}, err
	}
	select {
	case err = <-steer.done:
	case <-ctx.Done():
		if conv.withdrawSteer(steer) {
			return SteerAck{}, claudeNotApplied(request.ExpectedTurnID, request.ExpectedTurnID)
		}
		err = <-steer.done
	}
	if err != nil {
		return SteerAck{}, err
	}
	return SteerAck{TurnID: request.ExpectedTurnID}, nil
}

// claudeSteerContext introduces steered input where the CLI shows it: as
// context attached to a tool result, which the model would otherwise read as
// part of that result.
const claudeSteerContext = "New input for this turn arrived while the tool above was running. It is not part of the tool output. Take it into account from your next step on; it may add to or change what you are doing."

// deliverSteers answers a PostToolUse or PostToolUseFailure hook. A tool
// result of the main agent carries every waiting steer; a sub-agent's does
// not, since its context is not the turn's.
func (t *claudeTurn) deliverSteers(requestID string, hook claudeHookInput) {
	var steers []*claudeSteer
	output := map[string]any{}
	if hook.AgentID == "" {
		steers = t.proc.conv.takeSteers(t)
	}
	if len(steers) > 0 {
		parts := []string{claudeSteerContext}
		for _, steer := range steers {
			parts = append(parts, steer.text)
		}
		output["hookSpecificOutput"] = map[string]any{
			"hookEventName": hook.HookEventName, "additionalContext": strings.Join(parts, "\n\n"),
		}
	}
	err := t.proc.write(t.runCtx, claudeControlReply(requestID, output))
	if err != nil {
		t.proc.conv.abort(claudeAuthorizeFailed)
		turn := t.proc.conv.current()
		var unwritten *claudeUnwrittenError
		if errors.As(err, &unwritten) {
			err = claudeNotApplied(turn, turn)
		} else {
			err = &SteerError{
				Effect: "uncertain", Reason: "transport",
				ExpectedTurnID: turn, Message: claudeSteerNotConfirmed,
			}
		}
	}
	for _, steer := range steers {
		steer.done <- err
	}
}

// authorize answers a control_request on the inline path, or hands a
// can_use_tool call to the Room permission review.
func (t *claudeTurn) authorize(frame claudeFrame) {
	if t.compaction {
		if err := t.proc.write(t.runCtx, claudeControlRefusal(frame.RequestID, "Session compaction allows no requests")); err != nil {
			t.proc.conv.abort(claudeAuthorizeFailed)
		}
		return
	}
	var peek struct {
		Subtype    string          `json:"subtype"`
		CallbackID string          `json:"callback_id"`
		Input      json.RawMessage `json:"input"`
	}
	_ = json.Unmarshal(frame.Request, &peek)
	if peek.Subtype == "hook_callback" && peek.CallbackID == claudeSteerHookID {
		var hook claudeHookInput
		if frame.RequestID == "" || json.Unmarshal(peek.Input, &hook) != nil ||
			(hook.HookEventName != "PostToolUse" && hook.HookEventName != "PostToolUseFailure") {
			t.proc.conv.abort(claudePermissionInvalid)
			return
		}
		t.deliverSteers(frame.RequestID, hook)
		return
	}
	if peek.Subtype == "can_use_tool" && t.spec.PermissionReviewer != nil {
		t.review(frame)
		return
	}
	payload, err := claudeAuthorizeInline(t.spec.ClaudePolicy, frame.RequestID, frame.Request)
	if err == nil {
		err = t.proc.write(t.runCtx, claudeControlReply(frame.RequestID, payload))
	}
	if err != nil {
		t.proc.conv.abort(claudeAuthorizeFailed)
	}
}

func (t *claudeTurn) review(frame claudeFrame) {
	var request claudeControlRequest
	if frame.RequestID == "" || json.Unmarshal(frame.Request, &request) != nil {
		t.proc.conv.abort(claudePermissionInvalid)
		return
	}
	input, ok := claudeObject(request.Input)
	if !ok {
		t.proc.conv.abort(claudePermissionInvalid)
		return
	}
	if reason := t.spec.ClaudePolicy.denyReason(request.ToolName, input, request.AgentID); reason != "" {
		if err := t.proc.write(t.runCtx, claudeControlReply(frame.RequestID, claudeDeny(reason))); err != nil {
			t.proc.conv.abort(claudeAuthorizeFailed)
		}
		return
	}
	id := frame.RequestID
	reviewCtx, cancel := context.WithCancel(t.runCtx)
	t.reviewMu.Lock()
	if previous := t.reviews[id]; previous != nil {
		previous()
	}
	t.reviews[id] = cancel
	t.reviewMu.Unlock()
	session := t.observedSession
	reviewer := t.spec.PermissionReviewer
	go func() {
		defer cancel()
		review := permission.ClaudeRequest(request.ToolName, input, request.AgentID, t.spec.Dir)
		review.Transcript = permission.ClaudeTranscript(reviewCtx, t.spec.RuntimeHome, session)
		verdict := reviewer.Review(reviewCtx, review)
		t.reviewMu.Lock()
		current := t.reviews[id]
		delete(t.reviews, id)
		t.reviewMu.Unlock()
		if current == nil || reviewCtx.Err() != nil {
			return
		}
		response := claudeControlReply(id, permission.CanUseToolResponse(verdict, input, request.ToolUseID))
		if err := t.proc.write(t.runCtx, response); err != nil && t.runCtx.Err() == nil {
			t.proc.conv.abort(claudeAuthorizeFailed)
		}
	}()
}
