import { type Context, Hono } from "hono";
import * as AgentManagementRoutes from "@linger/wire-contracts/node-services-internal/server";
import type {
  ByokConfigInput,
  LocalModelCustomDownloadInput,
  LocalModelCustomProbeInput,
  LocalModelCustomSearchInput,
} from "@linger/wire-contracts/runner-gateway/types";
import {
  LocalComputerBusyError,
  LocalComputerHasAgentsError,
  LocalComputerCapabilityError,
  LocalComputerNotFoundError,
  LocalComputerOfflineError,
  LocalBrowserConnectionError,
  LocalComputerPermissionError,
  LocalModelSourceError,
  LocalSkillOperationError,
  type LocalBrowserConnectionCommand,
  type LocalComputerPermissionCommand,
  type LocalComputerManagement,
  type LocalModelSourceCommand,
} from "../../runner-gateway/local-computer-management.js";
import {
  LocalModelsActionTimeoutError,
  LocalModelsCustomError,
  LocalModelsCustomUnsupportedError,
  type LocalModelActionCommand,
} from "../../runner-gateway/runner-local-models.js";
import { isRecord } from "@linger/service-kit";
import {
  isByokProtocol,
  validByokPath,
} from "@linger/service-kit/byok-endpoint";

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
  searchLocalComputerCustomModels(
    context: Context,
  ): Promise<Response> | Response;
  probeLocalComputerCustomModel(context: Context): Promise<Response> | Response;
  downloadLocalComputerCustomModel(
    context: Context,
  ): Promise<Response> | Response;
  getLocalComputerModelSource(context: Context): Promise<Response> | Response;
  applyLocalComputerModelSource(context: Context): Promise<Response> | Response;
  testLocalComputerByok(context: Context): Promise<Response> | Response;
  listLocalComputerByokModels(context: Context): Promise<Response> | Response;
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
        ...(body.force === undefined ? {} : { force: body.force }),
        ...(body.context_tokens === undefined
          ? {}
          : { contextTokens: body.context_tokens }),
        ...(body.custom_download === undefined
          ? {}
          : { customDownload: body.custom_download }),
        expiresAt: body.expires_at,
        signal: context.req.raw.signal,
      });
      return writeJson(context, 200, {
        request_id: body.request_id,
        outcome: ack.outcome,
        ...(ack.outcome === "accepted" && ack.modelId !== undefined
          ? { model_id: ack.modelId }
          : {}),
        ...(ack.outcome === "refused" ? { refusal: ack.refusal } : {}),
      });
    } catch (error) {
      throw localModelsRequestError(error);
    }
  },
  searchLocalComputerCustomModels: async (context) => {
    const management = requireLocalComputerManagement(
      options.localComputerManagement,
    );
    if (!management.searchCustomLocalModels) {
      throw new LocalComputerHttpError(
        503,
        "LOCAL_MODELS_UNAVAILABLE",
        "Custom local models are unavailable",
      );
    }
    const input = parseCustomSearchRequest(await options.readJsonBody(context));
    try {
      const result = await management.searchCustomLocalModels({
        tenantId: options.pathId(context, "tenantId"),
        ownerActorId: options.pathId(context, "ownerActorId"),
        computerId: options.pathId(context, "computerId"),
        input,
        signal: context.req.raw.signal,
      });
      return writeJson(context, 200, result);
    } catch (error) {
      throw localModelsRequestError(error);
    }
  },
  probeLocalComputerCustomModel: async (context) => {
    const management = requireLocalComputerManagement(
      options.localComputerManagement,
    );
    if (!management.probeCustomLocalModel) {
      throw new LocalComputerHttpError(
        503,
        "LOCAL_MODELS_UNAVAILABLE",
        "Custom local models are unavailable",
      );
    }
    const input = parseCustomProbeRequest(await options.readJsonBody(context));
    try {
      const result = await management.probeCustomLocalModel({
        tenantId: options.pathId(context, "tenantId"),
        ownerActorId: options.pathId(context, "ownerActorId"),
        computerId: options.pathId(context, "computerId"),
        input,
        signal: context.req.raw.signal,
      });
      return writeJson(context, 200, result);
    } catch (error) {
      throw localModelsRequestError(error);
    }
  },
  downloadLocalComputerCustomModel: async (context) => {
    const management = requireLocalComputerManagement(
      options.localComputerManagement,
    );
    if (!management.downloadCustomLocalModel) {
      throw new LocalComputerHttpError(
        503,
        "LOCAL_MODELS_UNAVAILABLE",
        "Custom local models are unavailable",
      );
    }
    const body = parseCustomDownloadCommand(
      await options.readJsonBody(context),
    );
    try {
      const ack = await management.downloadCustomLocalModel({
        tenantId: options.pathId(context, "tenantId"),
        ownerActorId: options.pathId(context, "ownerActorId"),
        computerId: options.pathId(context, "computerId"),
        customDownload: body.custom_download,
        expiresAt: body.expires_at,
        signal: context.req.raw.signal,
      });
      return writeJson(context, 200, {
        request_id: body.request_id,
        outcome: ack.outcome,
        ...(ack.outcome === "accepted" && ack.modelId !== undefined
          ? { model_id: ack.modelId }
          : {}),
        ...(ack.outcome === "refused" ? { refusal: ack.refusal } : {}),
      });
    } catch (error) {
      throw localModelsRequestError(error);
    }
  },
  getLocalComputerModelSource: async (context) => {
    const management = requireModelSourceManagement(
      options.localComputerManagement,
    );
    try {
      const { status } = await management.modelSource({
        tenantId: options.pathId(context, "tenantId"),
        ownerActorId: options.pathId(context, "ownerActorId"),
        computerId: options.pathId(context, "computerId"),
        action: "status",
        signal: context.req.raw.signal,
      });
      if (!status) {
        throw new LocalComputerHttpError(
          502,
          "MODEL_SOURCE_EMPTY",
          "Local Computer returned no model source status",
        );
      }
      return writeJson(context, 200, status);
    } catch (error) {
      throw modelSourceRequestError(error);
    }
  },
  applyLocalComputerModelSource: async (context) => {
    const management = requireModelSourceManagement(
      options.localComputerManagement,
    );
    const body = parseModelSourceApplyCommand(
      await options.readJsonBody(context),
    );
    try {
      const { status } = await management.modelSource({
        tenantId: options.pathId(context, "tenantId"),
        ownerActorId: options.pathId(context, "ownerActorId"),
        computerId: options.pathId(context, "computerId"),
        action: "apply",
        mode: body.mode,
        ...(body.runtime ? { runtime: body.runtime } : {}),
        ...(body.local_model_id ? { localModelId: body.local_model_id } : {}),
        ...(body.byok ? { byok: body.byok } : {}),
        signal: context.req.raw.signal,
      });
      if (!status) {
        throw new LocalComputerHttpError(
          502,
          "MODEL_SOURCE_EMPTY",
          "Local Computer returned no model source status",
        );
      }
      return writeJson(context, 200, status);
    } catch (error) {
      throw modelSourceRequestError(error);
    }
  },
  testLocalComputerByok: async (context) => {
    const management = requireModelSourceManagement(
      options.localComputerManagement,
    );
    const byok = parseByokTestRequest(await options.readJsonBody(context));
    try {
      const { testResult } = await management.modelSource({
        tenantId: options.pathId(context, "tenantId"),
        ownerActorId: options.pathId(context, "ownerActorId"),
        computerId: options.pathId(context, "computerId"),
        action: "test",
        byok,
        signal: context.req.raw.signal,
      });
      if (!testResult) {
        throw new LocalComputerHttpError(
          502,
          "BYOK_CHECK_EMPTY",
          "Local Computer returned no BYOK check result",
        );
      }
      return writeJson(context, 200, testResult);
    } catch (error) {
      throw modelSourceRequestError(error);
    }
  },
  listLocalComputerByokModels: async (context) => {
    const management = requireModelSourceManagement(
      options.localComputerManagement,
    );
    const byok = parseByokEndpointInput(await options.readJsonBody(context));
    try {
      const { modelList } = await management.modelSource({
        tenantId: options.pathId(context, "tenantId"),
        ownerActorId: options.pathId(context, "ownerActorId"),
        computerId: options.pathId(context, "computerId"),
        action: "models",
        byok,
        signal: context.req.raw.signal,
      });
      if (!modelList) {
        throw new LocalComputerHttpError(
          502,
          "BYOK_MODELS_EMPTY",
          "Local Computer returned no BYOK model list",
        );
      }
      return writeJson(context, 200, modelList);
    } catch (error) {
      throw modelSourceRequestError(error);
    }
  },
});

