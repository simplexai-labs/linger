import { type Context, Hono } from "hono";
import * as AgentManagementRoutes from "@linger/wire-contracts/node-services-internal/server";
import {
  LocalComputerBusyError,
  LocalComputerHasAgentsError,
  LocalComputerCapabilityError,
  LocalComputerNotFoundError,
  LocalComputerOfflineError,
  LocalBrowserConnectionError,
  LocalComputerPermissionError,
  LocalSkillOperationError,
  type LocalBrowserConnectionCommand,
  type LocalComputerPermissionCommand,
  type LocalComputerManagement,
} from "../../runner-gateway/local-computer-management.js";
import {
  LocalModelsActionTimeoutError,
  type LocalModelActionCommand,
} from "../../runner-gateway/runner-local-models.js";
import { isRecord } from "@linger/service-kit";

type LocalComputerHttpStatus = 400 | 404 | 405 | 409 | 410 | 502 | 503;

export class LocalComputerHttpError extends Error {
  constructor(
    readonly status: LocalComputerHttpStatus,
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "LocalComputerHttpError";
  }
}

export interface LocalComputerRouteHandlers {
  removeLocalComputer(context: Context): Promise<Response> | Response;
  scanLocalComputerSkills(context: Context): Promise<Response> | Response;
  getLocalComputerBrowserConnection(
    context: Context,
  ): Promise<Response> | Response;
  configureLocalComputerBrowserConnection(
    context: Context,
  ): Promise<Response> | Response;
  disconnectLocalComputerBrowserConnection(
    context: Context,
  ): Promise<Response> | Response;
  getLocalComputerPermissions(context: Context): Promise<Response> | Response;
  actOnLocalComputerPermission(context: Context): Promise<Response> | Response;
  actOnLocalComputerModels(context: Context): Promise<Response> | Response;
}

