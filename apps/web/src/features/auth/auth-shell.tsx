import type { ReactNode } from "react";

import { isLanguage, LANGUAGES, setLanguage } from "@/i18n/language";
import { useTranslation } from "@/i18n/use-translation";

import { authMessages as m } from "./auth.messages";
import { AuthIllustration } from "./auth-illustration";

export function AuthShell({
  children,
  subtitle,
  title,
}: {
  children: ReactNode;
  subtitle: string;
  title: string;
}) {
  const { language, t } = useTranslation();

  return (
    <main className="auth-page min-h-dvh text-foreground">
      <header className="auth-brand">
        <img
          alt="Linger"
          className="auth-brand-wordmark"
          draggable={false}
          height={386}
          src="/linger-wordmark.svg"
          width={1225}
        />
        <select
          aria-label={t(m.interfaceLanguage)}
          className="ui-field-control auth-language-select"
          onChange={(event) => {
            const next = event.target.value;
            if (isLanguage(next) && next !== language) {
              void setLanguage(next).catch(() => {});
            }
          }}
          value={language}
        >
          {LANGUAGES.map(({ name, tag }) => (
            <option key={tag} lang={tag} value={tag}>
              {name}
            </option>
          ))}
        </select>
      </header>

      <div className="auth-stage">
        <div aria-hidden="true" className="auth-illustration">
          <AuthIllustration />
        </div>

        <section aria-labelledby="auth-title" className="auth-panel">
          <div className="auth-heading">
            <h1 className="auth-title" id="auth-title">
              {title}
            </h1>
            <p className="auth-subtitle">{subtitle}</p>
          </div>
          {children}
        </section>
      </div>

      <footer className="auth-footer">&copy; 2026 Linger</footer>
    </main>
  );
}
