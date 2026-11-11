package voice

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// voiceLiveBrowserTarget is the local browser the live session may
// drive, or ok=false when its Agent has none the Human owns.
func (s *Service) voiceLiveBrowserTarget(ctx context.Context, session voicelive.Session) (store.GetVoiceLiveComputerTargetRow, roomagent.LocalBrowserTool, bool, error) {
	browser, ok := s.localComputers.(roomagent.LocalBrowserTool)
	if !ok {
		return store.GetVoiceLiveComputerTargetRow{}, nil, false, nil
	}
	target, err := s.queries.GetVoiceLiveComputerTarget(ctx, store.GetVoiceLiveComputerTargetParams{
		AgentActorID: session.Agent.ID, TenantID: session.TenantID, HumanActorID: session.HumanActorID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return store.GetVoiceLiveComputerTargetRow{}, nil, false, nil
	}
	if err != nil {
		return store.GetVoiceLiveComputerTargetRow{}, nil, false, err
	}
	return target, browser, true, nil
}

// callVoiceLiveBrowser runs one live browser action on the Agent's Local Computer. Failures are told to the live model, never retried here.
func (s *Service) callVoiceLiveBrowser(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	var args voicelive.BrowserArguments
	if voicelive.DecodeArguments(request.Arguments, &args) != nil {
		return "", voicelive.ErrInvalid
	}
	toolName, arguments, ok := voicelive.BrowserCall(args)
	if !ok {
		return "", voicelive.ErrInvalid
	}
	target, browser, ok, err := s.voiceLiveBrowserTarget(ctx, session)
	if err != nil {
		return "", err
	}
	if !ok {
		return voicelive.ErrorOutput("no_local_computer"), nil
	}
	// The page the live voice saw last: where a hand-off continues, and what a
	// risky click would press.
	// landing is the first page of a tab a click opened, while the live voice
	// is still on that tab.
	lastPage, cameFrom, landing := "", -1, ""
	if previous, err := s.queries.GetLatestVoiceLiveToolOutput(ctx, store.GetLatestVoiceLiveToolOutputParams{
		VoiceSessionID: session.ID, Name: voicelive.ToolComputerBrowser, CallID: request.CallId,
	}); err == nil {
		var shown struct {
			Page        string `json:"page"`
			CameFromTab *int   `json:"came_from_tab"`
			LandingURL  string `json:"landing_url"`
		}
		_ = json.Unmarshal([]byte(previous), &shown)
		lastPage, landing = shown.Page, shown.LandingURL
		if shown.CameFromTab != nil {
			cameFrom = *shown.CameFromTab
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	if request.TurnId != "" {
		calls, err := s.queries.CountVoiceLiveTurnToolCalls(ctx, store.CountVoiceLiveTurnToolCallsParams{
			VoiceSessionID: session.ID, TurnID: request.TurnId, Name: voicelive.ToolComputerBrowser,
		})
		if err != nil {
			return "", err
		}
		if calls >= voicelive.MaxBrowserCallsPerTurn {
			// Longer work moves to a background task that goes on from this
			// page, logged in through the same browser.
			return voicelive.Output(map[string]string{
				"error":       "step_limit",
				"current_url": voicelive.BrowserPageURL(lastPage),
				"detail":      "Stop driving the browser yourself. If the work should go on, call start_task with surface web and a goal that says what is left to do, what is already done and that it starts from current_url (the background work uses the same logged-in browser); otherwise tell the user where it is stuck.",
			}), nil
		}
	}
	// A click or Enter that may send, pay or delete waits for the user's yes.
	if summary, risky := voicelive.BrowserRisk(args, lastPage); risky {
		prompt := voicelive.NeedsConfirmation(summary)
		if confirmed, err := s.voiceLiveConfirmed(ctx, session, request, bool(args.Confirmed), prompt); err != nil || !confirmed {
			return prompt, err
		}
	}
	call := roomagent.LocalBrowserToolCall{
		TenantID: session.TenantID, OwnerActorID: session.HumanActorID,
		ComputerID: target.ComputerID, AgentID: target.AgentManagementID,
		ToolSessionID: "voice-" + strings.TrimPrefix(session.ID, "voice_session_"),
		ToolName:      toolName, Arguments: arguments,
	}
	// Closing a tab, or going back from the page a click opened in a new tab,
	// closes that tab and returns to the one it came from: going back inside
	// it would leave a second copy of the page the user came from.
	count, current := voicelive.BrowserTabs(lastPage)
	closing := closesLiveBrowserTab(args.Action, lastPage, cameFrom, landing)
	if closing && count <= 1 {
		if args.Action == "close" {
			return voicelive.Output(map[string]string{"error": "only_tab", "detail": "This is the only tab, so it stays open: use back for the previous page or open another address."}), nil
		}
		closing = false
	}
	var result roomagent.LocalBrowserToolResult
	if closing {
		result, err = s.closeLiveBrowserTab(ctx, browser, call, current, cameFrom, count)
	} else {
		result, err = browser.CallLocalBrowserTool(ctx, call)
	}
	if err != nil {
		var rejected *roomagent.LocalComputerToolError
		if errors.As(err, &rejected) {
			code := strings.ToLower(rejected.Code)
			if detail, ok := voicelive.BrowserConnectionDetail(code); ok {
				return voicelive.Output(map[string]string{"error": code, "detail": detail}), nil
			}
			return voicelive.Output(map[string]string{"error": code, "detail": voicelive.Snippet(rejected.Message)}), nil
		}
		s.logger.Warn("live local browser call failed", "voice_session_id", session.ID, "tool", toolName, "error", err)
		return voicelive.ErrorOutput("browser_unavailable"), nil
	}
	if closing {
		cameFrom, landing = -1, ""
	} else {
		result, cameFrom = s.followLiveBrowserTab(ctx, session, browser, call, args.Action, lastPage, cameFrom, result)
		switch nowCount, nowCurrent := voicelive.BrowserTabs(result.Text); {
		case cameFrom < 0:
			landing = ""
		case nowCurrent != current || nowCount != count:
			// The click just moved to the tab it opened.
			landing = voicelive.BrowserPageURL(result.Text)
		}
	}
	part, find := 0, ""
	if args.Action == "look" {
		part, find = int(args.Part), args.Find
	}
	shown := voicelive.BrowserPage(result.Text, part, find)
	output := map[string]any{"page": shown.Page}
	if shown.Parts > 1 {
		output["part"], output["parts"] = shown.Part, shown.Parts
	}
	if !shown.Found {
		output["find"] = "not_found"
	}
	if shown.Truncated {
		output["truncated"] = true
	}
	if result.IsError {
		output["error"] = "action_failed"
	}
	if cameFrom >= 0 {
		output["came_from_tab"] = cameFrom
		if landing != "" {
			output["landing_url"] = landing
		}
	}
	return voicelive.Output(output), nil
}

// closesLiveBrowserTab reports whether an action closes the current tab:
// close always does, and back does on the first page of a tab a click opened,
// whatever history the site gave that tab.
func closesLiveBrowserTab(action, lastPage string, cameFrom int, landing string) bool {
	return action == "close" ||
		action == "back" && cameFrom >= 0 && landing != "" && voicelive.BrowserPageURL(lastPage) == landing
}

// closeLiveBrowserTab closes the current tab and reads the one it came from,
// or the tab before it when that is unknown.
func (s *Service) closeLiveBrowserTab(ctx context.Context, browser roomagent.LocalBrowserTool, call roomagent.LocalBrowserToolCall, current, cameFrom, count int) (roomagent.LocalBrowserToolResult, error) {
	call.ToolName, call.Arguments = "browser_tabs", map[string]any{"action": "close", "index": current}
	if closed, err := browser.CallLocalBrowserTool(ctx, call); err != nil || closed.IsError {
		return closed, err
	}
	back := max(current-1, 0)
	if cameFrom >= 0 && cameFrom < count && cameFrom != current {
		back = cameFrom
	}
	if back > current {
		back--
	}
	call.ToolName, call.Arguments = "browser_tabs", map[string]any{"action": "select", "index": back}
	if selected, err := browser.CallLocalBrowserTool(ctx, call); err != nil || selected.IsError {
		return selected, err
	}
	call.ToolName, call.Arguments = "browser_snapshot", map[string]any{}
	return browser.CallLocalBrowserTool(ctx, call)
}

// followLiveBrowserTab keeps the live voice on the tab the user sees, as a
// person would: a click that opens a new tab moves to it. Leaving that tab is
// closesLiveBrowserTab's. It returns the page to show and the tab the current
// one came from, or -1. A follow-up step that fails leaves the first result.
func (s *Service) followLiveBrowserTab(ctx context.Context, session voicelive.Session, browser roomagent.LocalBrowserTool, call roomagent.LocalBrowserToolCall, action, lastPage string, cameFrom int, result roomagent.LocalBrowserToolResult) (roomagent.LocalBrowserToolResult, int) {
	if result.IsError {
		return result, -1
	}
	beforeCount, beforeCurrent := voicelive.BrowserTabs(lastPage)
	count, current := voicelive.BrowserTabs(result.Text)
	// Tabs are listed in the order they opened, so the new one is the last.
	if action == "click" && count > beforeCount && current != count-1 {
		if page, ok := s.switchLiveBrowserTab(ctx, session, browser, call, count-1); ok {
			return page, current
		}
	}
	// Other steps stay on the same tab and keep where it came from.
	if current == beforeCurrent && count >= beforeCount {
		return result, cameFrom
	}
	return result, -1
}

// switchLiveBrowserTab brings a tab to the front and reads its page.
func (s *Service) switchLiveBrowserTab(ctx context.Context, session voicelive.Session, browser roomagent.LocalBrowserTool, call roomagent.LocalBrowserToolCall, index int) (roomagent.LocalBrowserToolResult, bool) {
	call.ToolName, call.Arguments = "browser_tabs", map[string]any{"action": "select", "index": index}
	if selected, err := browser.CallLocalBrowserTool(ctx, call); err != nil || selected.IsError {
		s.logger.Warn("live browser could not select a tab", "voice_session_id", session.ID, "error", err)
		return roomagent.LocalBrowserToolResult{}, false
	}
	call.ToolName, call.Arguments = "browser_snapshot", map[string]any{}
	page, err := browser.CallLocalBrowserTool(ctx, call)
	if err != nil || page.IsError {
		s.logger.Warn("live browser could not read the selected tab", "voice_session_id", session.ID, "error", err)
		return roomagent.LocalBrowserToolResult{}, false
	}
	return page, true
}
