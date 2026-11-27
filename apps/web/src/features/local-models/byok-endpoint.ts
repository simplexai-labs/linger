import {
  BYOK_PROTOCOL_ENDPOINTS,
  BYOK_RUNTIME_PROTOCOLS,
  DEFAULT_BYOK_PATH,
  normalizeByokBaseUrl,
  normalizeByokPath,
  validByokPath,
} from "@linger/service-kit/byok-endpoint";
import type { components } from "@linger/wire-contracts/teamhub-public/types";

import type { Translate } from "@/i18n/language";

import { localModelsMessages as m } from "./local-models.messages";
import type {
  ModelSourceRuntime,
  ModelSourceStatus,
} from "./model-source-queries";

type Schemas = components["schemas"];
type ByokProtocol = Schemas["ByokProtocol"];

const protocolEntries: readonly (readonly [ByokProtocol, string])[] = [
  ["openai-chat", BYOK_PROTOCOL_ENDPOINTS["openai-chat"]],
  ["openai-responses", BYOK_PROTOCOL_ENDPOINTS["openai-responses"]],
  ["anthropic", BYOK_PROTOCOL_ENDPOINTS.anthropic],
];

const protocolDefaultRuntime: Readonly<
  Record<ByokProtocol, ModelSourceRuntime>
> = {
  anthropic: "claude",
  "openai-chat": "pi",
  "openai-responses": "codex",
};

export interface ByokParsedUrl {
  readonly baseUrl: string;
  readonly endpoint: string;
  readonly explicitEndpoint: boolean;
  readonly origin: string;
  readonly path: string;
  readonly protocol: ByokProtocol;
  readonly runtime: ModelSourceRuntime;
}

export interface ParseByokUrlOptions {
  readonly preserveEmptyEndpointForUrl?: string;
  readonly preserveRuntime?: ModelSourceRuntime;
  readonly preserveRuntimeForUrl?: string;
}

/** Trims surrounding whitespace and trailing slashes from a full BYOK URL. */
export function normalizeByokFullUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

/** Joins a saved BYOK base URL, path, and endpoint into one full URL string. */
export function formatByokFullUrl(
  saved: Pick<ModelSourceStatus["byok"], "base_url" | "endpoint" | "path">,
): string {
  const base = normalizeByokBaseUrl(saved.base_url ?? "");
  if (!base) return "";
  const path = normalizeByokPath(saved.path ?? "");
  const endpoint = normalizeByokPath(saved.endpoint ?? "");
  return `${base}${path}${endpoint}`;
}

function isAnthropicHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "anthropic.com" || lower.endsWith(".anthropic.com");
}

/**
 * Splits a single user-entered BYOK URL into the wire fields TeamHub and
 * Bifrost expect (`base_url`, `path`, `endpoint`, `protocol`) and selects a
 * matching default runtime. Returns null when the input is not a clean
 * http(s) URL without query, hash, or embedded credentials.
 */
export function parseByokFullUrl(
  rawUrl: string,
  options?: ParseByokUrlOptions,
): ByokParsedUrl | null {
  const normalized = normalizeByokFullUrl(rawUrl);
  if (!normalized || /[\s?#\\]/u.test(normalized)) return null;

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname || parsed.username || parsed.password) return null;
  if (parsed.search || parsed.hash) return null;

  const rawPathname = parsed.pathname.replace(/\/+$/u, "");
  const matchedSuffix = protocolEntries.find(([, suffix]) =>
    rawPathname.endsWith(suffix),
  );

  let path: string;
  let endpoint: string;
  let protocol: ByokProtocol;
  let explicitEndpoint: boolean;

  if (matchedSuffix) {
    [protocol, endpoint] = matchedSuffix;
    path = rawPathname.slice(0, -endpoint.length);
    explicitEndpoint = true;
  } else if (
    options?.preserveEmptyEndpointForUrl &&
    normalized === options.preserveEmptyEndpointForUrl
  ) {
    path = rawPathname;
    endpoint = "";
    protocol = isAnthropicHostname(parsed.hostname)
      ? "anthropic"
      : options.preserveRuntime
        ? BYOK_RUNTIME_PROTOCOLS[options.preserveRuntime]
        : "openai-chat";
    explicitEndpoint = true;
  } else {
    path = rawPathname || DEFAULT_BYOK_PATH;
    protocol = isAnthropicHostname(parsed.hostname)
      ? "anthropic"
      : "openai-chat";
    endpoint = BYOK_PROTOCOL_ENDPOINTS[protocol];
    explicitEndpoint = false;
  }

  if (!validByokPath(path) || !validByokPath(endpoint)) return null;

  const runtime =
    options?.preserveRuntime &&
    options.preserveRuntimeForUrl &&
    normalized === options.preserveRuntimeForUrl
      ? options.preserveRuntime
      : protocolDefaultRuntime[protocol];

  return {
    baseUrl: parsed.origin,
    endpoint,
    explicitEndpoint,
    origin: parsed.origin,
    path,
    protocol,
    runtime,
  };
}

/** A context window as the BYOK form shows it. */
export function byokContextLabel(tokens: number, t: Translate) {
  return tokens < 1024
    ? t(m.byokContextTokens, { tokens })
    : t(m.byokContextKilo, { thousands: Math.round(tokens / 1024) });
}