export const createLocalComputerRouteHandlers = (options: {
  readonly localComputerManagement: LocalComputerManagement | undefined;
  readonly pathId: (context: Context, name: string) => string;
  readonly readJsonBody: (context: Context) => Promise<unknown>;
}): LocalComputerRouteHandlers => ({
  removeLocalComputer: async (context) => {
    if (!options.localComputerManagement) {
      throw new LocalComputerHttpError(
        503,
        "local_computer_unavailable",
        "Local Computer management is unavailable",
      );
    }
    try {
      const computerId = options.pathId(context, "computerId");
      await options.localComputerManagement.runLocalComputerMutation(
        computerId,
        async () =>
          options.localComputerManagement?.removeLocalComputer({
            tenantId: options.pathId(context, "tenantId"),
            ownerActorId: options.pathId(context, "ownerActorId"),
            computerId,
          }),
      );
    } catch (error) {
      if (
        error instanceof LocalComputerHasAgentsError ||
        (isRecord(error) && error.code === "local_computer_has_agents")
      ) {
        throw new LocalComputerHttpError(
          409,
          "local_computer_has_agents",
          error instanceof Error
            ? error.message
            : "Local Computer still has assigned Agents",
        );
      }
      if (
        error instanceof LocalComputerBusyError ||
        (isRecord(error) && error.code === "local_computer_busy")
      ) {
        throw new LocalComputerHttpError(
          409,
          "local_computer_busy",
          error instanceof Error
            ? error.message
            : "Local Computer still has active Operations",
        );
      }
      if (error instanceof LocalComputerNotFoundError) {
        throw new LocalComputerHttpError(
          404,
          "local_computer_not_found",
          error.message,
        );
      }
      throw error;
    }
    context.header("cache-control", "no-store");
    return context.body(null, 204);
  },
  scanLocalComputerSkills: async (context) => {
    const management = requireLocalSkillManagement(
      options.localComputerManagement,
    );
    const body = parseLocalSkillScanRequest(
      await options.readJsonBody(context),
    );
    try {
      const result = await management.scanLocalSkills({
        tenantId: options.pathId(context, "tenantId"),
        ownerActorId: options.pathId(context, "ownerActorId"),
        computerId: options.pathId(context, "computerId"),
        commandId: body.request_id,
        scanId: body.scan_id,
        runtimeType: body.runtime_type,
        expiresAt: body.expires_at,
        signal: context.req.raw.signal,
      });
      return writeJson(context, 200, {
        scan_id: result.scanId,
        computer_id: result.computerId,
        runtime_type: result.runtimeType,
        expires_at: result.expiresAt,
        items: result.items.map((item) => ({
          candidate_ref: item.candidateRef,
          ...(item.nativeSource
            ? {
                native_source: item.nativeSource,
                native_enabled: item.nativeEnabled,
              }
            : {}),
          name: item.name,
          description: item.description,
          package_sha256: item.packageSha256,
          file_count: item.fileCount,
          size_bytes: item.sizeBytes,
          normalizations: [...item.normalizations],
          risk_flags: [...item.riskFlags],
          importability: item.importability,
          ...(item.errorCode ? { error_code: item.errorCode } : {}),
          ...(item.errorDetail ? { error_detail: item.errorDetail } : {}),
          ...(item.manifestExcerpt
            ? { manifest_excerpt: item.manifestExcerpt }
            : {}),
        })),
      });
    } catch (error) {
      throw localSkillRequestError(error);
    }
  },
  getLocalComputerBrowserConnection: (context) =>
    browserConnection(options, context, "status"),
  configureLocalComputerBrowserConnection: async (context) =>
    browserConnection(
      options,
      context,
      "configure",
      parseBrowserConnectionConfigureRequest(
        await options.readJsonBody(context),
      ),
    ),
  disconnectLocalComputerBrowserConnection: (context) =>
    browserConnection(options, context, "disconnect"),
  getLocalComputerPermissions: (context) =>
    computerPermissions(options, context, { action: "status" }),
  actOnLocalComputerPermission: async (context) =>
    computerPermissions(
      options,
      context,
      parseComputerPermissionAction(await options.readJsonBody(context)),
    ),
  actOnLocalComputerModels: async (context) => {
    const management = requireLocalComputerManagement(
      options.localComputerManagement,
    );
    if (!management.actOnLocalModels) {
      throw new LocalComputerHttpError(
        503,
        "LOCAL_MODELS_UNAVAILABLE",
        "Local models are unavailable",
      );
    }
    const body = parseLocalModelActionCommand(
      await options.readJsonBody(context),
    );
    try {
      const ack = await management.actOnLocalModels({
        tenantId: options.pathId(context, "tenantId"),
        ownerActorId: options.pathId(context, "ownerActorId"),
        computerId: options.pathId(context, "computerId"),
        action: body.action,
        ...(body.model_id === undefined ? {} : { modelId: body.model_id }),
        ...(body.unload_first === undefined
          ? {}
          : { unloadFirst: body.unload_first }),
        expiresAt: body.expires_at,
        signal: context.req.raw.signal,
      });
      return writeJson(context, 200, {
        request_id: body.request_id,
        ...ack,
      });
    } catch (error) {
      throw localModelsRequestError(error);
    }
  },
});

const computerPermissions = async (
  options: {
    readonly localComputerManagement: LocalComputerManagement | undefined;
    readonly pathId: (context: Context, name: string) => string;
  },
  context: Context,
  step: Pick<
    LocalComputerPermissionCommand,
    "action" | "subject" | "permission"
  >,
): Promise<Response> => {
  const management = requireLocalComputerManagement(
    options.localComputerManagement,
  );
  if (!management.computerPermissions) {
    throw new LocalComputerHttpError(
      503,
      "computer_permissions_unavailable",
      "Computer permissions are unavailable",
    );
  }
  try {
    const status = await management.computerPermissions({
      tenantId: options.pathId(context, "tenantId"),
      ownerActorId: options.pathId(context, "ownerActorId"),
      computerId: options.pathId(context, "computerId"),
      ...step,
      signal: context.req.raw.signal,
    });
    return writeJson(context, 200, status);
  } catch (error) {
    throw computerPermissionRequestError(error);
  }
};

/**
 * Mounts the permission routes next to the generated Agent management routes,
 * which do not own this path yet.
 */
