import type {
  RunnerSystemTelemetry as RunnerSystemTelemetryFrame,
  SystemTelemetrySnapshot,
} from "@linger/wire-contracts/runner-gateway/types";
import {
  RUNNER_GATEWAY_PROTOCOL_VERSION,
  parseAgentToDaemonEnvelope,
} from "@linger/wire-contracts/runner-gateway/validator";
import { logAgentEvent } from "../observability/agent-log.js";
import {
  FIRST_SYSTEM_TELEMETRY_COMPUTER_VERSION,
  isComputerVersionAtLeast,
  LocalComputerNotFoundError,
  LocalComputerOfflineError,
} from "./local-computer-management.js";
import { isServingConnection } from "./runner-connections.js";
import type {
  ConnectedRunner,
  RunnerGatewayContext,
  RunnerGatewayControllers,
} from "./runner-gateway-context.js";

/** Target owned Local Computer for system telemetry requests. */
export interface LocalSystemTelemetryTarget {
  readonly tenantId: string;
  readonly ownerActorId: string;
  readonly computerId: string;
  readonly signal?: AbortSignal;
}

/** One revision-stamped telemetry snapshot emitted by a Local Computer. */
export interface LocalSystemTelemetrySnapshotEnvelope {
  readonly computerId: string;
  readonly revision: number;
  readonly observedAt: string;
  readonly snapshot: SystemTelemetrySnapshot;
}

/** Streamed telemetry event delivered to each subscriber. */
export type LocalSystemTelemetryEvent =
  | {
      readonly type: "snapshot";
      readonly envelope: LocalSystemTelemetrySnapshotEnvelope;
    }
  | {
      readonly type: "status";
      readonly computerId: string;
      readonly status: "offline" | "unsupported" | "unavailable";
      readonly code:
        | "LOCAL_COMPUTER_OFFLINE"
        | "SYSTEM_TELEMETRY_UNSUPPORTED"
        | "SYSTEM_TELEMETRY_UNAVAILABLE";
      readonly message: string;
    };

/** One viewer subscription with O(1) latest-snapshot coalescing. */
export interface LocalSystemTelemetrySubscription {
  readonly events: AsyncIterable<LocalSystemTelemetryEvent>;
  close(): void;
}

/** The Computer Daemon or its localmodels kit does not support live-tick telemetry. */
export class SystemTelemetryUnsupportedError extends Error {
  constructor(
    message = "Local Computer does not support live system telemetry",
  ) {
    super(message);
    this.name = "SystemTelemetryUnsupportedError";
  }
}

/** The Computer telemetry collector reported a transient unavailability. */
export class SystemTelemetryUnavailableError extends Error {
  constructor(message = "Local Computer system telemetry is unavailable") {
    super(message);
    this.name = "SystemTelemetryUnavailableError";
  }
}

/** The Computer did not emit a telemetry snapshot before the deadline. */
export class SystemTelemetryTimeoutError extends Error {
  constructor(
    message = "Local Computer did not emit a system telemetry snapshot in time",
  ) {
    super(message);
    this.name = "SystemTelemetryTimeoutError";
  }
}

export interface RunnerSystemTelemetryOptions {
  readonly leaseTtlMs?: number;
  readonly leaseRenewIntervalMs?: number;
  readonly tickIntervalMs?: number;
  readonly snapshotWaitTimeoutMs?: number;
  readonly freshCacheMaxAgeMs?: number;
}

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_LEASE_RENEW_INTERVAL_MS = 10_000;
const DEFAULT_TICK_INTERVAL_MS = 1_000;
const DEFAULT_SNAPSHOT_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_FRESH_CACHE_MAX_AGE_MS = 5_000;

interface TelemetrySubscriber {
  pending: LocalSystemTelemetryEvent | undefined;
  closed: boolean;
  wake?: () => void;
}

interface ComputerTelemetrySession {
  readonly connection: ConnectedRunner;
  lastRevision: number;
  latest?: {
    readonly envelope: LocalSystemTelemetrySnapshotEnvelope;
    readonly receivedAtMs: number;
  };
  readonly subscribers: Set<TelemetrySubscriber>;
  renewTimer?: ReturnType<typeof setInterval>;
}