const requireModelSourceManagement = (
  management: LocalComputerManagement | undefined,
): LocalComputerManagement &
  Required<Pick<LocalComputerManagement, "modelSource">> => {
  const available = requireLocalComputerManagement(management);
  if (!available.modelSource) {
    throw new LocalComputerHttpError(
      503,
      "MODEL_SOURCE_UNAVAILABLE",
      "Model source management is unavailable",
    );
  }
  return available as LocalComputerManagement &
    Required<Pick<LocalComputerManagement, "modelSource">>;
};

const BYOK_MODEL_ID_PATTERN = /^[-a-zA-Z0-9_./:@]{1,256}$/u;

const isByokUrlPath = (value: unknown): value is string =>
  typeof value === "string" && validByokPath(value);

interface ByokAddress {
  readonly base_url: string;
  readonly path: string;
  readonly endpoint: string;
  readonly protocol: ByokConfigInput["protocol"];
}

const byokAddress = (value: Record<string, unknown>): ByokAddress | null =>
  typeof value.base_url === "string" &&
  value.base_url.trim().length > 0 &&
  value.base_url.length <= 2048 &&
  isByokUrlPath(value.path) &&
  isByokUrlPath(value.endpoint) &&
  isByokProtocol(value.protocol)
    ? {
        base_url: value.base_url.trim(),
        path: value.path,
        endpoint: value.endpoint,
        protocol: value.protocol,
      }
    : null;

