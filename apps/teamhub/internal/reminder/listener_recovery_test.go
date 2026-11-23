package reminder

import (
	"context"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestGmailPollHydratesExternalTextButNotFileAttachments(t *testing.T) {
	for _, status := range []int{200, 404, 500} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			bodyCalls := 0
			provider := pollTestProvider(t, func(endpoint string, p map[string]string) (int, any) {
				switch endpoint {
				case "/gmail/v1/users/me/history":
					return 200, map[string]any{"historyId": "200", "history": []any{map[string]any{"messagesAdded": []any{map[string]any{"message": map[string]string{"id": "m1"}}}}}}
				case "/gmail/v1/users/me/messages/m1":
					return 200, map[string]any{"id": "m1", "payload": map[string]any{"mimeType": "multipart/mixed", "parts": []any{
						map[string]any{"mimeType": "text/plain", "body": map[string]string{"attachmentId": "body"}},
						map[string]any{"mimeType": "text/plain", "filename": "private.txt", "body": map[string]string{"attachmentId": "file"}},
					}}}
				case "/gmail/v1/users/me/messages/m1/attachments/body":
					bodyCalls++
					return status, map[string]string{"data": base64.RawURLEncoding.EncodeToString([]byte("Please sign today."))}
				default:
					t.Errorf("unexpected attachment read %s", endpoint)
					return 500, nil
				}
			})
			read, err := fetchGmail(t.Context(), provider, "ca", ListenerSpec{}, pollCursor{V: "100"})
			if bodyCalls != 1 {
				t.Fatal("missing external text read")
			}
			if status == 500 {
				if err == nil || read.cursor.V != "" {
					t.Fatal("temporary failure advanced cursor")
				}
				return
			}
			if err != nil || read.cursor.V != "200" {
				t.Fatalf("read=%+v error=%v", read, err)
			}
			if status == 200 && (len(read.events) != 1 || read.events[0].Snippet != "Please sign today.") {
				t.Fatal("external body lost")
			}
			if status == 404 && (len(read.events) != 1 || !strings.Contains(read.events[0].Snippet, "body unavailable")) {
				t.Fatal("missing body part discarded the message")
			}
		})
	}
}

func TestOutlookBootstrapPersistsMoreThanTenPagesAndNewMail(t *testing.T) {
	calls, bodyCalls := 0, 0
	created := time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
	provider := pollTestProvider(t, func(endpoint string, p map[string]string) (int, any) {
		if endpoint == "/v1.0/me/messages/new" {
			bodyCalls++
			return 200, map[string]any{"body": map[string]string{"contentType": "text", "content": "Reply today"}}
		}
		calls++
		page := 1
		if p["$skiptoken"] != "" {
			page, _ = strconv.Atoi(p["$skiptoken"])
		}
		if page != calls || endpoint != "/v1.0/me/mailFolders/inbox/messages/delta" {
			t.Errorf("page %d call %d endpoint %s", page, calls, endpoint)
		}
		items := []any{map[string]string{"id": "old", "createdDateTime": "2000-01-01T00:00:00Z"}}
		if page == 6 {
			items = append(items, map[string]string{"id": "new", "createdDateTime": created})
		}
		wire := map[string]any{"value": items}
		if page < 12 {
			wire["@odata.nextLink"] = fmt.Sprintf("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=%d", page+1)
		} else {
			wire["@odata.deltaLink"] = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=done"
		}
		return 200, wire
	})
	first, err := fetchOutlook(t.Context(), provider, "ca", ListenerSpec{}, pollCursor{})
	if err != nil || calls != 0 {
		t.Fatal("observation boundary was not saved before remote reads")
	}
	cursor := persistedPollCursor(t, first.cursor)
	boundary := cursor.Channels["since"]
	for page := 1; page <= 12; page++ {
		read, err := fetchOutlook(t.Context(), provider, "ca", ListenerSpec{}, cursor)
		if err != nil {
			t.Fatal(err)
		}
		cursor = persistedPollCursor(t, read.cursor)
		if boundary == "" {
			boundary = cursor.Channels["since"]
		}
		if cursor.Channels["since"] != boundary {
			t.Fatal("bootstrap boundary moved")
		}
		if page < 12 && (cursor.V != "" || cursor.PageToken == "" || read.nextPoll != time.Minute) {
			t.Fatal("bootstrap lost continuation")
		}
		if page == 6 && (len(read.events) != 1 || read.events[0].Snippet != "Reply today") {
			t.Fatal("mail arriving during bootstrap lost")
		}
	}
	if calls != 12 || bodyCalls != 1 || cursor.PageToken != "" || !strings.Contains(cursor.V, "done") {
		t.Fatalf("cursor %+v calls %d body %d", cursor, calls, bodyCalls)
	}
}