/**
 * Multiplexes concurrent system telemetry viewers for one Local Computer onto a
 * single renewable Daemon lease, coalescing frames to the latest snapshot per
 * subscriber (O(1) memory) and unsubscribing immediately when the last viewer
 * closes.
 */
export class RunnerSystemTelemetry {
  readonly #sessions = new Map<string, ComputerTelemetrySession>();

  readonly #unsupportedConnections = new WeakMap<ConnectedRunner, string>();

  readonly #leaseTtlMs: number;

  readonly #leaseRenewIntervalMs: number;

  readonly #tickIntervalMs: number;

  readonly #snapshotWaitTimeoutMs: number;

  readonly #freshCacheMaxAgeMs: number;

  constructor(
    private readonly context: RunnerGatewayContext,
    private readonly owners: Pick<RunnerGatewayControllers, "connections">,
    options: RunnerSystemTelemetryOptions = {},
  ) {
    this.#leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.#leaseRenewIntervalMs =
      options.leaseRenewIntervalMs ?? DEFAULT_LEASE_RENEW_INTERVAL_MS;
    this.#tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.#snapshotWaitTimeoutMs =
      options.snapshotWaitTimeoutMs ?? DEFAULT_SNAPSHOT_WAIT_TIMEOUT_MS;
    this.#freshCacheMaxAgeMs =
      options.freshCacheMaxAgeMs ?? DEFAULT_FRESH_CACHE_MAX_AGE_MS;
  }

  /**
   * Returns a cached latest snapshot if an active lease already has a fresh
   * one; otherwise acquires a brief lease to wait for the first live tick and
   * unsubscribes immediately once answered.
   */
  async getSnapshot(
    target: LocalSystemTelemetryTarget,
  ): Promise<LocalSystemTelemetrySnapshotEnvelope> {
    target.signal?.throwIfAborted();
    const connection = this.#requireCapableConnection(target);
    const existing = this.#sessions.get(connection.runnerId);
    if (
      existing &&
      existing.connection === connection &&
      existing.subscribers.size > 0 &&
      existing.latest &&
      Date.now() - existing.latest.receivedAtMs <= this.#freshCacheMaxAgeMs
    ) {
      return existing.latest.envelope;
    }

    const subscription = await this.subscribe(target);
    const signal = target.signal;
    let timedOut = false;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      subscription.close();
    };
    if (signal) {
      if (signal.aborted) {
        subscription.close();
        throw signal.reason;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      subscription.close();
    }, this.#snapshotWaitTimeoutMs);
    timer.unref();

    try {
      for await (const event of subscription.events) {
        if (event.type === "snapshot") {
          return event.envelope;
        }
        if (event.code === "LOCAL_COMPUTER_OFFLINE") {
          throw new LocalComputerOfflineError(event.message);
        }
        if (event.code === "SYSTEM_TELEMETRY_UNSUPPORTED") {
          throw new SystemTelemetryUnsupportedError(event.message);
        }
        throw new SystemTelemetryUnavailableError(event.message);
      }
      if (aborted && signal) {
        throw signal.reason;
      }
      if (timedOut) {
        throw new SystemTelemetryTimeoutError();
      }
      throw new LocalComputerOfflineError();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      subscription.close();
    }
  }

