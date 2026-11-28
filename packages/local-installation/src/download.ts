import { createHash, randomUUID, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { renameRetrying } from "./fs-retry.js";

export interface DownloadTiming {
  /**
   * Rounds over the hosts; each round tries every host once, and an
   * interrupted attempt resumes where the last one stopped.
   */
  attempts: number;
  /** Wait before the second round; it doubles for each later one. */
  retryDelayMs: number;
  /** An attempt that receives no bytes for this long starts again. */
  idleTimeoutMs: number;
  /**
   * When mirrors exist, check throughput on this interval until a round
   * compares host speeds so a slow host yields to a faster mirror. Disabled
   * when unset or <= 0.
   */
  slowCheckAfterMs?: number;
  /** Throughput below which the first host checks alternate mirrors. */
  minBytesPerSecond?: number;
  /** Only check alternate mirrors when at least this much transfer time remains. */
  minRemainingMs?: number;
}
const defaultTiming: DownloadTiming = {
  attempts: 4,
  retryDelayMs: 2_000,
  idleTimeoutMs: 60_000,
  slowCheckAfterMs: 6_000,
  minBytesPerSecond: 1024 * 1024,
  minRemainingMs: 25_000,
};
// A mirror replaces a slow primary only when it delivers a meaningful speedup,
// preventing oscillation when both regions have similar bandwidth.
const SLOW_SWITCH_RATIO = 1.5;

export interface DownloadSlowSwitchEvent {
  kind: "slow_switch";
  fromHost: string;
  toHost: string;
  bytesPerSecond: number;
  completed: number;
  total?: number;
}

export interface DownloadHostSwitchEvent {
  kind: "host_switch";
  fromHost: string;
  toHost: string;
  reason: string;
  completed: number;
  total?: number;
}

export type DownloadDiagnosticEvent =
  | DownloadSlowSwitchEvent
  | DownloadHostSwitchEvent;

interface SlowLimit {
  afterMs: number;
  minBytesPerSecond: number;
  minRemainingMs: number;
}

interface AttemptOutcome {
  status: "done" | "retry" | "next" | "slow";
  bytes: number;
  bytesPerSecond: number;
}

function publicUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Download requires a public HTTPS URL without credentials or query parameters.",
    );
  return url;
}

/**
 * Only a verified, bounded download may become an installation input. A
 * failed, slow or interrupted transfer moves on to the next mirror and
 * resumes there with an HTTP range request; the checksum still decides what
 * is published. Resolves to the URL that delivered the last bytes, or the
 * preferred URL when a complete saved file needs no request.
 */