func TestOutlookExpiredContinuationReplaysCheckpointThenResyncs(t *testing.T) {
	calls := 0
	provider := pollTestProvider(t, func(_ string, p map[string]string) (int, any) {
		calls++
		if calls <= 2 {
			return 410, map[string]any{}
		}
		if p["$select"] == "" {
			t.Fatal("expired delta did not restart initial sync")
		}
		return 200, map[string]any{"@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=new"}
	})
	cursor := pollCursor{V: "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=old", PageToken: "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=expired", Channels: map[string]string{"since": "2026-10-28T00:00:00Z"}}
	for round := 1; round <= 3; round++ {
		read, err := fetchOutlook(t.Context(), provider, "ca", ListenerSpec{}, cursor)
		if err != nil {
			t.Fatal(err)
		}
		cursor = persistedPollCursor(t, read.cursor)
		if cursor.Channels["since"] != "2026-10-28T00:00:00Z" {
			t.Fatal("resync lost original observation boundary")
		}
		if round == 1 && (cursor.V == "" || cursor.PageToken != "") {
			t.Fatal("checkpoint discarded with page")
		}
		if round == 2 && (cursor.V != "" || cursor.PageToken != "") {
			t.Fatal("expired checkpoint not reset")
		}
	}
	if !strings.Contains(cursor.V, "new") {
		t.Fatal("resync did not finish")
	}
}

func TestCalendarPollCommitsEveryPageWithoutSkippingUnorderedChanges(t *testing.T) {
	calls := 0
	provider := pollTestProvider(t, func(_ string, p map[string]string) (int, any) {
		calls++
		page := 1
		if p["pageToken"] != "" {
			page, _ = strconv.Atoi(p["pageToken"])
		}
		if p["updatedMin"] != "2026-10-28T00:00:00Z" || page != calls {
			t.Fatalf("checkpoint advanced early %v", p)
		}
		wire := map[string]any{"items": []any{map[string]any{"id": fmt.Sprint(page), "updated": fmt.Sprintf("2026-10-28T%02d:00:00Z", 10-page), "created": "2026-10-01T00:00:00Z", "summary": "Meeting", "description": "<style>noise</style><p>Bring the contract.</p>", "location": "Room 2", "organizer": map[string]string{"email": "host@example.com"}}}}
		if page < 6 {
			wire["nextPageToken"] = fmt.Sprint(page + 1)
		}
		return 200, wire
	})
	cursor := pollCursor{V: "2026-10-28T00:00:00Z"}
	for page := 1; page <= 6; page++ {
		read, err := fetchGCal(t.Context(), provider, "ca", ListenerSpec{}, cursor)
		if err != nil || len(read.events) != 1 {
			t.Fatalf("read %+v error %v", read, err)
		}
		if read.events[0].Description != "Bring the contract." || read.events[0].Location != "Room 2" || read.events[0].Organizer != "host@example.com" {
			t.Fatal("calendar evidence lost")
		}
		cursor = persistedPollCursor(t, read.cursor)
		if page < 6 && (cursor.V != "2026-10-28T00:00:00Z" || cursor.PageToken == "" || read.nextPoll != time.Minute) {
			t.Fatal("unfinished round advanced")
		}
	}
	if cursor.V != "2026-10-28T09:00:00Z" || cursor.PageToken != "" || cursor.Newest != "" {
		t.Fatalf("final cursor %+v", cursor)
	}
}