  /**
   * Attaches a coalesced viewer stream for a connected, capable Local Computer.
   * The first subscriber starts a Daemon lease; subsequent subscribers share
   * that single lease. Closing the last subscriber sends unsubscribe at once.
   */
  async subscribe(
    target: LocalSystemTelemetryTarget,
  ): Promise<LocalSystemTelemetrySubscription> {
    target.signal?.throwIfAborted();
    const connection = this.#requireCapableConnection(target);
    const existingSession = this.#sessions.get(connection.runnerId);
    const isFirstSubscriber =
      !existingSession || existingSession.connection !== connection;
    let session: ComputerTelemetrySession;
    if (isFirstSubscriber) {
      if (existingSession) {
        this.#teardownSession(existingSession, false);
      }
      session = {
        connection,
        lastRevision: 0,
        subscribers: new Set(),
      };
      this.#sessions.set(connection.runnerId, session);
    } else {
      session = existingSession;
    }

    const subscriber: TelemetrySubscriber = {
      pending: session.latest
        ? { type: "snapshot", envelope: session.latest.envelope }
        : undefined,
      closed: false,
    };
    session.subscribers.add(subscriber);

    const ownedSession = session;
    const close = (): void => {
      if (subscriber.closed) return;
      subscriber.closed = true;
      subscriber.pending = undefined;
      ownedSession.subscribers.delete(subscriber);
      const wake = subscriber.wake;
      subscriber.wake = undefined;
      wake?.();
      if (
        ownedSession.subscribers.size === 0 &&
        this.#sessions.get(connection.runnerId) === ownedSession
      ) {
        this.#teardownSession(ownedSession, true);
      }
    };

    if (isFirstSubscriber) {
      try {
        await this.#sendSubscribe(connection);
      } catch (error) {
        close();
        throw error instanceof LocalComputerOfflineError
          ? error
          : new LocalComputerOfflineError();
      }
      // If the subscriber closed while the first subscribe frame was in flight,
      // teardown already ran; only arm renewal when still active.
      if (
        !subscriber.closed &&
        this.#sessions.get(connection.runnerId) === ownedSession
      ) {
        ownedSession.renewTimer = setInterval(() => {
          if (
            ownedSession.subscribers.size === 0 ||
            this.#sessions.get(connection.runnerId) !== ownedSession
          ) {
            return;
          }
          void this.#sendSubscribe(connection).catch((err) => {
            logAgentEvent("warn", "runner.system_telemetry.renew_failed", {
              runner_id: connection.runnerId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }, this.#leaseRenewIntervalMs);
        ownedSession.renewTimer.unref();
      }
    }

    const events: AsyncIterable<LocalSystemTelemetryEvent> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          while (true) {
            if (subscriber.pending !== undefined) {
              const value = subscriber.pending;
              subscriber.pending = undefined;
              return { value, done: false };
            }
            if (subscriber.closed) {
              return { value: undefined, done: true };
            }
            await new Promise<void>((resolve) => {
              subscriber.wake = resolve;
            });
          }
        },
        return: async () => {
          close();
          return { value: undefined, done: true };
        },
      }),
    };