export const registerLocalComputerPermissionRoutes = (
  app: Hono,
  handlers: Pick<
    LocalComputerRouteHandlers,
    "getLocalComputerPermissions" | "actOnLocalComputerPermission"
  >,
): void => {
  const path =
    "/v1/tenants/:tenantId/owners/:ownerActorId/local-computers/:computerId/permissions";
  app.get(path, handlers.getLocalComputerPermissions);
  app.post(path, handlers.actOnLocalComputerPermission);
  app.all(path, (context) => methodNotAllowed(context, "GET, POST"));
};

/**
 * Mounts the local-models action route next to the generated Agent
 * management routes, which do not own this path yet.
 */
export const registerLocalComputerModelRoutes = (
  app: Hono,
  handlers: Pick<LocalComputerRouteHandlers, "actOnLocalComputerModels">,
): void => {
  const path =
    "/v1/tenants/:tenantId/owners/:ownerActorId/local-computers/:computerId/local-model-actions";
  app.post(path, handlers.actOnLocalComputerModels);
  app.all(path, (context) => methodNotAllowed(context, "POST"));
};

const LOCAL_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const LOCAL_MODEL_ACTIONS: ReadonlySet<unknown> = new Set([
  "download",
  "cancel",
  "load",
  "unload",
  "remove",
  "refresh",
]);

const isLocalModelId = (value: unknown): value is string =>
  typeof value === "string" && LOCAL_MODEL_ID_PATTERN.test(value);

const parseLocalModelActionCommand = (value: unknown) => {
  const unloadFirst = isRecord(value) ? value.unload_first : undefined;
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "request_id",
          "action",
          "model_id",
          "unload_first",
          "expires_at",
        ].includes(key),
    ) ||
    !isProtocolId(value.request_id) ||
    !LOCAL_MODEL_ACTIONS.has(value.action) ||
    !isTimestamp(value.expires_at) ||
    // refresh names no model; every other action names one.
    (value.action === "refresh") !== (value.model_id === undefined) ||
    (value.model_id !== undefined && !isLocalModelId(value.model_id)) ||
    (unloadFirst !== undefined &&
      (value.action !== "load" ||
        !Array.isArray(unloadFirst) ||
        unloadFirst.length > 64 ||
        !unloadFirst.every(isLocalModelId) ||
        new Set(unloadFirst).size !== unloadFirst.length))
  ) {
    throw new LocalComputerHttpError(
      400,
      "INVALID_LOCAL_MODEL_ACTION",
      "Local model action is invalid",
    );
  }
  return value as {
    readonly request_id: string;
    readonly action: LocalModelActionCommand["action"];
    readonly model_id?: string;
    readonly unload_first?: readonly string[];
    readonly expires_at: string;
  };
};

const localModelsRequestError = (error: unknown): Error => {
  if (error instanceof LocalComputerNotFoundError) {
    return new LocalComputerHttpError(
      404,
      "LOCAL_COMPUTER_NOT_FOUND",
      error.message,
    );
  }
  if (error instanceof LocalComputerOfflineError) {
    return new LocalComputerHttpError(
      503,
      "LOCAL_COMPUTER_OFFLINE",
      error.message,
    );
  }
  if (error instanceof LocalComputerCapabilityError) {
    return new LocalComputerHttpError(
      409,
      "LOCAL_MODELS_UNSUPPORTED",
      error.message,
    );
  }
  if (error instanceof LocalModelsActionTimeoutError) {
    return new LocalComputerHttpError(
      503,
      "LOCAL_MODELS_ACTION_TIMEOUT",
      error.message,
    );
  }
  return error instanceof Error
    ? error
    : new Error("Local models action failed");
};

const browserConnection = async (
  options: {
    readonly localComputerManagement: LocalComputerManagement | undefined;
    readonly pathId: (context: Context, name: string) => string;
  },
  context: Context,
  action: LocalBrowserConnectionCommand["action"],
  body?: { readonly extension_token: string; readonly profile?: string },
): Promise<Response> => {
  const management = requireLocalComputerManagement(
    options.localComputerManagement,
  );
  if (!management.connectLocalBrowser) {
    throw new LocalComputerHttpError(
      503,
      "browser_connection_unavailable",
      "Browser connection is unavailable",
    );
  }
  try {
    const status = await management.connectLocalBrowser({
      tenantId: options.pathId(context, "tenantId"),
      ownerActorId: options.pathId(context, "ownerActorId"),
      computerId: options.pathId(context, "computerId"),
      action,
      ...(body?.profile ? { profile: body.profile } : {}),
      ...(body ? { extensionToken: body.extension_token } : {}),
      signal: context.req.raw.signal,
    });
    return writeJson(context, 200, status);
  } catch (error) {
    throw browserConnectionRequestError(error);
  }
};

