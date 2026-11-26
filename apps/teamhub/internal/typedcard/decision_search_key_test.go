package typedcard

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestSearchKeyDecisionDraftsItsCard(t *testing.T) {
	t.Parallel()
	request := &SearchKeyRequest{Command: "search", Backend: "", Query: "q", Limit: 10}
	draft, err := DecisionCommand{SearchKey: &SearchKeyDecision{Prompt: " Add a key ", Backend: "tavily", Suggested: true, Reason: "free_limit", Request: request}}.draft()
	if err != nil || draft.kind != DecisionKindSearchKey || draft.text != "Add a key" || !draft.connection || draft.lifetime != 0 ||
		draft.view.(searchKeyView) != (searchKeyView{Prompt: "Add a key", Backend: "tavily", Origin: "suggested", Reason: "free_limit"}) ||
		draft.request.(*SearchKeyRequest) != request {
		t.Fatalf("search_key draft=%+v err=%v", draft, err)
	}
	draft, err = DecisionCommand{SearchKey: &SearchKeyDecision{Prompt: "Add a key", Backend: "brave", Reason: "missing"}}.draft()
	if err != nil || draft.view.(searchKeyView).Origin != "requested" {
		t.Fatalf("connect draft=%+v err=%v", draft, err)
	}
	if encoded, _ := json.Marshal(draft.request); string(encoded) != "{}" {
		t.Fatalf("connect request=%s", encoded)
	}
	for name, command := range map[string]SearchKeyDecision{
		"no prompt":    {Backend: "tavily", Reason: "missing"},
		"direct":       {Prompt: "a", Backend: "direct", Reason: "missing"},
		"no backend":   {Prompt: "a", Reason: "missing"},
		"bad reason":   {Prompt: "a", Backend: "tavily", Reason: "quota"},
		"bad command":  {Prompt: "a", Backend: "tavily", Reason: "missing", Request: &SearchKeyRequest{Command: "crawl"}},
		"empty replay": {Prompt: "a", Backend: "tavily", Reason: "missing", Request: &SearchKeyRequest{}},
	} {
		if _, err := (DecisionCommand{SearchKey: &command}).draft(); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%s: err=%v", name, err)
		}
	}
	for _, test := range []struct {
		command DecisionAnswerCommand
		valid   bool
	}{{DecisionAnswerCommand{Decision: "deny"}, true}, {DecisionAnswerCommand{Decision: "configured"}, false}, {DecisionAnswerCommand{Decision: "deny", Comment: "no"}, false}} {
		answer, status, err := normalizeDecisionAnswer(DecisionKindSearchKey, nil, test.command)
		if test.valid != (err == nil) || test.valid && (status != "denied" || answer.Decision != "deny") {
			t.Fatalf("%+v: answer=%+v status=%q err=%v", test.command, answer, status, err)
		}
	}
}

