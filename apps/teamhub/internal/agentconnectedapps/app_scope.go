package agentconnectedapps

import "strings"

// appToolScopes narrow an app that shares its Composio toolkit with another
// app to the tools it is for. Outlook Calendar connects through the Outlook
// toolkit, whose tools also read and send mail; an Agent granted only Outlook
// Calendar must not reach them. Feishu Mail and Feishu IM both record the
// feishu toolkit, so each is limited to its own tools.
var appToolScopes = map[string]func(slug string) bool{
	"outlook_calendar": isOutlookCalendarTool,
	"feishu_mail":      isFeishuMailTool,
	"feishu_im":        isFeishuIMTool,
}

// appAllowsTool reports whether a connection of appKey may search or run slug.
func appAllowsTool(appKey, slug string) bool {
	allows, scoped := appToolScopes[appKey]
	return !scoped || allows(slug)
}

// isFeishuMailTool reports whether slug is one of Feishu Mail's tools.
func isFeishuMailTool(slug string) bool { return strings.HasPrefix(slug, "FEISHU_MAIL_") }

// isFeishuIMTool reports whether slug is one of Feishu IM's tools.
func isFeishuIMTool(slug string) bool { return strings.HasPrefix(slug, "FEISHU_IM_") }

// outlookCalendarWords are the slug words of Outlook calendar tools; no mail,
// contact or task tool uses them.
var outlookCalendarWords = map[string]bool{
	"CALENDAR": true, "CALENDARS": true, "EVENT": true, "EVENTS": true,
	"SCHEDULE": true, "MEETING": true, "REMINDER": true, "REMINDERS": true,
}

func isOutlookCalendarTool(slug string) bool {
	if !strings.HasPrefix(slug, "OUTLOOK_") {
		return false
	}
	if slug == "OUTLOOK_GET_SUPPORTED_TIME_ZONES" {
		return true
	}
	for _, word := range strings.Split(strings.TrimPrefix(slug, "OUTLOOK_"), "_") {
		if outlookCalendarWords[word] {
			return true
		}
	}
	return false
}
