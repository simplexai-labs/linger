import type { ReactNode } from "react";

import { useT } from "@/i18n/use-translation";

import { connectorMessages as m } from "./connectors.messages";

const COMPOSIO_KEYS_URL =
  "https://dashboard.composio.dev/~/project/settings/api-keys";

/** Where a provider's API key comes from, shown above the form that saves it. */
export function ProviderKeyGuide({
  href,
  steps,
}: {
  href: string;
  steps: ReactNode;
}) {
  const t = useT();
  return (
    <div className="rounded-xl border border-app-border bg-app-surface-soft p-4 text-sm">
      <p className="font-medium text-foreground">{t(m.getYourApiKey)}</p>
      <div className="mt-1.5 leading-5 text-muted-foreground">{steps}</div>
      <a
        className="mt-2 inline-flex font-medium text-app-link hover:underline"
        href={href}
        rel="noopener noreferrer"
        target="_blank"
      >
        {t(m.getAKey)} <span aria-hidden="true">↗</span>
      </a>
    </div>
  );
}

export function ComposioKeyGuide() {
  const t = useT();
  return (
    <ProviderKeyGuide
      href={COMPOSIO_KEYS_URL}
      steps={<p>{t(m.composioKeyReminder)}</p>}
    />
  );
}
