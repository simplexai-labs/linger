package voicelive

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// ToolComputerBrowser drives the Chrome on the owner's Local Computer. It is
// offered only when the session's Agent has one.
const ToolComputerBrowser = "computer_browser"

// MaxBrowserCallsPerTurn bounds how long the live voice keeps trying on its
// own within one user turn before it must ask the user or hand the work over.
const MaxBrowserCallsPerTurn = 6

// MaxBrowserPageRunes bounds the page text read to the live model.
const MaxBrowserPageRunes = 6000

// BrowserTool describes the native browser operations offered to Live.
var BrowserTool = Tool{
	Name: ToolComputerBrowser,
	Description: "Operate the Chrome on the user's own Local Computer yourself while you keep talking, like sitting next to them; they can watch it on their own desktop. " +
		"Use it when the user wants to open, browse, search or read a website together with you or asks what is on that page; a site the user names is opened here, not answered with web search. " +
		"action: open (url), look (read the page as text with refs), click (ref), type (ref, text, submit to press Enter), back, close (close this tab and return to the page it came from, when the user wants a page closed). Every result is the page as text with refs; read it before you click or type and never guess what a page says. " +
		"A long page comes in parts (part 1 of parts): to see what is further down, such as more search results or the rest of an article, look with part 2 and so on, or look with find set to words you expect there (a title, a heading). " +
		"Before the first call of a request, tell the user in one natural sentence what you are opening or looking for; after that say only what you found and what comes next, never each step. A login, QR code or CAPTCHA is the user's: stop and ask them to take over on their own desktop, then look again when they say they are done. " +
		"Set commits=true on a click that sends, submits, posts, pays, orders, transfers, confirms or deletes something in the user's name, judged by what it does in any language; it and every Enter return needs_confirmation: restate it, and call again with confirmed=true only after the user says yes. " +
		"If a few tries make no progress (an element that will not respond, a page that will not load), stop and tell the user where it is stuck. Long work across many pages or that ends in a document is start_task: say in its goal what is done and the page to go on from. still_working means a slow step goes on while you keep talking; you are told when its page arrives.",
	Parameters: objectSchema([]string{"action", "commits"}, map[string]any{
		"action":    map[string]any{"type": "string", "enum": []string{"open", "look", "click", "type", "back", "close"}},
		"url":       stringProperty("For open: the address"),
		"ref":       stringProperty("For click and type: the element ref from the latest page text"),
		"text":      stringProperty("For type: the text to enter"),
		"submit":    map[string]any{"type": "boolean", "description": "For type: press Enter after typing"},
		"part":      map[string]any{"type": "integer", "description": "For look: which part of a long page to read, from 1"},
		"find":      stringProperty("For look: words to find on the page; returns the part that holds them"),
		"commits":   map[string]any{"type": "boolean", "description": "For click: whether it sends, submits, pays, orders or deletes something in the user's name; false for anything else"},
		"confirmed": map[string]any{"type": "boolean", "description": "Only after the user said yes to this exact click or Enter"},
	}),
}

// browserConnectionSteps is where the Web app connects the owner's Chrome.
// The live model cannot post the connection card an Agent posts, so it reads
// out these steps instead of guessing at the interface.
const browserConnectionSteps = "Give them the exact steps, not a guess: click their profile picture at the bottom of the left sidebar, choose Settings, open Computers, select this computer, click Connect Chrome, then follow the three steps there (install the Playwright Extension in Chrome, copy the token it shows, paste it and connect). Do not say you cannot see their screen; these steps are the whole answer."

// BrowserConnectionDetail tells the live model what to say when the owner's
// Chrome is not connected or is busy, so nothing ran: the user connects it
// once under Settings, Computers, or the work goes to a background task,
// which can use their Chrome through the desktop.
func BrowserConnectionDetail(code string) (string, bool) {
	switch code {
	case "browser_connection_required":
		return "Nothing was done: the user's Chrome is not connected to you yet. Tell them so in one sentence and that they can connect it once in Settings under Computers. " + browserConnectionSteps + " Until then offer to do it as a background task with start_task (surface web). Never call this tool again in this call until they say it is connected, and never blame Chrome, sleep or a frozen window.", true
	case "browser_connection_invalid":
		return "Nothing was done: the saved connection to the user's Chrome no longer works. Tell them so in one sentence and that they can reconnect it in Settings under Computers. " + browserConnectionSteps + " Until then offer to do it as a background task with start_task (surface web). Never call this tool again in this call until they say it is reconnected.", true
	case "browser_busy":
		return "Nothing was done: a background task is using the user's Chrome right now. Tell them so in one sentence and offer to try again when that task finishes; do not call this tool again right away.", true
	}
	return "", false
}

