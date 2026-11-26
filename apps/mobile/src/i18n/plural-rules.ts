// Hermes, the phone's JavaScript engine, has no Intl.PluralRules, and the
// shared message formatter picks plural forms with it. The app offers only
// English and Simplified Chinese, so this supplies their two rules: English
// says "one" for exactly 1 and "other" otherwise; Chinese has only "other".
// Where the engine has its own Intl.PluralRules (Node in tests), it is kept.

type Category = "one" | "other";

class PhonePluralRules {
  readonly #locale: string;

  constructor(locales?: string | readonly string[]) {
    const first = typeof locales === "string" ? locales : locales?.[0];
    this.#locale = first?.toLowerCase().startsWith("zh") ? "zh" : "en";
  }

  select(count: number): Category {
    return this.#locale === "en" && count === 1 ? "one" : "other";
  }

  resolvedOptions() {
    return {
      locale: this.#locale,
      pluralCategories: this.#locale === "en" ? ["one", "other"] : ["other"],
      type: "cardinal",
    };
  }

  static supportedLocalesOf(locales: string | readonly string[]): string[] {
    return typeof locales === "string" ? [locales] : [...locales];
  }
}

/** Installs the two rules when the engine has none; returns whether it did. */
export function installPluralRules(target: { Intl: object }): boolean {
  const intl = target.Intl as { PluralRules?: unknown };
  if (typeof intl.PluralRules === "function") return false;
  Object.defineProperty(intl, "PluralRules", {
    configurable: true,
    writable: true,
    value: PhonePluralRules,
  });
  return true;
}
