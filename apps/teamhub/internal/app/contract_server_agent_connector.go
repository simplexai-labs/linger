package app

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentconnectedapps"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/feishu"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	api "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
)

func (a *App) prepareConnectorFileUpload(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var input agentconnectedapps.FileUploadInput
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 8192), &input, "invalid upload metadata"); err != nil {
		a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Invalid file upload metadata")
		return
	}
	target, err := a.agentConnectedApps.PrepareFileUpload(connectorCallContext(c), token, input)
	if a.writeAgentConnectedAppsError(c, "prepare connector file upload", err) {
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, target)
}

// Account selection never borrows a Human's connection. Only the existing card
// decision can create a grant; this endpoint merely requests that decision.
func (a *App) resolveConnectorAccount(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var input struct {
		AppKey  string  `json:"app_key"`
		Account *string `json:"account,omitempty"`
	}
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 4096), &input, "invalid account selector"); err != nil {
		a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Invalid account selector")
		return
	}
	selector := ""
	if input.Account != nil {
		selector = *input.Account
	}
	if input.AppKey == "" || strings.TrimSpace(input.AppKey) != input.AppKey || utf8.RuneCountInString(input.AppKey) > 120 || strings.ContainsAny(input.AppKey, "\r\n\x00") || input.Account != nil && (selector == "" || strings.TrimSpace(selector) != selector || utf8.RuneCountInString(selector) > 240 || strings.ContainsAny(selector, "\r\n\x00")) {
		a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Invalid application key or account selector")
		return
	}
	// No Composio app can be connected without the deployment's Composio key,
	// so the user is asked for the key first; the Agent then asks again.
	// Feishu Mail connects through the owner's lark-cli instead.
	if !a.externalSources.ProviderConfigured() && input.AppKey != externalsource.FeishuMailAppKey {
		if !slices.ContainsFunc(a.externalSources.ListApps(), func(app externalsource.ExternalApp) bool { return app.Key == input.AppKey }) {
			a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Unsupported application")
			return
		}
		a.requestProviderKey(c, token, input.AppKey)
		return
	}
	connections, err := a.agentConnectedApps.List(c.Request.Context(), token)
	if a.writeAgentConnectedAppsError(c, "resolve connector account", err) {
		return
	}
	selected, candidates := selectConnectorAccount(connections, input.AppKey, selector)
	c.Header("Cache-Control", "no-store")
	if selected != nil {
		c.JSON(200, gin.H{"status": "ready", "account": agentConnectedAppToContract(*selected)})
		return
	}
	if len(candidates) > 0 {
		items := make([]api.AgentConnectedApp, len(candidates))
		for i, candidate := range candidates {
			items[i] = agentConnectedAppToContract(candidate)
		}
		c.JSON(200, gin.H{"status": "account_ambiguous", "candidates": items})
		return
	}
	if !a.externalSources.SupportsAgentTools(input.AppKey) {
		a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Unsupported application")
		return
	}
	displayName := input.AppKey
	catalog := a.externalSources.ListApps()
	if i := slices.IndexFunc(catalog, func(app externalsource.ExternalApp) bool { return app.Key == input.AppKey }); i >= 0 {
		displayName = catalog[i].DisplayName
	}
	prompt := connectorAuthorizationPrompt(displayName, selector)
	requestedAccount := selector
	if isConnectionIDSelector(selector) {
		requestedAccount = ""
	}
	if roomID, card, ok := a.postConnectorCard(c, token, "list_connected_apps", prompt, typedcard.DecisionCommand{
		ConnectionAuth: &typedcard.ConnectionAuthDecision{Prompt: prompt, AppKey: input.AppKey, Account: requestedAccount, ReusePending: true},
	}); ok {
		c.JSON(200, gin.H{"status": "authorization_required", "room_id": roomID, "message_id": card.MessageID, "interaction_id": card.DecisionID})
	}
}

// connectorAuthorizationPrompt is the Human-facing ask on a ConnectionAuth
// card. A selector that is a connection ID is internal and never shown.
func connectorAuthorizationPrompt(displayName, selector string) string {
	if selector == "" || isConnectionIDSelector(selector) {
		return fmt.Sprintf("Please connect and authorize your %s account so I can continue.", displayName)
	}
	return fmt.Sprintf("Please connect and authorize the %s account %s so I can continue.", displayName, selector)
}