// BrowserArguments holds one browser action and its explicit confirmation.
type BrowserArguments struct {
	Action string `json:"action"`
	URL    string `json:"url"`
	Ref    string `json:"ref"`
	Text   string `json:"text"`
	Submit bool   `json:"submit"`
	// Part and Find choose which part of a long page a look returns.
	Part LoosePart `json:"part"`
	Find string    `json:"find"`
	// Commits is the model's word that a click acts in the user's name.
	Commits LooseBool `json:"commits"`
	// Confirmed is the model's word that the user said yes; TeamHub
	// checks it against the prompt the user heard.
	Confirmed LooseBool `json:"confirmed"`
}

var refLinePattern = regexp.MustCompile(`"([^"]{1,80})"[^\n]*\[ref=([A-Za-z0-9_-]+)\]`)

// BrowserRisk says what a browser action would do in the user's name when
// it may send, pay or delete: pressing Enter in a field, or a click the
// model marks as commits. lastPage is the page text the ref came from.
func BrowserRisk(args BrowserArguments, lastPage string) (string, bool) {
	ref := strings.TrimSpace(args.Ref)
	switch args.Action {
	case "type":
		if args.Submit {
			return "Will type “" + Snippet(args.Text) + "” into field " + ref + " on the local browser and press Enter", true
		}
	case "click":
		if args.Commits {
			label := "element " + ref
			for _, match := range refLinePattern.FindAllStringSubmatch(lastPage, -1) {
				if match[2] == ref {
					label = "“" + match[1] + "”"
					break
				}
			}
			return "Will click " + label + " on the local browser", true
		}
	}
	return "", false
}

// BrowserCall maps a live browser action to the Computer's browser tool, or
// reports the arguments invalid.
func BrowserCall(args BrowserArguments) (string, map[string]any, bool) {
	ref := strings.TrimSpace(args.Ref)
	switch args.Action {
	case "open":
		url := strings.TrimSpace(args.URL)
		if url == "" {
			return "", nil, false
		}
		if !strings.Contains(url, "://") {
			url = "https://" + url
		}
		return "browser_navigate", map[string]any{"url": url}, true
	case "look":
		return "browser_snapshot", map[string]any{}, true
	case "click":
		if ref == "" {
			return "", nil, false
		}
		return "browser_click", map[string]any{"target": ref, "element": "element " + ref}, true
	case "type":
		if ref == "" {
			return "", nil, false
		}
		return "browser_type", map[string]any{"target": ref, "element": "field " + ref, "text": args.Text, "submit": args.Submit}, true
	case "back":
		return "browser_navigate_back", map[string]any{}, true
	case "close":
		// TeamHub picks the tab to close and the one to return to.
		return "browser_tabs", map[string]any{"action": "close"}, true
	}
	return "", nil, false
}

var (
	ranCodePattern = regexp.MustCompile("(?s)### Ran Playwright code\n```[a-z]*\n.*?```\n*")
	urlLinePattern = regexp.MustCompile(`(?m)^\s*- /url: .*\n`)
)

var pageURLPattern = regexp.MustCompile(`(?m)Page URL: (\S+)`)

// BrowserPageURL is the address of a browser page text, or "" when it has
// none.
func BrowserPageURL(page string) string {
	if match := pageURLPattern.FindStringSubmatch(page); match != nil {
		return match[1]
	}
	return ""
}

