// The languages the app offers and the phone-language match, kept apart from
// the store so tests and plain modules can use them without React Native.

/** The languages offered, each named in its own language. */
export const LANGUAGES = [
  { tag: "en", name: "English" },
  { tag: "zh-CN", name: "\u7b80\u4f53\u4e2d\u6587" },
] as const;

export type Language = (typeof LANGUAGES)[number]["tag"];
export type LanguageChoice = Language | "system";

export function isLanguageChoice(value: unknown): value is LanguageChoice {
  return (
    value === "system" || LANGUAGES.some((language) => language.tag === value)
  );
}

/**
 * The phone's first preferred language this app offers. Chinese written in
 * Simplified script, or with no script and a mainland or Singapore region,
 * is Simplified Chinese; Traditional Chinese has no catalog yet.
 */
export function systemLanguage(
  locales: readonly {
    languageCode: string | null;
    languageScriptCode: string | null;
    regionCode: string | null;
  }[],
): Language {
  for (const locale of locales) {
    if (locale.languageCode === "en") return "en";
    if (locale.languageCode !== "zh") continue;
    if (locale.languageScriptCode === "Hans") return "zh-CN";
    if (locale.languageScriptCode === "Hant") continue;
    if (locale.regionCode === null || /^(CN|SG)$/.test(locale.regionCode))
      return "zh-CN";
  }
  return "en";
}
