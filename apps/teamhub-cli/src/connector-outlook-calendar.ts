import type { CommandDefinition } from "./command-definition.js";
import {
  assertPositionals,
  bodySource,
  option,
  values,
} from "./command-input.js";
import { conflictingFlags } from "./input-issues.js";
import {
  booleanSchema,
  email,
  number,
  pageInput,
  pageSchema,
  schema,
  stringSchema,
  text,
  usage,
} from "./connector-input.js";
import {
  connectorDefinition,
  cursor,
  nextCursor,
  optionalFields,
  record,
  requiredString,
  toggle,
  value,
  type ConnectorRuntime,
  type Json,
} from "./connector-runtime.js";
import { CliError } from "./errors.js";
import {
  array,
  calendarWriteSchema,
  eventSchema,
  id,
  object,
  pageOutput,
  rootSchema,
  str,
} from "./connector-schemas.js";
import { displayText } from "./display-text.js";
import {
  dateInZone,
  freeSlotsFromBusy,
  midnight,
  rfc3339,
  timeWindow,
  utc,
  validateTimeZone,
  validDate,
  wallTimeToInstant,
} from "./connector-calendar.js";

const PRIMARY_CALENDAR = "primary";
const MAX_FREE_CALENDAR_PAGES = 50;

// Standard CLDR Windows-to-IANA timezone mapping for Microsoft Graph
// mailboxSettings.timeZone and event dateTimeTimeZone responses.
const WINDOWS_TO_IANA: Readonly<Record<string, string>> = {
  "Dateline Standard Time": "Etc/GMT+12",
  "UTC-11": "Etc/GMT+11",
  "Aleutian Standard Time": "America/Adak",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Marquesas Standard Time": "Pacific/Marquesas",
  "Alaskan Standard Time": "America/Anchorage",
  "UTC-09": "Etc/GMT+9",
  "Pacific Standard Time (Mexico)": "America/Tijuana",
  "UTC-08": "Etc/GMT+8",
  "Pacific Standard Time": "America/Los_Angeles",
  "US Mountain Standard Time": "America/Phoenix",
  "Mountain Standard Time (Mexico)": "America/Mazatlan",
  "Mountain Standard Time": "America/Denver",
  "Yukon Standard Time": "America/Whitehorse",
  "Central America Standard Time": "America/Guatemala",
  "Central Standard Time": "America/Chicago",
  "Easter Island Standard Time": "Pacific/Easter",
  "Central Standard Time (Mexico)": "America/Mexico_City",
  "Canada Central Standard Time": "America/Regina",
  "SA Pacific Standard Time": "America/Bogota",
  "Eastern Standard Time (Mexico)": "America/Cancun",
  "Eastern Standard Time": "America/New_York",
  "Haiti Standard Time": "America/Port-au-Prince",
  "Cuba Standard Time": "America/Havana",
  "US Eastern Standard Time": "America/Indiana/Indianapolis",
  "Turks And Caicos Standard Time": "America/Grand_Turk",
  "Paraguay Standard Time": "America/Asuncion",
  "Atlantic Standard Time": "America/Halifax",
  "Venezuela Standard Time": "America/Caracas",
  "Central Brazilian Standard Time": "America/Cuiaba",
  "SA Western Standard Time": "America/La_Paz",
  "Pacific SA Standard Time": "America/Santiago",
  "Newfoundland Standard Time": "America/St_Johns",
  "Tocantins Standard Time": "America/Araguaina",
  "E. South America Standard Time": "America/Sao_Paulo",
  "SA Eastern Standard Time": "America/Cayenne",
  "Argentina Standard Time": "America/Argentina/Buenos_Aires",
  "Greenland Standard Time": "America/Nuuk",
  "Montevideo Standard Time": "America/Montevideo",
  "Magallanes Standard Time": "America/Punta_Arenas",
  "Saint Pierre Standard Time": "America/Miquelon",
  "Bahia Standard Time": "America/Bahia",
  "UTC-02": "Etc/GMT+2",
  "Azores Standard Time": "Atlantic/Azores",
  "Cape Verde Standard Time": "Atlantic/Cape_Verde",
  UTC: "UTC",
  "Coordinated Universal Time": "UTC",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "Sao Tome Standard Time": "Africa/Sao_Tome",
  "Morocco Standard Time": "Africa/Casablanca",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Romance Standard Time": "Europe/Paris",
  "Central European Standard Time": "Europe/Warsaw",
  "W. Central Africa Standard Time": "Africa/Lagos",
  "Jordan Standard Time": "Asia/Amman",
  "GTB Standard Time": "Europe/Bucharest",
  "Middle East Standard Time": "Asia/Beirut",
  "Egypt Standard Time": "Africa/Cairo",
  "E. Europe Standard Time": "Europe/Chisinau",
  "Syria Standard Time": "Asia/Damascus",
  "West Bank Standard Time": "Asia/Hebron",
  "South Africa Standard Time": "Africa/Johannesburg",
  "FLE Standard Time": "Europe/Kiev",
  "Israel Standard Time": "Asia/Jerusalem",
  "South Sudan Standard Time": "Africa/Juba",
  "Kaliningrad Standard Time": "Europe/Kaliningrad",
  "Sudan Standard Time": "Africa/Khartoum",
  "Libya Standard Time": "Africa/Tripoli",
  "Namibia Standard Time": "Africa/Windhoek",
  "Arabic Standard Time": "Asia/Baghdad",
  "Turkey Standard Time": "Europe/Istanbul",
  "Arab Standard Time": "Asia/Riyadh",
  "Belarus Standard Time": "Europe/Minsk",
  "Russian Standard Time": "Europe/Moscow",
  "E. Africa Standard Time": "Africa/Nairobi",
  "Iran Standard Time": "Asia/Tehran",
  "Arabian Standard Time": "Asia/Dubai",
  "Astrakhan Standard Time": "Europe/Astrakhan",
  "Azerbaijan Standard Time": "Asia/Baku",
  "Russia Time Zone 3": "Europe/Samara",
  "Mauritius Standard Time": "Indian/Mauritius",
  "Saratov Standard Time": "Europe/Saratov",
  "Georgian Standard Time": "Asia/Tbilisi",
  "Volgograd Standard Time": "Europe/Volgograd",
  "Caucasus Standard Time": "Asia/Yerevan",
  "Afghanistan Standard Time": "Asia/Kabul",
  "West Asia Standard Time": "Asia/Tashkent",
  "Ekaterinburg Standard Time": "Asia/Yekaterinburg",
  "Pakistan Standard Time": "Asia/Karachi",
  "Qyzylorda Standard Time": "Asia/Qyzylorda",
  "India Standard Time": "Asia/Kolkata",
  "Sri Lanka Standard Time": "Asia/Colombo",
  "Nepal Standard Time": "Asia/Kathmandu",
  "Central Asia Standard Time": "Asia/Almaty",
  "Bangladesh Standard Time": "Asia/Dhaka",
  "Omsk Standard Time": "Asia/Omsk",
  "Myanmar Standard Time": "Asia/Yangon",
  "SE Asia Standard Time": "Asia/Bangkok",
  "Altai Standard Time": "Asia/Barnaul",
  "W. Mongolia Standard Time": "Asia/Hovd",
  "North Asia Standard Time": "Asia/Krasnoyarsk",
  "N. Central Asia Standard Time": "Asia/Novosibirsk",
  "Tomsk Standard Time": "Asia/Tomsk",
  "China Standard Time": "Asia/Shanghai",
  "North Asia East Standard Time": "Asia/Irkutsk",
  "Singapore Standard Time": "Asia/Singapore",
  "W. Australia Standard Time": "Australia/Perth",
  "Taipei Standard Time": "Asia/Taipei",
  "Ulaanbaatar Standard Time": "Asia/Ulaanbaatar",
  "Aus Central W. Standard Time": "Australia/Eucla",
  "Transbaikal Standard Time": "Asia/Chita",
  "Tokyo Standard Time": "Asia/Tokyo",
  "North Korea Standard Time": "Asia/Pyongyang",
  "Korea Standard Time": "Asia/Seoul",
  "Yakutsk Standard Time": "Asia/Yakutsk",
  "Cen. Australia Standard Time": "Australia/Adelaide",
  "AUS Central Standard Time": "Australia/Darwin",
  "E. Australia Standard Time": "Australia/Brisbane",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "West Pacific Standard Time": "Pacific/Port_Moresby",
  "Tasmania Standard Time": "Australia/Hobart",
  "Vladivostok Standard Time": "Asia/Vladivostok",
  "Lord Howe Standard Time": "Australia/Lord_Howe",
  "Bougainville Standard Time": "Pacific/Bougainville",
  "Russia Time Zone 10": "Asia/Srednekolymsk",
  "Magadan Standard Time": "Asia/Magadan",
  "Norfolk Standard Time": "Pacific/Norfolk",
  "Sakhalin Standard Time": "Asia/Sakhalin",
  "Central Pacific Standard Time": "Pacific/Guadalcanal",
  "Russia Time Zone 11": "Asia/Kamchatka",
  "New Zealand Standard Time": "Pacific/Auckland",
  "UTC+12": "Etc/GMT-12",
  "Fiji Standard Time": "Pacific/Fiji",
  "Chatham Islands Standard Time": "Pacific/Chatham",
  "UTC+13": "Etc/GMT-13",
  "Tonga Standard Time": "Pacific/Tongatapu",
  "Samoa Standard Time": "Pacific/Apia",
  "Line Islands Standard Time": "Pacific/Kiritimati",
};

