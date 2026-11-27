// The interface language. The choice is kept on this phone, like the Web
// client's per-browser choice: "system" (the default) follows the phone's
// language, and English or Simplified Chinese pin one. English is the source
// every message is written in and the fallback for a missing translation.
import { getLocales } from "expo-localization";
import { getItem, setItem } from "expo-secure-store";
import { AppState } from "react-native";

import {
  systemLanguage,
  isLanguageChoice,
  type Language,
  type LanguageChoice,
} from "./languages";
import zhCN from "./locales/zh-CN.json";
import {
  formatMessage,
  type Catalog,
  type Message,
  type MessageArguments,
} from "./messages";

const STORAGE_KEY = "linger.language";
const catalogs: Record<Language, Catalog | undefined> = {
  en: undefined,
  "zh-CN": zhCN,
};

/** Formats one message in the language on screen. */
export type Translate = <M extends Message>(
  message: M,
  ...values: MessageArguments<M["source"]>
) => string;

/** The language on screen and the lookup for it; replaced as one on a change. */
export interface Translation {
  readonly choice: LanguageChoice;
  readonly language: Language;
  readonly t: Translate;
}

function createTranslation(choice: LanguageChoice): Translation {
  const language = choice === "system" ? systemLanguage(getLocales()) : choice;
  const catalog = catalogs[language];
  return {
    choice,
    language,
    t: (message, ...values) =>
      formatMessage(message, language, catalog, values[0]),
  };
}

function storedChoice(): LanguageChoice {
  try {
    const value = getItem(STORAGE_KEY);
    return isLanguageChoice(value) ? value : "system";
  } catch {
    return "system";
  }
}

let translation = createTranslation(storedChoice());
const listeners = new Set<() => void>();

function publish(next: Translation) {
  if (
    next.choice === translation.choice &&
    next.language === translation.language
  )
    return;
  translation = next;
  for (const listener of listeners) listener();
}

// The phone's language can change while the app is in the background.
AppState.addEventListener("change", (state) => {
  if (state === "active" && translation.choice === "system")
    publish(createTranslation("system"));
});

export function getTranslation(): Translation {
  return translation;
}

/** Translates outside React, for alerts and errors made in plain modules. */
export const t: Translate = (message, ...values) =>
  translation.t(message, ...values);

export function subscribeTranslation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setLanguageChoice(choice: LanguageChoice): void {
  setItem(STORAGE_KEY, choice);
  publish(createTranslation(choice));
}
