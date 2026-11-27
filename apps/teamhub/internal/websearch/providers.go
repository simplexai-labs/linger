package websearch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"html"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// The provider APIs. Tests point Endpoints at fakes instead.
const (
	DefaultTavilyURL    = "https://api.tavily.com"
	DefaultBraveURL     = "https://api.search.brave.com"
	DefaultFirecrawlURL = "https://api.firecrawl.dev"
	DefaultYouAPIURL    = "https://api.you.com"
	DefaultYouIndexURL  = "https://ydc-index.io"
	DefaultYouMCPURL    = "https://api.you.com/mcp/free"
	DefaultDuckDuckGo   = "https://html.duckduckgo.com"
	DefaultExaURL       = "https://api.exa.ai"
)

// Call budgets. A page read waits longer because the provider fetches and
// renders the page first.
const (
	searchTimeout   = 20 * time.Second
	openTimeout     = 45 * time.Second
	checkTimeout    = 10 * time.Second
	maxResponseBody = 8 << 20
)

// Endpoints are the provider base URLs; an empty field uses the provider's
// API. Client replaces the default client, which never follows a redirect so
// a key never reaches another host.
type Endpoints struct {
	Tavily, Brave, Firecrawl, Exa, YouAPI, YouIndex, YouMCP, DuckDuckGo string
	Client                                                              *http.Client
}

type providers struct {
	endpoints Endpoints
	client    *http.Client
}

func newProviders(endpoints Endpoints) *providers {
	for _, field := range []struct {
		value    *string
		fallback string
	}{
		{&endpoints.Tavily, DefaultTavilyURL}, {&endpoints.Brave, DefaultBraveURL},
		{&endpoints.Firecrawl, DefaultFirecrawlURL}, {&endpoints.YouAPI, DefaultYouAPIURL},
		{&endpoints.YouIndex, DefaultYouIndexURL}, {&endpoints.YouMCP, DefaultYouMCPURL},
		{&endpoints.DuckDuckGo, DefaultDuckDuckGo}, {&endpoints.Exa, DefaultExaURL},
	} {
		if *field.value == "" {
			*field.value = field.fallback
		}
		*field.value = strings.TrimRight(*field.value, "/")
	}
	client := endpoints.Client
	if client == nil {
		client = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	return &providers{endpoints: endpoints, client: client}
}

// answer is one provider response.
type answer struct {
	status int
	header http.Header
	body   []byte
}

// call sends one request. A transport failure is CodeProviderUnavailable;
// the error never carries the URL, which may hold the query.
func (p *providers) call(ctx context.Context, method, endpoint string, header map[string]string, body any) (answer, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return answer{}, err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return answer{}, &Failure{Code: CodeProviderUnavailable}
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	for name, value := range header {
		request.Header.Set(name, value)
	}
	response, err := p.client.Do(request)
	if err != nil {
		return answer{}, &Failure{Code: CodeProviderUnavailable}
	}
	defer response.Body.Close()
	read, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBody))
	if err != nil {
		return answer{}, &Failure{Code: CodeProviderUnavailable}
	}
	return answer{status: response.StatusCode, header: response.Header, body: read}, nil
}

// classify turns a refused call into a Failure: 401 and 403 refuse the key,
// 402 and Tavily's 432/433 say the account has no credit left, 429 is a rate
// limit. A page read the provider could not fetch is unreadable. The
// provider's text is never kept.
func classify(b Backend, command string, a answer) error {
	if a.status >= 200 && a.status < 300 {
		return nil
	}
	failure := &Failure{Code: CodeProviderUnavailable, Backend: b}
	switch {
	case a.status == http.StatusUnauthorized || a.status == http.StatusForbidden:
		failure.Code = CodeKeyRejected
	case a.status == http.StatusPaymentRequired || b == Tavily && (a.status == 432 || a.status == 433):
		failure.Code, failure.proved = CodeQuotaExhausted, true
	case a.status == http.StatusTooManyRequests:
		failure.Code, failure.proved = CodeRateLimited, true
		if b == Brave && braveErrorCode(a.body) == "QUOTA_LIMITED" {
			failure.Code = CodeQuotaExhausted
		}
		failure.RetryAfter = retryAfter(a.header)
	case b == Brave && a.status == http.StatusUnprocessableEntity && braveErrorCode(a.body) == "SUBSCRIPTION_TOKEN_INVALID":
		failure.Code = CodeKeyRejected
	case command == CommandOpen && a.status >= 400 && a.status < 500:
		failure.Code = CodePageUnreadable
	}
	return failure
}

