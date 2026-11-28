// Package agentconnectedapps lets Agents search and call the tools of the
// connected apps their sponsor granted them, and holds the writes that need the
// sponsor's confirmation.
package agentconnectedapps

import (
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/vektah/gqlparser/v2/ast"
	"github.com/vektah/gqlparser/v2/parser"
)

// toolTier is how TeamHub classifies one provider tool call before combining it
// with the connection's write policy. Neither the CLI nor the host decides
// whether a connected-app write waits for the sponsor.
type toolTier int

const (
	// tierConfirmStrict always holds the call for a sponsor confirmation card
	// and never offers "Always allow", regardless of write_policy.
	tierConfirmStrict toolTier = iota
	// tierWorkspaceWrite holds non-destructive workspace mutations on "auto"
	// (offering "Always allow <App>"), runs immediately on "always_allow", and
	// holds without remember on "always_ask".
	tierWorkspaceWrite
	// tierDirectWrite runs immediately unless write_policy is "always_ask".
	tierDirectWrite
	// tierReadOnly runs immediately.
	tierReadOnly
)

// linearGraphQLTool runs any GraphQL document against Linear, so its slug
// alone cannot say whether a call reads or writes.
const linearGraphQLTool = "LINEAR_RUN_QUERY_OR_MUTATION"

// googleCalendarBatchTool runs arbitrary batched HTTP operations, including
// DELETE requests, so its arguments determine whether confirmation is strict.
const googleCalendarBatchTool = "GOOGLECALENDAR_BATCH_EVENTS"

// classifyTool assigns a provider tool call to its risk tier using explicit
// lists, Composio annotations/tags, and whole-token action-verb rules. Unknown
// mutating tools fail closed to tierConfirmStrict so always_allow never
// bypasses confirmation for unreviewed external mutations.
func classifyTool(tool composio.Tool, arguments map[string]any) toolTier {
	slug := tool.Slug
	switch {
	case strictConfirmTools[slug]:
		return tierConfirmStrict
	case readTools[slug]:
		return tierReadOnly
	case directWriteTools[slug]:
		return tierDirectWrite
	case slug == linearGraphQLTool:
		if onlyQueries(arguments["query_or_mutation"]) {
			return tierReadOnly
		}
		return tierConfirmStrict
	case slug == googleCalendarBatchTool:
		if calendarBatchHasOnlyNonDeleteOps(arguments) {
			return tierWorkspaceWrite
		}
		return tierConfirmStrict
	case tool.IsDestructiveHint() || hasDestructiveVerb(tool):
		return tierConfirmStrict
	case workspaceWriteTools[slug]:
		return tierWorkspaceWrite
	case tool.IsReadOnlyHint():
		return tierReadOnly
	case hasSafeReadOnlyVerb(tool):
		return tierReadOnly
	default:
		return tierConfirmStrict
	}
}

func actionTokens(tool composio.Tool) []string {
	slug := strings.ToUpper(strings.TrimSpace(tool.Slug))
	if slug == "" {
		return nil
	}
	rest := slug
	if prefix := strings.ToUpper(strings.TrimSpace(tool.Toolkit.Slug)); prefix != "" {
		prefix = strings.ReplaceAll(prefix, "-", "_")
		if strings.HasPrefix(rest, prefix+"_") {
			rest = strings.TrimPrefix(rest, prefix+"_")
		} else if idx := strings.IndexByte(rest, '_'); idx >= 0 {
			rest = rest[idx+1:]
		}
	} else if idx := strings.IndexByte(rest, '_'); idx >= 0 {
		rest = rest[idx+1:]
	}
	if rest == "" {
		return nil
	}
	raw := strings.Split(rest, "_")
	tokens := make([]string, 0, len(raw))
	for _, token := range raw {
		if token != "" {
			tokens = append(tokens, token)
		}
	}
	return tokens
}

func hasDestructiveVerb(tool composio.Tool) bool {
	tokens := actionTokens(tool)
	for i, token := range tokens {
		if destructiveActionVerbs[token] {
			return true
		}
		if token == "FORCE" && i+1 < len(tokens) && tokens[i+1] == "PUSH" {
			return true
		}
	}
	return false
}

func hasSafeReadOnlyVerb(tool composio.Tool) bool {
	tokens := actionTokens(tool)
	if len(tokens) == 0 || !readOnlyLeadingVerbs[tokens[0]] {
		return false
	}
	for i, token := range tokens {
		if destructiveActionVerbs[token] || mutationActionVerbs[token] {
			return false
		}
		if token == "FORCE" && i+1 < len(tokens) && tokens[i+1] == "PUSH" {
			return false
		}
	}
	return true
}