const pageOptions = {
  "--limit": value("1–100 items per page; default 20."),
  "--cursor": value(
    "Cursor from the previous page; keep the same account and filters.",
  ),
};
const calendarOption = { "--calendar": value("Calendar ID; default primary.") };
const bodyOptions = {
  "--content": value("Event description; exclusive with --file."),
  "--file": value("UTF-8 description file; - reads stdin."),
};
const options = {
  calendars: pageOptions,
  list: {
    ...calendarOption,
    ...pageOptions,
    "--date": value("today / tomorrow / YYYY-MM-DD; default today."),
    "--from": value("RFC3339 start time; use together with --to."),
    "--to": value("RFC3339 end time, exclusive of this instant."),
    "--timezone": value(
      "IANA time zone for date mode; default mailbox time zone.",
    ),
    "--query": value("Event subject keyword; at most 1000 characters."),
  },
  read: calendarOption,
  free: {
    "--from": value("RFC3339 start of the time window."),
    "--to": value("RFC3339 end of the time window; at most 31 days."),
    "--with": value(
      "Email of another person or room to check availability; repeatable.",
      true,
    ),
    "--calendar": value(
      "Calendar ID in this mailbox; repeatable; includes primary when omitted.",
      true,
    ),
    "--duration": value(
      "Minimum consecutive free minutes, 1–1440; default 30.",
    ),
  },
  create: {
    ...calendarOption,
    ...bodyOptions,
    "--start": value("RFC3339 start time."),
    "--end": value("RFC3339 end time; exclusive with --duration."),
    "--duration": value("Duration in minutes, 1–1440; default 30."),
    "--attendee": value("Attendee email; repeatable; at most 50.", true),
    "--location": value("Location; at most 1000 characters."),
    "--teams": toggle(
      "Request a Microsoft Teams meeting link (requires Microsoft 365 Teams).",
    ),
  },
  update: {
    ...calendarOption,
    ...bodyOptions,
    "--title": value("New title; at most 500 characters."),
    "--start": value("New start time; must be used with --end."),
    "--end": value("New end time; must be used with --start."),
    "--add-attendee": value("Add one email; repeatable.", true),
    "--remove-attendee": value(
      "Remove one email; repeatable; cannot remove the organizer.",
      true,
    ),
    "--location": value("New location."),
  },
  cancel: calendarOption,
};

type Action = keyof typeof options;

const descriptions: Record<Action, string> = {
  calendars: "List available Outlook calendars.",
  list: "List Outlook events for a day or a time window.",
  read: "Read Outlook event details and attendees.",
  free: "Find shared free time across Outlook calendars; query only, does not book.",
  create: "Create an Outlook meeting and notify attendees.",
  update: "Update a single Outlook meeting and notify attendees.",
  cancel: "Cancel an Outlook meeting as the organizer and notify attendees.",
};

