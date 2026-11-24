import {
  admissionLimit,
  INTERACTIVE_PRIORITY,
  RunPriority,
  type ModelLease,
  type ModelLeaseResult,
} from "../../model-tasks.js";
import { logAgentEvent } from "../observability/agent-log.js";
import {
  AdaptiveLimit,
  Occupancy,
  type ConcurrencyRange,
  type ModelSignal,
} from "./adaptive-limit.js";
import type {
  LocalComputerModel,
  LocalRuntimeType,
} from "./local-computer-management.js";

/** One Runtime on one Computer, which model work queues for. */
export interface ModelEndpoint {
  readonly computerId: string;
  readonly runtimeType: LocalRuntimeType;
}

export interface ModelWork {
  /** Lowest first; see model-tasks. A raised Run priority re-ranks the wait. */
  readonly priority: number | RunPriority;
  /** A call kind, a Run kind or compaction. */
  readonly kind: string;
  /** Names the work in the log. */
  readonly key: string;
}

/** How long interactive work waits for a place before the log says who
 * holds the places and why none of them yields. */
export const INTERACTIVE_STALL_MS = 30_000;

/** A Runtime whose every model is on the signed-in account. */
const SUBSCRIPTION_CONCURRENCY: ConcurrencyRange = { initial: 10, max: 10 };
/** A Runtime that reaches its models through an API link, or whose models
 * are unknown. */
const API_CONCURRENCY: ConcurrencyRange = { initial: 1, max: 8 };

/**
 * Units an endpoint runs at once, from where it starts to how far probing may
 * take it. The signed-in account serves many requests and starts high. An
 * API link is often one local model every Agent shares, which answers one
 * more request only by slowing the others, so it starts at one and grows only
 * while requests stay as fast.
 */
export function endpointConcurrency(
  models: readonly Pick<LocalComputerModel, "link">[] | undefined,
): ConcurrencyRange {
  return models?.length && models.every(({ link }) => link === "subscription")
    ? SUBSCRIPTION_CONCURRENCY
    : API_CONCURRENCY;
}

interface Waiter {
  readonly priority: () => number;
  readonly seq: number;
  readonly signal: AbortSignal;
  readonly admit: () => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
}

interface EndpointState {
  readonly key: string;
  readonly endpoint: ModelEndpoint;
  active: number;
  /** A timed request lies within its unit's place, so the history never
   * needs to outlive an idle endpoint. */
  readonly occupancy: Occupancy;
  readonly waiting: Waiter[];
}

/**
 * Admits model work per endpoint. A Run Operation, a model attempt and a
 * compaction each occupy one place. Smaller priority numbers start first,
 * in arrival order within a priority. When the limit exceeds one,
 * interactive work may fill the last place. When it cannot start, it asks a
 * lower-priority Run holding a place to yield.
 * The limit adapts to what finished requests report. Admission only; it
 * never picks, orders or retries a Run.
 */
export class ModelQueue {
  readonly #endpoints = new Map<string, EndpointState>();
  /** Outlives idle endpoints, so what was learned is kept. */
  readonly #limits = new Map<string, AdaptiveLimit>();
  #seq = 0;

  constructor(
    private readonly concurrency: (endpoint: ModelEndpoint) => ConcurrencyRange,
    private readonly now: () => number = Date.now,
    private readonly onInteractiveWait?: (
      endpoint: ModelEndpoint,
      priority: number,
    ) => void,
    /** The Runs holding places on endpoint and why each cannot yield. */
    private readonly describeHolders?: (
      endpoint: ModelEndpoint,
    ) => readonly Record<string, unknown>[],
  ) {}

