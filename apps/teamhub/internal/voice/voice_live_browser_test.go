package voice

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
)

type fakeLiveBrowser struct {
	calls   []roomagent.LocalBrowserToolCall
	answers map[string]string
}

func (b *fakeLiveBrowser) CallLocalBrowserTool(_ context.Context, call roomagent.LocalBrowserToolCall) (roomagent.LocalBrowserToolResult, error) {
	b.calls = append(b.calls, call)
	return roomagent.LocalBrowserToolResult{Text: b.answers[call.ToolName]}, nil
}

const (
	searchPage  = "### Page\n- Page URL: https://www.bing.com/search?q=xai\n"
	clickedPage = "### Open tabs\n- 0: (current) [xai - Search](https://www.bing.com/search?q=xai)\n- 1: [xAI News](https://x.ai/news)\n### Page\n- Page URL: https://www.bing.com/search?q=xai\n"
	articlePage = "### Open tabs\n- 0: [xai - Search](https://www.bing.com/search?q=xai)\n- 1: (current) [xAI News](https://x.ai/news)\n### Page\n- Page URL: https://x.ai/news\n"
)

func TestLiveBrowserFollowsTheTabAClickOpens(t *testing.T) {
	service := &Service{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	browser := &fakeLiveBrowser{answers: map[string]string{"browser_snapshot": articlePage}}
	result, cameFrom := service.followLiveBrowserTab(t.Context(), voicelive.Session{}, browser,
		roomagent.LocalBrowserToolCall{ToolName: "browser_click"}, "click", searchPage, -1,
		roomagent.LocalBrowserToolResult{Text: clickedPage})
	if result.Text != articlePage || cameFrom != 0 {
		t.Fatalf("page=%q came_from=%d", result.Text, cameFrom)
	}
	if len(browser.calls) != 2 || browser.calls[0].Arguments["action"] != "select" || browser.calls[0].Arguments["index"] != 1 {
		t.Fatalf("calls=%+v", browser.calls)
	}

	// A look on that tab keeps where it came from.
	_, cameFrom = service.followLiveBrowserTab(t.Context(), voicelive.Session{}, browser,
		roomagent.LocalBrowserToolCall{}, "look", articlePage, 0, roomagent.LocalBrowserToolResult{Text: articlePage})
	if cameFrom != 0 {
		t.Fatalf("look lost the tab it came from: %d", cameFrom)
	}

}

func TestLiveBrowserStaysOnATabWithoutANewOne(t *testing.T) {
	service := &Service{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	browser := &fakeLiveBrowser{}
	result, cameFrom := service.followLiveBrowserTab(t.Context(), voicelive.Session{}, browser,
		roomagent.LocalBrowserToolCall{}, "click", searchPage, -1, roomagent.LocalBrowserToolResult{Text: searchPage})
	if result.Text != searchPage || cameFrom != -1 || len(browser.calls) != 0 {
		t.Fatalf("page=%q came_from=%d calls=%d", result.Text, cameFrom, len(browser.calls))
	}
	// Back on a tab that has its own history is an ordinary back.
	moved := "### Page\n- Page URL: https://x.ai/\n"
	result, _ = service.followLiveBrowserTab(t.Context(), voicelive.Session{}, browser,
		roomagent.LocalBrowserToolCall{}, "back", articlePage, 0, roomagent.LocalBrowserToolResult{Text: moved})
	if result.Text != moved || len(browser.calls) != 0 {
		t.Fatalf("page=%q calls=%d", result.Text, len(browser.calls))
	}
}
