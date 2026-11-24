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
      /** How long before the report the timed span ended. */
      readonly endedMsAgo: number;
      readonly workTokens: number;
    }
  | { readonly type: "overload" };

/** Units running on the endpoint while one request was timed, the request
 * itself included. */
export interface Concurrency {
  /** Weighted by how long each count lasted. */
  readonly mean: number;
  readonly peak: number;
}

/** One latency sample beside what it is compared with, in ms per thousand
 * tokens; a median is missing until enough samples arrived. */
export interface LatencySample {
  readonly source: "run" | "call";
  readonly perThousand: number;
  readonly baseline?: number;
  readonly window?: number;
}

export interface ProbeFailure {
  readonly probing: number;
  readonly reason: "overload" | "slower";
  readonly ratio?: number;
}

export interface Observation {
  readonly change?: LimitChange;
  readonly probeFailure?: ProbeFailure;
  readonly latency?: LatencySample;
}

export interface LimitChange {
  readonly from: number;
  readonly to: number;
  readonly reason: "overload" | "slower" | "faster";
  readonly ratio?: number;
}

/** Samples that ran at one confirmed limit before it drops. */
const WINDOW = 4;
/** Samples that ran alone, which set the baseline. */
const BASELINE_SAMPLES = 10;
const BASELINE_MIN_SAMPLES = 3;
/** Window median over baseline at or below which a probe promotes the limit. */
const RAISE_AT_MOST = 1.3;
/** Ratio above which a steady limit drops or a probe fails at once. */
const LOWER_ABOVE = 1.8;
/** Minimum mean concurrency below a probe target to count as a probe sample.
 * On a strict single-slot FIFO endpoint, the second of two equal probing
 * calls waits half its time at concurrency 2 and drains alone (mean 1.5). */
const PROBE_CONCURRENCY_TOLERANCE = 0.5;
/** No probe for this long after the endpoint refused work. */
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
  probeWindow: number[];
}

/**
 * An endpoint's confirmed concurrency, grown only by silent background probes
 * and backed off fast. While idle of foreground work, the queue may probe
 * one unit above the confirmed limit using yieldable background calls: the
 * limit promotes only when probe samples stay within RAISE_AT_MOST of the
 * lone-unit baseline, and fails fast when a sample exceeds LOWER_ABOVE or the
 * endpoint refuses work. Steady-state work shrinks by one when clearly slower
 * and halves on overload. Running units are never interrupted by a limit drop.
 *
 * A limit it had to come down from or failed to probe is the ceiling: it is
 * not tried again until the retry time. A retry that promotes clears the
 * ceiling; one that fails waits twice as long for the next.
 */
export class AdaptiveLimit {
  #limit: number;
  #probing: number | undefined;
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

  /** The next concurrency currently being probed by background calls, if any. */
  get probing(): number | undefined {
    return this.#probing;
  }

  /** The lowest limit found too slow or refused, until a retry holds. */
  get ceiling(): number | undefined {
    return this.#ceiling;
  }