func TestCalendarContinuationFailureDoesNotSkipWindow(t *testing.T) {
	for _, status := range []int{400, 403, 500} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			provider := pollTestProvider(t, func(_ string, _ map[string]string) (int, any) { return status, nil })
			cursor := pollCursor{V: "2026-10-28T00:00:00Z", PageToken: "page2", Newest: "2026-10-28T09:00:00Z"}
			read, err := fetchGCal(t.Context(), provider, "ca", ListenerSpec{}, cursor)
			if status == 400 {
				if err != nil || read.cursor.V != cursor.V || read.cursor.PageToken != "" || read.cursor.Newest != "" {
					t.Fatal("expired page lost checkpoint")
				}
			} else if err == nil {
				t.Fatal("provider failure accepted")
			}
		})
	}
}

func TestPendingPollEventsDoNotWaitForProvider(t *testing.T) {
	provider := pollTestProvider(t, func(_ string, _ map[string]string) (int, any) {
		t.Error("provider contacted with saved events pending")
		return 503, nil
	})
	service := &Service{feishuMail: feishuFeed(func(time.Time, string) ([]FeishuInboxMessage, string, error) {
		t.Error("Feishu contacted with saved events pending")
		return nil, "", nil
	})}
	for _, source := range []string{ListenerGmail, ListenerOutlook, ListenerGCal, ListenerOutlookCalendar, ListenerSlack, ListenerFeishuMail} {
		cursor := pollCursor{V: "checkpoint", PageToken: "next", Pending: []ListenerEvent{{Source: source, EventID: "saved"}}}
		read, err := service.fetchListenerPoll(t.Context(), provider, "ca", ListenerSpec{Type: source}, cursor)
		if err != nil || len(read.cursor.Pending) != 1 || len(read.events) != 0 || read.nextPoll != time.Minute || read.cursor.PageToken != "next" {
			t.Fatalf("pending lost for %s: %+v %v", source, read, err)
		}
	}
}

func TestCalendarMinimalCancellationStillReachesJudgement(t *testing.T) {
	provider := pollTestProvider(t, func(_ string, _ map[string]string) (int, any) {
		return 200, map[string]any{"items": []any{map[string]string{"id": "cancelled", "status": "cancelled"}}}
	})
	read, err := fetchGCal(t.Context(), provider, "ca", ListenerSpec{}, pollCursor{V: "2026-10-28T00:00:00Z"})
	if err != nil || len(read.events) != 1 || read.events[0].EventKind != "cancelled" || read.events[0].EventID != "cancelled:cancelled" {
		t.Fatalf("read %+v error %v", read, err)
	}
}

func TestSlackContentSubtypesReachMentionMatching(t *testing.T) {
	provider := pollTestProvider(t, func(endpoint string, _ map[string]string) (int, any) {
		switch endpoint {
		case "/auth.test":
			return 200, map[string]any{"ok": true, "team_id": "T", "user_id": "U"}
		case "/conversations.list":
			return 200, map[string]any{"ok": true, "channels": []any{map[string]string{"id": "C", "name": "team"}}}
		case "/conversations.history":
			return 200, map[string]any{"ok": true, "messages": []any{
				map[string]string{"ts": "11", "subtype": "file_share", "text": "<@U> Please review this proposal today."},
				map[string]string{"ts": "12", "subtype": "bot_message", "text": "<@U> Your build failed."},
				map[string]string{"ts": "13", "subtype": "channel_join", "text": "<@U> joined"},
			}}
		}
		return 500, nil
	})
	spec := ListenerSpec{Type: ListenerSlack, Channel: "*", Match: &ListenerMatch{Kind: "mention"}}
	read, err := fetchSlack(t.Context(), provider, "ca", spec, pollCursor{Channels: map[string]string{"C": "10"}})
	if err != nil || len(read.events) != 2 || !MatchEvent(spec, read.events[0]) || !MatchEvent(spec, read.events[1]) {
		t.Fatalf("content filtered: %+v %v", read, err)
	}
}

