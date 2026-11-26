package typedcard

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// The AnotherMe setup prompts. Only TeamHub opens these cards: the apps card
// with the template opening, the sources card once the apps card is answered.
const (
	ProfileSetupAppsPrompt    = "Before I help with replies and follow-ups, I'd like to get to know you. The quickest way is to let me see where you talk about work — one account is enough."
	profileSetupSourcesPrompt = "Do you have a personal website or portfolio? Paste a link, or upload your resume and work samples."

	maxProfileSourceLinks       = 5
	maxProfileSourceLinkLength  = 2048
	maxProfileSourceAttachments = 5
)

// OpeningDecision is a card TeamHub posts for an Agent's opening: a question
// a new General Agent asks its Sponsor, or an AnotherMe setup card.
type OpeningDecision struct {
	Kind      string
	Prompt    string
	Questions []DecisionQuestion
	// Apps and MoreApps are the Connected App keys a profile_setup_apps card offers.
	Apps, MoreApps []string
}

// ProfileSetupAppsOpening is the apps card the template opening carries.
func ProfileSetupAppsOpening() OpeningDecision {
	return OpeningDecision{
		Kind: DecisionKindProfileSetupApps, Prompt: ProfileSetupAppsPrompt,
		Apps: []string{"gmail", "outlook", "google_calendar"}, MoreApps: []string{"github", "notion"},
	}
}

// openingView is what an opening card stores: its prompt and, by kind, its
// questions or the apps it offers.
type openingView struct {
	Prompt    string             `json:"prompt"`
	Questions []DecisionQuestion `json:"questions,omitempty"`
	Apps      []string           `json:"apps,omitempty"`
	MoreApps  []string           `json:"more_apps,omitempty"`
}

// OnboardingHandoff is the hidden Message that tells AnotherMe what its setup
// cards collected, with the uploads the sources card shared attached. Only
// AnotherMe reads it; the Human sees the cards and their recorded results.
type OnboardingHandoff struct {
	TenantID, RoomID, AccountID string
	Human, Agent                store.Actor
	CardMessageID               string
	// IdempotencyKey identifies the uploads' Document bindings; a decision is
	// answered once, so its ID serves.
	IdempotencyKey      string
	Text                string
	AttachmentUploadIDs []string
}

// OnboardingHandoffWriter persists an OnboardingHandoff in the decision's
// transaction and attaches its uploads exactly as Human message creation
// does. It runs after the decision's locks: Tenant membership, Room
// membership, the decision and card rows, then the Room's delivery row; the
// uploads lock after these and their Documents are new, matching
// createMessage's Room -> uploads order.
type OnboardingHandoffWriter func(ctx context.Context, tx pgx.Tx, queries *store.Queries, handoff OnboardingHandoff) (messagecreation.Persisted, error)

// OnboardingConnection is a Connected App account the Human granted their
// AnotherMe.
type OnboardingConnection struct {
	ID, AppName, AccountLabel string
}

// OnboardingConnections lists the Connected App accounts currently granted to
// an Agent, in the caller's transaction.
type OnboardingConnections func(ctx context.Context, tx pgx.Tx, agentActorID, tenantID string) ([]OnboardingConnection, error)

// SetOnboarding installs the handoff writer and the grant reader the app owns.
func (s *Service) SetOnboarding(writer OnboardingHandoffWriter, connections OnboardingConnections) {
	s.onboardingHandoff, s.onboardingConnections = writer, connections
}

