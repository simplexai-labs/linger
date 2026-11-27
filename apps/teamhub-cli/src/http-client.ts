import { randomUUID } from "node:crypto";
import createClient, { type Client } from "openapi-fetch";
import type { paths } from "@linger/wire-contracts/teamhub-agent-api/types";
import type { TeamHubConfig } from "./config.js";
import { CliError, type ErrorCode } from "./errors.js";
import { mebibytes } from "./input-issues.js";
import type { CliTiming, TimingFields } from "./timing.js";

/** The TeamHub Agent API, typed by the generated contract `paths`. */
export type TeamHubApi = Client<paths>;
export type TeamHubApiPath = keyof paths;
export type TeamHubApiPostPath = {
  [Path in TeamHubApiPath]: paths[Path] extends { post: object } ? Path : never;
}[TeamHubApiPath];

export interface TeamHubHttpClient {
  readonly config: TeamHubConfig;
  /** JSON calls; a non-2xx response or an unreadable body throws CliError. */
  readonly api: TeamHubApi;
  /** Byte transfers and the anonymous shared-link read the contract client does not cover. */
  request(endpoint: string, options?: RequestInit): Promise<Response>;
}

/** The header TeamHub deduplicates a write by. */
export function operationHeaders(
  operationId: string | undefined,
): Record<string, string> {
  return operationId ? { "x-teamhub-operation-id": operationId } : {};
}

/**
 * Resolves a successful JSON call to its body. The transport has already
 * thrown for every non-2xx response and every body that is not an object.
 */
export async function teamHubData<T>(call: Promise<{ data?: T }>): Promise<T> {
  // A 204 has no body; callers read it as an empty result.
  return ((await call).data ?? {}) as T;
}

const DEFAULT_UPGRADE_MAX_RETRIES = 3;
const DEFAULT_UPGRADE_RETRY_AFTER_SECONDS = 5;
const MAX_UPGRADE_RETRY_AFTER_SECONDS = 10;

function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/u.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
  }
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
}