// strictConfirmTools are outbound messaging, file-sharing, destructive, and
// external-notification actions that always wait for explicit sponsor
// confirmation and never offer "Always allow".
var strictConfirmTools = map[string]bool{
	"DISCORDBOT_CREATE_MESSAGE":                            true,
	"FEISHU_MAIL_SEND_DRAFT":                               true,
	"GMAIL_BATCH_MODIFY_MESSAGES":                          true,
	"GMAIL_REPLY_TO_THREAD":                                true,
	"GMAIL_SEND_DRAFT":                                     true,
	"GMAIL_SEND_EMAIL":                                     true,
	"GOOGLECALENDAR_DELETE_EVENT":                          true,
	"GOOGLEDRIVE_RESUMABLE_UPLOAD":                         true,
	"OUTLOOK_CANCEL_CALENDAR_EVENT":                        true,
	"OUTLOOK_CANCEL_EVENT":                                 true,
	"OUTLOOK_DELETE_CALENDAR_EVENT":                        true,
	"OUTLOOK_DELETE_CALENDAR_EVENT_FROM_SPECIFIC_CALENDAR": true,
	"OUTLOOK_MOVE_MESSAGE":                                 true,
	"OUTLOOK_REPLY_EMAIL":                                  true,
	"OUTLOOK_SEND_DRAFT":                                   true,
	"OUTLOOK_SEND_EMAIL":                                   true,
	"SLACK_SEND_MESSAGE":                                   true,
	"SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK":               true,
}

var destructiveActionVerbs = map[string]bool{
	"BROADCAST": true,
	"CANCEL":    true,
	"CHARGE":    true,
	"DELETE":    true,
	"DESTROY":   true,
	"FORWARD":   true,
	"GRANT":     true,
	"INVITE":    true,
	"MERGE":     true,
	"PAY":       true,
	"POST":      true,
	"PUBLISH":   true,
	"PURCHASE":  true,
	"PURGE":     true,
	"REMOVE":    true,
	"REPLY":     true,
	"REVOKE":    true,
	"SEND":      true,
	"SHARE":     true,
	"TRASH":     true,
	"TWEET":     true,
	"UPLOAD":    true,
}

var readOnlyLeadingVerbs = map[string]bool{
	"CHECK":    true,
	"DOWNLOAD": true,
	"EXPORT":   true,
	"FETCH":    true,
	"FIND":     true,
	"GET":      true,
	"INSPECT":  true,
	"LIST":     true,
	"LOOKUP":   true,
	"QUERY":    true,
	"READ":     true,
	"RETRIEVE": true,
	"SEARCH":   true,
	"TEST":     true,
}

var mutationActionVerbs = map[string]bool{
	"ADD":       true,
	"APPEND":    true,
	"ARCHIVE":   true,
	"ASSIGN":    true,
	"CANCEL":    true,
	"CLONE":     true,
	"CLOSE":     true,
	"COMMENT":   true,
	"COPY":      true,
	"CREATE":    true,
	"DISABLE":   true,
	"EDIT":      true,
	"ENABLE":    true,
	"EXECUTE":   true,
	"FORK":      true,
	"IMPORT":    true,
	"INSERT":    true,
	"LABEL":     true,
	"LINK":      true,
	"LOCK":      true,
	"MODIFY":    true,
	"MOVE":      true,
	"MUTATION":  true,
	"PATCH":     true,
	"PIN":       true,
	"POST":      true,
	"PUT":       true,
	"REACT":     true,
	"REMOVE":    true,
	"REOPEN":    true,
	"REPLACE":   true,
	"RUN":       true,
	"SET":       true,
	"STAR":      true,
	"START":     true,
	"STOP":      true,
	"SUBMIT":    true,
	"SYNC":      true,
	"TAG":       true,
	"TRIGGER":   true,
	"UNARCHIVE": true,
	"UNASSIGN":  true,
	"UNLABEL":   true,
	"UNLINK":    true,
	"UNLOCK":    true,
	"UNPIN":     true,
	"UNSTAR":    true,
	"UNTAG":     true,
	"UNWATCH":   true,
	"UPDATE":    true,
	"UPLOAD":    true,
	"WATCH":     true,
	"WRITE":     true,
}