// OnboardingProgressTx writes the hidden status that goes ahead of the
// Human's first own Message in AnotherMe's Direct Room while a setup card is
// still open, so AnotherMe answers the Message knowing what setup has
// collected. It reports false, writing nothing, in every other case, and once
// a status in the Room has offered the Profile. The
// caller publishes it before the Human's Message, in that Message's
// transaction.
func (s *Service) OnboardingProgressTx(ctx context.Context, tx pgx.Tx, queries *store.Queries, room store.Room, human store.Actor) (messagecreation.Persisted, bool, error) {
	if !room.DirectAgentActorID.Valid || human.Kind != "human" {
		return messagecreation.Persisted{}, false, nil
	}
	wrote, err := queries.HumanWroteInRoom(ctx, store.HumanWroteInRoomParams{RoomID: room.ID, HumanActorID: human.ID})
	if err != nil || wrote {
		return messagecreation.Persisted{}, false, err
	}
	cardMessageID, err := queries.GetPendingProfileSetupCard(ctx, store.GetPendingProfileSetupCardParams{
		AgentActorID: room.DirectAgentActorID.String, RoomID: room.ID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return messagecreation.Persisted{}, false, nil
	}
	if err != nil {
		return messagecreation.Persisted{}, false, err
	}
	// After a status that offered the Profile, such as the idle reminder, the
	// Human's first Message is often the reply to it.
	offered, err := queries.ProfileOfferedInRoom(ctx, store.ProfileOfferedInRoomParams{RoomID: room.ID, HumanActorID: human.ID, AgentActorID: room.DirectAgentActorID.String})
	if err != nil || offered {
		return messagecreation.Persisted{}, false, err
	}
	agent, err := queries.GetActor(ctx, store.GetActorParams{ID: room.DirectAgentActorID.String, TenantID: room.TenantID})
	if err != nil {
		return messagecreation.Persisted{}, false, err
	}
	connections, err := s.grantedConnections(ctx, tx, agent)
	if err != nil {
		return messagecreation.Persisted{}, false, err
	}
	message, err := messagecreation.CardHandoff(ctx, queries, messagecreation.Draft{
		TenantID: room.TenantID, RoomID: room.ID, Author: human, CardContextMessageID: cardMessageID,
		HumanWaiting: true,
	}, agent, " "+onboardingStatusText(onboardingStatus{connections: connections}))
	return message, err == nil, err
}

func (s *Service) grantedConnections(ctx context.Context, tx pgx.Tx, agent store.Actor) ([]OnboardingConnection, error) {
	if s.onboardingConnections == nil {
		return nil, nil
	}
	return s.onboardingConnections(ctx, tx, agent.ID, agent.TenantID)
}

// onboardingStatus is what the setup cards have collected when TeamHub tells
// AnotherMe.
type onboardingStatus struct {
	// finished reports the sources card answered; links and files come only
	// with it.
	finished    bool
	connections []OnboardingConnection
	links       []string
	files       int
	// chatted reports that the Human has written in the chat themselves.
	chatted bool
	// alreadyAsked reports that an earlier status offered the Profile while
	// the Human chatted or a Profile was already started, so the Human is not
	// asked about the Profile again.
	alreadyAsked bool
	// profileStarted reports that the Human already has a Profile or an active
	// build, so AnotherMe must not start another initial build.
	profileStarted bool
	// idleReminder reports the reminder TeamHub writes once the Room is quiet
	// while setup is unfinished; no Message of the Human's comes with it.
	idleReminder bool
}

// onboardingStatusText is the hidden status AnotherMe reads: the facts, then
// what to do with them. With nothing shared it keeps AnotherMe from reading
// the personal-profile Skill, so the chat goes on normally. The apps are the
// grants at this moment; a Connection that activates later is granted without
// another status, so the text must not read as permanent.
func onboardingStatusText(status onboardingStatus) string {
	lines := []string{"Onboarding status from TeamHub (automatic, not written by the Human)."}
	if status.finished {
		lines = append(lines, "Setup cards: finished.")
	} else {
		lines = append(lines, "Setup cards: not finished; the Human can still answer them above.")
	}
	if len(status.connections) == 0 {
		lines = append(lines, "Connected apps right now: none.")
	} else {
		lines = append(lines, "Connected apps right now:")
		for _, connection := range status.connections {
			line := "- " + connection.AppName
			if connection.AccountLabel != "" {
				line += " " + connection.AccountLabel
			}
			lines = append(lines, line+", connection "+connection.ID)
		}
	}
	shared := len(status.connections) > 0
	if status.finished {
		if len(status.links) == 0 {
			lines = append(lines, "Links: none.")
		} else {
			lines = append(lines, "Links: "+strings.Join(status.links, " "))
		}
		if status.files == 0 {
			lines = append(lines, "Files: none.")
		} else {
			lines = append(lines, fmt.Sprintf("Files: %d, attached to this message.", status.files))
		}
		shared = shared || len(status.links) > 0 || status.files > 0
	}
	switch {
	case !shared && !status.finished:
		lines = append(lines, "Answer the Human's message first. Then mention once that they can still connect an app or share links and files in the setup cards above. Do not open the personal-profile Skill until they share something.")
	case !shared:
		lines = append(lines, "The Human shared nothing. Do not open the personal-profile Skill or bring up setup again. Say briefly that you will get to know them as you talk and that they can connect apps anytime, then talk normally.")
	case status.idleReminder:
		lines = append(lines, "The Human connected these apps but has not finished setup, and has no Profile yet; no message of theirs comes with this status. Tell them once that building their profile takes a while, and ask whether to start now from what is connected. Start it with the personal-profile Skill only if they agree. Mention that they can still share links and files in the setup card.")
	case !status.finished:
		lines = append(lines, "Answer the Human's message first. Then tell them once that building their profile takes a while, and ask whether to start now from what is connected so far. Start it with the personal-profile Skill only if they agree; otherwise wait until they finish the setup cards.")
	case status.alreadyAsked:
		lines = append(lines, "You already brought up their profile; do not ask the Human about it again. If their profile is started or done, add these sources to it with the personal-profile Skill; otherwise only acknowledge them briefly.")
	case status.chatted:
		lines = append(lines, "Building their profile takes a while, so ask the Human once whether to start now from these sources, and start it with the personal-profile Skill only after they agree. If their profile is already started or done, only offer to add the sources it does not cover yet.")
	case status.profileStarted:
		lines = append(lines, "Their profile is already started or done; do not start another initial build. Add any sources here that it does not cover yet with the personal-profile Skill, and acknowledge them briefly.")
	default:
		lines = append(lines, "Tell the Human you are starting their profile from these sources, that it takes a while, and that they can talk with you about anything meanwhile. Then start it with the personal-profile Skill.")
	}
	return strings.Join(lines, "\n")
}

// CreateOpeningDecisionTx persists and publishes an opening card in the
// caller's transaction. The caller guards against a second card.
func CreateOpeningDecisionTx(
	ctx context.Context,
	queries *store.Queries,
	tenantID, roomID string,
	agent, decider store.Actor,
	opening OpeningDecision,
) (messagecreation.Result, error) {
	message, err := persistOpeningDecision(ctx, queries, tenantID, roomID, agent, decider, opening)
	if err != nil {
		return messagecreation.Result{}, err
	}
	return messagecreation.Publish(ctx, queries, message)
}

// persistOpeningDecision writes the card Message: plain prompt text with no
// mention, the Agent as requester and the Human it opens with as decider.
// These cards never expire.
func persistOpeningDecision(
	ctx context.Context,
	queries *store.Queries,
	tenantID, roomID string,
	agent, decider store.Actor,
	opening OpeningDecision,
) (messagecreation.Persisted, error) {
	view, err := normalizeOpening(opening)
	if err != nil {
		return messagecreation.Persisted{}, err
	}
	viewJSON, err := json.Marshal(view)
	if err != nil {
		return messagecreation.Persisted{}, err
	}
	content, err := messagecreation.Normalize([]messagecreation.Segment{{Type: "text", Content: view.Prompt}})
	if err != nil {
		return messagecreation.Persisted{}, err
	}
	message, err := messagecreation.Persist(ctx, queries, messagecreation.Draft{
		TenantID: tenantID, RoomID: roomID, Author: agent, Content: content,
		Card: &messagecreation.Card{
			DecisionOwnerActorID: decider.ID, CardType: "personal_notice", Intent: "decision_requested",
		},
	})
	if err != nil {
		return messagecreation.Persisted{}, err
	}
	if _, err := queries.InsertDecision(ctx, store.InsertDecisionParams{
		ID: idgen.New("decision"), TenantID: tenantID, RoomID: roomID, MessageID: message.Message.ID,
		Kind: opening.Kind, RequestedByActorID: agent.ID, DeciderActorID: decider.ID,
		Request: []byte("{}"), View: viewJSON,
	}); err != nil {
		return messagecreation.Persisted{}, err
	}
	card, found, err := hydrateCard(ctx, queries, message.Message.ID)
	if err != nil {
		return messagecreation.Persisted{}, err
	}
	if !found {
		return messagecreation.Persisted{}, ErrInvalid
	}
	message.Card = card
	return message, nil
}

func normalizeOpening(opening OpeningDecision) (openingView, error) {
	prompt, err := normalizePrompt(opening.Prompt)
	if err != nil {
		return openingView{}, err
	}
	view := openingView{Prompt: prompt}
	switch opening.Kind {
	case DecisionKindQuestion:
		if len(opening.Apps) > 0 || len(opening.MoreApps) > 0 {
			return openingView{}, ErrInvalid
		}
		view.Questions, err = normalizeQuestions(opening.Questions)
		return view, err
	case DecisionKindProfileSetupApps:
		if len(opening.Questions) > 0 || len(opening.Apps) == 0 {
			return openingView{}, ErrInvalid
		}
		view.Apps, view.MoreApps = opening.Apps, opening.MoreApps
		return view, nil
	case DecisionKindProfileSetupSources:
		if len(opening.Questions) > 0 || len(opening.Apps) > 0 || len(opening.MoreApps) > 0 {
			return openingView{}, ErrInvalid
		}
		return view, nil
	default:
		return openingView{}, ErrInvalid
	}
}

// profileSetupOutcome writes what an answered setup card announces. Each card
// records the Human's choice without waking AnotherMe. The apps card is
// followed by the sources card; the sources card finishes setup, and the
// hidden onboarding status wakes AnotherMe with everything setup collected.
func (s *Service) profileSetupOutcome(
	ctx context.Context,
	tx pgx.Tx,
	queries *store.Queries,
	authority store.GetDecisionAuthorityRow,
	answer decisionAnswer,
	accountID, decisionID string,
) ([]messagecreation.Persisted, error) {
	human, err := queries.GetActor(ctx, store.GetActorParams{ID: authority.DeciderActorID, TenantID: authority.TenantID})
	if err != nil {
		return nil, err
	}
	resultText, reply := "Connected", "Got it."
	switch {
	case authority.Kind == DecisionKindProfileSetupSources && answer.Decision == "skipped":
		resultText = "Skip"
	case authority.Kind == DecisionKindProfileSetupSources:
		resultText = "That's all"
	case answer.Decision == "skipped":
		resultText, reply = "Skip for now", "No problem."
	}
	result, err := persistDecisionResultMessage(ctx, queries, authority.TenantID, authority.RoomID, authority.MessageID, human, resultText)
	if err != nil {
		return nil, err
	}
	agent, err := queries.GetActor(ctx, store.GetActorParams{ID: authority.RequestedByActorID, TenantID: authority.TenantID})
	if err != nil {
		return nil, err
	}
	if authority.Kind == DecisionKindProfileSetupSources {
		handoff, found, err := s.onboardingFinished(ctx, tx, queries, authority, answer, accountID, decisionID, human, agent)
		if err != nil || !found {
			return []messagecreation.Persisted{result}, err
		}
		return []messagecreation.Persisted{result, handoff}, nil
	}
	content, err := messagecreation.Normalize([]messagecreation.Segment{{Type: "text", Content: reply}})
	if err != nil {
		return nil, err
	}
	acknowledgement, err := messagecreation.Persist(ctx, queries, messagecreation.Draft{
		TenantID: authority.TenantID, RoomID: authority.RoomID, Author: agent, Content: content,
	})
	if err != nil {
		return nil, err
	}
	card, err := persistOpeningDecision(ctx, queries, authority.TenantID, authority.RoomID, agent, human,
		OpeningDecision{Kind: DecisionKindProfileSetupSources, Prompt: profileSetupSourcesPrompt})
	if err != nil {
		return nil, err
	}
	return []messagecreation.Persisted{result, acknowledgement, card}, nil
}

// finishedOnboardingStatus builds the status for a completed sources card, or
// reports false when no second status is needed.
//
// Once an earlier status offered the Profile, a sources card that shares no
// links or files writes nothing, and one with new links or files hands them
// over without offering the Profile again. That guard applies only when the
// Human has written in the Room or a Profile is already started; when the Human
// has never chatted and still has no Profile (for example after an idle
// reminder fired while setup was open), finishing the setup cards completes
// onboarding and tells AnotherMe to start the Profile from everything
// collected. When a Profile was already started without an earlier offer in
// this Room, profileStarted keeps AnotherMe from starting a duplicate build.
func finishedOnboardingStatus(
	links []string,
	files int,
	chatted, offered, notStarted bool,
) (onboardingStatus, bool) {
	profileStarted := !notStarted
	alreadyAsked := offered && (chatted || profileStarted)
	if alreadyAsked && len(links) == 0 && files == 0 {
		return onboardingStatus{}, false
	}
	return onboardingStatus{
		finished: true, links: links, files: files,
		chatted: chatted, alreadyAsked: alreadyAsked, profileStarted: profileStarted,
	}, true
}

// onboardingFinished writes the hidden status of a finished setup, with the
// sources card's uploads attached, which wakes AnotherMe.
func (s *Service) onboardingFinished(
	ctx context.Context,
	tx pgx.Tx,
	queries *store.Queries,
	authority store.GetDecisionAuthorityRow,
	answer decisionAnswer,
	accountID, decisionID string,
	human, agent store.Actor,
) (messagecreation.Persisted, bool, error) {
	if s.onboardingHandoff == nil {
		return messagecreation.Persisted{}, false, errors.New("onboarding handoff writer is not configured")
	}
	chatted, err := queries.HumanWroteInRoom(ctx, store.HumanWroteInRoomParams{RoomID: authority.RoomID, HumanActorID: human.ID})
	if err != nil {
		return messagecreation.Persisted{}, false, err
	}
	offered, err := queries.ProfileOfferedInRoom(ctx, store.ProfileOfferedInRoomParams{RoomID: authority.RoomID, HumanActorID: human.ID, AgentActorID: agent.ID})
	if err != nil {
		return messagecreation.Persisted{}, false, err
	}
	notStarted, err := queries.PersonalProfileNotStarted(ctx, store.PersonalProfileNotStartedParams{TenantID: authority.TenantID, OwnerActorID: human.ID})
	if err != nil {
		return messagecreation.Persisted{}, false, err
	}
	status, ok := finishedOnboardingStatus(answer.Links, len(answer.AttachmentUploadIDs), chatted, offered, notStarted)
	if !ok {
		return messagecreation.Persisted{}, false, nil
	}
	connections, err := s.grantedConnections(ctx, tx, agent)
	if err != nil {
		return messagecreation.Persisted{}, false, err
	}
	status.connections = connections
	handoff, err := s.onboardingHandoff(ctx, tx, queries, OnboardingHandoff{
		TenantID: authority.TenantID, RoomID: authority.RoomID, AccountID: accountID,
		Human: human, Agent: agent, CardMessageID: authority.MessageID,
		IdempotencyKey: decisionID, Text: onboardingStatusText(status), AttachmentUploadIDs: answer.AttachmentUploadIDs,
	})
	return handoff, err == nil, err
}

// RemindProfileSetup wakes the AnotherMe of each unfinished setup that a newly
// active Connection serves, so a Human who connected an app but never reached
// the cards' status, for example by starting by voice, is still offered a
// Profile. Each setup is reminded once, when the Room has been quiet for
// reminder.Window, and only while the Human has no Profile and no status has
// offered one. It returns how long until a Room still in
// conversation is quiet; the caller tries again then.
func (s *Service) RemindProfileSetup(ctx context.Context, connectionID string, now time.Time) (time.Duration, error) {
	cards, err := store.New(s.pool).ListProfileSetupReminderCards(ctx, connectionID)
	if err != nil {
		return 0, err
	}
	var wait time.Duration
	for _, card := range cards {
		next, err := s.remindProfileSetup(ctx, card, now)
		if err != nil {
			return 0, err
		}
		if next > 0 && (wait == 0 || next < wait) {
			wait = next
		}
	}
	return wait, nil
}

func (s *Service) remindProfileSetup(ctx context.Context, card store.ListProfileSetupReminderCardsRow, now time.Time) (time.Duration, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	// The same lock order as a decision answer, so the Human's answer and the
	// reminder never cross.
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "room-membership|"+card.RoomID); err != nil {
		return 0, err
	}
	locked, err := queries.LockPendingProfileSetupCard(ctx, card.DecisionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	// The Human's Message path writes its status under the Room's delivery
	// lock, so the checks below run after it and see that status and the
	// Message itself.
	if err := queries.LockTenantDeliveryRooms(ctx, store.LockTenantDeliveryRoomsParams{TenantID: locked.TenantID, RoomIds: []string{card.RoomID}}); err != nil {
		return 0, err
	}
	offered, err := queries.ProfileOfferedInRoom(ctx, store.ProfileOfferedInRoomParams{RoomID: card.RoomID, HumanActorID: locked.DeciderActorID, AgentActorID: locked.RequestedByActorID})
	if err != nil || offered {
		return 0, err
	}
	notStarted, err := queries.PersonalProfileNotStarted(ctx, store.PersonalProfileNotStartedParams{TenantID: locked.TenantID, OwnerActorID: locked.DeciderActorID})
	if err != nil || !notStarted {
		return 0, err
	}
	last, err := queries.GetRoomLastConversationAt(ctx, card.RoomID)
	if err != nil {
		return 0, err
	}
	if wait := reminder.Wait(last, now, reminder.Window); wait > 0 {
		return wait, nil
	}
	human, err := queries.GetActor(ctx, store.GetActorParams{ID: locked.DeciderActorID, TenantID: locked.TenantID})
	if err != nil {
		return 0, err
	}
	agent, err := queries.GetActor(ctx, store.GetActorParams{ID: locked.RequestedByActorID, TenantID: locked.TenantID})
	if err != nil {
		return 0, err
	}
	connections, err := s.grantedConnections(ctx, tx, agent)
	if err != nil || len(connections) == 0 {
		return 0, err
	}
	status, err := messagecreation.CardHandoff(ctx, queries, messagecreation.Draft{
		TenantID: locked.TenantID, RoomID: card.RoomID, Author: human, CardContextMessageID: locked.MessageID,
	}, agent, " "+onboardingStatusText(onboardingStatus{connections: connections, idleReminder: true}))
	if err != nil {
		return 0, err
	}
	if _, err := messagecreation.Publish(ctx, queries, status); err != nil {
		return 0, err
	}
	return 0, tx.Commit(ctx)
}

// normalizeProfileSourcesAnswer takes the links and uploads a sources card
// shares, or none when the Human skips.
func normalizeProfileSourcesAnswer(command DecisionAnswerCommand) (decisionAnswer, error) {
	if command.Decision != "done" && command.Decision != "skipped" ||
		len(command.Links) > maxProfileSourceLinks || len(command.AttachmentUploadIDs) > maxProfileSourceAttachments ||
		command.Decision == "skipped" && (len(command.Links) > 0 || len(command.AttachmentUploadIDs) > 0) {
		return decisionAnswer{}, ErrInvalid
	}
	normalized := decisionAnswer{Decision: command.Decision}
	seen := map[string]struct{}{}
	for _, raw := range command.Links {
		link := strings.TrimSpace(raw)
		if !validProfileSourceLink(link) {
			return decisionAnswer{}, ErrInvalid
		}
		if _, duplicate := seen[link]; duplicate {
			continue
		}
		seen[link] = struct{}{}
		normalized.Links = append(normalized.Links, link)
	}
	uploads := map[string]struct{}{}
	for _, id := range command.AttachmentUploadIDs {
		if _, duplicate := uploads[id]; duplicate || id == "" {
			return decisionAnswer{}, ErrInvalid
		}
		uploads[id] = struct{}{}
		normalized.AttachmentUploadIDs = append(normalized.AttachmentUploadIDs, id)
	}
	return normalized, nil
}

// validProfileSourceLink accepts one absolute http(s) URL that fits on a
// single plain-text line.
func validProfileSourceLink(link string) bool {
	if link == "" || len(link) > maxProfileSourceLinkLength || strings.ContainsAny(link, " \t\r\n") {
		return false
	}
	parsed, err := url.Parse(link)
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != ""
}
