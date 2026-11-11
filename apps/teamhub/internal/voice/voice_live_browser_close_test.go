package voice

import (
	"io"
	"log/slog"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
)

const (
	toutiaoPage = "### Open tabs\n- 0: [Jay Chou - Search](https://www.bing.com/search?q=jay)\n- 1: (current) [Tour dates - Toutiao](https://www.toutiao.com/article/1)\n### Page\n- Page URL: https://www.toutiao.com/article/1\n"
	toutiaoNext = "### Open tabs\n- 0: [Jay Chou - Search](https://www.bing.com/search?q=jay)\n- 1: (current) [Next article - Toutiao](https://www.toutiao.com/article/2)\n### Page\n- Page URL: https://www.toutiao.com/article/2\n"
	jaySearch   = "### Page\n- Page URL: https://www.bing.com/search?q=jay\n"
)

func TestBackClosesATabStillOnThePageItsClickOpened(t *testing.T) {
	landing := "https://www.toutiao.com/article/1"
	for _, check := range []struct {
		name, action, page, landing string
		cameFrom                    int
		closes                      bool
	}{
		// Bing opens results through its own redirect, so the new tab can go
		// back to a second copy of the search: it is closed instead.
		{"back on the landing page", "back", toutiaoPage, landing, 0, true},
		{"back after reading on in that tab", "back", toutiaoNext, landing, 0, false},
		{"back on a tab nothing opened", "back", jaySearch, "", -1, false},
		{"close always closes", "close", jaySearch, "", -1, true},
	} {
		if got := closesLiveBrowserTab(check.action, check.page, check.cameFrom, check.landing); got != check.closes {
			t.Fatalf("%s: closes=%v", check.name, got)
		}
	}
}

func TestCloseReturnsToTheTabItCameFrom(t *testing.T) {
	service := &Service{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	browser := &fakeLiveBrowser{answers: map[string]string{"browser_snapshot": jaySearch}}
	result, err := service.closeLiveBrowserTab(t.Context(), browser, roomagent.LocalBrowserToolCall{}, 1, 0, 2)
	if err != nil || result.Text != jaySearch {
		t.Fatalf("page=%q err=%v", result.Text, err)
	}
	if len(browser.calls) != 3 || browser.calls[0].Arguments["action"] != "close" || browser.calls[0].Arguments["index"] != 1 ||
		browser.calls[1].Arguments["action"] != "select" || browser.calls[1].Arguments["index"] != 0 ||
		browser.calls[2].ToolName != "browser_snapshot" {
		t.Fatalf("calls=%+v", browser.calls)
	}
	// Without a known origin it returns to the tab before; a later origin
	// moves down one place once the tab before it is gone.
	for _, check := range []struct{ current, cameFrom, count, selected int }{{2, -1, 3, 1}, {0, -1, 2, 0}, {0, 2, 3, 1}} {
		browser = &fakeLiveBrowser{answers: map[string]string{}}
		_, _ = service.closeLiveBrowserTab(t.Context(), browser, roomagent.LocalBrowserToolCall{}, check.current, check.cameFrom, check.count)
		if browser.calls[1].Arguments["index"] != check.selected {
			t.Fatalf("%+v: selected %v", check, browser.calls[1].Arguments["index"])
		}
	}
}