export const outlookCalendarCommandDefinitions: CommandDefinition[] = (
  Object.keys(options) as Action[]
).map((action) =>
  connectorDefinition({
    command: ["outlook-calendar", action],
    app: () => "outlook",
    description: descriptions[action],
    readOnly: ["calendars", "list", "read", "free"].includes(action),
    options: options[action],
    usage:
      action === "free"
        ? [
            "teamhub outlook-calendar free --from <RFC3339> --to <RFC3339> [--with <email>] [--calendar <id>] [flags]",
          ]
        : action === "create"
          ? [
              "teamhub outlook-calendar create <title> --start <RFC3339> [--end <RFC3339> | --duration <minutes>] [flags]",
            ]
          : [
              `teamhub outlook-calendar ${action}${["read", "update", "cancel"].includes(action) ? " <event-id>" : ""} [flags]`,
            ],
    examples:
      action === "calendars"
        ? ["teamhub outlook-calendar calendars"]
        : action === "list"
          ? [
              "teamhub outlook-calendar list --date tomorrow --timezone America/New_York",
            ]
          : action === "free"
            ? [
                "teamhub outlook-calendar free --from 2026-10-19T09:00:00-04:00 --to 2026-10-19T18:00:00-04:00 --with alice@example.invalid",
              ]
            : action === "create"
              ? [
                  "teamhub outlook-calendar create 'Project sync' --start 2026-10-19T10:00:00-04:00 --duration 30 --attendee alice@example.invalid --teams",
                ]
              : action === "update"
                ? [
                    "teamhub outlook-calendar update event_example --title 'Project sync (rescheduled)' --add-attendee bob@example.invalid",
                  ]
                : action === "read"
                  ? ["teamhub outlook-calendar read event_example"]
                  : ["teamhub outlook-calendar cancel event_example"],
    inputSchema: outlookCalendarSchema(action),
    outputSchema:
      action === "calendars"
        ? rootSchema(
            {
              calendars: array(
                object(
                  {
                    calendarId: id,
                    name: str,
                    timeZone: str,
                    accessRole: str,
                    primary: { type: "boolean" },
                  },
                  ["calendarId"],
                ),
              ),
              ...pageOutput,
            },
            ["calendars", "hasMore"],
          )
        : action === "list"
          ? rootSchema({ events: array(eventSchema), ...pageOutput }, [
              "events",
              "hasMore",
            ])
          : action === "read"
            ? rootSchema({ event: eventSchema })
            : action === "free"
              ? rootSchema({
                  calendarIds: array(id),
                  window: object({
                    from: { type: "string", format: "date-time" },
                    to: { type: "string", format: "date-time" },
                  }),
                  durationMinutes: { type: "integer" },
                  slots: array(
                    object({
                      start: { type: "string", format: "date-time" },
                      end: { type: "string", format: "date-time" },
                      durationMinutes: { type: "integer" },
                    }),
                  ),
                })
              : rootSchema({ result: calendarWriteSchema }),
    normalize: async (args, reader) => {
      const input: Json = {};
      assertPositionals(
        args,
        ["read", "update", "cancel", "create"].includes(action) ? 1 : 0,
      );
      if (["read", "update", "cancel"].includes(action))
        input.eventId = text(args.positionals[0], "event ID", 1024);
      if (action !== "calendars" && action !== "free")
        input.calendarId =
          option(args, "--calendar") === undefined
            ? PRIMARY_CALENDAR
            : text(option(args, "--calendar"), "--calendar", 1024);
      if (["calendars", "list"].includes(action))
        Object.assign(input, pageInput(args));
      if (action === "list") {
        const from = option(args, "--from"),
          to = option(args, "--to"),
          date = option(args, "--date"),
          zone = option(args, "--timezone");
        if ((from === undefined) !== (to === undefined))
          usage("Provide --from and --to together.");
        if (from !== undefined) {
          if (date !== undefined || zone !== undefined)
            usage(
              "A time window cannot be combined with --date or --timezone.",
            );
          Object.assign(input, timeWindow(from, to!, 366));
        } else {
          input.date = date ?? "today";
          if (
            !["today", "tomorrow"].includes(String(input.date)) &&
            !validDate(String(input.date))
          )
            usage(
              "--date requires today, tomorrow, or a valid YYYY-MM-DD date.",
            );
          if (zone !== undefined) {
            validateTimeZone(zone);
            input.timeZone = zone;
          }
        }
        if (option(args, "--query") !== undefined)
          input.query = text(option(args, "--query"), "--query", 1000);
      }
      if (action === "free") {
        Object.assign(
          input,
          timeWindow(option(args, "--from"), option(args, "--to"), 31),
        );
        input.durationMinutes = number(
          option(args, "--duration"),
          "--duration",
          1,
          1440,
          30,
        );
        if (
          Number(input.durationMinutes) * 60000 >
          Date.parse(String(input.to)) - Date.parse(String(input.from))
        )
          usage("--duration exceeds the query window.");
        const explicit = values(args, "--calendar").map((x) =>
          text(x, "--calendar", 1024),
        );
        const calendarIds = [
          ...new Set(explicit.length ? explicit : [PRIMARY_CALENDAR]),
        ];
        const withEmails = [...new Set(values(args, "--with").map(email))];
        if (calendarIds.length + withEmails.length > 20)
          usage("At most 20 calendars may be queried.");
        input.calendarIds = calendarIds;
        if (withEmails.length) input.withEmails = withEmails;
      }
      if (action === "create" || action === "update") {
        const title =
          action === "create" ? args.positionals[0] : option(args, "--title");
        if (title !== undefined) input.title = text(title, "title", 500);
        const location = option(args, "--location");
        if (location !== undefined)
          input.location = text(location, "--location", 1000);
        const content = await bodySource(args, reader, false);
        if (content !== undefined) {
          if (Buffer.byteLength(content) > 1 << 20)
            usage("The description exceeds 1 MiB.");
          input.description = content;
        }
        const start = option(args, "--start"),
          end = option(args, "--end"),
          duration = option(args, "--duration");
        if (action === "create") {
          input.start = rfc3339(start, "--start");
          if (end !== undefined && duration !== undefined)
            throw conflictingFlags(["--end", "--duration"]);
          input.end =
            end === undefined
              ? new Date(
                  Date.parse(String(input.start)) +
                    number(duration, "--duration", 1, 1440, 30)! * 60000,
                ).toISOString()
              : rfc3339(end, "--end");
          if (option(args, "--teams")) input.teams = true;
        } else if (start !== undefined || end !== undefined) {
          if (start === undefined || end === undefined)
            usage("Provide --start and --end together.");
          input.start = rfc3339(start, "--start");
          input.end = rfc3339(end, "--end");
        }
        if (
          input.start !== undefined &&
          Date.parse(String(input.end)) <= Date.parse(displayText(input.start))
        )
          usage("--end must be later than --start.");
        for (const [flag, key] of action === "create"
          ? [["--attendee", "attendees"]]
          : [
              ["--add-attendee", "addAttendees"],
              ["--remove-attendee", "removeAttendees"],
            ]) {
          const list = [...new Set(values(args, flag!).map(email))];
          if (list.length > 50) usage("At most 50 attendees are allowed.");
          if (list.length) input[key!] = list;
        }
        if (
          (input.addAttendees as string[] | undefined)?.some((x) =>
            (input.removeAttendees as string[] | undefined)?.includes(x),
          )
        )
          usage("The same attendee cannot be added and removed.");
        if (
          action === "update" &&
          ![
            "title",
            "location",
            "description",
            "start",
            "addAttendees",
            "removeAttendees",
          ].some((x) => input[x] !== undefined)
        )
          usage("Provide at least one event change.");
      }
      return { input };
    },
    bindings: (input) => outlookCalendarBindings(action, input),
    execute: async (input, runtime) => {
      const result = await executeOutlookCalendar(action, input, runtime);
      return ["create", "update", "cancel"].includes(action)
        ? { result }
        : result;
    },
  }),
);

