// How Library rows name and date their items. Document names follow the
// web's document-display-name.ts; dates read like a phone's own lists:
// a time today, "Yesterday", a weekday this week, then the date.
import type { TeamHubDocument } from "../api/types";
import type { Translation } from "../i18n/language";
import { libraryItemsMessages as m } from "./library-items.messages";

/** The language dates are written in and the lookup for the words around them. */
type Words = Pick<Translation, "language" | "t">;

type NamedDocument = Pick<
  TeamHubDocument,
  "format" | "representation_format" | "title" | "draft_capability"
>;

const extensionByRepresentation: Readonly<Record<string, string>> = {
  csv: "csv",
  html: "html",
  markdown: "md",
  pdf: "pdf",
  plain_text: "txt",
};

function representationExtension(document: NamedDocument): string | undefined {
  const format =
    document.representation_format ||
    (document.format === "blocknote" ? "markdown" : document.format);
  return extensionByRepresentation[format];
}

/** The title a reader sees: a native Document's title without its format suffix. */
export function documentTitle(
  document: NamedDocument,
  t: Translation["t"],
): string {
  const title = document.title.trim() || t(m.untitled);
  if (document.draft_capability === "none") return title;
  const extension = representationExtension(document);
  const suffix = extension ? `.${extension}` : "";
  return suffix && title.toLowerCase().endsWith(suffix)
    ? title.slice(0, -suffix.length)
    : title;
}

/** A file name that carries the Document's kind, for its icon and type label. */
export function documentFileName(
  document: NamedDocument,
  t: Translation["t"],
): string {
  const title = documentTitle(document, t);
  const extension = representationExtension(document);
  if (!extension || title.toLowerCase().endsWith(`.${extension}`)) return title;
  return `${title}.${extension}`;
}

function parse(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  // A bare `YYYY-MM-DD` is a local calendar day, not UTC midnight.
  const day = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  const date = day
    ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
    : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function startOfDay(date: Date): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

/** Whole calendar days from `date` to `now`; 0 is today. */
function daysAgo(date: Date, now: Date): number {
  return Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
}

export function clockTime(value: string | undefined, language: string): string {
  const date = parse(value);
  return date
    ? date.toLocaleTimeString(language, { hour: "numeric", minute: "2-digit" })
    : "";
}

/** A short point in time for a row: `10:42 AM`, `Yesterday`, `Mon`, `Nov 3`. */
export function shortWhen(
  value: string | undefined,
  { language, t }: Words,
  now = new Date(),
): string {
  const date = parse(value);
  if (!date) return "";
  const days = daysAgo(date, now);
  if (days === 0) return clockTime(value, language);
  if (days === 1) return t(m.yesterday);
  if (days > 1 && days < 7)
    return date.toLocaleDateString(language, { weekday: "short" });
  return date.toLocaleDateString(language, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** A day heading: `Today`, `Yesterday`, then `Monday, Nov 17`. */
export function dayHeading(
  value: string | undefined,
  { language, t }: Words,
  now = new Date(),
): string {
  const date = parse(value);
  if (!date) return t(m.earlier);
  const days = daysAgo(date, now);
  if (days === 0) return t(m.today);
  if (days === 1) return t(m.yesterday);
  return date.toLocaleDateString(language, {
    weekday: "long",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** The local calendar day of a time, for grouping rows by day. */
export function dayKey(value: string | undefined): string {
  const date = parse(value);
  if (!date) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** One heading per day, in the order each day first appears. */
export function groupByDay<T>(
  items: readonly T[],
  timeOf: (item: T) => string | undefined,
  words: Words,
  now = new Date(),
): { key: string; title: string; data: T[] }[] {
  const groups = new Map<string, { key: string; title: string; data: T[] }>();
  for (const item of items) {
    const key = dayKey(timeOf(item));
    const group = groups.get(key);
    if (group) group.data.push(item);
    else
      groups.set(key, {
        key,
        title: dayHeading(timeOf(item), words, now),
        data: [item],
      });
  }
  return [...groups.values()];
}
