import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import {
  isByokProtocol,
  validByokPath,
  type ByokProtocol,
} from "@linger/service-kit/byok-endpoint";
import { atomicPrivate, readPrivate } from "./instance.js";
import {
  localmodelsBaseDirectory,
  localmodelsStateDirectory,
  runLocalmodels,
} from "./localmodels-tool.js";
import {
  prepareRuntime,
  type NativeRuntime,
  type RuntimeDescriptor,
} from "./managed-runtimes.js";
import type { InstallOutcome, InstallerEvent } from "./events.js";

export type { ByokProtocol };

/**
 * Requests go to baseUrl + path + endpoint in protocol, and models are listed
 * at baseUrl + path + /models.
 */
export interface ByokEndpoint {
  baseUrl: string;
  path: string;
  endpoint: string;
  protocol: ByokProtocol;
  apiKey?: string;
}

export interface ByokConfiguration extends ByokEndpoint {
  modelId: string;
  contextWindow?: number;
  runtime?: NativeRuntime;
}

export interface ByokCheckOutcome {
  ok: true;
  protocol: ByokProtocol;
  url: string;
  modelId: string;
  contextWindow: number;
}

export interface ByokModelListing {
  url: string;
  models: { id: string; name?: string; contextWindow?: number }[];
}

const NATIVE_RUNTIMES: readonly NativeRuntime[] = ["claude", "codex", "pi"];

interface StoredModelSource {
  schema: "localmodels.model-source/v1";
  mode: "local" | "subscription" | "byok";
  runtime: NativeRuntime;
  runtime_model: string;
  model_label: string | null;
  gateway_url: string | null;
  environment: Record<string, string>;
  runtime_paths?: Partial<Record<NativeRuntime, string>>;
}

const PRIVATE_HOST_IPV4 =
  /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})$/;

export function isAllowedByokUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return false;
    const host = url.hostname.toLowerCase().replace(/^\[\s*|\s*\]$/g, "");
    if (
      host === "0.0.0.0" ||
      host === "::" ||
      host === "metadata.google.internal" ||
      host.startsWith("169.254.") ||
      host.startsWith("fe80:")
    )
      return false;
    if (url.protocol === "https:") return true;
    return (
      host === "localhost" ||
      host === "::1" ||
      host.endsWith(".local") ||
      !host.includes(".") ||
      PRIVATE_HOST_IPV4.test(host)
    );
  } catch {
    return false;
  }
}

function byokRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid BYOK configuration.");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (!keys.includes(key)) throw new Error("Invalid BYOK configuration.");
  return record;
}

function byokEndpointFields(record: Record<string, unknown>): ByokEndpoint {
  if (
    typeof record.baseUrl !== "string" ||
    record.baseUrl.length > 2048 ||
    !isAllowedByokUrl(record.baseUrl)
  )
    throw new Error(
      "Endpoint URL must use HTTPS, or HTTP on localhost / a private network.",
    );
  for (const [label, value] of [
    ["Path", record.path],
    ["Endpoint", record.endpoint],
  ] as const)
    if (typeof value !== "string" || !validByokPath(value))
      throw new Error(`${label} must be empty or a path such as /v1.`);
  if (!isByokProtocol(record.protocol))
    throw new Error("Invalid BYOK wire format.");
  const apiKey = record.apiKey;
  if (
    apiKey !== undefined &&
    (typeof apiKey !== "string" ||
      apiKey.length > 4096 ||
      [...apiKey].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127))
  )
    throw new Error("API key format is invalid.");
  return {
    baseUrl: record.baseUrl.trim().replace(/\/+$/, ""),
    path: record.path as string,
    endpoint: record.endpoint as string,
    protocol: record.protocol,
    ...(apiKey !== undefined ? { apiKey } : {}),
  };
}

const BYOK_ENDPOINT_KEYS = [
  "baseUrl",
  "path",
  "endpoint",
  "protocol",
  "apiKey",
] as const;

export function validateByokEndpoint(value: unknown): ByokEndpoint {
  return byokEndpointFields(byokRecord(value, BYOK_ENDPOINT_KEYS));
}