const BYOK_ADDRESS_KEYS = ["base_url", "path", "endpoint", "protocol"];

// Never include the request body in the error; it carries the API key.
const parseByokInput = (value: unknown): ByokConfigInput => {
  const address = isRecord(value) ? byokAddress(value) : null;
  if (
    !isRecord(value) ||
    !address ||
    Object.keys(value).some(
      (key) =>
        ![
          ...BYOK_ADDRESS_KEYS,
          "api_key",
          "model_id",
          "context_window",
          "reuse_saved_key",
        ].includes(key),
    ) ||
    typeof value.model_id !== "string" ||
    !BYOK_MODEL_ID_PATTERN.test(value.model_id.trim()) ||
    (value.api_key !== undefined &&
      (typeof value.api_key !== "string" || value.api_key.length > 4096)) ||
    (value.context_window !== undefined &&
      (!Number.isSafeInteger(value.context_window) ||
        Number(value.context_window) < 1 ||
        Number(value.context_window) > 2_147_483_647)) ||
    (value.reuse_saved_key !== undefined &&
      typeof value.reuse_saved_key !== "boolean")
  ) {
    throw new LocalComputerHttpError(
      400,
      "BYOK_INVALID_CONFIG",
      "BYOK configuration is invalid",
    );
  }
  return {
    ...address,
    ...(value.api_key !== undefined ? { api_key: value.api_key } : {}),
    model_id: value.model_id.trim(),
    ...(value.context_window !== undefined
      ? { context_window: Number(value.context_window) }
      : {}),
    ...(value.reuse_saved_key !== undefined
      ? { reuse_saved_key: value.reuse_saved_key }
      : {}),
  };
};

