import type { CommandTarget } from "./command-definition.js";
import {
  CliError,
  type ErrorCode,
  type TeamHubErrorCode,
  type undeclaredTeamHubCodes,
} from "./errors.js";
import { accountIdentityText, displayText } from "./display-text.js";

export interface CommandError {
  code: string;
  message: string;
  command?: string;
  target?: CommandTarget;
  details?: Record<string, unknown>;
}
const singleLine = (value: string) => value.replace(/\p{Cc}/gu, " ");
/** Codes TeamHub sends; conflict is a 409 without TeamHub's envelope. */
type RemoteCode =
  | TeamHubErrorCode
  | (typeof undeclaredTeamHubCodes)[number]
  | "conflict";

/**
 * What a caller reads instead of TeamHub's or a provider's own prose: what
 * happened and what to do next. Every code TeamHub can send has one.
 */
const templates: Record<RemoteCode, string> = {
  invalid_request:
    "TeamHub rejected the request; see the issues, or check this command's --help and --schema.",
  invalid_input:
    "TeamHub rejected the input; see the issues, or check this command's --help and --schema.",
  artifact_reference_invalid:
    "A referenced Artifact is invalid or unavailable; check its ID.",
  team_md_document_invalid:
    "The team.md document is invalid; fix each issue's path and write it again.",
  unauthenticated: "The Agent identity credential is invalid or expired.",
  agent_credential_invalid: "The Agent credential is invalid or was revoked.",
  context_identity_invalid:
    "The Context of this command is not available to this Agent.",
  forbidden: "The current Agent is not permitted to perform this operation.",
  conflict:
    "The operation conflicts with the current resource state; read it again before retrying.",
  operation_forbidden:
    "TeamHub does not allow this operation for the current Agent or Context.",
  not_found: "The requested resource is unavailable.",
  version_conflict:
    "The Document changed. Preserve local changes, download a fresh copy to a different path, and merge before retrying.",
  artifact_path_conflict:
    "Another Artifact already uses this path; choose a different path.",
  artifact_version_conflict:
    "The Artifact changed since it was read; read it again before retrying.",
  agent_limit_reached:
    "The sponsor already has 50 Agents; the sponsor must delete one before another can be created.",
  agent_configuration_updating:
    "The Agent is not active right now; run this command again after it is back.",
  idempotency_conflict:
    "This Operation ID already belongs to different input; use a new --operation-id for a different operation.",
  profile_revision_conflict:
    "The Personal Profile changed since it was read. Run teamhub personal-profile show, merge into its current profile, and write again with its revision_id.",
  profile_document_invalid:
    "The Personal Profile document has an invalid field; see the issues for its path. Text is plain: no heading lines, images or scripts.",
  profile_module_empty:
    "A Personal Profile module is empty; see the issues for its path. Give it an overview or at least one point.",
  payload_too_large:
    "The request is larger than TeamHub accepts; send less content or split it.",
  task_finish_conflict:
    "The Task is no longer in a state that can finish this way; check it with teamhub task check.",
  task_limit_reached:
    "This Agent already has 10 running Tasks. Check them with teamhub task check, send to an idle one, or stop one before creating another.",
  connection_not_found:
    "The connected account is unavailable; choose another with --account.",
  connection_not_active:
    "The connected account is not active; the user must reconnect it before this command can run.",
  app_not_connected:
    "No active connected account of this application is available to this Agent.",
  provider_key_required:
    "The user has not set up Composio, which every connected app needs. A card asking them to add a Composio API key was posted in this chat; run this command again after they add it.",
  search_key_requested:
    "Waiting for the user to add a web search API key; a card asking for it is in the chat. End your turn: the card's result wakes you. If the user declines, don't retry.",
  search_quota_exhausted:
    "The web search account has no credit or quota left; try another backend or continue without web search.",
  tool_not_found: "The application tool is unavailable for this account.",
  invalid_tool_arguments:
    "The application rejected these arguments; check this command's --help and --schema.",
  provider_auth_failed:
    "The application rejected the account's authorization; the user must reconnect the account.",
  provider_rate_limited:
    "The application is rate limiting requests; wait before running this command again.",
  provider_unavailable:
    "The application is temporarily unavailable; run this command again later.",
  tool_execution_failed:
    "The application reported a failure, and part of the operation may have happened. Check the original objects before submitting again.",
  incomplete_response:
    "The connected application returned incomplete data; no complete result is available.",
  dependency_unavailable:
    "A service TeamHub depends on is temporarily unavailable; run this command again later.",
  internal_error:
    "TeamHub could not complete the request; run this command again later.",
  tracking_item_conflict:
    "The Tracking Item changed since it was read; run teamhub tracking-items list and retry with its current revision.",
  tracking_item_not_found:
    "The Tracking Item is unavailable; run teamhub tracking-items list for the current ones.",
  path_conflict: "A file already exists at this path; choose a different path.",
  latest_not_ready:
    "The latest version is still being prepared; run this command again in a moment.",
  sharing_conflict:
    "The sharing settings changed at the same time; run this command again.",
  too_large: "The file is larger than TeamHub accepts.",
  asset_unavailable: "The file content is unavailable.",
  unavailable:
    "The file operation could not be completed; run this command again later.",
  service_upgrading:
    "TeamHub is upgrading; nothing was written—retry this command shortly.",
};

