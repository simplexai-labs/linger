/**
 * Every kind of model call, and how call management treats it. Adding a kind
 * of model call is adding a policy row.
 */

/** One-shot calls and chains; the only kinds the HTTP contract accepts. */
const modelCallKinds = [
  "approval",
  "voice_ask",
  "meeting_notes",
  "memory",
  "agent_memory",
  "wiki",
  "profile",
  "insight",
] as const;
export type ModelCallKind = (typeof modelCallKinds)[number];

/** What queued a Run. */
export type RunKind =
  | "chat"
  | "agent_message"
  | "task"
  | "task_callback"
  | "routine"
  | "proactive"
  | "follow_up"
  | "document";

/** Smaller priorities go first. Interactive work may use the last place and
 * swaps out a running Run of a lower priority when it cannot start. A Meta
 * Run's work either answers someone or reports to them, so all of it goes
 * before Tasks and Documents. Among kinds of one priority, the earlier listed
 * one names a merged Run. */
export const runPriorities: Readonly<Record<RunKind, number>> = {
  chat: 10,
  task_callback: 11,
  agent_message: 11,
  follow_up: 11,
  routine: 11,
  proactive: 11,
  task: 12,
  document: 12,
};

/** Work at or before this priority is interactive: it may take the last
 * place and asks lower work holding a place to yield. */
export const INTERACTIVE_PRIORITY = 11;

/**
 * A Run's queue priority. It only rises while the Run lives, as input someone
 * waits on more joins it, and every wait for a place re-ranks when it does.
 */
export class RunPriority {
  #value: number;
  readonly #listeners = new Set<() => void>();

  constructor(value: number) {
    this.#value = value;
  }

  get value(): number {
    return this.#value;
  }

  /** Moves the Run up to priority; an equal or lower priority changes nothing. */
  raise(priority: number): void {
    if (priority >= this.#value) return;
    this.#value = priority;
    for (const listener of [...this.#listeners]) listener();
  }

  /** Calls listener after each raise until the returned function is called. */
  onRaise(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
export interface ModelLeaseResult {
  readonly outcome: string;
  /** Token usage as the Runtime reported it; only logged. */
  readonly usage?: unknown;
}

export interface ModelLease {
  /** A sent approval or chain step keeps the place until its Runtime reply. */
  borrow(): Pick<ModelLease, "release">;
  /** Frees the place once all borrowers finish. Later calls do nothing. */
  release(result: ModelLeaseResult): void;
}

/** A bounded Computer resolves an unknown Meta priority only when work contends. */
export type CapacityPriority =
  | number
  | RunPriority
  | {
      /** Monotonic arrival time retained across priority refreshes for this wait. */
      readonly queuedAt: number;
      resolve(): Promise<number>;
    };

/** A question or the notes of a recording go before chat. */
export const RECORDING_PRIORITY = 5;

export const COMPACTION_PRIORITY = 20;

export function softLimit(hard: number): number {
  return Math.max(1, hard - 1);
}

export function admissionLimit(hard: number, priority: number): number {
  return priority <= INTERACTIVE_PRIORITY ? hard : softLimit(hard);
}

export interface ModelCallPolicy {
  /** Smaller numbers start first, in arrival order within one priority. */
  readonly priority: number;
  /** Someone waits on the answer: the call stops once nobody waits, and
   * over HTTP it never answers pending. */
  readonly interactive: boolean;
  /** Runtime attempts of one call, a lone call or a chain's, corrections
   * included. Callers do not retry a call themselves. */
  readonly attempts: number;
  /** One Runtime attempt when the request names none. The Runtime counts it
   * from the attempt's start, so waiting for a place never counts. */
  readonly timeoutMs: number;
}

export const modelCallPolicies: Readonly<
  Record<ModelCallKind, ModelCallPolicy>
> = {
  approval: {
    priority: 0,
    interactive: true,
    attempts: 1,
    timeoutMs: 15_000,
  },
  voice_ask: {
    priority: RECORDING_PRIORITY,
    interactive: true,
    attempts: 1,
    timeoutMs: 45_000,
  },
  meeting_notes: {
    priority: RECORDING_PRIORITY,
    interactive: true,
    attempts: 1,
    timeoutMs: 60_000,
  },
  agent_memory: {
    priority: 30,
    interactive: false,
    attempts: 2,
    timeoutMs: 10 * 60_000,
  },
  memory: {
    priority: 40,
    interactive: false,
    attempts: 3,
    timeoutMs: 10 * 60_000,
  },
  profile: {
    priority: 50,
    interactive: false,
    attempts: 2,
    timeoutMs: 2 * 60_000,
  },
  insight: {
    priority: 60,
    interactive: false,
    attempts: 2,
    timeoutMs: 2 * 60_000,
  },
  wiki: {
    priority: 70,
    interactive: false,
    attempts: 2,
    timeoutMs: 10 * 60_000,
  },
};

export function isModelCallKind(value: unknown): value is ModelCallKind {
  return (
    typeof value === "string" &&
    (modelCallKinds as readonly string[]).includes(value)
  );
}

/** Whether kind is a yieldable background model call. */
export function isBackgroundModelCall(kind: string): boolean {
  return isModelCallKind(kind) && !modelCallPolicies[kind].interactive;
}
