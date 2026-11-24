import { type ReactNode, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { CopyValueButton } from "@/features/local-computer/computer-setup-instructions";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";
import { writeClipboardText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";

import { connectorMessages as m } from "./connectors.messages";

// What TeamHub answers when the owner's Computer cannot connect Feishu Mail
// yet. Each has steps the Human can follow, so none is shown as an error line.
const FEISHU_CONNECT_CODES = [
  "FEISHU_SCOPES_NOT_ENABLED",
  "LARK_CLI_NOT_INSTALLED",
  "LARK_CLI_NOT_CONFIGURED",
  "FEISHU_COMPUTER_OFFLINE",
  "FEISHU_COMPUTER_UNAVAILABLE",
];

/** An error a Feishu Mail connection answers with steps for the Human. */
export function isFeishuConnectError(error: unknown): error is TeamHubError {
  return (
    error instanceof TeamHubError && FEISHU_CONNECT_CODES.includes(error.code)
  );
}

/**
 * The steps for a Feishu Mail connection the owner's Computer cannot make
 * yet: install and set up lark-cli, bring the Computer online, or enable the
 * mail permissions of lark-cli's Feishu app.
 */
export function FeishuConnectGuide({
  className,
  error,
}: {
  className?: string;
  error: TeamHubError;
}) {
  const t = useT();
  // TeamHub names the commands, install first, so they are written once.
  const [first, second] = (error.details ?? [])
    .filter((detail) => detail.field === "command")
    .map((detail) => detail.reason);
  switch (error.code) {
    case "FEISHU_SCOPES_NOT_ENABLED":
      return <FeishuScopesGuide className={className} error={error} />;
    case "LARK_CLI_NOT_INSTALLED":
      return (
        <GuideBox className={className} title={t(m.feishuCliMissingTitle)}>
          <li>
            {t(m.feishuCliMissingStepInstall)}
            <Command value={first} />
          </li>
          <li>
            {t(m.feishuCliStepSetup)}
            <Command value={second} />
          </li>
          <li>{t(m.feishuStepConnectAgain)}</li>
        </GuideBox>
      );
    case "LARK_CLI_NOT_CONFIGURED":
      return (
        <GuideBox className={className} title={t(m.feishuCliNotSetUpTitle)}>
          <li>
            {t(m.feishuCliNotSetUpStepRun)}
            <Command value={first} />
          </li>
          <li>{t(m.feishuStepConnectAgain)}</li>
        </GuideBox>
      );
    case "FEISHU_COMPUTER_OFFLINE":
      return (
        <GuideBox className={className} title={t(m.feishuComputerOfflineTitle)}>
          <li>{t(m.feishuComputerOfflineStepOpen)}</li>
          <li>{t(m.feishuStepConnectAgain)}</li>
        </GuideBox>
      );
    default:
      return (
        <GuideBox
          className={className}
          title={t(m.feishuComputerUnavailableTitle)}
        >
          <li>{t(m.feishuComputerUnavailableStepCheck)}</li>
          <li>{t(m.feishuStepConnectAgain)}</li>
        </GuideBox>
      );
  }
}

function GuideBox({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-app-border bg-app-surface-soft p-3 text-xs",
        className,
      )}
      role="alert"
    >
      <p className="font-medium text-foreground">{title}</p>
      <ol className="mt-1.5 list-decimal space-y-1.5 pl-5 leading-5 text-muted-foreground">
        {children}
      </ol>
    </div>
  );
}

function Command({ value }: { value?: string }) {
  const ref = useRef<HTMLElement>(null);
  if (!value) return null;
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1.5 rounded-lg border border-border bg-muted/60 px-2.5 py-1.5">
      <code
        className="workspace-scrollbar min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-foreground"
        ref={ref}
      >
        {value}
      </code>
      <CopyValueButton selectionTargetRef={ref} value={value} />
    </div>
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
function FeishuScopesGuide({
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
    <GuideBox className={className} title={t(m.feishuScopesTitle)}>
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
    </GuideBox>
  );
}