/**
 * 2: fix the command or its input. 3: the current state conflicts; read it
 * again. 4: not authorized, or waiting for the user. 5: not found. 1: any
 * other failure, including an unknown outcome.
 */
const exitCodes: Record<ErrorCode, 1 | 2 | 3 | 4 | 5> = {
  usage: 2,
  invalid_input: 2,
  configuration_error: 2,
  connection_failed: 1,
  outcome_unknown: 1,
  internal_error: 1,
  invalid_response: 1,
  conflict: 3,
  target_ambiguous: 2,
  account_ambiguous: 2,
  authorization_required: 4,
  capability_unavailable: 1,
  cursor_mismatch: 2,
  unsupported_combination: 2,
  provider_error: 1,
  file_transfer_failed: 1,
  state_unavailable: 1,
  projection_pending: 1,
  page_unreadable: 1,
  invalid_request: 2,
  artifact_reference_invalid: 2,
  team_md_document_invalid: 2,
  unauthenticated: 4,
  agent_credential_invalid: 4,
  context_identity_invalid: 4,
  forbidden: 4,
  operation_forbidden: 4,
  not_found: 5,
  version_conflict: 3,
  artifact_path_conflict: 3,
  artifact_version_conflict: 3,
  agent_limit_reached: 3,
  agent_configuration_updating: 3,
  idempotency_conflict: 3,
  profile_revision_conflict: 3,
  profile_document_invalid: 2,
  profile_module_empty: 2,
  payload_too_large: 2,
  task_finish_conflict: 3,
  task_limit_reached: 3,
  connection_not_found: 5,
  connection_not_active: 3,
  app_not_connected: 3,
  provider_key_required: 4,
  search_key_requested: 4,
  search_quota_exhausted: 1,
  tool_not_found: 5,
  invalid_tool_arguments: 2,
  provider_auth_failed: 3,
  provider_rate_limited: 1,
  provider_unavailable: 1,
  tool_execution_failed: 1,
  incomplete_response: 1,
  dependency_unavailable: 1,
  tracking_item_conflict: 3,
  tracking_item_not_found: 5,
  path_conflict: 3,
  latest_not_ready: 1,
  sharing_conflict: 3,
  too_large: 2,
  asset_unavailable: 1,
  unavailable: 1,
  service_upgrading: 1,
};

/** Every code with an exit code; the closed-set test reads it. */
export const knownErrorCodes = Object.keys(exitCodes) as ErrorCode[];
/** Every code TeamHub can send with a template; the closed-set test reads it. */
export const templatedErrorCodes = Object.keys(templates) as RemoteCode[];

