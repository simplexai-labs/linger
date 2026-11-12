import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serviceCredential, type JsonLogger } from "@linger/service-kit/node";
import {
  startVoiceService,
  VOICE_READY_WAIT_MS,
  VOICE_RECONCILE_POLL_MS,
  type VoiceWorker,
  type VoiceWorkerSpawn,
} from "../src/voice/service.js";
import type { HttpHost, HttpRoute } from "../src/http-host.js";

class Worker extends EventEmitter {
  kill = vi.fn(() => true);
}
const environment = {
  LINGER_SECRET_SEED: "voice-service-test-seed-0123456789abcdef",
  TEAMHUB_BASE_URL: "http://teamhub.test",
};
const SONIOX = "soniox-key-1";
const XAI = "xai-key-1";

afterEach(() => vi.useRealTimers());

async function harness(
  options: {
    keys?: Record<string, unknown>;
    env?: NodeJS.ProcessEnv;
    failure?: "network" | number | "json";
    healthy?: boolean;
  } = {},
) {
  vi.useFakeTimers();
  const teamHub = {
    keys: options.keys ?? {},
    failure: options.failure,
    calls: 0,
    pending: [] as (() => void)[],
    hold: false,
  };
  const fetchImpl = vi.fn(async (url: URL | string, init?: RequestInit) => {
    teamHub.calls += 1;
    expect(String(url)).toBe(
      "http://teamhub.test/internal/v1/voice/provider-keys",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${serviceCredential("voice-runtime", environment)}`,
    );
    if (teamHub.hold)
      await new Promise<void>((resolve) => teamHub.pending.push(resolve));
    if (teamHub.failure === "network") throw new TypeError("fetch failed");
    if (typeof teamHub.failure === "number")
      return new Response("{}", { status: teamHub.failure });
    if (teamHub.failure === "json") return new Response("not json");
    return Response.json(teamHub.keys);
  });
  const spawned: {
    worker: VoiceWorker;
    spec: VoiceWorkerSpawn;
    child: Worker;
  }[] = [];
  const health = { healthy: options.healthy ?? true };
  const log = vi.fn();
  let route: HttpRoute | undefined;
  const unmount = vi.fn();
  const service = await startVoiceService({
    logger: { log } as unknown as JsonLogger,
    http: {
      mount: (mounted: HttpRoute) => {
        route = mounted;
        return unmount;
      },
    } as unknown as HttpHost,
    environment: { ...environment, ...options.env },
    fetch: fetchImpl as unknown as typeof fetch,
    installModels: async () => undefined,
    probeWorker: async () => health.healthy,
    spawnWorker: (worker, spec) => {
      const child = new Worker();
      spawned.push({ worker, spec, child });
      return child as unknown as ChildProcess;
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  const of = (worker: VoiceWorker) =>
    spawned.filter((entry) => entry.worker === worker);
  const shutdown = async () => {
    const stopped = service.stop();
    for (const { child } of spawned) child.emit("exit", 0, null);
    await stopped;
  };
  return {
    service,
    shutdown,
    health,
    teamHub,
    spawned,
    of,
    log,
    route: route!,
    unmount,
  };
}

function reconcileRequest() {
  return new Request("http://x/v1/voice/workers:reconcile", {
    method: "POST",
    headers: {
      authorization: `Bearer ${serviceCredential("node-services-internal", environment)}`,
    },
  });
}

describe("voice worker reconcile", () => {
  it("starts no worker without keys", async () => {
    const { spawned, route, shutdown } = await harness();
    expect(spawned).toHaveLength(0);
    const health = await route.fetch(new Request("http://x/voice/health"));
    expect(await health.json()).toEqual({ workers: [] });
    expect(await route.readiness!()).toEqual({ ready: true });
    await shutdown();
  });

  it("starts workers as keys appear, with the key only in the child env", async () => {
    const { spawned, of, teamHub, service, shutdown, log } = await harness();
    teamHub.keys = { soniox_api_key: SONIOX };
    await service.reconcile();
    expect(spawned.map(({ worker }) => worker)).toEqual(["asr", "recorder"]);
    for (const { spec } of spawned) {
      expect(spec.env.SONIOX_API_KEY).toBe(SONIOX);
      expect(spec.env.XAI_API_KEY).toBe("");
      expect(spec.env.TEAMHUB_BASE_URL).toBe("http://teamhub.test");
      expect(spec.args.join(" ")).not.toContain(SONIOX);
    }
    expect(of("recorder")[0]!.spec.args).toContain("--recorder");
    teamHub.keys = { soniox_api_key: SONIOX, xai_api_key: XAI };
    await service.reconcile();
    expect(of("live")).toHaveLength(1);
    expect(of("live")[0]!.spec.env).toMatchObject({
      XAI_API_KEY: XAI,
      SONIOX_API_KEY: "",
    });
    expect(of("live")[0]!.spec.args.join(" ")).not.toContain(XAI);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/soniox-key|xai-key/);
    await shutdown();
  });

  it("never passes an inherited key to a worker", async () => {
    const { spawned, teamHub, service, shutdown, of } = await harness({
      env: { SONIOX_API_KEY: "inherited", XAI_API_KEY: "inherited" },
    });
    expect(spawned).toHaveLength(0);
    teamHub.keys = { xai_api_key: XAI };
    await service.reconcile();
    expect(spawned).toHaveLength(1);
    expect(of("live")[0]!.spec.env.SONIOX_API_KEY).toBe("");
    expect(of("live")[0]!.spec.env.XAI_API_KEY).toBe(XAI);
    await shutdown();
  });

  it("restarts nothing for unchanged keys and only the worker whose key changed", async () => {
    const { spawned, of, teamHub, service, shutdown } = await harness({
      keys: { soniox_api_key: SONIOX, xai_api_key: XAI },
    });
    expect(spawned).toHaveLength(3);
    await service.reconcile();
    await vi.advanceTimersByTimeAsync(VOICE_RECONCILE_POLL_MS);
    expect(spawned).toHaveLength(3);
    expect(
      spawned.every(({ child }) => child.kill.mock.calls.length === 0),
    ).toBe(true);
    teamHub.keys = { soniox_api_key: SONIOX, xai_api_key: "xai-key-2" };
    await service.reconcile();
    const oldLive = of("live")[0]!.child;
    expect(oldLive.kill).toHaveBeenCalledWith("SIGTERM");
    // The replacement waits for the old process to leave the port.
    expect(of("live")).toHaveLength(1);
    oldLive.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(of("live")).toHaveLength(2);
    expect(of("live")[1]!.spec.env.XAI_API_KEY).toBe("xai-key-2");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(of("live")).toHaveLength(2);
    expect(of("asr")).toHaveLength(1);
    expect(of("recorder")).toHaveLength(1);
    await shutdown();
  });

  it("drains a worker whose key was removed and keeps it stopped after it exits", async () => {
    const { of, teamHub, service, shutdown, route } = await harness({
      keys: { soniox_api_key: SONIOX, xai_api_key: XAI },
    });
    teamHub.keys = { soniox_api_key: SONIOX };
    await service.reconcile();
    const live = of("live")[0]!.child;
    expect(live.kill).toHaveBeenCalledWith("SIGTERM");
    live.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(of("live")).toHaveLength(1);
    const health = await route.fetch(new Request("http://x/voice/health"));
    expect(await health.json()).toEqual({ workers: ["asr", "recorder"] });
    await shutdown();
  });

  it("does not start a second process while a worker is in restart backoff", async () => {
    const { of, teamHub, service, shutdown } = await harness({
      keys: { xai_api_key: XAI },
    });
    of("live")[0]!.child.emit("exit", 1, null);
    await service.reconcile();
    await vi.advanceTimersByTimeAsync(999);
    expect(of("live")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(of("live")).toHaveLength(2);
    // A key removed during backoff cancels the pending restart.
    of("live")[1]!.child.emit("exit", 1, null);
    teamHub.keys = {};
    await service.reconcile();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(of("live")).toHaveLength(2);
    await shutdown();
  });

  it("runs one reconcile at a time and coalesces overlapping triggers", async () => {
    const { of, teamHub, service, shutdown, route } = await harness();
    const token = serviceCredential("node-services-internal", environment);
    teamHub.hold = true;
    teamHub.keys = { soniox_api_key: SONIOX };
    const first = service.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    const callsBefore = teamHub.calls;
    const notified = route.fetch(
      new Request("http://x/v1/voice/workers:reconcile", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    await vi.advanceTimersByTimeAsync(VOICE_RECONCILE_POLL_MS);
    expect(teamHub.calls).toBe(callsBefore);
    teamHub.hold = false;
    teamHub.pending.splice(0).forEach((resolve) => resolve());
    await first;
    expect(await (await notified).json()).toEqual({ ready: true });
    // The two overlapping triggers ran exactly one follow-up reconcile.
    expect(teamHub.calls).toBe(callsBefore + 1);
    expect(of("asr")).toHaveLength(1);
    expect(of("recorder")).toHaveLength(1);
    await shutdown();
  });

  it.each(["network", 401, 503, "json"] as const)(
    "keeps current workers when TeamHub fails (%s)",
    async (failure) => {
      const { spawned, teamHub, service, shutdown, log } = await harness({
        keys: { soniox_api_key: SONIOX },
      });
      teamHub.failure = failure;
      teamHub.keys = {};
      await service.reconcile();
      expect(spawned).toHaveLength(2);
      expect(spawned.every(({ child }) => !child.kill.mock.calls.length)).toBe(
        true,
      );
      expect(log).toHaveBeenCalledWith(
        "warn",
        "voice.reconcile_failed",
        expect.objectContaining({ reason: expect.any(String) }),
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(SONIOX);
      await shutdown();
    },
  );

  it("retries a failed startup reconcile on the poll", async () => {
    const { spawned, teamHub, shutdown } = await harness({
      keys: { soniox_api_key: SONIOX },
      failure: "network",
    });
    expect(spawned).toHaveLength(0);
    teamHub.failure = undefined;
    await vi.advanceTimersByTimeAsync(VOICE_RECONCILE_POLL_MS);
    expect(spawned).toHaveLength(2);
    await shutdown();
  });

  it("answers a reconcile once the wanted workers are registered", async () => {
    const { route, teamHub, health, shutdown, of } = await harness({
      healthy: false,
    });
    teamHub.keys = { xai_api_key: XAI };
    let answer: unknown;
    const answered = Promise.resolve(route.fetch(reconcileRequest())).then(
      async (response) => {
        expect(response.status).toBe(200);
        answer = await response.json();
      },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(of("live")).toHaveLength(1);
    expect(answer).toBeUndefined();
    health.healthy = true;
    await vi.advanceTimersByTimeAsync(250);
    await answered;
    expect(answer).toEqual({ ready: true });
    await shutdown();
  });

  it("answers not ready when the workers miss the wait", async () => {
    const { route, teamHub, shutdown } = await harness({ healthy: false });
    teamHub.keys = { soniox_api_key: SONIOX };
    let answer: unknown;
    const answered = Promise.resolve(route.fetch(reconcileRequest())).then(
      async (response) => {
        answer = await response.json();
      },
    );
    await vi.advanceTimersByTimeAsync(VOICE_READY_WAIT_MS - 1_000);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    await answered;
    expect(answer).toEqual({ ready: false });
    await shutdown();
  });

  it("answers ready at once when no key wants a worker", async () => {
    const { route, shutdown } = await harness({ healthy: false });
    const response = await route.fetch(reconcileRequest());
    expect(await response.json()).toEqual({ ready: true });
    await shutdown();
  });

  it("answers not ready when TeamHub's keys cannot be read", async () => {
    const { route, teamHub, shutdown, log } = await harness({
      keys: { soniox_api_key: SONIOX },
    });
    teamHub.failure = 503;
    const response = await route.fetch(reconcileRequest());
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ ready: false });
    expect(body).not.toContain(SONIOX);
    expect(JSON.stringify(log.mock.calls)).not.toContain(SONIOX);
    await shutdown();
  });

  it("ends the readiness wait when the service stops", async () => {
    const { route, teamHub, shutdown } = await harness({ healthy: false });
    teamHub.keys = { xai_api_key: XAI };
    let answer: unknown;
    const answered = Promise.resolve(route.fetch(reconcileRequest())).then(
      async (response) => {
        answer = await response.json();
      },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(answer).toBeUndefined();
    await shutdown();
    await answered;
    expect(answer).toEqual({ ready: false });
  });

  it("authenticates the reconcile route", async () => {
    const { route, teamHub, shutdown } = await harness();
    const calls = teamHub.calls;
    for (const authorization of [undefined, "Bearer wrong"]) {
      const response = await route.fetch(
        new Request("http://x/v1/voice/workers:reconcile", {
          method: "POST",
          ...(authorization ? { headers: { authorization } } : {}),
        }),
      );
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("UNAUTHENTICATED");
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(teamHub.calls).toBe(calls);
    await shutdown();
  });

  it("restarts only the failed worker and drains all media before returning", async () => {
    const { of, service, unmount, teamHub } = await harness({
      keys: { soniox_api_key: SONIOX, xai_api_key: XAI },
    });
    of("live")[0]!.child.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(1000);
    expect(of("live")).toHaveLength(2);
    expect(of("recorder")).toHaveLength(1);
    expect(of("asr")).toHaveLength(1);
    let drained = false;
    const stopping = service.stop().then(() => {
      drained = true;
    });
    for (const worker of ["asr", "recorder", "live"] as const)
      expect(of(worker).at(-1)!.child.kill).toHaveBeenCalledWith("SIGTERM");
    of("live").at(-1)!.child.emit("exit", 0, null);
    of("asr")[0]!.child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(2000);
    expect(drained).toBe(false);
    of("recorder")[0]!.child.emit("exit", 0, null);
    await stopping;
    const calls = teamHub.calls;
    await vi.advanceTimersByTimeAsync(VOICE_RECONCILE_POLL_MS * 2);
    expect(of("live")).toHaveLength(2);
    expect(teamHub.calls).toBe(calls);
    expect(unmount).toHaveBeenCalledOnce();
  });
});
