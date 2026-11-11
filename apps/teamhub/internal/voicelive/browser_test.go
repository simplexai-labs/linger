package voicelive

import (
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestBrowserActionsMapToTheComputersBrowserTools(t *testing.T) {
	for _, check := range []struct {
		args BrowserArguments
		tool string
		ok   bool
	}{
		{BrowserArguments{Action: "open", URL: "news.ycombinator.com"}, "browser_navigate", true},
		{BrowserArguments{Action: "open"}, "", false},
		{BrowserArguments{Action: "look"}, "browser_snapshot", true},
		{BrowserArguments{Action: "click", Ref: "e61"}, "browser_click", true},
		{BrowserArguments{Action: "click"}, "", false},
		{BrowserArguments{Action: "type", Ref: "e47", Text: "Anthropic", Submit: true}, "browser_type", true},
		{BrowserArguments{Action: "back"}, "browser_navigate_back", true},
		{BrowserArguments{Action: "run_code"}, "", false},
	} {
		tool, arguments, ok := BrowserCall(check.args)
		if tool != check.tool || ok != check.ok {
			t.Fatalf("%+v: got %q %v", check.args, tool, ok)
		}
		if tool == "browser_navigate" && arguments["url"] != "https://news.ycombinator.com" {
			t.Fatalf("url not completed: %v", arguments)
		}
		if tool == "browser_type" && (arguments["target"] != "e47" || arguments["submit"] != true) {
			t.Fatalf("type arguments: %v", arguments)
		}
	}
	if len(BrowserTool.Description) > 2000 || BrowserTool.Parameters["type"] != "object" {
		t.Fatal("browser tool spec is invalid")
	}
}

func TestBrowserPageKeepsThePageAndDropsNoise(t *testing.T) {
	shown := BrowserPage("### Ran Playwright code\n```js\nawait page.goto('x');\n```\n### Page\n- Page URL: https://x\n### Snapshot\n```yaml\n- generic [ref=e1]:\n  - list [ref=e2]:\n    - listitem [ref=e3]:\n      - link \"News\" [ref=e4] [cursor=pointer]:\n        - /url: https://x/news\n      - link [ref=e5] [cursor=pointer]:\n        - heading \"Untitled link text\" [level=2] [ref=e6]\n      - generic [ref=e7]: Zhihu\n      - generic [ref=e8]: \"+2\"\n      - strong [aria-hidden] [ref=e9]: Primeval Forest\n      - generic [ref=e10] [cursor=pointer]\n```\n", 0, "")
	page := shown.Page
	for _, gone := range []string{"page.goto", "/url:", "[ref=e1]", "[ref=e2]", "[ref=e3]", `"+2"`} {
		if strings.Contains(page, gone) {
			t.Fatalf("%s stays in %q", gone, page)
		}
	}
	// Every word and everything to press stays, hidden-from-reader text too.
	for _, kept := range []string{"Page URL: https://x", `link "News" [ref=e4]`, "link [ref=e5]", `heading "Untitled link text"`, "Zhihu", "Primeval Forest", "[ref=e10] [cursor=pointer]"} {
		if !strings.Contains(page, kept) {
			t.Fatalf("%s is missing from %q", kept, page)
		}
	}
	if strings.Contains(page, `link "News" [ref=e4] [cursor=pointer]`) || shown.Parts != 1 || shown.Truncated {
		t.Fatalf("shown: %+v", shown)
	}
}

func TestBrowserPageSplitsALongPageIntoParts(t *testing.T) {
	var snapshot strings.Builder
	for index := range 400 {
		fmt.Fprintf(&snapshot, "- link \"Result %d about the lake\" [ref=e%d] [cursor=pointer]\n", index, index)
	}
	text := "### Open tabs\n- 0: (current) [Search](https://bing.test)\n### Page\n- Page URL: https://bing.test\n### Snapshot\n```yaml\n" + snapshot.String() + "```\n"
	first := BrowserPage(text, 0, "")
	if first.Parts < 3 || first.Part != 1 || first.Truncated || !strings.Contains(first.Page, "Result 0 about") || strings.Contains(first.Page, "Result 399 about") {
		t.Fatalf("first: part %d of %d, truncated %v", first.Part, first.Parts, first.Truncated)
	}
	last := BrowserPage(text, 99, "")
	if last.Part != last.Parts || !strings.Contains(last.Page, "Result 399 about") {
		t.Fatalf("last: part %d of %d", last.Part, last.Parts)
	}
	// Each part keeps the tabs and address the tab handling reads.
	for _, shown := range []BrowserPageResult{first, last} {
		if !strings.Contains(shown.Page, "### Open tabs") || BrowserPageURL(shown.Page) != "https://bing.test" ||
			!strings.Contains(shown.Page, fmt.Sprintf("(part %d of %d)", shown.Part, shown.Parts)) || utf8.RuneCountInString(shown.Page) > MaxBrowserPageRunes {
			t.Fatalf("part %d: %q", shown.Part, shown.Page[:200])
		}
	}
	found := BrowserPage(text, 0, "result 250 ABOUT")
	if !found.Found || found.Part == 1 || !strings.Contains(found.Page, "Result 250 about") {
		t.Fatalf("find: part %d found %v", found.Part, found.Found)
	}
	if some := BrowserPage(text, 0, "price 250 tickets"); !some.Found || !strings.Contains(some.Page, "Result 250 about") {
		t.Fatalf("some words: part %d found %v", some.Part, some.Found)
	}
	if missing := BrowserPage(text, 2, "no such words"); missing.Found || missing.Part != 2 {
		t.Fatalf("missing: part %d found %v", missing.Part, missing.Found)
	}
}

func TestBrowserArgumentsReadAPartGivenAsText(t *testing.T) {
	var args BrowserArguments
	if err := DecodeArguments(`{"action":"look","part":"2","find":"Zhihu"}`, &args); err != nil || args.Part != 2 || args.Find != "Zhihu" {
		t.Fatalf("args=%+v err=%v", args, err)
	}
	if err := DecodeArguments(`{"action":"look","part":3}`, &args); err != nil || args.Part != 3 {
		t.Fatalf("args=%+v err=%v", args, err)
	}
}

func TestBrowserRiskCatchesSendsAndPaymentsOnly(t *testing.T) {
	page := "- textbox \"Search\" [ref=e3]\n- button \"Passer la commande\" [ref=e7]\n- link \"Sony WH-1000XM5\" [ref=e9]\n- button \"Send\" [ref=e11]"
	for _, check := range []struct {
		args  BrowserArguments
		risky bool
	}{
		// The model marks a click that acts in the user's name, in any language.
		{BrowserArguments{Action: "click", Ref: "e7", Commits: true}, true},
		{BrowserArguments{Action: "click", Ref: "e11", Commits: true}, true},
		{BrowserArguments{Action: "click", Ref: "e99", Commits: true}, true},
		{BrowserArguments{Action: "click", Ref: "e7"}, false},
		{BrowserArguments{Action: "click", Ref: "e9"}, false},
		{BrowserArguments{Action: "type", Ref: "e3", Text: "headphones"}, false},
		{BrowserArguments{Action: "type", Ref: "e3", Text: "headphones", Submit: true}, true},
		{BrowserArguments{Action: "open", URL: "jd.com"}, false},
	} {
		if summary, risky := BrowserRisk(check.args, page); risky != check.risky || risky && summary == "" {
			t.Fatalf("%+v: risky=%v summary=%q", check.args, risky, summary)
		}
	}
}

func TestBrowserRiskNamesTheClickedElement(t *testing.T) {
	page := "- button \"Place order\" [ref=e7]"
	if summary, _ := BrowserRisk(BrowserArguments{Action: "click", Ref: "e7", Commits: true}, page); summary != "Will click “Place order” on the local browser" {
		t.Fatalf("summary=%q", summary)
	}
	if summary, _ := BrowserRisk(BrowserArguments{Action: "click", Ref: "e8", Commits: true}, page); summary != "Will click element e8 on the local browser" {
		t.Fatalf("summary=%q", summary)
	}
}

func TestBrowserPageURLReadsWhereThePageIs(t *testing.T) {
	page := "### Page state\n- Page URL: https://cart.jd.com/cart\n- Page Title: Cart\n- button \"Passer la commande\" [ref=e7]"
	if got := BrowserPageURL(page); got != "https://cart.jd.com/cart" {
		t.Fatalf("url=%q", got)
	}
	if got := BrowserPageURL("no page"); got != "" {
		t.Fatalf("url=%q", got)
	}
}

func TestBrowserConnectionDetailSendsTheUserToConnectChrome(t *testing.T) {
	for _, code := range []string{"browser_connection_required", "browser_connection_invalid"} {
		detail, ok := BrowserConnectionDetail(code)
		if !ok || !strings.Contains(detail, "Settings under Computers") || !strings.Contains(detail, "Connect Chrome") ||
			!strings.Contains(detail, "Playwright Extension") || !strings.Contains(detail, "start_task") {
			t.Fatalf("%s: %q", code, detail)
		}
	}
	if _, ok := BrowserConnectionDetail("outcome_unknown"); ok {
		t.Fatal("an unknown outcome is not a missing connection")
	}
}