// requestProviderKey posts, or reuses, the card asking the Agent's Human for
// the deployment's Composio API key, and answers provider_key_required so the
// Agent runs the command again once the key is saved. appKey names the app
// that needed it, when the command said.
func (a *App) requestProviderKey(c *gin.Context, token, appKey string) {
	prompt := "Please add a Composio API key so I can use connected apps."
	if slices.ContainsFunc(a.externalSources.ListApps(), func(app externalsource.ExternalApp) bool { return app.Key == appKey }) {
		prompt = fmt.Sprintf("Please add a Composio API key so I can connect %s. Every connected app needs it.", appKey)
	} else {
		appKey = ""
	}
	if _, _, ok := a.postConnectorCard(c, token, "list_connected_apps", prompt, typedcard.DecisionCommand{
		ProviderKey: &typedcard.ProviderKeyDecision{Prompt: prompt, AppKey: appKey},
	}); ok {
		a.writeAgentAPIError(c, http.StatusConflict, api.AgentApiErrorCodeProviderKeyRequired,
			"The user has not added a Composio API key; a card asking for it was posted in this chat")
	}
}

// askForProviderKey answers a connected app command refused only because the
// deployment has no Composio API key with the card that asks for it.
func (a *App) askForProviderKey(c *gin.Context, token, appKey string, err error) bool {
	if !errors.Is(err, agentauth.ErrProviderKeyRequired) {
		return false
	}
	a.requestProviderKey(c, token, appKey)
	return true
}

// postConnectorCard posts the card that asks the Agent's Human for what a
// command still needs; action is the command's business action. It writes
// the error response itself and reports whether the card was posted.
func (a *App) postConnectorCard(c *gin.Context, token, action, prompt string, command typedcard.DecisionCommand) (string, typedcard.CreateResult, bool) {
	c.Header("Cache-Control", "no-store")
	auth, err := a.agentAuth.Authorize(c.Request.Context(), token, action)
	if a.writeAgentAuthError(c, "request connector authorization", err) {
		return "", typedcard.CreateResult{}, false
	}
	if auth.Principal == nil || auth.SponsorActorID == "" {
		a.writeAgentAPIError(c, 403, api.AgentApiErrorCodeForbidden, "Connection authorization requires an eligible chat and Human decision owner")
		return "", typedcard.CreateResult{}, false
	}
	roomID := auth.RoomID
	if auth.ParticipantTaskID != "" {
		// A delegated Task's card goes to the Room that delegated it.
		roomID, err = a.sponsorConfirmationRoom(c.Request.Context(), auth)
	} else if roomID == "" && auth.Target.Kind == "" {
		roomID, err = a.collaboration.CurrentDirectRoom(c.Request.Context(), auth.TenantID, auth.SponsorActorID, auth.AgentActorID)
	}
	if err != nil || roomID == "" {
		a.writeAgentAPIError(c, 403, api.AgentApiErrorCodeForbidden, "Run this command from an eligible Room or Task chat to request account authorization")
		return "", typedcard.CreateResult{}, false
	}
	if command.ConnectionAuth != nil && command.ConnectionAuth.AppKey == externalsource.FeishuMailAppKey && a.refuseFeishuConnect(c, auth) {
		return "", typedcard.CreateResult{}, false
	}
	digest := sha256.Sum256([]byte(roomID + "\x00" + auth.AgentActorID + "\x00" + prompt))
	// A fresh key allows a new request after denial/expiry; the service deduplicates
	// pending cards under the same membership lock used by grant decisions.
	key := "connector-auth-" + idgen.New("request")
	command.Principal, command.DeciderActorID, command.AlterEgoTaskID = auth.Principal, auth.SponsorActorID, auth.ParticipantTaskID
	result, err := a.typedCards.CreateDecision(c.Request.Context(), roomID, auth.AgentID, key, digest[:], command)
	if err != nil {
		if errors.Is(err, typedcard.ErrForbidden) || errors.Is(err, typedcard.ErrNotFound) || errors.Is(err, typedcard.ErrInvalid) {
			a.writeAgentAPIError(c, 403, api.AgentApiErrorCodeForbidden, "Connection authorization is unavailable in this chat")
		} else {
			a.writeAgentAPIError(c, 503, api.AgentApiErrorCodeDependencyUnavailable, "Connection authorization is temporarily unavailable")
		}
		return "", typedcard.CreateResult{}, false
	}
	return roomID, result, true
}