export async function downloadVerified(
  options: {
    url: string;
    /** Other hosts serving the same bytes, tried after `url`. */
    mirrors?: readonly string[];
    output: string;
    algorithm: "sha256" | "sha512";
    digest: string;
    maxBytes: number;
    signal: AbortSignal;
    onProgress?: (completed: number, total?: number) => void;
    onDiagnostic?: (event: DownloadDiagnosticEvent) => void;
    /** Keep `<output>.part` after a failure so the next call resumes it. */
    resumable?: boolean;
  },
  fetcher: typeof fetch = fetch,
  timing: DownloadTiming = defaultTiming,
): Promise<string> {
  const urls = [options.url, ...(options.mirrors ?? [])].map(publicUrl);
  const digestLength = options.algorithm === "sha256" ? 64 : 128;
  if (!new RegExp(`^[a-f0-9]{${digestLength}}$`).test(options.digest))
    throw new Error("Invalid trusted checksum.");
  options.signal.throwIfAborted();
  const name = path.posix.basename(urls[0]!.pathname) || urls[0]!.host;
  const hosts = [...new Set(urls.map((url) => url.host))].join(" and ");
  const partial = options.resumable
    ? `${options.output}.part`
    : `${options.output}.${randomUUID()}.part`;
  let hash: Hash = createHash(options.algorithm);
  let completed = 0;
  let completePartial = false;
  if (options.resumable) {
    const existing = await lstat(partial).catch(() => undefined);
    if (existing?.isFile() && existing.size <= options.maxBytes) {
      try {
        for await (const chunk of createReadStream(partial, {
          signal: options.signal,
        }))
          hash.update(chunk as Buffer);
      } catch (error) {
        options.signal.throwIfAborted();
        throw error;
      }
      completed = existing.size;
      completePartial = hash.copy().digest("hex") === options.digest;
    } else await rm(partial, { recursive: true, force: true });
  }
  options.signal.throwIfAborted();
  let handle = await open(partial, options.resumable ? "a" : "ax", 0o600);
  let size: number | undefined = completePartial ? completed : undefined;
  let lastProgressAt = 0;
  let failure = "no connection";

  // One request: "done" when the body ended, "retry" after a transient
  // failure, "next" when this host cannot serve the file, "slow" when it
  // yielded so another mirror can be compared.
  const attempt = async (
    url: URL,
    slowLimit?: SlowLimit,
  ): Promise<AttemptOutcome> => {
    const stalled = new AbortController();
    const signal = AbortSignal.any([options.signal, stalled.signal]);
    let idle: NodeJS.Timeout | undefined;
    let slowTimer: NodeJS.Timeout | undefined;
    let received = 0;
    let windowBytes = 0;
    let windowStartedAt = performance.now();
    let slowAborted = false;
    let slowRate = 0;
    const watch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => stalled.abort(), timing.idleTimeoutMs);
    };
    const scheduleSlowCheck = () => {
      if (!slowLimit) return;
      slowTimer = setTimeout(() => {
        const elapsedSec = Math.max(
          (performance.now() - windowStartedAt) / 1000,
          0.001,
        );
        const rate = windowBytes / elapsedSec;
        const remaining =
          size !== undefined ? Math.max(0, size - completed) : undefined;
        const remainingMs =
          remaining !== undefined && rate > 0
            ? (remaining / rate) * 1000
            : Number.POSITIVE_INFINITY;
        if (
          rate < slowLimit.minBytesPerSecond &&
          remainingMs > slowLimit.minRemainingMs
        ) {
          slowAborted = true;
          slowRate = rate;
          stalled.abort();
          return;
        }
        windowBytes = 0;
        windowStartedAt = performance.now();
        scheduleSlowCheck();
      }, slowLimit.afterMs);
    };
    watch();
    scheduleSlowCheck();
    try {
      let response: Response;
      try {
        response = await fetcher(url, {
          redirect: "error",
          signal,
          ...(completed ? { headers: { range: `bytes=${completed}-` } } : {}),
        });
      } catch {
        options.signal.throwIfAborted();
        if (slowAborted) {
          failure = "slow";
          return { status: "slow", bytes: 0, bytesPerSecond: 0 };
        }
        failure = stalled.signal.aborted ? "no response" : "no connection";
        return { status: "retry", bytes: 0, bytesPerSecond: 0 };
      }
      if (
        completed &&
        response.status === 206 &&
        !(response.headers.get("content-range") ?? "").startsWith(
          `bytes ${completed}-`,
        )
      ) {
        await response.body?.cancel();
        failure = "invalid range response";
        return { status: "next", bytes: 0, bytesPerSecond: 0 };
      }
      // The previous call received every byte; the checksum decides.
      if (completed && response.status === 416) {
        await response.body?.cancel();
        return { status: "done", bytes: 0, bytesPerSecond: 0 };
      }
      if (completed && response.status === 200) {
        // The host ignored the range. Windows append handles cannot truncate,
        // so start over with a newly created private partial file.
        await handle.close();
        await rm(partial, { force: true });
        handle = await open(partial, "ax", 0o600);
        hash = createHash(options.algorithm);
        completed = 0;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        failure = `HTTP ${response.status}`;
        // A missing or forbidden file stays so on this host.
        return {
          status:
            response.status >= 400 &&
            response.status < 500 &&
            ![408, 429].includes(response.status)
              ? "next"
              : "retry",
          bytes: 0,
          bytesPerSecond: 0,
        };
      }
      const length = Number(response.headers.get("content-length")) || 0;
      size = length ? completed + length : undefined;
      if (size && size > options.maxBytes) {
        await response.body.cancel();
        throw new Error("Download size exceeds limit.");
      }
      // The slow check compares transfer throughput, so its window starts
      // when the response arrives. Time to first byte is not throughput,
      // and the first host tried would otherwise be charged for cold-start
      // latency that later hosts never pay.
      clearTimeout(slowTimer);
      windowBytes = 0;
      windowStartedAt = performance.now();
      scheduleSlowCheck();
      const reader = response.body.getReader();
      // Some bodies ignore the fetch signal; either abort still ends the read.
      let abortRead: (() => void) | undefined;
      const interrupted = new Promise<never>((_resolve, reject) => {
        abortRead = () => reject(signal.reason);
        if (signal.aborted) abortRead();
        else signal.addEventListener("abort", abortRead, { once: true });
      });
      interrupted.catch(() => {});
      try {
        for (;;) {
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await Promise.race([reader.read(), interrupted]);
          } catch {
            options.signal.throwIfAborted();
            if (slowAborted) {
              failure = "slow";
              return {
                status: "slow",
                bytes: received,
                bytesPerSecond: slowRate,
              };
            }
            failure = stalled.signal.aborted ? "stalled" : "interrupted";
            return { status: "retry", bytes: received, bytesPerSecond: 0 };
          }
          const { done, value } = chunk;
          if (done)
            return { status: "done", bytes: received, bytesPerSecond: 0 };
          watch();
          received += value.byteLength;
          windowBytes += value.byteLength;
          completed += value.byteLength;
          if (completed > options.maxBytes)
            throw new Error("Download size exceeds limit.");
          hash.update(value);
          await handle.writeFile(value);
          if (Date.now() - lastProgressAt >= 250) {
            options.onProgress?.(completed, size);
            lastProgressAt = Date.now();
          }
        }
      } finally {
        if (abortRead) signal.removeEventListener("abort", abortRead);
        await reader.cancel().catch(() => {});
      }
    } finally {
      clearTimeout(idle);
      clearTimeout(slowTimer);
    }
  };

  let published = false;
  let served = urls[0]!;
  try {
    let result: AttemptOutcome["status"] = completePartial ? "done" : "next";
    // Hosts that cannot serve the file leave the rotation.
    let active = urls;
    const slowAfterMs = timing.slowCheckAfterMs ?? 0;
    const slowFloor = timing.minBytesPerSecond ?? 0;
    const slowRemainingMs = timing.minRemainingMs ?? 0;
    const slowEnabled = slowAfterMs > 0 && slowFloor > 0 && timing.attempts > 1;
    let slowCompared = false;
    let skipNextDelay = false;
    rounds: for (let round = 0; round < timing.attempts; round += 1) {
      // A cancelled publication can leave every verified byte on disk.
      if (completePartial) break;
      if (!active.length) break;
      if (round > 0 && !skipNextDelay)
        await delay(timing.retryDelayMs * 2 ** (round - 1), undefined, {
          signal: options.signal,
        });
      skipNextDelay = false;
      let bestSlowRate: number | undefined;
      const measured = new Map<URL, number>();
      let anySlowProgress = false;
      for (let index = 0; index < active.length; index += 1) {
        const url = active[index]!;
        const remainingHosts = active.length - 1 - index;
        let slowLimit: SlowLimit | undefined;
        if (!slowCompared && slowEnabled && active.length > 1) {
          if (bestSlowRate === undefined) {
            // With nothing measured yet the last host runs without a
            // limit: no faster host has been proven, so a limit here
            // could only send the download back to a host that already
            // yielded without delivering a byte.
            if (remainingHosts > 0) {
              slowLimit = {
                afterMs: slowAfterMs,
                minBytesPerSecond: slowFloor,
                minRemainingMs: slowRemainingMs,
              };
            }
          } else if (remainingHosts > 0 || round < timing.attempts - 1) {
            const targetRate =
              remainingHosts > 0
                ? Math.max(slowFloor, bestSlowRate * SLOW_SWITCH_RATIO)
                : bestSlowRate * SLOW_SWITCH_RATIO;
            if (targetRate > 0) {
              slowLimit = {
                afterMs: slowAfterMs,
                minBytesPerSecond: targetRate,
                // Keep minRemainingMs while another mirror remains so a faster
                // mirror that will finish soon completes instead of aborting;
                // only the last mirror drops it so a crawling tail still yields
                // back to a faster host measured earlier in the round.
                minRemainingMs: remainingHosts > 0 ? slowRemainingMs : 0,
              };
            }
          }
        }
        const outcome = await attempt(url, slowLimit);
        result = outcome.status;
        served = url;
        if (outcome.status === "done") break rounds;
        const nextUrl = active[index + 1];
        if (outcome.status === "next") {
          if (nextUrl) {
            options.onDiagnostic?.({
              kind: "host_switch",
              fromHost: url.hostname,
              toHost: nextUrl.hostname,
              reason: failure,
              completed,
              ...(size !== undefined ? { total: size } : {}),
            });
          }
          active = active.filter((item) => item !== url);
          index -= 1;
          continue;
        }
        if (outcome.status === "slow") {
          // A yield before the first byte carries no transfer rate: the
          // host may only be slow to start. Recording it as a measured 0
          // would disarm the speed check for every later host and let any
          // of them displace the primary unproven.
          if (outcome.bytes > 0) {
            measured.set(url, outcome.bytesPerSecond);
            anySlowProgress = true;
            bestSlowRate =
              bestSlowRate === undefined
                ? outcome.bytesPerSecond
                : Math.max(bestSlowRate, outcome.bytesPerSecond);
          }
          if (nextUrl) {
            options.onDiagnostic?.({
              kind: "slow_switch",
              fromHost: url.hostname,
              toHost: nextUrl.hostname,
              bytesPerSecond: Math.round(outcome.bytesPerSecond),
              completed,
              ...(size !== undefined ? { total: size } : {}),
            });
          }
          continue;
        }
        if (nextUrl) {
          options.onDiagnostic?.({
            kind: "host_switch",
            fromHost: url.hostname,
            toHost: nextUrl.hostname,
            reason: failure,
            completed,
            ...(size !== undefined ? { total: size } : {}),
          });
        }
      }
      if (!slowCompared && measured.size > 0) {
        slowCompared = true;
        const primary = active[0];
        const baseRate = primary ? (measured.get(primary) ?? 0) : 0;
        let bestUrl = primary;
        let bestRate = baseRate;
        for (const [url, rate] of measured) {
          if (
            rate > bestRate &&
            (baseRate === 0 ? rate > 0 : rate >= baseRate * SLOW_SWITCH_RATIO)
          ) {
            bestUrl = url;
            bestRate = rate;
          }
        }
        if (bestUrl && bestUrl !== primary) {
          active = [bestUrl, ...active.filter((item) => item !== bestUrl)];
        }
        if (anySlowProgress) skipNextDelay = true;
      }
      if (
        round + 1 < timing.attempts &&
        active.length > 0 &&
        active[0] !== served
      ) {
        if (result === "slow") {
          options.onDiagnostic?.({
            kind: "slow_switch",
            fromHost: served.hostname,
            toHost: active[0]!.hostname,
            bytesPerSecond: Math.round(measured.get(served) ?? 0),
            completed,
            ...(size !== undefined ? { total: size } : {}),
          });
        } else if (result === "retry" || result === "next") {
          options.onDiagnostic?.({
            kind: "host_switch",
            fromHost: served.hostname,
            toHost: active[0]!.hostname,
            reason: failure,
            completed,
            ...(size !== undefined ? { total: size } : {}),
          });
        }
      }
    }
    if (result !== "done")
      throw new Error(
        `Download of ${name} from ${hosts} failed (${failure}). Check your network and retry.`,
      );
    if (hash.digest("hex") !== options.digest) {
      completed = 0;
      throw new Error("Download checksum mismatch.");
    }
    options.onProgress?.(completed, size);
    await handle.sync();
    options.signal.throwIfAborted();
    await handle.close();
    await renameRetrying(partial, options.output, {
      signal: options.signal,
    });
    published = true;
    return served.href;
  } finally {
    await handle.close().catch(() => {});
    // A resumable download keeps what it received for the next call.
    if (!published && (!options.resumable || completed === 0))
      await rm(partial, { force: true });
  }
}
