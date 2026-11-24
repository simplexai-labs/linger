import type { TeamHubLocalRuntimeType } from "@/features/teamhub/teamhub-types";
import type { Translate } from "@/i18n/language";

import { appNames } from "./computer-readiness";
import { localRuntimeMessageMessages as m } from "./local-runtime-message.messages";

/**
 * The sentence for a local Runtime status: worded by its error code, or the
 * English message TeamHub sent when the code is unknown or missing.
 * RUNTIME_DIAGNOSTIC_FAILED carries the Runtime's own diagnostic, so it keeps
 * the message as sent.
 */
export function localRuntimeMessage(
  status: { readonly error_code?: string; readonly message?: string },
  runtimeType: TeamHubLocalRuntimeType,
  computer: string,
  t: Translate,
): string | undefined {
  const app = appNames[runtimeType];
  switch (status.error_code) {
    case "RUNTIME_NOT_INSTALLED":
      return t(m.notInstalled, { app, computer });
    case "RUNTIME_AUTHENTICATION_REQUIRED":
      return t(m.signInRequired, { app, computer });
    case "RUNTIME_INCOMPATIBLE":
      return t(m.needsUpdate, { app, computer });
    case "LOCAL_COMPUTER_UPGRADE_REQUIRED":
      return t(m.computerNeedsUpdate, { computer });
    case "LOCAL_COMPUTER_OFFLINE":
      return t(m.computerOffline, { computer });
    default:
      return status.message;
  }
}