// calendarBatchHasOnlyNonDeleteOps reports whether GOOGLECALENDAR_BATCH_EVENTS
// explicitly lists non-empty operations where none uses HTTP DELETE. Missing,
// empty, or malformed operation lists fail closed to strict confirmation.
func calendarBatchHasOnlyNonDeleteOps(arguments map[string]any) bool {
	if len(arguments) == 0 {
		return false
	}
	var rawOps any
	if ops, ok := arguments["operations"]; ok {
		rawOps = ops
	} else if reqs, ok := arguments["requests"]; ok {
		rawOps = reqs
	} else {
		return false
	}
	entries, ok := rawOps.([]any)
	if !ok || len(entries) == 0 {
		return false
	}
	for _, entry := range entries {
		item, ok := entry.(map[string]any)
		if !ok {
			return false
		}
		method, ok := item["method"].(string)
		method = strings.ToUpper(strings.TrimSpace(method))
		if !ok || method == "" || method == "DELETE" {
			return false
		}
	}
	return true
}

// onlyQueries reports whether document is a GraphQL document whose operations
// are all queries. A document that does not parse, declares no operation, or
// declares a mutation or subscription is held like any other write.
func onlyQueries(document any) bool {
	text, ok := document.(string)
	if !ok {
		return false
	}
	parsed, err := parser.ParseQuery(&ast.Source{Input: text})
	if err != nil || len(parsed.Operations) == 0 {
		return false
	}
	for _, operation := range parsed.Operations {
		if operation.Operation != ast.Query {
			return false
		}
	}
	return true
}

