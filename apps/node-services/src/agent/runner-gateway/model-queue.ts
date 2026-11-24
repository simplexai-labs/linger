import {
  admissionLimit,
  INTERACTIVE_PRIORITY,
  isBackgroundModelCall,
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
import type { LocalModelsSnapshot } from "@linger/wire-contracts/runner-gateway/types";
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

function probedConcurrencyRange(limit: number): ConcurrencyRange {
  if (limit <= 1) {
    return { initial: 1, max: 1 };
  }
  return { initial: limit, max: Math.max(limit, API_CONCURRENCY.max) };
}

/**
 * Units an endpoint runs at once, from where it starts to how far probing may
 * take it. The signed-in account serves many requests and starts high. Local
 * library models on Computers supporting concurrency probing carry a verified
 * post-load concurrency (`concurrency`): a verified 1 stays capped at 1, while
 * verified >= 2 starts at that limit and still allows adaptive probing up to
 * the API ceiling. Other API links start at one and grow only while requests
 * stay as fast.
 */
export function endpointConcurrency(
  models:
    | readonly (Pick<LocalComputerModel, "link" | "concurrency"> & {
        readonly id?: string;
      })[]
    | undefined,
  localModels?: LocalModelsSnapshot,
): ConcurrencyRange {
  if (models?.length && models.every(({ link }) => link === "subscription")) {
    return SUBSCRIPTION_CONCURRENCY;
  }
  const explicitConcurrencies =
    models
      ?.map((model) => model.concurrency)
      .filter(
        (concurrency): concurrency is number =>
          concurrency !== undefined &&
          Number.isSafeInteger(concurrency) &&
          concurrency >= 1,
      ) ?? [];
  if (explicitConcurrencies.length > 0) {
    return probedConcurrencyRange(Math.min(...explicitConcurrencies));
  }
  const libraryRows = localModels?.available ? localModels.models : undefined;
  if (!models?.length && libraryRows?.length) {
    const loadedConcurrencies = libraryRows
      .filter((row) => row.state === "loaded")
      .map((row) => row.concurrency)
      .filter(
        (concurrency): concurrency is number =>
          concurrency !== undefined &&
          Number.isSafeInteger(concurrency) &&
          concurrency >= 1,
      );
    if (loadedConcurrencies.length > 0) {
      return probedConcurrencyRange(Math.min(...loadedConcurrencies));
    }
  }
  return API_CONCURRENCY;
}

interface Waiter {
  readonly kind: string;
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
  /** Active units that are not yieldable background calls. */
  activeNonBackground: number;
  /** A timed request lies within its unit's place, so the history never
   * needs to outlive an idle endpoint. */
  readonly occupancy: Occupancy;
  readonly waiting: Waiter[];
}

/**
 * Admits model work per endpoint. A Run Operation, a model attempt and a
 * compaction each occupy one place. Smaller priority numbers start first,
 * in arrival order within a priority. When the confirmed limit exceeds one,
 * interactive work may fill the last place. When it cannot start, it asks
 * lower-priority work holding places to yield.
 * The confirmed limit grows only through silent background probes while no
 * higher work is active or waiting, and backs off when requests slow down or
 * fail. Admission only; it never picks, orders or retries a Run.
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
      count: number,
    ) => void,
    /** The Runs holding places on endpoint and why each cannot yield. */
    private readonly describeHolders?: (
      endpoint: ModelEndpoint,
    ) => readonly Record<string, unknown>[],
    /** Whether background calls on endpoint can be stopped for interactive work. */
    private readonly canYieldBackground: (
      endpoint: ModelEndpoint,
    ) => boolean = () => true,
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
    const { change, probeFailure, latency } = limit.observe(signal, {
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
        ...(limit.probing === undefined ? {} : { probing: limit.probing }),
        ...(limit.ceiling === undefined ? {} : { ceiling: limit.ceiling }),
      });
    if (probeFailure)
      logAgentEvent("info", "model_queue.probe_stopped", {
        computer_id: endpoint.computerId,
        runtime_type: endpoint.runtimeType,
        limit: limit.value,
        probing: probeFailure.probing,
        outcome: "failed",
        reason: probeFailure.reason,
        ...(limit.ceiling === undefined ? {} : { ceiling: limit.ceiling }),
        ...(probeFailure.ratio === undefined
          ? {}
          : { ratio: Math.round(probeFailure.ratio * 100) / 100 }),
      });
    if (change) {
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
      return;
    }
    if (state && !limit.probing && limit.canStartProbe(now)) this.#drain(state);
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
          kind: work.kind,
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

  /** Waiting work first in line and blocked asks lower work holding places to
   * yield: interactive work clears a place, and non-background work trims
   * background calls left above its steady-state cap after a probe aborts. */
  recheckInteractiveWait(endpoint: ModelEndpoint): void {
    const state = this.#endpoints.get(endpointKey(endpoint));
    const next = state?.waiting[0];
    const priority = next?.priority();
    if (!state || !next || priority === undefined) return;
    const confirmed = this.#limit(state.key, endpoint).value;
    const cap = admissionLimit(confirmed, priority);
    if (priority <= INTERACTIVE_PRIORITY) {
      if (state.active >= cap) {
        this.onInteractiveWait?.(endpoint, priority, state.active - cap + 1);
      }
      return;
    }
    if (
      !isBackgroundModelCall(next.kind) &&
      state.activeNonBackground === 0 &&
      state.active > cap
    ) {
      this.onInteractiveWait?.(endpoint, priority, state.active - cap);
    }
  }

  /** Re-evaluates the endpoint limit after models or local-model probe state change and wakes waiters. */
  refreshEndpoint(endpoint: ModelEndpoint): void {
    const key = endpointKey(endpoint);
    const state = this.#endpoints.get(key);
    if (state) {
      this.#drain(state);
      return;
    }
    if (this.#limits.has(key)) {
      this.#limit(key, endpoint);
    }
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
        activeNonBackground: 0,
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
    const nonBackground = !isBackgroundModelCall(work.kind);
    let result: ModelLeaseResult | undefined;
    let borrowers = 0;
    const finish = () => {
      if (!result || borrowers > 0) return;
      state.active -= 1;
      if (nonBackground) state.activeNonBackground -= 1;
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
    const limit = this.#limit(state.key, state.endpoint);
    const now = this.now();
    const backgroundOnly =
      state.activeNonBackground === 0 &&
      !state.waiting.some((waiter) => !isBackgroundModelCall(waiter.kind)) &&
      this.canYieldBackground(state.endpoint);
    if (!backgroundOnly && limit.probing !== undefined) {
      const aborted = limit.abortProbe();
      if (aborted !== undefined)
        logAgentEvent("info", "model_queue.probe_stopped", {
          computer_id: state.endpoint.computerId,
          runtime_type: state.endpoint.runtimeType,
          limit: limit.value,
          probing: aborted,
          outcome: "aborted",
        });
    }
    if (
      backgroundOnly &&
      limit.probing === undefined &&
      state.active + state.waiting.length >= limit.value + 1 &&
      limit.canStartProbe(now)
    ) {
      const probing = limit.startProbe();
      if (probing !== undefined)
        logAgentEvent("info", "model_queue.probe_started", {
          computer_id: state.endpoint.computerId,
          runtime_type: state.endpoint.runtimeType,
          limit: limit.value,
          probing,
        });
    }
    const confirmed = limit.value;
    const probing = limit.probing;
    while (state.waiting.length > 0) {
      const next = state.waiting[0]!;
      const cap =
        probing !== undefined && isBackgroundModelCall(next.kind)
          ? probing
          : admissionLimit(confirmed, next.priority());
      if (state.active >= cap) break;
      state.active += 1;
      if (!isBackgroundModelCall(next.kind)) state.activeNonBackground += 1;
      state.occupancy.record(now, state.active);
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
    ) {
      const limit = this.#limits.get(state.key);
      const aborted = limit?.abortProbe();
      if (aborted !== undefined)
        logAgentEvent("info", "model_queue.probe_stopped", {
          computer_id: state.endpoint.computerId,
          runtime_type: state.endpoint.runtimeType,
          limit: limit!.value,
          probing: aborted,
          outcome: "aborted",
        });
      this.#endpoints.delete(state.key);
    }
  }
}

function endpointKey(endpoint: ModelEndpoint): string {
  return `${endpoint.computerId}\n${endpoint.runtimeType}`;
}
