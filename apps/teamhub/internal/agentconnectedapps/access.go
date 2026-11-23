// Package agentconnectedapps lets Agents search and call the tools of the
// connected apps their sponsor granted them, and holds the writes that need the
// sponsor's confirmation.
package agentconnectedapps

import (
	"github.com/vektah/gqlparser/v2/ast"
	"github.com/vektah/gqlparser/v2/parser"
)

// toolAccess is how TeamHub admits one provider tool call. The
// generic `teamhub apps execute` and the wrapped connector commands submit
// their calls to the same Execute, which decides here; neither the CLI nor
// the host decides whether a write waits for the sponsor.
type toolAccess int

const (
	// accessConfirm runs the call only after the sponsor approves its
	// confirmation card. It is the default: a tool TeamHub does not know is
	// treated as a write that needs confirmation.
	accessConfirm toolAccess = iota
	// accessRead runs the call at once.
	accessRead
	// accessWrite runs the call at once. These are writes nobody else sees
	// before a confirmed step (creating a draft, opening a chat) and writes
	// the host's permission reviewer judges (calendar events, uploads).
	accessWrite
)

// linearGraphQLTool runs any GraphQL document against Linear, so its slug
// alone cannot say whether a call reads or writes.
const linearGraphQLTool = "LINEAR_RUN_QUERY_OR_MUTATION"

// accessOf classifies a provider tool call by its exact slug, and a Linear
// GraphQL call by the operations its document declares.
func accessOf(slug string, arguments map[string]any) toolAccess {
	switch {
	case readTools[slug]:
		return accessRead
	case directWriteTools[slug]:
		return accessWrite
	case slug == linearGraphQLTool && onlyQueries(arguments["query_or_mutation"]):
		return accessRead
	default:
		return accessConfirm
	}
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

// directWriteTools are the wrapped commands' writes that run at once: the
// preparatory writes before a confirmed send (drafts, chats, attachments),
// archives, new folders, and the writes hosts send to their
// permission reviewer ("judge" in the CLI's connectorWriteApproval), which
// include paid media generation.
var directWriteTools = map[string]bool{
	"FAL_AI_SUBMIT_ASYNC_JOB":                              true,
	"FAL_AI_UPLOAD_FILE":                                   true,
	"FEISHU_MAIL_ARCHIVE":                                  true,
	"FEISHU_MAIL_CREATE_DRAFT":                             true,
	"FEISHU_MAIL_UPDATE_DRAFT":                             true,
	"FIGMA_ADD_A_COMMENT_TO_A_FILE":                        true,
	"GMAIL_BATCH_MODIFY_MESSAGES":                          true,
	"GMAIL_CREATE_EMAIL_DRAFT":                             true,
	"GMAIL_UPDATE_DRAFT":                                   true,
	"GOOGLECALENDAR_BATCH_EVENTS":                          true,
	"GOOGLECALENDAR_CREATE_EVENT":                          true,
	"GOOGLECALENDAR_DELETE_EVENT":                          true,
	"GOOGLECALENDAR_PATCH_EVENT":                           true,
	"GOOGLEDRIVE_CREATE_FOLDER":                            true,
	"GOOGLEDRIVE_RESUMABLE_UPLOAD":                         true,
	"HIGGSFIELD_MCP_GENERATE_IMAGE":                        true,
	"HIGGSFIELD_MCP_GENERATE_VIDEO":                        true,
	"HIGGSFIELD_MCP_MEDIA_CONFIRM":                         true,
	"HIGGSFIELD_MCP_MEDIA_UPLOAD":                          true,
	"OUTLOOK_ADD_MAIL_ATTACHMENT":                          true,
	"OUTLOOK_CALENDAR_CREATE_EVENT":                        true,
	"OUTLOOK_CANCEL_CALENDAR_EVENT":                        true,
	"OUTLOOK_CANCEL_EVENT":                                 true,
	"OUTLOOK_CREATE_ATTACHMENT_UPLOAD_SESSION":             true,
	"OUTLOOK_CREATE_DRAFT":                                 true,
	"OUTLOOK_CREATE_DRAFT_REPLY":                           true,
	"OUTLOOK_CREATE_REPLY_ALL_DRAFT":                       true,
	"OUTLOOK_DELETE_CALENDAR_EVENT":                        true,
	"OUTLOOK_DELETE_CALENDAR_EVENT_FROM_SPECIFIC_CALENDAR": true,
	"OUTLOOK_MOVE_MESSAGE":                                 true,
	"OUTLOOK_UPDATE_CALENDAR_EVENT":                        true,
	"OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR":            true,
	"OUTLOOK_UPDATE_EMAIL":                                 true,
	"SLACK_ADD_REACTION_TO_AN_ITEM":                        true,
	"SLACK_OPEN_DM":                                        true,
	"SLACK_REMOVE_REACTION_FROM_ITEM":                      true,
}
