import path from "node:path";
import {
  operationHeaders,
  teamHubData,
  type TeamHubApiPostPath,
} from "./http-client.js";
import {
  connectorOutput,
  connectorOutputDescription,
} from "./connector-output.js";
import { createHash } from "node:crypto";
import type {
  CommandApproval,
  CommandDefinition,
  CommandExecutionContext,
  CommandOption,
} from "./command-definition.js";
import { connectorWriteApproval } from "./connector-approval.js";
import { id, object, rootSchema } from "./connector-schemas.js";
import { CliError } from "./errors.js";
import type { ErrorObject } from "ajv";
import {
  ajvInputIssues,
  fileFailure,
  fileSystemError,
  flagPaths,
  invalidFlag,
  invalidInput,
  mebibytes,
} from "./input-issues.js";
import type { ConnectorFile } from "./connector-files.js";
import { accountIdentityText, displayText } from "./display-text.js";

export type Json = Record<string, unknown>;
export interface ConnectorBinding {
  slug: string;
  version: string;
  schema: Json;
}
export const appKeys: Record<string, string> = {
  gmail: "gmail",
  outlook: "outlook",
  "feishu-mail": "feishu_mail",
  slack: "slack",
  gcal: "google_calendar",
  notion: "notion",
  gdrive: "googledrive",
  figma: "figma",
  github: "github",
  fal: "fal_ai",
  higgsfield: "higgsfield",
};
/**
 * Feishu Mail attachments travel inside the tool call, which TeamHub caps at
 * 1 MiB, so their base64 must leave room for the body and the request.
 */
export const FEISHU_MAIL_ATTACHMENT_BUDGET = 640 * 1024;
// Dated toolkit pins from the official catalog, reviewed 2026-10-16 (fal and
// Higgsfield on 2026-11-05, GitHub on 2026-11-06).
export const connectorVersions: Record<string, string> = {
  gmail: "20261015_00",
  outlook: "20261014_00",
  // TeamHub serves Feishu Mail's tools itself, at this version.
  "feishu-mail": "20261121_00",
  slack: "20261015_00",
  gcal: "20261010_00",
  notion: "20261008_00",
  gdrive: "20261001_00",
  figma: "20261010_00",
  github: "20261104_00",
  fal: "20261101_00",
  higgsfield: "20261018_00",
};
export const value = (
  description: string,
  repeatable = false,
): CommandOption => ({ description, ...(repeatable ? { repeatable } : {}) });
export const toggle = (description: string): CommandOption => ({
  description,
  boolean: true,
});
export const record = (value: unknown, label = "response"): Json => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CliError("incomplete_response", `The ${label} is incomplete.`);
  return value as Json;
};
export const requiredString = (v: unknown, label: string): string => {
  if (typeof v !== "string" || !v.trim())
    throw new CliError("incomplete_response", `Missing ${label}.`);
  return v;
};
export const optionalFields = (v: Json): Json =>
  Object.fromEntries(
    Object.entries(v).filter(([, x]) => x !== undefined && x !== null),
  );
