// Package mobilepush tells Paired Phones about Messages that need the Human:
// a reply from Another Me in their direct chat, or a decision they must make.
// A database trigger enqueues one job per published Message in the
// transaction that publishes it; the job decides whether the Message
// qualifies and asks each phone's Push Service to deliver a generic alert.
// docs/mobile.md describes the Push Service.
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
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Queue runs push jobs; the trigger in migration 00895 names it.
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

// Worker works push jobs.
type Worker struct {
	river.WorkerDefaults[Args]
	queries *store.Queries
	hostID  string
	client  *http.Client
	logger  *slog.Logger
}

// NewWorker builds the worker. hostID names this computer to the phone.
func NewWorker(pool *pgxpool.Pool, hostID string, client *http.Client, logger *slog.Logger) *Worker {
	return &Worker{queries: store.New(pool), hostID: hostID, client: client, logger: logger}
}

// AddWorker registers the push job and its queue.
func AddWorker(workers *river.Workers, queues map[string]river.QueueConfig, worker *Worker) {
	queues[Queue] = river.QueueConfig{MaxWorkers: 2}
	river.AddWorker(workers, worker)
}

// Timeout bounds one delivery round to every phone.
func (w *Worker) Timeout(*river.Job[Args]) time.Duration { return 30 * time.Second }

// Work sends the alert a Message qualifies for to every phone with a grant.
// A phone whose Push Service refused its grant loses the grant; other
// failures retry the job, and a phone that already got the alert may get it
// again, which is harmless for a content-free alert.
func (w *Worker) Work(ctx context.Context, job *river.Job[Args]) error {
	facts, err := w.queries.GetMobilePushMessage(ctx, job.Args.EventID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read pushed message: %w", err)
	}
	kind := Classify(facts.MessageKind, facts.FromAnotherMeDirect, facts.AsksDecision)
	if kind == "" {
		return nil
	}
	grants, err := w.queries.ListPushGrantsForTenant(ctx, facts.TenantID)
	if err != nil {
		return fmt.Errorf("list push grants: %w", err)
	}
	var failed error
	for _, target := range grants {
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

// Classify decides which alert, if any, a Message deserves: a pending
// decision for the Human outranks a reply.
func Classify(messageKind string, fromAnotherMeDirect, asksDecision bool) string {
	switch {
	case asksDecision:
		return KindDecision
	case fromAnotherMeDirect && messageKind == "conversation":
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
