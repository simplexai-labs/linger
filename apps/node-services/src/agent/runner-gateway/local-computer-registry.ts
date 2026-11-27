import { createHash } from "node:crypto";

import type {
  LocalModelsSnapshot,
  RunnerHello,
  RuntimeDiagnostics,
} from "@linger/wire-contracts/runner-gateway/types";

import type {
  LocalReasoningEffort,
  LocalRuntimeType,
} from "./local-computer-management.js";
import {
  TeamHubRuntimeStateError,
  type RuntimeStateSchemas,
  type TeamHubRuntimeStateClient,
} from "../executor/teamhub-runtime-state-client.js";
import { RunnerDaemonIdentityInUseError } from "./runner-operation.js";

export interface LocalComputerOwner {
  readonly ownerActorId: string;
  readonly tenantId: string;
}

/**
 * An active Agent placed on a Computer, read from its TeamHub registration
 * row. The Agent Runner the Computer should hold is computed from it.
 */
export interface RunnerPlacement {
  readonly agentId: string;
  readonly tenantId: string;
  readonly ownerActorId: string;
  readonly runtimeType: LocalRuntimeType;
  readonly model: string;
  readonly reasoningEffort?: LocalReasoningEffort;
  readonly workspaceGrantId: string;
  readonly assignmentRevision: number;
}

export interface LocalComputerConnection {
  readonly computerId: string;
  readonly owner: LocalComputerOwner;
  readonly credentialGeneration: number;
  readonly hello: RunnerHello;
  /** offline while the connection's Agent Runners are reconciled. */
  readonly status: "online" | "offline";
  /** The Computer release this deployment ships. */
  readonly recommendedVersion?: string;
}

export interface LocalComputerTouch {
  readonly status: "online" | "offline" | "upgrade_required";
  readonly seenAt: string;
  readonly activeOperations?: number;
  readonly runtimes?: readonly LocalRuntimeType[];
  readonly runtimeDiagnostics?: RuntimeDiagnostics;
  readonly daemonVersion?: string;
  readonly recommendedVersion?: string;
}

export type LocalComputerRemovalResult =
  | "removed"
  | "already-removed"
  | "has-agents"
  | "not-found";

/** Placements and deployment flags returned when a Computer connects. */
export interface LocalComputerConnectResult {
  readonly placements: readonly RunnerPlacement[];
  readonly connectedApps?: boolean;
  readonly permissionReview?: boolean;
}

/** The Computer rows TeamHub keeps; the Runner Gateway holds no copy. */
export interface LocalComputerRegistry {
  /** The Computer's credential generation, or null when it is not this owner's active Computer. */
  credentialGeneration(
    computerId: string,
    owner: LocalComputerOwner,
  ): Promise<number | null>;
  /** Records a hello and returns the Agents placed on the Computer. */
  connect(
    connection: LocalComputerConnection,
  ): Promise<LocalComputerConnectResult>;
  touch(computerId: string, touch: LocalComputerTouch): Promise<void>;
  /** Replaces the Computer's stored model library with its latest snapshot. */
  recordLocalModels(
    computerId: string,
    snapshot: LocalModelsSnapshot,
  ): Promise<void>;
  remove(
    input: LocalComputerOwner & { readonly computerId: string },
  ): Promise<LocalComputerRemovalResult>;
}

type TeamHubLocalComputerClient = Pick<
  TeamHubRuntimeStateClient,
  | "getLocalComputer"
  | "connectLocalComputer"
  | "touchLocalComputer"
  | "removeLocalComputer"
  | "recordLocalModels"
>;

export const createTeamHubLocalComputerRegistry = (
  client: TeamHubLocalComputerClient,
): LocalComputerRegistry =>
  buildTeamHubLocalComputerRegistry(client, createMonotonicSeenAt());