export function outlookCalendarBindings(
  action: Action,
  input: Json,
): readonly string[] {
  const specific = !isDefaultCalendar(input.calendarId);
  if (action === "calendars") return ["OUTLOOK_LIST_CALENDARS"];
  if (action === "list")
    return [
      input.query !== undefined
        ? "OUTLOOK_LIST_EVENTS"
        : "OUTLOOK_GET_CALENDAR_VIEW",
      ...(input.date !== undefined && input.timeZone === undefined
        ? ["OUTLOOK_GET_MAILBOX_SETTINGS"]
        : []),
    ];
  if (action === "read")
    return [specific ? "OUTLOOK_GET_CALENDAR_EVENT" : "OUTLOOK_GET_EVENT"];
  if (action === "free") {
    const withEmails = (input.withEmails as string[] | undefined) ?? [];
    return [
      "OUTLOOK_GET_CALENDAR_VIEW",
      ...(withEmails.length ? ["OUTLOOK_GET_CALENDAR_SCHEDULE"] : []),
    ];
  }
  if (action === "create") return ["OUTLOOK_CALENDAR_CREATE_EVENT"];
  if (action === "update")
    return [
      specific ? "OUTLOOK_GET_CALENDAR_EVENT" : "OUTLOOK_GET_EVENT",
      specific
        ? "OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR"
        : "OUTLOOK_UPDATE_CALENDAR_EVENT",
    ];
  return [
    specific ? "OUTLOOK_GET_CALENDAR_EVENT" : "OUTLOOK_GET_EVENT",
    specific ? "OUTLOOK_CANCEL_CALENDAR_EVENT" : "OUTLOOK_CANCEL_EVENT",
    specific
      ? "OUTLOOK_DELETE_CALENDAR_EVENT_FROM_SPECIFIC_CALENDAR"
      : "OUTLOOK_DELETE_CALENDAR_EVENT",
  ];
}

function outlookCalendarSchema(action: Action): Json {
  const time = { type: "string", format: "date-time" };
  const list = {
    type: "array",
    items: { type: "string", format: "email" },
    maxItems: 50,
  };
  return schema(
    action === "calendars"
      ? pageSchema
      : action === "free"
        ? {
            from: time,
            to: time,
            calendarIds: {
              type: "array",
              items: stringSchema,
              minItems: 1,
              maxItems: 20,
            },
            withEmails: {
              type: "array",
              items: { type: "string", format: "email" },
              maxItems: 20,
            },
            durationMinutes: {
              type: "integer",
              minimum: 1,
              maximum: 1440,
              default: 30,
            },
          }
        : {
            calendarId: { ...stringSchema, default: PRIMARY_CALENDAR },
            ...(action === "list"
              ? {
                  ...pageSchema,
                  date: stringSchema,
                  timeZone: stringSchema,
                  from: time,
                  to: time,
                  query: stringSchema,
                }
              : action === "read" || action === "cancel"
                ? { eventId: stringSchema }
                : {
                    eventId: stringSchema,
                    title: stringSchema,
                    start: time,
                    end: time,
                    description: { type: "string" },
                    location: stringSchema,
                    attendees: list,
                    addAttendees: list,
                    removeAttendees: list,
                    teams: booleanSchema,
                  }),
          },
  );
}

function isDefaultCalendar(calendarId: unknown): boolean {
  return calendarId === undefined || calendarId === PRIMARY_CALENDAR;
}

/**
 * Resolves an IANA or Windows timezone name from Microsoft Graph into a valid
 * IANA timezone identifier usable by Intl.DateTimeFormat.
 */
export function resolveOutlookTimeZone(raw: string): string {
  const trimmed = raw.trim();
  const candidate = WINDOWS_TO_IANA[trimmed] ?? trimmed;
  try {
    new Intl.DateTimeFormat("en", { timeZone: candidate }).format();
    return candidate;
  } catch {
    throw new CliError(
      "incomplete_response",
      `Unsupported Outlook time zone: ${trimmed}.`,
    );
  }
}

