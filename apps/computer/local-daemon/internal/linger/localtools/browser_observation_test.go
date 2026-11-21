package localtools

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
)

func browserResult(t *testing.T, text string) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}})
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func browserResultText(t *testing.T, result json.RawMessage) string {
	t.Helper()
	texts := resultTexts(result)
	if len(texts) != 1 {
		t.Fatalf("result text parts: %d", len(texts))
	}
	return texts[0]
}

func snapshotPage(url, title, snapshot string) string {
	return "### Page\n- Page URL: " + url + "\n- Page Title: " + title + "\n### Snapshot\n```yaml\n" + snapshot + "\n```"
}

func withShopNavigation(tree string) string {
	return tree + `
  - navigation "Store" [ref=e90]:
    - link "New arrivals" [ref=e91] [cursor=pointer]:
      - /url: /collections/new
    - link "Recently viewed" [ref=e92] [cursor=pointer]:
      - /url: /products/recent
    - link "Orders and returns" [ref=e93] [cursor=pointer]:
      - /url: /account/orders
    - link "Shipping and delivery" [ref=e94] [cursor=pointer]:
      - /url: /help/shipping
    - link "Contact customer support" [ref=e95] [cursor=pointer]:
      - /url: /help/contact`
}

func TestBrowserFirstNavigationKeepsFullSnapshot(t *testing.T) {
	var observations browserObservations
	result := observations.observeAction("browser_navigate", nil, browserResult(t, snapshotPage(
		"https://shop.example/cart", "Cart",
		"- main [ref=e1]:\n  - button \"Pay\" [ref=e2]",
	)), t.TempDir(), false)

	text := browserResultText(t, result)
	if !strings.Contains(text, "### Snapshot\n```yaml\n- main [ref=e1]:") {
		t.Fatalf("first navigation lost its full snapshot: %q", text)
	}
	if strings.Contains(text, "### Snapshot diff") {
		t.Fatalf("first navigation reported a diff: %q", text)
	}
}

