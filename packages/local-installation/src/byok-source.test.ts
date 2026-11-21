import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkByokEndpoint,
  isAllowedByokUrl,
  listByokModels,
  prepareByokNativeRuntime,
  prepareByokRuntime,
  applyNativeSource,
  readByokEnvironment,
  validateByokConfiguration,
} from "./byok-source.js";
import { atomicPrivate, privateDirectory } from "./instance.js";
import type { prepareRuntime } from "./managed-runtimes.js";
import { restoreByokSource, withLocalModelsLock } from "./local-models.js";

const tempDirs: string[] = [];

async function makeHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "linger-byok-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("isAllowedByokUrl", () => {
  it("allows HTTPS and private LAN/loopback HTTP endpoints", () => {
    expect(isAllowedByokUrl("https://api.openai.com/v1/")).toBe(true);
    expect(isAllowedByokUrl("http://127.0.0.1:8000/v1")).toBe(true);
    expect(isAllowedByokUrl("http://192.168.10.117:8080/v1")).toBe(true);
    expect(isAllowedByokUrl("http://100.88.1.5:11434/v1")).toBe(true);
    expect(
      validateByokConfiguration({
        baseUrl: "https://api.openai.com/",
        path: "/v1",
        endpoint: "/responses",
        protocol: "openai-responses",
        modelId: "gpt-5.4",
      }).baseUrl,
    ).toBe("https://api.openai.com");
  });

  it("accepts an empty path or endpoint and refuses one that could leave the base URL", () => {
    const base = {
      baseUrl: "https://gw.example.com/full",
      path: "",
      endpoint: "",
      protocol: "anthropic",
      modelId: "m",
    };
    expect(validateByokConfiguration(base)).toMatchObject({
      path: "",
      endpoint: "",
    });
    for (const bad of [
      { path: "v1" },
      { path: "/v1/" },
      { endpoint: "//evil.example.com/x" },
      { endpoint: "/chat?key=1" },
      { protocol: "gemini" },
    ])
      expect(() => validateByokConfiguration({ ...base, ...bad })).toThrow();
  });

  it("blocks link-local metadata, public HTTP, and URL credentials", () => {
    expect(isAllowedByokUrl("http://169.254.169.254/latest/meta-data")).toBe(
      false,
    );
    expect(isAllowedByokUrl("https://metadata.google.internal/v1")).toBe(false);
    expect(isAllowedByokUrl("http://api.example.com/v1")).toBe(false);
    expect(isAllowedByokUrl("https://user@api.example.com/v1")).toBe(false);
  });
});

