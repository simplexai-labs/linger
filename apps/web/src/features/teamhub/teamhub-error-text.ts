import type { Translate } from "@/i18n/language";
import type { Message } from "@/i18n/messages";

import { teamHubErrorMessages as m } from "./teamhub-error.messages";

// Only codes whose message says nothing beyond the code are worded here.
// FORBIDDEN, CONFLICT, NOT_FOUND, PAYLOAD_TOO_LARGE, INVALID_REQUEST and the
// unavailable codes keep TeamHub's message, which names what to do, such as
// "This email was already sent." A case worth its own wording needs its own
// code from TeamHub first.
const worded: Readonly<Record<string, Message<string>>> = {
  INVALID_CREDENTIALS: m.invalidCredentials,
  UNAUTHENTICATED: m.unauthenticated,
  RATE_LIMITED: m.rateLimited,
  INTERNAL_ERROR: m.internal,
  // TeamHub always sends the same sentence for this code.
  LOCAL_COMPUTER_OFFLINE: m.computerOffline,
};

/**
 * The text a failed TeamHub request shows, in the interface language.
 * A generic code is worded from the code; every other code keeps the
 * message TeamHub sent. `HTTP_<status>` is the client's own code for a
 * response without a TeamHub error body, from a layer in front of TeamHub.
 */
export function teamHubErrorText(
  error: {
    readonly code: string;
    readonly message?: string;
    readonly status: number;
  },
  t: Translate,
): string {
  const message = Object.hasOwn(worded, error.code)
    ? worded[error.code]
    : undefined;
  if (message) return t(message);
  if (error.code === `HTTP_${error.status}`) return statusText(error.status, t);
  return error.message || statusText(error.status, t);
}

// Only the status class is meaningful without a TeamHub error body.
function statusText(status: number, t: Translate) {
  if (status === 401 || status === 403) return t(m.refused);
  if (status === 429) return t(m.rateLimited);
  if (status >= 500) return t(m.unavailable);
  return t(m.notCompleted, { status: String(status) });
}