func TestBrowserSamePageActionEmitsMultiLayerDiff(t *testing.T) {
	var observations browserObservations
	output := t.TempDir()
	observations.observeAction("browser_navigate", nil, browserResult(t, snapshotPage(
		"https://shop.example/cart", "Cart",
		withShopNavigation("- main [ref=e1]:\n  - button \"Pay\" [ref=e2]\n  - paragraph [ref=e4]: Total 10"),
	)), output, false)

	if err := os.WriteFile(filepath.Join(output, "report.pdf"), []byte("pdf"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(output, "photo.png"), []byte("png"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(output, "shot.jpeg"), []byte("jpeg"), 0o600); err != nil {
		t.Fatal(err)
	}
	click := "### Open tabs\n- 0: (current) [Cart](https://shop.example/cart)\n- 1: [Receipt](https://shop.example/receipt)\n" +
		"![Screenshot](.linger/browser-output/abc/shot.jpeg)\n" +
		snapshotPage("https://shop.example/cart", "Cart",
			withShopNavigation("- main [ref=e1]:\n  - button \"Pay\" [disabled] [ref=e2]\n  - dialog \"Confirm\" [ref=e3]:\n    - text: Are you sure?"))
	text := browserResultText(t, observations.observeAction("browser_click", nil, browserResult(t, click), output, false))
	for _, want := range []string{
		"### Snapshot diff",
		"+ - dialog \"Confirm\" [ref=e3]:",
		"~ - button \"Pay\" [disabled] [ref=e2]",
		"- - paragraph [ref=e4]: Total 10",
		"      - text: Are you sure?",
		"    under - main [ref=e1]:",
		"- download: report.pdf",
		"- download: photo.png",
		"- tabs added: - 1: [Receipt](https://shop.example/receipt)",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("diff lacks %q: %q", want, text)
		}
	}
	if strings.Contains(text, "download: shot.jpeg") {
		t.Fatalf("screenshot was reported as a download: %q", text)
	}
	if strings.Contains(text, "Recently viewed") {
		t.Fatalf("unchanged navigation repeated in the diff: %q", text)
	}
}

func TestBrowserDiffKeepsDollarSigns(t *testing.T) {
	var observations browserObservations
	output := t.TempDir()
	observations.observeAction("browser_navigate", nil, browserResult(t, snapshotPage(
		"https://shop.example/cart", "Cart", withShopNavigation("- main [ref=e1]:\n  - paragraph [ref=e2]:\n    - text: Price $90"),
	)), output, false)

	text := browserResultText(t, observations.observeAction("browser_click", nil, browserResult(t, snapshotPage(
		"https://shop.example/cart", "Cart", withShopNavigation("- main [ref=e1]:\n  - paragraph [ref=e2]:\n    - text: Price $100"),
	)), output, false))
	if !strings.Contains(text, "~ - paragraph [ref=e2]:\n      - text: Price $100") {
		t.Fatalf("diff rewrote a dollar sign: %q", text)
	}
}

func TestBrowserSamePageActionWithoutChangeSaysSo(t *testing.T) {
	var observations browserObservations
	output := t.TempDir()
	page := snapshotPage("https://shop.example/cart", "Cart", withShopNavigation("- main [ref=e1]:\n  - button \"Pay\" [ref=e2]"))
	observations.observeAction("browser_navigate", nil, browserResult(t, page), output, false)
	text := browserResultText(t, observations.observeAction("browser_click", nil, browserResult(t, page), output, false))
	if !strings.Contains(text, "### Snapshot diff\nno_change") {
		t.Fatalf("unchanged page did not report no_change: %q", text)
	}
}

func TestBrowserLargeChangeKeepsFullSnapshot(t *testing.T) {
	var observations browserObservations
	output := t.TempDir()
	observations.observeAction("browser_navigate", nil, browserResult(t, snapshotPage(
		"https://shop.example/list", "List", "- main [ref=e1]:",
	)), output, false)

	var snapshot strings.Builder
	snapshot.WriteString("- main [ref=e1]:\n")
	for index := 0; index < maxSnapshotDiffRows+1; index++ {
		snapshot.WriteString(fmt.Sprintf("  - button \"Item\" [ref=e%d]\n", index+2))
	}
	text := browserResultText(t, observations.observeAction("browser_click", nil, browserResult(t, snapshotPage(
		"https://shop.example/list", "List", snapshot.String(),
	)), output, false))
	if !strings.Contains(text, "### Snapshot\n```yaml\n- main [ref=e1]:") {
		t.Fatalf("large change was compacted: %q", text)
	}
}

func TestBrowserNavigationChangeKeepsFullSnapshot(t *testing.T) {
	var observations browserObservations
	output := t.TempDir()
	observations.observeAction("browser_navigate", nil, browserResult(t, snapshotPage(
		"https://shop.example/cart", "Cart", "- main [ref=e1]:",
	)), output, false)

	text := browserResultText(t, observations.observeAction("browser_click", nil, browserResult(t, snapshotPage(
		"https://shop.example/checkout", "Checkout", "- main [ref=e9]:\n  - button \"Place order\" [ref=e10]",
	)), output, false))
	if !strings.Contains(text, "### Snapshot\n```yaml\n- main [ref=e9]:") {
		t.Fatalf("navigation change was compacted: %q", text)
	}
}

func TestBrowserSamePageActionReportsPageHostChanges(t *testing.T) {
	var observations browserObservations
	output := t.TempDir()
	page := func(title, status string) json.RawMessage {
		text := snapshotPage("https://shop.example/cart", title, withShopNavigation("- main [ref=e1]:"))
		return browserResult(t, strings.Replace(text, "### Snapshot", status+"\n### Snapshot", 1))
	}
	observations.observeAction("browser_navigate", nil, page("Cart", "- Console: 0 errors, 0 warnings"), output, false)
	text := browserResultText(t, observations.observeAction("browser_click", nil,
		page("Cart (2)", "- HTTP status: 500 Server Error\n- Console: 2 errors, 0 warnings"), output, false))
	for _, want := range []string{
		"### Snapshot diff",
		"- title: Cart -> Cart (2)",
		"- http status: 500 Server Error",
		"- console: 0 errors, 0 warnings -> 2 errors, 0 warnings",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("page host diff lacks %q: %q", want, text)
		}
	}
}

func TestBrowserTabsResultUpdatesTheTabBaseline(t *testing.T) {
	var observations browserObservations
	output := t.TempDir()
	page := snapshotPage("https://shop.example/cart", "Cart", withShopNavigation("- main [ref=e1]:"))
	observations.observeAction("browser_navigate", nil, browserResult(t, page), output, false)

	tabs := "### Open tabs\n- 0: (current) [Cart](https://shop.example/cart)\n- 1: [Receipt](https://shop.example/receipt)"
	observations.observeAction("browser_tabs", json.RawMessage(`{"action":"list"}`), browserResult(t, tabs), output, false)
	click := tabs + "\n" + page
	text := browserResultText(t, observations.observeAction("browser_click", nil, browserResult(t, click), output, false))
	if !strings.Contains(text, "### Snapshot diff\nno_change") {
		t.Fatalf("listing tabs with the same active page lost the baseline: %q", text)
	}
}