// braveErrorCode reads Brave's machine-readable error code.
func braveErrorCode(body []byte) string {
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &envelope)
	return envelope.Error.Code
}

func retryAfter(header http.Header) time.Duration {
	const maximum = time.Duration(1<<63 - 1)
	value := strings.TrimSpace(header.Get("Retry-After"))
	if value == "" {
		// Brave reports the reset of each window, the per-second one first.
		value, _, _ = strings.Cut(header.Get("X-RateLimit-Reset"), ",")
	} else if deadline, err := http.ParseTime(value); err == nil {
		wait := time.Until(deadline)
		if wait <= 0 {
			return 0
		}
		// The Agent API exposes whole seconds; round up so it cannot advise
		// retrying before the provider's date. Saturate before duration overflow.
		if wait > maximum-(time.Second-1) {
			return maximum
		}
		return (wait + time.Second - 1).Truncate(time.Second)
	}
	seconds, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || seconds < 0 {
		return 0
	}
	if uint64(seconds) > uint64(maximum/time.Second) {
		return maximum
	}
	return time.Duration(seconds) * time.Second
}

// run calls one backend with key. It returns the quota a response reported
// (Brave's rate-limit headers) for TeamHub to keep.
func (p *providers) run(ctx context.Context, b Backend, key string, request Request) (Outcome, *Quota, error) {
	if !supports(b, request) {
		return Outcome{}, nil, &Failure{Code: CodeUnsupported, Backend: b}
	}
	timeout := searchTimeout
	if request.Command == CommandOpen {
		timeout = openTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var (
		outcome  Outcome
		observed *Quota
		err      error
	)
	switch {
	case b == Tavily && request.Command == CommandSearch:
		outcome, err = p.tavilySearch(ctx, key, request)
	case b == Tavily:
		outcome, err = p.tavilyExtract(ctx, key, request.URL)
	case b == Brave:
		outcome, observed, err = p.braveSearch(ctx, key, request)
	case b == Firecrawl && request.Command == CommandSearch:
		outcome, err = p.firecrawlSearch(ctx, key, request)
	case b == Firecrawl:
		outcome, err = p.firecrawlScrape(ctx, key, request.URL)
	case b == Exa && request.Command == CommandSearch:
		outcome, err = p.exaSearch(ctx, key, request)
	case b == Exa:
		outcome, err = p.exaContents(ctx, key, request.URL)
	case b == You && request.Command == CommandSearch:
		outcome, err = p.youSearch(ctx, key, request)
	case b == You:
		outcome, err = p.youExtract(ctx, key, request.URL)
	default:
		return Outcome{}, nil, &Failure{Code: CodeUnsupported, Backend: b}
	}
	if failure := (*Failure)(nil); errors.As(err, &failure) && failure.Backend == "" {
		failure.Backend = b
	}
	outcome.Backend = b
	return outcome, observed, err
}

func bearer(key string) map[string]string { return map[string]string{"Authorization": "Bearer " + key} }

func (p *providers) tavilySearch(ctx context.Context, key string, request Request) (Outcome, error) {
	body := map[string]any{"query": request.Query, "max_results": request.Limit, "search_depth": "basic", "topic": "general"}
	if request.Recency != "" {
		body["time_range"] = request.Recency
	}
	if len(request.Sites) > 0 {
		body["include_domains"] = request.Sites
	}
	a, err := p.call(ctx, http.MethodPost, p.endpoints.Tavily+"/search", bearer(key), body)
	if err != nil {
		return Outcome{}, err
	}
	if err := classify(Tavily, CommandSearch, a); err != nil {
		return Outcome{}, err
	}
	var decoded struct {
		Results []struct {
			Title         string `json:"title"`
			URL           string `json:"url"`
			Content       string `json:"content"`
			PublishedDate string `json:"published_date"`
		} `json:"results"`
	}
	if json.Unmarshal(a.body, &decoded) != nil {
		return Outcome{}, &Failure{Code: CodeProviderUnavailable}
	}
	results := make([]Result, 0, len(decoded.Results))
	for _, item := range decoded.Results {
		results = appendResult(results, item.Title, item.URL, item.Content, item.PublishedDate)
	}
	return Outcome{Results: limitResults(results, request.Limit)}, nil
}

func (p *providers) tavilyExtract(ctx context.Context, key, pageURL string) (Outcome, error) {
	a, err := p.call(ctx, http.MethodPost, p.endpoints.Tavily+"/extract", bearer(key),
		map[string]any{"urls": []string{pageURL}, "format": "markdown", "extract_depth": "basic"})
	if err != nil {
		return Outcome{}, err
	}
	if err := classify(Tavily, CommandOpen, a); err != nil {
		return Outcome{}, err
	}
	var decoded struct {
		Results []struct {
			URL        string `json:"url"`
			Title      string `json:"title"`
			RawContent string `json:"raw_content"`
		} `json:"results"`
	}
	if json.Unmarshal(a.body, &decoded) != nil {
		return Outcome{}, &Failure{Code: CodeProviderUnavailable}
	}
	if len(decoded.Results) == 0 {
		return Outcome{}, &Failure{Code: CodePageUnreadable}
	}
	item := decoded.Results[0]
	return pageOutcome(pageURL, item.URL, item.Title, item.RawContent)
}

func (p *providers) braveSearch(ctx context.Context, key string, request Request) (Outcome, *Quota, error) {
	query := url.Values{"q": {request.Query}, "count": {strconv.Itoa(request.Limit)}}
	if len(request.Sites) == 1 {
		query.Set("q", request.Query+" site:"+request.Sites[0])
	}
	if freshness, ok := map[string]string{"day": "pd", "week": "pw", "month": "pm", "year": "py"}[request.Recency]; ok {
		query.Set("freshness", freshness)
	}
	a, err := p.call(ctx, http.MethodGet, p.endpoints.Brave+"/res/v1/web/search?"+query.Encode(),
		map[string]string{"X-Subscription-Token": key}, nil)
	if err != nil {
		return Outcome{}, nil, err
	}
	observed := braveQuota(a.header, time.Now())
	if err := classify(Brave, CommandSearch, a); err != nil {
		return Outcome{}, observed, err
	}
	var decoded struct {
		Web struct {
			Results []struct {
				Title       string `json:"title"`
				URL         string `json:"url"`
				Description string `json:"description"`
				PageAge     string `json:"page_age"`
				Age         string `json:"age"`
			} `json:"results"`
		} `json:"web"`
	}
	if json.Unmarshal(a.body, &decoded) != nil {
		return Outcome{}, observed, &Failure{Code: CodeProviderUnavailable}
	}
	results := make([]Result, 0, len(decoded.Web.Results))
	for _, item := range decoded.Web.Results {
		published := item.PageAge
		if published == "" {
			published = item.Age
		}
		results = appendResult(results, item.Title, item.URL, item.Description, published)
	}
	return Outcome{Results: limitResults(results, request.Limit)}, observed, nil
}

// braveQuota reads the monthly window of Brave's rate-limit headers, which
// list the per-second window first and the monthly one last.
func braveQuota(header http.Header, now time.Time) *Quota {
	last := func(name string) (float64, bool) {
		values := strings.Split(header.Get(name), ",")
		value, err := strconv.ParseFloat(strings.TrimSpace(values[len(values)-1]), 64)
		return value, err == nil && value >= 0 && !math.IsInf(value, 0) && len(values) > 1
	}
	remaining, ok := last("X-RateLimit-Remaining")
	if !ok {
		return nil
	}
	quota := &Quota{From: "last_response", Unit: "requests", Remaining: &remaining, ObservedAt: &now}
	if limit, ok := last("X-RateLimit-Limit"); ok {
		quota.Limit = &limit
	}
	if reset, ok := last("X-RateLimit-Reset"); ok {
		resets := now.Add(time.Duration(reset) * time.Second).Truncate(time.Second)
		quota.ResetsAt = &resets
	}
	return quota
}

func (p *providers) firecrawlSearch(ctx context.Context, key string, request Request) (Outcome, error) {
	body := map[string]any{"query": request.Query, "limit": request.Limit, "sources": []string{"web"}}
	if tbs, ok := map[string]string{"day": "qdr:d", "week": "qdr:w", "month": "qdr:m", "year": "qdr:y"}[request.Recency]; ok {
		body["tbs"] = tbs
	}
	a, err := p.call(ctx, http.MethodPost, p.endpoints.Firecrawl+"/v2/search", bearer(key), body)
	if err != nil {
		return Outcome{}, err
	}
	if err := classify(Firecrawl, CommandSearch, a); err != nil {
		return Outcome{}, err
	}
	var decoded struct {
		Data struct {
			Web []struct {
				Title       string `json:"title"`
				URL         string `json:"url"`
				Description string `json:"description"`
			} `json:"web"`
		} `json:"data"`
	}
	if json.Unmarshal(a.body, &decoded) != nil {
		return Outcome{}, &Failure{Code: CodeProviderUnavailable}
	}
	results := make([]Result, 0, len(decoded.Data.Web))
	for _, item := range decoded.Data.Web {
		results = appendResult(results, item.Title, item.URL, item.Description, "")
	}
	return Outcome{Results: limitResults(results, request.Limit)}, nil
}

func (p *providers) firecrawlScrape(ctx context.Context, key, pageURL string) (Outcome, error) {
	a, err := p.call(ctx, http.MethodPost, p.endpoints.Firecrawl+"/v2/scrape", bearer(key),
		map[string]any{"url": pageURL, "formats": []string{"markdown"}, "onlyMainContent": true})
	if err != nil {
		return Outcome{}, err
	}
	if err := classify(Firecrawl, CommandOpen, a); err != nil {
		return Outcome{}, err
	}
	var decoded struct {
		Data struct {
			Markdown string `json:"markdown"`
			Metadata struct {
				Title      string `json:"title"`
				URL        string `json:"url"`
				StatusCode int    `json:"statusCode"`
			} `json:"metadata"`
		} `json:"data"`
	}
	if json.Unmarshal(a.body, &decoded) != nil {
		return Outcome{}, &Failure{Code: CodeProviderUnavailable}
	}
	if decoded.Data.Metadata.StatusCode >= 400 {
		return Outcome{}, &Failure{Code: CodePageUnreadable}
	}
	return pageOutcome(pageURL, decoded.Data.Metadata.URL, decoded.Data.Metadata.Title, decoded.Data.Markdown)
}

func youHeader(key string) map[string]string { return map[string]string{"X-API-Key": key} }

// youWebResults is the web results of You.com's search, from the API and from
// the keyless MCP tool alike.
type youWebResults struct {
	Results struct {
		Web []struct {
			Title       string   `json:"title"`
			URL         string   `json:"url"`
			Description string   `json:"description"`
			Snippets    []string `json:"snippets"`
			PageAge     string   `json:"page_age"`
		} `json:"web"`
	} `json:"results"`
}

func (r youWebResults) outcome(limit int) Outcome {
	results := make([]Result, 0, len(r.Results.Web))
	for _, item := range r.Results.Web {
		snippet := item.Description
		if snippet == "" && len(item.Snippets) > 0 {
			snippet = item.Snippets[0]
		}
		results = appendResult(results, item.Title, item.URL, snippet, item.PageAge)
	}
	return Outcome{Results: limitResults(results, limit)}
}

func youSearchBody(request Request) map[string]any {
	body := map[string]any{"query": request.Query, "count": request.Limit}
	if request.Recency != "" {
		body["freshness"] = request.Recency
	}
	return body
}

func (p *providers) youSearch(ctx context.Context, key string, request Request) (Outcome, error) {
	a, err := p.call(ctx, http.MethodPost, p.endpoints.YouIndex+"/v1/search", youHeader(key), youSearchBody(request))
	if err != nil {
		return Outcome{}, err
	}
	if err := classify(You, CommandSearch, a); err != nil {
		return Outcome{}, err
	}
	var decoded youWebResults
	if json.Unmarshal(a.body, &decoded) != nil {
		return Outcome{}, &Failure{Code: CodeProviderUnavailable}
	}
	return decoded.outcome(request.Limit), nil
}

// youPage is one page of You.com's Extract API, which nests the Markdown
// under contents.full_page.
type youPage struct {
	URL      string `json:"url"`
	Title    string `json:"title"`
	Markdown string `json:"markdown"`
	Contents struct {
		FullPage struct {
			Markdown string `json:"markdown"`
		} `json:"full_page"`
	} `json:"contents"`
}

func (page youPage) markdown() string {
	if page.Contents.FullPage.Markdown != "" {
		return page.Contents.FullPage.Markdown
	}
	return page.Markdown
}

func (p *providers) youExtract(ctx context.Context, key, pageURL string) (Outcome, error) {
	a, err := p.call(ctx, http.MethodPost, p.endpoints.YouIndex+"/v1/extract", youHeader(key),
		map[string]any{"url": pageURL, "full_page": map[string]any{"extraction_formats": []string{"markdown"}}})
	if err != nil {
		return Outcome{}, err
	}
	if err := classify(You, CommandOpen, a); err != nil {
		return Outcome{}, err
	}
	var page youPage
	if json.Unmarshal(a.body, &page) != nil {
		return Outcome{}, &Failure{Code: CodeProviderUnavailable}
	}
	return pageOutcome(pageURL, page.URL, page.Title, page.markdown())
}

// check asks the provider's official usage endpoint whether it accepts key,
// and returns the quota it reports.
func (p *providers) check(ctx context.Context, b Backend, key string) (Quota, error) {
	ctx, cancel := context.WithTimeout(ctx, checkTimeout)
	defer cancel()
	var (
		endpoint string
		header   map[string]string
	)
	switch b {
	case Tavily:
		endpoint, header = p.endpoints.Tavily+"/usage", bearer(key)
	case Firecrawl:
		endpoint, header = p.endpoints.Firecrawl+"/v2/team/credit-usage", bearer(key)
	case You:
		endpoint, header = p.endpoints.YouAPI+"/v1/billing/account_balance", youHeader(key)
	default:
		return Quota{}, ErrInvalid
	}
	a, err := p.call(ctx, http.MethodGet, endpoint, header, nil)
	if err != nil {
		return Quota{}, ErrProviderUnavailable
	}
	switch {
	case a.status == http.StatusUnauthorized || a.status == http.StatusForbidden:
		return Quota{}, ErrKeyRejected
	case a.status < 200 || a.status >= 300:
		return Quota{}, ErrProviderUnavailable
	}
	now := time.Now()
	return parseQuota(b, a.body, now), nil
}

// quota reads a saved key's live quota; a failure is reported in the quota.
func (p *providers) quota(ctx context.Context, b Backend, key string) Quota {
	quota, err := p.check(ctx, b, key)
	switch {
	case errors.Is(err, ErrKeyRejected):
		return Quota{From: "unavailable", Reason: "key_rejected"}
	case err != nil:
		return Quota{From: "unavailable", Reason: "provider_unavailable"}
	}
	return quota
}

// parseQuota reads each provider's usage answer. An answer without the
// expected numbers still proves the key; its quota is not_reported.
func parseQuota(b Backend, body []byte, now time.Time) Quota {
	quota := Quota{From: "provider", ObservedAt: &now}
	unreported := Quota{From: "unavailable", Reason: "not_reported"}
	switch b {
	case Tavily:
		var decoded struct {
			Key struct {
				Usage *float64 `json:"usage"`
				Limit *float64 `json:"limit"`
			} `json:"key"`
			Account struct {
				CurrentPlan string   `json:"current_plan"`
				PlanUsage   *float64 `json:"plan_usage"`
				PlanLimit   *float64 `json:"plan_limit"`
			} `json:"account"`
		}
		if json.Unmarshal(body, &decoded) != nil || decoded.Account.PlanLimit == nil || decoded.Account.PlanUsage == nil {
			return unreported
		}
		remaining, limit := math.Max(0, *decoded.Account.PlanLimit-*decoded.Account.PlanUsage), *decoded.Account.PlanLimit
		// A per-key cap below the plan's remainder binds first.
		if decoded.Key.Limit != nil && decoded.Key.Usage != nil && *decoded.Key.Limit-*decoded.Key.Usage < remaining {
			remaining, limit = math.Max(0, *decoded.Key.Limit-*decoded.Key.Usage), *decoded.Key.Limit
		}
		quota.Remaining, quota.Limit, quota.Unit = &remaining, &limit, "credits"
		quota.Plan = truncateRunes(decoded.Account.CurrentPlan, 200)
	case Firecrawl:
		var decoded struct {
			Data struct {
				RemainingCredits *float64 `json:"remainingCredits"`
				PlanCredits      *float64 `json:"planCredits"`
				BillingPeriodEnd string   `json:"billingPeriodEnd"`
			} `json:"data"`
		}
		if json.Unmarshal(body, &decoded) != nil || decoded.Data.RemainingCredits == nil {
			return unreported
		}
		remaining := math.Max(0, *decoded.Data.RemainingCredits)
		quota.Remaining, quota.Unit = &remaining, "credits"
		if decoded.Data.PlanCredits != nil && *decoded.Data.PlanCredits > 0 {
			quota.Limit = decoded.Data.PlanCredits
		}
		if resets, err := time.Parse(time.RFC3339, decoded.Data.BillingPeriodEnd); err == nil {
			quota.ResetsAt = &resets
		}
	case You:
		var decoded struct {
			Data struct {
				Attributes struct {
					Balance *float64 `json:"balance"`
				} `json:"attributes"`
			} `json:"data"`
		}
		if json.Unmarshal(body, &decoded) != nil || decoded.Data.Attributes.Balance == nil {
			return unreported
		}
		// You.com reports the balance in cents.
		remaining := math.Max(0, *decoded.Data.Attributes.Balance/100)
		quota.Remaining, quota.Unit = &remaining, "usd"
	default:
		return unreported
	}
	return quota
}

var (
	htmlTag    = regexp.MustCompile(`<[^>]*>`)
	whitespace = regexp.MustCompile(`\s+`)
)

// plainText strips the markup some providers put in titles and snippets.
func plainText(value string, limit int) string {
	value = html.UnescapeString(htmlTag.ReplaceAllString(value, ""))
	return truncateRunes(strings.TrimSpace(whitespace.ReplaceAllString(value, " ")), limit)
}

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	return string([]rune(value)[:limit])
}