/**
 * Converts an RFC3339 timestamp to naive UTC YYYY-MM-DDTHH:MM:SS(.sss) as
 * required by OUTLOOK_CALENDAR_CREATE_EVENT and OUTLOOK_UPDATE_CALENDAR_EVENT.
 */
export function toOutlookNaiveUtc(rfc: string): string {
  return new Date(Date.parse(rfc))
    .toISOString()
    .replace(/\.000Z$/u, "")
    .replace(/Z$/u, "");
}

function formatOffset(minutes: number): string {
  if (minutes === 0) return "Z";
  const sign = minutes > 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/**
 * Converts a Microsoft Graph dateTimeTimeZone object (whose dateTime typically
 * lacks a timezone suffix and may carry 7 fractional digits) into valid RFC3339.
 */
export function outlookDateTimeToRfc3339(
  dateTime: string,
  timeZone?: string,
): { dateTime: string; timeZone?: string } {
  const trimmed = dateTime.trim();
  const withOffset =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u.exec(
      trimmed,
    );
  if (withOffset) {
    const frac = withOffset[2]?.replace(/0+$/u, "") ?? "";
    const normalized = `${withOffset[1]}${frac ? `.${frac.slice(0, 3)}` : ""}${withOffset[3]}`;
    const resolvedZone =
      typeof timeZone === "string" && timeZone.trim()
        ? resolveOutlookTimeZone(timeZone)
        : undefined;
    return optionalFields({
      dateTime: normalized,
      timeZone: resolvedZone,
    }) as { dateTime: string; timeZone?: string };
  }
  const naive = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/u.exec(
    trimmed,
  );
  if (!naive)
    throw new CliError(
      "incomplete_response",
      `Unrecognized Outlook date-time: ${trimmed}.`,
    );
  const base = naive[1]!;
  const frac = naive[2]?.replace(/0+$/u, "") ?? "";
  const cleanFrac = frac ? `.${frac.slice(0, 3)}` : "";
  const zone =
    typeof timeZone === "string" && timeZone.trim()
      ? resolveOutlookTimeZone(timeZone)
      : "UTC";
  if (zone === "UTC" || zone === "Etc/UTC") {
    return { dateTime: `${base}${cleanFrac}Z`, timeZone: "UTC" };
  }
  const instant = wallTimeToInstant(base, zone);
  if (instant === undefined)
    throw new CliError(
      "incomplete_response",
      `Outlook returned a non-existent local date-time in ${zone}: ${trimmed}.`,
    );
  const offsetMinutes = Math.round((Date.parse(`${base}Z`) - instant) / 60000);
  return {
    dateTime: `${base}${cleanFrac}${formatOffset(offsetMinutes)}`,
    timeZone: zone,
  };
}

function unwrapOutlookPayload(raw: Json): Json {
  if (
    raw.response_data &&
    typeof raw.response_data === "object" &&
    !Array.isArray(raw.response_data)
  )
    return raw.response_data as Json;
  if (raw.event && typeof raw.event === "object" && !Array.isArray(raw.event))
    return raw.event as Json;
  return raw;
}

function extractOutlookList(
  raw: Json,
  fallbackKey: string,
): {
  rows: unknown[];
  token: unknown;
} {
  const payload = unwrapOutlookPayload(raw);
  const rows =
    payload.value ?? payload[fallbackKey] ?? payload.items ?? raw.value;
  if (!Array.isArray(rows))
    throw new CliError(
      "incomplete_response",
      "The Outlook calendar page is incomplete.",
    );
  const token = raw.next_page_token ?? payload.next_page_token;
  if (!token && (payload["@odata.nextLink"] || raw["@odata.nextLink"]))
    throw new CliError(
      "incomplete_response",
      "The selected tool did not provide a usable continuation token.",
    );
  return { rows, token };
}

function parseOutlookTimeInstant(raw: unknown, label: string): number {
  const entry = record(raw, label);
  const dt = requiredString(entry.dateTime, `${label} dateTime`);
  const tz = typeof entry.timeZone === "string" ? entry.timeZone : undefined;
  const normalized = outlookDateTimeToRfc3339(dt, tz).dateTime;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms))
    throw new CliError("incomplete_response", `Invalid ${label} timestamp.`);
  return ms;
}

/**
 * Extracts busy intervals from OUTLOOK_GET_CALENDAR_SCHEDULE for every
 * requested email address. Missing or errored schedules fail closed.
 */
export function outlookBusyFromSchedule(
  raw: Json,
  emails: readonly string[],
  start: number,
  end: number,
): [number, number][] {
  function unknown(): never {
    throw new CliError(
      "incomplete_response",
      "A requested schedule is missing, inaccessible, or incomplete; availability is unknown.",
    );
  }
  const payload = unwrapOutlookPayload(raw);
  const entries = payload.value ?? raw.value ?? payload.items;
  if (!Array.isArray(entries)) unknown();
  const byEmail = new Map<string, Json>();
  for (const item of entries) {
    const entry =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Json)
        : unknown();
    if (typeof entry.scheduleId === "string" && entry.scheduleId.trim())
      byEmail.set(entry.scheduleId.trim().toLowerCase(), entry);
  }
  const busy: [number, number][] = [];
  for (const address of emails) {
    const entry = byEmail.get(address.toLowerCase());
    if (!entry) unknown();
    if (entry.error !== undefined && entry.error !== null) unknown();
    const scheduleItems = entry.scheduleItems;
    if (!Array.isArray(scheduleItems)) unknown();
    for (const item of scheduleItems) {
      const slot =
        item && typeof item === "object" && !Array.isArray(item)
          ? (item as Json)
          : unknown();
      const status =
        typeof slot.status === "string" ? slot.status.toLowerCase() : "";
      if (status === "free") continue;
      let a: number;
      let b: number;
      try {
        a = parseOutlookTimeInstant(slot.start, "schedule item start");
        b = parseOutlookTimeInstant(slot.end, "schedule item end");
      } catch {
        unknown();
      }
      if (b <= a) unknown();
      if (Math.min(b, end) > Math.max(a, start))
        busy.push([Math.max(a, start), Math.min(b, end)]);
    }
  }
  return busy;
}

