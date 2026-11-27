import type {
  CapabilityLocalModelsAccepted,
  CapabilityLocalModelsRefused,
  DaemonToAgentEnvelope,
  LocalModelActionRefusal,
  LocalModelsSnapshot,
  RunnerLocalModels as RunnerLocalModelsFrame,
} from "@linger/wire-contracts/runner-gateway/types";
import {
  RUNNER_GATEWAY_PROTOCOL_VERSION,
  parseAgentToDaemonEnvelope,
} from "@linger/wire-contracts/runner-gateway/validator";
import { logAgentEvent } from "../observability/agent-log.js";
import {
  LocalComputerCapabilityError,
  LocalComputerNotFoundError,
  LocalComputerOfflineError,
} from "./local-computer-management.js";
import { isServingConnection } from "./runner-connections.js";
import type {
  ConnectedRunner,
  RunnerGatewayContext,
  RunnerGatewayControllers,
} from "./runner-gateway-context.js";
import { RunnerGatewayProtocolError } from "./runner-operation.js";
import { RunnerSnapshotRelay } from "./runner-snapshot-relay.js";

export type LocalModelActionKind =
  | "download"
  | "cancel"
  | "load"
  | "unload"
  | "remove"
  | "refresh";

/** One action on an owned Computer's model library. */
export interface LocalModelActionCommand {
  readonly tenantId: string;
  readonly ownerActorId: string;
  readonly computerId: string;
  readonly action: LocalModelActionKind;
  /** Absent only for refresh. */
  readonly modelId?: string;
  /** Only for load. */
  readonly unloadFirst?: readonly string[];
  readonly expiresAt: string;
  readonly signal?: AbortSignal;
}

/** The Computer's immediate answer; progress arrives only as snapshots. */
export type LocalModelActionAck =
  | { readonly outcome: "accepted" }
  | { readonly outcome: "refused"; readonly refusal: LocalModelActionRefusal };

/** The Computer did not answer an action before it expired. */
export class LocalModelsActionTimeoutError extends Error {
  constructor() {
    super("Local Computer did not answer the local-models action");
    this.name = "LocalModelsActionTimeoutError";
  }
}

type LocalModelsOutcome =
  | CapabilityLocalModelsAccepted
  | CapabilityLocalModelsRefused;

interface ActionWaiter {
  readonly connection: ConnectedRunner;
  readonly action: LocalModelActionKind;
  readonly modelId: string | undefined;
  readonly resolve: (outcome: LocalModelsOutcome) => void;
  readonly reject: (error: unknown) => void;
}

// The Computer answers once localmodels has validated the action, which can
// take a few seconds. Past the command's expiry (and never past this bound)
// the action is unconfirmed, not refused: the Computer may still run it, and
// its snapshots show the outcome.
const MAX_ACTION_ACK_WAIT_MS = 30_000;

/**
 * Relays a Computer's model library to TeamHub and its actions to the
 * Computer. The Computer reports each library change as a runner.local_models
 * snapshot; this keeps only the newest one per Computer in flight, so TeamHub
 * receives one Computer's snapshots one at a time and never an older one last.
 */
export class RunnerLocalModels {
  readonly #waiters = new Map<string, ActionWaiter>();

  readonly #snapshotRelay: RunnerSnapshotRelay<LocalModelsSnapshot>;

