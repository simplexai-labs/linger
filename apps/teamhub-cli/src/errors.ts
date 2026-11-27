import type { components } from "@linger/wire-contracts/teamhub-agent-api/types";

/** TeamHub's declared Agent API codes; they pass through unchanged. */
export type TeamHubErrorCode = components["schemas"]["AgentApiErrorCode"];

/**
 * Codes TeamHub sends outside its declared Agent API set: the Tracking Item
 * routes, and the envelopes of the file and message-commit routes.
 */
export const undeclaredTeamHubCodes = [
  "tracking_item_conflict",
  "tracking_item_not_found",
  "path_conflict",
  "latest_not_ready",
  "sharing_conflict",
  "too_large",
  "asset_unavailable",
  "unavailable",
  "service_upgrading",
] as const;

/**
 * Codes this CLI writes itself. usage: the command line is malformed.
 * invalid_input: a flag value, JSON, schema, file or size is wrong.
 * configuration_error: configuration, credential or Context. Transport and
 * the CLI itself use connection_failed (nothing was written), outcome_unknown
 * (a write may have happened) and internal_error (a CLI bug).
 */
export const localErrorCodes = [
  "usage",
  "invalid_input",
  "configuration_error",
  "connection_failed",
  "outcome_unknown",
  "internal_error",
  "invalid_response",
  "conflict",
  "target_ambiguous",
  "account_ambiguous",
  "authorization_required",
  "capability_unavailable",
  "cursor_mismatch",
  "unsupported_combination",
  "provider_error",
  "file_transfer_failed",
  "state_unavailable",
  "projection_pending",
  "page_unreadable",
] as const;

/** The closed set of codes a CLI failure carries. */
export type ErrorCode =
  | (typeof localErrorCodes)[number]
  | TeamHubErrorCode
  | (typeof undeclaredTeamHubCodes)[number];

/**
 * Where a failure's text was written. This CLI authors every local message
 * and shows it as is; a remote one wraps TeamHub's or a provider's own prose,
 * which is never shown, so the code's template replaces it.
 */
export type ErrorOrigin = "local" | "remote";

export class CliError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly origin: ErrorOrigin = "local",
  ) {
    super(message);
  }
}
