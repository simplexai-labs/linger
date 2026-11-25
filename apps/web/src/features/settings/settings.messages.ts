import { defineMessages } from "@/i18n/messages";

export const settingsMessages = defineMessages("settings", {
  navigation: "Settings navigation",
  title: "Settings",
  sections: "Settings sections",
  profile: "Profile",
  security: "Security",
  computers: "Computers",
  models: "Models",
  language: "Language",
  loadingComputers: "Loading Computers",
  loadingContent: "Loading content",
  languageDescription: "Choose the language Linger is shown in.",
  interfaceLanguage: "Interface language",
  interfaceLanguageHint:
    "Saved on this device. Text written by Agents and other people stays as they wrote it.",
  languageUnavailable:
    "That language could not be loaded. Check your connection and try again.",
  saveDiagnostics: "Save diagnostics…",
  saveDiagnosticsFailed: "Diagnostics could not be saved. Try again.",
  appearance: "Appearance",
  appearanceDescription: "Choose how Linger looks on this device.",
  interfaceTheme: "Theme",
  interfaceThemeHint:
    "Saved on this device. System follows your operating system; it is {current} now.",
  light: "Light",
  dark: "Dark",
  system: "System",
});