export const registerLocalComputerCompatibilityRoutes = (
  app: Hono,
  handlers: LocalComputerRouteHandlers,
): void => {
  const generatedCapabilities =
    AgentManagementRoutes as typeof AgentManagementRoutes & {
      readonly AGENT_MANAGEMENT_ROUTE_CAPABILITIES?: {
        readonly localComputers?: boolean;
      };
    };
  if (
    generatedCapabilities.AGENT_MANAGEMENT_ROUTE_CAPABILITIES?.localComputers
  ) {
    return;
  }
  const inventoryPath =
    "/v1/tenants/:tenantId/owners/:ownerActorId/local-computers";
  app.delete(`${inventoryPath}/:computerId`, handlers.removeLocalComputer);
  app.post(
    `${inventoryPath}/:computerId/skill-scans`,
    handlers.scanLocalComputerSkills,
  );
  app.all(`${inventoryPath}/:computerId`, (context) =>
    methodNotAllowed(context, "DELETE"),
  );
  app.all(`${inventoryPath}/:computerId/skill-scans`, (context) =>
    methodNotAllowed(context, "POST"),
  );
};

const requireLocalComputerManagement = (
  management: LocalComputerManagement | undefined,
): LocalComputerManagement => {
  if (!management) {
    throw new LocalComputerHttpError(
      503,
      "local_computer_unavailable",
      "Local Computer management is unavailable",
    );
  }
  return management;
};

const requireLocalSkillManagement = (
  management: LocalComputerManagement | undefined,
): LocalComputerManagement &
  Required<Pick<LocalComputerManagement, "scanLocalSkills">> => {
  const available = requireLocalComputerManagement(management);
  if (!available.scanLocalSkills) {
    throw new LocalComputerHttpError(
      503,
      "local_skill_catalog_unavailable",
      "Local Skill catalog is unavailable",
    );
  }
  return available as LocalComputerManagement &
    Required<Pick<LocalComputerManagement, "scanLocalSkills">>;
};

const parseLocalSkillScanRequest = (value: unknown) => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "expires_at",
      "request_id",
      "runtime_type",
      "scan_id",
    ]) ||
    !isProtocolId(value.request_id) ||
    !isProtocolId(value.scan_id) ||
    (value.runtime_type !== "codex" &&
      value.runtime_type !== "claude" &&
      value.runtime_type !== "pi") ||
    !isTimestamp(value.expires_at)
  ) {
    throw new LocalComputerHttpError(
      400,
      "invalid_local_skill_scan",
      "Local Skill scan request is invalid",
    );
  }
  return value as {
    readonly request_id: string;
    readonly scan_id: string;
    readonly runtime_type: "codex" | "claude" | "pi";
    readonly expires_at: string;
  };
};

const BROWSER_PROFILE_PATTERN =
  /^(?:Default|Profile [1-9][0-9]{0,3}|Guest Profile)$/u;
const BROWSER_EXTENSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,256}$/u;

// Never include the request body in the error; it carries the token.
const parseBrowserConnectionConfigureRequest = (value: unknown) => {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => key !== "extension_token" && key !== "profile",
    ) ||
    typeof value.extension_token !== "string" ||
    !BROWSER_EXTENSION_TOKEN_PATTERN.test(value.extension_token) ||
    (value.profile !== undefined &&
      (typeof value.profile !== "string" ||
        !BROWSER_PROFILE_PATTERN.test(value.profile)))
  ) {
    throw new LocalComputerHttpError(
      400,
      "invalid_browser_connection",
      "Browser connection request is invalid",
    );
  }
  return value as {
    readonly extension_token: string;
    readonly profile?: string;
  };
};

