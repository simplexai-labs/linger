import type {
  AgentToDaemonEnvelope,
  SystemTelemetrySnapshot,
} from "@linger/wire-contracts/runner-gateway/types";
import { parseDaemonToAgentEnvelope } from "@linger/wire-contracts/runner-gateway/validator";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalComputerHttpError,
  createLocalComputerRouteHandlers,
  registerLocalComputerSystemTelemetryRoutes,
} from "../../../src/agent/executor/http/local-computer-http.js";
import {
  LocalComputerNotFoundError,
  LocalComputerOfflineError,
} from "../../../src/agent/runner-gateway/local-computer-management.js";
import type { RunnerGatewayConnection } from "../../../src/agent/runner-gateway/runner-gateway.js";
import { SystemTelemetryUnsupportedError } from "../../../src/agent/runner-gateway/runner-system-telemetry.js";
import { createTestLocalComputerRegistry } from "../test-support/local-computer-registry.js";
import {
  CURRENT_RUNNER_CAPABILITIES,
  currentRunnerIdentity,
} from "../test-support/runner-capabilities.js";
import { createTestRunnerGateway } from "../test-support/runner-gateway.js";
import { runtimeDiagnostics } from "./runtime-diagnostics-fixture.js";

const connections: RunnerGatewayConnection[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.disconnect();
});

const target = {
  computerId: "computer-telemetry",
  tenantId: "tenant-1",
  ownerActorId: "actor-1",
} as const;

const sampleSnapshot = (inFlight: number): SystemTelemetrySnapshot => ({
  schema: "localmodels.stack-view/v1",
  schema_version: "1.1",
  generated_at: "2026-11-26T10:00:00Z",
  source: "live",
  bottleneck: inFlight > 0 ? "memory_bw_bound" : "idle",
  in_flight: inFlight,
  effective_decode_bw_gb_s: {
    value: inFlight > 0 ? 480.5 : 0,
    basis: "measured",
    note: "decode * weights",
  },
});

const connect = async (daemonVersion = "0.67.0") => {
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
      close: vi.fn(),
    },
  );
  connections.push(connection);
  const welcome = sent.find((frame) => frame.type === "runner.welcome");
  const epoch =
    welcome?.type === "runner.welcome" ? welcome.connection_epoch : 1;
  return { gateway, connection, sent, welcome, epoch };
};

const emitSnapshot = async (
  connection: RunnerGatewayConnection,
  epoch: number,
  revision: number,
  inFlight: number,
) => {
  await connection.receive(
    parseDaemonToAgentEnvelope({
      type: "runner.system_telemetry",
      protocol_version: "2",
      runner_id: target.computerId,
      connection_epoch: epoch,
      sent_at: new Date().toISOString(),
      revision,
      status: "ok",
      snapshot: sampleSnapshot(inFlight),
    }),
  );
};

