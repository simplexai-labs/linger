import type { TeamHubLocalRuntimeType } from "@/features/teamhub/teamhub-types";
import { RichMessage, useT } from "@/i18n/use-translation";

import type { ComputerPlatform } from "./computer-platform";
import { appNames } from "./computer-readiness";
import { computerSetupMessages } from "./computer-setup.messages";
import { installCommand, updateCommand } from "./local-runtime-commands";

export function LocalRuntimeInstallGuidance({
  action = "install",
  runtimeTypes,
  platform,
  computerName,
}: {
  action?: "install" | "update";
  runtimeTypes: readonly TeamHubLocalRuntimeType[];
  platform?: ComputerPlatform;
  computerName: string;
}) {
  const t = useT();
  if (runtimeTypes.length === 0) return null;
  const command = action === "update" ? updateCommand : installCommand;
  const prompt =
    action === "update"
      ? platform === "win32"
        ? computerSetupMessages.updateRuntimePowerShell
        : computerSetupMessages.updateRuntime
      : platform === "win32"
        ? computerSetupMessages.installRuntimePowerShell
        : computerSetupMessages.installRuntime;
  return (
    <div className="text-xs text-muted-foreground">
      <p>{t(prompt, { computer: computerName })}</p>
      <ul className="mt-2 flex flex-col gap-1">
        {runtimeTypes.map((runtimeType) => (
          <li key={runtimeType}>
            <RichMessage
              message={computerSetupMessages.runtimeCommand}
              tags={{
                code: (text) => (
                  <code className="select-all font-mono text-foreground">
                    {text}
                  </code>
                ),
              }}
              values={{
                app: appNames[runtimeType],
                command: command(runtimeType, platform),
              }}
            />
          </li>
        ))}
      </ul>
      {action === "install" &&
      runtimeTypes.some(
        (runtimeType) => runtimeType === "codex" || runtimeType === "pi",
      ) ? (
        <p className="mt-2">{t(computerSetupMessages.npmNeedsNode)}</p>
      ) : null}
    </div>
  );
}
