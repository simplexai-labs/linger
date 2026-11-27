// Package mobilepush tells Paired Phones about Messages that need the Human,
// the way agent products do: once when an Agent's turn in a chat ends, not
// for every message, and at once for a decision the Human must make. A reply
// waits ReplyDelay; it is skipped when a later Agent message supersedes it,
// when the Human has read it, or when they are looking at the Room on any
// device. A database trigger enqueues one job per published Message in the
// transaction that publishes it. docs/mobile.md describes the Push Service.
package mobilepush

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Queue runs push jobs; the trigger in migration 00899 names it.
const Queue = "mobile"

// Args names one published Message's room event.
type Args struct {
	EventID  string `json:"event_id"`
	TenantID string `json:"tenant_id"`
}

// Kind is the job kind the trigger inserts.
func (Args) Kind() string { return "mobile.push" }

// InsertOpts matches what the trigger inserts.
func (Args) InsertOpts() river.InsertOpts { return river.InsertOpts{Queue: Queue, MaxAttempts: 5} }

// Kinds of push a phone may receive; docs/mobile.md lists their alert text.
const (
	KindMessage  = "message"
	KindDecision = "decision"
)

// Handle tells the phone what to open; it names no content.
type Handle struct {
	HostID  string `json:"host_id"`
	RoomID  string `json:"room_id"`
	EventID string `json:"event_id"`
}

type sendRequest struct {
	Grant  string `json:"grant"`
	Kind   string `json:"kind"`
	Handle Handle `json:"handle"`
}

// ReplyDelay is how long a reply waits before it may alert, so a Human who
// reads it in that time is not alerted and a turn's later messages replace
// it. RunGrace bounds how long a reply waits for a still-working Agent.
const (
	ReplyDelay = 30 * time.Second
	runRecheck = 30 * time.Second
	RunGrace   = 10 * time.Minute
)

// Presence reports whether an Account looked at the Room on any device
// within the last half minute.
type Presence func(accountID, roomID string) bool

// Worker works push jobs.
type Worker struct {
	river.WorkerDefaults[Args]
	queries *store.Queries
	hostID  string
	client  *http.Client
	logger  *slog.Logger
	present Presence
	now     func() time.Time
}

// NewWorker builds the worker. hostID names this computer to the phone;
// present may be nil, which counts nobody as present.
func NewWorker(pool *pgxpool.Pool, hostID string, client *http.Client, logger *slog.Logger, present Presence) *Worker {
	if present == nil {
		present = func(string, string) bool { return false }
	}
	return &Worker{queries: store.New(pool), hostID: hostID, client: client, logger: logger, present: present, now: time.Now}
}

// AddWorker registers the push job and its queue.
func AddWorker(workers *river.Workers, queues map[string]river.QueueConfig, worker *Worker) {
	queues[Queue] = river.QueueConfig{MaxWorkers: 2}
	river.AddWorker(workers, worker)
}

// Timeout bounds one delivery round to every phone.
func (w *Worker) Timeout(*river.Job[Args]) time.Duration { return 30 * time.Second }

// Work sends the alert a Message qualifies for to every phone that wants it.
// A phone whose Push Service refused its grant loses the grant; other
// failures retry the job, and a phone that already got the alert may get it
// again, which is harmless for a content-free alert that replaces its Room's
// last one.
func (w *Worker) Work(ctx context.Context, job *river.Job[Args]) error {
	facts, err := w.queries.GetMobilePushMessage(ctx, job.Args.EventID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read pushed message: %w", err)
	}
	if len(facts.DeciderActorIds) == 0 {
		if !facts.FromAgent || facts.MessageKind != "conversation" || facts.Superseded {
			return nil
		}
		age := w.now().Sub(facts.OccurredAt.Time)
		if age < ReplyDelay {
			return river.JobSnooze(ReplyDelay - age)
		}
		// The turn is not over while its Agent still works, unless it has
		// worked for so long that the Human should hear about this reply.
		if facts.RunActive && age < RunGrace {
			return river.JobSnooze(runRecheck)
		}
	}
	targets, err := w.queries.ListPushTargetsForRoom(ctx, store.ListPushTargetsForRoomParams{TenantID: facts.TenantID, RoomID: facts.RoomID})
	if err != nil {
		return fmt.Errorf("list push targets: %w", err)
	}
	var failed error
	for _, target := range targets {
		kind := Classify(facts, target)
		if kind == "" || (!target.PushWhenActive && w.present(target.AccountID, facts.RoomID)) {
			continue
		}
		request := sendRequest{Grant: target.PushGrant, Kind: kind, Handle: Handle{HostID: w.hostID, RoomID: facts.RoomID, EventID: facts.EventID}}
		status, err := w.send(ctx, target.PushServiceUrl, request)
		switch {
		case err != nil:
			failed = errors.Join(failed, err)
		case status == http.StatusGone || status == http.StatusUnauthorized:
			if err := w.queries.ClearPairedPhonePushGrant(ctx, store.ClearPairedPhonePushGrantParams{ID: target.ID, PushGrant: pgtype.Text{String: target.PushGrant, Valid: true}}); err != nil {
				failed = errors.Join(failed, err)
			}
			w.logger.Info("mobile.push_grant_dropped", "phone_id", target.ID, "status", status)
		case status == http.StatusTooManyRequests:
			// The phone's quota is spent; the alert is dropped, not retried.
			w.logger.Info("mobile.push_rate_limited", "phone_id", target.ID)
		case status >= 300:
			failed = errors.Join(failed, fmt.Errorf("push service answered %d", status))
		}
	}
	return failed
}

// Classify decides which alert, if any, one phone gets for a Message: a
// pending decision outranks a reply. A reply alerts in the Human's direct
// chat with an Agent, or in a group when the Agent mentions them, and only
// while the phone has not read that far.
func Classify(facts store.GetMobilePushMessageRow, target store.ListPushTargetsForRoomRow) string {
	switch {
	case len(facts.DeciderActorIds) > 0:
		// Only the Human the card asks; another member of the Space may not
		// even see the Room.
		if target.PushDecisions && slices.Contains(facts.DeciderActorIds, target.HumanActorID) {
			return KindDecision
		}
		return ""
	case !facts.FromAgent || facts.MessageKind != "conversation":
		return ""
	case !target.PushReplies || target.ReadThroughRoomSeq >= facts.RoomSeq:
		return ""
	case facts.FromDirectAgent && facts.DirectHumanActorID == target.HumanActorID:
		return KindMessage
	case slices.Contains(facts.MentionedActorIds, target.HumanActorID):
		return KindMessage
	default:
		return ""
	}
}

func (w *Worker) send(ctx context.Context, serviceURL string, request sendRequest) (int, error) {
	if !strings.HasPrefix(serviceURL, "https://") {
		return 0, errors.New("push service URL is not https")
	}
	body, err := json.Marshal(request)
	if err != nil {
		return 0, err
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(serviceURL, "/")+"/v1/push/send", bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	response, err := w.client.Do(httpRequest)
	if err != nil {
		return 0, fmt.Errorf("call push service: %w", err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
	return response.StatusCode, nil
}
