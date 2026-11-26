import { TeamHubRuntimeStateError } from "../executor/teamhub-runtime-state-client.js";
import { logAgentEvent } from "../observability/agent-log.js";

interface SnapshotQueue<TSnapshot> {
  next: TSnapshot | undefined;
  /** Ends a retry delay early: a newer snapshot is written at once. */
  wake?: () => void;
}

// A snapshot TeamHub failed to store is written again after these delays.
const FIRST_RECORD_RETRY_MS = 1_000;
const MAX_RECORD_RETRY_MS = 60_000;

/**
 * Coalesces per-Computer snapshots so TeamHub receives one Computer's updates
 * one at a time, newest last, retrying retryable failures with backoff until
 * stored or superseded by a newer snapshot.
 */
export class RunnerSnapshotRelay<TSnapshot> {
  readonly #queues = new Map<string, SnapshotQueue<TSnapshot>>();

  constructor(
    private readonly recordFailureEvent: string,
    private readonly record: (
      computerId: string,
      snapshot: TSnapshot,
    ) => Promise<void>,
  ) {}

  enqueue(computerId: string, snapshot: TSnapshot): void {
    const queue = this.#queues.get(computerId);
    if (queue) {
      queue.next = snapshot;
      queue.wake?.();
      return;
    }
    const started: SnapshotQueue<TSnapshot> = { next: snapshot };
    this.#queues.set(computerId, started);
    void this.#drain(computerId, started);
  }

  async #drain(
    computerId: string,
    queue: SnapshotQueue<TSnapshot>,
  ): Promise<void> {
    let retryMs = FIRST_RECORD_RETRY_MS;
    for (
      let snapshot = queue.next;
      snapshot !== undefined;
      snapshot = queue.next
    ) {
      queue.next = undefined;
      try {
        await this.record(computerId, snapshot);
        retryMs = FIRST_RECORD_RETRY_MS;
      } catch (error) {
        const retryable = !(
          error instanceof TeamHubRuntimeStateError && !error.retryable
        );
        logAgentEvent("warn", this.recordFailureEvent, {
          runnerId: computerId,
          retryable,
          error: error instanceof Error ? error.message : String(error),
        });
        // The Computer reports again only when state changes, so the unsaved
        // snapshot is kept until TeamHub stores it; a newer one that arrives
        // meanwhile replaces it.
        if (!retryable || queue.next !== undefined) continue;
        queue.next = snapshot;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, retryMs);
          timer.unref();
          queue.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        queue.wake = undefined;
        retryMs = Math.min(2 * retryMs, MAX_RECORD_RETRY_MS);
      }
    }
    this.#queues.delete(computerId);
  }
}