describe("BYOK localmodels integration", () => {
  it("passes BYOK secrets over stdin and never in argv", async () => {
    const home = await makeHome();
    const calls: { args: string[]; input?: string }[] = [];
    const fakeLocalmodels = vi.fn(
      async (
        _home: string,
        args: string[],
        options: { input?: string } = {},
      ) => {
        calls.push({ args, input: options.input });
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            protocol: "openai-responses",
            url: "https://api.example.com/v1/responses",
            model_id: "gpt-5.4",
            context_window: 200_000,
          }),
          stderr: "",
        };
      },
    );
    const report = await checkByokEndpoint(
      home,
      {
        baseUrl: "https://api.example.com",
        path: "/v1",
        endpoint: "/responses",
        protocol: "openai-responses",
        apiKey: "sk-private-secret",
        modelId: "gpt-5.4",
        runtime: "codex",
      },
      new AbortController().signal,
      { localmodels: fakeLocalmodels },
    );
    expect(report).toEqual({
      ok: true,
      protocol: "openai-responses",
      url: "https://api.example.com/v1/responses",
      modelId: "gpt-5.4",
      contextWindow: 200_000,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.join(" ")).not.toContain("sk-private-secret");
    expect(calls[0]!.args).toContain("--config-stdin");
    expect(calls[0]!.args).not.toContain("--runtime");
    expect(JSON.parse(calls[0]!.input!)).toEqual({
      baseUrl: "https://api.example.com",
      path: "/v1",
      endpoint: "/responses",
      protocol: "openai-responses",
      apiKey: "sk-private-secret",
      modelId: "gpt-5.4",
    });
  });

  it("lists models at the endpoint's model address with the key on stdin", async () => {
    const calls: { args: string[]; input?: string }[] = [];
    const listing = await listByokModels(
      await makeHome(),
      {
        baseUrl: "https://open.bigmodel.cn",
        path: "/api/paas/v4",
        endpoint: "/chat/completions",
        protocol: "openai-chat",
        apiKey: "sk-list-secret",
      },
      new AbortController().signal,
      {
        localmodels: async (_home, args, options = {}) => {
          calls.push({ args, input: options.input });
          return {
            code: 0,
            stdout: JSON.stringify({
              ok: true,
              url: "https://open.bigmodel.cn/api/paas/v4/models",
              models: [
                { id: "glm-4.6", name: "GLM 4.6", context_window: 131_072 },
                { id: "glm-4.5", name: null, context_window: null },
              ],
            }),
            stderr: "",
          };
        },
      },
    );
    expect(listing).toEqual({
      url: "https://open.bigmodel.cn/api/paas/v4/models",
      models: [
        { id: "glm-4.6", name: "GLM 4.6", contextWindow: 131_072 },
        { id: "glm-4.5" },
      ],
    });
    expect(calls[0]!.args).toEqual([
      "source",
      "models",
      "--config-stdin",
      "--json",
    ]);
    expect(JSON.parse(calls[0]!.input!)).toMatchObject({
      path: "/api/paas/v4",
      apiKey: "sk-list-secret",
    });

    await expect(
      listByokModels(
        await makeHome(),
        {
          baseUrl: "https://open.bigmodel.cn",
          path: "/api/paas/v4",
          endpoint: "/chat/completions",
          protocol: "openai-chat",
        },
        new AbortController().signal,
        {
          localmodels: async () => ({
            code: 1,
            stdout: JSON.stringify({
              ok: false,
              code: "BYOK_NOT_FOUND",
              message:
                "https://open.bigmodel.cn/api/paas/v4/models returned HTTP 404.",
            }),
            stderr: "",
          }),
        },
      ),
    ).rejects.toMatchObject({ code: "BYOK_NOT_FOUND" });
  });

  it("mounts BYOK on Bifrost even when native runtime lacks vendor OAuth", async () => {
    const home = await makeHome();
    const outcome = await prepareByokRuntime(
      {
        baseUrl: "https://api.anthropic.com",
        path: "/v1",
        endpoint: "/messages",
        protocol: "anthropic",
        apiKey: "sk-ant-test",
        modelId: "claude-sonnet-4-6",
        runtime: "claude",
      },
      {
        home,
        signal: new AbortController().signal,
        onEvent: () => {},
      },
      {
        prepareNative: async () => ({
          code: 1,
          state: "waiting_user",
          message: "Login required",
          details: { code: "RUNTIME_AUTH_REQUIRED" },
        }),
        localmodels: async () => ({
          code: 0,
          stdout: JSON.stringify({ ok: true }),
          stderr: "",
        }),
      },
    );
    expect(outcome.code).toBe(0);
    expect(outcome.state).toBe("ready");
  });

  it("sets a subscription source through localmodels, never writing it itself", async () => {
    const home = await makeHome();
    const calls: string[][] = [];
    const outcome = await applyNativeSource(
      home,
      "subscription",
      "codex",
      { signal: new AbortController().signal },
      {
        localmodels: async (_home, args) => {
          calls.push(args);
          return { code: 0, stdout: "{}", stderr: "" };
        },
      },
    );
    expect(outcome).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 6)).toEqual([
      "source",
      "apply",
      "--mode",
      "subscription",
      "--runtime",
      "codex",
    ]);
    expect(calls[0]).not.toContain("--config-stdin");
    expect(await readByokEnvironment(home)).toBeUndefined();
  });

  it("reports what localmodels refused when setting a source", async () => {
    const outcome = await applyNativeSource(
      await makeHome(),
      "local",
      "pi",
      { signal: new AbortController().signal },
      {
        localmodels: async () => ({
          code: 2,
          stdout: JSON.stringify({
            code: "MODEL_UNKNOWN",
            message: "No model is loaded.",
          }),
          stderr: "",
        }),
      },
    );
    expect(outcome).toEqual({
      code: 1,
      state: "failed",
      message: "No model is loaded.",
      details: { code: "MODEL_UNKNOWN" },
    });
  });

  it("reads the runtime environment overrides localmodels recorded", async () => {
    const home = await makeHome();
    const state = path.join(home, "runtime", "localmodels", "state");
    await privateDirectory(state);
    await atomicPrivate(
      path.join(state, "model-source.json"),
      JSON.stringify({
        schema: "localmodels.model-source/v1",
        mode: "byok",
        runtime: "pi",
        runtime_model: "localmodels-byok",
        model_label: "vendor/model",
        gateway_url: "http://127.0.0.1:18480",
        environment: { PI_CODING_AGENT_DIR: "/abs/pi", OTHER: "/ignored" },
      }),
    );
    expect(await readByokEnvironment(home)).toEqual({
      mode: "byok",
      runtime: "pi",
      runtimeModel: "localmodels-byok",
      environment: { PI_CODING_AGENT_DIR: "/abs/pi" },
      gatewayUrl: "http://127.0.0.1:18480",
    });
  });

  async function mountWithHeartbeat(settle: "resolve" | "reject") {
    const home = await makeHome();
    const events: { kind: string; stage?: string; message: string }[] = [];
    let resolveApply!: (value: {
      code: number;
      stdout: string;
      stderr: string;
    }) => void;
    let rejectApply!: (error: Error) => void;
    const promise = prepareByokRuntime(
      {
        baseUrl: "https://api.example.com",
        path: "/v1",
        endpoint: "/responses",
        protocol: "openai-responses",
        modelId: "gpt-4o",
        runtime: "codex",
      },
      {
        home,
        signal: new AbortController().signal,
        onEvent: (event) => events.push(event),
      },
      {
        prepareNative: async () => ({
          code: 0,
          state: "ready",
          message: "ok",
        }),
        localmodels: () =>
          new Promise((resolve, reject) => {
            resolveApply = resolve;
            rejectApply = reject;
          }),
      },
    );
    await vi.advanceTimersByTimeAsync(9_900);
    const beforeTen = events.length;
    await vi.advanceTimersByTimeAsync(200);
    const heartbeats = events.slice(beforeTen);
    if (settle === "resolve")
      resolveApply({ code: 0, stdout: "{}", stderr: "" });
    else rejectApply(new Error("localmodels crashed"));
    const outcome = await promise.catch((error: Error) => error);
    return { events, beforeTen, heartbeats, outcome };
  }

  it("logs elapsed progress every 10s while mounting the BYOK gateway", async () => {
    vi.useFakeTimers();
    try {
      const { events, beforeTen, heartbeats, outcome } =
        await mountWithHeartbeat("resolve");
      expect(outcome).toMatchObject({ state: "ready" });
      const stages = events.slice(0, beforeTen);
      expect(stages).toEqual([
        expect.objectContaining({
          kind: "stage",
          message: expect.stringMatching(/^Mounting BYOK endpoint/),
        }),
      ]);
      expect(heartbeats).toEqual([
        {
          kind: "log",
          stage: "runtime",
          message: "Local BYOK model gateway is starting (10s elapsed).\n",
        },
      ]);
      const count = events.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(events.length).toBe(count);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the BYOK heartbeat when the mount rejects", async () => {
    vi.useFakeTimers();
    try {
      const { events, heartbeats, outcome } =
        await mountWithHeartbeat("reject");
      expect(outcome).toBeInstanceOf(Error);
      expect(heartbeats.map((event) => event.kind)).toEqual(["log"]);
      const count = events.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(events.length).toBe(count);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

async function writeSource(home: string, source: unknown): Promise<void> {
  const state = path.join(home, "runtime", "localmodels", "state");
  await privateDirectory(state);
  await atomicPrivate(
    path.join(state, "model-source.json"),
    typeof source === "string" ? source : JSON.stringify(source),
  );
}

function byokSource(gatewayUrl: string | null = "http://127.0.0.1:18480") {
  return {
    schema: "localmodels.model-source/v1",
    mode: "byok",
    runtime: "pi",
    runtime_model: "localmodels-byok",
    model_label: "vendor/model",
    gateway_url: gatewayUrl,
    environment: {},
  };
}

describe("prepareByokNativeRuntime", () => {
  it("forwards the cold-resume options only when given", async () => {
    const prepareNative = vi.fn<typeof prepareRuntime>(async () => ({
      code: 0,
      state: "ready",
      message: "ok",
    }));
    const base = {
      home: "/home",
      signal: new AbortController().signal,
      onEvent: () => {},
    };
    const onDescriptor = vi.fn();
    await prepareByokNativeRuntime(
      "pi",
      { ...base, reuseInstalled: true, onDescriptor },
      { prepareNative },
    );
    expect(prepareNative.mock.calls[0]?.[1]).toMatchObject({
      reuseInstalled: true,
      onDescriptor,
    });
    await prepareByokNativeRuntime("pi", base, { prepareNative });
    expect(prepareNative.mock.calls[1]?.[1]).not.toHaveProperty(
      "reuseInstalled",
    );
    expect(prepareNative.mock.calls[1]?.[1]).not.toHaveProperty("onDescriptor");
  });
});

describe("restoreByokSource", () => {
  const ok = async () => ({ code: 0, stdout: "{}", stderr: "" });

  it("mounts the saved BYOK source from its saved configuration when the gateway is down", async () => {
    const home = await makeHome();
    await writeSource(home, byokSource());
    const localmodels = vi.fn(ok);
    const fetch = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    await restoreByokSource(
      home,
      { signal: new AbortController().signal, onEvent: () => {} },
      { localmodels, fetch },
    );
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:18480/health",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(localmodels).toHaveBeenCalledTimes(1);
    const [, args, options] = localmodels.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(args.slice(0, 6)).toEqual([
      "source",
      "apply",
      "--mode",
      "byok",
      "--runtime",
      "pi",
    ]);
    expect(args.at(-1)).toBe("--json");
    expect(args).not.toContain("--config-stdin");
    expect(options).not.toHaveProperty("input");
    expect(options.restoreSavedByok).toBe(true);
  });

  it("uses normal source apply when no gateway URL was recorded", async () => {
    const home = await makeHome();
    await writeSource(home, byokSource(null));
    const localmodels = vi.fn(ok);
    await restoreByokSource(
      home,
      {
        signal: new AbortController().signal,
        onEvent: () => {},
      },
      { localmodels },
    );
    expect(localmodels).toHaveBeenCalledWith(
      home,
      expect.any(Array),
      expect.objectContaining({ restoreSavedByok: false }),
    );
  });

  it.each(["models.json", "settings.json"])(
    "repairs a healthy gateway's managed Pi profile when %s is missing",
    async (missing) => {
      const home = await makeHome();
      const profile = path.join(home, "pi");
      await privateDirectory(profile);
      await Promise.all(
        ["models.json", "settings.json"].map((name) =>
          fs.writeFile(path.join(profile, name), "{}"),
        ),
      );
      await writeSource(home, {
        ...byokSource(),
        environment: { PI_CODING_AGENT_DIR: profile },
      });
      const localmodels = vi.fn(ok);
      const options = {
        signal: new AbortController().signal,
        onEvent: () => {},
      };
      const dependencies = {
        localmodels,
        fetch: async () => new Response("ok"),
      };
      await restoreByokSource(home, options, dependencies);
      expect(localmodels).not.toHaveBeenCalled();
      await fs.unlink(path.join(profile, missing));
      await restoreByokSource(home, options, dependencies);
      expect(localmodels).toHaveBeenCalledExactlyOnceWith(
        home,
        expect.any(Array),
        expect.objectContaining({ restoreSavedByok: true }),
      );
    },
  );

  it("reports a skipped recovery when the Computer switched model sources", async () => {
    const home = await makeHome();
    await writeSource(home, byokSource());
    const onEvent = vi.fn();
    await restoreByokSource(
      home,
      { signal: new AbortController().signal, onEvent },
      {
        fetch: async () => new Response(null, { status: 503 }),
        localmodels: async () => ({
          code: 0,
          stdout: '{"restore":"skipped"}',
          stderr: "",
        }),
      },
    );
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "skipped" }),
    );
  });

  it("leaves a gateway that already answers alone", async () => {
    const home = await makeHome();
    await writeSource(home, byokSource());
    const localmodels = vi.fn(ok);
    const fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    await restoreByokSource(
      home,
      { signal: new AbortController().signal, onEvent: () => {} },
      { localmodels, fetch },
    );
    expect(localmodels).not.toHaveBeenCalled();
  });

  it.each([
    ["local", { ...byokSource(), mode: "local" }],
    ["subscription", { ...byokSource(), mode: "subscription" }],
    ["malformed", "{not json"],
    ["missing", undefined],
  ])("does nothing for a %s source", async (_name, source) => {
    const home = await makeHome();
    if (source !== undefined) await writeSource(home, source);
    const localmodels = vi.fn(ok);
    const fetch = vi.fn(async () => new Response("ok"));
    await restoreByokSource(
      home,
      { signal: new AbortController().signal, onEvent: () => {} },
      { localmodels, fetch },
    );
    expect(localmodels).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "http://10.0.0.5:18480",
    "https://127.0.0.1:18480",
    "http://127.0.0.1",
    "http://user:pw@127.0.0.1:18480",
    "http://127.0.0.1:18480/?x=1",
    "not a url",
    null,
  ])("never probes the gateway URL %s and applies", async (gatewayUrl) => {
    const home = await makeHome();
    await writeSource(home, byokSource(gatewayUrl));
    const localmodels = vi.fn(ok);
    const fetch = vi.fn(async () => new Response("ok"));
    await restoreByokSource(
      home,
      { signal: new AbortController().signal, onEvent: () => {} },
      { localmodels, fetch },
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(localmodels).toHaveBeenCalledTimes(1);
  });

  it("logs and returns a failed mount without throwing", async () => {
    const home = await makeHome();
    await writeSource(home, byokSource(null));
    const events: { kind: string; message: string }[] = [];
    const failure = await restoreByokSource(
      home,
      {
        signal: new AbortController().signal,
        onEvent: (event) => events.push(event),
      },
      {
        localmodels: vi.fn(async () => ({
          code: 1,
          stdout: JSON.stringify({
            code: "BYOK_UNREACHABLE",
            message: "Endpoint did not answer.",
          }),
          stderr: "",
        })),
      },
    );
    expect(failure).toEqual({
      code: "BYOK_UNREACHABLE",
      message: "Endpoint did not answer.",
    });
    const log = events.find((event) => event.kind === "log");
    expect(log?.message).toContain("Endpoint did not answer.");
    expect(log?.message).toContain("BYOK_UNREACHABLE");

    events.length = 0;
    expect(
      await restoreByokSource(
        home,
        {
          signal: new AbortController().signal,
          onEvent: (event) => events.push(event),
        },
        {
          localmodels: vi.fn(async () => ({
            code: 1,
            stdout: "raw private tool output",
            stderr: "",
          })),
        },
      ),
    ).toMatchObject({ code: "BYOK_GATEWAY_FAILED" });
    expect(JSON.stringify(events)).not.toContain("raw private tool output");
    expect(events.some((event) => event.kind === "log")).toBe(true);
  });

  it("keeps the cause of a tool that could not run", async () => {
    const home = await makeHome();
    await writeSource(home, byokSource(null));
    expect(
      await restoreByokSource(
        home,
        { signal: new AbortController().signal, onEvent: () => {} },
        {
          localmodels: vi.fn(async () => {
            throw new Error("The installed localmodels tool kit is missing.");
          }),
        },
      ),
    ).toEqual({
      code: "BYOK_GATEWAY_FAILED",
      message: "The installed localmodels tool kit is missing.",
    });
  });

  it("waits for a quit-time stop holding the lock, then mounts", async () => {
    const home = await makeHome();
    await writeSource(home, byokSource(null));
    const localmodels = vi.fn(ok);
    let release!: () => void;
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const stop = withLocalModelsLock(home, async () => {
      held();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await holding;
    const restored = restoreByokSource(
      home,
      { signal: new AbortController().signal, onEvent: () => {} },
      { localmodels, lockRetryMs: 5, lockWaitMs: 10_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(localmodels).not.toHaveBeenCalled();
    release();
    await stop;
    expect(await restored).toBeUndefined();
    expect(localmodels).toHaveBeenCalledTimes(1);
  });

  it("gives up on a lock that is never released without applying", async () => {
    const home = await makeHome();
    await writeSource(home, byokSource(null));
    const localmodels = vi.fn(ok);
    let release!: () => void;
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const stop = withLocalModelsLock(home, async () => {
      held();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await holding;
    expect(
      await restoreByokSource(
        home,
        { signal: new AbortController().signal, onEvent: () => {} },
        { localmodels, lockRetryMs: 5, lockWaitMs: 30 },
      ),
    ).toMatchObject({ code: "LOCAL_MODELS_BUSY" });
    expect(localmodels).not.toHaveBeenCalled();
    release();
    await stop;
  });

  it("lets a cancel through", async () => {
    const home = await makeHome();
    await writeSource(home, byokSource(null));
    const controller = new AbortController();
    await expect(
      restoreByokSource(
        home,
        { signal: controller.signal, onEvent: () => {} },
        {
          localmodels: vi.fn(async () => {
            controller.abort();
            throw new Error("aborted");
          }),
        },
      ),
    ).rejects.toThrow();
  });
});

describe("source apply timeouts and progress", () => {
  const onEvent = () => {};

  it("bounds a BYOK apply by silence, not wall clock, and forwards events", async () => {
    const localmodels = vi.fn(async () => ({
      code: 0,
      stdout: "{}",
      stderr: "",
    }));
    await prepareByokRuntime(
      {
        baseUrl: "https://api.example.com",
        path: "/v1",
        endpoint: "/messages",
        protocol: "anthropic",
        apiKey: "sk-test",
        modelId: "m",
        runtime: "claude",
      },
      { home: await makeHome(), signal: new AbortController().signal, onEvent },
      {
        prepareNative: async () => ({ code: 0, state: "ready", message: "" }),
        localmodels,
      },
    );
    const options = (localmodels.mock.calls[0] as unknown[])[2] as Record<
      string,
      unknown
    >;
    expect(options).toMatchObject({ idleTimeoutMs: 240_000, onEvent });
    expect(options).not.toHaveProperty("timeoutMs");
  });

  it("bounds a native source apply by silence and still reads its failure", async () => {
    const localmodels = vi.fn(async () => ({
      code: 2,
      stdout: JSON.stringify({
        code: "GATEWAY_FAILED",
        message: "No gateway.",
      }),
      stderr:
        '{"kind":"stage","stage":"download","state":"connecting","host":"registry.npmmirror.com"}\n',
    }));
    const outcome = await applyNativeSource(
      await makeHome(),
      "local",
      "pi",
      { signal: new AbortController().signal, onEvent },
      { localmodels },
    );
    expect(outcome).toMatchObject({
      message: "No gateway.",
      details: { code: "GATEWAY_FAILED" },
    });
    const options = (localmodels.mock.calls[0] as unknown[])[2] as Record<
      string,
      unknown
    >;
    expect(options).toMatchObject({ idleTimeoutMs: 240_000, onEvent });
    expect(options).not.toHaveProperty("timeoutMs");
  });

  it("keeps the resume mount's wall clock and forwards its events", async () => {
    const home = await makeHome();
    await writeSource(home, byokSource(null));
    const localmodels = vi.fn(async () => ({
      code: 0,
      stdout: "{}",
      stderr: "",
    }));
    await restoreByokSource(
      home,
      { signal: new AbortController().signal, onEvent },
      { localmodels },
    );
    const apply = localmodels.mock.calls.find((call) =>
      (call as unknown[])[1]?.toString().startsWith("source,apply"),
    ) as unknown[] | undefined;
    expect(apply?.[2]).toMatchObject({ timeoutMs: 90_000, onEvent });
    expect(apply?.[2]).not.toHaveProperty("idleTimeoutMs");
  });
});