export function validateByokConfiguration(value: unknown): ByokConfiguration {
  const record = byokRecord(value, [
    ...BYOK_ENDPOINT_KEYS,
    "modelId",
    "contextWindow",
    "runtime",
  ]);
  const endpoint = byokEndpointFields(record);
  if (
    typeof record.modelId !== "string" ||
    !/^[-a-zA-Z0-9_./:@]{1,256}$/.test(record.modelId.trim())
  )
    throw new Error("Model ID is invalid.");
  const contextWindow = record.contextWindow;
  if (
    contextWindow !== undefined &&
    (!Number.isSafeInteger(contextWindow) ||
      Number(contextWindow) < 1 ||
      Number(contextWindow) > 2_147_483_647)
  )
    throw new Error("Context window must be a positive integer.");
  const runtime = record.runtime;
  if (
    runtime !== undefined &&
    runtime !== "claude" &&
    runtime !== "codex" &&
    runtime !== "pi"
  )
    throw new Error("Invalid BYOK runtime selection.");
  return {
    ...endpoint,
    modelId: record.modelId.trim(),
    ...(contextWindow !== undefined
      ? { contextWindow: Number(contextWindow) }
      : {}),
    ...(runtime !== undefined ? { runtime } : {}),
  };
}

// The API key travels on stdin, never in argv. An empty path or endpoint is
// sent too: it appends nothing, which localmodels tells apart from a missing
// field.
function byokStdin(config: ByokEndpoint & Partial<ByokConfiguration>): string {
  return JSON.stringify({
    baseUrl: config.baseUrl,
    path: config.path,
    endpoint: config.endpoint,
    protocol: config.protocol,
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    ...(config.modelId !== undefined ? { modelId: config.modelId } : {}),
    ...(config.contextWindow !== undefined
      ? { contextWindow: config.contextWindow }
      : {}),
  });
}

function endpointFailure(
  parsed: Record<string, unknown> | undefined,
  fallback: string,
  fallbackCode: string,
): Error {
  const message =
    typeof parsed?.message === "string" && parsed.message
      ? parsed.message
      : fallback;
  const code = typeof parsed?.code === "string" ? parsed.code : fallbackCode;
  return Object.assign(new Error(message), { code });
}

/**
 * Extracts the final top-level JSON object from stdout, handling sequential
 * mixes of JSONL progress lines and pretty-printed multi-line JSON objects.
 */
export function lastJsonObject(
  stdout: string,
): Record<string, unknown> | undefined {
  let last: Record<string, unknown> | undefined;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let retries = 0;
  for (let i = 0; i < stdout.length; i += 1) {
    const ch = stdout[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      if (depth > 0) inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          const parsed = JSON.parse(stdout.slice(start, i + 1)) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            last = parsed as Record<string, unknown>;
          }
        } catch {
          if (retries < 64) {
            retries += 1;
            i = start;
          }
        }
        start = -1;
      }
    }
    if (i === stdout.length - 1 && depth > 0 && start >= 0 && retries < 64) {
      retries += 1;
      i = start;
      depth = 0;
      start = -1;
      inString = false;
      escaped = false;
    }
  }
  return last;
}

function parseToolJson(stdout: string): Record<string, unknown> | undefined {
  return lastJsonObject(stdout);
}

/** Sends one request to the endpoint's address from this computer. */
export async function checkByokEndpoint(
  home: string,
  config: ByokConfiguration,
  signal: AbortSignal,
  dependencies: { localmodels?: typeof runLocalmodels } = {},
): Promise<ByokCheckOutcome> {
  const validated = validateByokConfiguration(config);
  signal.throwIfAborted();
  const result = await (dependencies.localmodels ?? runLocalmodels)(
    home,
    ["source", "check", "--config-stdin", "--json"],
    { signal, timeoutMs: 45_000, input: byokStdin(validated) },
  );
  const parsed = parseToolJson(result.stdout);
  if (
    result.code !== 0 ||
    parsed?.ok !== true ||
    !isByokProtocol(parsed.protocol) ||
    typeof parsed.url !== "string"
  )
    throw endpointFailure(
      parsed,
      "Could not verify the BYOK endpoint. Check the URL, API key, model ID and network.",
      "BYOK_CHECK_FAILED",
    );
  return {
    ok: true,
    protocol: parsed.protocol,
    url: parsed.url,
    modelId:
      typeof parsed.model_id === "string" ? parsed.model_id : validated.modelId,
    contextWindow:
      typeof parsed.context_window === "number" && parsed.context_window > 0
        ? parsed.context_window
        : (validated.contextWindow ?? 131_072),
  };
}