describe("RunnerSystemTelemetry", () => {
  it("multiplexes concurrent viewers into one lease and unsubscribes on last viewer close", async () => {
    const { gateway, connection, sent, welcome, epoch } =
      await connect("0.67.0");
    expect(welcome?.type).toBe("runner.welcome");
    if (welcome?.type === "runner.welcome") {
      expect(welcome.service_features).toContain("system_telemetry");
    }

    const sub1 = await gateway.subscribeSystemTelemetry(target);
    const sub2 = await gateway.subscribeSystemTelemetry(target);

    const subscribes = sent.filter(
      (frame) => frame.type === "capability.system_telemetry.subscribe",
    );
    expect(subscribes).toHaveLength(1);

    const iter1 = sub1.events[Symbol.asyncIterator]();
    const iter2 = sub2.events[Symbol.asyncIterator]();

    await emitSnapshot(connection, epoch, 1, 2);

    const [first1, first2] = await Promise.all([iter1.next(), iter2.next()]);
    expect(first1.done).toBe(false);
    expect(first2.done).toBe(false);
    if (first1.value?.type === "snapshot") {
      expect(first1.value.envelope.revision).toBe(1);
      expect(first1.value.envelope.snapshot.in_flight).toBe(2);
    }

    // Late joiner gets seeded immediately with the latest cached snapshot.
    const sub3 = await gateway.subscribeSystemTelemetry(target);
    expect(
      sent.filter((f) => f.type === "capability.system_telemetry.subscribe"),
    ).toHaveLength(1);
    const first3 = await sub3.events[Symbol.asyncIterator]().next();
    expect(first3.value?.type).toBe("snapshot");

    // Closing 1st and 2nd viewers keeps the lease alive; closing 3rd unsubscribes immediately.
    sub1.close();
    sub2.close();
    expect(
      sent.filter((f) => f.type === "capability.system_telemetry.unsubscribe"),
    ).toHaveLength(0);

    sub3.close();
    await Promise.resolve();
    expect(
      sent.filter((f) => f.type === "capability.system_telemetry.unsubscribe"),
    ).toHaveLength(1);
  });

  it("coalesces stale ticks under slow viewers to O(1) latest snapshot", async () => {
    const { gateway, connection, epoch } = await connect("0.67.0");
    const sub = await gateway.subscribeSystemTelemetry(target);

    // Emit 4 ticks before the slow viewer drains anything.
    await emitSnapshot(connection, epoch, 1, 1);
    await emitSnapshot(connection, epoch, 2, 2);
    await emitSnapshot(connection, epoch, 3, 3);
    await emitSnapshot(connection, epoch, 4, 4);

    const iter = sub.events[Symbol.asyncIterator]();
    const next = await iter.next();
    expect(next.done).toBe(false);
    expect(next.value?.type).toBe("snapshot");
    if (next.value?.type === "snapshot") {
      expect(next.value.envelope.revision).toBe(4);
      expect(next.value.envelope.snapshot.in_flight).toBe(4);
    }
    sub.close();
  });

  it("rejects older daemons (< 0.67.0) and unsupported localmodels kits with SYSTEM_TELEMETRY_UNSUPPORTED", async () => {
    const oldConn = await connect("0.66.0");
    if (oldConn.welcome?.type === "runner.welcome") {
      expect(oldConn.welcome.service_features).not.toContain(
        "system_telemetry",
      );
    }
    await expect(
      oldConn.gateway.subscribeSystemTelemetry(target),
    ).rejects.toBeInstanceOf(SystemTelemetryUnsupportedError);
    await expect(
      oldConn.gateway.getSystemTelemetrySnapshot(target),
    ).rejects.toBeInstanceOf(SystemTelemetryUnsupportedError);
    oldConn.connection.disconnect();

    // Capable daemon (0.67.0) reporting older localmodels kit lacking --live-tick.
    const { gateway, connection, epoch } = await connect("0.67.0");
    const sub = await gateway.subscribeSystemTelemetry(target);
    const iter = sub.events[Symbol.asyncIterator]();

    await connection.receive(
      parseDaemonToAgentEnvelope({
        type: "runner.system_telemetry",
        protocol_version: "2",
        runner_id: target.computerId,
        connection_epoch: epoch,
        sent_at: new Date().toISOString(),
        revision: 1,
        status: "unsupported",
        reason: {
          code: "LIVE_TICK_UNSUPPORTED",
          detail: "localmodels binary predates --live-tick",
        },
      }),
    );

    const statusEvent = await iter.next();
    expect(statusEvent.value).toEqual({
      type: "status",
      computerId: target.computerId,
      status: "unsupported",
      code: "SYSTEM_TELEMETRY_UNSUPPORTED",
      message: "localmodels binary predates --live-tick",
    });
    expect((await iter.next()).done).toBe(true);

    // Subsequent calls on the same connection immediately fail with unsupported.
    await expect(
      gateway.getSystemTelemetrySnapshot(target),
    ).rejects.toBeInstanceOf(SystemTelemetryUnsupportedError);
  });

  it("enforces owner scope and handles offline computers cleanly", async () => {
    const { gateway, connection } = await connect("0.67.0");
    await expect(
      gateway.subscribeSystemTelemetry({
        ...target,
        ownerActorId: "actor-other",
      }),
    ).rejects.toBeInstanceOf(LocalComputerNotFoundError);

    const sub = await gateway.subscribeSystemTelemetry(target);
    const iter = sub.events[Symbol.asyncIterator]();
    connection.disconnect();

    const offlineEvent = await iter.next();
    expect(offlineEvent.value).toMatchObject({
      type: "status",
      status: "offline",
      code: "LOCAL_COMPUTER_OFFLINE",
    });
    await expect(
      gateway.getSystemTelemetrySnapshot(target),
    ).rejects.toBeInstanceOf(LocalComputerOfflineError);
  });

  it("acquires a brief lease for one-shot snapshot GET and unsubscribes immediately after first tick", async () => {
    const { gateway, connection, sent, epoch } = await connect("0.67.0");
    const pending = gateway.getSystemTelemetrySnapshot(target);

    // Wait a microtask for subscribe to be sent.
    await Promise.resolve();
    expect(
      sent.filter((f) => f.type === "capability.system_telemetry.subscribe"),
    ).toHaveLength(1);

    await emitSnapshot(connection, epoch, 1, 3);
    const envelope = await pending;
    expect(envelope.revision).toBe(1);
    expect(envelope.snapshot.in_flight).toBe(3);

    await Promise.resolve();
    expect(
      sent.filter((f) => f.type === "capability.system_telemetry.unsubscribe"),
    ).toHaveLength(1);
  });

  it("serves internal HTTP snapshot and SSE stream endpoints with proper headers and error codes", async () => {
    const { gateway, connection, epoch } = await connect("0.67.0");
    const app = new Hono();
    const handlers = createLocalComputerRouteHandlers({
      localComputerManagement: gateway,
      pathId: (context, name) => context.req.param(name) ?? "",
      readJsonBody: async (context) => context.req.json(),
    });
    registerLocalComputerSystemTelemetryRoutes(app, handlers);
    app.onError((error, context) => {
      if (error instanceof LocalComputerHttpError) {
        return context.json(
          { error: { code: error.errorCode, message: error.message } },
          error.status,
        );
      }
      return context.json({ error: { code: "internal_error" } }, 500);
    });

    const base = `/v1/tenants/${target.tenantId}/owners/${target.ownerActorId}/local-computers/${target.computerId}/system-telemetry`;
    const streamRes = await app.request(`${base}/stream`);
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("content-type")).toBe("text/event-stream");
    expect(streamRes.headers.get("x-accel-buffering")).toBe("no");

    const reader = streamRes.body!.getReader();
    await emitSnapshot(connection, epoch, 1, 5);
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain("event: telemetry.snapshot");
    expect(text).toContain('"in_flight":5');

    // One-shot GET reuses the fresh active snapshot immediately.
    const snapRes = await app.request(base);
    expect(snapRes.status).toBe(200);
    const snapJson = (await snapRes.json()) as {
      computer_id: string;
      revision: number;
      snapshot: { in_flight: number };
    };
    expect(snapJson.computer_id).toBe(target.computerId);
    expect(snapJson.revision).toBe(1);
    expect(snapJson.snapshot.in_flight).toBe(5);

    await reader.cancel();
    connection.disconnect();

    const offlineRes = await app.request(base);
    expect(offlineRes.status).toBe(503);
    const offlineJson = (await offlineRes.json()) as {
      error: { code: string };
    };
    expect(offlineJson.error.code).toBe("LOCAL_COMPUTER_OFFLINE");
  });
});