// Never include the request body in the error; it carries the API key.
const parseByokEndpointInput = (value: unknown): ByokConfigInput => {
  const address = isRecord(value) ? byokAddress(value) : null;
  if (
    !isRecord(value) ||
    !address ||
    Object.keys(value).some(
      (key) =>
        ![...BYOK_ADDRESS_KEYS, "api_key", "reuse_saved_key"].includes(key),
    ) ||
    (value.api_key !== undefined &&
      (typeof value.api_key !== "string" || value.api_key.length > 4096)) ||
    (value.reuse_saved_key !== undefined &&
      typeof value.reuse_saved_key !== "boolean")
  ) {
    throw new LocalComputerHttpError(
      400,
      "BYOK_INVALID_CONFIG",
      "BYOK endpoint is invalid",
    );
  }
  return {
    ...address,
    ...(value.api_key !== undefined ? { api_key: value.api_key } : {}),
    ...(value.reuse_saved_key !== undefined
      ? { reuse_saved_key: value.reuse_saved_key }
      : {}),
  };
};

const isModelSourceRuntime = (
  value: unknown,
): value is NonNullable<LocalModelSourceCommand["runtime"]> =>
  value === "claude" || value === "codex" || value === "pi";

const parseByokTestRequest = (value: unknown): ByokConfigInput => {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "byok")) {
    throw new LocalComputerHttpError(
      400,
      "BYOK_INVALID_CONFIG",
      "BYOK configuration is invalid",
    );
  }
  return parseByokInput(value.byok);
};

interface ModelSourceApplyBody {
  readonly mode: NonNullable<LocalModelSourceCommand["mode"]>;
  readonly runtime?: LocalModelSourceCommand["runtime"];
  readonly local_model_id?: string;
  readonly byok?: ByokConfigInput;
}

const parseModelSourceApplyCommand = (value: unknown): ModelSourceApplyBody => {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["mode", "runtime", "local_model_id", "byok"].includes(key),
    ) ||
    (value.mode !== "local" &&
      value.mode !== "subscription" &&
      value.mode !== "byok") ||
    (value.runtime !== undefined && !isModelSourceRuntime(value.runtime)) ||
    (value.local_model_id !== undefined &&
      !isLocalModelId(value.local_model_id))
  ) {
    throw new LocalComputerHttpError(
      400,
      "MODEL_SOURCE_INVALID",
      "Model source command is invalid",
    );
  }
  return {
    mode: value.mode,
    ...(value.runtime !== undefined ? { runtime: value.runtime } : {}),
    ...(value.local_model_id !== undefined
      ? { local_model_id: value.local_model_id }
      : {}),
    ...(value.byok !== undefined ? { byok: parseByokInput(value.byok) } : {}),
  };
};

const modelSourceRequestError = (error: unknown): Error => {
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
      "MODEL_SOURCE_UNSUPPORTED",
      error.message,
    );
  }
  if (error instanceof LocalModelSourceError) {
    if (
      error.code === "MODEL_SOURCE_TIMEOUT" ||
      error.code === "BYOK_CHECK_TIMEOUT"
    ) {
      return new LocalComputerHttpError(503, error.code, error.message);
    }
    if (
      error.code === "BYOK_INVALID_CONFIG" ||
      error.code === "MODEL_SOURCE_INVALID" ||
      error.code === "MODEL_UNKNOWN"
    ) {
      return new LocalComputerHttpError(400, error.code, error.message);
    }
    if (
      error.code === "MODEL_SOURCE_UNSUPPORTED" ||
      error.code === "RUNTIME_NOT_ENABLED" ||
      error.code === "TOOL_NOT_INSTALLED"
    ) {
      return new LocalComputerHttpError(409, error.code, error.message);
    }
    return new LocalComputerHttpError(502, error.code, error.message);
  }
  return error instanceof Error
    ? error
    : new Error("Model source operation failed");
};