// readTools are the provider reads the wrapped connector commands make,
// including the draft reads TeamHub makes to build a send-draft card, plus the
// Discord reads of the connected guild, its channels, threads, and messages
// (which run at once only inside the connected guild; see discordReadInScope), the
// Slack reads Agents make through the generic execute to find direct messages
// and the people in them, and the Linear reads, which have no wrapped command.
// A read the generic execute names outside this list is held like a write.
var readTools = map[string]bool{
	"DISCORDBOT_GET_CONNECTED_GUILD":                      true,
	"DISCORDBOT_GET_GUILD":                                true,
	"DISCORDBOT_LIST_GUILD_CHANNELS":                      true,
	"DISCORDBOT_GET_CHANNEL":                              true,
	"DISCORDBOT_GET_ACTIVE_GUILD_THREADS":                 true,
	"DISCORDBOT_LIST_PUBLIC_ARCHIVED_THREADS":             true,
	"DISCORDBOT_LIST_MESSAGES":                            true,
	"DISCORDBOT_GET_MESSAGE":                              true,
	"DISCORDBOT_LIST_PINNED_MESSAGES":                     true,
	"FAL_AI_GET_MODELS":                                   true,
	"FEISHU_MAIL_GET_ATTACHMENT":                          true,
	"FEISHU_MAIL_GET_DRAFT":                               true,
	"FEISHU_MAIL_GET_MESSAGE":                             true,
	"FEISHU_MAIL_GET_THREAD":                              true,
	"FEISHU_MAIL_LIST_MESSAGES":                           true,
	"FAL_AI_GET_PRICING":                                  true,
	"FAL_AI_GET_QUEUE_REQUEST_RESULT":                     true,
	"FAL_AI_QUEUE_GET_STATUS":                             true,
	"FIGMA_GET_COMMENTS_IN_A_FILE":                        true,
	"FIGMA_GET_FILE_JSON":                                 true,
	"FIGMA_GET_FILE_NODES":                                true,
	"FIGMA_RENDER_IMAGES_OF_FILE_NODES":                   true,
	"GITHUB_GET_AN_ISSUE":                                 true,
	"GITHUB_GET_A_PULL_REQUEST":                           true,
	"GITHUB_GET_A_REPOSITORY":                             true,
	"GITHUB_GET_A_REPOSITORY_README":                      true,
	"GITHUB_GET_THE_AUTHENTICATED_USER":                   true,
	"GITHUB_LIST_ISSUE_COMMENTS":                          true,
	"GITHUB_LIST_PULL_REQUESTS_FILES":                     true,
	"GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER": true,
	"GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS":              true,
	"GMAIL_FETCH_EMAILS":                                  true,
	"GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID":                   true,
	"GMAIL_FETCH_MESSAGE_BY_THREAD_ID":                    true,
	"GMAIL_GET_ATTACHMENT":                                true,
	"GMAIL_GET_DRAFT":                                     true,
	"GMAIL_GET_PROFILE":                                   true,
	"GOOGLECALENDAR_EVENTS_GET":                           true,
	"GOOGLECALENDAR_EVENTS_LIST":                          true,
	"GOOGLECALENDAR_FREE_BUSY_QUERY":                      true,
	"GOOGLECALENDAR_GET_CALENDAR":                         true,
	"GOOGLECALENDAR_LIST_CALENDARS":                       true,
	"GOOGLEDRIVE_DOWNLOAD_FILE":                           true,
	"GOOGLEDRIVE_EXPORT_GOOGLE_WORKSPACE_FILE":            true,
	"GOOGLEDRIVE_FIND_FILE":                               true,
	"GOOGLEDRIVE_GET_FILE_METADATA":                       true,
	"HIGGSFIELD_MCP_JOB_STATUS":                           true,
	"HIGGSFIELD_MCP_MODELS_EXPLORE":                       true,
	"LINEAR_GET_ALL_LINEAR_TEAMS":                         true,
	"LINEAR_GET_ATTACHMENT":                               true,
	"LINEAR_GET_COMMENT":                                  true,
	"LINEAR_GET_CURRENT_USER":                             true,
	"LINEAR_GET_CYCLES_BY_TEAM_ID":                        true,
	"LINEAR_GET_ISSUE_DEFAULTS":                           true,
	"LINEAR_GET_LINEAR_ISSUE":                             true,
	"LINEAR_GET_LINEAR_PROJECT":                           true,
	"LINEAR_GET_PROJECT_UPDATE":                           true,
	"LINEAR_LIST_COMMENTS":                                true,
	"LINEAR_LIST_ISSUES_BY_TEAM_ID":                       true,
	"LINEAR_LIST_ISSUE_DRAFTS":                            true,
	"LINEAR_LIST_LINEAR_CYCLES":                           true,
	"LINEAR_LIST_LINEAR_ISSUES":                           true,
	"LINEAR_LIST_LINEAR_LABELS":                           true,
	"LINEAR_LIST_LINEAR_PROJECTS":                         true,
	"LINEAR_LIST_LINEAR_STATES":                           true,
	"LINEAR_LIST_LINEAR_TEAMS":                            true,
	"LINEAR_LIST_LINEAR_USERS":                            true,
	"LINEAR_LIST_PROJECT_UPDATES":                         true,
	"LINEAR_SEARCH_ISSUES":                                true,
	"LINEAR_VALIDATE_CREDENTIAL":                          true,
	"LINEAR_WHO_AM_I":                                     true,
	"NOTION_GET_PAGE_MARKDOWN":                            true,
	"NOTION_RETRIEVE_PAGE":                                true,
	"NOTION_SEARCH_NOTION_PAGE":                           true,
	"OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT":                 true,
	"OUTLOOK_GET_CALENDAR_EVENT":                          true,
	"OUTLOOK_GET_CALENDAR_SCHEDULE":                       true,
	"OUTLOOK_GET_CALENDAR_VIEW":                           true,
	"OUTLOOK_GET_EVENT":                                   true,
	"OUTLOOK_GET_MAILBOX_SETTINGS":                        true,
	"OUTLOOK_GET_MESSAGE":                                 true,
	"OUTLOOK_LIST_CALENDARS":                              true,
	"OUTLOOK_LIST_EVENTS":                                 true,
	"OUTLOOK_LIST_MESSAGES":                               true,
	"OUTLOOK_LIST_OUTLOOK_ATTACHMENTS":                    true,
	"OUTLOOK_QUERY_EMAILS":                                true,
	"SLACK_DOWNLOAD_SLACK_FILE":                           true,
	"SLACK_FETCH_CONVERSATION_HISTORY":                    true,
	"SLACK_FETCH_ITEM_REACTIONS":                          true,
	"SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION":      true,
	"SLACK_FIND_CHANNELS":                                 true,
	"SLACK_FIND_USER_BY_EMAIL_ADDRESS":                    true,
	"SLACK_FIND_USERS":                                    true,
	"SLACK_GET_UNREAD_MESSAGES_FROM_USER":                 true,
	"SLACK_LIST_ALL_CHANNELS":                             true,
	"SLACK_LIST_ALL_USERS":                                true,
	"SLACK_LIST_CONVERSATIONS":                            true,
	"SLACK_LIST_UNREAD_CHANNEL_MESSAGES":                  true,
	"SLACK_RETRIEVE_CONVERSATION_MEMBERS_LIST":            true,
	"SLACK_RETRIEVE_DETAILED_INFORMATION_ABOUT_A_FILE":    true,
	"SLACK_RETRIEVE_MESSAGE_PERMALINK_URL":                true,
	"SLACK_SEARCH_MESSAGES":                               true,
	"SLACK_TEST_AUTH":                                     true,
}

