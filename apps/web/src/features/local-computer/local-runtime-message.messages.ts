import { defineMessages } from "@/i18n/messages";

/**
 * Why an AI app on a Computer cannot run, worded from the `error_code`
 * TeamHub sends beside its English `message`.
 */
export const localRuntimeMessageMessages = defineMessages(
  "localRuntimeMessage",
  {
    notInstalled: "{app} is not installed on {computer}.",
    signInRequired: "{app} on {computer} needs you to sign in.",
    needsUpdate: "{app} on {computer} needs an update.",
    computerNeedsUpdate: "{computer} needs a Linger update.",
    computerOffline: "{computer} is offline.",
  },
);
