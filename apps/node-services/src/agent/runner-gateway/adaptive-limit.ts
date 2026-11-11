/** Where an endpoint's concurrency starts and how far it may grow. */
export interface ConcurrencyRange {
  readonly initial: number;
  readonly max: number;
}

/**
 * What one finished model request says about its endpoint. Latency is
 * compared per thousand tokens of work, so a long prompt is not mistaken for
 * a busy endpoint.
 */
export type ModelSignal =
  | {
      readonly type: "latency";
      /** Run requests and one-shot calls time different spans, so each is
       * compared only with its own kind. */
      readonly source: "run" | "call";
      readonly latencyMs: number;
      readonly workTokens: number;
    }
  | { readonly type: "overload" };

/** One latency sample beside what it is compared with, in ms per thousand
 * tokens; a median is missing until enough samples arrived. */
export interface LatencySample {
  readonly source: "run" | "call";
  readonly perThousand: number;
  readonly baseline?: number;
  readonly window?: number;
}

export interface Observation {
  readonly change?: LimitChange;
  readonly latency?: LatencySample;
}

export interface LimitChange {
  readonly from: number;
  readonly to: number;
  readonly reason: "overload" | "slower" | "faster";
  readonly ratio?: number;
}

/** Samples taken at one limit before it moves again. */
const WINDOW = 4;
/** Samples taken with one unit running, which set the baseline. */
const BASELINE_SAMPLES = 10;
const BASELINE_MIN_SAMPLES = 3;
/** Window median over baseline at or below which another unit is tried. */
const RAISE_AT_MOST = 1.3;
/** Window median over baseline above which a unit is given back. */
const LOWER_ABOVE = 1.8;
/** No raise for this long after the endpoint refused work. */
const OVERLOAD_COOLDOWN_MS = 60_000;
/** First wait before a limit found too slow or refused is tried again; each
 * failed retry doubles it, up to the most. */
const RETRY_CEILING_MS = 5 * 60_000;
const RETRY_CEILING_MAX_MS = 30 * 60_000;
/** Below this, fixed per-request overhead dominates the latency. */
const MIN_WORK_TOKENS = 1_000;

interface Latencies {
  readonly baseline: number[];
  window: number[];
}

/**
 * An endpoint's concurrency, probed additively and backed off fast. The
 * limit grows by one only while work waits for it and requests are about as
 * fast as with one unit running; it shrinks by one when they are clearly
 * slower and halves when the endpoint refuses work. Running units are never
 * interrupted, so a lower limit only holds back new ones.
 *
 * A limit it had to come down from is the ceiling: it is not tried again
 * until the retry time, since one unit running always looks fast and would
 * otherwise send the limit straight back up. A retry that holds clears the
 * ceiling; one that fails waits twice as long for the next.
 */
export class AdaptiveLimit {
  #limit: number;
  #cooldownUntil = 0;
  #ceiling: number | undefined;
  #retryAt = 0;
  #retryAfterMs = RETRY_CEILING_MS;
  readonly #latencies = new Map<string, Latencies>();

  constructor(readonly range: ConcurrencyRange) {
    this.#limit = range.initial;
  }

  get value(): number {
    return this.#limit;
  }

  /** The lowest limit found too slow or refused, until a retry holds. */
  get ceiling(): number | undefined {
    return this.#ceiling;
  }

  observe(
    signal: ModelSignal,
    endpoint: {
      readonly active: number;
      readonly saturated: boolean;
      readonly now: number;
    },
  ): Observation {
    if (signal.type === "overload") {
      this.#cooldownUntil = endpoint.now + OVERLOAD_COOLDOWN_MS;
      return {
        change: this.#lower(
          Math.max(1, Math.floor(this.#limit / 2)),
          "overload",
          endpoint.now,
        ),
      };
    }
    const perThousand =
      signal.latencyMs / (Math.max(signal.workTokens, MIN_WORK_TOKENS) / 1000);
    let latencies = this.#latencies.get(signal.source);
    if (!latencies) {
      latencies = { baseline: [], window: [] };
      this.#latencies.set(signal.source, latencies);
    }
    if (endpoint.active <= 1)
      keepLast(latencies.baseline, perThousand, BASELINE_SAMPLES);
    // After a lower limit the units already running drain first; until
    // then requests still show the old limit's load.
    if (endpoint.active <= this.#limit)
      keepLast(latencies.window, perThousand, WINDOW);
    const baseline =
      latencies.baseline.length >= BASELINE_MIN_SAMPLES
        ? median(latencies.baseline)
        : undefined;
    const window =
      latencies.window.length >= WINDOW ? median(latencies.window) : undefined;
    const latency = {
      source: signal.source,
      perThousand,
      ...(baseline === undefined ? {} : { baseline }),
      ...(window === undefined ? {} : { window }),
    };
    if (baseline === undefined || window === undefined) return { latency };
    const ratio = window / baseline;
    if (ratio > LOWER_ABOVE)
      return {
        latency,
        change: this.#lower(
          Math.max(1, this.#limit - 1),
          "slower",
          endpoint.now,
          ratio,
        ),
      };
    if (this.#ceiling !== undefined && this.#limit >= this.#ceiling) {
      this.#ceiling = undefined;
      this.#retryAfterMs = RETRY_CEILING_MS;
    }
    const next = Math.min(this.range.max, this.#limit + 1);
    if (
      ratio <= RAISE_AT_MOST &&
      endpoint.saturated &&
      endpoint.now >= this.#cooldownUntil &&
      (this.#ceiling === undefined ||
        next < this.#ceiling ||
        endpoint.now >= this.#retryAt)
    )
      return { latency, change: this.#set(next, "faster", ratio) };
    return { latency };
  }

  #lower(
    to: number,
    reason: LimitChange["reason"],
    now: number,
    ratio?: number,
  ): LimitChange | undefined {
    const from = this.#limit;
    const change = this.#set(to, reason, ratio);
    if (!change) return undefined;
    if (this.#ceiling !== undefined && from >= this.#ceiling)
      this.#retryAfterMs = Math.min(
        this.#retryAfterMs * 2,
        RETRY_CEILING_MAX_MS,
      );
    this.#ceiling = from;
    this.#retryAt = now + this.#retryAfterMs;
    return change;
  }

  #set(
    to: number,
    reason: LimitChange["reason"],
    ratio?: number,
  ): LimitChange | undefined {
    if (to === this.#limit) return undefined;
    const from = this.#limit;
    this.#limit = to;
    // Requests timed at the old limit say nothing about the new one.
    for (const latencies of this.#latencies.values()) latencies.window = [];
    return { from, to, reason, ...(ratio === undefined ? {} : { ratio }) };
  }
}

function keepLast(values: number[], value: number, size: number): void {
  values.push(value);
  if (values.length > size) values.splice(0, values.length - size);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
