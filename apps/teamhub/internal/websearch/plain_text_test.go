package websearch

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestProviderTextPreservesLiteralComparisons(t *testing.T) {
	for _, test := range []struct {
		name, input, want string
	}{
		{"comparison", "Keep 1 < 2 and 3 > 2", "Keep 1 < 2 and 3 > 2"},
		{"mixed markup", "<b>Bounds:</b> 1 < 2 and 3 > 2", "Bounds: 1 < 2 and 3 > 2"},
		{"quoted attribute", `<a title="1 > 0">value</a>`, "value"},
		{"quoted comment", "before <!-- hidden > text --> after", "before after"},
		{"inline tags", "a<strong>b</strong>c", "abc"},
		{"decode once", "&lt;b&gt;literal&lt;/b&gt; &amp;lt;tag&amp;gt;", "<b>literal</b> &lt;tag&gt;"},
		{"whitespace", "  ready\n\t<b>now</b>  ", "ready now"},
		{"open comparison", "a < b", "a < b"},
		{"unfinished tag", "value <unfinished", "value <unfinished"},
		{"unfinished entity", "value <unfinished &amp;", "value <unfinished &"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := plainText(test.input, 200); got != test.want {
				t.Fatalf("plainText = %q, want %q", got, test.want)
			}
		})
	}
}

func TestDuckDuckGoTextNormalizationAfterHTMLParsing(t *testing.T) {
	for _, test := range []struct {
		name, source, want string
	}{
		{"escaped comparison", "Bounds: 1 &lt; 2 and 3 &gt; 2", "Bounds: 1 < 2 and 3 > 2"},
		{"nested entity control", "Ready <b>now</b> &amp;lt;tag&amp;gt;", "Ready now <tag>"},
	} {
		t.Run(test.name, func(t *testing.T) {
			fake := newFakeProviders(t, func(w http.ResponseWriter, _ seen) {
				w.Header().Set("Content-Type", "text/html")
				_, _ = fmt.Fprintf(w, `<div class="result"><a class="result__a" href="https://result.example">%s</a><a class="result__snippet">%s</a></div>`, test.source, test.source)
			})
			service, _ := newTestService(t, fake)
			request := search("comparison syntax")
			request.Backend = DuckDuckGo
			outcome, err := service.Run(t.Context(), request)
			if err != nil || len(outcome.Results) != 1 {
				t.Fatalf("Run = %+v, %v", outcome, err)
			}
			if result := outcome.Results[0]; result.Title != test.want || result.Snippet != test.want {
				t.Fatalf("result = %+v, want title and snippet %q", result, test.want)
			}
			if requests := fake.seen(); len(requests) != 1 {
				t.Fatalf("provider calls = %d, want 1", len(requests))
			}
		})
	}
}

func TestProviderTextKeepsDecodedCharacterLimit(t *testing.T) {
	input := "<b>" + strings.Repeat("&#128578;", 5) + "</b>"
	if got := plainText(input, 3); got != strings.Repeat("\U0001f642", 3) {
		t.Fatalf("bounded text = %q", got)
	}
}

func TestSearchResultsKeepLiteralTextThroughProviderHTTP(t *testing.T) {
	input := `<a title="n > 0">n</a> < 5 and 6 > 3`
	want := "n < 5 and 6 > 3"
	for _, backend := range []Backend{Tavily, Brave, Firecrawl, You, Exa} {
		t.Run(string(backend), func(t *testing.T) {
			result := map[string]any{
				"title": input, "url": "https://result.example", "description": input,
				"content": input, "highlights": []string{input},
			}
			var response any
			switch backend {
			case Tavily, Exa:
				response = map[string]any{"results": []any{result}}
			case Brave:
				response = map[string]any{"web": map[string]any{"results": []any{result}}}
			case Firecrawl:
				response = map[string]any{"data": map[string]any{"web": []any{result}}}
			case You:
				response = map[string]any{"results": map[string]any{"web": []any{result}}}
			}
			body, err := json.Marshal(response)
			if err != nil {
				t.Fatal(err)
			}
			fake := newFakeProviders(t, func(w http.ResponseWriter, _ seen) {
				writeJSON(w, http.StatusOK, string(body))
			})
			service, keys := newTestService(t, fake)
			saveRaw(t, service, keys, backend, "test-key", "verified")
			request := search("comparison syntax")
			request.Backend = backend
			outcome, err := service.Run(t.Context(), request)
			if err != nil || outcome.Backend != backend || len(outcome.Results) != 1 {
				t.Fatalf("Run = %+v, %v", outcome, err)
			}
			got := outcome.Results[0]
			if got.Title != want || got.Snippet != want || got.URL != "https://result.example" {
				t.Fatalf("result = %+v; title and snippet must retain %q", got, want)
			}
			if requests := fake.seen(); len(requests) != 1 {
				t.Fatalf("provider calls = %d, want 1", len(requests))
			}
		})
	}
}