export function registerLocalComputerModelSourceRoutes(
  app: Hono,
  handlers: Pick<
    LocalComputerRouteHandlers,
    | "getLocalComputerModelSource"
    | "applyLocalComputerModelSource"
    | "testLocalComputerByok"
    | "listLocalComputerByokModels"
  >,
): void {
  const basePath =
    "/v1/tenants/:tenantId/owners/:ownerActorId/local-computers/:computerId/model-source";
  const testPath = `${basePath}/test`;
  const modelsPath = `${basePath}/models`;
  app.get(basePath, handlers.getLocalComputerModelSource);
  app.post(basePath, handlers.applyLocalComputerModelSource);
  app.all(basePath, (context) => methodNotAllowed(context, "GET, POST"));
  app.post(testPath, handlers.testLocalComputerByok);
  app.all(testPath, (context) => methodNotAllowed(context, "POST"));
  app.post(modelsPath, handlers.listLocalComputerByokModels);
  app.all(modelsPath, (context) => methodNotAllowed(context, "POST"));
}

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
 * Mounts the local-models action and custom hub routes next to the generated
 * Agent management routes, which do not own these paths yet.
 */
export const registerLocalComputerModelRoutes = (
  app: Hono,
  handlers: Pick<
    LocalComputerRouteHandlers,
    | "actOnLocalComputerModels"
    | "searchLocalComputerCustomModels"
    | "probeLocalComputerCustomModel"
    | "downloadLocalComputerCustomModel"
  >,
): void => {
  const basePath =
    "/v1/tenants/:tenantId/owners/:ownerActorId/local-computers/:computerId";
  const actionPath = `${basePath}/local-model-actions`;
  const searchPath = `${basePath}/local-models/custom/search`;
  const probePath = `${basePath}/local-models/custom/probe`;
  const downloadPath = `${basePath}/local-models/custom/download`;
  app.post(actionPath, handlers.actOnLocalComputerModels);
  app.all(actionPath, (context) => methodNotAllowed(context, "POST"));
  app.post(searchPath, handlers.searchLocalComputerCustomModels);
  app.all(searchPath, (context) => methodNotAllowed(context, "POST"));
  app.post(probePath, handlers.probeLocalComputerCustomModel);
  app.all(probePath, (context) => methodNotAllowed(context, "POST"));
  app.post(downloadPath, handlers.downloadLocalComputerCustomModel);
  app.all(downloadPath, (context) => methodNotAllowed(context, "POST"));
};

const LOCAL_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const LOCAL_MODEL_ACTIONS: ReadonlySet<unknown> = new Set([
  "download",
  "cancel",
  "load",
  "unload",
  "remove",
  "refresh",
  "smoke_test",
  "custom_download",
]);

const isLocalModelId = (value: unknown): value is string =>
  typeof value === "string" && LOCAL_MODEL_ID_PATTERN.test(value);

const isCustomHub = (value: unknown): value is "huggingface" | "modelscope" =>
  value === "huggingface" || value === "modelscope";

