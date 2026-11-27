package reminder

import (
	"testing"
	"time"
)

func TestCalendarCadenceKeepsConfiguredClockAfterGapDay(t *testing.T) {
	cases := []struct {
		name, kind, zone, weekday, after, want string
		hour, minute                           int
	}{
		{"daily New York", "daily", "America/New_York", "", "2026-03-08T07:45:00Z", "2026-03-09T06:30:00Z", 2, 30},
		{"daily Berlin", "daily", "Europe/Berlin", "", "2026-03-29T02:00:00Z", "2026-03-30T00:30:00Z", 2, 30},
		{"daily half-hour gap", "daily", "Australia/Lord_Howe", "", "2026-10-03T16:00:00Z", "2026-10-04T15:15:00Z", 2, 15},
		{"daily midnight gap", "daily", "America/Santiago", "", "2026-09-06T05:00:00Z", "2026-09-07T03:30:00Z", 0, 30},
		{"weekly New York next day", "weekly", "America/New_York", "monday", "2026-03-08T07:45:00Z", "2026-03-09T06:30:00Z", 2, 30},
		{"weekly New York next week", "weekly", "America/New_York", "sunday", "2026-03-08T07:45:00Z", "2026-03-15T06:30:00Z", 2, 30},
		{"weekly Berlin", "weekly", "Europe/Berlin", "monday", "2026-03-29T02:00:00Z", "2026-03-30T00:30:00Z", 2, 30},
		{"weekly half-hour gap", "weekly", "Australia/Lord_Howe", "monday", "2026-10-03T16:00:00Z", "2026-10-04T15:15:00Z", 2, 15},
		{"weekly midnight gap", "weekly", "America/Santiago", "sunday", "2026-09-06T05:00:00Z", "2026-09-13T03:30:00Z", 0, 30},
		{"daily from midnight gap slot", "daily", "America/Santiago", "", "2026-09-06T03:30:00Z", "2026-09-07T03:30:00Z", 0, 30},
		{"weekly from midnight gap slot", "weekly", "America/Santiago", "sunday", "2026-09-06T03:30:00Z", "2026-09-13T03:30:00Z", 0, 30},
		{"weekly Monday on midnight gap day", "weekly", "America/Santiago", "monday", "2026-09-06T05:00:00Z", "2026-09-07T03:30:00Z", 0, 30},
		{"daily after fall transition", "daily", "America/New_York", "", "2026-11-01T08:00:00Z", "2026-11-02T07:30:00Z", 2, 30},
		{"weekly year rollover", "weekly", "UTC", "monday", "2026-12-31T12:00:00Z", "2027-01-04T02:30:00Z", 2, 30},
		{"daily fixed offset", "daily", "Asia/Shanghai", "", "2026-11-21T19:00:00Z", "2026-11-22T18:30:00Z", 2, 30},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			after, err := time.Parse(time.RFC3339, tc.after)
			if err != nil {
				t.Fatal(err)
			}
			cadence := Cadence{Kind: tc.kind, Timezone: tc.zone, Hour: &tc.hour, Minute: &tc.minute}
			if tc.kind == "weekly" {
				cadence.Weekdays = []string{tc.weekday}
			}
			got, err := nextRunAt(cadence, after)
			if err != nil {
				t.Fatal(err)
			}
			if got.Format(time.RFC3339) != tc.want {
				t.Fatalf("next occurrence = %s, want %s", got.Format(time.RFC3339), tc.want)
			}
		})
	}
}

func TestFiredCalendarOccurrenceRetainsClockAfterDSTGap(t *testing.T) {
	hour, minute := 2, 30
	cadence := Cadence{Kind: "daily", Timezone: "America/New_York", Hour: &hour, Minute: &minute}
	dueAt := time.Date(2026, time.March, 7, 7, 30, 0, 0, time.UTC)
	now := time.Date(2026, time.March, 8, 7, 45, 0, 0, time.UTC)
	got, err := nextOccurrenceAt(cadence, dueAt, now)
	if err != nil {
		t.Fatal(err)
	}
	if got.Format(time.RFC3339) != "2026-03-09T06:30:00Z" {
		t.Fatalf("next occurrence = %s, want March 9 at 02:30 New York", got.Format(time.RFC3339))
	}
}

func TestDailyOccurrencesAdvanceThroughMidnightGap(t *testing.T) {
	cases := []struct {
		name, zone, previous, gap, following string
		minute                               int
	}{
		{"Santiago midnight", "America/Santiago", "2026-09-05T04:00:00Z", "2026-09-06T03:00:00Z", "2026-09-07T03:00:00Z", 0},
		{"Santiago half hour", "America/Santiago", "2026-09-05T04:30:00Z", "2026-09-06T03:30:00Z", "2026-09-07T03:30:00Z", 30},
		{"Havana midnight", "America/Havana", "2026-03-07T05:00:00Z", "2026-03-08T04:00:00Z", "2026-03-09T04:00:00Z", 0},
		{"Havana half hour", "America/Havana", "2026-03-07T05:30:00Z", "2026-03-08T04:30:00Z", "2026-03-09T04:30:00Z", 30},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			parse := func(value string) time.Time {
				t.Helper()
				parsed, err := time.Parse(time.RFC3339, value)
				if err != nil {
					t.Fatal(err)
				}
				return parsed
			}
			hour := 0
			cadence := Cadence{Kind: "daily", Timezone: tc.zone, Hour: &hour, Minute: &tc.minute}
			dueAt := parse(tc.previous)
			following := parse(tc.following)
			for _, want := range []time.Time{parse(tc.gap), following, following.Add(24 * time.Hour)} {
				got, err := nextOccurrenceAt(cadence, dueAt, dueAt)
				if err != nil {
					t.Fatalf("advance from %s: %v", dueAt.Format(time.RFC3339), err)
				}
				if !got.Equal(want) || !got.After(dueAt) {
					t.Fatalf("advance from %s = %s, want %s", dueAt.Format(time.RFC3339), got.Format(time.RFC3339), want.Format(time.RFC3339))
				}
				dueAt = got
			}
		})
	}
}