func TestBrowserTabsResultFromResultSection(t *testing.T) {
	var observations browserObservations
	observations.observeAction("browser_tabs", json.RawMessage(`{"action":"list"}`), browserResult(t,
		"### Result\n- 0: (current) [Cart](https://shop.example/cart)\n- 1: [Receipt](https://shop.example/receipt)"), "", false)

	if len(observations.latest.tabs) != 2 || observations.latest.activeTab != "0: https://shop.example/cart" {
		t.Fatalf("tab result lost its tabs or active tab: %+v", observations.latest)
	}
}

func TestBrowserTabsCloseToOneTabUpdatesTheBaseline(t *testing.T) {
	var observations browserObservations
	output := t.TempDir()
	observations.observeAction("browser_navigate", nil, browserResult(t, snapshotPage(
		"https://shop.example/cart", "Cart", "- main [ref=e1]:",
	)), output, false)

	observations.observeAction("browser_tabs", json.RawMessage(`{"action":"list"}`), browserResult(t,
		"### Open tabs\n- 0: (current) [Cart](https://shop.example/cart)\n- 1: [Receipt](https://shop.example/receipt)"), output, false)

	observations.observeAction("browser_tabs", json.RawMessage(`{"action":"close","index":1}`), browserResult(t,
		"### Result\n- 0: (current) [Cart](https://shop.example/cart)"), output, false)

	if len(observations.latest.tabs) != 1 {
		t.Fatalf("closed tab remained in the baseline: %+v", observations.latest)
	}
	text := browserResultText(t, observations.observeAction("browser_click", nil, browserResult(t, snapshotPage(
		"https://shop.example/cart", "Cart", "- main [ref=e1]:",
	)), output, false))
	if !strings.Contains(text, "### Snapshot\n") {
		t.Fatalf("a tab mutation did not start a new read: %q", text)
	}
}

func TestBrowserTabsCloseLastTabClearsTheBaseline(t *testing.T) {
	var observations browserObservations
	observations.observeAction("browser_navigate", nil, browserResult(t, snapshotPage(
		"https://shop.example/cart", "Cart", "- main [ref=e1]:",
	)), "", false)

	observations.observeAction("browser_tabs", json.RawMessage(`{"action":"close"}`), browserResult(t,
		"### Result\nNo open tabs. Navigate to a URL to create one."), "", false)

	if len(observations.latest.tabs) != 0 || observations.latest.snapshot != nil {
		t.Fatalf("closed tab remained in the baseline: %+v", observations.latest)
	}
}

func TestBrowserTabKeyKeepsDuplicateURLs(t *testing.T) {
	tabs, _ := parseTabs([]string{
		"### Open tabs\n- 0: (current) [Cart](https://shop.example/cart)\n- 1: [Cart](https://shop.example/cart)",
	})
	if len(tabs) != 2 {
		t.Fatalf("duplicate tab addresses collapsed into %d tabs: %v", len(tabs), tabs)
	}
}

func TestBrowserFormValueChangeKeepsItsRef(t *testing.T) {
	var observations browserObservations
	output := t.TempDir()
	page := func(value string) string {
		return snapshotPage("https://shop.example/checkout", "Checkout",
			withShopNavigation("- main [ref=e1]:\n  - textbox \"Email\" [ref=e2]:\n    - /placeholder: Enter email\n    - text: "+value))
	}
	observations.observeAction("browser_navigate", nil, browserResult(t, page("a@b.com")), output, false)
	text := browserResultText(t, observations.observeAction("browser_type", nil, browserResult(t, page("c@d.com")), output, false))
	if !strings.Contains(text, "~ - textbox \"Email\" [ref=e2]:\n      - /placeholder: Enter email\n      - text: c@d.com") {
		t.Fatalf("form value change lost its ref and context: %q", text)
	}
}

func TestBrowserDiffKeepsLinkDestinationsWithTheirRefs(t *testing.T) {
	var observations browserObservations
	page := func(first, second string) json.RawMessage {
		return browserResult(t, snapshotPage("https://shop.example/cart", "Cart",
			withShopNavigation("- main [ref=e1]:\n"+
				"  - link \"First [ref=e99]\" [ref=e2] [cursor=pointer]:\n    - /url: "+first+"\n"+
				"  - link \"Second [ref=e99]\" [ref=e3] [cursor=pointer]:\n    - /url: "+second)))
	}
	observations.observeAction("browser_navigate", nil, page("/alpha", "/beta"), "", false)
	text := browserResultText(t, observations.observeAction("browser_click", nil, page("/beta", "/alpha"), "", false))
	for _, want := range []string{
		"### Snapshot diff",
		"~ - link \"First [ref=e99]\" [ref=e2] [cursor=pointer]:\n      - /url: /beta",
		"~ - link \"Second [ref=e99]\" [ref=e3] [cursor=pointer]:\n      - /url: /alpha",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("diff lacks %q: %q", want, text)
		}
	}
}

