import type { TeamHubLocalRuntimeType } from "@/features/teamhub/teamhub-types";
import { useT } from "@/i18n/use-translation";

import { CommandLine } from "./computer-app-setup-dialog";
import type { ComputerPlatform } from "./computer-platform";
import { appNames } from "./computer-readiness";
import { computerSetupMessages as m } from "./computer-setup.messages";
import { updateCommand } from "./local-runtime-commands";

export interface LocalRuntimeUpdateGuidanceProps {
  readonly computerName: string;
  readonly diagnosticMessage?: string;
  readonly platform?: ComputerPlatform;
  readonly runtimeType: TeamHubLocalRuntimeType;
  readonly version?: string;
}

/**
 * Actionable guidance when a Local Computer reports a Runtime as incompatible
 * (for example below its minimum supported version or failing its protocol
 * handshake). Shows which Runtime needs the update, the Daemon's diagnostic
 * detail, and a copyable update command.
 */
export function LocalRuntimeUpdateGuidance({
  computerName,
  diagnosticMessage,
  platform,
  runtimeType,
  version,
}: LocalRuntimeUpdateGuidanceProps) {
  const t = useT();
  const app = appNames[runtimeType];
  const command = updateCommand(runtimeType, platform);
  const showMacAlternative =
    platform === "darwin" &&
    (runtimeType === "codex" || runtimeType === "claude");
  const usesNpm = runtimeType === "codex" || runtimeType === "pi";

  return (
    <div
      className="rounded-lg border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-surface)] p-3 text-sm text-app-body"
      role="status"
    >
      <p className="font-medium text-foreground">
        {t(m.updateRequiredTitle, { app })}
      </p>
      <p className="mt-1 text-muted-foreground">
        {version
          ? t(m.updateRequiredBodyWithVersion, {
              app,
              computer: computerName,
              version,
            })
          : t(m.updateRequiredBody, { app, computer: computerName })}
      </p>
      {diagnosticMessage ? (
        <p className="mt-2 rounded-md bg-background/60 px-2.5 py-1.5 font-mono text-xs text-muted-foreground">
          {diagnosticMessage}
        </p>
      ) : null}
      <p className="mt-2.5 text-xs text-muted-foreground">
        {t(
          platform === "win32"
            ? m.updateRunInPowerShell
            : m.updateRunInTerminal,
          { computer: computerName },
        )}
      </p>
      <CommandLine command={command} />
      {showMacAlternative ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {t(m.updateAlternativeMac, { app })}
        </p>
      ) : null}
      {usesNpm ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {t(m.npmNeedsNode)}
        </p>
      ) : null}
      <p className="mt-1.5 text-xs text-muted-foreground">
        {t(m.readyAfterUpdate)}
      </p>
    </div>
  );
}
