import { describe, expect, it } from "vitest";
import {
  decodeOutlookCalendar,
  decodeOutlookEvent,
  outlookBusyFromEvents,
  outlookBusyFromSchedule,
  outlookCalendarBindings,
  outlookCalendarCommandDefinitions,
  outlookDateTimeToRfc3339,
  resolveOutlookTimeZone,
  toOutlookNaiveUtc,
} from "./connector-outlook-calendar.js";

describe("connector-outlook-calendar helpers", () => {
  it("resolves Windows and IANA timezones", () => {
    expect(resolveOutlookTimeZone("China Standard Time")).toBe("Asia/Shanghai");
    expect(resolveOutlookTimeZone("Pacific Standard Time")).toBe(
      "America/Los_Angeles",
    );
    expect(resolveOutlookTimeZone("UTC")).toBe("UTC");
    expect(resolveOutlookTimeZone("Asia/Almaty")).toBe("Asia/Almaty");
    expect(resolveOutlookTimeZone("America/New_York")).toBe("America/New_York");
    expect(() => resolveOutlookTimeZone("Not A Real Zone")).toThrow(
      /Unsupported Outlook time zone/,
    );
  });

  it("converts RFC3339 timestamps to naive UTC for Outlook write schemas", () => {
    expect(toOutlookNaiveUtc("2026-11-21T10:30:00+08:00")).toBe(
      "2026-11-21T02:30:00",
    );
    expect(toOutlookNaiveUtc("2026-11-21T10:30:00Z")).toBe(
      "2026-11-21T10:30:00",
    );
  });

  it("normalizes Microsoft Graph naive dateTimeTimeZone into RFC3339", () => {
    expect(
      outlookDateTimeToRfc3339("2026-11-21T02:30:00.0000000", "UTC"),
    ).toEqual({
      dateTime: "2026-11-21T02:30:00Z",
      timeZone: "UTC",
    });
    expect(
      outlookDateTimeToRfc3339(
        "2026-11-21T10:30:00.0000000",
        "China Standard Time",
      ),
    ).toEqual({
      dateTime: "2026-11-21T10:30:00+08:00",
      timeZone: "Asia/Shanghai",
    });
    expect(() =>
      outlookDateTimeToRfc3339("2026-03-08T02:30:00", "America/New_York"),
    ).toThrow(/non-existent local date-time/);
  });

  it("decodes Outlook calendar and event payloads into canonical schema", () => {
    expect(
      decodeOutlookCalendar({
        id: "cal_1",
        name: "Calendar",
        canEdit: true,
        isDefaultCalendar: true,
      }),
    ).toEqual({
      calendarId: "cal_1",
      name: "Calendar",
      accessRole: "writer",
      primary: true,
    });

    expect(
      decodeOutlookEvent(
        {
          id: "evt_1",
          subject: "Weekly sync",
          body: { contentType: "text", content: "Agenda items" },
          location: { displayName: "Room 3B" },
          showAs: "busy",
          isCancelled: false,
          isAllDay: false,
          start: { dateTime: "2026-11-21T02:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-11-21T02:30:00.0000000", timeZone: "UTC" },
          organizer: {
            emailAddress: { name: "Owner", address: "owner@example.test" },
          },
          webLink: "https://outlook.office365.com/calendar/item/evt_1",
          onlineMeeting: {
            joinUrl: "https://teams.microsoft.com/l/meetup-join/example",
          },
          attendees: [
            {
              type: "required",
              status: { response: "accepted" },
              emailAddress: { name: "Alice", address: "alice@example.test" },
            },
          ],
        },
        "primary",
      ),
    ).toEqual({
      eventId: "evt_1",
      calendarId: "primary",
      title: "Weekly sync",
      description: "Agenda items",
      location: "Room 3B",
      status: "busy",
      start: { dateTime: "2026-11-21T02:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2026-11-21T02:30:00Z", timeZone: "UTC" },
      organizerEmail: "owner@example.test",
      url: "https://outlook.office365.com/calendar/item/evt_1",
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/example",
      attendees: [{ email: "alice@example.test", responseStatus: "accepted" }],
    });
  });

  it("extracts busy intervals from calendar view and fails closed on incomplete schedules", () => {
    const start = Date.parse("2026-11-21T09:00:00Z");
    const end = Date.parse("2026-11-21T12:00:00Z");
    expect(
      outlookBusyFromEvents(
        [
          {
            isCancelled: false,
            showAs: "busy",
            start: { dateTime: "2026-11-21T10:00:00", timeZone: "UTC" },
            end: { dateTime: "2026-11-21T11:00:00", timeZone: "UTC" },
          },
          {
            isCancelled: false,
            showAs: "free",
            start: { dateTime: "2026-11-21T09:00:00", timeZone: "UTC" },
            end: { dateTime: "2026-11-21T09:30:00", timeZone: "UTC" },
          },
          {
            isCancelled: true,
            showAs: "busy",
            start: { dateTime: "2026-11-21T11:00:00", timeZone: "UTC" },
            end: { dateTime: "2026-11-21T11:30:00", timeZone: "UTC" },
          },
        ],
        start,
        end,
      ),
    ).toEqual([
      [Date.parse("2026-11-21T10:00:00Z"), Date.parse("2026-11-21T11:00:00Z")],
    ]);

    expect(
      outlookBusyFromSchedule(
        {
          value: [
            {
              scheduleId: "alice@example.test",
              scheduleItems: [
                {
                  status: "busy",
                  start: { dateTime: "2026-11-21T09:30:00", timeZone: "UTC" },
                  end: { dateTime: "2026-11-21T10:00:00", timeZone: "UTC" },
                },
                {
                  status: "free",
                  start: { dateTime: "2026-11-21T10:00:00", timeZone: "UTC" },
                  end: { dateTime: "2026-11-21T10:30:00", timeZone: "UTC" },
                },
              ],
            },
          ],
        },
        ["alice@example.test"],
        start,
        end,
      ),
    ).toEqual([
      [Date.parse("2026-11-21T09:30:00Z"), Date.parse("2026-11-21T10:00:00Z")],
    ]);

    expect(() =>
      outlookBusyFromSchedule(
        {
          value: [
            {
              scheduleId: "alice@example.test",
              error: { message: "No access" },
              scheduleItems: [],
            },
          ],
        },
        ["alice@example.test"],
        start,
        end,
      ),
    ).toThrow(/availability is unknown/);
  });

  it("defines all 7 subcommands and exact bindings", () => {
    expect(
      outlookCalendarCommandDefinitions.map((d) => d.command.join(" ")),
    ).toEqual([
      "outlook-calendar calendars",
      "outlook-calendar list",
      "outlook-calendar read",
      "outlook-calendar free",
      "outlook-calendar create",
      "outlook-calendar update",
      "outlook-calendar cancel",
    ]);
    expect(outlookCalendarBindings("list", { date: "today" })).toEqual([
      "OUTLOOK_GET_CALENDAR_VIEW",
      "OUTLOOK_GET_MAILBOX_SETTINGS",
    ]);
    expect(
      outlookCalendarBindings("list", {
        from: "2026-11-21T00:00:00Z",
        to: "2026-11-22T00:00:00Z",
        query: "sync",
      }),
    ).toEqual(["OUTLOOK_LIST_EVENTS"]);
    expect(
      outlookCalendarBindings("update", { calendarId: "cal_secondary" }),
    ).toEqual([
      "OUTLOOK_GET_CALENDAR_EVENT",
      "OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR",
    ]);
  });
});
