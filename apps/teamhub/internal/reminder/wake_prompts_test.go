package reminder

import (
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	builtinskills "github.com/simplexai-labs/linger/skills"
)

func TestTrackingRoutineWakePutsItsNoteBeforeTheInstruction(t *testing.T) {
	record := store.RoomReminder{
		Instruction:     "Remind the Human about the review. Look up first: where the pricing talk was left.",
		TrackingItemID:  pgtype.Text{String: "ti_review", Valid: true},
		TrackingPurpose: pgtype.Text{String: "pre-meeting reminder", Valid: true},
	}
	body := wakeInstruction(record)
	note, instruction := strings.Index(body, "serves Tracking Item ti_review"), strings.Index(body, record.Instruction)
	if note < 0 || instruction <= note || !strings.Contains(body[:instruction], "Look up nothing it does not ask for") {
		t.Fatalf("wake=%q", body)
	}
}

func TestPlainRoutineWakeGetsNothingAdded(t *testing.T) {
	if note := trackingNote(store.RoomReminder{Instruction: "Start the NBA deck at 14:00 on Wednesday."}); note != "" {
		t.Fatalf("plain Routine note=%q", note)
	}
}

func TestArrangingTellsHowToAskForALookUp(t *testing.T) {
	arranging := Prompt(Arranging, nil)
	if !strings.Contains(arranging, "--content") || !strings.Contains(arranging, `"Look up first: `) {
		t.Fatalf("arranging=%q", arranging)
	}
	// It points at every scenario guide, so the Agent knows which one to read.
	for _, guide := range []string{"meetings", "occasions", "travel", "deadlines", "replies"} {
		if !strings.Contains(arranging, "references/"+guide+".md") {
			t.Fatalf("arranging misses the %s guide: %q", guide, arranging)
		}
	}
}

func TestRoutineWakeAllowsAPreparedDocumentOrDeck(t *testing.T) {
	note := trackingNote(store.RoomReminder{TrackingItemID: pgtype.Text{String: "ti_review", Valid: true}})
	if !strings.Contains(note, "links to the document or deck") {
		t.Fatalf("tracking note=%q", note)
	}
	meetings, err := builtinskills.FS.ReadFile("builtin/proactive-response/1.0.3/references/meetings.md")
	for _, want := range []string{"teamhub docs create", "teamhub task create", "from the web", "earlier meetings with the same people"} {
		if err != nil || !strings.Contains(string(meetings), want) {
			t.Fatalf("meetings guide misses %q: %v", want, err)
		}
	}
}