const parseComputerPermissionAction = (
  value: unknown,
): Pick<
  LocalComputerPermissionCommand,
  "action" | "subject" | "permission"
> => {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => key !== "action" && key !== "subject" && key !== "permission",
    ) ||
    (value.action !== "prompt" &&
      value.action !== "open_settings" &&
      value.action !== "relaunch") ||
    (value.subject !== "linger" && value.subject !== "computer_use") ||
    (value.permission !== undefined &&
      value.permission !== "screen_recording" &&
      value.permission !== "accessibility") ||
    (value.action === "relaunch") !== (value.permission === undefined)
  ) {
    throw new LocalComputerHttpError(
      400,
      "invalid_computer_permission_action",
      "Computer permission action is invalid",
    );
  }
  return {
    action: value.action,
    subject: value.subject,
    ...(value.permission === undefined ? {} : { permission: value.permission }),
  };
};

const computerPermissionRequestError = (error: unknown): Error => {
  if (error instanceof LocalComputerNotFoundError) {
    return new LocalComputerHttpError(
      404,
      "local_computer_not_found",
      error.message,
    );
  }
  if (error instanceof LocalComputerOfflineError) {
    return new LocalComputerHttpError(
      503,
      "local_computer_offline",
      error.message,
    );
  }
  if (error instanceof LocalComputerCapabilityError) {
    return new LocalComputerHttpError(
      409,
      "computer_permission_capability_unavailable",
      error.message,
    );
  }
  if (error instanceof LocalComputerPermissionError) {
    return error.code === "COMPUTER_PERMISSION_TIMEOUT"
      ? new LocalComputerHttpError(503, error.code, error.message)
      : new LocalComputerHttpError(502, error.code, error.message);
  }
  return error instanceof Error
    ? error
    : new Error("Computer permission operation failed");
};

const browserConnectionRequestError = (error: unknown): Error => {
  if (error instanceof LocalComputerNotFoundError) {
    return new LocalComputerHttpError(
      404,
      "local_computer_not_found",
      error.message,
    );
  }
  if (error instanceof LocalComputerOfflineError) {
    return new LocalComputerHttpError(
      503,
      "local_computer_offline",
      error.message,
    );
  }
  if (error instanceof LocalComputerCapabilityError) {
    return new LocalComputerHttpError(
      409,
      "browser_connection_capability_unavailable",
      error.message,
    );
  }
  if (error instanceof LocalBrowserConnectionError) {
    return error.code === "BROWSER_CONNECTION_TIMEOUT"
      ? new LocalComputerHttpError(503, error.code, error.message)
      : new LocalComputerHttpError(502, error.code, error.message);
  }
  return error instanceof Error
    ? error
    : new Error("Browser connection operation failed");
};

const localSkillRequestError = (error: unknown): Error => {
  if (error instanceof LocalComputerNotFoundError) {
    return new LocalComputerHttpError(
      404,
      "local_computer_not_found",
      error.message,
    );
  }
  if (error instanceof LocalComputerOfflineError) {
    return new LocalComputerHttpError(
      503,
      "local_computer_offline",
      error.message,
    );
  }
  if (error instanceof LocalComputerCapabilityError) {
    return new LocalComputerHttpError(
      409,
      "local_skill_capability_unavailable",
      error.message,
    );
  }
  if (error instanceof LocalSkillOperationError) {
    const status: LocalComputerHttpStatus = error.code.includes("UPLOAD")
      ? 502
      : 409;
    return new LocalComputerHttpError(status, error.code, error.message);
  }
  return error instanceof Error
    ? error
    : new Error("Local Skill operation failed");
};

const methodNotAllowed = (context: Context, allow: string): never => {
  context.header("allow", allow);
  throw new LocalComputerHttpError(
    405,
    "method_not_allowed",
    "Method not allowed",
  );
};

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const isProtocolId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 64 &&
  /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value);

const isTimestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

const writeJson = (
  context: Context,
  status: 200 | 201,
  value: unknown,
): Response => {
  context.header("cache-control", "no-store");
  context.status(status);
  return context.json(value);
};
