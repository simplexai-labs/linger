package voice

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicequicknotes"
)

func (s *Service) searchVoiceLiveMeetings(ctx context.Context, session voicelive.Session, raw string) (string, error) {
	var args struct {
		RoomID     string `json:"room_id"`
		Topic      string `json:"topic"`
		From       string `json:"event_from"`
		To         string `json:"event_to"`
		Overview   string `json:"overview"`
		ExactWords bool   `json:"exact_words"`
	}
	if err := voicelive.DecodeArguments(raw, &args); err != nil {
		return "", err
	}
	params := store.SearchVoiceLiveMeetingsParams{RoomID: session.RoomID, TenantID: session.TenantID, HumanActorID: session.HumanActorID, Topic: strings.TrimSpace(args.Topic)}
	if params.Topic != "" && !voicelive.ValidQuery(params.Topic) {
		return "", voicelive.ErrInvalid
	}
	if args.RoomID != "" {
		params.RoomID = args.RoomID
	}
	if args.From != "" {
		start, err := time.ParseInLocation(time.DateOnly, args.From, time.Local)
		if err != nil {
			return "", voicelive.ErrInvalid
		}
		params.Since = pgtype.Timestamptz{Time: start, Valid: true}
	}
	if args.To != "" {
		end, err := time.ParseInLocation(time.DateOnly, args.To, time.Local)
		if err != nil || params.Since.Valid && end.Before(params.Since.Time) {
			return "", voicelive.ErrInvalid
		}
		params.BeforeTime = pgtype.Timestamptz{Time: end.AddDate(0, 0, 1), Valid: true}
	}
	rows, err := s.queries.SearchVoiceLiveMeetings(ctx, params)
	if err != nil {
		return "", err
	}
	meetings := make([]map[string]any, 0, len(rows))
	selected := !args.ExactWords && (args.Overview == "latest" || args.Overview == "single" && len(rows) == 1)
	overviewReady := false
	for i, row := range rows {
		meeting := map[string]any{
			"started_at":               row.StartedAt.Time.In(time.Local).Format(time.RFC3339),
			"room":                     row.Room,
			"capture_id":               row.CaptureID,
			"notes_state":              row.NotesState,
			"notes":                    json.RawMessage(row.QuickNotes),
			"wiki_summary_document_id": row.WikiSummaryDocumentID,
			"transcript_document_id":   row.TranscriptDocumentID,
		}
		if row.DurationMs > 0 {
			meeting["duration_ms"] = row.DurationMs
		}
		ready := row.NotesState == "ready" && hasMeetingNoteContent(row.QuickNotes)
		// Inline one source for the newest match; other candidates retain their
		// references without bringing every meeting body into the call.
		if i == 0 && (args.ExactWords || !ready) {
			field, documentID := "wiki_summary", row.WikiSummaryDocumentID
			if args.ExactWords || documentID == "" {
				field, documentID = "transcript_excerpt", row.TranscriptDocumentID
			}
			if documentID != "" {
				limit := voicelive.MaxDocumentRunes
				if selected {
					limit *= 2
				}
				body, err := s.readVoiceLiveDocument(ctx, session, voicelive.ReadDocumentArguments{DocumentID: documentID}, limit)
				if err != nil {
					return "", err
				}
				meeting[field] = json.RawMessage(body)
				if selected {
					var doc struct {
						Text      string
						Truncated bool
					}
					ready = json.Unmarshal([]byte(body), &doc) == nil && strings.TrimSpace(doc.Text) != "" && !doc.Truncated
				}
			}
		}
		meetings = append(meetings, meeting)
		if i == 0 && selected && ready && row.DurationMs > 0 {
			overviewReady = true
			break
		}
	}
	output := map[string]any{"meetings": meetings}
	if overviewReady {
		output["status"] = "overview_ready"
	}
	return voicelive.Output(output), nil
}

func hasMeetingNoteContent(raw []byte) bool {
	var notes voicequicknotes.Notes
	if json.Unmarshal(raw, &notes) != nil {
		return false
	}
	for _, section := range notes.Sections {
		for _, bullet := range section.Bullets {
			if strings.TrimSpace(bullet) != "" {
				return true
			}
		}
	}
	return false
}