/**
 * Extracts busy intervals from calendarView event objects. Cancelled events and
 * events marked showAs="free" do not block availability.
 */
export function outlookBusyFromEvents(
  events: readonly unknown[],
  start: number,
  end: number,
): [number, number][] {
  const busy: [number, number][] = [];
  for (const item of events) {
    const event = record(item, "calendar event");
    if (event.isCancelled === true) continue;
    const showAs =
      typeof event.showAs === "string" ? event.showAs.toLowerCase() : "busy";
    if (showAs === "free") continue;
    const a = parseOutlookTimeInstant(event.start, "event start");
    const b = parseOutlookTimeInstant(event.end, "event end");
    if (b <= a)
      throw new CliError(
        "incomplete_response",
        "An Outlook event has an invalid start/end range.",
      );
    if (Math.min(b, end) > Math.max(a, start))
      busy.push([Math.max(a, start), Math.min(b, end)]);
  }
  return busy;
}

async function readOutlookEvent(
  runtime: ConnectorRuntime,
  calendarId: string,
  eventId: unknown,
): Promise<Json> {
  const raw = isDefaultCalendar(calendarId)
    ? await runtime.call("OUTLOOK_GET_EVENT", {
        event_id: eventId,
      })
    : await runtime.call("OUTLOOK_GET_CALENDAR_EVENT", {
        calendar_id: calendarId,
        event_id: eventId,
      });
  return unwrapOutlookPayload(raw);
}

