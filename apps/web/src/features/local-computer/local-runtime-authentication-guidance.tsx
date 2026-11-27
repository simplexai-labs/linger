import type { TeamHubLocalRuntimeType } from "@/features/teamhub/teamhub-types";
import { RichMessage, useT } from "@/i18n/use-translation";

import { appNames } from "./computer-readiness";
import { computerSetupMessages } from "./computer-setup.messages";
import { useDesktopComputer } from "./desktop-computer";
import { type SignInComputer, signInCommand } from "./local-runtime-commands";

export function LocalRuntimeAuthenticationGuidance({
  runtimeType,
  computerName,
  computer,
}: {
  runtimeType: TeamHubLocalRuntimeType;
  computerName: string;
  computer?: SignInComputer;
}) {
  const t = useT();
  const desktop = useDesktopComputer();
  const app = appNames[runtimeType];
  return (
    <>
      <p className="font-medium">
        {t(computerSetupMessages.signInRequired, { app })}
      </p>
      <p className="mt-1 text-muted-foreground">
        <RichMessage
          message={computerSetupMessages.signInGuidance}
          tags={{ code: (text) => <code className="font-mono">{text}</code> }}
          values={{
            command: signInCommand(runtimeType, computer, desktop),
            computer: computerName,
          }}
        />
      </p>
      {runtimeType === "pi" && (
        <p className="mt-1 text-muted-foreground">
          {t(computerSetupMessages.piSignIn)}
        </p>
      )}
      {runtimeType === "antigravity" && (
        <p className="mt-1 text-muted-foreground">
          {t(computerSetupMessages.antigravitySignIn)}
        </p>
      )}
    </>
  );
}