  /** A model request on endpoint finished, whoever holds its place. */
  observe(endpoint: ModelEndpoint, signal: ModelSignal): void {
    const key = endpointKey(endpoint);
    const limit = this.#limit(key, endpoint);
    const state = this.#endpoints.get(key);
    const active = state?.active ?? 0;
    const saturated = (state?.waiting.length ?? 0) > 0;
    const now = this.now();
    const ended = now - (signal.type === "latency" ? signal.endedMsAgo : 0);
    const started = ended - (signal.type === "latency" ? signal.latencyMs : 0);
    const concurrency = state?.occupancy.over(started, ended) ?? {
      mean: 0,
      peak: 0,
    };
    const { change, latency } = limit.observe(signal, {
      concurrency,
      saturated,
      now,
    });
    if (latency)
      logAgentEvent("debug", "model_queue.latency_sampled", {
        computer_id: endpoint.computerId,
        runtime_type: endpoint.runtimeType,
        source: latency.source,
        ms_per_thousand: Math.round(latency.perThousand),
        ...(latency.baseline === undefined
          ? {}
          : { baseline_ms_per_thousand: Math.round(latency.baseline) }),
        ...(latency.window === undefined
          ? {}
          : { window_ms_per_thousand: Math.round(latency.window) }),
        concurrency: Math.round(concurrency.mean * 10) / 10,
        peak_concurrency: concurrency.peak,
        active,
        waiting: state?.waiting.length ?? 0,
        limit: limit.value,
        ...(limit.ceiling === undefined ? {} : { ceiling: limit.ceiling }),
      });
    if (!change) return;
    logAgentEvent("info", "model_queue.limit_changed", {
      computer_id: endpoint.computerId,
      runtime_type: endpoint.runtimeType,
      from: change.from,
      to: change.to,
      reason: change.reason,
      ...(limit.ceiling === undefined ? {} : { ceiling: limit.ceiling }),
      ...(change.ratio === undefined
        ? {}
        : { ratio: Math.round(change.ratio * 100) / 100 }),
    });
    if (state) this.#drain(state);
  }