function isRepeatableBody(body: RequestInit["body"]): boolean {
  return (
    body === undefined ||
    body === null ||
    typeof body === "string" ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof URLSearchParams ||
    body instanceof FormData
  );
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createTeamHubClient(
  config: TeamHubConfig,
  dependencies: {
    fetch: typeof fetch;
    timing?: CliTiming;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    maxUpgradeRetries?: number;
  },
): TeamHubHttpClient {
  const sleep = dependencies.sleep ?? sleepAbortable;
  const maxUpgradeRetries = Math.max(
    0,
    dependencies.maxUpgradeRetries ?? DEFAULT_UPGRADE_MAX_RETRIES,
  );
  const request = async (endpoint: string, options: RequestInit = {}) => {
    const requestPath = endpoint.split("?")[0]!;
    const sharedDocument = endpoint === "/v0/shared-documents/content";
    if (
      (!endpoint.startsWith("/api/agent/v1/") && !sharedDocument) ||
      endpoint.includes("\\") ||
      endpoint.includes("#") ||
      requestPath.split("/").includes("..") ||
      /%2e|%2f|%5c/iu.test(requestPath)
    )
      throw new CliError("invalid_input", "Invalid TeamHub API endpoint.");
    const headers = new Headers(options.headers);
    if (!sharedDocument) headers.set("authorization", `Bearer ${config.token}`);
    if (!sharedDocument && config.identity) {
      headers.set("x-teamhub-expected-tenant-id", config.identity.tenantId);
      headers.set("x-teamhub-expected-agent-id", config.identity.agentId);
    }
    if (!sharedDocument && config.scope) {
      headers.set("x-teamhub-context-kind", config.scope.kind);
      headers.set("x-teamhub-context-id", config.scope.id);
    }
    // The Run this CLI serves; TeamHub keeps it on a Message only after checking it.
    if (!sharedDocument && config.runId)
      headers.set("x-teamhub-run-id", config.runId);
    const operationId = headers.get("x-teamhub-operation-id");
    const operationTiming =
      operationId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(operationId)
        ? { operation_id: operationId }
        : {};
    const timing = dependencies.timing;
    const method = options.method ?? "GET";
    const repeatable = isRepeatableBody(options.body);

    for (let attempt = 0; ; attempt += 1) {
      const started = timing?.now() ?? 0;
      const requestId = timing ? randomUUID() : undefined;
      if (requestId) headers.set("x-request-id", requestId);
      let response: Response;
      try {
        response = await dependencies.fetch(`${config.url}${endpoint}`, {
          ...options,
          headers,
          redirect: "error",
          signal: options.signal ?? AbortSignal.timeout(180_000),
        });
      } catch {
        timing?.record("http", timing.now() - started, {
          request_id: requestId,
          ...operationTiming,
          method,
          outcome: "failure",
        });
        if (operationId) throw unknownWriteOutcome(operationId);
        throw new CliError("connection_failed", "Could not reach TeamHub.");
      }
      if (timing) {
        const returnedId = response.headers.get("x-request-id");
        const fields: TimingFields = {
          ...operationTiming,
          request_id:
            returnedId && /^[A-Za-z0-9._:-]{1,128}$/u.test(returnedId)
              ? returnedId
              : requestId,
          method,
          http_status: response.status,
        };
        timing.record("http_headers", timing.now() - started, fields);
        response = timedResponse(response, timing, started, fields);
      }
      if (!response.ok) {
        const retryAfterSeconds = parseRetryAfterSeconds(
          response.headers.get("retry-after"),
        );
        let value: unknown;
        try {
          value = await readJson(response);
        } catch {
          /* Preserve HTTP status below. */
        }
        const envelope =
          record(value) && record(value.error) ? value.error : undefined;
        const normalizedCode =
          envelope && typeof envelope.code === "string"
            ? envelope.code.toLowerCase()
            : undefined;
        // TeamHub's upgrade write fence middleware rejects requests BEFORE
        // executing any route handler (503 + Retry-After + code:
        // "service_upgrading"). Because the write definitely did not execute,
        // bounded retry is safe even for mutating requests with an operationId,
        // and exhaustion throws an explicit retryable `service_upgrading` error
        // rather than `outcome_unknown`.
        if (
          response.status === 503 &&
          normalizedCode === "service_upgrading" &&
          repeatable &&
          attempt < maxUpgradeRetries &&
          !options.signal?.aborted
        ) {
          const waitSeconds = Math.min(
            Math.max(
              retryAfterSeconds ?? DEFAULT_UPGRADE_RETRY_AFTER_SECONDS,
              1,
            ),
            MAX_UPGRADE_RETRY_AFTER_SECONDS,
          );
          try {
            await sleep(waitSeconds * 1000, options.signal ?? undefined);
            continue;
          } catch {
            // Aborted while waiting for upgrade; fall through and throw explicit
            // `service_upgrading` error rather than `outcome_unknown`.
          }
        }
        if (envelope && normalizedCode) {
          throw new CliError(
            // Some routes send UPPER_SNAKE. A code this build does not know
            // still passes through; it gets the generic template and an exit
            // code from the HTTP status.
            normalizedCode as ErrorCode,
            typeof envelope.message === "string"
              ? envelope.message
              : "TeamHub rejected the request.",
            {
              ...envelope,
              ...(record(envelope.details) ? envelope.details : {}),
              http_status: response.status,
              ...(normalizedCode === "service_upgrading"
                ? { retryable: true }
                : {}),
              ...(retryAfterSeconds !== undefined
                ? { retry_after_seconds: retryAfterSeconds }
                : {}),
              ...(operationId ? { operation_id: operationId } : {}),
            },
            "remote",
          );
        }
        throw new CliError(
          statusCodes[response.status] ??
            (response.status >= 500
              ? "dependency_unavailable"
              : "invalid_request"),
          `TeamHub request failed (HTTP ${response.status}).`,
          {
            http_status: response.status,
            ...(retryAfterSeconds !== undefined
              ? { retry_after_seconds: retryAfterSeconds }
              : {}),
            ...(operationId ? { operation_id: operationId } : {}),
          },
          "remote",
        );
      }
      if (operationId && response.status !== 204) {
        try {
          return await jsonResponse(response);
        } catch {
          throw unknownWriteOutcome(operationId);
        }
      }
      return response;
    }
  };
  // The base URL only shapes the Request: the transport above prefixes the
  // configured TeamHub URL and checks the endpoint before any credential leaves.
  const api = createClient<paths>({
    baseUrl: "http://teamhub.invalid",
    fetch: async (call: Request) => {
      const url = new URL(call.url);
      const response = await request(url.pathname + url.search, {
        method: call.method,
        headers: call.headers,
        ...(call.body ? { body: await call.text() } : {}),
      });
      if (response.status === 204 || call.headers.get("x-teamhub-operation-id"))
        return response;
      return jsonResponse(response);
    },
  });
  return { config, api, request };
}

async function jsonResponse(response: Response): Promise<Response> {
  const content = await readBounded(response, 8 * 1024 * 1024);
  if (!record(parseJson(content)))
    throw new CliError(
      "invalid_response",
      "TeamHub returned an invalid JSON response.",
    );
  return new Response(content, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** The code of a response without TeamHub's error envelope, such as a proxy's. */
const statusCodes: Partial<Record<number, ErrorCode>> = {
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  408: "dependency_unavailable",
  409: "conflict",
  413: "payload_too_large",
  429: "provider_rate_limited",
  500: "internal_error",
};

function unknownWriteOutcome(operationId: string): CliError {
  return new CliError(
    "outcome_unknown",
    "The operation outcome is unknown. Run the same command again with --operation-id set to this Operation ID: TeamHub returns the original result instead of submitting it twice.",
    { operation_id: operationId },
  );
}

function timedResponse(
  response: Response,
  timing: CliTiming,
  started: number,
  fields: TimingFields,
): Response {
  const completed = (outcome: NonNullable<TimingFields["outcome"]>) =>
    timing.record("http", timing.now() - started, { ...fields, outcome });
  if (!response.body) {
    completed(response.ok ? "success" : "failure");
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  let canceling = false;
  const finish = (outcome: NonNullable<TimingFields["outcome"]>) => {
    if (finished) return;
    finished = true;
    completed(outcome);
    reader.releaseLock();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          finish(canceling ? "canceled" : response.ok ? "success" : "failure");
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        finish("failure");
        controller.error(error);
      }
    },
    async cancel(reason) {
      canceling = true;
      try {
        await reader.cancel(reason);
      } finally {
        finish("canceled");
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export async function readJson(response: Response): Promise<unknown> {
  return parseJson(await readBounded(response, 8 * 1024 * 1024));
}
function parseJson(content: Buffer): unknown {
  try {
    return JSON.parse(content.toString("utf8"));
  } catch {
    throw new CliError(
      "invalid_response",
      "TeamHub returned an invalid JSON response.",
    );
  }
}
export async function readBounded(
  response: Response,
  limit: number,
): Promise<Buffer<ArrayBuffer>> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read().catch(() => {
        throw new CliError(
          "connection_failed",
          "The connection closed before the response was complete.",
        );
      });
      if (next.done) return Buffer.concat(chunks, size);
      size += next.value.byteLength;
      if (size > limit)
        throw new CliError(
          "invalid_response",
          `The response is larger than ${mebibytes(limit)}.`,
        );
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