// Never include the request body in validation errors; custom payloads may carry a hub token.
const parseCustomDownloadInput = (
  value: unknown,
): LocalModelCustomDownloadInput => {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "hub",
          "repo_id",
          "revision",
          "variant_id",
          "files",
          "mmproj",
          "force_memory",
          "replace",
          "token",
        ].includes(key),
    ) ||
    !isCustomHub(value.hub) ||
    typeof value.repo_id !== "string" ||
    value.repo_id.trim().length === 0 ||
    value.repo_id.length > 256 ||
    typeof value.variant_id !== "string" ||
    value.variant_id.trim().length === 0 ||
    value.variant_id.length > 128 ||
    (value.revision !== undefined &&
      (typeof value.revision !== "string" ||
        value.revision.trim().length === 0 ||
        value.revision.length > 128)) ||
    (value.files !== undefined &&
      (!Array.isArray(value.files) ||
        value.files.length > 256 ||
        !value.files.every(
          (item) =>
            typeof item === "string" &&
            item.trim().length > 0 &&
            item.length <= 512,
        ))) ||
    (value.mmproj !== undefined &&
      (typeof value.mmproj !== "string" ||
        value.mmproj.trim().length === 0 ||
        value.mmproj.length > 512)) ||
    (value.force_memory !== undefined &&
      typeof value.force_memory !== "boolean") ||
    (value.replace !== undefined && typeof value.replace !== "boolean") ||
    (value.token !== undefined &&
      (typeof value.token !== "string" || value.token.length > 4096))
  ) {
    throw new LocalComputerHttpError(
      400,
      "INVALID_LOCAL_MODEL_ACTION",
      "Custom model download input is invalid",
    );
  }
  return {
    hub: value.hub,
    repo_id: value.repo_id.trim(),
    variant_id: value.variant_id.trim(),
    ...(value.revision !== undefined
      ? { revision: value.revision.trim() }
      : {}),
    ...(value.files !== undefined ? { files: value.files as string[] } : {}),
    ...(value.mmproj !== undefined ? { mmproj: value.mmproj.trim() } : {}),
    ...(value.force_memory !== undefined
      ? { force_memory: value.force_memory }
      : {}),
    ...(value.replace !== undefined ? { replace: value.replace } : {}),
    ...(value.token !== undefined ? { token: value.token } : {}),
  };
};

// Never include the request body in validation errors; it may carry a hub token.
const parseCustomSearchRequest = (
  value: unknown,
): LocalModelCustomSearchInput => {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["hub", "query", "format", "limit", "token"].includes(key),
    ) ||
    (value.hub !== undefined &&
      value.hub !== "all" &&
      value.hub !== "huggingface" &&
      value.hub !== "modelscope") ||
    (value.query !== undefined &&
      (typeof value.query !== "string" || value.query.length > 256)) ||
    (value.format !== undefined &&
      value.format !== "compatible" &&
      value.format !== "gguf" &&
      value.format !== "mlx" &&
      value.format !== "all") ||
    (value.limit !== undefined &&
      (!Number.isSafeInteger(value.limit) ||
        Number(value.limit) < 1 ||
        Number(value.limit) > 50)) ||
    (value.token !== undefined &&
      (typeof value.token !== "string" || value.token.length > 4096))
  ) {
    throw new LocalComputerHttpError(
      400,
      "INVALID_REPO_SPEC",
      "Custom model search request is invalid",
    );
  }
  return {
    ...(value.hub !== undefined ? { hub: value.hub } : {}),
    ...(value.query !== undefined ? { query: value.query } : {}),
    ...(value.format !== undefined ? { format: value.format } : {}),
    ...(value.limit !== undefined ? { limit: Number(value.limit) } : {}),
    ...(value.token !== undefined ? { token: value.token } : {}),
  };
};

// Never include the request body in validation errors; it may carry a hub token.
const parseCustomProbeRequest = (
  value: unknown,
): LocalModelCustomProbeInput => {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        !["target", "hub", "revision", "file_name", "token"].includes(key),
    ) ||
    typeof value.target !== "string" ||
    value.target.trim().length === 0 ||
    value.target.length > 2048 ||
    (value.hub !== undefined &&
      value.hub !== "auto" &&
      value.hub !== "huggingface" &&
      value.hub !== "modelscope") ||
    (value.revision !== undefined &&
      (typeof value.revision !== "string" ||
        value.revision.trim().length === 0 ||
        value.revision.length > 128)) ||
    (value.file_name !== undefined &&
      (typeof value.file_name !== "string" ||
        value.file_name.trim().length === 0 ||
        value.file_name.length > 512)) ||
    (value.token !== undefined &&
      (typeof value.token !== "string" || value.token.length > 4096))
  ) {
    throw new LocalComputerHttpError(
      400,
      "INVALID_REPO_SPEC",
      "Custom model probe request is invalid",
    );
  }
  return {
    target: value.target.trim(),
    ...(value.hub !== undefined ? { hub: value.hub } : {}),
    ...(value.revision !== undefined
      ? { revision: value.revision.trim() }
      : {}),
    ...(value.file_name !== undefined
      ? { file_name: value.file_name.trim() }
      : {}),
    ...(value.token !== undefined ? { token: value.token } : {}),
  };
};