// refuseFeishuConnect checks the Human's Computer before a Feishu Mail card is
// posted. When the card's Connect could not work, it answers with what the
// Human must do first as an issue, which the CLI shows the Agent, so the Agent
// gives the steps in the chat instead of a card that fails when clicked. It
// reports whether it answered.
func (a *App) refuseFeishuConnect(c *gin.Context, auth agentauth.Authorization) bool {
	err := a.externalSources.CheckFeishuConnect(c.Request.Context(), auth.TenantID, auth.SponsorActorID)
	if err == nil {
		return false
	}
	var notEnabled *externalsource.FeishuScopesNotEnabledError
	var computer *feishu.ComputerError
	status, code := http.StatusConflict, api.AgentApiErrorCodeOperationForbidden
	var reason, steps string
	switch {
	case errors.As(err, &notEnabled):
		reason = "feishu_scopes_not_enabled"
		page := "the app's permissions page in the Feishu developer console"
		if notEnabled.PermissionsURL != "" {
			page += " (" + notEnabled.PermissionsURL + ")"
		}
		// An issue holds at most 1024 characters, so a long list is cut short.
		for shown := len(notEnabled.Scopes); shown > 0; shown-- {
			scopes := strings.Join(notEnabled.Scopes[:shown], ", ")
			if shown < len(notEnabled.Scopes) {
				scopes += fmt.Sprintf(" and %d more", len(notEnabled.Scopes)-shown)
			}
			steps = "The Feishu app that lark-cli uses on the user's Computer does not enable these mail permissions: " + scopes +
				". Steps for the user: 1. Open " + page + ". 2. Add each of these permissions as a user permission. 3. Publish a new version of the app. 4. Tell you when it is done, and you connect again."
			if utf8.RuneCountInString(steps) <= 1024 {
				break
			}
		}
	case errors.As(err, &computer) && computer.Status == feishu.StatusComputerOffline:
		status, code, reason = http.StatusServiceUnavailable, api.AgentApiErrorCodeDependencyUnavailable, "feishu_computer_offline"
		steps = "Feishu Mail runs through lark-cli on the Computer that runs the user's Another Me, and that Computer is offline. Steps for the user: 1. On that Computer, open Linger and make sure it is signed in and online. 2. Tell you when it is done, and you connect again."
	case errors.As(err, &computer) && computer.Status == feishu.StatusNotInstalled:
		reason = "lark_cli_not_installed"
		steps = "lark-cli is not installed on the Computer that runs the user's Another Me. Steps for the user, on that Computer: 1. Install it in a terminal: " + feishu.InstallCommand +
			" 2. Set it up with a Feishu app: " + feishu.SetupCommand + " (it prints a link to open in a browser). 3. Tell you when it is done, and you connect again."
	case errors.As(err, &computer) && computer.Status == feishu.StatusNotConfigured:
		reason = "lark_cli_not_configured"
		steps = "lark-cli is installed on the Computer that runs the user's Another Me but not set up with a Feishu app yet. Steps for the user, on that Computer: 1. In a terminal, run: " + feishu.SetupCommand +
			" (it prints a link to open in a browser to finish). 2. Tell you when it is done, and you connect again."
		steps += larkHint(computer.Hint)
	case errors.As(err, &computer):
		status, code, reason = http.StatusServiceUnavailable, api.AgentApiErrorCodeDependencyUnavailable, "feishu_computer_unavailable"
		a.logger.Warn("feishu_mail.connect_check_computer_failed", "status", computer.Status, "detail", computer.Detail)
		steps = "The Computer that runs the user's Another Me could not check lark-cli. Steps for the user: 1. Make sure Linger on that Computer is online and up to date. 2. Tell you when it is done, and you connect again."
		steps += larkHint(computer.Hint)
	default:
		// The card still works for what this check cannot tell; its Connect
		// reports the problem itself.
		a.logger.Warn("feishu_mail.connect_check_failed", "error", err)
		return false
	}
	a.writeAgentAPIErrorWithIssues(c, status, code, "Feishu Mail cannot be connected yet; no card was posted",
		[]api.AgentApiErrorIssue{{Path: externalsource.FeishuMailAppKey, Code: reason, Message: steps}})
	return true
}

