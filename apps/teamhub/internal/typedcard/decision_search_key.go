package typedcard

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/websearch"
)

// searchKeyBackend reports whether a key card may show the backend: one that
// takes an API key.
func searchKeyBackend(backend string) bool { return websearch.KeyBackend(websearch.Backend(backend)) }

// SearchKeyDecision asks a Human for a web search API key. Backend is the one
// the card shows: the backend the Agent's command named, or, when it named
// none (Suggested), the first one TeamHub's order still needs a key for.
// Reason is missing, rejected or free_limit. Request is the search or page
// open the card was posted for, which TeamHub replays with a key added from
// the card; nil for a connect request. The Human may add any backend's key
// instead; saving any web search key answers the card.
type SearchKeyDecision struct {
	Prompt    string
	Backend   string
	Suggested bool
	Reason    string
	Request   *SearchKeyRequest
}

// SearchKeyRequest is a stored web search or page open. Backend is the one
// the command named, empty when it named none.
type SearchKeyRequest struct {
	Command string   `json:"command"`
	Backend string   `json:"backend,omitempty"`
	Query   string   `json:"query,omitempty"`
	Limit   int      `json:"limit,omitempty"`
	Recency string   `json:"recency,omitempty"`
	Sites   []string `json:"sites,omitempty"`
	URL     string   `json:"url,omitempty"`
}

// searchKeyView is what a search_key card shows.
type searchKeyView struct {
	Prompt  string `json:"prompt"`
	Backend string `json:"backend"`
	Origin  string `json:"origin"`
	Reason  string `json:"reason"`
}

func (command SearchKeyDecision) draft() (decisionDraft, error) {
	prompt, err := normalizeConnectionPrompt(command.Prompt)
	if err != nil || !searchKeyBackend(command.Backend) ||
		!slices.Contains([]string{"missing", "rejected", "free_limit"}, command.Reason) {
		return decisionDraft{}, ErrInvalid
	}
	var request any = struct{}{}
	if command.Request != nil {
		if command.Request.Command != "search" && command.Request.Command != "open" {
			return decisionDraft{}, ErrInvalid
		}
		request = command.Request
	}
	origin := "requested"
	if command.Suggested {
		origin = "suggested"
	}
	return decisionDraft{kind: DecisionKindSearchKey, text: prompt, request: request,
		view: searchKeyView{Prompt: prompt, Backend: command.Backend, Origin: origin, Reason: command.Reason}, connection: true}, nil
}