const parseCustomDownloadCommand = (value: unknown) => {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["request_id", "expires_at", "custom_download"].includes(key),
    ) ||
    !isProtocolId(value.request_id) ||
    !isTimestamp(value.expires_at)
  ) {
    throw new LocalComputerHttpError(
      400,
      "INVALID_LOCAL_MODEL_ACTION",
      "Custom model download command is invalid",
    );
  }
  return {
    request_id: value.request_id,
    expires_at: value.expires_at,
    custom_download: parseCustomDownloadInput(value.custom_download),
  };
};

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
          "force",
          "context_tokens",
          "custom_download",
          "expires_at",
        ].includes(key),
    ) ||
    !isProtocolId(value.request_id) ||
    !LOCAL_MODEL_ACTIONS.has(value.action) ||
    !isTimestamp(value.expires_at)
  ) {
    throw new LocalComputerHttpError(
      400,
      "INVALID_LOCAL_MODEL_ACTION",
      "Local model action is invalid",
    );
  }
  const action = value.action as LocalModelActionCommand["action"];
  const needsNoModelId = action === "refresh" || action === "custom_download";
  if (
    needsNoModelId !== (value.model_id === undefined) ||
    (value.model_id !== undefined && !isLocalModelId(value.model_id)) ||
    (unloadFirst !== undefined &&
      (action !== "load" ||
        !Array.isArray(unloadFirst) ||
        unloadFirst.length > 64 ||
        !unloadFirst.every(isLocalModelId) ||
        new Set(unloadFirst).size !== unloadFirst.length)) ||
    (value.force !== undefined &&
      (action !== "load" || typeof value.force !== "boolean")) ||
    (value.context_tokens !== undefined &&
      ((action !== "load" && action !== "smoke_test") ||
        !Number.isSafeInteger(value.context_tokens) ||
        (action === "smoke_test"
          ? value.context_tokens !== 2048 && value.context_tokens !== 4096
          : Number(value.context_tokens) < 512 ||
            Number(value.context_tokens) > 1_048_576))) ||
    (action === "custom_download") !== (value.custom_download !== undefined)
  ) {
    throw new LocalComputerHttpError(
      400,
      "INVALID_LOCAL_MODEL_ACTION",
      "Local model action is invalid",
    );
  }
  return {
    request_id: value.request_id,
    action,
    ...(value.model_id !== undefined ? { model_id: value.model_id } : {}),
    ...(unloadFirst !== undefined
      ? { unload_first: unloadFirst as readonly string[] }
      : {}),
    ...(value.force !== undefined ? { force: value.force } : {}),
    ...(value.context_tokens !== undefined
      ? { context_tokens: Number(value.context_tokens) }
      : {}),
    ...(value.custom_download !== undefined
      ? { custom_download: parseCustomDownloadInput(value.custom_download) }
      : {}),
    expires_at: value.expires_at,
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
  if (error instanceof LocalModelsCustomUnsupportedError) {
    return new LocalComputerHttpError(
      409,
      "LOCAL_MODELS_CUSTOM_UNSUPPORTED",
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
  if (error instanceof LocalModelsCustomError) {
    if (error.code === "INVALID_REPO_SPEC") {
      return new LocalComputerHttpError(400, error.code, error.message);
    }
    if (
      error.code === "TOOL_NOT_INSTALLED" ||
      error.code === "LOCAL_MODELS_CUSTOM_UNSUPPORTED"
    ) {
      return new LocalComputerHttpError(409, error.code, error.message);
    }
    if (error.code === "LOCAL_MODELS_CUSTOM_EXPIRED") {
      return new LocalComputerHttpError(503, error.code, error.message);
    }
    return new LocalComputerHttpError(502, error.code, error.message);
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