  /** Waits for the work's turn; aborting stops waiting. */
  async acquire(
    endpoint: ModelEndpoint,
    work: ModelWork,
    signal: AbortSignal,
  ): Promise<ModelLease> {
    signal.throwIfAborted();
    const queuedAt = Date.now();
    const state = this.#state(endpoint);
    const { priority } = work;
    // A raise keeps the arrival order within the new priority.
    const unsubscribe =
      priority instanceof RunPriority
        ? priority.onRaise(() => this.#drain(state))
        : undefined;
    const value = () =>
      priority instanceof RunPriority ? priority.value : priority;
    let stall: ReturnType<typeof setTimeout> | undefined;
    const watchStall = () => {
      stall = setTimeout(() => {
        if (value() > INTERACTIVE_PRIORITY) return watchStall();
        logAgentEvent("warn", "model_queue.interactive_waiting", {
          kind: work.kind,
          key: work.key.slice(0, 200),
          priority: value(),
          computer_id: endpoint.computerId,
          runtime_type: endpoint.runtimeType,
          waited_ms: Date.now() - queuedAt,
          active: state.active,
          waiting: state.waiting.length,
          limit: this.#limits.get(state.key)?.value,
          holders: this.describeHolders?.(endpoint) ?? [],
        });
      }, INTERACTIVE_STALL_MS);
      stall.unref?.();
    };
    if (priority instanceof RunPriority || priority <= INTERACTIVE_PRIORITY)
      watchStall();
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const index = state.waiting.indexOf(waiter);
          if (index >= 0) state.waiting.splice(index, 1);
          this.#prune(state);
          reject(signal.reason);
        };
        const waiter: Waiter = {
          priority: value,
          seq: this.#seq++,
          signal,
          admit: () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          },
          reject,
          onAbort,
        };
        state.waiting.push(waiter);
        signal.addEventListener("abort", onAbort, { once: true });
        this.#drain(state);
      });
    } finally {
      clearTimeout(stall);
      unsubscribe?.();
    }
    return this.#lease(state, work, queuedAt);
  }

  /** Interactive work first in line and out of places asks for a yield, also
   * when a Run on this endpoint has just become able to yield. */
  recheckInteractiveWait(endpoint: ModelEndpoint): void {
    const state = this.#endpoints.get(endpointKey(endpoint));
    const next = state?.waiting[0];
    const priority = next?.priority();
    if (
      state &&
      priority !== undefined &&
      priority <= INTERACTIVE_PRIORITY &&
      state.active >=
        admissionLimit(this.#limit(state.key, endpoint).value, priority)
    )
      this.onInteractiveWait?.(endpoint, priority);
  }

  /** The Computer is gone; work waiting for it fails with error. */
  rejectWaiters(computerId: string, error: unknown): void {
    for (const state of [...this.#endpoints.values()]) {
      if (state.endpoint.computerId !== computerId) continue;
      for (const waiter of state.waiting.splice(0)) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.reject(error);
      }
      this.#prune(state);
    }
  }

  #state(endpoint: ModelEndpoint): EndpointState {
    const key = endpointKey(endpoint);
    let state = this.#endpoints.get(key);
    if (!state) {
      state = {
        key,
        endpoint,
        active: 0,
        occupancy: new Occupancy(this.now()),
        waiting: [],
      };
      this.#endpoints.set(key, state);
    }
    return state;
  }

  /** The endpoint's limit; it starts over when its models change link. */
  #limit(key: string, endpoint: ModelEndpoint): AdaptiveLimit {
    const range = this.concurrency(endpoint);
    let limit = this.#limits.get(key);
    if (
      !limit ||
      limit.range.initial !== range.initial ||
      limit.range.max !== range.max
    ) {
      limit = new AdaptiveLimit(range);
      this.#limits.set(key, limit);
    }
    return limit;
  }

  /** Admission already counted the unit as active. */
  #lease(state: EndpointState, work: ModelWork, queuedAt: number): ModelLease {
    const startedAt = Date.now();
    let result: ModelLeaseResult | undefined;
    let borrowers = 0;
    const finish = () => {
      if (!result || borrowers > 0) return;
      state.active -= 1;
      state.occupancy.record(this.now(), state.active);
      logAgentEvent("info", "model_queue.finished", {
        kind: work.kind,
        key: work.key.slice(0, 200),
        computer_id: state.endpoint.computerId,
        runtime_type: state.endpoint.runtimeType,
        outcome: result.outcome,
        queued_ms: startedAt - queuedAt,
        run_ms: Date.now() - startedAt,
        limit: this.#limits.get(state.key)?.value,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      });
      this.#drain(state);
    };
    return {
      borrow() {
        if (result) throw new Error("The model lease was released");
        borrowers++;
        let held = true;
        return {
          release() {
            if (!held) return;
            held = false;
            borrowers--;
            finish();
          },
        };
      },
      release(outcome) {
        if (result) return;
        result = outcome;
        finish();
      },
    };
  }

  #drain(state: EndpointState): void {
    state.waiting.sort((a, b) => a.priority() - b.priority() || a.seq - b.seq);
    const limit = this.#limit(state.key, state.endpoint).value;
    while (state.active < limit && state.waiting.length > 0) {
      const next = state.waiting[0]!;
      if (state.active >= admissionLimit(limit, next.priority())) break;
      state.active += 1;
      state.occupancy.record(this.now(), state.active);
      state.waiting.shift();
      next.admit();
    }
    this.recheckInteractiveWait(state.endpoint);
    this.#prune(state);
  }

  #prune(state: EndpointState): void {
    if (
      state.active === 0 &&
      state.waiting.length === 0 &&
      this.#endpoints.get(state.key) === state
    )
      this.#endpoints.delete(state.key);
  }
}

function endpointKey(endpoint: ModelEndpoint): string {
  return `${endpoint.computerId}\n${endpoint.runtimeType}`;
}