// reusePendingSearchKey returns the key card still waiting for the same Human
// and Agent in this Room, whichever backend it shows: any saved key answers
// it. The card then shows the latest backend, and keeps the latest request
// for the replay; a connect request, which has none, leaves the stored one.
func reusePendingSearchKey(
	ctx context.Context, tx pgx.Tx, queries *store.Queries, tenantID, roomID, agentID, humanID, alterEgoTaskID string,
	requestJSON, viewJSON []byte,
) (CreateResult, bool, error) {
	eligible, err := connectionAuthParticipants(ctx, tx, tenantID, roomID, humanID, agentID)
	if err != nil {
		return CreateResult{}, false, err
	}
	if !eligible {
		return CreateResult{}, false, ErrForbidden
	}
	pending, found, err := pendingConnectionCard(ctx, tx, `SELECT message_id,id FROM decisions
 WHERE tenant_id=$1 AND room_id=$2 AND requested_by_actor_id=$3 AND decider_actor_id=$4
 AND kind='search_key' AND status='pending' AND alter_ego_task_id IS NOT DISTINCT FROM $5
 ORDER BY created_at DESC LIMIT 1`, tenantID, roomID, agentID, humanID, optionalText(alterEgoTaskID))
	if err != nil || !found {
		return CreateResult{}, false, err
	}
	// The Room membership lock CreateDecision holds keeps the card pending
	// while it is rewritten: every answer takes that lock first.
	var storedView []byte
	if err := tx.QueryRow(ctx, `SELECT view FROM decisions WHERE id=$1`, pending.DecisionID).Scan(&storedView); err != nil {
		return CreateResult{}, false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE decisions SET view=$3::jsonb,
 request=CASE WHEN $2::jsonb='{}'::jsonb THEN request ELSE $2::jsonb END WHERE id=$1`,
		pending.DecisionID, requestJSON, viewJSON); err != nil {
		return CreateResult{}, false, err
	}
	if !jsonEqual(storedView, viewJSON) {
		if err := messagecreation.AdvanceCards(ctx, queries, tenantID, agentID, []string{pending.MessageID}); err != nil {
			return CreateResult{}, false, err
		}
	}
	return pending, true, nil
}

func jsonEqual(a, b []byte) bool {
	var left, right any
	if json.Unmarshal(a, &left) != nil || json.Unmarshal(b, &right) != nil {
		return bytes.Equal(a, b)
	}
	encodedLeft, _ := json.Marshal(left)
	encodedRight, _ := json.Marshal(right)
	return bytes.Equal(encodedLeft, encodedRight)
}

// SearchKeyCard is an open key card a Human adds a key from.
type SearchKeyCard struct {
	// Request is the call to replay; nil when a connect request posted the
	// card.
	Request *SearchKeyRequest
	// Open is false once the card has ended; the key is then saved without
	// a replay.
	Open bool
}

// SearchKeyCardRequest returns the request a search_key card stores, for its
// decision owner adding a key from it. It returns ErrNotFound for a card the
// caller cannot see, ErrForbidden for one they do not decide, and ErrInvalid
// for another kind of card.
func (s *Service) SearchKeyCardRequest(ctx context.Context, accountID, decisionID string) (SearchKeyCard, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SearchKeyCard{}, err
	}
	defer tx.Rollback(ctx)
	authority, err := store.New(tx).GetDecisionAuthority(ctx, store.GetDecisionAuthorityParams{AccountID: accountID, DecisionID: decisionID})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return SearchKeyCard{}, ErrNotFound
	case err != nil:
		return SearchKeyCard{}, err
	case authority.Kind != DecisionKindSearchKey:
		return SearchKeyCard{}, ErrInvalid
	case authority.CallerActorID != authority.DeciderActorID:
		return SearchKeyCard{}, ErrForbidden
	}
	card := SearchKeyCard{Open: authority.Open}
	var request SearchKeyRequest
	if err := json.Unmarshal(authority.Request, &request); err != nil {
		return SearchKeyCard{}, err
	}
	if request.Command != "" {
		card.Request = &request
	}
	return card, tx.Commit(ctx)
}

// SearchKeyReplay is what the replay of a card's request returned with the
// key added from that card: Results for a search, Page for a page open, or
// the agent error code of a failed call.
type SearchKeyReplay struct {
	DecisionID string          `json:"-"`
	Results    json.RawMessage `json:"results,omitempty"`
	Page       json.RawMessage `json:"page,omitempty"`
	ErrorCode  string          `json:"error_code,omitempty"`
}

// SettleSearchKeys answers every pending search_key card configured with the
// backend whose key was just saved, and wakes each waiting Agent. The card the
// key was added from also records its replay. The key belongs to the
// deployment, so it answers the cards of every tenant.
func (s *Service) SettleSearchKeys(ctx context.Context, backend string, replay *SearchKeyReplay) error {
	if !searchKeyBackend(backend) {
		return ErrInvalid
	}
	rows, err := s.pool.Query(ctx, `SELECT id FROM decisions WHERE kind='search_key' AND status='pending' ORDER BY id`)
	if err != nil {
		return err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	var replayResult []byte
	if replay != nil {
		data, err := json.Marshal(replay)
		if err != nil {
			return err
		}
		if replayResult, err = json.Marshal(decisionStoredResult{Data: data}); err != nil {
			return err
		}
	}
	var settleErr error
	for _, id := range ids {
		var result []byte
		if replay != nil && id == replay.DecisionID {
			result = replayResult
		}
		settleErr = errors.Join(settleErr, s.answerConnectionCard(ctx, id, decisionAnswer{Decision: "configured", Backend: backend}, result))
	}
	return settleErr
}

// searchKeyPayload is how an Agent reads a key card's result.
type searchKeyPayload struct {
	Decision         string          `json:"decision"`
	Backend          string          `json:"backend,omitempty"`
	RequestedBackend string          `json:"requested_backend,omitempty"`
	Results          json.RawMessage `json:"results,omitempty"`
	Page             json.RawMessage `json:"page,omitempty"`
	ErrorCode        string          `json:"error_code,omitempty"`
}

// searchKeyName is a backend's API key with its article, as the notice says it.
func searchKeyName(backend string) string {
	name := websearch.DisplayName(websearch.Backend(backend))
	if strings.ContainsAny(name[:1], "AEIOU") {
		return "an " + name + " API key"
	}
	return "a " + name + " API key"
}

// searchKeyNoticeText tells the waiting Agent how its key card ended. The
// decision is in the payload line; the sentence is for the model to read.
// A replayed call's results come with it, so the Agent need not run it again.
func searchKeyNoticeText(decisionID string, decision decisionRecord, answer decisionAnswer, result decisionStoredResult) (string, error) {
	var view searchKeyView
	if err := json.Unmarshal(decision.View, &view); err != nil {
		return "", err
	}
	var request SearchKeyRequest
	if len(decision.Request) > 0 {
		if err := json.Unmarshal(decision.Request, &request); err != nil {
			return "", err
		}
	}
	var replay SearchKeyReplay
	if len(result.Data) > 0 {
		if err := json.Unmarshal(result.Data, &replay); err != nil {
			return "", err
		}
	}
	alterEgo := decision.AlterEgoTaskID.Valid
	who, prefix := "The user", "Human interaction "+decisionID+" resolved: "
	if alterEgo {
		who, prefix = "The Sponsor", ""
	}
	// A connect request named its backend; a search without one named none.
	requested := request.Backend
	if request.Command == "" {
		requested = view.Backend
	}
	payload := searchKeyPayload{Decision: "deny"}
	text := who + " declined to add a web search key. Don't retry; tell the user web search needs a key in Connectors."
	if alterEgo {
		text = who + " declined to add a web search key. Don't retry; say in your final reply that web search needs a key in Connectors."
	}
	if requested != "" {
		// Naming the backend keeps the Agent from reporting every backend lost.
		text = who + " declined to add " + searchKeyName(requested) + ". Don't ask for it again; other backends are unaffected, and teamhub web list shows the ready ones."
	}
	if decision.Status == "answered" {
		configured := answer.Backend
		payload = searchKeyPayload{Decision: "configured", Backend: configured, Results: replay.Results, Page: replay.Page, ErrorCode: replay.ErrorCode}
		text = who + " added " + searchKeyName(configured)
		if requested != "" && requested != configured {
			payload.RequestedBackend = requested
			text += " instead of " + websearch.DisplayName(websearch.Backend(requested))
		}
		action := "search for " + strconv.Quote(request.Query)
		if request.Command == "open" {
			action = "page open of " + request.URL
		}
		rerun := " with --backend " + configured
		if requested == configured {
			rerun = ""
		}
		switch {
		case len(replay.Results) > 0:
			text += ". Results of your " + action + " are in the payload below; don't run it again."
		case len(replay.Page) > 0:
			text += ". The page from your " + action + " is in the payload below; don't open it again."
		case replay.ErrorCode != "":
			text += ", but your " + action + " failed with it (" + replay.ErrorCode + "). Decide whether to run the command again" + rerun + "."
		default:
			text += ". Run the command again" + rerun + "."
		}
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	return prefix + text + "\npayload=" + string(encoded), nil
}

// searchKeyCardView is the kind's view on a search_key card.
func searchKeyCardView(view searchKeyView) (json.RawMessage, error) {
	return json.Marshal(struct {
		Backend string `json:"backend"`
		Origin  string `json:"origin"`
		Reason  string `json:"reason"`
	}{view.Backend, view.Origin, view.Reason})
}
