import { useState } from "react";

import { Button } from "@/components/ui/button";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";
import { writeClipboardText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";

import { connectorMessages as m } from "./connectors.messages";

/** The error TeamHub answers when lark-cli's Feishu app lacks mail scopes. */
export function isFeishuScopesNotEnabled(
  error: unknown,
): error is TeamHubError {
  return (
    error instanceof TeamHubError && error.code === "FEISHU_SCOPES_NOT_ENABLED"
  );
}

// Only the Feishu and Lark developer consoles are linked.
const CONSOLE_ORIGINS = [
  "https://open.feishu.cn/",
  "https://open.larksuite.com/",
];

/**
 * What to do when the Feishu app behind the person's lark-cli does not enable
 * the mail scopes: open its permissions page, add the scopes as user
 * permissions, publish a version, and connect again.
 */
export function FeishuScopesGuide({
  className,
  error,
}: {
  className?: string;
  error: TeamHubError;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const details = error.details ?? [];
  const scopes = details
    .filter((detail) => detail.field === "scope")
    .map((detail) => detail.reason);
  const permissionsUrl = details.find(
    (detail) =>
      detail.field === "permissions_url" &&
      CONSOLE_ORIGINS.some((origin) => detail.reason.startsWith(origin)),
  )?.reason;
  return (
    <div
      className={cn(
        "rounded-xl border border-app-border bg-app-surface-soft p-3 text-xs",
        className,
      )}
      role="alert"
    >
      <p className="font-medium text-foreground">{t(m.feishuScopesTitle)}</p>
      <ol className="mt-1.5 list-decimal space-y-1.5 pl-5 leading-5 text-muted-foreground">
        <li>
          {t(m.feishuScopesStepOpen)}
          {permissionsUrl ? (
            <>
              {" "}
              <a
                className="font-medium text-app-link hover:underline"
                href={permissionsUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                {t(m.feishuScopesOpenConsole)} <span aria-hidden="true">↗</span>
              </a>
            </>
          ) : null}
        </li>
        <li>
          {t(m.feishuScopesStepAdd)}
          <ul
            aria-label={t(m.feishuScopesList)}
            className="mt-1 space-y-0.5 font-mono text-foreground"
          >
            {scopes.map((scope) => (
              <li key={scope}>{scope}</li>
            ))}
          </ul>
          <Button
            className="mt-1.5"
            onClick={() =>
              void writeClipboardText(scopes.join("\n")).then(
                () => setCopied(true),
                () => setCopied(false),
              )
            }
            size="compact"
          >
            {t(copied ? commonMessages.copied : commonMessages.copy)}
          </Button>
        </li>
        <li>{t(m.feishuScopesStepPublish)}</li>
        <li>{t(m.feishuScopesStepConnect)}</li>
      </ol>
    </div>
  );
}