// larkHint appends lark-cli's own advice to an Issue's steps, cut short so the
// Issue stays within its 1024 characters.
func larkHint(hint string) string {
	hint = strings.TrimSpace(hint)
	if hint == "" {
		return ""
	}
	if runes := []rune(hint); len(runes) > 400 {
		hint = string(runes[:400]) + "…"
	}
	return " lark-cli's own hint: " + hint
}

func selectConnectorAccount(connections []agentconnectedapps.ConnectedApp, app, selector string) (*agentconnectedapps.ConnectedApp, []agentconnectedapps.ConnectedApp) {
	staleID := isConnectionIDSelector(selector)
	items := make([]agentconnectedapps.ConnectedApp, 0)
	for _, connection := range connections {
		if connection.AppKey != app {
			continue
		}
		if selector != "" && connection.ConnectionID == selector {
			return &connection, nil
		}
		if selector == "" || staleID || strings.EqualFold(connection.Identity, selector) {
			items = append(items, connection)
		}
	}
	// A connection ID that matches nothing is stale: the Agent must choose
	// again rather than be handed another account, even when only one exists.
	if staleID {
		return nil, items
	}
	if len(items) == 1 {
		return &items[0], nil
	}
	if len(items) == 0 {
		return nil, nil
	}
	return nil, items
}

// isConnectionIDSelector reports whether an account selector has the
// structured connection ID format rather than being an identity label.
func isConnectionIDSelector(selector string) bool {
	return strings.HasPrefix(selector, "external_connection_")
}

func (a *App) prepareConnectorMailBody(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var input struct {
		Content string `json:"content"`
	}
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 6<<20), &input, "invalid mail body"); err != nil || len(input.Content) > 1<<20 {
		a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Mail body exceeds its UTF-8 size limit or is invalid")
		return
	}
	_, err := a.agentAuth.Authorize(c.Request.Context(), token, "list_connected_apps")
	if a.writeAgentAuthError(c, "prepare mail body", err) {
		return
	}
	html, err := agentconnectedapps.MailMarkdownHTML(input.Content)
	if errors.Is(err, agentconnectedapps.ErrMailRawHTML) {
		a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Raw HTML in Markdown is unsupported; use --html for an HTML body")
		return
	}
	if err != nil {
		a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Mail Markdown could not be converted")
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"html": html})
}

func (a *App) bindConnectorTools(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var input agentconnectedapps.BindToolsInput
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 8192), &input, "invalid bindings"); err != nil {
		a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Invalid fixed tool bindings")
		return
	}
	result, err := a.agentConnectedApps.BindTools(c.Request.Context(), token, input)
	if a.writeAgentConnectedAppsError(c, "bind connector tools", err) {
		return
	}
	tools := make([]gin.H, 0, len(result))
	for _, tool := range result {
		tools = append(tools, gin.H{"tool_slug": tool.ToolSlug, "tool_version": tool.ToolVersion, "app_key": tool.AppKey, "input_schema": tool.InputSchema})
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, gin.H{"tools": tools})
}

func (a *App) prepareConnectorNotionBody(c *gin.Context) {
	token, ok := a.agentCommandBearer(c)
	if !ok {
		return
	}
	var input struct {
		Content  string `json:"content"`
		Markdown bool   `json:"markdown"`
	}
	if err := decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 6<<20), &input, "invalid body"); err != nil {
		a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Invalid Notion body")
		return
	}
	_, err := a.agentAuth.Authorize(c.Request.Context(), token, "list_connected_apps")
	if a.writeAgentAuthError(c, "prepare Notion body", err) {
		return
	}
	result, err := prepareNotionBody(input.Content, input.Markdown)
	if err != nil {
		a.writeAgentAPIError(c, 400, api.AgentApiErrorCodeInvalidInput, "Unsupported Notion Markdown structure or content limit")
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(200, result)
}
