import { commonMessages } from "@/i18n/common.messages";
import { formatLocale, type Translation } from "@/i18n/language";

const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();

function relativeFormat(locale: string) {
  let format = relativeFormats.get(locale);
  if (!format) {
    format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    relativeFormats.set(locale, format);
  }
  return format;
}

/**
 * "2 hours ago" for a past instant, used for when a Computer was last seen.
 * It follows the language of `translation`, and is English without one.
 */
export function relativeTime(value: string, translation?: Translation) {
  const format = relativeFormat(formatLocale(translation?.language ?? "en"));
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1_000);
  if (Math.abs(seconds) < 60)
    return translation
      ? translation.t(commonMessages.justNow)
      : commonMessages.justNow.source;
  // A rounded value may reach the next unit ("24 hours ago" at 23.6 hours,
  // where a day reads "yesterday"), so each unit is chosen from its rounded
  // value rather than from the raw elapsed time.
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(seconds / 3_600);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  return format.format(Math.round(seconds / 86_400), "day");
}
