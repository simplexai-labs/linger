import type {
  AgentToDaemonEnvelope,
  CapabilityLocalModelsExecute,
  LocalModelsSnapshot,
} from "@linger/wire-contracts/runner-gateway/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LocalComputerCapabilityError,
  LocalComputerNotFoundError,
  LocalComputerOfflineError,
} from "../../../src/agent/runner-gateway/local-computer-management.js";
import { type RunnerGatewayConnection } from "../../../src/agent/runner-gateway/runner-gateway.js";
import { TeamHubRuntimeStateError } from "../../../src/agent/executor/teamhub-runtime-state-client.js";
import { LocalModelsActionTimeoutError } from "../../../src/agent/runner-gateway/runner-local-models.js";
import {
  createTestLocalComputerRegistry,
  type TestLocalComputerRegistry,
} from "../test-support/local-computer-registry.js";
import { createTestRunnerGateway } from "../test-support/runner-gateway.js";
import { runtimeDiagnostics } from "./runtime-diagnostics-fixture.js";
import {
  CURRENT_RUNNER_CAPABILITIES,
  currentRunnerIdentity,
} from "../test-support/runner-capabilities.js";

const connections: RunnerGatewayConnection[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.disconnect();
});

const target = {
  computerId: "computer-local",
  tenantId: "tenant-1",
  ownerActorId: "actor-1",
} as const;

const snapshot = (toolVersion: string): LocalModelsSnapshot => ({
  available: true,
  observed_at: new Date().toISOString(),
  tool_version: toolVersion,
  pools: [
    {
      id: "gpu:0",
      kind: "gpu",
      gpu_index: 0,
      total_bytes: 24_000,
      used_bytes: 0,
      holders: [],
    },
  ],
  models: [
    {
      id: "qwen3-4b:Q4_K_M",
      name: "Qwen3 4B",
      description: "",
      quant: "Q4_K_M",
      context_tokens: 32_768,
      vision: false,
      download_bytes: 4_000,
      memory_bytes: 5_000,
      fit: "gpu",
      recommended: true,
      availability: { downloadable: true },
      pool: "gpu:0",
      state: "absent",
    },
    {
      id: "giant:Q8",
      name: "Giant",
      description: "",
      quant: "Q8",
      context_tokens: 8_192,
      vision: false,
      download_bytes: 90_000,
      memory_bytes: 90_000,
      fit: "none",
      recommended: false,
      availability: {
        downloadable: false,
        reason: {
          code: "MEMORY_INSUFFICIENT",
          need_bytes: 90_000,
          have_bytes: 24_000,
        },
      },
      state: "absent",
    },
  ],
});

const connect = async (registry?: TestLocalComputerRegistry) => {
  const computerRegistry = registry ?? createTestLocalComputerRegistry();
  computerRegistry.enroll({ ...target });
  const gateway = createTestRunnerGateway({
    heartbeatIntervalMs: 60_000,
    computerRegistry,
  });
  const sent: AgentToDaemonEnvelope[] = [];
  const close = vi.fn();
  const connection = await gateway.acceptConnection(
    {
      runnerId: target.computerId,
      credentialGeneration: 0,
      tenantOwners: [
        { tenantId: target.tenantId, ownerActorId: target.ownerActorId },
      ],
    },
    {
      type: "runner.hello",
      platform: "linux",
      protocol_version: "2",
      daemon_version: "dev",
      ...currentRunnerIdentity(),
      capabilities: [...CURRENT_RUNNER_CAPABILITIES],
      runner_id: target.computerId,
      display_name: "Studio",
      connection_nonce: "nonce-1",
      sent_at: new Date().toISOString(),
      runtimes: ["codex"],
      runtime_diagnostics: runtimeDiagnostics(),
      workspace_grants: [],
      agent_runners: [],
      active_operations: [],
    },
    {
      send: vi.fn(async (envelope: AgentToDaemonEnvelope) => {
        sent.push(envelope);
      }),
      close,
    },
  );
  connections.push(connection);
  const report = (revision: number, toolVersion = `v${revision}`) =>
    connection.receive({
      type: "runner.local_models",
      protocol_version: "2",
      runner_id: target.computerId,
      sent_at: new Date().toISOString(),
      revision,
      local_models: snapshot(toolVersion),
    });
  const command = async (): Promise<CapabilityLocalModelsExecute> => {
    await vi.waitFor(() => expect(sent.some(isLocalModelsCommand)).toBe(true));
    const value = [...sent].reverse().find(isLocalModelsCommand);
    if (!value) throw new Error("Missing local-models command");
    sent.splice(sent.indexOf(value), 1);
    return value;
  };
  return { gateway, connection, computerRegistry, report, command, close };
};