export async function executeOutlookCalendar(
  action: Action,
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  const calendarId = displayText(input.calendarId ?? PRIMARY_CALENDAR);

  if (action === "free") {
    const ownCalendars = input.calendarIds as string[];
    const withEmails = (input.withEmails as string[] | undefined) ?? [];
    const from = displayText(input.from);
    const to = displayText(input.to);
    const startMs = Date.parse(from);
    const endMs = Date.parse(to);
    const busy: [number, number][] = [];

    for (const calId of ownCalendars) {
      let pageToken: unknown = undefined;
      for (let page = 0; page < MAX_FREE_CALENDAR_PAGES; page++) {
        const raw = await runtime.call(
          "OUTLOOK_GET_CALENDAR_VIEW",
          optionalFields({
            calendar_id: isDefaultCalendar(calId) ? undefined : calId,
            start_datetime: from,
            end_datetime: to,
            top: 250,
            timezone: "UTC",
            page_token: pageToken,
          }),
        );
        const { rows, token } = extractOutlookList(raw, "events");
        busy.push(...outlookBusyFromEvents(rows, startMs, endMs));
        if (!token) break;
        if (page === MAX_FREE_CALENDAR_PAGES - 1)
          throw new CliError(
            "incomplete_response",
            "Calendar availability exceeded the page limit; shorten the query window.",
          );
        pageToken = token;
      }
    }

    if (withEmails.length) {
      const raw = await runtime.call("OUTLOOK_GET_CALENDAR_SCHEDULE", {
        schedules: withEmails,
        start_time: { dateTime: toOutlookNaiveUtc(from), timeZone: "UTC" },
        end_time: { dateTime: toOutlookNaiveUtc(to), timeZone: "UTC" },
        availability_view_interval: 30,
      });
      busy.push(...outlookBusyFromSchedule(raw, withEmails, startMs, endMs));
    }

    return {
      calendarIds: [...ownCalendars, ...withEmails],
      window: { from, to },
      durationMinutes: input.durationMinutes,
      slots: freeSlotsFromBusy(
        busy,
        startMs,
        endMs,
        Number(input.durationMinutes),
      ),
    };
  }

  if (action === "calendars") {
    const fingerprint = {
      account: runtime.account.connection_id,
      action,
      limit: input.limit,
    };
    const state = cursor(input.cursor, fingerprint);
    const raw = await runtime.call(
      "OUTLOOK_LIST_CALENDARS",
      optionalFields({
        top: input.limit,
        page_token: state.token,
      }),
    );
    const { rows, token } = extractOutlookList(raw, "calendars");
    return {
      calendars: rows.map((x) => decodeOutlookCalendar(record(x))),
      hasMore: Boolean(token),
      ...(token
        ? { nextCursor: nextCursor(optionalFields({ token }), fingerprint) }
        : {}),
    };
  }

  if (action === "list") {
    const fingerprint = {
      account: runtime.account.connection_id,
      action,
      calendarId,
      limit: input.limit,
      query: input.query ?? "",
      date: input.date ?? "",
      timeZone: input.timeZone ?? "",
      from: input.from ?? "",
      to: input.to ?? "",
    };
    const state = cursor(input.cursor, fingerprint);
    let from = input.from ?? state.from;
    let to = input.to ?? state.to;
    let zone =
      typeof state.zone === "string"
        ? state.zone
        : typeof input.timeZone === "string"
          ? input.timeZone
          : undefined;

    if (input.date && from === undefined) {
      if (zone === undefined) {
        const settingsRaw = await runtime.call("OUTLOOK_GET_MAILBOX_SETTINGS", {
          select: ["timeZone"],
        });
        const settings = unwrapOutlookPayload(settingsRaw);
        const mailboxZone = requiredString(
          settings.timeZone,
          "mailbox time zone",
        );
        zone = resolveOutlookTimeZone(mailboxZone);
      } else {
        validateTimeZone(zone);
      }
      let date = ["today", "tomorrow"].includes(displayText(input.date))
        ? dateInZone(new Date(), zone)
        : displayText(input.date);
      if (input.date === "tomorrow")
        date = new Date(Date.parse(date + "T12:00:00Z") + 86400000)
          .toISOString()
          .slice(0, 10);
      const next = new Date(Date.parse(date + "T12:00:00Z") + 86400000)
        .toISOString()
        .slice(0, 10);
      from = midnight(date, zone);
      to = midnight(next, zone);
    }

    const fromStr = displayText(from);
    const toStr = displayText(to);
    // UTC responses preserve the instant of each occurrence of a repeated hour.

    const raw =
      input.query !== undefined
        ? await runtime.call(
            "OUTLOOK_LIST_EVENTS",
            optionalFields({
              calendar_id: isDefaultCalendar(calendarId)
                ? undefined
                : calendarId,
              top: input.limit,
              page_token: state.token,
              expand_recurring_events: true,
              filter: `start/dateTime lt '${utc(Date.parse(toStr))}' and end/dateTime gt '${utc(Date.parse(fromStr))}' and contains(subject,'${displayText(input.query).replaceAll("'", "''")}') and isCancelled eq false`,
              orderby: ["start/dateTime asc"],
              timezone: "UTC",
            }),
          )
        : await runtime.call(
            "OUTLOOK_GET_CALENDAR_VIEW",
            optionalFields({
              calendar_id: isDefaultCalendar(calendarId)
                ? undefined
                : calendarId,
              start_datetime: fromStr,
              end_datetime: toStr,
              top: input.limit,
              page_token: state.token,
              orderby: "start/dateTime asc",
              timezone: "UTC",
            }),
          );

    const { rows, token } = extractOutlookList(raw, "events");
    return {
      events: rows.map((x) => decodeOutlookEvent(record(x), calendarId)),
      hasMore: Boolean(token),
      ...(token
        ? {
            nextCursor: nextCursor(
              optionalFields({ token, from: fromStr, to: toStr, zone }),
              fingerprint,
            ),
          }
        : {}),
    };
  }

  if (action === "read") {
    const current = await readOutlookEvent(runtime, calendarId, input.eventId);
    return { event: decodeOutlookEvent(current, calendarId) };
  }

  if (action === "create") {
    const attendees = input.attendees as string[] | undefined;
    const raw = await runtime.call(
      "OUTLOOK_CALENDAR_CREATE_EVENT",
      optionalFields({
        calendar_id: isDefaultCalendar(calendarId) ? undefined : calendarId,
        subject: input.title,
        start_datetime: toOutlookNaiveUtc(displayText(input.start)),
        end_datetime: toOutlookNaiveUtc(displayText(input.end)),
        time_zone: "UTC",
        body: input.description,
        is_html: input.description !== undefined ? false : undefined,
        location: input.location,
        attendees_info: attendees?.map((address) => ({
          email: address,
          type: "required",
        })),
        is_online_meeting: input.teams === true ? true : undefined,
        online_meeting_provider:
          input.teams === true ? "teamsForBusiness" : undefined,
      }),
      true,
    );
    const event = decodeOutlookEvent(raw, calendarId);
    if (input.teams && !event.meetingUrl)
      throw new CliError(
        "outcome_unknown",
        "The event exists, but its requested Teams link was not confirmed.",
        { event_id: event.eventId },
      );
    return { action: "created", acknowledged: true, event };
  }

  const current = await readOutlookEvent(runtime, calendarId, input.eventId);
  const eventType = typeof current.type === "string" ? current.type : undefined;
  if (
    current.recurrence ||
    current.seriesMasterId ||
    (eventType !== undefined && eventType !== "singleInstance")
  )
    throw new CliError(
      "unsupported_combination",
      "Recurring event writes are pending; select a single nonrecurring event.",
      { operation_rejected: true },
    );
  if (current.isOrganizer !== true)
    throw new CliError(
      "forbidden",
      "Only the event organizer can modify or cancel this meeting.",
      { operation_rejected: true },
    );

  if (action === "cancel") {
    const hasAttendees =
      Array.isArray(current.attendees) && current.attendees.length > 0;
    if (hasAttendees) {
      await runtime.call(
        isDefaultCalendar(calendarId)
          ? "OUTLOOK_CANCEL_EVENT"
          : "OUTLOOK_CANCEL_CALENDAR_EVENT",
        optionalFields({
          user_id: "me",
          calendar_id: isDefaultCalendar(calendarId) ? undefined : calendarId,
          event_id: input.eventId,
        }),
        true,
      );
    } else {
      await runtime.call(
        isDefaultCalendar(calendarId)
          ? "OUTLOOK_DELETE_CALENDAR_EVENT"
          : "OUTLOOK_DELETE_CALENDAR_EVENT_FROM_SPECIFIC_CALENDAR",
        optionalFields({
          calendar_id: isDefaultCalendar(calendarId) ? undefined : calendarId,
          event_id: input.eventId,
        }),
        true,
      );
    }
    return {
      action: "canceled",
      acknowledged: true,
      eventId: requiredString(current.id, "canceled event ID"),
    };
  }

  let mergedAttendees: Json[] | undefined;
  if (input.addAttendees || input.removeAttendees) {
    if (current.attendees !== undefined && !Array.isArray(current.attendees))
      throw new CliError(
        "incomplete_response",
        "The full attendee list is unavailable.",
        { operation_rejected: true },
      );
    const organizerEmail = extractEmailAddress(current.organizer);
    const remove = (input.removeAttendees ?? []) as string[];
    const add = (input.addAttendees ?? []) as string[];
    const same = (a: unknown, b: string) =>
      String(a).toLowerCase() === b.toLowerCase();
    if (organizerEmail && remove.some((x) => same(organizerEmail, x)))
      usage("The organizer cannot be removed.");
    const existing = ((current.attendees ?? []) as unknown[]).map((x) => {
      const entry = record(x, "existing attendee");
      const emailObj = record(entry.emailAddress, "attendee emailAddress");
      const address = requiredString(
        emailObj.address,
        "existing attendee email",
      );
      const name =
        typeof emailObj.name === "string" && emailObj.name.trim()
          ? emailObj.name
          : undefined;
      const type =
        typeof entry.type === "string" && entry.type.trim()
          ? entry.type
          : "required";
      return {
        type,
        emailAddress: optionalFields({ address, name }),
      };
    });
    const merged = existing.filter(
      (x) => !remove.some((a) => same(record(x.emailAddress).address, a)),
    );
    for (const address of add) {
      if (!merged.some((x) => same(record(x.emailAddress).address, address)))
        merged.push({
          type: "required",
          emailAddress: { address },
        });
    }
    if (merged.length > 50)
      usage("The resulting meeting exceeds 50 attendees.");
    mergedAttendees = merged;
  }

  const raw = await runtime.call(
    isDefaultCalendar(calendarId)
      ? "OUTLOOK_UPDATE_CALENDAR_EVENT"
      : "OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR",
    optionalFields({
      calendar_id: isDefaultCalendar(calendarId) ? undefined : calendarId,
      event_id: input.eventId,
      subject: input.title,
      location: input.location,
      body:
        input.description !== undefined
          ? { contentType: "Text", content: input.description }
          : undefined,
      start_datetime: input.start
        ? toOutlookNaiveUtc(displayText(input.start))
        : undefined,
      end_datetime: input.end
        ? toOutlookNaiveUtc(displayText(input.end))
        : undefined,
      time_zone: input.start ? "UTC" : undefined,
      attendees: mergedAttendees,
    }),
    true,
  );
  return {
    action: "updated",
    acknowledged: true,
    event: decodeOutlookEvent(raw, calendarId),
  };
}