  constructor(
    private readonly context: RunnerGatewayContext,
    private readonly owners: Pick<
      RunnerGatewayControllers,
      "connections" | "queue"
    >,
  ) {
    this.#snapshotRelay = new RunnerSnapshotRelay(
      "runner.local_models.record_failed",
      async (computerId, snapshot) => {
        await this.context.computerRegistry?.recordLocalModels(
          computerId,
          snapshot,
        );
      },
    );
  }

  receiveSnapshot(
    connection: ConnectedRunner,
    frame: RunnerLocalModelsFrame,
  ): void {
    if (frame.revision <= connection.localModelsRevision) {
      logAgentEvent("warn", "runner.local_models.stale", {
        runnerId: connection.runnerId,
        revision: frame.revision,
        currentRevision: connection.localModelsRevision,
      });
      return;
    }
    connection.localModelsRevision = frame.revision;
    connection.localModelsSnapshot = frame.local_models;
    this.owners.queue().refreshEndpoint({
      computerId: connection.runnerId,
      runtimeType: "pi",
    });
    this.#snapshotRelay.enqueue(connection.runnerId, frame.local_models);
  }

  /**
   * Sends one action and waits for the Computer's accept or refusal. Only a
   * connection that reported a library takes actions: an older Computer
   * would treat the unknown command as a protocol error.
   */
  async act(command: LocalModelActionCommand): Promise<LocalModelActionAck> {
    command.signal?.throwIfAborted();
    const connection = this.owners
      .connections()
      .getConnection(command.computerId);
    if (!isServingConnection(connection)) {
      throw new LocalComputerOfflineError();
    }
    if (
      connection.tenantOwners.get(command.tenantId) !== command.ownerActorId
    ) {
      throw new LocalComputerNotFoundError();
    }
    if (connection.localModelsRevision === 0) {
      throw new LocalComputerCapabilityError(
        "Local Computer has not reported a model library",
      );
    }
    const commandId = this.context.createId();
    const envelope = parseAgentToDaemonEnvelope({
      type: "execute",
      kind: "local_models",
      protocol_version: RUNNER_GATEWAY_PROTOCOL_VERSION,
      command_id: commandId,
      runner_id: command.computerId,
      tenant_id: command.tenantId,
      owner_actor_id: command.ownerActorId,
      connection_epoch: connection.connectionEpoch,
      expires_at: command.expiresAt,
      action: command.action,
      ...(command.modelId === undefined ? {} : { model_id: command.modelId }),
      ...(command.unloadFirst === undefined
        ? {}
        : { unload_first: [...command.unloadFirst] }),
    });
    const signal = command.signal;
    let onAbort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = new Promise<LocalModelsOutcome>((resolve, reject) => {
      const waitMs = Math.min(
        MAX_ACTION_ACK_WAIT_MS,
        Math.max(0, Date.parse(command.expiresAt) - Date.now()),
      );
      timer = setTimeout(
        () => reject(new LocalModelsActionTimeoutError()),
        waitMs,
      );
      timer.unref();
      onAbort = () => reject(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.set(commandId, {
        connection,
        action: command.action,
        modelId: command.modelId,
        resolve,
        reject,
      });
    });
    let result: LocalModelsOutcome;
    try {
      [, result] = await Promise.all([
        this.owners.connections().sendToCurrentRunner(envelope),
        outcome,
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      this.#waiters.delete(commandId);
    }
    return result.outcome === "accepted"
      ? { outcome: "accepted" }
      : { outcome: "refused", refusal: result.refusal };
  }

  receiveOutcome(connection: ConnectedRunner, envelope: LocalModelsOutcome) {
    if (
      envelope.connection_epoch !== connection.connectionEpoch ||
      connection.tenantOwners.get(envelope.tenant_id) !==
        envelope.owner_actor_id
    ) {
      throw new RunnerGatewayProtocolError(
        "Runner local-models outcome identity mismatch",
      );
    }
    const waiter = this.#waiters.get(envelope.command_id);
    if (!waiter) {
      // The action already expired; the Computer's next snapshot shows it.
      logAgentEvent("info", "runner.local_models.late_outcome", {
        runnerId: connection.runnerId,
        commandId: envelope.command_id,
        outcome: envelope.outcome,
      });
      return;
    }
    if (
      waiter.connection !== connection ||
      waiter.action !== envelope.action ||
      waiter.modelId !== envelope.model_id
    ) {
      throw new RunnerGatewayProtocolError(
        "Runner local-models command identity mismatch",
      );
    }
    this.#waiters.delete(envelope.command_id);
    waiter.resolve(envelope);
  }

  /** Fails every action still waiting on this connection. */
  disconnected(connection: ConnectedRunner): void {
    for (const [commandId, waiter] of this.#waiters) {
      if (waiter.connection !== connection) continue;
      this.#waiters.delete(commandId);
      waiter.reject(new LocalComputerOfflineError());
    }
  }
}

export function isLocalModelsOutcome(
  envelope: DaemonToAgentEnvelope,
): envelope is LocalModelsOutcome {
  return envelope.type === "executed" && envelope.kind === "local_models";
}
