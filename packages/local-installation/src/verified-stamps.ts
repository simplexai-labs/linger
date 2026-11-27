import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { readFile } from "node:fs/promises";
import { atomicPrivate } from "./instance.js";

// Trust a verified stamp once its timestamps have settled past coarse clock ticks
// so an immediate same-sized rewrite still re-hashes.
export const STAMP_SETTLE_MS = 2_000;

export type SettledStamp = [size: number, mtimeMs: number, ctimeMs: number];
export type SettledStamps = Record<string, SettledStamp>;

interface StampRecord {
  digest?: unknown;
  stamps?: SettledStamps;
}

/** Computes the lowercase hex SHA-256 digest of a file. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Runs `worker` over `items` with at most `concurrency` in flight, draining
 * started workers on the first error before rethrowing.
 */
export async function runBounded<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  let failure: { reason: unknown } | undefined;
  const runner = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await worker(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () =>
      runner().catch((reason: unknown) => {
        next = items.length;
        failure ??= { reason };
      }),
    ),
  );
  if (failure) throw failure.reason;
}

/**
 * Reports whether `info` still matches a previously verified file stamp whose
 * timestamps are outside the clock-resolution settle window.
 */
export function settledStampMatches(
  seen: SettledStamp | undefined,
  info: Pick<Stats, "size" | "mtimeMs" | "ctimeMs">,
  nowMs: number,
  settleMs: number = STAMP_SETTLE_MS,
): boolean {
  return (
    !!seen &&
    seen[0] === info.size &&
    seen[1] === info.mtimeMs &&
    seen[2] === info.ctimeMs &&
    Math.abs(nowMs - info.mtimeMs) >= settleMs &&
    Math.abs(nowMs - info.ctimeMs) >= settleMs
  );
}

/** Reads verified file stamps when their recorded manifest digest matches. */
export async function readSettledStamps(
  stampFile: string,
  expectedDigest: string,
): Promise<SettledStamps | undefined> {
  try {
    const record = JSON.parse(await readFile(stampFile, "utf8")) as StampRecord;
    return record.digest === expectedDigest &&
      record.stamps &&
      typeof record.stamps === "object"
      ? record.stamps
      : undefined;
  } catch {
    return undefined;
  }
}

/** Persists settled file stamps keyed by the manifest digest. */
export async function writeSettledStamps(
  stampFile: string,
  digest: string,
  stamps: SettledStamps,
): Promise<void> {
  await atomicPrivate(stampFile, JSON.stringify({ digest, stamps })).catch(
    () => undefined,
  );
}