/** Lists the models the endpoint serves at baseUrl + path + /models. */
export async function listByokModels(
  home: string,
  endpoint: ByokEndpoint,
  signal: AbortSignal,
  dependencies: { localmodels?: typeof runLocalmodels } = {},
): Promise<ByokModelListing> {
  const validated = validateByokEndpoint(endpoint);
  signal.throwIfAborted();
  const result = await (dependencies.localmodels ?? runLocalmodels)(
    home,
    ["source", "models", "--config-stdin", "--json"],
    { signal, timeoutMs: 30_000, input: byokStdin(validated) },
  );
  const parsed = parseToolJson(result.stdout);
  if (
    result.code !== 0 ||
    parsed?.ok !== true ||
    typeof parsed.url !== "string" ||
    !Array.isArray(parsed.models)
  )
    throw endpointFailure(
      parsed,
      "Could not list the endpoint's models. Check the URL, API key and network.",
      "BYOK_MODELS_FAILED",
    );
  const models: ByokModelListing["models"] = [];
  for (const row of parsed.models as unknown[]) {
    if (!row || typeof row !== "object") continue;
    const { id, name, context_window } = row as Record<string, unknown>;
    if (typeof id !== "string" || !id) continue;
    models.push({
      id,
      ...(typeof name === "string" && name ? { name } : {}),
      ...(typeof context_window === "number" && context_window > 0
        ? { contextWindow: context_window }
        : {}),
    });
  }
  return { url: parsed.url, models };
}

// The kit's longest silent span is a BYOK apply with Bifrost already
// installed: the endpoint probe (up to about 35 s) and then Bifrost's health
// wait (up to 180 s), with no output between them. A download may run longer
// than any wall clock, so a source apply that still reports progress is never
// cut off.
const SOURCE_APPLY_IDLE_TIMEOUT_MS = 240_000;

function modelSourceStateFile(home: string): string {
  return path.join(localmodelsStateDirectory(home), "model-source.json");
}

function harnessRootDirectory(home: string): string {
  return path.join(path.resolve(home), "runtime", "harness");
}

async function isExecutableFile(
  candidate: unknown,
): Promise<string | undefined> {
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) return undefined;
  try {
    const info = await stat(trimmed);
    if (!info.isFile()) return undefined;
    if (process.platform !== "win32") {
      if ((info.mode & 0o111) === 0) return undefined;
      await access(trimmed, constants.X_OK);
    }
    return path.normalize(trimmed);
  } catch {
    return undefined;
  }
}

async function extractValidRuntimePaths(
  source: unknown,
): Promise<Partial<Record<NativeRuntime, string>>> {
  const paths: Partial<Record<NativeRuntime, string>> = {};
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return paths;
  }
  const record = source as Record<string, unknown>;
  for (const rt of NATIVE_RUNTIMES) {
    const valid = await isExecutableFile(record[rt]);
    if (valid) paths[rt] = valid;
  }
  return paths;
}

function isPathWithin(prefix: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(prefix), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function sameRuntimePaths(
  existing: unknown,
  next: Partial<Record<NativeRuntime, string>>,
): boolean {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    return Object.keys(next).length === 0;
  }
  const existingRecord = existing as Record<string, unknown>;
  const existingKeys = Object.keys(existingRecord);
  const nextKeys = Object.keys(next) as NativeRuntime[];
  return (
    existingKeys.length === nextKeys.length &&
    nextKeys.every((key) => existingRecord[key] === next[key])
  );
}

async function readPreviousRuntimePaths(
  stateFile: string,
): Promise<Partial<Record<NativeRuntime, string>>> {
  try {
    const raw = await readPrivate(stateFile);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return await extractValidRuntimePaths(
      (parsed as Record<string, unknown>).runtime_paths,
    );
  } catch {
    return {};
  }
}