    return { events, close };
  }

  /** Handles one runner.system_telemetry frame emitted by the Computer Daemon. */
  receiveFrame(
    connection: ConnectedRunner,
    frame: RunnerSystemTelemetryFrame,
  ): void {
    if (frame.connection_epoch !== connection.connectionEpoch) {
      return;
    }
    const session = this.#sessions.get(connection.runnerId);
    if (!session || session.connection !== connection) {
      return;
    }
    if (frame.revision <= session.lastRevision) {
      return;
    }
    session.lastRevision = frame.revision;

    if (frame.status === "ok" && frame.snapshot) {
      const envelope: LocalSystemTelemetrySnapshotEnvelope = {
        computerId: connection.runnerId,
        revision: frame.revision,
        observedAt: frame.sent_at,
        snapshot: frame.snapshot,
      };
      session.latest = { envelope, receivedAtMs: Date.now() };
      this.#broadcast(session, { type: "snapshot", envelope }, false);
      return;
    }

    if (frame.status === "unsupported") {
      const message =
        frame.reason?.detail ||
        "Local Computer does not support live system telemetry";
      this.#unsupportedConnections.set(connection, message);
      this.#broadcast(
        session,
        {
          type: "status",
          computerId: connection.runnerId,
          status: "unsupported",
          code: "SYSTEM_TELEMETRY_UNSUPPORTED",
          message,
        },
        true,
      );
      this.#teardownSession(session, false);
      return;
    }

    const message =
      frame.reason?.detail || "Local Computer system telemetry is unavailable";
    this.#broadcast(
      session,
      {
        type: "status",
        computerId: connection.runnerId,
        status: "unavailable",
        code: "SYSTEM_TELEMETRY_UNAVAILABLE",
        message,
      },
      false,
    );
  }

  /** Closes all active telemetry subscribers for a disconnected connection. */
  disconnected(connection: ConnectedRunner): void {
    const session = this.#sessions.get(connection.runnerId);
    if (!session || session.connection !== connection) {
      return;
    }
    this.#broadcast(
      session,
      {
        type: "status",
        computerId: connection.runnerId,
        status: "offline",
        code: "LOCAL_COMPUTER_OFFLINE",
        message: "Local Computer went offline",
      },
      true,
    );
    this.#teardownSession(session, false);
  }

  #requireCapableConnection(
    target: LocalSystemTelemetryTarget,
  ): ConnectedRunner {
    const connection = this.owners
      .connections()
      .getConnection(target.computerId);
    if (!isServingConnection(connection)) {
      throw new LocalComputerOfflineError();
    }
    if (connection.tenantOwners.get(target.tenantId) !== target.ownerActorId) {
      throw new LocalComputerNotFoundError();
    }
    if (
      !isComputerVersionAtLeast(
        connection.hello.daemon_version,
        FIRST_SYSTEM_TELEMETRY_COMPUTER_VERSION,
      )
    ) {
      throw new SystemTelemetryUnsupportedError(
        "Update Local Computer to enable live system telemetry",
      );
    }
    const unsupportedReason = this.#unsupportedConnections.get(connection);
    if (unsupportedReason !== undefined) {
      throw new SystemTelemetryUnsupportedError(unsupportedReason);
    }
    return connection;
  }

  #broadcast(
    session: ComputerTelemetrySession,
    event: LocalSystemTelemetryEvent,
    closeSubscribers: boolean,
  ): void {
    for (const subscriber of [...session.subscribers]) {
      // Coalesce: overwrite any undrained event with the newest state so slow
      // clients never accumulate unbounded buffers.
      subscriber.pending = event;
      if (closeSubscribers) {
        subscriber.closed = true;
        session.subscribers.delete(subscriber);
      }
      const wake = subscriber.wake;
      subscriber.wake = undefined;
      wake?.();
    }
  }

  #teardownSession(
    session: ComputerTelemetrySession,
    sendUnsubscribe: boolean,
  ): void {
    if (session.renewTimer) {
      clearInterval(session.renewTimer);
      session.renewTimer = undefined;
    }
    session.latest = undefined;
    if (this.#sessions.get(session.connection.runnerId) === session) {
      this.#sessions.delete(session.connection.runnerId);
    }
    if (sendUnsubscribe && session.connection.connected) {
      void this.#sendUnsubscribe(session.connection).catch((err) => {
        logAgentEvent("warn", "runner.system_telemetry.unsubscribe_failed", {
          runner_id: session.connection.runnerId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  async #sendSubscribe(connection: ConnectedRunner): Promise<void> {
    const envelope = parseAgentToDaemonEnvelope({
      type: "capability.system_telemetry.subscribe",
      protocol_version: RUNNER_GATEWAY_PROTOCOL_VERSION,
      command_id: this.context.createId(),
      runner_id: connection.runnerId,
      connection_epoch: connection.connectionEpoch,
      lease_ttl_ms: this.#leaseTtlMs,
      interval_ms: this.#tickIntervalMs,
    });
    await this.owners.connections().send(connection, envelope);
  }

  async #sendUnsubscribe(connection: ConnectedRunner): Promise<void> {
    const envelope = parseAgentToDaemonEnvelope({
      type: "capability.system_telemetry.unsubscribe",
      protocol_version: RUNNER_GATEWAY_PROTOCOL_VERSION,
      command_id: this.context.createId(),
      runner_id: connection.runnerId,
      connection_epoch: connection.connectionEpoch,
    });
    await this.owners.connections().send(connection, envelope);
  }
}