func TestGmailOversizedExternalPlainKeepsReadableHTML(t *testing.T) {
	for _, htmlBody := range []string{"", "<p>Reply by Friday.</p>"} {
		t.Run(fmt.Sprint(htmlBody != ""), func(t *testing.T) {
			provider := pollTestProvider(t, func(endpoint string, _ map[string]string) (int, any) {
				switch endpoint {
				case "/gmail/v1/users/me/history":
					return 200, map[string]any{"historyId": "200", "history": []any{map[string]any{"messagesAdded": []any{map[string]any{"message": map[string]string{"id": "m1"}}}}}}
				case "/gmail/v1/users/me/messages/m1":
					return 200, map[string]any{"id": "m1", "payload": map[string]any{"mimeType": "multipart/alternative", "parts": []any{
						map[string]any{"mimeType": "text/plain", "body": map[string]string{"attachmentId": "body"}},
						map[string]any{"mimeType": "text/html", "body": map[string]string{"data": base64.RawURLEncoding.EncodeToString([]byte(htmlBody))}},
					}}}
				case "/gmail/v1/users/me/messages/m1/attachments/body":
					return 200, map[string]string{"data": strings.Repeat("A", 4<<20)}
				default:
					t.Errorf("unexpected read %s", endpoint)
					return 500, nil
				}
			})
			read, err := fetchGmail(t.Context(), provider, "ca", ListenerSpec{}, pollCursor{V: "100"})
			if err != nil || len(read.events) != 1 || read.cursor.V != "200" {
				t.Fatalf("read %+v error %v", read, err)
			}
			body := read.events[0].Snippet
			if htmlBody == "" {
				if !strings.Contains(body, "body unavailable") {
					t.Fatal("missing body was not disclosed")
				}
			} else if !strings.Contains(body, "Reply by Friday.") || strings.Contains(body, "Only headers are available") {
				t.Fatalf("readable alternative hidden: %s", body)
			}
		})
	}
}

func TestOutlookCalendarBootstrapPersistsPagesAndCapturesNewEvents(t *testing.T) {
	calls := 0
	created := time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
	provider := pollTestProvider(t, func(endpoint string, p map[string]string) (int, any) {
		calls++
		page := 1
		if p["$skiptoken"] != "" {
			page, _ = strconv.Atoi(p["$skiptoken"])
		}
		if page != calls || endpoint != "/v1.0/me/calendarView/delta" {
			t.Errorf("page %d call %d endpoint %s", page, calls, endpoint)
		}
		if page == 1 && (p["startDateTime"] == "" || p["endDateTime"] == "") {
			t.Errorf("initial sync missing window bounds: %v", p)
		}
		items := []any{
			map[string]any{"id": "old", "subject": "Past review", "createdDateTime": "2000-01-01T00:00:00Z", "lastModifiedDateTime": "2000-01-01T00:00:00Z"},
			map[string]any{"id": "gone", "@removed": map[string]string{"reason": "deleted"}},
		}
		if page == 2 {
			items = append(items, map[string]any{
				"id": "new1", "subject": "Board sync",
				"createdDateTime": created, "lastModifiedDateTime": created,
				"start": map[string]string{"dateTime": "2026-11-22T09:00:00.0000000", "timeZone": "UTC"},
				"end":   map[string]string{"dateTime": "2026-11-22T10:00:00.0000000", "timeZone": "UTC"},
			})
		}
		wire := map[string]any{"value": items}
		if page < 3 {
			wire["@odata.nextLink"] = fmt.Sprintf("https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=%d", page+1)
		} else {
			wire["@odata.deltaLink"] = "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=cal_done"
		}
		return 200, wire
	})
	first, err := fetchOutlookCalendar(t.Context(), provider, "ca", ListenerSpec{}, pollCursor{})
	if err != nil || calls != 0 || first.cursor.Channels["since"] == "" || first.cursor.Channels["window_end"] == "" {
		t.Fatalf("observation boundary was not saved before remote reads: %+v calls=%d err=%v", first, calls, err)
	}
	cursor := persistedPollCursor(t, first.cursor)
	boundary := cursor.Channels["since"]
	for page := 1; page <= 3; page++ {
		read, err := fetchOutlookCalendar(t.Context(), provider, "ca", ListenerSpec{}, cursor)
		if err != nil {
			t.Fatal(err)
		}
		cursor = persistedPollCursor(t, read.cursor)
		if cursor.Channels["since"] != boundary {
			t.Fatal("bootstrap boundary moved")
		}
		if page < 3 && (cursor.V != "" || cursor.PageToken == "" || read.nextPoll != time.Minute) {
			t.Fatalf("bootstrap lost continuation on page %d: %+v", page, read)
		}
		if page == 2 {
			if len(read.events) != 1 || read.events[0].Source != ListenerOutlookCalendar || read.events[0].EventKind != "created" || read.events[0].Start != "2026-11-22T09:00:00Z" {
				t.Fatalf("event arriving during bootstrap lost: %+v", read.events)
			}
		} else if len(read.events) != 0 {
			t.Fatalf("pre-existing event or tombstone emitted during bootstrap on page %d: %+v", page, read.events)
		}
	}
	if calls != 3 || cursor.PageToken != "" || !strings.Contains(cursor.V, "cal_done") {
		t.Fatalf("final cursor=%+v calls=%d", cursor, calls)
	}
}

