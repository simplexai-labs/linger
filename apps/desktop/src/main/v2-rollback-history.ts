import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { BundleModuleId } from "@linger/local-installation/release-descriptor";

import { redactServiceLogText } from "./v2-service-logs.js";

export const ROLLBACK_HISTORY_FILENAME = "rollback-history.jsonl";
export const MAX_ROLLBACK_HISTORY_ENTRIES = 50;

export interface RollbackHistoryEntry {
  readonly timestamp: string;
  readonly failedVersion: string;
  readonly restoredVersion: string;
  readonly stage: "migrate" | "healthcheck" | "crash-watchdog";
  readonly changedModules: readonly BundleModuleId[];
  readonly failedServices: readonly string[];
  readonly reason: string;
  readonly serviceLogTails?: Readonly<Record<string, string>>;
  readonly rollbackSafe: boolean;
  readonly dbBackupFile?: string;
  readonly dbRestored: boolean;
  readonly manualRecoveryRequired: boolean;
  readonly denylisted: boolean;
}

export function rollbackHistoryPath(home: string): string {
  return path.join(path.resolve(home), "state", ROLLBACK_HISTORY_FILENAME);
}

function sanitizeHistoryEntry(
  entry: RollbackHistoryEntry,
): RollbackHistoryEntry {
  const sanitizedTails = entry.serviceLogTails
    ? Object.fromEntries(
        Object.entries(entry.serviceLogTails).map(([svc, tail]) => [
          svc,
          redactServiceLogText(tail),
        ]),
      )
    : undefined;
  return {
    ...entry,
    reason: redactServiceLogText(entry.reason),
    ...(sanitizedTails && Object.keys(sanitizedTails).length > 0
      ? { serviceLogTails: sanitizedTails }
      : {}),
  };
}

/**
 * Reads persisted V2 rollback records from `<home>/state/rollback-history.jsonl`.
 * Returns at most the latest `limit` valid entries (empty array if absent).
 */
export async function readRollbackHistory(
  home: string,
  limit = MAX_ROLLBACK_HISTORY_ENTRIES,
): Promise<RollbackHistoryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(rollbackHistoryPath(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const parsed: RollbackHistoryEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const item = JSON.parse(trimmed) as Partial<RollbackHistoryEntry>;
      if (
        item &&
        typeof item === "object" &&
        typeof item.timestamp === "string" &&
        typeof item.failedVersion === "string" &&
        typeof item.restoredVersion === "string" &&
        typeof item.stage === "string" &&
        typeof item.reason === "string"
      ) {
        parsed.push(item as RollbackHistoryEntry);
      }
    } catch {
      // Ignore malformed/truncated JSONL lines so diagnostics never fail.
    }
  }
  return limit > 0 ? parsed.slice(-limit) : parsed;
}

/**
 * Atomically appends a sanitized rollback record to
 * `<home>/state/rollback-history.jsonl` (0o700 dir, 0o600 file on POSIX),
 * retaining at most the newest `maxEntries` (default 50) entries.
 */
export async function appendRollbackHistory(
  home: string,
  entry: RollbackHistoryEntry,
  options: {
    readonly maxEntries?: number;
    readonly platform?: NodeJS.Platform;
  } = {},
): Promise<void> {
  const maxEntries = options.maxEntries ?? MAX_ROLLBACK_HISTORY_ENTRIES;
  const platform = options.platform ?? process.platform;
  const filePath = rollbackHistoryPath(home);
  const stateDir = path.dirname(filePath);

  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  if (platform !== "win32") {
    await chmod(stateDir, 0o700);
  }

  const existing = await readRollbackHistory(home, maxEntries).catch(() => []);
  const next = [...existing, sanitizeHistoryEntry(entry)].slice(-maxEntries);
  const payload = `${next.map((item) => JSON.stringify(item)).join("\n")}\n`;

  const tempPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(tempPath, "w", 0o600);
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();

  await rename(tempPath, filePath);
  if (platform !== "win32") {
    await chmod(filePath, 0o600);
  }
}