export function unwrap(value: unknown): Json {
  let result = Array.isArray(value) ? { items: value } : record(value);
  // Some tools return their own execution envelope inside the common adapter.
  if (
    result.successful === false ||
    result.success === false ||
    result.ok === false
  )
    throw new CliError(
      "provider_error",
      "The connected application rejected the operation.",
    );
  if (Object.hasOwn(result, "successful") && result.data !== undefined)
    result = Array.isArray(result.data)
      ? { items: result.data }
      : record(result.data);
  return result;
}
export interface ConnectorSpec {
  command: readonly string[];
  app?(input: Json): string;
  description: string;
  readOnly: boolean;
  options: Readonly<Record<string, CommandOption>>;
  usage?: readonly string[];
  examples?: readonly string[];
  notes?: readonly string[];
  inputSchema: Json;
  outputSchema?: Json;
  sourceFiles?(input: Json): readonly string[];
  normalize: CommandDefinition["normalize"];
  bindings(input: Json): readonly string[];
  /** Adjusts a bound tool's input schema before arguments are checked. */
  bindingSchema?(slug: string, schema: Json): Json;
  execute(input: Json, runtime: ConnectorRuntime): Promise<Json>;
}
export function validateAccountSelector(account: string | undefined): void {
  if (
    account !== undefined &&
    (!account.trim() ||
      [...account].length > 240 ||
      account.trim() !== account ||
      /[\r\n\p{Cc}]/u.test(account))
  )
    throw new CliError(
      "usage",
      "--account requires a connection ID or complete identity label.",
    );
}
/** Selects a delegated account or posts the chat authorization card. */
export async function resolveConnectorAccount(
  context: CommandExecutionContext,
  appKey: string,
  account?: string,
): Promise<Json> {
  const resolution = await teamHubData(
    context.client.api.POST("/api/agent/v1/apps/account", {
      body: { app_key: appKey, ...(account === undefined ? {} : { account }) },
    }),
  );
  if (resolution.status === "authorization_required")
    authorizationCard(resolution);
  if (resolution.status === "account_ambiguous")
    throw new CliError(
      "account_ambiguous",
      "The requested account is unavailable or more than one account matches. If one of the candidates is the account you meant, run again with --account set to its connection ID; otherwise pass the account's label (for example its email address) with --account to ask the user to authorize it.",
      { candidates: resolution.candidates, operation_rejected: true },
    );
  const selected = record(resolution.account, "selected account");
  if (resolution.status !== "ready")
    throw new CliError(
      "invalid_response",
      "TeamHub did not select an account for this application.",
    );
  return selected;
}
function authorizationCard(resolution: Json): never {
  throw new CliError(
    "authorization_required",
    "Waiting for the user to authorize the account; an authorization card is in the chat. End your turn: the card's result wakes you, then run this command again. If the user declines, don't retry.",
    { ...resolution, operation_rejected: true },
  );
}
/** Binds the exact pinned version of each tool on one account. */
async function bindTools(
  context: CommandExecutionContext,
  app: string,
  connectionId: string,
  slugs: readonly string[],
  label: string,
): Promise<ConnectorBinding[]> {
  if (!slugs.length) return [];
  const found = await teamHubData(
    context.client.api.POST("/api/agent/v1/apps/tools/bind", {
      body: {
        connection_id: connectionId,
        tool_version: connectorVersions[app] as string,
        tool_slugs: [...slugs],
      },
    }),
  );
  return slugs.map((slug) => {
    const matches = (Array.isArray(found.tools) ? found.tools : [])
      .map((x) => record(x))
      .filter((x) => x.tool_slug === slug && x.app_key === appKeys[app]);
    if (
      matches.length !== 1 ||
      matches[0]!.tool_version !== connectorVersions[app]
    )
      throw new CliError(
        "capability_unavailable",
        `The exact binding for ${label} is unavailable.`,
        { operation_rejected: true },
      );
    return {
      slug,
      version: String(matches[0]!.tool_version),
      schema: record(matches[0]!.input_schema, "tool schema"),
    };
  });
}
/** The result of a command whose external write awaits the sponsor. */
const confirmationOutput = rootSchema({
  result: object(
    {
      action: { const: "confirmation_requested" },
      confirmation: object(
        {
          status: { const: "pending" },
          interactionId: id,
          messageId: id,
          roomId: id,
        },
        ["status", "interactionId", "messageId", "roomId"],
      ),
    },
    ["action", "confirmation"],
  ),
});

/** Thrown by the runtime once the final write is submitted for confirmation. */
class ConfirmationRequested extends Error {}

