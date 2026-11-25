import { useSyncExternalStore } from "react";

import {
  currentTheme,
  getThemeChoice,
  isThemeChoice,
  setThemeChoice,
  subscribeToTheme,
  THEME_CHOICES,
  type ThemeChoice,
} from "@/app/theme";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslation } from "@/i18n/use-translation";

import { SettingsPageHeading } from "./settings-page-heading";
import { settingsMessages } from "./settings.messages";

const choiceMessages = {
  system: settingsMessages.system,
  light: settingsMessages.light,
  dark: settingsMessages.dark,
} satisfies Record<ThemeChoice, unknown>;

// The choice and the theme it shows as one value: while System is chosen the
// choice stays put when the operating system switches, and the hint that
// names the theme on screen still has to redraw.
function themeSnapshot() {
  return `${getThemeChoice()}:${currentTheme()}`;
}

export function AppearanceSettingsPage() {
  const { t } = useTranslation();
  // The theme also changes from outside this page: another tab of this
  // browser, or the operating system while System is chosen.
  useSyncExternalStore(subscribeToTheme, themeSnapshot, themeSnapshot);
  const choice = getThemeChoice();

  function choose(value: string) {
    if (!isThemeChoice(value) || value === choice) return;
    setThemeChoice(value);
  }

  return (
    <div className="mx-auto flex w-full max-w-(--app-settings-width) flex-col gap-8 pb-4">
      <SettingsPageHeading
        description={t(settingsMessages.appearanceDescription)}
        title={t(settingsMessages.appearance)}
      />

      <section className="rounded-2xl border border-border bg-background p-6">
        <div className="flex flex-col justify-center gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm text-foreground" id="interface-theme">
              {t(settingsMessages.interfaceTheme)}
            </p>
            <p
              className="text-sm text-muted-foreground"
              id="interface-theme-hint"
            >
              {t(settingsMessages.interfaceThemeHint, {
                current: t(choiceMessages[currentTheme()]),
              })}
            </p>
          </div>
          <Select
            aria-describedby="interface-theme-hint"
            aria-label={t(settingsMessages.interfaceTheme)}
            className="w-full shrink-0 sm:w-44"
            onValueChange={choose}
            value={choice}
          >
            {THEME_CHOICES.map((value) => (
              <SelectItem key={value} value={value}>
                {t(choiceMessages[value])}
              </SelectItem>
            ))}
          </Select>
        </div>
      </section>
    </div>
  );
}
