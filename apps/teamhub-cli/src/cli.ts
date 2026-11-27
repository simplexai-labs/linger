import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  configurationDirectory,
  createLocalPathResolver,
  loadConfig,
  withScope,
  type TeamHubConfig,
} from "./config.js";
import {
  createTeamHubClient,
  operationHeaders,
  teamHubData,
} from "./http-client.js";
import { CliError, type ErrorCode } from "./errors.js";
import { fileFailure, fileSystemError } from "./input-issues.js";
import type {
  NormalizedCommandInput,
  CommandTarget,
} from "./command-definition.js";
import {
  formatCommandError,
  renderCommandError,
  errorExitCode,
} from "./command-errors.js";
import type { CliTiming } from "./timing.js";
import {
  commandSchema,
  findCommand,
  helpText,
  parseDomainCommand,
  unknownCommand,
} from "./domain-commands.js";

interface CliDependencies {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly fetch: typeof fetch;
  readonly readInput?: (source: string) => Promise<string>;
  readonly stdout: (text: string) => void | Promise<void>;
  readonly stderr: (text: string) => void;
  readonly timing?: CliTiming;
}

// These failures prove an external write was not dispatched. Provider
// uncertainty, transport failures and malformed successful responses cannot.
function isConnectedAppRejection(error: unknown): boolean {
  return (
    error instanceof CliError &&
    (error.details.operation_rejected === true ||
      [
        "invalid_input",
        "invalid_request",
        "invalid_tool_arguments",
        "connection_not_found",
        "connection_not_active",
        "app_not_connected",
        "provider_key_required",
        "tool_not_found",
        "provider_auth_failed",
        "operation_forbidden",
        "agent_credential_invalid",
        "forbidden",
        "unauthenticated",
      ].includes(error.code))
  );
}

// TeamHub cannot deduplicate a write a connected application performed, so
// the CLI reports it as unknown instead of inviting an automatic retry. The
// application's own reason, such as an exhausted balance, stays in issues.
function externalOutcomeUnknown(error: unknown, operationId: string): CliError {
  const details = error instanceof CliError ? error.details : {};
  return new CliError(
    "outcome_unknown",
    "The external operation outcome is unknown. Check the connected application before submitting again: running this command again submits the write again.",
    {
      ...Object.fromEntries(
        ["draft_id", "partial_receipts", "issues"]
          .filter((key) => details[key] !== undefined)
          .map((key) => [key, details[key]]),
      ),
      operation_id: operationId,
      retryable: false,
    },
  );
}

/** Codes of the local file layers that keep their meaning in this CLI. */
const fileLayerCodes = new Set<string>([
  "state_unavailable",
  "invalid_response",
  "version_conflict",
]);
const fileLayers = new Set([
  "TeamHubFileError",
  "ContextRuntimeFileError",
  "ContextSkillFolderPackError",
  "DocumentImageError",
]);

/**
 * The CliError of any failure. A local file layer's reason is this CLI's own
 * text; a bad local file is invalid_input. Anything else is a CLI bug, or,
 * after a write was handed off, an outcome the caller has to check.
 */
