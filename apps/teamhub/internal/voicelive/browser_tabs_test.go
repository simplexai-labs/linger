package voicelive

import "testing"

func TestBrowserTabsReadsTheOpenTabs(t *testing.T) {
	page := "### Open tabs\n" +
		"- 0: (current) [OpenAI news - Search](https://www.bing.com/search?q=OpenAI+news)\n" +
		"- 1: [OpenAI acquires Odessia](https://www.unite.ai/odessia)\n" +
		"### Page\n- Page URL: https://www.bing.com/search?q=OpenAI+news\n" +
		"### Snapshot\n```yaml\n- 2: [not a tab](https://example.com)\n```"
	if count, current := BrowserTabs(page); count != 2 || current != 0 {
		t.Fatalf("count=%d current=%d", count, current)
	}
	switched := "### Open tabs\n- 0: [a](https://a)\n- 1: (current) [b](https://b)\n### Page\n"
	if count, current := BrowserTabs(switched); count != 2 || current != 1 {
		t.Fatalf("count=%d current=%d", count, current)
	}
	if count, current := BrowserTabs("### Page\n- Page URL: https://a\n"); count != 1 || current != 0 {
		t.Fatalf("one tab: count=%d current=%d", count, current)
	}
}