async function persistAppliedRuntimePaths(
  home: string,
  stateFile: string,
  stdout: string,
  previousPaths: Partial<Record<NativeRuntime, string>>,
  descriptor?: RuntimeDescriptor,
): Promise<void> {
  let raw: string | undefined;
  try {
    raw = await readPrivate(stateFile);
  } catch {
    return;
  }
  if (!raw) return;
  let doc: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    doc = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  const harnessRoot = harnessRootDirectory(home);
  const outsideHarness = (exe: string | undefined): string | undefined =>
    exe && !isPathWithin(harnessRoot, exe) ? exe : undefined;
  const existingPaths = await extractValidRuntimePaths(doc.runtime_paths);
  const stdoutDoc = lastJsonObject(stdout);
  const stdoutPaths = await extractValidRuntimePaths(stdoutDoc?.runtime_paths);
  const descriptorPaths =
    descriptor?.installed &&
    descriptor.executable &&
    descriptor.argvPrefix.length === 0
      ? await extractValidRuntimePaths({
          [descriptor.runtime]: descriptor.executable,
        })
      : {};
  const merged: Partial<Record<NativeRuntime, string>> = {};
  for (const rt of NATIVE_RUNTIMES) {
    if (stdoutPaths[rt]) {
      merged[rt] = stdoutPaths[rt];
    } else if (descriptorPaths[rt]) {
      const nonHarnessDescriptor = outsideHarness(descriptorPaths[rt]);
      if (nonHarnessDescriptor) merged[rt] = nonHarnessDescriptor;
    } else {
      const chosen =
        outsideHarness(existingPaths[rt]) ?? outsideHarness(previousPaths[rt]);
      if (chosen) merged[rt] = chosen;
    }
  }
  if (Object.keys(merged).length === 0) {
    if (!("runtime_paths" in doc)) return;
    delete doc.runtime_paths;
  } else {
    if (sameRuntimePaths(doc.runtime_paths, merged)) return;
    doc.runtime_paths = merged;
  }
  await atomicPrivate(stateFile, `${JSON.stringify(doc, null, 2)}\n`);
}

// The installer switches the source through localmodels, as the Computer
// does from Settings, so model-source.json has one primary writer. Because
// localmodels omits runtime_paths when rewriting model-source.json, merge back
// valid non-harness executables alongside any stdout or non-harness descriptor
// paths and leave harness scanning to the Daemon's OverlayRuntimePaths.
async function applySource(
  home: string,
  mode: "local" | "subscription" | "byok",
  runtime: NativeRuntime,
  options: {
    signal: AbortSignal;
    model?: string;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    input?: string;
    onEvent?: (event: InstallerEvent) => void;
    descriptor?: RuntimeDescriptor;
  },
  localmodels: typeof runLocalmodels,
) {
  const stateFile = modelSourceStateFile(home);
  const previousPaths = await readPreviousRuntimePaths(stateFile);
  const result = await localmodels(
    home,
    [
      "source",
      "apply",
      "--mode",
      mode,
      "--runtime",
      runtime,
      ...(options.model ? ["--model", options.model] : []),
      "--base-dir",
      localmodelsBaseDirectory(home),
      "--harness-root",
      harnessRootDirectory(home),
      "--node",
      process.execPath,
      ...(options.input === undefined ? [] : ["--config-stdin"]),
      "--json",
    ],
    {
      signal: options.signal,
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      ...(options.idleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: options.idleTimeoutMs }),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.input === undefined ? {} : { input: options.input }),
    },
  );
  if (result.code === 0) {
    options.signal.throwIfAborted();
    await persistAppliedRuntimePaths(
      home,
      stateFile,
      result.stdout,
      previousPaths,
      options.descriptor,
    );
  }
  return result;
}

const SOURCE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function sourceApplyFailure(
  stdout: string,
  message: string,
  code: string,
): InstallOutcome {
  let detail = message;
  let detailCode = code;
  const errDoc = lastJsonObject(stdout);
  if (typeof errDoc?.message === "string" && errDoc.message)
    detail = errDoc.message;
  if (
    typeof errDoc?.code === "string" &&
    SOURCE_ERROR_CODE_PATTERN.test(errDoc.code)
  )
    detailCode = errDoc.code;
  return {
    code: 1,
    state: "failed",
    message: detail,
    details: { code: detailCode },
  };
}

/**
 * Installs the runtime a BYOK source drives. BYOK needs no runtime sign-in,
 * so a pending one is not a failure. Returns the outcome only on failure.
 */
