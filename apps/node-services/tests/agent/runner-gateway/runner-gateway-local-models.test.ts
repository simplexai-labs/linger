import type {
  AgentToDaemonEnvelope,
  CapabilityLocalModelsExecute,
  LocalModelsSnapshot,
  RuntimeDiagnostic,
  RuntimeDiagnostics,
} from "@linger/wire-contracts/runner-gateway/types";
import { parseDaemonToAgentEnvelope } from "@linger/wire-contracts/runner-gateway/validator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelCallPolicies, runPriorities } from "../../../src/model-tasks.js";

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

const connect = async (
  registry?: TestLocalComputerRegistry,
  daemonVersion = "dev",
) => {
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
      daemon_version: daemonVersion,
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
  return {
    gateway,
    connection,
    computerRegistry,
    report,
    command,
    close,
    sent,
  };
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
  // A Computer sends runner.local_models only when the welcome names the
  // family; a release before 0.52.0 rejects the unknown welcome key, so it
  // is welcomed without it and keeps receiving its target_release. BYOK
  // paths are named only to a release that decodes them.
  it.each([
    [
      "dev",
      [
        "local_models",
        "byok_endpoint",
        "local_models_diagnostics",
        "model_invoke_outcomes",
        "local_models_engine",
        "local_models_concurrency_probe",
        "local_model_unavailable",
        "local_models_external_holders",
      ],
    ],
    [
      "0.64.0",
      [
        "local_models",
        "byok_endpoint",
        "local_models_diagnostics",
        "model_invoke_outcomes",
        "local_models_engine",
        "local_models_concurrency_probe",
        "local_model_unavailable",
        "local_models_external_holders",
      ],
    ],
    [
      "0.63.0",
      [
        "local_models",
        "byok_endpoint",
        "local_models_diagnostics",
        "model_invoke_outcomes",
        "local_models_engine",
        "local_model_unavailable",
        "local_models_external_holders",
      ],
    ],
    [
      "0.62.0",
      [
        "local_models",
        "byok_endpoint",
        "local_models_diagnostics",
        "model_invoke_outcomes",
        "local_models_engine",
        "local_model_unavailable",
        "local_models_external_holders",
      ],
    ],
    [
      "0.61.0",
      [
        "local_models",
        "byok_endpoint",
        "local_models_diagnostics",
        "model_invoke_outcomes",
        "local_models_engine",
        "local_model_unavailable",
        "local_models_external_holders",
      ],
    ],
    [
      "0.60.0",
      [
        "local_models",
        "byok_endpoint",
        "local_models_diagnostics",
        "model_invoke_outcomes",
        "local_model_unavailable",
        "local_models_external_holders",
      ],
    ],
    [
      "0.59.0",
      [
        "local_models",
        "byok_endpoint",
        "local_models_diagnostics",
        "local_model_unavailable",
        "local_models_external_holders",
      ],
    ],
    [
      "0.58.0",
      [
        "local_models",
        "byok_endpoint",
        "local_models_diagnostics",
        "local_model_unavailable",
        "local_models_external_holders",
      ],
    ],
    [
      "0.57.0",
      [
        "local_models",
        "byok_endpoint",
        "local_model_unavailable",
        "local_models_external_holders",
      ],
    ],
    [
      "0.56.0",
      [
        "local_models",
        "byok_endpoint",
        "local_model_unavailable",
        "local_models_external_holders",
      ],
    ],
    [
      "0.55.0",
      [
        "local_models",
        "local_model_unavailable",
        "local_models_external_holders",
      ],
    ],
    [
      "0.52.0",
      [
        "local_models",
        "local_model_unavailable",
        "local_models_external_holders",
      ],
    ],
    ["0.51.0", undefined],
  ])(
    "welcomes a %s Computer with service_features %j",
    async (daemonVersion, expected) => {
      const { sent } = await connect(undefined, daemonVersion);
      const welcome = sent.find((frame) => frame.type === "runner.welcome");
      expect(welcome).toBeDefined();
      expect(
        welcome && "service_features" in welcome
          ? welcome.service_features
          : undefined,
      ).toEqual(expected);
    },
  );

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

describe("runner.local_models external_holders", () => {
  it.each([
    ["an empty list", []],
    ["a listed app", [{ name: "msedge", bytes: 188_743_680 }]],
  ])("parses and keeps %s as sent", (_label, externalHolders) => {
    const base = snapshot("v1");
    const envelope = parseDaemonToAgentEnvelope({
      type: "runner.local_models",
      protocol_version: "2",
      runner_id: target.computerId,
      sent_at: new Date().toISOString(),
      revision: 1,
      local_models: {
        ...base,
        pools: [{ ...base.pools[0], external_holders: externalHolders }],
      },
    });
    if (envelope.type !== "runner.local_models")
      throw new Error("Unexpected envelope");
    expect(envelope.local_models.pools[0]?.external_holders).toEqual(
      externalHolders,
    );
  });
});

describe("runner.local_models concurrency probing and ModelQueue wiring", () => {
  const piModel =
    "localmodels-library/localmodels-lib-qwen3-4b-q4-k-m/Qwen3-4B-Q4_K_M";

  const piDiagnostics = (): RuntimeDiagnostics => {
    const [d0, d1, d2, d3] = runtimeDiagnostics({
      ready: ["pi"],
      link: "api",
    });
    const withPiModel = (diagnostic: RuntimeDiagnostic): RuntimeDiagnostic =>
      diagnostic.type === "pi"
        ? {
            ...diagnostic,
            models: [
              {
                id: piModel,
                label: "Qwen3 4B",
                allowed_reasoning_effort: [],
                link: "api",
              },
            ],
          }
        : diagnostic;
    return [withPiModel(d0), withPiModel(d1), withPiModel(d2), withPiModel(d3)];
  };

  const connectWithPi = async (daemonVersion = "0.64.0") => {
    const computerRegistry = createTestLocalComputerRegistry();
    computerRegistry.enroll({ ...target });
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      computerRegistry,
    });
    const sent: AgentToDaemonEnvelope[] = [];
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
        daemon_version: daemonVersion,
        ...currentRunnerIdentity(),
        capabilities: [...CURRENT_RUNNER_CAPABILITIES],
        runner_id: target.computerId,
        display_name: "Studio",
        connection_nonce: "nonce-probe",
        sent_at: new Date().toISOString(),
        runtimes: ["pi"],
        runtime_diagnostics: piDiagnostics(),
        workspace_grants: [],
        agent_runners: [],
        active_operations: [],
      },
      {
        send: vi.fn(async (envelope: AgentToDaemonEnvelope) => {
          sent.push(envelope);
        }),
        close: vi.fn(),
      },
    );
    connections.push(connection);
    return { gateway, connection, sent };
  };

  it("holds ModelQueue at 1 while concurrency_probing and admits 2 once probed loaded snapshot arrives", async () => {
    const { gateway, connection } = await connectWithPi();
    const base = snapshot("v1");
    const probingModel = {
      ...base.models[0]!,
      state: "loading" as const,
      concurrency_probing: true,
      pi_model: piModel,
    };

    const parsedProbing = parseDaemonToAgentEnvelope({
      type: "runner.local_models",
      protocol_version: "2",
      runner_id: target.computerId,
      sent_at: new Date().toISOString(),
      revision: 1,
      local_models: {
        ...base,
        models: [probingModel, base.models[1]!],
      },
    });
    if (parsedProbing.type !== "runner.local_models") {
      throw new Error("Unexpected envelope");
    }
    expect(parsedProbing.local_models.models[0]?.concurrency_probing).toBe(
      true,
    );

    await connection.receive(parsedProbing);
    expect(
      gateway.runtimeModels(target.computerId, "pi")?.[0]?.concurrency,
    ).toBeUndefined();

    const signal = new AbortController().signal;
    const piEndpoint = {
      computerId: target.computerId,
      runtimeType: "pi" as const,
    };
    const first = await gateway.acquireModelCall(
      piEndpoint,
      { priority: runPriorities.chat, kind: "chat", key: "run-1" },
      signal,
    );
    let secondAdmitted = false;
    const secondPromise = gateway
      .acquireModelCall(
        piEndpoint,
        { priority: runPriorities.chat, kind: "chat", key: "run-2" },
        signal,
      )
      .then((lease) => {
        secondAdmitted = true;
        return lease;
      });
    let wikiAdmitted = false;
    const wikiPromise = gateway
      .acquireModelCall(
        piEndpoint,
        {
          priority: modelCallPolicies.wiki.priority,
          kind: "wiki",
          key: "wiki-1",
        },
        signal,
      )
      .then((lease) => {
        wikiAdmitted = true;
        return lease;
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondAdmitted).toBe(false);
    expect(wikiAdmitted).toBe(false);

    await connection.receive({
      type: "runner.local_models",
      protocol_version: "2",
      runner_id: target.computerId,
      sent_at: new Date().toISOString(),
      revision: 2,
      local_models: {
        ...base,
        models: [
          {
            ...base.models[0]!,
            state: "loaded",
            concurrency: 2,
            pi_model: piModel,
          },
          base.models[1]!,
        ],
      },
    });

    expect(
      gateway.runtimeModels(target.computerId, "pi")?.[0]?.concurrency,
    ).toBe(2);

    const second = await secondPromise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(wikiAdmitted).toBe(false);

    first.release({ outcome: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(wikiAdmitted).toBe(false);

    second.release({ outcome: "completed" });
    const wiki = await wikiPromise;
    wiki.release({ outcome: "completed" });
  });

  it("caps Pi concurrency at 1 when probed loaded model reports concurrency 1", async () => {
    const { gateway, connection } = await connectWithPi();
    const base = snapshot("v1");
    await connection.receive({
      type: "runner.local_models",
      protocol_version: "2",
      runner_id: target.computerId,
      sent_at: new Date().toISOString(),
      revision: 1,
      local_models: {
        ...base,
        models: [
          {
            ...base.models[0]!,
            state: "loaded",
            concurrency: 1,
            pi_model: piModel,
          },
          base.models[1]!,
        ],
      },
    });

    expect(
      gateway.runtimeModels(target.computerId, "pi")?.[0]?.concurrency,
    ).toBe(1);

    const signal = new AbortController().signal;
    const piEndpoint = {
      computerId: target.computerId,
      runtimeType: "pi" as const,
    };
    const first = await gateway.acquireModelCall(
      piEndpoint,
      { priority: runPriorities.chat, kind: "chat", key: "run-1" },
      signal,
    );
    let secondAdmitted = false;
    const secondPromise = gateway
      .acquireModelCall(
        piEndpoint,
        { priority: runPriorities.chat, kind: "chat", key: "run-2" },
        signal,
      )
      .then((lease) => {
        secondAdmitted = true;
        return lease;
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondAdmitted).toBe(false);

    first.release({ outcome: "completed" });
    const second = await secondPromise;
    second.release({ outcome: "completed" });
  });

  it("ignores unverified concurrency from Computers below 0.64.0 and falls back to API_CONCURRENCY", async () => {
    const { gateway, connection, sent } = await connectWithPi("0.63.0");
    const welcome = sent.find((frame) => frame.type === "runner.welcome");
    expect(welcome?.type).toBe("runner.welcome");
    if (welcome?.type === "runner.welcome") {
      expect(welcome.service_features).not.toContain(
        "local_models_concurrency_probe",
      );
    }

    const base = snapshot("v1");
    await connection.receive({
      type: "runner.local_models",
      protocol_version: "2",
      runner_id: target.computerId,
      sent_at: new Date().toISOString(),
      revision: 1,
      local_models: {
        ...base,
        models: [
          {
            ...base.models[0]!,
            state: "loaded",
            concurrency: 8,
            pi_model: piModel,
          },
          base.models[1]!,
        ],
      },
    });

    expect(
      gateway.runtimeModels(target.computerId, "pi")?.[0]?.concurrency,
    ).toBeUndefined();

    const signal = new AbortController().signal;
    const piEndpoint = {
      computerId: target.computerId,
      runtimeType: "pi" as const,
    };
    const first = await gateway.acquireModelCall(
      piEndpoint,
      { priority: runPriorities.chat, kind: "chat", key: "legacy-run-1" },
      signal,
    );
    let secondAdmitted = false;
    const secondPromise = gateway
      .acquireModelCall(
        piEndpoint,
        { priority: runPriorities.chat, kind: "chat", key: "legacy-run-2" },
        signal,
      )
      .then((lease) => {
        secondAdmitted = true;
        return lease;
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondAdmitted).toBe(false);

    first.release({ outcome: "completed" });
    const second = await secondPromise;
    second.release({ outcome: "completed" });
  });

  it("keeps loaded model concurrency at 2 when another local model enters loading", async () => {
    const { gateway, connection } = await connectWithPi("0.64.0");
    const base = snapshot("v1");
    await connection.receive({
      type: "runner.local_models",
      protocol_version: "2",
      runner_id: target.computerId,
      sent_at: new Date().toISOString(),
      revision: 1,
      local_models: {
        ...base,
        models: [
          {
            ...base.models[0]!,
            state: "loaded",
            concurrency: 2,
            pi_model: piModel,
          },
          {
            ...base.models[1]!,
            state: "loading",
            concurrency_probing: true,
            pi_model: "localmodels-library/giant/Giant",
          },
        ],
      },
    });

    expect(
      gateway.runtimeModels(target.computerId, "pi")?.[0]?.concurrency,
    ).toBe(2);

    const signal = new AbortController().signal;
    const piEndpoint = {
      computerId: target.computerId,
      runtimeType: "pi" as const,
    };
    const first = await gateway.acquireModelCall(
      piEndpoint,
      { priority: runPriorities.chat, kind: "chat", key: "mixed-run-1" },
      signal,
    );
    let secondAdmitted = false;
    const secondPromise = gateway
      .acquireModelCall(
        piEndpoint,
        { priority: runPriorities.chat, kind: "chat", key: "mixed-run-2" },
        signal,
      )
      .then((lease) => {
        secondAdmitted = true;
        return lease;
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondAdmitted).toBe(true);

    const second = await secondPromise;
    first.release({ outcome: "completed" });
    second.release({ outcome: "completed" });
  });
});