// appendResult keeps a result with a web URL, bounded as the contract says.
func appendResult(results []Result, title, link, snippet, published string) []Result {
	link = strings.TrimSpace(link)
	if !webURL(link) {
		return results
	}
	return append(results, Result{
		Title: plainText(title, maxTitleRunes), URL: link, Snippet: plainText(snippet, maxSnippetRunes),
		PublishedAt: truncateRunes(strings.TrimSpace(published), maxDateRunes),
	})
}

func limitResults(results []Result, limit int) []Result {
	if len(results) > limit {
		return results[:limit]
	}
	return results
}

// pageOutcome cuts a page at MaxMarkdown characters; an empty page is
// unreadable.
func pageOutcome(requested, final, title, markdown string) (Outcome, error) {
	markdown = strings.TrimSpace(markdown)
	if markdown == "" {
		return Outcome{}, &Failure{Code: CodePageUnreadable}
	}
	if !webURL(final) {
		final = requested
	}
	page := &Page{URL: final, Title: plainText(title, maxTitleRunes), Markdown: markdown}
	if utf8.RuneCountInString(markdown) > MaxMarkdown {
		page.Markdown, page.Truncated = string([]rune(markdown)[:MaxMarkdown]), true
	}
	return Outcome{Page: page}, nil
}

// webURL accepts an absolute http or https URL within the contract's bound.
func webURL(value string) bool {
	if value == "" || len(value) > MaxURLBytes {
		return false
	}
	parsed, err := url.Parse(value)
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != "" && parsed.User == nil
}

var hostPattern = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// validHost accepts a lowercase hostname with at least one dot.
func validHost(value string) bool {
	return len(value) >= 3 && len(value) <= 253 && hostPattern.MatchString(value)
}