function unexpectedFailure(error: unknown, operationId?: string): CliError {
  if (error instanceof CliError) return error;
  if (fileSystemError(error)) return fileFailure(error);
  if (
    error instanceof Error &&
    fileLayers.has(error.name) &&
    "code" in error &&
    typeof error.code === "string"
  )
    return new CliError(
      fileLayerCodes.has(error.code)
        ? (error.code as ErrorCode)
        : "invalid_input",
      error.message,
    );
  if (operationId)
    return new CliError(
      "outcome_unknown",
      "The operation outcome is unknown. Run the same command again with --operation-id set to this Operation ID: TeamHub returns the original result instead of submitting it twice.",
      { operation_id: operationId },
    );
  return new CliError(
    "internal_error",
    "The command failed unexpectedly on this computer; this is a CLI bug.",
  );
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  let json = args.includes("--json");
  let selected = findCommand(args);
  let target: CommandTarget | undefined;
  // The Operation ID of a write handed to its executor: from then on a
  // failure this CLI cannot explain may follow a completed write.
  let dispatched: string | undefined;
  try {
    if (
      !args.length ||
      args[0] === "help" ||
      (["--help", "-h"].includes(args[0]!) && args.length === 1)
    ) {
      const prefix = args[0] === "help" ? args.slice(1) : [];
      const help = await helpText(prefix);
      if (!help) throw unknownCommand(prefix);
      await dependencies.stdout(help);
      return 0;
    }
    if (!selected && args.at(-1) === "--help") {
      const help = await helpText(args.slice(0, -1));
      if (help) {
        await dependencies.stdout(help);
        return 0;
      }
    }
    if (!selected && args.every((value) => !value.startsWith("-"))) {
      const help = await helpText(args);
      if (help) {
        await dependencies.stdout(help);
        return 0;
      }
    }
    const localPath = createLocalPathResolver(
      dependencies.cwd,
      dependencies.env,
    );
    // The whole input is checked before configuration is read, so a caller
    // without a configured Context still learns every field to fix.
    const parse = () =>
      parseDomainCommand(args, {
        ...dependencies,
        localPath,
        beforeNormalize: (value) => {
          target = value;
        },
      });
    const command = await (dependencies.timing
      ? dependencies.timing.measure("command_dependencies", parse)
      : parse());
    selected = command.descriptor;
    json = command.json;
    if (command.route === "help") {
      await dependencies.stdout(await helpText(selected.command));
      return 0;
    }
    if (command.route === "schema") {
      await dependencies.stdout(
        JSON.stringify(
          await commandSchema(selected),
          null,
          json ? undefined : 2,
        ) + "\n",
      );
      return 0;
    }
    const configured = await (dependencies.timing
      ? dependencies.timing.measure("configuration", () =>
          loadConfig(dependencies.env, dependencies.timing),
        )
      : loadConfig(dependencies.env));
    if (selected.unavailableInTask && configured.scope?.kind === "task")
      throw new CliError("forbidden", selected.unavailableInTask);
    const stateRoot =
      dependencies.env.TEAMHUB_STATE_ROOT ??
      configurationDirectory(dependencies.env);
    if (
      dependencies.env.TEAMHUB_STATE_ROOT !== undefined &&
      (!path.isAbsolute(stateRoot) ||
        Array.from(stateRoot).some((character) => {
          const code = character.codePointAt(0)!;
          return code < 32 || code === 127;
        }))
    )
      throw new CliError(
        "configuration_error",
        "TEAMHUB_STATE_ROOT must be an absolute directory without control characters.",
      );
    const normalize = async (): Promise<
      NormalizedCommandInput & { operationId?: string }
    > => {
      let input = { ...(command.body.input as Record<string, unknown>) };
      target = command.target;
      const independentRead =
        selected!.toolName === "read_messages" &&
        (input.list_inboxes === true ||
          input.message_ids !== undefined ||
          input.inbox_id !== undefined);
      let scope = command.scope;
      if (!scope && !independentRead && selected!.defaultTarget && !target) {
        const kind = configured.scope?.kind;
        if (
          !kind ||
          !(
            selected!.defaultTarget === "room-or-task"
              ? ["room", "task"]
              : [selected!.defaultTarget]
          ).includes(kind)
        )
          throw new CliError(
            "configuration_error",
            `This command needs a ${selected!.defaultTarget === "room-or-task" ? "Room or Task" : selected!.defaultTarget === "room" ? "Room" : "Task"} Context in the TeamHub CLI configuration.`,
          );
        scope = configured.scope;
        target ??= { type: kind, id: scope.id };
      }
      if (
        target &&
        [
          "send_message",
          "send_message_card",
          "send_message_sequence",
          "read_messages",
          "get_room_members",
          "get_team_md",
        ].includes(selected!.toolName) &&
        input.inbox_id === undefined &&
        input.thread_id === undefined
      )
        input.inbox_id =
          target.type === "room" && selected!.toolName !== "read_messages"
            ? target.id
            : `${target.type}:${target.id}`;
      // The configured caller Context is the only Room source. It is sent with
      // every request and is never added as an implicit collection filter.
      if (!scope) scope = configured.scope;
      if (selected!.prepare) {
        input = await selected!.prepare(input, {
          client: createTeamHubClient(
            { ...configured, scope: scope as TeamHubConfig["scope"] },
            dependencies,
          ),
          cwd: dependencies.cwd,
          stateRoot,
          fetch: dependencies.fetch,
          target,
          timing: dependencies.timing,
        });
      }
      return {
        input,
        target,
        scope,
        toolName: command.toolName ?? selected!.toolName,
        ...(typeof command.body.operation_id === "string"
          ? { operationId: command.body.operation_id }
          : {}),
      };
    };
    const dispatch = async (
      normalized: NormalizedCommandInput & { operationId?: string },
    ): Promise<number> => {
      const { input, scope } = normalized;
      target = normalized.target;
      const config: TeamHubConfig = {
        ...withScope(configured, scope as TeamHubConfig["scope"]),
        ...(selected!.fileRoute ? { identityKey: configured.identityKey } : {}),
      };
      const client = createTeamHubClient(config, dependencies);
      const toolName = normalized.toolName ?? selected!.toolName;
      const emit = async (result: Record<string, unknown>) => {
        const projected = selected!.project
          ? selected!.project(result)
          : result;
        const output = json
          ? JSON.stringify(projected)
          : selected!.render
            ? selected!.render(projected, input)
            : JSON.stringify(projected);
        if (output) await dependencies.stdout(output + "\n");
      };
      if (selected!.fileRoute) {
        const { executeFileCommand } = await import("./file-executor.js");
        await executeFileCommand(
          { route: selected!.fileRoute, body: input },
          client,
          emit,
          dependencies.timing,
        );
        return 0;
      }
      // TeamHub deduplicates a write by this ID. The caller passes the same
      // --operation-id to retry an unknown outcome; otherwise every
      // invocation is a new operation.
      const operationId = selected!.readOnly
        ? undefined
        : (normalized.operationId ?? randomUUID());
      // Complete validation precedes dispatch, especially for external apps
      // whose unknown results must never be dispatched a second time.
      const routes = selected!.execute
        ? undefined
        : await import("./business-routes.js");
      const body = routes
        ? await routes.encodeAgentCommandBody(toolName, input, operationId)
        : undefined;
      const execute = async (): Promise<Record<string, unknown>> => {
        if (selected!.execute)
          return selected!.execute(input, {
            client,
            cwd: dependencies.cwd,
            localPath,
            stateRoot,
            operationId,
            fetch: dependencies.fetch,
            timing: dependencies.timing,
            target,
          });
        const endpoint = routes!.routesByToolName[toolName];
        if (!endpoint)
          throw new CliError(
            "internal_error",
            "This command has no TeamHub endpoint in this CLI build.",
          );
        const result = await teamHubData(
          client.api.POST(endpoint, {
            body: body as never,
            headers: operationHeaders(operationId),
          }),
        );
        return routes!.decodeAgentCommandResult(toolName, result);
      };
      const externalWrite =
        !selected!.readOnly &&
        (selected!.allowUnknownReplay ?? toolName !== "execute_app_tool") ===
          false;
      let result: Record<string, unknown>;
      dispatched = operationId;
      try {
        result = await execute();
      } catch (error) {
        if (!externalWrite || isConnectedAppRejection(error)) throw error;
        throw externalOutcomeUnknown(error, operationId!);
      }
      await emit(result);
      return 0;
    };
    return await dispatch(await normalize());
  } catch (error) {
    const failure = unexpectedFailure(error, dispatched);
    const formatted = formatCommandError(failure, {
      command: selected?.command.join(" "),
      target,
      // A malformed command line shows how the command is written.
      ...(failure.code === "usage" && selected
        ? {
            usage: selected.usage.map((line) =>
              line.startsWith("teamhub ")
                ? line
                : `teamhub ${selected!.command.join(" ")} ${line}`,
            ),
          }
        : {}),
    });
    dependencies.stderr(
      (json
        ? JSON.stringify({ error: formatted })
        : renderCommandError(formatted)) + "\n",
    );
    return errorExitCode(failure);
  }
}
