import { describe, expect, it } from "vitest";

import { LANGUAGES } from "./languages";
import zhCN from "./locales/zh-CN.json";
import type {
  Catalog,
  Message,
  MessageSource,
} from "@linger/service-kit/messages";

// Vitest (Vite) provides import.meta.glob; the app's types do not know it.
declare global {
  interface ImportMeta {
    glob<T>(pattern: string, options: { eager: true }): Record<string, T>;
  }
}

// Every namespace of the app, found by file name so that a new
// `*.messages.ts` is checked without being listed here.
const modules = import.meta.glob<Record<string, Record<string, Message>>>(
  "../**/*.messages.ts",
  { eager: true },
);

const source = new Map<string, MessageSource>();
for (const exports of Object.values(modules)) {
  for (const messages of Object.values(exports)) {
    for (const message of Object.values(messages)) {
      if (source.has(message.id)) {
        throw new Error(`Two messages are named ${message.id}`);
      }
      source.set(message.id, message.source);
    }
  }
}

const catalogs: Record<string, Catalog> = { "zh-CN": zhCN };

/**
 * English messages a catalog may still lack, as `namespace.name`. A message
 * listed here shows in English until it is translated; keep the list empty
 * unless a translation is knowingly postponed.
 */
const untranslated: Record<string, readonly string[]> = { "zh-CN": [] };

function forms(text: MessageSource): string[] {
  return typeof text === "string" ? [text] : Object.values(text);
}

function names(text: MessageSource, pattern: RegExp): string[] {
  return [
    ...new Set(
      forms(text).flatMap((form) =>
        [...form.matchAll(pattern)].map((match) => match[1]!),
      ),
    ),
  ].sort();
}

const placeholder = /\{(\w+)\}/gu;
const openingTag = /<(\w+)>/gu;
const span = /<(\w+)>.*?<\/\1>/gsu;

describe("message catalogs", () => {
  it("finds the message modules of the app", () => {
    expect(source.size).toBeGreaterThan(0);
    for (const id of source.keys()) {
      // The catalog is addressed as namespace, then name.
      expect(id.split(".")).toHaveLength(2);
    }
  });

  it("has a catalog for every language except the source", () => {
    expect(Object.keys(catalogs).sort()).toEqual(
      LANGUAGES.map((language) => language.tag)
        .filter((tag) => tag !== "en")
        .sort(),
    );
  });

  describe.each(Object.entries(catalogs))("%s", (language, catalog) => {
    const translated = new Map<string, MessageSource>(
      Object.entries(catalog).flatMap(([namespace, messages]) =>
        Object.entries(messages).map(
          ([name, text]) => [`${namespace}.${name}`, text] as const,
        ),
      ),
    );

    it("translates every English message", () => {
      const missing = [...source.keys()].filter((id) => !translated.has(id));
      expect(missing.sort()).toEqual([...untranslated[language]!].sort());
    });

    it("has no translation without an English message", () => {
      expect([...translated.keys()].filter((id) => !source.has(id))).toEqual(
        [],
      );
    });

    it("keeps the placeholders and tags of each message", () => {
      const different = [...translated]
        .filter(([id]) => source.has(id))
        .filter(([id, text]) => {
          const english = source.get(id)!;
          return (
            names(text, placeholder).join() !==
              names(english, placeholder).join() ||
            names(text, openingTag).join() !==
              names(english, openingTag).join() ||
            // Every tag of a translation is closed, so none shows as text.
            forms(text).some(
              (form) =>
                (form.match(openingTag) ?? []).length !==
                (form.match(span) ?? []).length,
            )
          );
        })
        .map(([id]) => id);
      expect(different).toEqual([]);
    });

    it("gives plural messages the forms the language uses", () => {
      const categories = [
        ...new Intl.PluralRules(language).resolvedOptions().pluralCategories,
      ].sort();
      const wrong = [...translated]
        .filter(([id]) => source.has(id))
        .filter(([id, text]) => {
          const plural = typeof source.get(id) !== "string";
          if (typeof text === "string") return plural;
          return (
            !plural || Object.keys(text).sort().join() !== categories.join()
          );
        })
        .map(([id]) => id);
      expect(wrong).toEqual([]);
    });
  });
});