const isLocalModelsCommand = (
  frame: AgentToDaemonEnvelope,
): frame is CapabilityLocalModelsExecute =>
  frame.type === "execute" && frame.kind === "local_models";

const identityOf = (request: CapabilityLocalModelsExecute) => ({
  protocol_version: request.protocol_version,
  command_id: request.command_id,
  runner_id: request.runner_id,
  tenant_id: request.tenant_id,
  owner_actor_id: request.owner_actor_id,
  connection_epoch: request.connection_epoch,
  expires_at: request.expires_at,
});

const inSeconds = (seconds: number) =>
  new Date(Date.now() + seconds * 1_000).toISOString();

const versions = (registry: TestLocalComputerRegistry) =>
  registry
    .localModels(target.computerId)
    .map((recorded) => recorded.tool_version);

describe("Runner Gateway local models", () => {
  it("records each snapshot in TeamHub and drops a stale revision", async () => {
    const { computerRegistry, report } = await connect();
    await report(1);
    await vi.waitFor(() => expect(versions(computerRegistry)).toEqual(["v1"]));
    await report(1, "replayed");
    await report(3);
    await vi.waitFor(() =>
      expect(versions(computerRegistry)).toEqual(["v1", "v3"]),
    );
    expect(computerRegistry.localModels(target.computerId)[1]).toEqual(
      expect.objectContaining({
        models: [
          expect.objectContaining({ pool: "gpu:0" }),
          expect.not.objectContaining({ pool: expect.anything() }),
        ],
      }),
    );
  });

  it("keeps one snapshot in flight per Computer and sends only the newest after it", async () => {
    const registry = createTestLocalComputerRegistry();
    const released: Array<() => void> = [];
    const record = registry.recordLocalModels;
    registry.recordLocalModels = async (computerId, value) => {
      await new Promise<void>((resolve) => released.push(resolve));
      await record(computerId, value);
    };
    const { report } = await connect(registry);
    await report(1);
    await report(2);
    await report(3);
    await vi.waitFor(() => expect(released).toHaveLength(1));
    released.shift()!();
    await vi.waitFor(() => expect(released).toHaveLength(1));
    released.shift()!();
    await vi.waitFor(() => expect(versions(registry)).toEqual(["v1", "v3"]));
  });

  it("keeps the connection when TeamHub refuses a snapshot", async () => {
    const registry = createTestLocalComputerRegistry();
    const record = registry.recordLocalModels;
    let failures = 1;
    registry.recordLocalModels = async (computerId, value) => {
      if (failures-- > 0) throw new Error("TeamHub is unavailable");
      await record(computerId, value);
    };
    const { gateway, report, close } = await connect(registry);
    await report(1);
    await report(2);
    await vi.waitFor(() => expect(versions(registry)).toEqual(["v2"]));
    expect(close).not.toHaveBeenCalled();
    expect(gateway.isLocalComputerExecutionReady(target.computerId)).toBe(true);
  });

  it("retries the newest snapshot until TeamHub stores it", async () => {
    const registry = createTestLocalComputerRegistry();
    const record = registry.recordLocalModels;
    let failures = 2;
    const attempt = vi.fn(
      async (computerId: string, value: LocalModelsSnapshot) => {
        if (failures-- > 0) throw new Error("TeamHub is unavailable");
        await record(computerId, value);
      },
    );
    registry.recordLocalModels = attempt;
    const { report, connection } = await connect(registry);
    vi.useFakeTimers();
    try {
      // The Computer's last report fails, and no newer one follows.
      await report(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(versions(registry)).toEqual(["v1"]);
      expect(attempt).toHaveBeenCalledTimes(3);
      // Stored once: nothing is written again.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempt).toHaveBeenCalledTimes(3);
    } finally {
      connection.disconnect();
      vi.useRealTimers();
    }
  });

  it("retries with the snapshot that replaced a failed one", async () => {
    const registry = createTestLocalComputerRegistry();
    const record = registry.recordLocalModels;
    let failures = 1;
    registry.recordLocalModels = async (computerId, value) => {
      if (failures-- > 0) throw new Error("TeamHub is unavailable");
      await record(computerId, value);
    };
    const { report, connection } = await connect(registry);
    vi.useFakeTimers();
    try {
      await report(1);
      await report(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(versions(registry)).toEqual(["v2"]);
    } finally {
      connection.disconnect();
      vi.useRealTimers();
    }
  });

  it("stops retrying a snapshot TeamHub will never store", async () => {
    const registry = createTestLocalComputerRegistry();
    const attempt = vi.fn(async () => {
      throw new TeamHubRuntimeStateError(404, "Local Computer was not found");
    });
    registry.recordLocalModels = attempt;
    const { report, connection } = await connect(registry);
    vi.useFakeTimers();
    try {
      await report(1);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(attempt).toHaveBeenCalledTimes(1);
    } finally {
      connection.disconnect();
      vi.useRealTimers();
    }
  });

  it("sends no action to a connection that never reported a library", async () => {
    const { gateway, connection } = await connect();
    await expect(
      gateway.actOnLocalModels({
        ...target,
        action: "download",
        modelId: "qwen3-4b:Q4_K_M",
        expiresAt: inSeconds(10),
      }),
    ).rejects.toBeInstanceOf(LocalComputerCapabilityError);
    await expect(
      gateway.actOnLocalModels({
        ...target,
        ownerActorId: "actor-other",
        action: "refresh",
        expiresAt: inSeconds(10),
      }),
    ).rejects.toBeInstanceOf(LocalComputerNotFoundError);
    connection.disconnect();
    await expect(
      gateway.actOnLocalModels({
        ...target,
        action: "refresh",
        expiresAt: inSeconds(10),
      }),
    ).rejects.toBeInstanceOf(LocalComputerOfflineError);
  });

  it("answers each action with the Computer's accept or refusal for that command", async () => {
    const { gateway, connection, report, command } = await connect();
    await report(1);
    const loading = gateway.actOnLocalModels({
      ...target,
      action: "load",
      modelId: "qwen3-4b:Q4_K_M",
      unloadFirst: ["gemma-3:Q4"],
      expiresAt: inSeconds(10),
    });
    const load = await command();
    expect(load).toMatchObject({
      action: "load",
      model_id: "qwen3-4b:Q4_K_M",
      unload_first: ["gemma-3:Q4"],
      tenant_id: target.tenantId,
      owner_actor_id: target.ownerActorId,
    });
    const downloading = gateway.actOnLocalModels({
      ...target,
      action: "download",
      modelId: "giant:Q8",
      expiresAt: inSeconds(10),
    });
    const download = await command();
    // Answers arrive out of order; each settles its own command.
    await connection.receive({
      type: "executed",
      kind: "local_models",
      outcome: "refused",
      ...identityOf(download),
      action: "download",
      model_id: "giant:Q8",
      refusal: {
        code: "MEMORY_INSUFFICIENT",
        need_bytes: 90_000,
        free_bytes: 24_000,
      },
    });
    await connection.receive({
      type: "executed",
      kind: "local_models",
      outcome: "accepted",
      ...identityOf(load),
      action: "load",
      model_id: "qwen3-4b:Q4_K_M",
    });
    await expect(loading).resolves.toEqual({ outcome: "accepted" });
    await expect(downloading).resolves.toEqual({
      outcome: "refused",
      refusal: {
        code: "MEMORY_INSUFFICIENT",
        need_bytes: 90_000,
        free_bytes: 24_000,
      },
    });
  });

  it("fails an unanswered action at its deadline and ignores the late answer", async () => {
    const { gateway, connection, report, command, close } = await connect();
    await report(1);
    const unloading = gateway.actOnLocalModels({
      ...target,
      action: "unload",
      modelId: "qwen3-4b:Q4_K_M",
      expiresAt: new Date(Date.now() + 50).toISOString(),
    });
    const request = await command();
    await expect(unloading).rejects.toBeInstanceOf(
      LocalModelsActionTimeoutError,
    );
    await connection.receive({
      type: "executed",
      kind: "local_models",
      outcome: "accepted",
      ...identityOf(request),
      action: "unload",
      model_id: "qwen3-4b:Q4_K_M",
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("fails a waiting action when the Computer disconnects", async () => {
    const { gateway, connection, report, command } = await connect();
    await report(1);
    const removing = gateway.actOnLocalModels({
      ...target,
      action: "remove",
      modelId: "qwen3-4b:Q4_K_M",
      expiresAt: inSeconds(10),
    });
    await command();
    connection.disconnect();
    await expect(removing).rejects.toBeInstanceOf(LocalComputerOfflineError);
  });

  it("treats an answer naming another action as a protocol violation", async () => {
    const { gateway, connection, report, command, close } = await connect();
    await report(1);
    const cancelling = gateway.actOnLocalModels({
      ...target,
      action: "cancel",
      modelId: "qwen3-4b:Q4_K_M",
      expiresAt: inSeconds(10),
    });
    const request = await command();
    await expect(
      connection.receive({
        type: "executed",
        kind: "local_models",
        outcome: "accepted",
        ...identityOf(request),
        action: "remove",
        model_id: "qwen3-4b:Q4_K_M",
      }),
    ).rejects.toThrow(/identity mismatch/u);
    expect(close).toHaveBeenCalledWith(1002, "Runner protocol violation");
    await expect(cancelling).rejects.toBeInstanceOf(LocalComputerOfflineError);
  });
});