func TestOutlookCalendarPollClassifiesCreatedUpdatedAndCancelled(t *testing.T) {
	provider := pollTestProvider(t, func(endpoint string, p map[string]string) (int, any) {
		if endpoint != "/v1.0/me/calendarView/delta" || p["$deltatoken"] != "old" {
			t.Errorf("unexpected request %s %v", endpoint, p)
		}
		return 200, map[string]any{
			"@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=new",
			"value": []any{
				map[string]any{
					"id": "c1", "subject": "Created meeting",
					"createdDateTime": "2026-10-29T01:00:00.000Z", "lastModifiedDateTime": "2026-10-29T01:00:00.500Z",
					"start":     map[string]string{"dateTime": "2026-10-30T14:00:00.0000000", "timeZone": "UTC"},
					"end":       map[string]string{"dateTime": "2026-10-30T15:00:00.0000000", "timeZone": "UTC"},
					"location":  map[string]string{"displayName": "Room 3"},
					"organizer": map[string]any{"emailAddress": map[string]string{"name": "Host", "address": "host@example.com"}},
					"body":      map[string]string{"contentType": "html", "content": "<p>Bring notes.</p>"},
				},
				map[string]any{
					"id": "u1", "subject": "Rescheduled meeting",
					"createdDateTime": "2026-10-01T00:00:00Z", "lastModifiedDateTime": "2026-10-29T02:00:00Z",
					"start": map[string]string{"dateTime": "2026-10-31T16:00:00.0000000", "timeZone": "UTC"},
				},
				map[string]any{
					"id": "x1", "subject": "Cancelled meeting", "isCancelled": true,
					"createdDateTime": "2026-10-01T00:00:00Z", "lastModifiedDateTime": "2026-10-29T03:00:00Z",
				},
				map[string]any{"id": "d1", "@removed": map[string]string{"reason": "deleted"}},
				map[string]any{"id": "m1", "@removed": map[string]string{"reason": "changed"}},
			},
		}
	})
	cursor := pollCursor{
		V: "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=old",
		Channels: map[string]string{
			"since":        "2026-10-28T00:00:00Z",
			"window_start": time.Now().Add(-24 * time.Hour).UTC().Format(time.RFC3339),
			"window_end":   time.Now().Add(180 * 24 * time.Hour).UTC().Format(time.RFC3339),
		},
	}
	read, err := fetchOutlookCalendar(t.Context(), provider, "ca", ListenerSpec{}, cursor)
	if err != nil || len(read.events) != 4 || !strings.Contains(read.cursor.V, "$deltatoken=new") {
		t.Fatalf("read=%+v err=%v", read, err)
	}
	if read.events[0].EventKind != "created" || read.events[0].Description != "Bring notes." || read.events[0].Location != "Room 3" || read.events[0].Organizer != "Host <host@example.com>" {
		t.Fatalf("created event=%+v", read.events[0])
	}
	if read.events[1].EventKind != "updated" || read.events[1].Start != "2026-10-31T16:00:00Z" {
		t.Fatalf("updated event=%+v", read.events[1])
	}
	if read.events[2].EventKind != "cancelled" || read.events[2].MessageID != "x1" {
		t.Fatalf("isCancelled event=%+v", read.events[2])
	}
	if read.events[3].EventKind != "cancelled" || read.events[3].EventID != "d1:cancelled" {
		t.Fatalf("removed deleted event=%+v", read.events[3])
	}
}