export function formatCommandError(
  error: CliError,
  context: { command?: string; target?: CommandTarget; usage?: string[] },
): CommandError {
  const code: string = error.code;
  // This CLI authored every local message. Backend and provider prose never
  // reaches the caller: it can reveal routing addresses or credentials, and
  // authority or existence is never inferred from it.
  const message =
    error.origin === "local"
      ? singleLine(error.message)
      : code === "version_conflict" && !context.command?.startsWith("docs ")
        ? "The resource changed since it was read; read it again before retrying."
        : Object.hasOwn(templates, code)
          ? templates[code as RemoteCode]
          : "The TeamHub operation could not be completed.";
  const details = Object.fromEntries(
    [
      "http_status",
      "request_id",
      "operation_id",
      "retryable",
      "base_version_id",
      "current_version_id",
      "document_id",
      "thread_id",
      "task_id",
      "issues",
      "issues_omitted",
      "room_id",
      "message_id",
      "interaction_id",
      "candidates",
      "draft_id",
      "partial_receipts",
      "backend",
      "origin",
      "reason",
      "ready_backends",
      "retry_after_seconds",
      "group",
      "commands",
    ]
      .filter((name) => Object.hasOwn(error.details, name))
      .map((name) => [name, error.details[name]]),
  );
  if (code === "target_ambiguous" && Array.isArray(error.details.candidates)) {
    // Candidates are object IDs, such as Document IDs or base64 attachment
    // IDs. A bounded token without ":" or whitespace keeps addresses and
    // forged lines out.
    const candidates = error.details.candidates.filter(
      (id): id is string =>
        typeof id === "string" && /^[A-Za-z0-9_=+/.-]{1,2048}$/u.test(id),
    );
    if (candidates.length) details.candidates = candidates;
    else delete details.candidates;
  }
  if (context.usage?.length) details.usage = context.usage;
  return {
    code: error.code,
    message,
    ...(context.command ? { command: context.command } : {}),
    ...(context.target ? { target: context.target } : {}),
    ...(Object.keys(details).length ? { details } : {}),
  };
}
export function renderCommandError(error: CommandError): string {
  return [
    `teamhub: ${singleLine(error.code)}: ${error.message}`,
    error.command ? `Command: teamhub ${error.command}` : "",
    error.target
      ? ["thread", "inbox"].includes(error.target.type)
        ? `Target: --${error.target.type} ${singleLine(error.target.id)}`
        : `Context: ${error.target.type}:${singleLine(error.target.id)}`
      : "",
    typeof error.details?.base_version_id === "string"
      ? `Base version: ${singleLine(error.details.base_version_id)}`
      : "",
    typeof error.details?.current_version_id === "string"
      ? `Current version: ${singleLine(error.details.current_version_id)}`
      : "",
    typeof error.details?.operation_id === "string"
      ? `Operation ID: ${singleLine(error.details.operation_id)}`
      : "",
    typeof error.details?.request_id === "string"
      ? `Request ID: ${singleLine(error.details.request_id)}`
      : "",
    typeof error.details?.retry_after_seconds === "number"
      ? `Retry after: ${error.details.retry_after_seconds}s`
      : "",
    typeof error.details?.message_id === "string"
      ? `Authorization card: ${singleLine(error.details.message_id)}`
      : "",
    typeof error.details?.draft_id === "string"
      ? `Draft: ${singleLine(error.details.draft_id)}`
      : undefined,
    Array.isArray(error.details?.ready_backends) &&
    error.details.ready_backends.length
      ? `Ready backends: ${error.details.ready_backends.map((item) => singleLine(displayText(item))).join(", ")}`
      : "",
    ...(Array.isArray(error.details?.partial_receipts)
      ? error.details.partial_receipts
      : []
    ).map(
      (item: Record<string, unknown>) =>
        `Completed step: ${singleLine(JSON.stringify(item))}`,
    ),
    Array.isArray(error.details?.candidates) &&
    error.details.candidates.some((item) => typeof item === "string")
      ? `Candidates: ${error.details.candidates
          .filter((item) => typeof item === "string")
          .map(singleLine)
          .join(", ")}`
      : "",
    ...(Array.isArray(error.details?.candidates)
      ? error.details.candidates.filter((item) => typeof item === "object")
      : []
    ).map(
      (item: Record<string, unknown>) =>
        `Account: ${singleLine(displayText(item.connection_id ?? ""))}  ${singleLine(accountIdentityText(item.app_key, item.identity_label))}`,
    ),
    ...(Array.isArray(error.details?.issues) ? error.details.issues : []).map(
      (issue: Record<string, unknown>) =>
        `Issue: ${["path", "code", "message"]
          .map((name) => singleLine(displayText(issue?.[name] ?? "")))
          .filter(Boolean)
          .join(": ")}`,
    ),
    typeof error.details?.issues_omitted === "number"
      ? `And ${error.details.issues_omitted} more issues.`
      : "",
    Array.isArray(error.details?.commands)
      ? `Commands in ${singleLine(displayText(error.details.group ?? ""))}: ${error.details.commands.map((item) => singleLine(displayText(item))).join(", ")}.`
      : "",
    ...(Array.isArray(error.details?.usage) ? error.details.usage : []).map(
      (line) => `Usage: ${singleLine(displayText(line))}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}
export function errorExitCode(failure: CliError): number {
  const status = failure.details.http_status;
  // A code from a newer TeamHub that this build does not know.
  return Object.hasOwn(exitCodes, failure.code)
    ? exitCodes[failure.code]
    : status === 409
      ? 3
      : status === 401 || status === 403
        ? 4
        : status === 404
          ? 5
          : status === 400 || status === 413
            ? 2
            : 1;
}