const buildTeamHubLocalComputerRegistry = (
  client: TeamHubLocalComputerClient,
  seenAt: ReturnType<typeof createMonotonicSeenAt>,
): LocalComputerRegistry => ({
  async credentialGeneration(computerId, owner) {
    let computer: RuntimeStateSchemas["AgentRuntimeLocalComputer"];
    try {
      computer = await client.getLocalComputer(computerId);
    } catch (error) {
      if (error instanceof TeamHubRuntimeStateError && error.status === 404)
        return null;
      throw error;
    }
    return computer.owner.tenant_id === owner.tenantId &&
      computer.owner.owner_actor_id === owner.ownerActorId
      ? Number(computer.credential_generation)
      : null;
  },
  async connect({
    computerId,
    owner,
    credentialGeneration,
    hello,
    status,
    recommendedVersion,
  }) {
    let result: RuntimeStateSchemas["ConnectAgentRuntimeLocalComputerResult"];
    try {
      result = await client.connectLocalComputer({
        computer_id: computerId,
        owner: {
          tenant_id: owner.tenantId,
          owner_actor_id: owner.ownerActorId,
        },
        credential_generation: String(credentialGeneration),
        daemon_id: hello.daemon_identity.daemon_id,
        daemon_public_key: hello.daemon_identity.public_key,
        identity_version: String(hello.daemon_identity.identity_version),
        status,
        seen_at: seenAt.next(computerId),
        display_name: hello.display_name ?? computerId,
        platform: hello.platform,
        // A rolling upgrade can still route this reconnect to an older TeamHub.
        ...(hello.capacity === undefined ? {} : { capacity: hello.capacity }),
        runtimes: [...hello.runtimes],
        runtime_diagnostics: jsonObjects(hello.runtime_diagnostics),
        workspace_grants: jsonObjects(hello.workspace_grants),
        daemon_version: hello.daemon_version,
        ...(recommendedVersion === undefined
          ? {}
          : { recommended_version: recommendedVersion }),
      });
    } catch (error) {
      if (
        error instanceof TeamHubRuntimeStateError &&
        error.code === "DAEMON_IDENTITY_IN_USE"
      ) {
        throw new RunnerDaemonIdentityInUseError(error.message);
      }
      throw error;
    }
    return {
      placements: result.placements.map((placement) => ({
        agentId: placement.agent_id,
        tenantId: placement.tenant_id,
        ownerActorId: placement.owner_actor_id,
        runtimeType: placement.runtime_type,
        model: placement.model,
        ...(placement.reasoning_effort === undefined
          ? {}
          : { reasoningEffort: placement.reasoning_effort }),
        workspaceGrantId: placement.workspace_grant_id,
        assignmentRevision: Number(placement.assignment_revision),
      })),
      ...(result.connected_apps === undefined
        ? {}
        : { connectedApps: result.connected_apps }),
      ...(result.permission_review === undefined
        ? {}
        : { permissionReview: result.permission_review }),
    };
  },
  async touch(computerId, touch) {
    await client.touchLocalComputer({
      computer_id: computerId,
      status: touch.status,
      seen_at: seenAt.next(computerId, touch.seenAt),
      ...(touch.activeOperations === undefined
        ? {}
        : { active_operations: touch.activeOperations }),
      ...(touch.runtimes === undefined
        ? {}
        : { runtimes: [...touch.runtimes] }),
      ...(touch.runtimeDiagnostics === undefined
        ? {}
        : { runtime_diagnostics: jsonObjects(touch.runtimeDiagnostics) }),
      ...(touch.daemonVersion === undefined
        ? {}
        : { daemon_version: touch.daemonVersion }),
      ...(touch.recommendedVersion === undefined
        ? {}
        : { recommended_version: touch.recommendedVersion }),
    });
  },
  async recordLocalModels(computerId, snapshot) {
    await client.recordLocalModels({
      computer_id: computerId,
      snapshot: structuredClone(snapshot),
    });
  },
  async remove({ computerId, tenantId, ownerActorId }) {
    const response = await client.removeLocalComputer({
      computer_id: computerId,
      owner: { tenant_id: tenantId, owner_actor_id: ownerActorId },
    });
    if (
      response.status === "removed" ||
      response.status === "already_removed"
    ) {
      seenAt.forget(computerId);
    }
    switch (response.status) {
      case "already_removed":
        return "already-removed";
      case "not_found":
        return "not-found";
      case "has_agents":
        return "has-agents";
      case "removed":
        return "removed";
    }
  },
});

// TeamHub ignores a touch whose seen_at is not strictly newer than the last
// write, so keep per-computer timestamps strictly monotonic even within 1ms.
function createMonotonicSeenAt() {
  const lastSeenAtMs = new Map<string, number>();
  return {
    next(computerId: string, candidate?: string): string {
      const parsed =
        candidate === undefined ? Date.now() : Date.parse(candidate);
      const candidateMs = Number.isFinite(parsed) ? parsed : Date.now();
      const nextMs = Math.max(
        candidateMs,
        (lastSeenAtMs.get(computerId) ?? 0) + 1,
      );
      lastSeenAtMs.set(computerId, nextMs);
      return new Date(nextMs).toISOString();
    },
    forget(computerId: string): void {
      lastSeenAtMs.delete(computerId);
    },
  };
}

/**
 * Names the Computer's Runtime of one owner. The name is the same on every
 * connection and in every Agent Service process, so an Agent Runner and an
 * Operation keep naming the Runtime they were admitted for.
 */
export const runtimeRegistrationId = (
  owner: LocalComputerOwner,
  runtimeType: LocalRuntimeType,
): string =>
  `${runtimeType}-${createHash("sha256")
    .update(`${owner.tenantId}\0${owner.ownerActorId}`)
    .digest("hex")
    .slice(0, 32)}`;

const jsonObjects = (values: readonly object[]): Record<string, unknown>[] =>
  values.map((value) => structuredClone(value) as Record<string, unknown>);