func TestBrowserDiffReturnsFullSnapshotWhenTreeAnchorsMove(t *testing.T) {
	initial := withShopNavigation("- main [ref=e1]:\n  - heading \"First\" [ref=e2]\n  - heading \"Second\" [ref=e3]")
	for _, test := range []struct {
		name string
		tree string
	}{
		{name: "sibling reorder", tree: withShopNavigation("- main [ref=e1]:\n  - heading \"Second\" [ref=e3]\n  - heading \"First\" [ref=e2]")},
		{name: "new parent", tree: withShopNavigation("- main [ref=e1]:\n  - group [ref=e4]:\n    - heading \"First\" [ref=e2]\n  - heading \"Second\" [ref=e3]")},
		{name: "replacement document", tree: strings.ReplaceAll(initial, "[ref=e", "[ref=f1e")},
	} {
		t.Run(test.name, func(t *testing.T) {
			var observations browserObservations
			page := func(tree string) json.RawMessage {
				return browserResult(t, snapshotPage("https://shop.example/cart", "Cart", tree))
			}
			observations.observeAction("browser_navigate", nil, page(initial), "", false)
			result := observations.observeAction("browser_click", nil, page(test.tree), "", false)
			if !strings.Contains(browserResultText(t, result), "### Snapshot\n") {
				t.Fatalf("expected the new full tree: %s", result)
			}
			result = observations.observeAction("browser_click", nil, page(test.tree), "", false)
			if !strings.Contains(browserResultText(t, result), "### Snapshot diff\nno_change") {
				t.Fatalf("the full tree did not establish a new baseline: %s", result)
			}
		})
	}
}

func TestBrowserDiffIdentifiesParentsOfAddedAndRemovedControls(t *testing.T) {
	const shipping = "- region \"Shipping\" [ref=e2]:"
	const billing = "- region \"Billing\" [ref=e4]:"
	const tree = "- main [ref=e1]:\n" +
		"  " + shipping + "\n    - heading \"Shipping address\" [ref=e3]\n" +
		"  " + billing + "\n    - heading \"Billing address\" [ref=e5]"
	const button = "- button \"Continue\" [ref=e6]"
	for _, test := range []struct {
		name   string
		anchor string
		parent string
	}{
		{name: "shipping", anchor: "[ref=e3]", parent: shipping},
		{name: "billing", anchor: "[ref=e5]", parent: billing},
	} {
		t.Run(test.name, func(t *testing.T) {
			var observations browserObservations
			page := func(tree string) json.RawMessage {
				return browserResult(t, snapshotPage("https://shop.example/cart", "Cart", withShopNavigation(tree)))
			}
			before := page(tree)
			after := page(strings.Replace(tree, test.anchor, test.anchor+"\n    "+button, 1))
			observations.observeAction("browser_navigate", nil, before, "", false)
			added := browserResultText(t, observations.observeAction("browser_click", nil, after, "", false))
			removed := browserResultText(t, observations.observeAction("browser_click", nil, before, "", false))
			if !strings.Contains(added, "+ "+button+"\n    under "+test.parent) ||
				!strings.Contains(removed, "- "+button+"\n    under "+test.parent) {
				t.Fatalf("diff lost the control's parent:\nadded: %s\nremoved: %s", added, removed)
			}
		})
	}
}

func TestBrowserKeepsShorterFullSnapshot(t *testing.T) {
	var observations browserObservations
	const tree = "- main [ref=e1]:\n  - button \"Prepare receipt\" [ref=e2]"
	const url = "https://shop.example/cart"
	observations.observeAction("browser_navigate", nil, browserResult(t, snapshotPage(url, "Cart", tree)), "", false)
	snapshot := snapshotPage(url, "Receipt ready", strings.Replace(tree, "[ref=e2]", "[active] [ref=e2]", 1))
	result := browserResult(t, snapshot+"\n### Events\n- Downloaded file receipt.txt to \"receipt.txt\"")
	got := observations.observeAction("browser_click", nil, result, "", false)
	if string(got) != string(result) {
		t.Fatalf("action replaced a shorter full snapshot: %s", got)
	}
}