// BrowserPage trims a browser tool result to what a voice model needs and
// returns the part a look asked for. It drops the code that ran, link
// targets, empty layout lines and citation counts, but no word or ref the page
// shows. A page longer than MaxBrowserPageRunes is cut at line ends into parts
// that each repeat the tabs, address and title above the snapshot; find picks
// the part holding most of its words, otherwise part (from 1) is used.
func BrowserPage(text string, part int, find string) BrowserPageResult {
	text = ranCodePattern.ReplaceAllString(text, "")
	text = urlLinePattern.ReplaceAllString(text, "")
	text = strings.TrimSpace(text)
	head, body, tail := text, "", ""
	if at := strings.Index(text, snapshotHeading); at >= 0 {
		head = strings.TrimSpace(text[:at])
		body = strings.TrimPrefix(text[at+len(snapshotHeading):], "\n")
		body = strings.TrimPrefix(body, "```yaml\n")
		if end := strings.Index(body, "\n```"); end >= 0 {
			body, tail = body[:end], strings.TrimSpace(body[end+len("\n```"):])
		}
	}
	lines := compactSnapshot(body)
	budget := MaxBrowserPageRunes - utf8.RuneCountInString(head) - utf8.RuneCountInString(tail) - 64
	parts := splitLines(lines, max(budget, MaxBrowserPageRunes/2))
	chosen := min(max(part, 1), len(parts))
	found := true
	if terms := strings.Fields(strings.ToLower(find)); len(terms) > 0 {
		// The model often sends a few words ("ticket price cost"): the part
		// holding most of them wins, the earliest on a tie.
		found = false
		best := 0
		for index, candidate := range parts {
			candidate = strings.ToLower(candidate)
			hits := 0
			for _, term := range terms {
				if strings.Contains(candidate, term) {
					hits++
				}
			}
			if hits > best {
				chosen, found, best = index+1, true, hits
			}
		}
	}
	page := head
	if body != "" {
		page += "\n" + snapshotHeading
		if len(parts) > 1 {
			page += fmt.Sprintf(" (part %d of %d)", chosen, len(parts))
		}
		page += "\n```yaml\n" + parts[chosen-1] + "\n```"
	}
	if tail != "" && chosen == len(parts) {
		page += "\n" + tail
	}
	page, cut := Truncate(page, MaxBrowserPageRunes)
	return BrowserPageResult{Page: page, Part: chosen, Parts: len(parts), Found: found, Truncated: cut}
}

// BrowserPageResult is one part of a page as the live model reads it.
type BrowserPageResult struct {
	Page        string
	Part, Parts int
	// Found is false when find matched nothing; Page is then part 1 or the
	// part asked for.
	Found     bool
	Truncated bool
}

const snapshotHeading = "### Snapshot"

var (
	// layoutLinePattern is a line of a role that is never pressed, with no
	// name and no text of its own, such as "- generic [ref=e1]:".
	layoutLinePattern = regexp.MustCompile(`^\s*- (?:generic|group|list|listitem|region|navigation|banner|main|contentinfo|complementary|article|section|separator|paragraph|figure|rowgroup)(?: \[[^\]]*\])*:?\s*$`)
	// citationCountPattern is a source badge's count, such as "+2".
	citationCountPattern = regexp.MustCompile(`^\s*- generic(?: \[[^\]]*\])*: "?\+\d+"?\s*$`)
	// pressableCursorPattern marks a link or button as clickable, which its
	// role already says.
	pressableCursorPattern = regexp.MustCompile(`^(\s*- (?:link|button)\b.*?) \[cursor=pointer\]`)
)

// compactSnapshot drops snapshot lines that carry no word the page shows and
// nothing to press.
func compactSnapshot(body string) []string {
	var lines []string
	for line := range strings.SplitSeq(body, "\n") {
		if strings.TrimSpace(line) == "" || citationCountPattern.MatchString(line) {
			continue
		}
		if layoutLinePattern.MatchString(line) && !strings.Contains(line, "[cursor=pointer]") {
			continue
		}
		lines = append(lines, pressableCursorPattern.ReplaceAllString(line, "$1"))
	}
	return lines
}

// splitLines joins lines into parts of at most budget runes, cutting only at
// line ends; a single longer line is cut on its own.
func splitLines(lines []string, budget int) []string {
	parts := []string{""}
	size := 0
	for _, line := range lines {
		length := utf8.RuneCountInString(line) + 1
		if size > 0 && size+length > budget {
			parts = append(parts, "")
			size = 0
		}
		if parts[len(parts)-1] != "" {
			parts[len(parts)-1] += "\n"
		}
		parts[len(parts)-1] += line
		size += length
	}
	return parts
}

// LoosePart reads a part number the model may send as a number or a string.
type LoosePart int

// UnmarshalJSON accepts 2 and "2"; anything else reads as 0, the first part.
func (p *LoosePart) UnmarshalJSON(raw []byte) error {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return err
	}
	switch typed := value.(type) {
	case float64:
		*p = LoosePart(typed)
	case string:
		number, _ := strconv.Atoi(strings.TrimSpace(typed))
		*p = LoosePart(number)
	default:
		*p = 0
	}
	return nil
}