export function connectorDefinition(spec: ConnectorSpec): CommandDefinition {
  const approval: CommandApproval = spec.readOnly
    ? "allow"
    : (connectorWriteApproval[spec.command.join(" ")] ?? "judge");
  const confirm = approval === "confirm";
  const baseOutput =
    spec.outputSchema ?? connectorOutput(spec.command, spec.readOnly);
  // TeamHub decides which external write waits for the sponsor,
  // so any write command may end with a confirmation request.
  const outputSchema = spec.readOnly
    ? baseOutput
    : { anyOf: [baseOutput, confirmationOutput] };
  return {
    ...spec,
    approval,
    toolName: `connector_${spec.command.join("_").replaceAll("-", "_")}`,
    options: {
      ...spec.options,
      "--account": value(
        "Select a connection ID or complete account label; when authorization is missing, an authorization card is shown in the chat.",
      ),
    },
    usage: spec.usage ?? [`teamhub ${spec.command.join(" ")} [flags]`],
    operationId: !spec.readOnly,
    allowUnknownReplay: false,
    outputSchema,
    outputDescription: connectorOutputDescription(spec.command),
    notes: [
      ...(spec.notes ?? []),
      ...(confirm
        ? [
            "The external write waits for the sponsor to approve a confirmation card in the chat; TeamHub then runs it and sends you the result, or the denial and its reason.",
          ]
        : []),
      "Help and schema are available offline; TeamHub checks current access at execution time.",
    ],
    normalize: async (args, reader) => {
      const normalized = await spec.normalize(args, reader);
      const account = args.options["--account"]?.[0];
      validateAccountSelector(account);
      const input = {
        ...normalized.input,
        ...(account === undefined ? {} : { account }),
      };
      const errors = await schemaErrors(spec.inputSchema, input);
      if (errors.length)
        throw invalidInput(
          `The input does not match ${spec.command.join(" ")}.`,
          flagPaths(ajvInputIssues(errors, input), {
            ...spec.options,
            "--account": true,
          }),
        );
      return { ...normalized, input };
    },
    prepare: async (input, context) => {
      const app = spec.app?.(input) ?? spec.command[0]!;
      const account = await resolveConnectorAccount(
        context,
        appKeys[app]!,
        (input.account as string | undefined) ?? cursorAccount(input.cursor),
      );
      const connectionId = requiredString(
        account.connection_id,
        "connection ID",
      );
      if (account.app_key !== appKeys[app])
        throw new CliError(
          "invalid_response",
          "TeamHub did not select an account for this application.",
        );
      const bindings = (
        await bindTools(
          context,
          app,
          connectionId,
          [...new Set(spec.bindings(input))],
          spec.command.join(" "),
        )
      ).map((binding) => ({
        ...binding,
        schema:
          spec.bindingSchema?.(binding.slug, binding.schema) ?? binding.schema,
      }));
      let body = input;
      if (input.bodyFormat === "markdown") {
        const converted = await teamHubData(
          context.client.api.POST("/api/agent/v1/apps/mail-body", {
            body: { content: input.content as string },
          }),
        );
        body = {
          ...input,
          content: requiredString(converted.html, "rendered HTML"),
          bodyFormat: "html",
        };
      }
      if (app === "notion" && input.content !== undefined) {
        const converted = await teamHubData(
          context.client.api.POST("/api/agent/v1/apps/notion-body", {
            body: {
              content: input.content as string,
              markdown: input.markdown === true,
            },
          }),
        );
        if (
          typeof converted.markdown !== "string" ||
          !Array.isArray(converted.blocks)
        )
          throw new CliError(
            "invalid_response",
            "Notion content preparation is incomplete.",
          );
        body = {
          ...body,
          _markdown: converted.markdown,
          _blocks: converted.blocks,
        };
      }
      const sourceFiles = spec.sourceFiles?.(input) ?? [];
      const files = sourceFiles.length
        ? await (
            await import("./connector-files.js")
          ).snapshotConnectorFiles(sourceFiles)
        : [];
      const encoded = files.reduce(
        (total, file) => total + Math.ceil(file.sizeBytes / 3) * 4 + 2048,
        Math.ceil(Buffer.byteLength(displayText(body.content ?? "")) / 3) * 4 +
          8192,
      );
      if (app === "gmail" && encoded > 25 * 1024 * 1024)
        throw invalidFlag(
          "--attach",
          "out_of_range",
          `the encoded message must be at most 25 MiB; got ${mebibytes(encoded)}.`,
        );
      const feishuEncoded = files.reduce(
        (total, file) => total + Math.ceil(file.sizeBytes / 3) * 4,
        0,
      );
      if (
        app === "feishu-mail" &&
        feishuEncoded > FEISHU_MAIL_ATTACHMENT_BUDGET
      )
        throw invalidFlag(
          "--attach",
          "out_of_range",
          `Feishu Mail attachments sent through Linger are limited to about 640 KiB in total; got ${mebibytes(feishuEncoded)}. Share a link instead.`,
        );
      const large = files.find((file) => file.sizeBytes > 150 * 1024 * 1024);
      if (app === "outlook" && large)
        throw invalidFlag(
          "--attach",
          "unreadable",
          `${large.name}: larger than 150 MiB.`,
        );
      return {
        ...body,
        _account: account,
        _bindings: bindings,
        ...(files.length ? { _files: files } : {}),
      };
    },
    execute: async (input, context) => {
      const runtime = new ConnectorRuntime(input, context);
      // Once the final write is submitted the command has ended, whatever
      // its own code did with the interruption.
      const confirmation = () => ({
        account: accountOutput(runtime),
        result: {
          action: "confirmation_requested",
          confirmation: runtime.confirmation,
        },
      });
      try {
        const result = await spec.execute(input, runtime);
        if (runtime.confirmation) return confirmation();
        const output = { account: accountOutput(runtime), ...result };
        if (!(await validateSchema(outputSchema, output)))
          throw new CliError(
            "incomplete_response",
            "The application result does not satisfy this command's output schema.",
          );
        return output;
      } catch (error) {
        if (runtime.confirmation) return confirmation();
        if (runtime.completedWrites)
          throw new CliError(
            "outcome_unknown",
            // The CLI's own reason for the failed step is safe to show;
            // TeamHub's carries its issues in details instead.
            `Part of this external operation completed${
              error instanceof CliError && error.origin === "local"
                ? `, then a later step failed with ${error.code}: ${error.message}`
                : ""
            }. Check the original objects before submitting again.`,
            {
              ...(error instanceof CliError ? error.details : {}),
              // A later rejected step cannot undo an earlier external write.
              operation_rejected: false,
              partial_receipts: [
                ...runtime.receipts,
                ...(error instanceof CliError &&
                Array.isArray(error.details.partial_receipts)
                  ? error.details.partial_receipts
                  : []),
              ],
            },
          );
        if (!runtime.writeAttempts && error instanceof CliError)
          throw new CliError(
            error.code,
            error.message,
            { ...error.details, operation_rejected: true },
            error.origin,
          );
        // Without a write attempt nothing reached the application, so a
        // local failure, such as an output path that cannot be written,
        // rejects the command instead of leaving its outcome unknown.
        if (!runtime.writeAttempts) {
          // A failed save names --output; any other file stays generic.
          const output =
            typeof input.output === "string" &&
            fileSystemError(error) &&
            error.path !== undefined &&
            path
              .resolve(error.path)
              .startsWith(path.dirname(path.resolve(input.output)));
          const failure = !fileSystemError(error)
            ? new CliError(
                "internal_error",
                "The command failed on this computer before anything was sent.",
              )
            : output
              ? fileFailure(error, "--output", undefined, true)
              : fileFailure(error);
          throw new CliError(failure.code, failure.message, {
            ...failure.details,
            operation_rejected: true,
          });
        }
        throw error;
      }
    },
    render: (result) => renderConnectorResult(result),
  };
}

