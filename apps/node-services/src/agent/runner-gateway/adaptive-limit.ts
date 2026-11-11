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
 */
export class AdaptiveLimit {
  #limit: number;
  #cooldownUntil = 0;
  readonly #latencies = new Map<string, Latencies>();

  constructor(readonly range: ConcurrencyRange) {
    this.#limit = range.initial;
  }

  get value(): number {
    return this.#limit;
  }

  observe(
    signal: ModelSignal,
    endpoint: {
      readonly active: number;
      readonly saturated: boolean;
      readonly now: number;
    },
  ): LimitChange | undefined {
    if (signal.type === "overload") {
      this.#cooldownUntil = endpoint.now + OVERLOAD_COOLDOWN_MS;
      return this.#set(Math.max(1, Math.floor(this.#limit / 2)), "overload");
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
    keepLast(latencies.window, perThousand, WINDOW);
    if (
      latencies.baseline.length < BASELINE_MIN_SAMPLES ||
      latencies.window.length < WINDOW
    )
      return undefined;
    const ratio = median(latencies.window) / median(latencies.baseline);
    if (ratio > LOWER_ABOVE)
      return this.#set(Math.max(1, this.#limit - 1), "slower", ratio);
    if (
      ratio <= RAISE_AT_MOST &&
      endpoint.saturated &&
      endpoint.now >= this.#cooldownUntil
    )
      return this.#set(
        Math.min(this.range.max, this.#limit + 1),
        "faster",
        ratio,
      );
    return undefined;
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