  /** Whether a background probe for one more unit may start now. */
  canStartProbe(now: number): boolean {
    if (this.#probing !== undefined || this.#limit >= this.range.max)
      return false;
    const calls = this.#latencies.get("call");
    if (!calls || calls.baseline.length < BASELINE_MIN_SAMPLES) return false;
    if (now < this.#cooldownUntil) return false;
    const next = this.#limit + 1;
    return (
      this.#ceiling === undefined ||
      next < this.#ceiling ||
      now >= this.#retryAt
    );
  }

  /** Enters a background probe for one more unit above the confirmed limit. */
  startProbe(): number | undefined {
    if (this.#probing !== undefined || this.#limit >= this.range.max)
      return undefined;
    this.#probing = this.#limit + 1;
    this.#clearProbeWindows();
    return this.#probing;
  }

  /** Ends an in-progress probe without recording a ceiling, e.g. when higher
   * work arrives or the endpoint goes idle. */
  abortProbe(): number | undefined {
    const probing = this.#probing;
    if (probing === undefined) return undefined;
    this.#probing = undefined;
    this.#clearProbeWindows();
    return probing;
  }

  observe(
    signal: ModelSignal,
    endpoint: {
      /** Over a latency signal's timed span; an overload ignores it. */
      readonly concurrency: Concurrency;
      readonly saturated: boolean;
      readonly now: number;
    },
  ): Observation {
    if (signal.type === "overload") {
      this.#cooldownUntil = endpoint.now + OVERLOAD_COOLDOWN_MS;
      if (this.#probing !== undefined) {
        return { probeFailure: this.#failProbe("overload", endpoint.now) };
      }
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
      latencies = { baseline: [], window: [], probeWindow: [] };
      this.#latencies.set(signal.source, latencies);
    }
    const { mean, peak } = endpoint.concurrency;
    if (peak <= 1) keepLast(latencies.baseline, perThousand, BASELINE_SAMPLES);
    const baseline =
      latencies.baseline.length >= BASELINE_MIN_SAMPLES
        ? median(latencies.baseline)
        : undefined;

    // A background probe evaluates samples that collided at the probed
    // concurrency against the lone-unit baseline.
    if (
      this.#probing !== undefined &&
      signal.source === "call" &&
      baseline !== undefined &&
      peak >= this.#probing
    ) {
      const sampleRatio = perThousand / baseline;
      if (sampleRatio > LOWER_ABOVE) {
        const latency: LatencySample = {
          source: signal.source,
          perThousand,
          baseline,
        };
        return {
          latency,
          probeFailure: this.#failProbe("slower", endpoint.now, sampleRatio),
        };
      }
      if (
        mean >= this.#probing - PROBE_CONCURRENCY_TOLERANCE &&
        mean <= this.#probing + 0.5
      ) {
        const needed = Math.min(WINDOW, this.#probing);
        keepLast(latencies.probeWindow, perThousand, needed);
        const probeWindow =
          latencies.probeWindow.length >= needed
            ? median(latencies.probeWindow)
            : undefined;
        const latency: LatencySample = {
          source: signal.source,
          perThousand,
          baseline,
          ...(probeWindow === undefined ? {} : { window: probeWindow }),
        };
        if (probeWindow !== undefined) {
          const ratio = probeWindow / baseline;
          if (ratio <= RAISE_AT_MOST) {
            const target = this.#probing;
            this.#probing = undefined;
            this.#clearProbeWindows();
            if (this.#ceiling !== undefined && target >= this.#ceiling) {
              this.#ceiling = undefined;
              this.#retryAfterMs = RETRY_CEILING_MS;
            }
            return { latency, change: this.#set(target, "faster", ratio) };
          }
          return {
            latency,
            probeFailure: this.#failProbe("slower", endpoint.now, ratio),
          };
        }
        return { latency };
      }
    }

    // Background work leaves the last place free, so a confirmed limit's
    // requests often run with fewer units and would show a lower limit's speed.
    // After a lower limit the units already running drain first; until then
    // requests still show the old limit's load.
    if (Math.round(mean) === this.#limit)
      keepLast(latencies.window, perThousand, WINDOW);
    const window =
      latencies.window.length >= WINDOW ? median(latencies.window) : undefined;
    const latency: LatencySample = {
      source: signal.source,
      perThousand,
      ...(baseline === undefined ? {} : { baseline }),
      ...(window === undefined ? {} : { window }),
    };
    if (baseline === undefined || window === undefined) return { latency };
    const ratio = window / baseline;
    if (ratio > LOWER_ABOVE) {
      this.abortProbe();
      return {
        latency,
        change: this.#lower(
          Math.max(1, this.#limit - 1),
          "slower",
          endpoint.now,
          ratio,
        ),
      };
    }
    return { latency };
  }

  #failProbe(
    reason: ProbeFailure["reason"],
    now: number,
    ratio?: number,
  ): ProbeFailure {
    const probing = this.#probing!;
    this.#probing = undefined;
    this.#clearProbeWindows();
    this.#recordCeiling(probing, now);
    return { probing, reason, ...(ratio === undefined ? {} : { ratio }) };
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
    this.#recordCeiling(from, now);
    return change;
  }

  #recordCeiling(ceiling: number, now: number): void {
    if (this.#ceiling !== undefined && ceiling >= this.#ceiling)
      this.#retryAfterMs = Math.min(
        this.#retryAfterMs * 2,
        RETRY_CEILING_MAX_MS,
      );
    this.#ceiling = ceiling;
    this.#retryAt = now + this.#retryAfterMs;
  }

  #clearProbeWindows(): void {
    for (const latencies of this.#latencies.values())
      latencies.probeWindow = [];
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

/** Longer than any timed request; a longer one counts from here. */
const OCCUPANCY_HISTORY_MS = 30 * 60_000;

/** How many units an endpoint ran, and since when. */
export class Occupancy {
  /** Each count holds from its time until the next one. */
  readonly #counts: { readonly at: number; readonly active: number }[];

  constructor(now: number) {
    this.#counts = [{ at: now, active: 0 }];
  }

  record(now: number, active: number): void {
    this.#counts.push({ at: now, active });
    // The newest count before the horizon still holds at it.
    let stale = 0;
    while (this.#counts[stale + 1]!.at <= now - OCCUPANCY_HISTORY_MS) stale++;
    this.#counts.splice(0, stale);
  }

  /** Units running from one time to another, which start no earlier than
   * the history does. */
  over(from: number, to: number): Concurrency {
    const counts = this.#counts;
    const start = Math.max(from, counts[0]!.at);
    const end = Math.max(to, start);
    let i = 0;
    while (i + 1 < counts.length && counts[i + 1]!.at <= start) i++;
    if (end === start)
      return { mean: counts[i]!.active, peak: counts[i]!.active };
    let area = 0;
    let peak = 0;
    for (let at = start; i < counts.length && at < end; i++) {
      const until = Math.min(counts[i + 1]?.at ?? end, end);
      if (until <= at) continue;
      area += counts[i]!.active * (until - at);
      peak = Math.max(peak, counts[i]!.active);
      at = until;
    }
    return { mean: area / (end - start), peak };
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