function extractEmailAddress(container: unknown): string | undefined {
  if (!container || typeof container !== "object" || Array.isArray(container))
    return undefined;
  const obj = container as Json;
  if (
    obj.emailAddress &&
    typeof obj.emailAddress === "object" &&
    !Array.isArray(obj.emailAddress)
  ) {
    const addr = (obj.emailAddress as Json).address;
    if (typeof addr === "string" && addr.trim()) return addr;
  }
  if (typeof obj.address === "string" && obj.address.trim()) return obj.address;
  return undefined;
}

export function decodeOutlookCalendar(raw: Json): Json {
  const canEdit = raw.canEdit;
  const accessRole =
    canEdit === true ? "writer" : canEdit === false ? "reader" : undefined;
  return optionalFields({
    calendarId: requiredString(raw.id, "calendar ID"),
    name: typeof raw.name === "string" ? raw.name : undefined,
    timeZone: typeof raw.timeZone === "string" ? raw.timeZone : undefined,
    accessRole,
    primary:
      typeof raw.isDefaultCalendar === "boolean"
        ? raw.isDefaultCalendar
        : undefined,
  });
}

function decodeOutlookEventTime(
  raw: unknown,
  isAllDay: boolean,
): Json | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entry = raw as Json;
  if (typeof entry.dateTime !== "string" || !entry.dateTime.trim())
    return undefined;
  if (
    isAllDay &&
    /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0+)?(?:Z)?$/u.test(entry.dateTime.trim())
  ) {
    return { date: entry.dateTime.trim().slice(0, 10) };
  }
  const timeZone =
    typeof entry.timeZone === "string" ? entry.timeZone : undefined;
  return outlookDateTimeToRfc3339(entry.dateTime, timeZone);
}

export function decodeOutlookEvent(raw: Json, calendarId: string): Json {
  const event = unwrapOutlookPayload(raw);
  const isAllDay = event.isAllDay === true;
  const body =
    event.body && typeof event.body === "object" && !Array.isArray(event.body)
      ? (event.body as Json)
      : undefined;
  const rawBodyContent =
    typeof body?.content === "string" && body.content.length > 0
      ? body.content
      : undefined;
  const isEmptyExchangeHtml =
    rawBodyContent !== undefined &&
    event.bodyPreview === "" &&
    typeof body?.contentType === "string" &&
    body.contentType.toLowerCase() === "html" &&
    rawBodyContent
      .replace(/<style[\s\S]*?<\/style>/giu, "")
      .replace(/<[^>]+>/gu, "")
      .replace(/&nbsp;/giu, " ")
      .trim() === "";
  const bodyContent =
    rawBodyContent !== undefined && !isEmptyExchangeHtml
      ? rawBodyContent
      : typeof event.bodyPreview === "string" && event.bodyPreview.length > 0
        ? event.bodyPreview
        : undefined;
  const locationObj =
    event.location &&
    typeof event.location === "object" &&
    !Array.isArray(event.location)
      ? (event.location as Json)
      : undefined;
  const location =
    typeof locationObj?.displayName === "string" &&
    locationObj.displayName.length > 0
      ? locationObj.displayName
      : typeof event.location === "string" && event.location.length > 0
        ? event.location
        : undefined;
  const onlineMeeting =
    event.onlineMeeting &&
    typeof event.onlineMeeting === "object" &&
    !Array.isArray(event.onlineMeeting)
      ? (event.onlineMeeting as Json)
      : undefined;
  const meetingUrl =
    typeof onlineMeeting?.joinUrl === "string" && onlineMeeting.joinUrl.trim()
      ? onlineMeeting.joinUrl
      : typeof event.onlineMeetingUrl === "string" &&
          event.onlineMeetingUrl.trim()
        ? event.onlineMeetingUrl
        : undefined;
  const status =
    event.isCancelled === true
      ? "cancelled"
      : typeof event.showAs === "string" && event.showAs.trim()
        ? event.showAs
        : undefined;

  return optionalFields({
    eventId: requiredString(event.id, "event ID"),
    calendarId,
    title: typeof event.subject === "string" ? event.subject : undefined,
    description: bodyContent,
    location,
    status,
    start: decodeOutlookEventTime(event.start, isAllDay),
    end: decodeOutlookEventTime(event.end, isAllDay),
    organizerEmail: extractEmailAddress(event.organizer),
    url:
      typeof event.webLink === "string" && event.webLink.trim()
        ? event.webLink
        : undefined,
    meetingUrl,
    recurringEventId:
      typeof event.seriesMasterId === "string" && event.seriesMasterId.trim()
        ? event.seriesMasterId
        : undefined,
    attendees: Array.isArray(event.attendees)
      ? event.attendees
          .map((x) => {
            const a = record(x, "attendee");
            const address = extractEmailAddress(a);
            if (!address) return undefined;
            const statusObj =
              a.status &&
              typeof a.status === "object" &&
              !Array.isArray(a.status)
                ? (a.status as Json)
                : undefined;
            return optionalFields({
              email: address,
              responseStatus:
                typeof statusObj?.response === "string"
                  ? statusObj.response
                  : undefined,
            });
          })
          .filter((x): x is Json => x !== undefined)
      : undefined,
  });
}
