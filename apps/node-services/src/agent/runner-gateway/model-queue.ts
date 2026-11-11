import { COMPACTION_PRIORITY } from "../../model-tasks.js";
import { logAgentEvent } from "../observability/agent-log.js";
import {
  AdaptiveLimit,
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
  /** Lowest first; see model-tasks. */
  readonly priority: number;
  /** What the work is: a call kind, a Run kind or compaction. Only logged. */
  readonly kind: string;
  /** Names the work in the log. */
  readonly key: string;
}

export interface ModelLeaseResult {
  readonly outcome: string;
  /** Token usage as the Runtime reported it; only logged. */
  readonly usage?: unknown;
}

export interface ModelLease {
  /** Frees the place; later calls do nothing. */
  release(result: ModelLeaseResult): void;
}

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

/** Work after compaction; it never takes an endpoint's last place. */
function isBackground(priority: number): boolean {
  return priority > COMPACTION_PRIORITY;
}

interface Waiter {
  readonly priority: number;
  readonly background: boolean;
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
  /** Running background units, also counted in active. */
  background: number;
  readonly waiting: Waiter[];
}

/**
 * Admits model work per endpoint. A Run's Operation, a one-shot call, a
 * chain and a compaction are each one unit. Units start lowest priority
 * first, in arrival order within one priority, while the endpoint runs fewer
 * than its limit; a running unit is never interrupted. Background work
 * leaves the last place to Runs and compaction once the limit is above one.
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
  ) {}

  /** A model request on endpoint finished, whoever holds its place. */
  observe(endpoint: ModelEndpoint, signal: ModelSignal): void {
    const key = endpointKey(endpoint);
    const limit = this.#limit(key, endpoint);
    const state = this.#endpoints.get(key);
    const active = state?.active ?? 0;
    const saturated = (state?.waiting.length ?? 0) > 0;
    const { change, latency } = limit.observe(signal, {
      active,
      saturated,
      now: this.now(),
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
        active,
        waiting: state?.waiting.length ?? 0,
        limit: limit.value,
      });
    if (!change) return;
    logAgentEvent("info", "model_queue.limit_changed", {
      computer_id: endpoint.computerId,
      runtime_type: endpoint.runtimeType,
      from: change.from,
      to: change.to,
      reason: change.reason,
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
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = state.waiting.indexOf(waiter);
        if (index >= 0) state.waiting.splice(index, 1);
        this.#prune(state);
        reject(signal.reason);
      };
      const waiter: Waiter = {
        priority: work.priority,
        background: isBackground(work.priority),
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
    return this.#lease(state, work, queuedAt, isBackground(work.priority));
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
      state = { key, endpoint, active: 0, background: 0, waiting: [] };
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
  #lease(
    state: EndpointState,
    work: ModelWork,
    queuedAt: number,
    background: boolean,
  ): ModelLease {
    const startedAt = Date.now();
    let released = false;
    return {
      release: (result) => {
        if (released) return;
        released = true;
        state.active -= 1;
        if (background) state.background -= 1;
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
      },
    };
  }

  #drain(state: EndpointState): void {
    state.waiting.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    const limit = this.#limit(state.key, state.endpoint).value;
    while (state.active < limit && state.waiting.length > 0) {
      const next = state.waiting[0]!;
      // Sorted foreground first, so every waiter after this one is
      // background too.
      if (next.background && limit > 1 && state.background >= limit - 1) break;
      // Counted now, so the next waiter sees the place taken.
      state.active += 1;
      if (next.background) state.background += 1;
      state.waiting.shift();
      next.admit();
    }
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