func TestOutlookCalendarExpiredContinuationReplaysThenResyncs(t *testing.T) {
	calls := 0
	provider := pollTestProvider(t, func(_ string, p map[string]string) (int, any) {
		calls++
		if calls <= 2 {
			return 410, map[string]any{}
		}
		if p["startDateTime"] == "" || p["endDateTime"] == "" {
			t.Fatalf("expired delta did not restart initial sync: %v", p)
		}
		return 200, map[string]any{"@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=fresh"}
	})
	cursor := pollCursor{
		V:         "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=old",
		PageToken: "https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=expired",
		Channels: map[string]string{
			"since":        "2026-10-28T00:00:00Z",
			"window_start": time.Now().Add(-24 * time.Hour).UTC().Format(time.RFC3339),
			"window_end":   time.Now().Add(180 * 24 * time.Hour).UTC().Format(time.RFC3339),
		},
	}
	for round := 1; round <= 3; round++ {
		read, err := fetchOutlookCalendar(t.Context(), provider, "ca", ListenerSpec{}, cursor)
		if err != nil {
			t.Fatal(err)
		}
		cursor = persistedPollCursor(t, read.cursor)
		if cursor.Channels["since"] != "2026-10-28T00:00:00Z" {
			t.Fatal("resync lost original observation boundary")
		}
		if round == 1 && (cursor.V == "" || cursor.PageToken != "") {
			t.Fatal("checkpoint discarded with expired page")
		}
		if round == 2 && (cursor.V != "" || cursor.PageToken != "") {
			t.Fatal("expired checkpoint not reset")
		}
	}
	if !strings.Contains(cursor.V, "fresh") {
		t.Fatalf("resync did not finish: %+v", cursor)
	}
}

func TestOutlookCalendarRollsWindowBeforeCoverageExpires(t *testing.T) {
	calls := 0
	provider := pollTestProvider(t, func(endpoint string, p map[string]string) (int, any) {
		calls++
		if endpoint != "/v1.0/me/calendarView/delta" || p["$deltatoken"] != "old" {
			t.Errorf("unexpected request %s %v", endpoint, p)
		}
		return 200, map[string]any{
			"@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=drained",
			"value": []any{
				map[string]any{
					"id": "u_last", "subject": "Moved before roll",
					"createdDateTime": "2026-06-02T00:00:00Z", "lastModifiedDateTime": "2026-10-29T02:00:00Z",
					"start": map[string]string{"dateTime": "2026-11-01T10:00:00.0000000", "timeZone": "UTC"},
				},
			},
		}
	})
	cursor := pollCursor{
		V: "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=old",
		Channels: map[string]string{
			"since":        "2026-06-01T00:00:00Z",
			"window_start": "2026-05-31T00:00:00Z",
			"window_end":   time.Now().Add(10 * 24 * time.Hour).UTC().Format(time.RFC3339),
		},
	}
	read, err := fetchOutlookCalendar(t.Context(), provider, "ca", ListenerSpec{}, cursor)
	if err != nil || calls != 1 || len(read.events) != 1 || read.events[0].MessageID != "u_last" || read.cursor.V != "" || read.nextPoll != time.Minute {
		t.Fatalf("window roll must drain pending delta before resetting cursor: %+v calls=%d err=%v", read, calls, err)
	}
	if cursor.Channels["since"] != "2026-06-01T00:00:00Z" {
		t.Fatal("input cursor channels mutated before persistence")
	}
	nextEnd, err := time.Parse(time.RFC3339, read.cursor.Channels["window_end"])
	if err != nil || nextEnd.Before(time.Now().Add(150*24*time.Hour)) {
		t.Fatalf("rolled window_end too soon: %q err=%v", read.cursor.Channels["window_end"], err)
	}
}

type feishuFeed func(since time.Time, pageToken string) ([]FeishuInboxMessage, string, error)

func (f feishuFeed) FeishuInboxSince(_ context.Context, _ string, since time.Time, pageToken string) ([]FeishuInboxMessage, string, error) {
	return f(since, pageToken)
}