func TestBrowserScopedSnapshotKeepsFullPageBaseline(t *testing.T) {
	full := withShopNavigation("- main [ref=e1]:\n  - button \"Read\" [ref=e2]\n  - button \"Next\" [ref=e3]")
	for _, test := range []struct {
		name string
		args json.RawMessage
		tree string
	}{
		{name: "target", args: json.RawMessage(`{"target":"e2"}`), tree: "- button \"Read\" [ref=e2]"},
		{name: "depth zero", args: json.RawMessage(`{"depth":0}`), tree: "- main [ref=e1]"},
		{name: "boxes", args: json.RawMessage(`{"boxes":true}`), tree: strings.ReplaceAll(full, "]", "] [box=0,0,10,10]")},
	} {
		t.Run(test.name, func(t *testing.T) {
			var observations browserObservations
			page := func(tree string) json.RawMessage {
				return browserResult(t, snapshotPage("https://shop.example/cart", "Cart", tree))
			}
			observations.observeAction("browser_navigate", nil, page(full), "", false)
			result := observations.observeAction("browser_snapshot", test.args, page(test.tree), "", false)
			if !strings.Contains(browserResultText(t, result), "### Snapshot\n") {
				t.Fatalf("scoped read lost its snapshot: %s", result)
			}
			result = observations.observeAction("browser_click", nil, page(full), "", false)
			if !strings.Contains(browserResultText(t, result), "### Snapshot diff\nno_change") {
				t.Fatalf("scoped read changed the full-page baseline: %s", result)
			}
		})
	}
}

func TestBrowserClosingActiveDuplicateTabInvalidatesSnapshot(t *testing.T) {
	var observations browserObservations
	const address = "https://shop.example/cart"
	page := snapshotPage(address, "Cart", withShopNavigation("- main [ref=e1]:\n  - button \"Read\" [active] [ref=e2]"))
	observations.observeAction("browser_snapshot", nil, browserResult(t,
		"### Open tabs\n- 0: (current) [Cart]("+address+")\n- 1: [Cart]("+address+")\n"+page), "", false)

	observations.observeAction("browser_tabs", json.RawMessage(`{"action":"close","index":0}`), browserResult(t,
		"### Result\n- 0: (current) [Cart]("+address+")"), "", false)

	result := observations.observeAction("browser_click", nil, browserResult(t, page), "", false)
	if !strings.Contains(browserResultText(t, result), "### Snapshot\n") {
		t.Fatalf("the surviving tab was diffed against the closed tab: %s", result)
	}
}

func TestBrowserDiffIgnoresPlaywrightArtifacts(t *testing.T) {
	var observations browserObservations
	output := t.TempDir()
	page := snapshotPage("https://shop.example/cart", "Cart", withShopNavigation("- main [ref=e1]:"))
	observations.observeAction("browser_navigate", nil, browserResult(t, page), output, false)

	for _, name := range []string{"console-2026.log", "page-1.png", "report.pdf", "photo.png"} {
		if err := os.WriteFile(filepath.Join(output, name), []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	link := ".linger/browser-output/" + path.Base(filepath.ToSlash(output)) + "/"
	click := "### Events\n- Downloaded file report.pdf to \"" + link + "report.pdf\"\n" +
		"- [Screenshot of viewport](" + link + "page-1.png)\n" +
		"- [Console](" + link + "console-2026.log)\n" +
		page
	text := browserResultText(t, observations.observeAction("browser_click", nil, browserResult(t, click), output, false))
	for _, want := range []string{"- download: report.pdf", "- download: photo.png"} {
		if !strings.Contains(text, want) {
			t.Fatalf("diff lacks %q: %q", want, text)
		}
	}
	for _, unwanted := range []string{"- download: console-2026.log", "- download: page-1.png"} {
		if strings.Contains(text, unwanted) {
			t.Fatalf("Playwright artifact reported as a download: %q", text)
		}
	}
}

func TestBrowserScreenshotArtifactSurvivesNoSnapshotResult(t *testing.T) {
	var observations browserObservations
	output := t.TempDir()
	page := snapshotPage("https://shop.example/cart", "Cart", withShopNavigation("- main [ref=e1]:"))
	observations.observeAction("browser_navigate", nil, browserResult(t, page), output, false)

	if err := os.WriteFile(filepath.Join(output, "page-1.png"), []byte("png"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := ".linger/browser-output/" + path.Base(filepath.ToSlash(output)) + "/page-1.png"
	observations.observeAction("browser_take_screenshot", nil, browserResult(t, "- [Screenshot of viewport]("+link+")"), output, false)
	text := browserResultText(t, observations.observeAction("browser_click", nil, browserResult(t, page), output, false))
	if !strings.Contains(text, "### Snapshot diff\nno_change") || strings.Contains(text, "- download: page-1.png") {
		t.Fatalf("screenshot reported as a download: %q", text)
	}
}
