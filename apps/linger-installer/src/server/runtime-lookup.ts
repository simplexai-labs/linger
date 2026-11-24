import type { RuntimeDescriptor } from "@linger/local-installation/managed-runtimes";

/** How long a finished lookup answers again without probing. */
export const RUNTIME_LOOKUP_RETAIN_MS = 10 * 60_000;

type Lookup<T> = (
  name: string,
  descriptors: RuntimeDescriptor[] | undefined,
) => Promise<T>;

interface Entry<T> {
  generation: number;
  result: Promise<T>;
  settledAt?: number;
}

/**
 * The runtime paths the desktop asks for once an install finishes. On
 * Windows that lookup can run for minutes (a runtime status probe, then
 * private file and pinned tool checks), and the desktop may stop waiting
 * before it ends. Each instance runs one lookup at a time; a caller who asks
 * again joins it, and a finished answer is kept for a while, so a retry or
 * a relaunch picks up work that finished after the first caller left
 * instead of starting it over. The runtime descriptors an install inspected
 * stand in for a second status probe, as on the desktop's resume path.
 * Starting or finishing an install forgets both.
 */
export class RuntimeLookups<T> {
  readonly #lookup: Lookup<T>;
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry<T>>();
  readonly #descriptors = new Map<string, RuntimeDescriptor[]>();
  readonly #generations = new Map<string, number>();

  constructor(lookup: Lookup<T>, options: { now?: () => number } = {}) {
    this.#lookup = lookup;
    this.#now = options.now ?? Date.now;
  }

  get(name: string): Promise<T> {
    const generation = this.#generations.get(name) ?? 0;
    const current = this.#entries.get(name);
    if (
      current &&
      current.generation === generation &&
      (current.settledAt === undefined ||
        this.#now() - current.settledAt < RUNTIME_LOOKUP_RETAIN_MS)
    )
      return current.result;
    const entry: Entry<T> = {
      generation,
      result: this.#lookup(name, this.#descriptors.get(name)),
    };
    this.#entries.set(name, entry);
    entry.result.then(
      () => {
        entry.settledAt = this.#now();
      },
      () => {
        // A failed lookup is asked again by the next caller.
        if (this.#entries.get(name) === entry) this.#entries.delete(name);
      },
    );
    return entry.result;
  }

  /** An install for the instance starts or ends: what it changed is unknown. */
  invalidate(name: string): void {
    this.#generations.set(name, (this.#generations.get(name) ?? 0) + 1);
    this.#entries.delete(name);
    this.#descriptors.delete(name);
  }

  /** Runtime descriptors an install of the instance just inspected. */
  remember(name: string, descriptors: RuntimeDescriptor[]): void {
    this.#descriptors.set(name, descriptors);
  }
}