export async function prepareByokNativeRuntime(
  runtime: NativeRuntime,
  options: {
    home: string;
    signal: AbortSignal;
    onEvent: (event: InstallerEvent) => void;
    env?: NodeJS.ProcessEnv;
    reuseInstalled?: boolean;
    onDescriptor?: (descriptor: RuntimeDescriptor) => void;
  },
  dependencies: {
    localmodels?: typeof runLocalmodels;
    prepareNative?: typeof prepareRuntime;
  } = {},
): Promise<InstallOutcome | undefined> {
  const outcome = await (dependencies.prepareNative ?? prepareRuntime)(
    runtime,
    {
      home: options.home,
      signal: options.signal,
      onEvent: options.onEvent,
      env: options.env,
      ...(options.reuseInstalled ? { reuseInstalled: true } : {}),
      ...(options.onDescriptor ? { onDescriptor: options.onDescriptor } : {}),
    },
    dependencies.localmodels ? { localmodels: dependencies.localmodels } : {},
  );
  return outcome.code === 0 ||
    (outcome.details as { code?: string } | undefined)?.code ===
      "RUNTIME_AUTH_REQUIRED"
    ? undefined
    : outcome;
}

export async function prepareByokRuntime(
  config: ByokConfiguration,
  options: {
    home: string;
    signal: AbortSignal;
    onEvent: (event: InstallerEvent) => void;
    env?: NodeJS.ProcessEnv;
    onDescriptor?: (descriptor: RuntimeDescriptor) => void;
  },
  dependencies: {
    localmodels?: typeof runLocalmodels;
    prepareNative?: typeof prepareRuntime;
  } = {},
): Promise<InstallOutcome> {
  const validated = validateByokConfiguration(config);
  const runtime = validated.runtime ?? "claude";
  let preparedDescriptor: RuntimeDescriptor | undefined;
  const nativeFailure = await prepareByokNativeRuntime(
    runtime,
    {
      ...options,
      onDescriptor: (descriptor) => {
        preparedDescriptor = descriptor;
        options.onDescriptor?.(descriptor);
      },
    },
    dependencies,
  );
  if (nativeFailure) return nativeFailure;

  options.onEvent({
    kind: "stage",
    stage: "runtime",
    state: "running",
    message: "Mounting BYOK endpoint on local Bifrost gateway…",
  });
  const startedAt = Date.now();
  // A log line, not a stage event: the job appends and persists every stage
  // event, and other stages may run concurrently with this one.
  const heartbeat = setInterval(() => {
    options.onEvent({
      kind: "log",
      stage: "runtime",
      message: `Local BYOK model gateway is starting (${Math.floor((Date.now() - startedAt) / 1000)}s elapsed).\n`,
    });
  }, 10_000);
  heartbeat.unref?.();
  let result;
  try {
    result = await applySource(
      options.home,
      "byok",
      runtime,
      {
        signal: options.signal,
        idleTimeoutMs: SOURCE_APPLY_IDLE_TIMEOUT_MS,
        input: byokStdin(validated),
        onEvent: options.onEvent,
        ...(preparedDescriptor ? { descriptor: preparedDescriptor } : {}),
      },
      dependencies.localmodels ?? runLocalmodels,
    );
  } finally {
    clearInterval(heartbeat);
  }
  if (result.code !== 0)
    return sourceApplyFailure(
      result.stdout,
      "BYOK gateway configuration failed. Check the endpoint settings and retry.",
      "BYOK_GATEWAY_FAILED",
    );
  options.onEvent({
    kind: "stage",
    stage: "runtime",
    state: "succeeded",
    message: "BYOK gateway and runtime profiles are ready.",
  });
  return {
    code: 0,
    state: "ready",
    message: "BYOK gateway and runtime profiles are ready.",
  };
}

/**
 * Makes a local-model or subscription setup the Computer's model source, which
 * also ends a BYOK source left from an earlier setup. Returns a failed outcome
 * when localmodels refuses.
 */
