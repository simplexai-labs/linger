import { useState } from "react";

import { Select, SelectItem } from "@/components/ui/select";
import { isLanguage, LANGUAGES, setLanguage } from "@/i18n/language";
import { useTranslation } from "@/i18n/use-translation";

import { SettingsPageHeading } from "./settings-page-heading";
import { settingsMessages } from "./settings.messages";

export function LanguageSettingsPage() {
  const { language, t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const [switching, setSwitching] = useState(false);

  function choose(value: string) {
    if (!isLanguage(value) || value === language) return;
    setFailed(false);
    setSwitching(true);
    setLanguage(value)
      .catch(() => setFailed(true))
      .finally(() => setSwitching(false));
  }

  return (
    <div className="mx-auto flex w-full max-w-(--app-settings-width) flex-col gap-8 pb-4">
      <SettingsPageHeading title={t(settingsMessages.language)} />

      <section className="rounded-2xl border border-border bg-background p-6">
        <div className="flex flex-col justify-center gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm text-foreground" id="interface-language">
              {t(settingsMessages.interfaceLanguage)}
            </p>
            <p
              className="text-sm text-muted-foreground"
              id="interface-language-hint"
            >
              {t(settingsMessages.interfaceLanguageHint)}
            </p>
          </div>
          {/* Each language is named in itself, so it can be found from any other. */}
          <Select
            aria-describedby="interface-language-hint"
            aria-label={t(settingsMessages.interfaceLanguage)}
            className="w-full shrink-0 sm:w-44"
            disabled={switching}
            onValueChange={choose}
            value={language}
          >
            {LANGUAGES.map(({ name, tag }) => (
              <SelectItem key={tag} value={tag}>
                <span lang={tag}>{name}</span>
              </SelectItem>
            ))}
          </Select>
        </div>
        {failed ? (
          <p className="mt-3 text-sm text-app-danger" role="alert">
            {t(settingsMessages.languageUnavailable)}
          </p>
        ) : null}
      </section>
    </div>
  );
}
