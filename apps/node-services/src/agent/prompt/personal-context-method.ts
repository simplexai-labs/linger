/**
 * How an Agent gathers the Human's personal context across sources. Knowledge
 * search is the first step; the personal knowledge policy describes that tool.
 * The source list names only the apps with an account granted to the Agent;
 * an app without its own entry is reached through the generic app tools.
 */
export function renderPersonalContextMethod(
  connectedApps: boolean,
  connectedAppKeys: readonly string[],
): string {
  const connected = new Set(connectedApps ? connectedAppKeys : []);
  const apps = APP_SOURCES.flatMap(({ keys, render }) => {
    const present = keys.filter((key) => connected.has(key));
    return present.length > 0 ? [render(present)] : [];
  });
  const listed = new Set(APP_SOURCES.flatMap(({ keys }) => keys));
  const others = [...connected].filter((key) => !listed.has(key));
  if (others.length > 0) apps.push(otherApps(others));
  return [
    METHOD,
    INTRO,
    ...apps,
    SHARED,
    WEB,
    "</personal-context-method>",
  ].join("\n");
}

const METHOD = `<personal-context-method>
When an answer depends on facts about the Human's own work and life, gather them this way.
1. Start from what is already here: memory.md when your instructions carry it, this conversation, and the Agent Memory index.
2. List the facts the answer still needs. Note for each whether it is the Human's own or from outside, and whether it can change after it was recorded: a date or plan, a meeting time, where someone works or lives, contact details, an amount, a deadline, whether something is done.
3. Search knowledge first, as the personal knowledge policy describes. Then query a live or outside source only for a fact knowledge does not have, or for a changing fact that knowledge gives only as a lead; do not query sources just to be thorough. A source that is plainly needed and independent of knowledge may run alongside the first search.
4. Before stating a changing fact as current, check it once in the latest source that holds it. Give a live query a window from the date of the record you hold to now, since a change, confirmation or cancellation can only come after it; a specific name or subject narrows a search better than a short window. If a newer record differs, use it and say what changed; if nothing newer turns up, the latest record stands. Only say you checked a source when you queried it.
5. When the answer chains facts held by different sources (a person found in knowledge, their current role in recent mail, their time in the calendar), check each link in the source that owns it, for the right person and time. Topical overlap does not establish a link; if a link cannot be established, say which.
6. Answer once every needed fact is established and every changing fact has been checked. Shape it to what you deliver: a report leads with the answer and says what was not checked; a recommendation names the candidates, the criteria and the evidence for each; a plan lists the constraints and any conflict with the calendar or Tracking Items; a draft or action shows the facts it uses, and nothing is sent, booked or bought without approval. Carry the constraints into any later step or handed-off Task.
A record of a past event does not by itself prove a present status. Where sources disagree, weigh recency and authority; newer is not always correct.`;

const INTRO =
  "What each source you can query here can tell you. When none of them holds a changing fact, say it is unconfirmed rather than presenting it as current.";

const CALENDAR_COMMANDS: Record<string, string> = {
  google_calendar: "teamhub gcal",
  outlook: "teamhub outlook-calendar",
};
const MAIL_COMMANDS: Record<string, string> = {
  gmail: "teamhub gmail",
  outlook: "teamhub outlook",
  feishu_mail: "teamhub feishu-mail",
};
const DOCUMENT_SOURCES: Record<string, string> = {
  googledrive: "Drive (teamhub gdrive)",
  notion: "Notion (teamhub notion)",
  github: "GitHub (teamhub github)",
};

const APP_SOURCES: readonly {
  readonly keys: readonly string[];
  readonly render: (present: readonly string[]) => string;
}[] = [
  {
    keys: ["google_calendar", "outlook"],
    render: (present) =>
      `- calendar (${present.map((key) => CALENDAR_COMMANDS[key]).join(" or ")} list / free / read): scheduled meetings and events, attendees, free time.`,
  },
  {
    keys: ["gmail", "outlook", "feishu_mail"],
    render: (present) =>
      `- mail (${present.map((key) => MAIL_COMMANDS[key]).join(" or ")} list / read): the latest exchanges with people, including meeting invites, reschedules, confirmations, replies and attachments. Knowledge holds mail only up to its last import; newer mail is only here.`,
  },
  {
    keys: ["slack"],
    render: () =>
      "- Slack (teamhub slack search / read): recent team and partner discussion and progress.",
  },
  {
    keys: ["googledrive", "notion", "github"],
    render: (present) =>
      `- ${present.map((key) => DOCUMENT_SOURCES[key]).join(", ")} search / read: documents, specs, code and issues.`,
  },
];

function otherApps(keys: readonly string[]): string {
  return `- other connected apps (${keys.join(", ")}): find a tool with teamhub apps search "<the action in English, with the app name>", then run it with teamhub apps execute; each holds what its app keeps, such as events in a calendar or issues in a tracker.`;
}

const SHARED = `- Tracking Items (teamhub tracking-items list): open commitments, things waiting on others, deadlines and upcoming plans, each extracted from a message or mail named in source_ref.
- Routines (teamhub routine list): reminders and checks already scheduled in this Room.`;

const WEB =
  "- web: prices, availability, schedules and public facts, checked now.";
