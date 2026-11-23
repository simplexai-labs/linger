import { teamHubCatalogText } from "@/features/teamhub/teamhub-catalog-text";
import type { TeamHubExternalApp } from "@/features/teamhub/teamhub-types";
import { type Translate, translate } from "@/i18n/language";
import type { Message } from "@/i18n/messages";

import { appDescriptionMessages as d } from "./app-descriptions.messages";
import { connectorMessages as m } from "./connectors.messages";

export interface AppGroup {
  apps: readonly string[];
  id: string;
  title: Message;
}

/**
 * The Connectors page sections, ordered by how central each kind of app is to
 * daily work. TeamHub apps listed in no group (Google Drive, Facebook, Feishu
 * Mail, which an Agent asks for in chat) stay connectable elsewhere but are not
 * offered on this page, so an app TeamHub adds later appears here only once it
 * is added to a group. Group names avoid product nouns such as Profile, Chats,
 * Docs, Projects and Sources.
 */
/**
 * Apps a person shares only with their AnotherMe, by asking it in chat. Their
 * accounts show in AnotherMe's connectors and never on the Connectors page,
 * not even under Connected; its `?app=` dialog still manages them.
 */
export const ANOTHER_ME_ONLY_APPS: ReadonlySet<string> = new Set([
  "feishu_mail",
]);

/** The Connectors tab for web search, beside the Composio app groups. */
export const WEB_SEARCH_FILTER = {
  id: "web-search",
  label: m.filterWebSearch,
};

export const APP_GROUPS: readonly AppGroup[] = [
  {
    id: "mail-calendar",
    title: m.groupMailCalendar,
    apps: [
      "gmail",
      "outlook",
      "google_calendar",
      "outlook_calendar",
      "calendly",
    ],
  },
  { id: "meetings", title: m.groupMeetings, apps: ["granola", "google_meet"] },
  {
    id: "productivity",
    title: m.groupProductivity,
    apps: ["github", "notion", "linear"],
  },
  { id: "messaging", title: m.groupMessaging, apps: ["slack", "discord"] },
  {
    id: "design-creative",
    title: m.groupDesignCreative,
    apps: ["figma", "canva"],
  },
  {
    id: "multimodal",
    title: m.groupMultimodal,
    apps: ["higgsfield", "fal_ai"],
  },
];

/**
 * One-line card labels. TeamHub's longer descriptions stay in the manage
 * dialog, where their import limits and scope matter.
 */
const APP_SUMMARIES: Record<string, Message> = {
  calendly: m.summaryCalendly,
  canva: m.summaryCanva,
  discord: m.summaryDiscord,
  fal_ai: m.summaryFalAi,
  feishu_mail: m.summaryMail,
  figma: m.summaryFigma,
  github: m.summaryGitHub,
  gmail: m.summaryMail,
  google_calendar: m.summaryCalendar,
  google_meet: m.summaryGoogleMeet,
  granola: m.summaryGranola,
  higgsfield: m.summaryHiggsfield,
  linear: m.summaryLinear,
  notion: m.summaryNotion,
  outlook: m.summaryMail,
  outlook_calendar: m.summaryCalendar,
  slack: m.summarySlack,
};

/** What the app holds, in a few words; TeamHub's description for other apps. */
export function appSummary(app: TeamHubExternalApp, t: Translate = translate) {
  const summary = APP_SUMMARIES[app.key];
  return summary ? t(summary) : app.description;
}

/** Each group with the catalog apps it holds, in group order; empty groups drop. */
export function groupCatalogApps(apps: readonly TeamHubExternalApp[]) {
  const byKey = new Map(apps.map((app) => [app.key, app]));
  return APP_GROUPS.map((group) => ({
    group,
    apps: group.apps.flatMap((key) => byKey.get(key) ?? []),
  })).filter((entry) => entry.apps.length > 0);
}

const APP_DESCRIPTIONS: Record<string, Message<string>> = {
  calendly: d.calendly,
  canva: d.canva,
  discord: d.discord,
  facebook: d.facebook,
  fal_ai: d.falAi,
  feishu_mail: d.feishuMail,
  figma: d.figma,
  github: d.github,
  gmail: d.mail,
  google_calendar: d.googleCalendar,
  google_meet: d.googleMeet,
  googledrive: d.googleDrive,
  granola: d.granola,
  higgsfield: d.higgsfield,
  linear: d.linear,
  notion: d.notion,
  outlook: d.mail,
  outlook_calendar: d.outlookCalendar,
  slack: d.slack,
};

/**
 * A catalog app's full description: TeamHub's own text in English and for
 * apps without a copy here.
 */
export function appDescription(
  app: TeamHubExternalApp,
  t: Translate = translate,
) {
  const description = Object.hasOwn(APP_DESCRIPTIONS, app.key)
    ? APP_DESCRIPTIONS[app.key]
    : undefined;
  return teamHubCatalogText(app.description, description, t);
}