// The Agent reads the decision from the payload and what to do next from the
// sentence: run again with the configured backend, use the replayed results,
// or stop asking.
func TestSearchKeyNoticesCarryTheConfiguredBackend(t *testing.T) {
	t.Parallel()
	view := func(backend string) []byte {
		encoded, _ := json.Marshal(searchKeyView{Prompt: "Add a key", Backend: backend, Origin: "requested", Reason: "missing"})
		return encoded
	}
	tavilySearch := []byte(`{"command":"search","backend":"tavily","query":"rust 2026","limit":10}`)
	implicitSearch := []byte(`{"command":"search","query":"rust 2026","limit":10}`)
	open := []byte(`{"command":"open","backend":"tavily","url":"https://a.example/x"}`)
	task := pgtype.Text{String: "task_1", Valid: true}
	for _, test := range []struct {
		name     string
		status   string
		view     []byte
		request  []byte
		answer   string
		result   string
		alterEgo pgtype.Text
		want     string
	}{
		{"same backend", "answered", view("tavily"), tavilySearch, `{"decision":"configured","backend":"tavily"}`, "", pgtype.Text{},
			"Human interaction decision_1 resolved: The user added a Tavily API key. Run the command again.\n" +
				`payload={"decision":"configured","backend":"tavily"}`},
		{"other backend", "answered", view("tavily"), tavilySearch, `{"decision":"configured","backend":"brave"}`, "", pgtype.Text{},
			"Human interaction decision_1 resolved: The user added a Brave Search API key instead of Tavily. Run the command again with --backend brave.\n" +
				`payload={"decision":"configured","backend":"brave","requested_backend":"tavily"}`},
		{"no backend named", "answered", view("tavily"), implicitSearch, `{"decision":"configured","backend":"tavily"}`, "", pgtype.Text{},
			"The user added a Tavily API key. Run the command again with --backend tavily.\n" + `payload={"decision":"configured","backend":"tavily"}`},
		{"connect", "answered", view("firecrawl"), []byte(`{}`), `{"decision":"configured","backend":"firecrawl"}`, "", pgtype.Text{},
			"The user added a Firecrawl API key. Run the command again.\n"},
		{"vowel name", "answered", view("exa"), []byte(`{}`), `{"decision":"configured","backend":"exa"}`, "", pgtype.Text{},
			"The user added an Exa API key. Run the command again.\n"},
		{"declined", "denied", view("tavily"), tavilySearch, `{"decision":"deny"}`, "", pgtype.Text{},
			"Human interaction decision_1 resolved: The user declined to add a Tavily API key. Don't ask for it again; other backends are unaffected, and teamhub web list shows the ready ones.\n" +
				`payload={"decision":"deny"}`},
		{"declined task", "denied", view("tavily"), tavilySearch, `{"decision":"deny"}`, "", task,
			"The Sponsor declined to add a Tavily API key. Don't ask for it again"},
		{"declined keyless search", "denied", view(""), []byte(`{"command":"search","query":"rust 2026"}`), `{"decision":"deny"}`, "", pgtype.Text{},
			"The user declined to add a web search key. Don't retry; tell the user web search needs a key in Connectors."},
		{"replayed search", "answered", view("tavily"), tavilySearch, `{"decision":"configured","backend":"brave"}`,
			`{"outcome":"","data":{"results":[{"title":"T","url":"https://t.example","snippet":"s"}]}}`, pgtype.Text{},
			`The user added a Brave Search API key instead of Tavily. Results of your search for "rust 2026" are in the payload below; don't run it again.` + "\n" +
				`payload={"decision":"configured","backend":"brave","requested_backend":"tavily","results":[{"title":"T","url":"https://t.example","snippet":"s"}]}`},
		{"replayed open", "answered", view("tavily"), open, `{"decision":"configured","backend":"tavily"}`,
			`{"outcome":"","data":{"page":{"url":"https://a.example/x","markdown":"# A","truncated":false}}}`, task,
			"The Sponsor added a Tavily API key. The page from your page open of https://a.example/x is in the payload below"},
		{"replay failed", "answered", view("tavily"), tavilySearch, `{"decision":"configured","backend":"brave"}`,
			`{"outcome":"","data":{"error_code":"search_quota_exhausted"}}`, pgtype.Text{},
			`but your search for "rust 2026" failed with it (search_quota_exhausted). Decide whether to run the command again with --backend brave.` + "\n" +
				`payload={"decision":"configured","backend":"brave","requested_backend":"tavily","error_code":"search_quota_exhausted"}`},
	} {
		decision := decisionRecord{Kind: DecisionKindSearchKey, Status: test.status, View: test.view, Request: test.request,
			Answer: []byte(test.answer), AlterEgoTaskID: test.alterEgo}
		if test.result != "" {
			decision.Result = []byte(test.result)
		}
		text, err := decisionNoticeText("decision_1", decision)
		if err != nil || !strings.Contains(text, test.want) {
			t.Fatalf("%s: text=%q err=%v", test.name, text, err)
		}
		if test.alterEgo.Valid && strings.HasPrefix(text, "Human interaction") {
			t.Fatalf("%s: a Task notice names the interaction: %q", test.name, text)
		}
	}
}

func TestEncodeDecisionCardShowsTheSearchKeyView(t *testing.T) {
	t.Parallel()
	decider := store.Actor{ID: "actor_alice", Kind: "human", DisplayName: "Alice"}
	requester := store.Actor{ID: "actor_nova", Kind: "agent", DisplayName: "Nova"}
	record := store.MessageCard{CardType: "personal_notice", Intent: "decision_requested", Version: 3}
	view, _ := json.Marshal(searchKeyView{Prompt: "Add a web search key", Backend: "tavily", Origin: "suggested", Reason: "free_limit"})
	decision := decisionRecord{ID: "decision_s", Kind: DecisionKindSearchKey, Status: "answered", View: view,
		Request:   []byte(`{"command":"search","query":"secret plans"}`),
		Answer:    []byte(`{"decision":"configured","backend":"brave"}`),
		Result:    []byte(`{"outcome":"","data":{"results":[{"title":"T","url":"https://t.example","snippet":"s"}]}}`),
		DecidedAt: pgtype.Timestamptz{Time: time.Date(2026, 11, 20, 9, 0, 0, 0, time.UTC), Valid: true}}
	encoded, err := encodeDecisionCard(record, decider, requester, &decider, decision)
	if err != nil {
		t.Fatal(err)
	}
	var card map[string]any
	if err := json.Unmarshal(encoded, &card); err != nil {
		t.Fatal(err)
	}
	searchKey := card["search_key"].(map[string]any)
	if card["title"] != "Add a web search key" || searchKey["backend"] != "tavily" || searchKey["origin"] != "suggested" ||
		searchKey["reason"] != "free_limit" || card["answer"].(map[string]any)["backend"] != "brave" || card["outcome"] != nil {
		t.Fatalf("card=%s", encoded)
	}
	// The replayed results and the stored request reach only the Agent.
	if strings.Contains(string(encoded), "secret plans") || strings.Contains(string(encoded), "t.example") {
		t.Fatalf("card leaks the replay: %s", encoded)
	}
}