function accountOutput(runtime: ConnectorRuntime): Json {
  return {
    connectionId: runtime.account.connection_id,
    name: runtime.account.app_key,
    displayName: runtime.account.display_name,
    identityLabel: runtime.account.identity_label,
  };
}

export class ConnectorRuntime {
  readonly account: Json;
  completedWrites = 0;
  writeAttempts = 0;
  readonly receipts: Json[] = [];
  /** Set once the final write was submitted for the sponsor's confirmation. */
  confirmation?: Json;
  private readonly bindings: ConnectorBinding[];
  readonly files: ConnectorFile[];
  readonly pageKey: string;
  private readonly staged = new Map<string, Json>();
  constructor(
    input: Json,
    readonly context: CommandExecutionContext,
  ) {
    this.account = record(input._account, "prepared account");
    this.pageKey = digest({
      connection: this.account.connection_id,
      ...Object.fromEntries(
        Object.entries(input).filter(
          ([key]) =>
            key !== "cursor" && key !== "account" && !key.startsWith("_"),
        ),
      ),
    });
    this.bindings = input._bindings as ConnectorBinding[];
    this.files = (input._files ?? []) as ConnectorFile[];
  }
  async stageDownloadedFile(remote: Json, slug: string): Promise<Json> {
    const { randomUUID } = await import("node:crypto");
    const { mkdir, rm } = await import("node:fs/promises");
    const { saveConnectorDownload, snapshotConnectorFiles } =
      await import("./connector-files.js");
    const directory = path.join(
      this.context.stateRoot,
      ".teamhub",
      `attachment-${randomUUID()}`,
    );
    await mkdir(directory, { mode: 0o700, recursive: true });
    const name = requiredString(remote.name, "attachment filename");
    if (path.basename(name) !== name || name === "." || name === "..")
      throw new CliError(
        "incomplete_response",
        "The attachment filename is invalid.",
      );
    try {
      const saved = await saveConnectorDownload(
        remote.s3url,
        path.join(directory, name),
        this.context,
      );
      const [file] = await snapshotConnectorFiles([saved.path]);
      if (!file)
        throw new CliError(
          "incomplete_response",
          "Attachment snapshot is missing.",
        );
      return await this.stageFile(file, slug);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  async stageFile(file: ConnectorFile, slug: string): Promise<Json> {
    const binding = this.bindings.find((x) => x.slug === slug);
    if (!binding)
      throw new CliError(
        "capability_unavailable",
        "The upload tool is not prepared.",
        { operation_rejected: true },
      );
    const key = `${slug}:${file.sha256}:${file.name}`;
    const cached = this.staged.get(key);
    if (cached) return cached;
    const { connectorTransferURL, readConnectorFile } =
      await import("./connector-files.js");
    const bytes = await readConnectorFile(file);
    const target = await teamHubData(
      this.context.client.api.POST("/api/agent/v1/apps/files/upload-request", {
        body: {
          connection_id: this.account.connection_id as string,
          tool_slug: slug,
          tool_version: binding.version,
          filename: file.name,
          mimetype: file.mimetype,
          md5: file.md5,
        },
      }),
    );
    const url = connectorTransferURL(target.new_presigned_url);
    let response: Response;
    try {
      response = await (this.context.fetch ?? globalThis.fetch)(url, {
        method: "PUT",
        body: new Uint8Array(bytes),
        headers: { "content-type": file.mimetype },
        redirect: "error",
        signal: AbortSignal.timeout(180000),
      });
    } catch {
      throw new CliError(
        "file_transfer_failed",
        "The input file could not be staged.",
        { operation_rejected: true },
      );
    }
    await response.body?.cancel();
    if (!response.ok)
      throw new CliError(
        "file_transfer_failed",
        "The file staging upload was rejected.",
        { operation_rejected: true },
      );
    const reference = {
      name: file.name,
      mimetype: file.mimetype,
      s3key: requiredString(target.key, "staged file reference"),
    };
    this.staged.set(key, reference);
    return reference;
  }
  /**
   * Ends the command when TeamHub held its external write for the
   * sponsor's confirmation instead of running it. TeamHub runs the stored
   * call after approval and sends the Agent the result.
   */
  private held(response: Json): void {
    if (response.status !== "confirmation_pending") return;
    this.confirmation = {
      status: "pending",
      interactionId: requiredString(response.interaction_id, "interaction ID"),
      messageId: requiredString(response.message_id, "card message ID"),
      roomId: requiredString(response.room_id, "card room ID"),
    };
    throw new ConfirmationRequested();
  }
  /**
   * Sends an external write that a TeamHub connector route performs, such as
   * saving a canvas draft. It counts as a write attempt, so a failure after
   * dispatch is reported as an unknown outcome instead of a rejection.
   */
  async write(endpoint: TeamHubApiPostPath, body: Json): Promise<Json> {
    if (this.confirmation) throw new ConfirmationRequested();
    this.writeAttempts++;
    const response: Json = await teamHubData(
      this.context.client.api.POST(endpoint, {
        body: body as never,
        headers: operationHeaders(this.context.operationId),
      }),
    );
    this.completedWrites++;
    return response;
  }
  /** Adds what the last write created, such as a job ID, to its receipt. */
  noteReceipt(fields: Json): void {
    const receipt = this.receipts.at(-1);
    if (receipt) Object.assign(receipt, optionalFields(fields));
  }
  async call(slug: string, args: Json, write = false): Promise<Json> {
    if (this.confirmation) throw new ConfirmationRequested();
    const binding = this.bindings.find((x) => x.slug === slug);
    if (!binding)
      throw new CliError(
        "capability_unavailable",
        "This operation has no prepared tool binding.",
      );
    const errors = await schemaErrors(binding.schema, args);
    if (errors.length)
      throw new CliError(
        "unsupported_combination",
        "The selected tool version cannot represent this request.",
        {
          operation_rejected: true,
          issues: ajvInputIssues(errors, args, { root: "arguments" }),
        },
      );
    if (write) this.writeAttempts++;
    const response: Json = await teamHubData(
      this.context.client.api.POST("/api/agent/v1/apps/tools/execute", {
        body: {
          connection_id: this.account.connection_id as string,
          tool_slug: binding.slug,
          tool_version: binding.version,
          arguments: args,
        },
        headers: operationHeaders(write ? this.context.operationId : undefined),
      }),
    );
    this.held(response);
    const result = unwrap(response.data === null && write ? {} : response.data);
    if (write) this.completedWrites++;
    if (write)
      this.receipts.push(
        optionalFields({
          tool: binding.slug,
          id: result.id,
          messageId: result.messageId,
          threadId: result.threadId,
        }),
      );
    return result;
  }
}
export async function validateSchema(
  schema: Json,
  value: unknown,
): Promise<boolean> {
  return !(await schemaErrors(schema, value)).length;
}
/** The value's JSON Schema errors, every one of them; empty when it is valid. */
export async function schemaErrors(
  schema: Json,
  value: unknown,
): Promise<ErrorObject[]> {
  const imported = await import("ajv");
  // Native Node/Vitest synthesize CJS named exports, while the split bundle
  // exposes the CJS namespace under default. Keep both execution paths valid.
  let Ajv =
    imported.Ajv ??
    (imported.default as unknown as { Ajv: typeof imported.Ajv }).Ajv;
  // Toolkits such as Higgsfield declare JSON Schema 2020-12, which the
  // default draft-07 validator refuses to compile.
  if (schema.$schema === "https://json-schema.org/draft/2020-12/schema") {
    const draft2020 = await import("ajv/dist/2020.js");
    Ajv =
      draft2020.Ajv2020 ??
      (draft2020.default as unknown as { Ajv2020: typeof Ajv }).Ajv2020;
  }
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    verbose: true,
    logger: false,
  });
  const formats = await import("ajv-formats");
  const addFormats = (
    typeof formats.default === "function"
      ? formats.default
      : (formats.default as unknown as { default: unknown }).default
  ) as (validator: InstanceType<typeof Ajv>) => void;
  addFormats(ajv);
  return ajv.validate(schema, value) ? [] : [...(ajv.errors ?? [])];
}
function cursorAccount(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    if (typeof value !== "string" || value.length > 128 * 1024)
      throw new Error();
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      parsed.version !== 1 ||
      typeof parsed.account !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(parsed.account)
    )
      throw new Error();
    return parsed.account;
  } catch {
    throw new CliError(
      "cursor_mismatch",
      "The cursor is invalid; use the previous page's returned cursor.",
    );
  }
}
export function cursor(value: unknown, fingerprint: Json): Json {
  if (value === undefined) return {};
  try {
    if (typeof value !== "string" || value.length > 128 * 1024)
      throw new Error();
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (parsed.version !== 1 || parsed.key !== digest(fingerprint))
      throw new Error();
    return record(parsed.state);
  } catch {
    throw new CliError(
      "cursor_mismatch",
      "Use the returned cursor with the same account and filters.",
    );
  }
}
export function nextCursor(state: Json, fingerprint: Json): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      account: fingerprint.account,
      key: digest(fingerprint),
      state,
    }),
  ).toString("base64url");
}
function digest(value: Json): string {
  const canonical = (v: unknown): string =>
    Array.isArray(v)
      ? `[${v.map(canonical).join(",")}]`
      : v && typeof v === "object"
        ? `{${Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
            .join(",")}}`
        : (JSON.stringify(v) ?? "null");
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function clean(value: unknown): string {
  return displayText(value ?? "").replace(/\p{Cc}/gu, (char) =>
    char === "\n" || char === "\t" ? char : " ",
  );
}
function label(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replaceAll("_", " ")
    .replace(/\bId\b/gu, "ID")
    .replace(/^./u, (x) => x.toUpperCase());
}
export function renderConnectorResult(result: Json): string {
  const account = record(result.account);
  const lines = [
    `Account: ${clean(accountIdentityText(account.name, account.identityLabel) || account.displayName)} (${clean(account.connectionId)})`,
  ];
  const submitted = record(result.result ?? {});
  if (submitted.action === "confirmation_requested") {
    const confirmation = record(submitted.confirmation);
    lines.push(
      `Confirmation requested: the sponsor must approve this on the card in the chat (card ${clean(confirmation.messageId)}).`,
      "TeamHub runs it after approval and sends you the result; a denial comes with its reason, and an unapproved card expires after 24 hours.",
      "Do not run this command again, and do not try another way to do the same thing; continue with other work.",
    );
    return lines.join("\n");
  }
  const visit = (key: string, value: unknown, depth: number) => {
    if (value === undefined) return;
    const indent = "  ".repeat(depth);
    if (Array.isArray(value)) {
      lines.push(`${indent}${label(key)}: ${value.length}`);
      value.forEach((row, index) => {
        if (row && typeof row === "object") {
          lines.push(`${indent}  [${index + 1}]`);
          for (const [name, item] of Object.entries(row))
            visit(name, item, depth + 2);
        } else lines.push(`${indent}  ${clean(row)}`);
      });
    } else if (value && typeof value === "object") {
      lines.push(`${indent}${label(key)}:`);
      for (const [name, item] of Object.entries(value))
        visit(name, item, depth + 1);
    } else if (
      typeof value === "string" &&
      (value.includes("\n") ||
        ["bodyText", "bodyHtml", "markdown", "text", "body", "patch"].includes(
          key,
        ))
    ) {
      lines.push(`${indent}${label(key)}:`, clean(value));
    } else
      lines.push(
        `${indent}${label(key)}: ${typeof value === "boolean" ? (value ? "yes" : "no") : clean(value)}`,
      );
  };
  for (const [key, value] of Object.entries(result))
    if (key !== "account") visit(key, value, 0);
  return lines.join("\n");
}