// workspaceWriteTools are known non-destructive workspace mutations where
// "auto" asks with "Always allow <App>" and "always_allow" runs directly.
var workspaceWriteTools = map[string]bool{
	"FAL_AI_SUBMIT_ASYNC_JOB":                           true,
	"FIGMA_ADD_A_COMMENT_TO_A_FILE":                     true,
	"GITHUB_ADD_LABELS_TO_AN_ISSUE":                     true,
	"GITHUB_CREATE_A_PULL_REQUEST":                      true,
	"GITHUB_CREATE_A_REVIEW_COMMENT_FOR_A_PULL_REQUEST": true,
	"GITHUB_CREATE_AN_ISSUE":                            true,
	"GITHUB_CREATE_AN_ISSUE_COMMENT":                    true,
	"GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS":             true,
	"GITHUB_UPDATE_A_PULL_REQUEST":                      true,
	"GITHUB_UPDATE_AN_ISSUE":                            true,
	"GITHUB_UPDATE_AN_ISSUE_COMMENT":                    true,
	"GOOGLECALENDAR_CREATE_EVENT":                       true,
	"GOOGLECALENDAR_PATCH_EVENT":                        true,
	"HIGGSFIELD_MCP_GENERATE_IMAGE":                     true,
	"HIGGSFIELD_MCP_GENERATE_VIDEO":                     true,
	"LINEAR_ADD_LABEL_TO_ISSUE":                         true,
	"LINEAR_CREATE_COMMENT":                             true,
	"LINEAR_CREATE_ISSUE":                               true,
	"LINEAR_CREATE_ISSUE_LABEL":                         true,
	"LINEAR_CREATE_LINEAR_COMMENT":                      true,
	"LINEAR_CREATE_LINEAR_ISSUE":                        true,
	"LINEAR_CREATE_LINEAR_PROJECT":                      true,
	"LINEAR_CREATE_PROJECT_UPDATE":                      true,
	"LINEAR_FIND_OR_CREATE_ISSUE":                       true,
	"LINEAR_UPDATE_COMMENT":                             true,
	"LINEAR_UPDATE_ISSUE":                               true,
	"LINEAR_UPDATE_LINEAR_ISSUE":                        true,
	"LINEAR_UPDATE_LINEAR_PROJECT":                      true,
	"NOTION_APPEND_BLOCK_CHILDREN":                      true,
	"NOTION_INSERT_ROW_DATABASE":                        true,
	"NOTION_UPDATE_BLOCK":                               true,
	"NOTION_UPDATE_PAGE":                                true,
	"NOTION_UPDATE_PAGE_MARKDOWN":                       true,
	"NOTION_UPDATE_ROW_DATABASE":                        true,
	"OUTLOOK_CALENDAR_CREATE_EVENT":                     true,
	"OUTLOOK_UPDATE_CALENDAR_EVENT":                     true,
	"OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR":         true,
	"OUTLOOK_UPDATE_EMAIL":                              true,
	"SLACK_ADD_REACTION_TO_AN_ITEM":                     true,
}

// directWriteTools are genuinely safe, non-destructive, non-outbound
// preparatory writes (private drafts, draft attachments, empty folders,
// additive Notion pages with history, opening a DM).
var directWriteTools = map[string]bool{
	"FAL_AI_UPLOAD_FILE":                       true,
	"FEISHU_MAIL_ARCHIVE":                      true,
	"FEISHU_MAIL_CREATE_DRAFT":                 true,
	"FEISHU_MAIL_UPDATE_DRAFT":                 true,
	"GMAIL_CREATE_EMAIL_DRAFT":                 true,
	"GMAIL_UPDATE_DRAFT":                       true,
	"GOOGLEDRIVE_CREATE_FOLDER":                true,
	"HIGGSFIELD_MCP_MEDIA_CONFIRM":             true,
	"HIGGSFIELD_MCP_MEDIA_UPLOAD":              true,
	"NOTION_ADD_MULTIPLE_PAGE_CONTENT":         true,
	"NOTION_CREATE_NOTION_PAGE":                true,
	"OUTLOOK_ADD_MAIL_ATTACHMENT":              true,
	"OUTLOOK_CREATE_ATTACHMENT_UPLOAD_SESSION": true,
	"OUTLOOK_CREATE_DRAFT":                     true,
	"OUTLOOK_CREATE_DRAFT_REPLY":               true,
	"OUTLOOK_CREATE_REPLY_ALL_DRAFT":           true,
	"SLACK_OPEN_DM":                            true,
	"SLACK_REMOVE_REACTION_FROM_ITEM":          true,
}
