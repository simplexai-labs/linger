/** Keyword helpers shared by the global search dialog: one case-insensitive substring, no ranking. */

import { formatLocale, type Translate, translate } from "@/i18n/language";

import { searchMessages as m } from "./global-search.messages";

export function normalizeSearchQuery(raw: string) {
  return raw.trim().toLocaleLowerCase();
}

export function matchesSearchQuery(
  query: string,
  values: ReadonlyArray<string | null | undefined>,
) {
  if (!query) return false;
  return values.some((value) =>
    value ? value.toLocaleLowerCase().includes(query) : false,
  );
}

/**
 * The passage around the first match: `before` characters ahead of it and
 * `radius` after, so a narrow line can open close to the match and keep the
 * highlighted word in view.
 */
export function snippetAround(
  text: string,
  query: string,
  radius = 60,
  before = radius,
) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!query) return flat.slice(0, radius * 2);
  const index = flat.toLocaleLowerCase().indexOf(query);
  if (index < 0) return flat.slice(0, radius * 2);
  const start = Math.max(0, index - before);
  const end = Math.min(flat.length, index + query.length + radius);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/** Compact relative age for result rows: 5m, 3h, 2d, then a short date. */
export function relativeTimeLabel(
  iso: string,
  t: Translate = translate,
  now = Date.now(),
) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const elapsed = Math.max(0, now - time);
  const minute = 60_000;
  if (elapsed < minute) return t(m.ageNow);
  // A rounded value may reach the next unit ("60m" at 59.6 minutes), so the
  // unit is chosen from the rounded value, not from the raw elapsed time.
  const minutes = Math.round(elapsed / minute);
  if (minutes < 60) return t(m.ageMinutes, { value: minutes });
  const hours = Math.round(elapsed / (60 * minute));
  if (hours < 24) return t(m.ageHours, { value: hours });
  const days = Math.round(elapsed / (24 * 60 * minute));
  if (days < 7) return t(m.ageDays, { value: days });
  return new Date(time).toLocaleDateString(formatLocale(), {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
