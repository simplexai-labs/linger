import { open } from "node:fs/promises";
import path from "node:path";

import { redactDiagnostics } from "./diagnostics.js";

export const DEFAULT_SERVICE_LOG_TAIL_BYTES = 8 * 1024;
export const DEFAULT_SERVICE_LOG_TAIL_LINES = 10;
export const DEFAULT_SERVICE_LOG_TAIL_CHARS = 1_500;

export type NativeServiceLogName =
  | "teamhub"
  | "node-services"
  | "web"
  | "postgres"
  | "livekit";

const ALLOWED_SERVICE_LOGS = new Set<NativeServiceLogName>([
  "teamhub",
  "node-services",
  "web",
  "postgres",
  "livekit",
]);

const PEM_COMPLETE_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const PEM_UNTERMINATED_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/g;
const PEM_TRUNCATED_TAIL_RE =
  /(?:^[A-Za-z0-9+/=\s]{16,}$\r?\n)*^-----END [A-Z0-9 ]*PRIVATE KEY-----$/gm;

const URI_CREDENTIALS_RE =
  /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]*):[^\s/@]+@/gi;

const COOKIE_HEADER_RE = /(\b(?:set-cookie|cookie)\b\s*[:=]\s*)[^\r\n]+/gi;
const AUTH_SCHEME_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi;

const JSON_SECRET_KEY_RE =
  /("[\w.-]*(?:password|passwd|pass|secret|token|cookie|credential|api[_-]?key|private[_-]?key|access[_-]?key|encryption[_-]?key|identity[_-]?key|signing[_-]?key|auth[_-]?key|pgpassword|authorization)[\w.-]*"\s*:\s*)("(?:[^"\\\n]|\\.)*"|[^\s,}\]]+)/gi;

const ENV_OR_KV_SECRET_RE =
  /((?:\b(?:[A-Za-z0-9_.-]*[_-])?(?:password|passwd|pass|secret(?:[_-]?seed)?|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|encryption[_-]?key|identity[_-]?key|signing[_-]?key|auth[_-]?key|credential|pgpassword|authorization)|\b[A-Z][A-Z0-9_]*_KEY)\b["']?\s*[:=]\s*)(?:(?:Bearer|Basic)\s+[^\s"']+|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[^\s,;}]+)/gi;

const KNOWN_TOKEN_PREFIX_RE =
  /\b(?:sk[-_][A-Za-z0-9_-]{8,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g;

const JWT_RE =
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

/**
 * Redacts credentials, tokens, connection URIs, cookies, and private keys
 * from service log excerpts before writing them into Desktop structured logs.
 */
export function redactServiceLogText(text: string): string {
  let sanitized = text
    .replace(PEM_COMPLETE_RE, "[REDACTED_PRIVATE_KEY]")
    .replace(PEM_UNTERMINATED_RE, "[REDACTED_PRIVATE_KEY]")
    .replace(PEM_TRUNCATED_TAIL_RE, "[REDACTED_PRIVATE_KEY]")
    .replace(URI_CREDENTIALS_RE, "$1$2:[REDACTED]@")
    .replace(COOKIE_HEADER_RE, "$1[REDACTED]")
    .replace(AUTH_SCHEME_RE, "$1 [REDACTED]")
    .replace(JSON_SECRET_KEY_RE, '$1"[REDACTED]"')
    .replace(ENV_OR_KV_SECRET_RE, "$1[REDACTED]")
    .replace(KNOWN_TOKEN_PREFIX_RE, "[REDACTED]")
    .replace(JWT_RE, "[REDACTED]");

  sanitized = redactDiagnostics(sanitized);
  return sanitized;
}

/**
 * Maps a health probe name (e.g. `teamhub-healthz`, `node-services-healthz`,
 * `web-healthz`) to its native service log name under
 * `<home>/instances/<instanceName>/native/logs/<service>.log`.
 */
export function probeNameToServiceLog(
  probeName: string,
): NativeServiceLogName | undefined {
  const normalized = probeName
    .trim()
    .toLowerCase()
    .replace(/-healthz$/, "");
  if (ALLOWED_SERVICE_LOGS.has(normalized as NativeServiceLogName)) {
    return normalized as NativeServiceLogName;
  }
  return undefined;
}

/**
 * Reads at most the last `maxBytes` of `filePath` without loading the full
 * file into memory, sanitizes secrets, and bounds the result to the last
 * `maxLines` non-empty lines and `maxChars` characters.
 */
export async function readSanitizedLogTail(
  filePath: string,
  options: {
    readonly maxBytes?: number;
    readonly maxLines?: number;
    readonly maxChars?: number;
  } = {},
): Promise<string | undefined> {
  const maxBytes = options.maxBytes ?? DEFAULT_SERVICE_LOG_TAIL_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_SERVICE_LOG_TAIL_LINES;
  const maxChars = options.maxChars ?? DEFAULT_SERVICE_LOG_TAIL_CHARS;

  let raw: string;
  try {
    const handle = await open(filePath, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size <= 0) return undefined;
      const start = Math.max(0, info.size - maxBytes);
      const length = info.size - start;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      raw = buffer.subarray(0, bytesRead).toString("utf8");
      if (start > 0) {
        const firstNewline = raw.indexOf("\n");
        if (firstNewline >= 0) {
          raw = raw.slice(firstNewline + 1);
        }
      }
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }

  const sanitized = redactServiceLogText(raw);
  const lines = sanitized
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-maxLines);

  if (lines.length === 0) return undefined;
  const joined = lines.join("\n");
  if (joined.length <= maxChars) return joined;
  return `…${joined.slice(-(maxChars - 1))}`;
}

export interface FailedServiceLogReaderOptions {
  readonly getHome: () => string;
  readonly instanceName?: string;
  readonly maxBytes?: number;
  readonly maxLines?: number;
  readonly maxChars?: number;
}

/**
 * Creates a lazy reader that captures sanitized, bounded tails of failed
 * native service logs under `<home>/instances/<instanceName>/native/logs/`.
 */
export function createFailedServiceLogReader(
  options: FailedServiceLogReaderOptions,
): (failedProbes: readonly string[]) => Promise<Record<string, string>> {
  const instanceName = options.instanceName ?? "desktop";
  return async (
    failedProbes: readonly string[],
  ): Promise<Record<string, string>> => {
    const services = new Set<NativeServiceLogName>();
    for (const probe of failedProbes) {
      const service = probeNameToServiceLog(probe);
      if (service) services.add(service);
    }
    if (services.size === 0) return {};

    const logsDir = path.join(
      options.getHome(),
      "instances",
      instanceName,
      "native",
      "logs",
    );
    const result: Record<string, string> = {};
    await Promise.all(
      [...services].map(async (service) => {
        const tail = await readSanitizedLogTail(
          path.join(logsDir, `${service}.log`),
          {
            maxBytes: options.maxBytes,
            maxLines: options.maxLines,
            maxChars: options.maxChars,
          },
        );
        if (tail) {
          result[service] = tail;
        }
      }),
    );
    return result;
  };
}
