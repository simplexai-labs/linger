import type { Translate } from "@/i18n/language";
import type { Message } from "@/i18n/messages";

import type { RuntimeExecutionFailure } from "./runtime-presentation-events";
import { runtimeStatusMessages as m } from "./runtime-status.messages";

const messages: Record<RuntimeExecutionFailure["code"], Message<string>> = {
  session_not_found: m.failureSessionNotFound,
  protocol_incompatible: m.failureProtocolIncompatible,
  authentication_required: m.failureAuthenticationRequired,
  network_error: m.failureNetworkError,
  rate_limited: m.failureRateLimited,
  model_unavailable: m.failureModelUnavailable,
  model_not_offered: m.failureModelNotOffered,
  local_model_unavailable: m.failureLocalModelUnavailable,
  context_too_long: m.failureContextTooLong,
  model_service_error: m.failureModelServiceError,
  timeout: m.failureTimeout,
  execution_failed: m.failureExecutionFailed,
  execution_outcome_unknown: m.failureExecutionOutcomeUnknown,
  reply_undelivered: m.failureReplyUndelivered,
  reply_not_sent: m.failureReplyNotSent,
  interrupted: m.failureInterrupted,
  computer_unavailable: m.failureComputerUnavailable,
  cleanup_unconfirmed: m.failureCleanupUnconfirmed,
  response_too_large: m.failureResponseTooLarge,
  unclassified: m.failureUnclassified,
};

/**
 * An interrupted Run was stopped from outside, by a restart such as the one
 * macOS asks for after a permission grant, or by stopping the Agent. Nothing
 * failed, so the Room shows it as a stop, not as an error.
 */
export function isRunInterruption(failure?: RuntimeExecutionFailure): boolean {
  return failure?.code === "interrupted";
}

/** Why a Run failed, or "Run failed" alone when its cause is not known. */
export function runtimeFailureMessage(
  t: Translate,
  failure?: RuntimeExecutionFailure,
): string {
  return runtimeFailureReason(t, failure) ?? t(m.runFailed);
}

/** The cause of a failed Run in words, when the client knows its code. */
export function runtimeFailureReason(
  t: Translate,
  failure?: RuntimeExecutionFailure,
): string | undefined {
  if (!failure || !Object.hasOwn(messages, failure.code)) return undefined;
  const reason = t(messages[failure.code]);
  // Failures the Agent Service or TeamHub observed name no Runtime.
  if (!failure.runtime_type) return reason;
  const runtime = {
    codex: "Codex",
    claude: "Claude",
    pi: "Pi",
    antigravity: "Antigravity",
  }[failure.runtime_type];
  if (!runtime) return undefined;
  const version =
    failure.runtime_version &&
    /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(
      failure.runtime_version,
    )
      ? ` ${failure.runtime_version}`
      : "";
  return t(m.labeled, { label: `${runtime}${version}`, value: reason });
}