export async function applyNativeSource(
  home: string,
  mode: "local" | "subscription",
  runtime: NativeRuntime,
  options: {
    signal: AbortSignal;
    model?: string;
    onEvent?: (event: InstallerEvent) => void;
  },
  dependencies: { localmodels?: typeof runLocalmodels } = {},
): Promise<InstallOutcome | undefined> {
  const result = await applySource(
    home,
    mode,
    runtime,
    {
      signal: options.signal,
      idleTimeoutMs: SOURCE_APPLY_IDLE_TIMEOUT_MS,
      ...(options.model ? { model: options.model } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    },
    dependencies.localmodels ?? runLocalmodels,
  );
  return result.code === 0
    ? undefined
    : sourceApplyFailure(
        result.stdout,
        "Could not set the model source. Retry setup.",
        "MODEL_SOURCE_FAILED",
      );
}

export async function readByokEnvironment(home: string): Promise<
  | {
      mode: "local" | "subscription" | "byok";
      runtime: NativeRuntime;
      runtimeModel: string;
      environment: Record<string, string>;
      gatewayUrl: string | undefined;
    }
  | undefined
> {
  try {
    const raw = await readPrivate(
      path.join(localmodelsStateDirectory(home), "model-source.json"),
    );
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<StoredModelSource>;
    if (
      parsed.schema !== "localmodels.model-source/v1" ||
      !parsed.mode ||
      !["local", "subscription", "byok"].includes(parsed.mode) ||
      !parsed.runtime ||
      !["claude", "codex", "pi"].includes(parsed.runtime)
    )
      return undefined;
    const environment: Record<string, string> = {};
    if (parsed.environment && typeof parsed.environment === "object") {
      for (const key of [
        "CODEX_HOME",
        "CLAUDE_CONFIG_DIR",
        "PI_CODING_AGENT_DIR",
      ]) {
        const val = parsed.environment[key];
        if (typeof val === "string" && path.isAbsolute(val))
          environment[key] = val;
      }
    }
    return {
      mode: parsed.mode,
      runtime: parsed.runtime,
      runtimeModel:
        typeof parsed.runtime_model === "string" ? parsed.runtime_model : "",
      environment,
      gatewayUrl: loopbackGatewayUrl(parsed.gateway_url),
    };
  } catch {
    return undefined;
  }
}

// Only a loopback gateway is probed, so a tampered state file cannot point
// the resume's health check at another host.
function loopbackGatewayUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "http:" ||
      (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

async function gatewayAnswers(
  gatewayUrl: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${gatewayUrl}/health`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
      redirect: "error",
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

/** Why a saved BYOK source's gateway could not be mounted again. */
export interface ByokGatewayFailure {
  code: string;
  message: string;
}

/**
 * Mounts a saved BYOK source on Bifrost again from the configuration
 * localmodels saved, so the key never passes through Node, unless its
 * loopback gateway already answers. The caller holds the local model lock,
 * so a quit-time stop cannot take the gateway down between the check and
 * the decision. Returns why it failed, without throwing, except for the
 * caller's abort.
 */
export async function mountSavedByokSource(
  home: string,
  source: { runtime: NativeRuntime; gatewayUrl: string | undefined },
  options: { signal: AbortSignal; onEvent: (event: InstallerEvent) => void },
  dependencies: {
    localmodels?: typeof runLocalmodels;
    fetch?: typeof fetch;
  } = {},
): Promise<ByokGatewayFailure | undefined> {
  if (
    source.gatewayUrl &&
    (await gatewayAnswers(
      source.gatewayUrl,
      options.signal,
      dependencies.fetch ?? fetch,
    ))
  )
    return undefined;
  options.signal.throwIfAborted();
  options.onEvent({
    kind: "stage",
    stage: "runtime",
    state: "running",
    message: "Mounting the saved BYOK endpoint on the local Bifrost gateway…",
  });
  const fallback = "The BYOK gateway did not start.";
  let failure: InstallOutcome | undefined;
  try {
    // The kit's apply probes the endpoint once (up to about 35 s) before
    // Bifrost starts.
    const result = await applySource(
      home,
      "byok",
      source.runtime,
      { signal: options.signal, timeoutMs: 90_000, onEvent: options.onEvent },
      dependencies.localmodels ?? runLocalmodels,
    );
    if (result.code !== 0)
      failure = sourceApplyFailure(
        result.stdout,
        fallback,
        "BYOK_GATEWAY_FAILED",
      );
  } catch (error) {
    options.signal.throwIfAborted();
    failure = sourceApplyFailure(
      "",
      error instanceof Error && error.message ? error.message : fallback,
      "BYOK_GATEWAY_FAILED",
    );
  }
  if (!failure) {
    options.onEvent({
      kind: "stage",
      stage: "runtime",
      state: "succeeded",
      message: "BYOK gateway is ready.",
    });
    return undefined;
  }
  return {
    code:
      (failure.details as { code?: string } | undefined)?.code ??
      "BYOK_GATEWAY_FAILED",
    message: failure.message,
  };
}