func TestFeishuMailListenerReportsOnlyMailAfterItsWatermark(t *testing.T) {
	start := time.Now().Add(-time.Hour)
	var asked []time.Time
	feed := feishuFeed(func(since time.Time, _ string) ([]FeishuInboxMessage, string, error) {
		asked = append(asked, since)
		return []FeishuInboxMessage{
			{ID: "new", ThreadID: "t1", From: "alice@example.com", Subject: "Plan", Body: "Meet Friday?", Received: start.Add(30 * time.Minute)},
			{ID: "old", Received: start.Add(-time.Minute)},
		}, "", nil
	})
	// The first poll only records the watermark.
	first, err := fetchFeishuMail(t.Context(), feed, "ca", pollCursor{})
	if err != nil || len(first.events) != 0 || !first.cursor.bootstrapped() || len(asked) != 0 {
		t.Fatalf("bootstrap = %+v err=%v asked=%v", first, err, asked)
	}
	cursor := pollCursor{Channels: map[string]string{"since": start.UTC().Format(time.RFC3339Nano)}}
	read, err := fetchFeishuMail(t.Context(), feed, "ca", cursor)
	if err != nil || len(read.events) != 1 || read.events[0].MessageID != "new" || read.events[0].Snippet != "Meet Friday?" || read.events[0].Source != ListenerFeishuMail {
		t.Fatalf("read = %+v err=%v", read, err)
	}
	if !MatchEvent(ListenerSpec{Type: ListenerFeishuMail}, read.events[0]) {
		t.Fatal("a Feishu Mail listener must report every inbox message")
	}
	if read.cursor.Channels["since"] != start.Add(30*time.Minute).UTC().Format(time.RFC3339Nano) {
		t.Fatalf("watermark = %s", read.cursor.Channels["since"])
	}
}

func TestFeishuMailBacklogIsReadToTheEndBeforeTheWatermarkMoves(t *testing.T) {
	start := time.Now().Add(-time.Hour).UTC()
	stamp := func(minutes int) time.Time { return start.Add(time.Duration(minutes) * time.Minute) }
	// Newest first, split across two reads: the second read starts from the
	// page the first one stopped at.
	pages := map[string]struct {
		messages []FeishuInboxMessage
		next     string
	}{
		"":       {[]FeishuInboxMessage{{ID: "m3", Received: stamp(30)}, {ID: "m2", Received: stamp(20)}}, "page-2"},
		"page-2": {[]FeishuInboxMessage{{ID: "m1", Received: stamp(10)}, {ID: "old", Received: stamp(-1)}}, ""},
	}
	var asked []string
	feed := feishuFeed(func(since time.Time, pageToken string) ([]FeishuInboxMessage, string, error) {
		if !since.Equal(start) {
			t.Errorf("read since %s, want the unmoved watermark %s", since, start)
		}
		asked = append(asked, pageToken)
		page := pages[pageToken]
		return page.messages, page.next, nil
	})
	cursor := pollCursor{Channels: map[string]string{"since": start.Format(time.RFC3339Nano)}}

	first, err := fetchFeishuMail(t.Context(), feed, "ca", cursor)
	if err != nil || len(first.events) != 2 || first.nextPoll != time.Minute {
		t.Fatalf("first read = %+v err=%v", first, err)
	}
	if got := first.cursor.Channels; got["since"] != start.Format(time.RFC3339Nano) || got["backlog_page"] != "page-2" || got["backlog_newest"] != stamp(30).Format(time.RFC3339Nano) {
		t.Fatalf("mid-backlog cursor = %v", got)
	}

	second, err := fetchFeishuMail(t.Context(), feed, "ca", first.cursor)
	if err != nil || len(second.events) != 1 || second.events[0].MessageID != "m1" {
		t.Fatalf("second read = %+v err=%v", second, err)
	}
	got := second.cursor.Channels
	if got["since"] != stamp(30).Format(time.RFC3339Nano) || got["backlog_page"] != "" || got["backlog_newest"] != "" {
		t.Fatalf("finished cursor = %v", got)
	}
	if len(asked) != 2 || asked[0] != "" || asked[1] != "page-2" {
		t.Fatalf("pages asked = %q", asked)
	}
}
