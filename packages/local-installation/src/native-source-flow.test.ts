import { prepareFoundationServices } from "./foundation-services.js";
vi.mock("./foundation-services.js", () => ({
  prepareFoundationServices: vi.fn(async () => {}),
}));
import { prepareModelGateway, stopModelGateway } from "./model-gateway.js";
vi.mock("./model-gateway.js", () => ({
  prepareModelGateway: vi.fn(async () => {}),
  stopModelGateway: vi.fn(async () => {}),
}));
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import {
  compileFailureExcerpt,
  createVoiceToolsBackgroundLauncher,
  installNativeSource,
  prepareVoiceToolsAndStartLiveKit,
  stopNativeSource,
} from "./native-source.js";
import {
  canBuildNativeServicesFromSource,
  canCompileTeamhubFromSource,
  isMinimalSourceSkeleton,
} from "./source-checkout.js";
import { localIdentityProof } from "./account.js";
import { runProcess } from "./process.js";
import { REGION_SCHEMA, regionFile } from "./region.js";
import {
  installAppleDeveloperTools,
  needsAppleDeveloperTools,
} from "./apple-developer-tools.js";
import type { InstallOutcome, InstallerEvent } from "./events.js";
import {
  prepareNativeDependencies,
  prepareNativeVoiceTools,
  resolveNativeVoiceToolsPlan,
} from "./native-dependencies.js";
import {
  prepareLiveKitSettings,
  readLiveKitSettings,
  startNativeLiveKit,
} from "./native-livekit.js";
import { PortAllocationError } from "./ports.js";
import { updateUserKeys } from "./user-environment.js";
import {
  NATIVE_RUNTIME_DIRECTORY,
  NATIVE_RUNTIME_FILES,
} from "./native-runtime.js";
import {
  TEAMHUB_BINARY_DIRECTORY,
  TEAMHUB_COMMANDS,
} from "./teamhub-binaries.js";
import { prepareRuntime, type RuntimeDescriptor } from "./managed-runtimes.js";
import { managedRuntimeEnvironment } from "./managed-codex.js";
import { applyNativeSource, prepareByokRuntime } from "./byok-source.js";
import {
  atomicPrivate,
  privateDirectory,
  withInstanceLock,
} from "./instance.js";
import {
  prepareLocalModels,
  restoreByokSource,
  restoreLocalModels,
} from "./local-models.js";
import {
  readResumeLocalModels,
  writeResumeLocalModels,
} from "./localmodels-tool.js";
import {
  inspectNativeListeners,
  inspectNativeProcess,
  nativeConfigurationChanged,
  reclaimNativeOrphans,
  SERVICE_RESTART_POLICY,
  startNativeProcess,
  stopNativeProcess,
} from "./native-process.js";
import { prepareNativeDatabase } from "./native-database.js";
import { prepareSourceComputer } from "./source-computer.js";
import { connectComputer } from "./computer.js";
import { loadInstance } from "./instance.js";
vi.mock("./process.js", () => ({ runProcess: vi.fn() }));
vi.mock("./apple-developer-tools.js", () => ({
  needsAppleDeveloperTools: vi.fn(),
  installAppleDeveloperTools: vi.fn(),
}));
vi.mock("./native-dependencies.js", () => ({
  prepareNativeDependencies: vi.fn(),
  prepareNativeVoiceTools: vi.fn(),
  resolveNativeVoiceToolsPlan: vi.fn(),
}));
vi.mock("./native-livekit.js", async (original) => {
  const actual = await original<typeof import("./native-livekit.js")>();
  return {
    ...actual,
    prepareLiveKitSettings: vi.fn(actual.prepareLiveKitSettings),
    readLiveKitSettings: vi.fn(),
    startNativeLiveKit: vi.fn(),
  };
});
// Setting the model source runs the localmodels tool, which these tests never
// install.
vi.mock("./byok-source.js", async (original) => ({
  ...(await original<typeof import("./byok-source.js")>()),
  applyNativeSource: vi.fn(async () => undefined),
  prepareByokRuntime: vi.fn(),
}));
// Deploying local models runs the localmodels tool too.
vi.mock("./local-models.js", async (original) => ({
  ...(await original<typeof import("./local-models.js")>()),
  prepareLocalModels: vi.fn(async () => undefined),
  restoreByokSource: vi.fn(async () => undefined),
  restoreLocalModels: vi.fn(async () => undefined),
}));
vi.mock("./managed-runtimes.js", () => ({
  runtimeVersionFailure: vi.fn(() => undefined),
  prepareRuntime: vi.fn(),
}));
vi.mock("./managed-codex.js", () => ({
  managedRuntimeEnvironment: vi.fn(async () => ({})),
  configureManagedCodex: vi.fn(),
}));
vi.mock("./native-process.js", () => {
  const inspectNativeProcess = vi.fn();
  const stopNativeProcess = vi.fn();
  return {
    inspectNativeProcess,
    inspectNativeProcesses: async (root: string, names: readonly string[]) =>
      Promise.all(names.map((name) => inspectNativeProcess(root, name))),
    // Port ownership is checked only on Windows; elsewhere it is the
    // process state.
    inspectNativeListeners: vi.fn(
      async (root: string, listeners: { name: string; port: number }[]) =>
        Promise.all(
          listeners.map(async ({ name }) => ({
            running: Boolean(
              (
                (await inspectNativeProcess(root, name)) as {
                  running?: boolean;
                }
              )?.running,
            ),
          })),
        ),
    ),
    reclaimNativeOrphans: vi.fn(async () => []),
    nativeConfigurationChanged: vi.fn(),
    startNativeProcess: vi.fn(),
    stopNativeProcess,
    stopNativeProcesses: async (
      root: string,
      names: readonly string[],
      options: {
        signal?: AbortSignal;
        interruptMs?: number;
        onServiceDone?: (
          name: string,
          durationMs: number,
          error?: unknown,
        ) => void;
      } = {},
    ) => {
      for (const name of names) {
        options.signal?.throwIfAborted();
        const startedAt = Date.now();
        try {
          await stopNativeProcess(root, name);
        } catch (error) {
          options.onServiceDone?.(name, Date.now() - startedAt, error);
          throw error;
        }
        options.onServiceDone?.(name, Date.now() - startedAt);
      }
    },
    SERVICE_RESTART_POLICY: {
      delaysMs: [1_000],
      windowMs: 60_000,
      limit: 5,
      armAfterMs: 10_000,
    },
  };
});
vi.mock("./native-database.js", () => ({ prepareNativeDatabase: vi.fn() }));
vi.mock("./source-computer.js", () => ({ prepareSourceComputer: vi.fn() }));
vi.mock("./computer.js", () => ({
  connectComputer: vi.fn(async () => ({
    connected: true,
    state: "ready",
    detail: "connected",
    runtimes: [],
    activeOperations: 0,
  })),
  stopComputer: vi.fn(),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "native-flow-"));
  roots.push(home);
  // A region resolved earlier, so no test probes the registries.
  await mkdir(path.dirname(regionFile(home)), { recursive: true });
  await writeFile(
    regionFile(home),
    JSON.stringify({
      schema: REGION_SCHEMA,
      region: "global",
      resolved_at: new Date().toISOString(),
      method: "probe",
    }),
  );
  const repo = path.join(home, "checkout");
  await mkdir(path.join(repo, "scripts"), { recursive: true });
  await writeFile(path.join(repo, "scripts/source-native.mjs"), "");
  await writeFile(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "linger" }),
  );
  vi.mocked(prepareNativeDependencies).mockResolvedValue({
    env: {},
    postgresBin: "/private/postgres/bin",
    toolchainRoot: "/private/tools",
    registries: ["https://registry.npmjs.org/"],
  });
  let provisioned = false;
  vi.mocked(runProcess).mockImplementation(async (_command, args) => {
    if (args.includes("owner")) provisioned = true;
    return { code: 0, stdout: "", stderr: "" };
  });
  const running = new Set<string>();
  vi.mocked(inspectNativeProcess).mockImplementation(async (_root, name) => ({
    running: running.has(name),
  }));
  vi.mocked(startNativeProcess).mockImplementation(async (options) => {
    running.add(options.name);
    return { running: true, pid: 100 };
  });
  vi.mocked(nativeConfigurationChanged).mockResolvedValue(false);
  vi.mocked(reclaimNativeOrphans).mockResolvedValue([]);
  vi.mocked(stopNativeProcess).mockImplementation(async (_root, name) => {
    running.delete(name);
  });
  vi.mocked(prepareNativeDatabase).mockImplementation(async () => {
    running.add("postgres");
    return {};
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init?: RequestInit) =>
      String(url).endsWith("/v0/local/identity")
        ? identityProof(home, String(url), init)
        : new Response("{}", {
            status:
              String(url).endsWith("/v0/auth/login") && !provisioned
                ? 401
                : 200,
          }),
    ),
  );
  return { home, repo, running };
}
// The instance's TeamHub answering at its origin (see account.ts).
async function identityProof(home: string, url: string, init?: RequestInit) {
  const origin = new URL(url).origin;
  const { nonce } = JSON.parse(init?.body as string) as { nonce: string };
  for (const name of await readdir(path.join(home, "instances"))) {
    const root = path.join(home, "instances", name);
    const instance = JSON.parse(
      await readFile(path.join(root, "instance.json"), "utf8"),
    ) as { origin: string };
    if (instance.origin !== origin) continue;
    const key = await readFile(path.join(root, "local-identity.key"), "utf8");
    return Response.json({
      proof: localIdentityProof(
        Buffer.from(key.trim(), "base64"),
        nonce,
        origin,
      ).toString("base64url"),
    });
  }
  return new Response(null, { status: 404 });
}
test("native services and owner creation continue while selected Runtime authentication is pending", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 4,
    state: "action_required",
    message: "sign in later",
    details: { code: "RUNTIME_AUTH_REQUIRED" },
  });
  const events: string[] = [];
  const result = await installNativeSource({
    home: f.home,
    repo: path.relative(process.cwd(), f.repo),
    name: "native-flow",
    setupChoice: "pi",
    shareGpu: true,
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event.message),
  });
  expect(result.code).toBe(4);
  expect(prepareModelGateway).toHaveBeenCalledWith(
    expect.anything(),
    "pi",
    expect.objectContaining({ home: f.home }),
  );
  expect(prepareFoundationServices).toHaveBeenCalledWith(
    expect.objectContaining({ root: expect.any(String) }),
    "pi",
    expect.objectContaining({
      shareGpu: true,
      signal: expect.any(AbortSignal),
    }),
  );
  expect(
    (result.details as { services: { ready: boolean }[] }).services.every(
      (row) => row.ready,
    ),
  ).toBe(true);
  expect(f.running).toEqual(
    new Set(["postgres", "teamhub", "node-services", "web"]),
  );
  expect(stopNativeProcess).not.toHaveBeenCalled();
  const owner = vi
    .mocked(runProcess)
    .mock.calls.find((row) => row[1].includes("owner"));
  expect(owner?.[0]).toBe(process.execPath);
  expect(owner?.[1][0]).toBe(path.join(f.repo, "scripts/source-native.mjs"));
  expect(owner?.[2]?.cwd).toBe(f.repo);
  expect(owner?.[2]?.input?.trim().length).toBeGreaterThan(8);
  expect(JSON.stringify(owner?.[1])).not.toContain(owner?.[2]?.input?.trim());
  expect(events.join("\n")).not.toContain(owner?.[2]?.input?.trim());
});
test("choosing local models makes them the model source", async () => {
  const f = await fixture();
  const result = await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-flow",
    setupChoice: "local-models",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(result.code).toBe(0);
  expect(prepareLocalModels).toHaveBeenCalled();
  expect(prepareFoundationServices).toHaveBeenCalledWith(
    expect.anything(),
    "local-models",
    expect.objectContaining({ mainPlan: true }),
  );
  expect(applyNativeSource).toHaveBeenCalledWith(
    path.resolve(f.home),
    "local",
    "pi",
    { signal: expect.any(AbortSignal), onEvent: expect.any(Function) },
  );
});

test("a restart of local models keeps the model source the person switched to", async () => {
  const f = await fixture();
  await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-flow",
    setupChoice: "local-models",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  vi.mocked(applyNativeSource).mockClear();
  vi.mocked(prepareFoundationServices).mockClear();
  // A resume after a reboot or an update reads the saved choice.
  const result = await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-flow",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(result.code).toBe(0);
  expect(vi.mocked(prepareLocalModels).mock.calls).toHaveLength(2);
  expect(prepareFoundationServices).toHaveBeenCalledWith(
    expect.anything(),
    "local-models",
    expect.objectContaining({ mainPlan: true }),
  );
  expect(applyNativeSource).not.toHaveBeenCalled();
});

async function saveModelSource(home: string, mode: string, runtime: string) {
  const state = path.join(home, "runtime", "localmodels", "state");
  await privateDirectory(state);
  await atomicPrivate(
    path.join(state, "model-source.json"),
    JSON.stringify({
      schema: "localmodels.model-source/v1",
      mode,
      runtime,
      runtime_model: "model",
      model_label: null,
      gateway_url: "http://127.0.0.1:18480",
      environment: {},
    }),
  );
}

async function restartAfter(
  setupChoice: "codex" | "local-models",
  source: { mode: string; runtime: string },
  restartRuntime?:
    | Awaited<ReturnType<typeof prepareRuntime>>
    | typeof prepareRuntime,
  restartOptions: Partial<Parameters<typeof installNativeSource>[0]> = {},
) {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ok",
  });
  await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-flow",
    setupChoice,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  await saveModelSource(f.home, source.mode, source.runtime);
  vi.mocked(applyNativeSource).mockClear();
  vi.mocked(prepareFoundationServices).mockClear();
  vi.mocked(prepareLocalModels).mockClear();
  vi.mocked(prepareRuntime).mockClear();
  vi.mocked(prepareModelGateway).mockClear();
  vi.mocked(restoreByokSource).mockClear();
  vi.mocked(restoreLocalModels).mockClear();
  if (typeof restartRuntime === "function")
    vi.mocked(prepareRuntime).mockImplementation(restartRuntime);
  else if (restartRuntime)
    vi.mocked(prepareRuntime).mockResolvedValue(restartRuntime);
  const result = await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-flow",
    signal: new AbortController().signal,
    onEvent: () => {},
    ...restartOptions,
  });
  return { f, result };
}

test.each(["codex", "local-models"] as const)(
  "a restart mounts a BYOK source switched to after choosing %s",
  async (setupChoice) => {
    // BYOK needs no runtime sign-in, so a pending one never holds a resume.
    const { f, result } = await restartAfter(
      setupChoice,
      { mode: "byok", runtime: "pi" },
      {
        code: 4,
        state: "action_required",
        message: "sign in later",
        details: { code: "RUNTIME_AUTH_REQUIRED" },
      },
    );
    expect(result.code).toBe(0);
    expect(vi.mocked(prepareRuntime).mock.calls[0]?.[0]).toBe("pi");
    expect(restoreByokSource).toHaveBeenCalledWith(
      path.resolve(f.home),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(applyNativeSource).not.toHaveBeenCalled();
    expect(prepareLocalModels).not.toHaveBeenCalled();
    expect(prepareFoundationServices).toHaveBeenCalledWith(
      expect.anything(),
      setupChoice,
      expect.objectContaining({ mainPlan: false }),
    );
    expect(prepareModelGateway).toHaveBeenCalledWith(
      expect.anything(),
      { runtime: "pi", modelSource: "byok" },
      expect.anything(),
    );
  },
);

test.each(["byok", "subscription"] as const)(
  "upgrading an instance whose model source was switched to %s leaves local models stopped",
  async (mode) => {
    const f = await fixture();
    vi.mocked(prepareRuntime).mockResolvedValue({
      code: 0,
      state: "ready",
      message: "ok",
    });
    await installNativeSource({
      home: f.home,
      repo: f.repo,
      name: "native-upgrade-switched",
      setupChoice: "local-models",
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    await saveModelSource(f.home, mode, "claude");
    vi.mocked(prepareFoundationServices).mockClear();
    vi.mocked(prepareModelGateway).mockClear();
    vi.mocked(prepareLocalModels).mockClear();
    vi.mocked(applyNativeSource).mockClear();
    vi.mocked(restoreByokSource).mockClear();
    // A version upgrade (--resume on a newer checkout) passes no setupChoice.
    const upgraded = await installNativeSource({
      home: f.home,
      repo: f.repo,
      name: "native-upgrade-switched",
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(upgraded.code).toBe(0);
    expect(prepareLocalModels).not.toHaveBeenCalled();
    expect(applyNativeSource).not.toHaveBeenCalled();
    expect(prepareFoundationServices).toHaveBeenCalledWith(
      expect.anything(),
      "local-models",
      expect.objectContaining({ mainPlan: false }),
    );
    if (mode === "byok") {
      expect(restoreByokSource).toHaveBeenCalledTimes(1);
      expect(prepareModelGateway).toHaveBeenCalledWith(
        expect.anything(),
        { runtime: "claude", modelSource: "byok" },
        expect.anything(),
      );
    } else {
      expect(restoreByokSource).not.toHaveBeenCalled();
      expect(prepareModelGateway).toHaveBeenCalledWith(
        expect.anything(),
        "claude",
        expect.anything(),
      );
    }
    vi.mocked(prepareFoundationServices).mockClear();
    // Explicitly choosing local models again via Set Up Again restores them.
    const explicit = await installNativeSource({
      home: f.home,
      repo: f.repo,
      name: "native-upgrade-switched",
      setupChoice: "local-models",
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(explicit.code).toBe(0);
    expect(prepareLocalModels).toHaveBeenCalledTimes(1);
    expect(prepareFoundationServices).toHaveBeenCalledWith(
      expect.anything(),
      "local-models",
      expect.objectContaining({ mainPlan: true }),
    );
    expect(applyNativeSource).toHaveBeenCalledWith(
      path.resolve(f.home),
      "local",
      "pi",
      { signal: expect.any(AbortSignal), onEvent: expect.any(Function) },
    );
  },
);

test("a restart reports a BYOK gateway that did not come back", async () => {
  const byokGateway = {
    code: "BYOK_UNREACHABLE",
    message: "Endpoint did not answer.",
  };
  vi.mocked(restoreByokSource).mockResolvedValue(byokGateway);
  const { result } = await restartAfter("codex", {
    mode: "byok",
    runtime: "pi",
  });
  expect(result).toMatchObject({ code: 0, details: { byokGateway } });
});

test("a cold resume of a saved BYOK source reuses the installed runtime and forwards its descriptor", async () => {
  const descriptor: RuntimeDescriptor = {
    runtime: "pi",
    executable: "/mock/pi",
    argvPrefix: [],
    installed: true,
    authenticated: true,
    authMode: "api_key",
    loginCommand: null,
  };
  const forwarded: RuntimeDescriptor[][] = [];
  const { f, result } = await restartAfter(
    "codex",
    { mode: "byok", runtime: "pi" },
    async (_runtime, options) => {
      options.onDescriptor?.(descriptor);
      return { code: 0, state: "ready", message: "ok" };
    },
    {
      resume: true,
      onRuntimeDescriptors: (descriptors) => forwarded.push(descriptors),
    },
  );
  expect(result.code).toBe(0);
  const options = vi.mocked(prepareRuntime).mock.calls[0]?.[1];
  expect(options?.reuseInstalled).toBe(true);
  expect(options?.env).toBeUndefined();
  expect(forwarded).toEqual([[descriptor]]);
  expect(restoreByokSource).toHaveBeenCalledWith(
    path.resolve(f.home),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

test("a restart of a saved BYOK source without resume prepares the runtime in full", async () => {
  const { result } = await restartAfter("codex", {
    mode: "byok",
    runtime: "pi",
  });
  expect(result.code).toBe(0);
  const options = vi.mocked(prepareRuntime).mock.calls[0]?.[1];
  expect(options?.env).toBeDefined();
  expect(options).not.toHaveProperty("reuseInstalled");
});

test("choosing a subscription again replaces a saved BYOK source", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ok",
  });
  await saveModelSource(f.home, "byok", "pi");
  await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-flow",
    setupChoice: "codex",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(applyNativeSource).toHaveBeenCalledWith(
    path.resolve(f.home),
    "subscription",
    "codex",
    { signal: expect.any(AbortSignal), onEvent: expect.any(Function) },
  );
  expect(restoreByokSource).not.toHaveBeenCalled();
});

test("a restart keeps a saved subscription source without re-applying it or unloading local models", async () => {
  const { result } = await restartAfter("codex", {
    mode: "subscription",
    runtime: "codex",
  });
  expect(result.code).toBe(0);
  expect(applyNativeSource).not.toHaveBeenCalled();
  expect(restoreByokSource).not.toHaveBeenCalled();
  expect(restoreLocalModels).not.toHaveBeenCalled();
  expect(prepareModelGateway).toHaveBeenCalledWith(
    expect.anything(),
    "codex",
    expect.anything(),
  );
});

test("a subscription restart or update restores previously loaded library models and reports them", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ok",
  });
  await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-flow",
    setupChoice: "claude",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  await saveModelSource(f.home, "subscription", "claude");
  await writeResumeLocalModels(f.home, ["spark-x2.6-4b:Q4_K_M"]);
  vi.mocked(applyNativeSource).mockClear();
  vi.mocked(restoreLocalModels).mockClear();
  vi.mocked(restoreLocalModels).mockImplementationOnce(async (_inst, opts) => {
    opts.onRestored?.(["spark-x2.6-4b:Q4_K_M"]);
    return undefined;
  });

  const result = await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-flow",
    externalComputer: true,
    degradeLocalModels: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(result).toMatchObject({
    code: 0,
    state: "ready",
    details: {
      localModelsRestored: true,
      restoredLocalModels: ["spark-x2.6-4b:Q4_K_M"],
    },
  });
  expect(applyNativeSource).not.toHaveBeenCalled();
  expect(restoreLocalModels).toHaveBeenCalledTimes(1);
});

test("a BYOK restart mounts BYOK before restoring previously loaded library models", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ok",
  });
  await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-flow",
    setupChoice: "codex",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  await saveModelSource(f.home, "byok", "pi");
  await writeResumeLocalModels(f.home, ["spark-x2.6-4b:Q4_K_M"]);
  const order: string[] = [];
  vi.mocked(restoreByokSource).mockImplementationOnce(async () => {
    order.push("byok");
    return undefined;
  });
  vi.mocked(restoreLocalModels).mockImplementationOnce(async (_inst, opts) => {
    order.push("local");
    opts.onRestored?.(["spark-x2.6-4b:Q4_K_M"]);
    return undefined;
  });
  vi.mocked(applyNativeSource).mockClear();

  const result = await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-flow",
    resume: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(result).toMatchObject({
    code: 0,
    details: {
      localModelsRestored: true,
      restoredLocalModels: ["spark-x2.6-4b:Q4_K_M"],
    },
  });
  expect(order).toEqual(["byok", "local"]);
  expect(applyNativeSource).not.toHaveBeenCalled();
});

test("an explicit setup choice clears any stale post-stop local model resume record", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ok",
  });
  await writeResumeLocalModels(f.home, ["spark-x2.6-4b:Q4_K_M"]);
  await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-flow",
    setupChoice: "codex",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(await readResumeLocalModels(f.home)).toBeUndefined();
});

test("a cold resume in local-models mode restores models from resume-models.json even when model-source.json is absent", async () => {
  const f = await fixture();
  await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-flow",
    setupChoice: "local-models",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  await writeResumeLocalModels(f.home, ["spark-x2.6-4b:Q4_K_M"]);
  vi.mocked(applyNativeSource).mockClear();
  vi.mocked(prepareLocalModels).mockClear();
  vi.mocked(restoreLocalModels).mockClear();
  vi.mocked(restoreLocalModels).mockImplementationOnce(async (_inst, opts) => {
    opts.onRestored?.(["spark-x2.6-4b:Q4_K_M"]);
    return undefined;
  });

  const result = await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-flow",
    resume: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(result).toMatchObject({
    code: 0,
    details: {
      localModelsRestored: true,
      restoredLocalModels: ["spark-x2.6-4b:Q4_K_M"],
    },
  });
  expect(prepareLocalModels).toHaveBeenCalledTimes(1);
  expect(restoreLocalModels).toHaveBeenCalledTimes(1);
  expect(applyNativeSource).not.toHaveBeenCalled();
});

test("a legacy subscription restart without model-source.json preserves source apply when idle and avoids unloading when local models are pending", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ok",
  });
  await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-flow",
    setupChoice: "codex",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  // No model-source.json on disk and no pending local models: creates
  // model-source.json via source apply --mode subscription.
  vi.mocked(applyNativeSource).mockClear();
  vi.mocked(restoreLocalModels).mockClear();
  const migrated = await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-flow",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(migrated.code).toBe(0);
  expect(applyNativeSource).toHaveBeenCalledWith(
    path.resolve(f.home),
    "subscription",
    "codex",
    { signal: expect.any(AbortSignal), onEvent: expect.any(Function) },
  );
  expect(restoreLocalModels).not.toHaveBeenCalled();

  // With pending local models and still no model-source.json: skips
  // subscription source apply so active local models are not unloaded.
  await writeResumeLocalModels(f.home, ["spark-x2.6-4b:Q4_K_M"]);
  vi.mocked(applyNativeSource).mockClear();
  vi.mocked(restoreLocalModels).mockClear();
  const preserved = await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-flow",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(preserved.code).toBe(0);
  expect(applyNativeSource).not.toHaveBeenCalled();
  expect(restoreLocalModels).toHaveBeenCalledTimes(1);
});

test("a restart keeps a saved local source as before", async () => {
  const { result } = await restartAfter("local-models", {
    mode: "local",
    runtime: "pi",
  });
  expect(result.code).toBe(0);
  expect(prepareLocalModels).toHaveBeenCalled();
  expect(prepareFoundationServices).toHaveBeenCalledWith(
    expect.anything(),
    "local-models",
    expect.objectContaining({ mainPlan: true }),
  );
  expect(prepareModelGateway).toHaveBeenCalledWith(
    expect.anything(),
    "local-models",
    expect.anything(),
  );
  expect(applyNativeSource).not.toHaveBeenCalled();
  expect(restoreByokSource).not.toHaveBeenCalled();
  expect(restoreLocalModels).not.toHaveBeenCalled();
});

test("a fresh BYOK install omits --main-plan and prepares the BYOK gateway", async () => {
  const f = await fixture();
  vi.mocked(prepareByokRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ok",
  });
  const result = await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-flow",
    byok: {
      baseUrl: "https://api.example.com",
      path: "/v1",
      endpoint: "/chat/completions",
      protocol: "openai-chat",
      modelId: "vendor/model",
      apiKey: "sk-test-key",
    },
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(result.code).toBe(0);
  expect(prepareFoundationServices).toHaveBeenCalledWith(
    expect.anything(),
    "claude",
    expect.objectContaining({ mainPlan: false }),
  );
  expect(prepareModelGateway).toHaveBeenCalledWith(
    expect.anything(),
    { runtime: "claude", modelSource: "byok" },
    expect.anything(),
  );
});
test("a cold resume restores an adopted stack local model when setup-choice is local-models and setup binding is ready", async () => {
  const f = await fixture();
  await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-flow",
    setupChoice: "local-models",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  const planId = "a".repeat(64);
  const localmodelsRoot = path.join(f.home, "runtime", "localmodels");
  const state = path.join(localmodelsRoot, "state");
  await privateDirectory(state);
  await atomicPrivate(
    path.join(localmodelsRoot, "plan.json"),
    JSON.stringify({ schema: "localmodels.stack-plan/v1", plan_id: planId }),
  );
  await atomicPrivate(
    path.join(state, "model-source.json"),
    JSON.stringify({
      schema: "localmodels.model-source/v1",
      mode: "local",
      runtime: "pi",
      runtime_model: "localmodels/localmodels-agent",
      model_label: "Qwen3.8 27B",
      gateway_url: "http://127.0.0.1:18480",
      environment: {},
    }),
  );
  vi.mocked(applyNativeSource).mockClear();
  vi.mocked(prepareLocalModels).mockClear();
  vi.mocked(restoreLocalModels).mockClear();
  const actualLocalModels =
    await vi.importActual<typeof import("./local-models.js")>(
      "./local-models.js",
    );
  const localmodelsCalls: string[][] = [];
  const fakeLocalmodels = vi.fn(async (_home: string, args: string[]) => {
    localmodelsCalls.push(args);
    if (args[0] === "setup" && args[1] === "binding") {
      return {
        code: 0,
        stdout: JSON.stringify({
          schema: "localmodels.stack-binding/v1",
          planId,
          ready: true,
          pi: {
            executable: "/mock/pi",
            configFingerprint: "b".repeat(64),
            environment: { PI_CODING_AGENT_DIR: "/mock/pi-agent" },
          },
        }),
        stderr: "",
      };
    }
    if (args[0] === "library" && args[1] === "status") {
      return {
        code: 0,
        stdout: JSON.stringify({
          schema: "localmodels.library-status/v1",
          models: [
            {
              id: "qwen3.8-27b:UD-Q4_K_M",
              state: "idle",
              pi_model: "localmodels/localmodels-agent",
            },
          ],
        }),
        stderr: "",
      };
    }
    if (args[0] === "library" && args[1] === "load") {
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "{}", stderr: "" };
  });
  vi.mocked(restoreLocalModels).mockImplementationOnce((instance, options) =>
    actualLocalModels.restoreLocalModels(instance, options, {
      localmodels: fakeLocalmodels,
    }),
  );

  const result = await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-flow",
    resume: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(result.code).toBe(0);
  expect(
    (result.details as { localModelsDegraded?: unknown }).localModelsDegraded,
  ).toBeUndefined();
  expect(prepareLocalModels).toHaveBeenCalledTimes(1);
  expect(restoreLocalModels).toHaveBeenCalledTimes(1);
  expect(localmodelsCalls.map((args) => `${args[0]} ${args[1]}`)).toEqual([
    "setup binding",
    "library status",
    "library load",
  ]);
  expect(localmodelsCalls[2]?.slice(0, 3)).toEqual([
    "library",
    "load",
    "qwen3.8-27b:UD-Q4_K_M",
  ]);
  expect(applyNativeSource).toHaveBeenCalledWith(
    path.resolve(f.home),
    "local",
    "pi",
    expect.objectContaining({
      model: "qwen3.8-27b:UD-Q4_K_M",
      signal: expect.any(AbortSignal),
      onEvent: expect.any(Function),
    }),
    expect.objectContaining({ localmodels: fakeLocalmodels }),
  );
  expect(restoreByokSource).not.toHaveBeenCalled();
});
test("a cold resume with setup-choice local-models does not treat a stale BYOK sentinel runtime_model as a local library model", async () => {
  const f = await fixture();
  await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-flow",
    setupChoice: "local-models",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  const state = path.join(f.home, "runtime", "localmodels", "state");
  await privateDirectory(state);
  await atomicPrivate(
    path.join(state, "model-source.json"),
    JSON.stringify({
      schema: "localmodels.model-source/v1",
      mode: "local",
      runtime: "pi",
      runtime_model: "localmodels/localmodels-byok",
      model_label: null,
      gateway_url: "http://127.0.0.1:18480",
      environment: {},
    }),
  );
  vi.mocked(applyNativeSource).mockClear();
  vi.mocked(prepareLocalModels).mockClear();
  vi.mocked(restoreLocalModels).mockClear();

  const result = await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-flow",
    resume: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(result.code).toBe(0);
  expect(
    (result.details as { localModelsDegraded?: unknown }).localModelsDegraded,
  ).toBeUndefined();
  expect(prepareLocalModels).toHaveBeenCalledTimes(1);
  expect(restoreLocalModels).not.toHaveBeenCalled();
  expect(applyNativeSource).not.toHaveBeenCalled();
});
test("a cold resume preserves a saved local model source even when setup-choice is a subscription runtime", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ok",
  });
  await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-flow",
    setupChoice: "codex",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  const state = path.join(f.home, "runtime", "localmodels", "state");
  await privateDirectory(state);
  await atomicPrivate(
    path.join(state, "model-source.json"),
    JSON.stringify({
      schema: "localmodels.model-source/v1",
      mode: "local",
      runtime: "pi",
      runtime_model:
        "localmodels-library/localmodels-lib-qwen3-8-27b/Qwen3.8-27B-UD-Q4_K_M",
      model_label: "Qwen3.8 27B",
      gateway_url: "http://127.0.0.1:18480",
      environment: {},
    }),
  );
  vi.mocked(applyNativeSource).mockClear();
  vi.mocked(prepareLocalModels).mockClear();
  vi.mocked(prepareRuntime).mockClear();
  vi.mocked(restoreLocalModels).mockClear();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 4,
    state: "action_required",
    message: "sign in later",
    details: { code: "RUNTIME_AUTH_REQUIRED" },
  });

  const result = await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-flow",
    resume: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(result.code).toBe(0);
  expect(vi.mocked(prepareRuntime).mock.calls[0]?.[0]).toBe("pi");
  expect(vi.mocked(prepareRuntime).mock.calls[0]?.[1]?.reuseInstalled).toBe(
    true,
  );
  expect(restoreLocalModels).toHaveBeenCalled();
  expect(applyNativeSource).not.toHaveBeenCalled();
  expect(restoreByokSource).not.toHaveBeenCalled();
});

test("a cold resume degrades a saved local library model failure into localModelsDegraded without blocking startup", async () => {
  vi.mocked(restoreLocalModels).mockResolvedValueOnce({
    code: 1,
    state: "failed",
    message: "Could not reload local model qwen3.8-27b:UD-Q4_K_M: Out of VRAM.",
    details: { code: "LOAD_NO_ROOM" },
  });
  const { result } = await restartAfter(
    "codex",
    {
      mode: "local",
      runtime: "pi",
    },
    undefined,
    { resume: true },
  );
  expect(result).toMatchObject({
    code: 0,
    state: "ready",
    details: {
      localModelsDegraded: {
        code: "LOAD_NO_ROOM",
        message:
          "Could not reload local model qwen3.8-27b:UD-Q4_K_M: Out of VRAM.",
      },
    },
  });
  expect(applyNativeSource).not.toHaveBeenCalled();
});
test("only TeamHub's process gets the server identity key", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  // Not even a key the installer itself was started with reaches the others.
  vi.stubEnv("TEAMHUB_LOCAL_IDENTITY_KEY", "inherited");
  const events: string[] = [];
  try {
    await installNativeSource({
      home: f.home,
      repo: f.repo,
      name: "native-identity",
      setupChoice: "pi",
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event.message),
    });
  } finally {
    vi.unstubAllEnvs();
  }
  const root = path.join(f.home, "instances", "native-identity");
  const key = (
    await readFile(path.join(root, "local-identity.key"), "utf8")
  ).trim();
  const services = vi
    .mocked(startNativeProcess)
    .mock.calls.map(([options]) => options);
  expect(
    services.find((options) => options.name === "teamhub")!.env
      .TEAMHUB_LOCAL_IDENTITY_KEY,
  ).toBe(key);
  const others = services.filter((options) => options.name !== "teamhub");
  expect(others.map((options) => options.name)).toEqual(
    expect.arrayContaining(["node-services", "web"]),
  );
  for (const options of others)
    expect(options.env).not.toHaveProperty("TEAMHUB_LOCAL_IDENTITY_KEY");
  // Each of them is restarted by its supervisor when it exits unasked.
  for (const options of services)
    expect(options.restartOnExit).toEqual(SERVICE_RESTART_POLICY);
  const commands = vi.mocked(runProcess).mock.calls;
  expect(commands.some((row) => row[1].includes("migrate"))).toBe(true);
  for (const [, , options] of commands)
    expect(options?.env ?? {}).not.toHaveProperty("TEAMHUB_LOCAL_IDENTITY_KEY");
  // Compose and the services load native.env; the installer's own secrets
  // file no longer holds the key either.
  for (const file of ["native.env", "services.env"])
    expect(await readFile(path.join(root, file), "utf8")).not.toContain(
      "TEAMHUB_LOCAL_IDENTITY_KEY",
    );
  expect(events.join("\n")).not.toContain(key);
});
test("a database from before Linger is reported and the installation goes on", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const backup = path.join(f.home, "instances/native-legacy/simplex-backup-x");
  vi.mocked(prepareNativeDatabase).mockImplementation(async () => {
    f.running.add("postgres");
    return { legacyBackup: backup };
  });
  const events: InstallerEvent[] = [];
  const result = await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-legacy",
    setupChoice: "pi",
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  expect(result.code).toBe(0);
  const notice = events.findIndex(
    (event) => event.kind === "log" && event.message.includes(backup),
  );
  expect(events[notice]).toMatchObject({
    stage: "services",
    message: expect.stringContaining("earlier Simplex app"),
  });
  const migrate = vi
    .mocked(runProcess)
    .mock.calls.findIndex((row) => row[1].includes("migrate"));
  expect(
    vi.mocked(runProcess).mock.invocationCallOrder[migrate],
  ).toBeGreaterThan(
    vi.mocked(prepareNativeDatabase).mock.invocationCallOrder[0]!,
  );
});
test("a new identity key restarts TeamHub alone", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const install = async () => {
    vi.mocked(startNativeProcess).mockClear();
    await installNativeSource({
      home: f.home,
      repo: f.repo,
      name: "native-rekey",
      setupChoice: "pi",
      externalComputer: true,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    return Object.fromEntries(
      vi
        .mocked(startNativeProcess)
        .mock.calls.map(([options]) => [options.name, options.settings]),
    );
  };
  const before = await install();
  const file = path.join(
    f.home,
    "instances",
    "native-rekey",
    "local-identity.key",
  );
  const key = Buffer.alloc(32, 5).toString("base64");
  await writeFile(file, `${key}\n`, { mode: 0o600 });
  const after = await install();
  expect(after.teamhub).not.toBe(before.teamhub);
  expect(after.teamhub).not.toContain(key);
  expect(after["node-services"]).toBe(before["node-services"]);
  expect(after.web).toBe(before.web);
});
test("an external Computer skips the Go Computer release and enrollment", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const stages: string[] = [];
  const result = await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-desktop",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: (event) => {
      if (event.kind === "stage" && event.state !== "running")
        stages.push(`${event.stage}:${event.state}`);
    },
  });
  expect(result).toMatchObject({ code: 0, state: "ready" });
  expect(stages).toContain("computer:skipped");
  expect(stages).toContain("runtime:succeeded");
  const operations = vi.mocked(runProcess).mock.calls.map((row) => row[1]);
  expect(operations.some((args) => args.includes("prepare"))).toBe(true);
  expect(operations.some((args) => args.includes("computer-release"))).toBe(
    false,
  );
  expect(prepareSourceComputer).not.toHaveBeenCalled();
  expect(connectComputer).not.toHaveBeenCalled();
  expect(f.running).toEqual(
    new Set(["postgres", "teamhub", "node-services", "web"]),
  );
});
test("a failed dependency install retries from the next registry and reports package progress", async () => {
  const f = await fixture();
  vi.mocked(prepareNativeDependencies).mockResolvedValue({
    env: {},
    postgresBin: "/private/postgres/bin",
    toolchainRoot: "/private/tools",
    registries: [
      "https://registry.npmjs.org/",
      "https://registry.npmmirror.com/",
    ],
  });
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const installs: string[] = [];
  vi.mocked(runProcess).mockImplementation(async (_command, args, options) => {
    const operation = args[1]!;
    if (operation.startsWith("prepare")) {
      const registry = options?.env?.pnpm_config_registry ?? "";
      installs.push(`${operation} ${new URL(registry).host}`);
      options?.onOutput?.(
        "Progress: resolved 1, reused 0, downloaded 0, added 0\nProgress: resolved 90, reused 0, downloaded 40, added 30\nERR_PNPM_FETCH timed out\n",
      );
      return {
        code: installs.length === 1 ? 1 : 0,
        stdout: "",
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const events: InstallerEvent[] = [];
  await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "pi",
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  expect(installs).toEqual([
    "prepare registry.npmjs.org",
    "prepare registry.npmmirror.com",
    "prepare-computer registry.npmmirror.com",
  ]);
  const operations = vi.mocked(runProcess).mock.calls.map((row) => row[1][1]);
  expect(operations.indexOf("prepare-computer")).toBeLessThan(
    operations.indexOf("computer-release"),
  );
  const messages = events.map((event) => event.message);
  expect(messages).toContain(
    "Dependency installation from registry.npmjs.org failed; retrying with registry.npmmirror.com.\n",
  );
  expect(messages).toContain("ERR_PNPM_FETCH timed out\n");
  expect(messages.some((message) => message.startsWith("Progress:"))).toBe(
    false,
  );
  expect(events).toContainEqual({
    kind: "log",
    stage: "images",
    message: "Installing dependencies: 30 of 90 packages\n",
    progress: { completed: 30, total: 90, unit: "packages" },
  });
  // The China mirror worked where the global registry failed: later runs
  // start there.
  expect(JSON.parse(await readFile(regionFile(f.home), "utf8"))).toMatchObject({
    region: "cn",
    method: "fallback",
  });
});
test("every native service gets the resolved download region", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "pi",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  const services = vi
    .mocked(startNativeProcess)
    .mock.calls.map(([options]) => [options.name, options.env.SIMPLEX_REGION]);
  expect(services).toEqual([
    ["teamhub", "global"],
    ["node-services", "global"],
    ["web", "global"],
  ]);
});
test("failed preparation never stops services that were already running", async () => {
  const f = await fixture();
  f.running.add("postgres");
  f.running.add("teamhub");
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  vi.mocked(runProcess).mockImplementation(async (_executable, args) => ({
    code: args.includes("migrate") ? 3 : 0,
    stdout: "",
    stderr: "",
  }));
  const result = await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "pi",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(result.code).toBe(1);
  expect(stopNativeProcess).not.toHaveBeenCalled();
  expect(f.running.has("postgres")).toBe(true);
});

async function runFlow(f: Awaited<ReturnType<typeof fixture>>) {
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  return installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "pi",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
}

test("a move to a new checkout that fails before the restart leaves the services on the old one", async () => {
  const f = await fixture();
  const install = (repo: string) =>
    installNativeSource({
      home: f.home,
      repo,
      name: "desktop",
      setupChoice: "pi",
      externalComputer: true,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  expect((await install(f.repo)).code).toBe(0);
  const old = await realpath(f.repo);
  const next = path.join(f.home, "next");
  await cp(f.repo, next, { recursive: true });
  // The Runtime (the local model, for one) is not ready on the new checkout.
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 4,
    state: "action_required",
    message: "The upstream stack is not ready.",
    details: { code: "LOCAL_MODELS_RECOVERY_REQUIRED" },
  });
  vi.mocked(runProcess).mockClear();
  vi.mocked(startNativeProcess).mockClear();
  expect(await install(next)).toMatchObject({ code: 4 });
  const stored = await loadInstance({ home: f.home, name: "desktop" });
  expect(stored?.source?.repo).toBe(old);
  expect(startNativeProcess).not.toHaveBeenCalled();
  expect(
    vi
      .mocked(runProcess)
      .mock.calls.some(([, args]) => args.includes("migrate")),
  ).toBe(false);
  // Trying again once the Runtime is ready restarts them on the new one.
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  expect((await install(next)).code).toBe(0);
  const moved = await realpath(next);
  expect(
    (await loadInstance({ home: f.home, name: "desktop" }))?.source?.repo,
  ).toBe(moved);
  expect(
    vi
      .mocked(startNativeProcess)
      .mock.calls.filter(([options]) => options.name !== "livekit")
      .map(([options]) => options.cwd),
  ).toEqual([moved, moved, moved]);
});

test("an unchanged TeamHub leaves a running node-services alone", async () => {
  const f = await fixture();
  for (const name of ["teamhub", "node-services", "web"]) f.running.add(name);
  await runFlow(f);
  expect(vi.mocked(stopNativeProcess)).not.toHaveBeenCalledWith(
    expect.anything(),
    "node-services",
  );
});

test("a stopped TeamHub never stops node-services up front", async () => {
  const f = await fixture();
  f.running.add("node-services");
  await runFlow(f);
  expect(vi.mocked(stopNativeProcess)).not.toHaveBeenCalledWith(
    expect.anything(),
    "node-services",
  );
});

test("a running node-services stops before TeamHub restarts and services start concurrently without pre-stopping web", async () => {
  const f = await fixture();
  for (const name of ["teamhub", "node-services", "web"]) f.running.add(name);
  vi.mocked(nativeConfigurationChanged).mockImplementation(
    async (options) => options.name === "teamhub",
  );
  let nodeServicesStopped = false;
  const baseStop = vi.mocked(stopNativeProcess).getMockImplementation()!;
  vi.mocked(stopNativeProcess).mockImplementation(async (root, name) => {
    const result = await baseStop(root, name);
    if (name === "node-services") nodeServicesStopped = true;
    return result;
  });
  const baseStart = vi.mocked(startNativeProcess).getMockImplementation()!;
  const entered = new Set<string>();
  let releaseAll!: () => void;
  const allEntered = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });
  vi.mocked(startNativeProcess).mockImplementation(async (options) => {
    if (
      options.name === "teamhub" ||
      options.name === "node-services" ||
      options.name === "web"
    ) {
      expect(nodeServicesStopped).toBe(true);
      entered.add(options.name);
      if (entered.size === 3) releaseAll();
      await allEntered;
    }
    return baseStart(options);
  });
  await runFlow(f);
  expect(
    vi.mocked(stopNativeProcess).mock.calls.map((call) => call[1]),
  ).toEqual(["node-services"]);
  expect(entered).toEqual(new Set(["teamhub", "node-services", "web"]));
  const teamHubStart = vi
    .mocked(startNativeProcess)
    .mock.calls.findIndex(([options]) => options.name === "teamhub");
  expect(vi.mocked(stopNativeProcess).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(startNativeProcess).mock.invocationCallOrder[teamHubStart]!,
  );
  expect(f.running.has("node-services")).toBe(true);
  expect(f.running.has("web")).toBe(true);
});

test("a failure after pre-stopping keeps pre-existing teamhub, node-services, and web running without rollback stopping them", async () => {
  const f = await fixture();
  for (const name of ["postgres", "teamhub", "node-services", "web"])
    f.running.add(name);
  vi.mocked(nativeConfigurationChanged).mockImplementation(
    async (options) => options.name === "teamhub",
  );
  vi.mocked(startNativeProcess).mockImplementation(async (options) => {
    if (options.name === "teamhub") throw new Error("teamhub failed");
    f.running.add(options.name);
    return { running: true, pid: 100 };
  });
  const result = await runFlow(f);
  expect(result.code).toBe(1);
  // Only the node-services pre-stop ran; rollback must not stop pre-existing web, node-services, or teamhub.
  expect(
    vi.mocked(stopNativeProcess).mock.calls.map((call) => call[1]),
  ).toEqual(["node-services"]);
  expect(vi.mocked(stopNativeProcess)).toHaveBeenCalledTimes(1);
  expect(f.running.has("node-services")).toBe(true);
  expect(f.running.has("web")).toBe(true);
});

test("a failure after the restart settles concurrent starts and keeps the node-services and TeamHub that ran before", async () => {
  const f = await fixture();
  for (const name of ["postgres", "teamhub", "node-services"])
    f.running.add(name);
  vi.mocked(nativeConfigurationChanged).mockImplementation(
    async (options) => options.name === "teamhub",
  );
  const entered = new Set<string>();
  const settled = new Set<string>();
  let releaseAll!: () => void;
  const allEntered = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });
  vi.mocked(startNativeProcess).mockImplementation(async (options) => {
    if (
      options.name === "teamhub" ||
      options.name === "node-services" ||
      options.name === "web"
    ) {
      entered.add(options.name);
      if (entered.size === 3) releaseAll();
      await allEntered;
    }
    if (options.name === "web") throw new Error("web failed");
    f.running.add(options.name);
    settled.add(options.name);
    return { running: true, pid: 100 };
  });
  const result = await runFlow(f);
  expect(result.code).toBe(1);
  expect(entered).toEqual(new Set(["teamhub", "node-services", "web"]));
  expect(settled).toEqual(new Set(["teamhub", "node-services"]));
  // The pre-stop hands in-flight Runs back; the rollback stops only what this
  // run started, never the node-services or TeamHub that were already running.
  expect(
    vi.mocked(stopNativeProcess).mock.calls.map((call) => call[1]),
  ).toEqual(["node-services", "web"]);
  expect(f.running.has("teamhub")).toBe(true);
  expect(f.running.has("node-services")).toBe(true);
});

test("waitHealthy reports stopped services in watchedServices priority order from the periodic listener snapshot", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  let started = 0;
  vi.mocked(startNativeProcess).mockImplementation(async (options) => {
    f.running.add(options.name);
    if (++started === 3) {
      vi.mocked(inspectNativeProcess).mockClear();
      vi.mocked(inspectNativeListeners).mockClear();
    }
    return { running: true, pid: 100 };
  });
  let healthCalls = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.mocked(inspectNativeListeners).mockImplementation(
      async (_root, listeners) =>
        listeners.map(({ name }) => ({
          running: name === "node-services",
        })),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const text = String(url);
        if (text.endsWith("/healthz") || text.endsWith("/readyz")) {
          healthCalls += 1;
          if (healthCalls === 5) vi.setSystemTime(Date.now() + 5_000);
        }
        return new Response("{}", { status: 503 });
      }),
    );
    const result = await installNativeSource({
      ...f,
      name: "native-flow-wait-order",
      setupChoice: "pi",
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(result.code).toBe(1);
    expect(inspectNativeListeners).toHaveBeenCalledTimes(1);
    expect(inspectNativeProcess).not.toHaveBeenCalled();
    // Both teamhub and web reported stopped; teamhub comes first in watchedServices.
    expect(result.message).toContain("Native teamhub stopped during startup.");
  } finally {
    vi.useRealTimers();
  }
});

test("stops native business services even if owned gateway shutdown reports a failure", async () => {
  const f = await fixture();
  const { prepareNativeConfiguration } = await import("./native-source.js");
  const { instance } = await prepareNativeConfiguration(f.repo, {
    home: f.home,
    name: "stop-native",
  });
  vi.mocked(stopModelGateway).mockRejectedValueOnce(
    new Error("Gateway unavailable"),
  );
  await expect(
    stopNativeSource(instance, new AbortController().signal),
  ).rejects.toThrow("Gateway unavailable");
  expect(
    vi.mocked(stopNativeProcess).mock.calls.map((call) => call[1]),
  ).toEqual(["web", "node-services", "teamhub", "livekit", "postgres"]);
});

test("a full disk ends startup at once instead of at the deadline", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const logs = path.join(f.home, "instances", "native-flow", "native/logs");
  await mkdir(logs, { recursive: true, mode: 0o700 });
  // An earlier run that failed is not this one.
  await writeFile(path.join(logs, "teamhub.log"), "failed to build\n", {
    mode: 0o600,
  });
  vi.mocked(startNativeProcess).mockImplementation(async (options) => {
    f.running.add(options.name);
    if (options.name === "teamhub")
      await writeFile(
        path.join(logs, "teamhub.log"),
        "compile: writing output: no space left on device\n",
        { mode: 0o600, flag: "a" },
      );
    return { running: true, pid: 100 };
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 503 })),
  );
  const result = await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "pi",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(result).toMatchObject({ code: 1 });
  expect(result.message).toContain(
    "This computer's disk is full, so native teamhub could not be built.",
  );
});

test("a service that stops because another program took its port names the port", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  // Another program takes TeamHub's port after Linger chose it, so TeamHub
  // exits at once.
  const holder = net.createServer();
  let port: number | undefined;
  vi.mocked(startNativeProcess).mockImplementation(async (options) => {
    if (options.name !== "teamhub") {
      f.running.add(options.name);
      return { running: true, pid: 100 };
    }
    const instance = JSON.parse(
      await readFile(
        path.join(f.home, "instances", "native-flow", "instance.json"),
        "utf8",
      ),
    ) as { source: { ports: { teamhub: number } } };
    port = instance.source.ports.teamhub;
    await new Promise<void>((resolve) =>
      holder.listen(port, "127.0.0.1", resolve),
    );
    return { running: false };
  });
  try {
    const result = await installNativeSource({
      ...f,
      name: "native-flow",
      setupChoice: "pi",
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(result).toMatchObject({ code: 1 });
    expect(result.message).toContain(
      `Native teamhub cannot listen on port ${port}: another program is using it.`,
    );
  } finally {
    await new Promise((resolve) => holder.close(resolve));
  }
});

test("a port an earlier TeamHub still holds fails startup instead of passing its health check", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    // The earlier TeamHub answers /healthz on the port; each probe is ten
    // seconds later.
    vi.mocked(inspectNativeListeners).mockImplementation(
      async (_root, listeners) => {
        vi.setSystemTime(Date.now() + 10_000);
        return listeners.map(({ name }) =>
          name === "teamhub"
            ? { running: true, foreign: 4328 }
            : { running: true },
        );
      },
    );
    const result = await installNativeSource({
      ...f,
      name: "native-flow",
      setupChoice: "pi",
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(result).toMatchObject({ code: 1 });
    expect(result.message).toMatch(
      /Native teamhub cannot listen on port \d+: another program \(PID 4328\) is using it/,
    );
  } finally {
    vi.useRealTimers();
  }
});

// What scripts/source-native.mjs logs when go build fails, as on Windows
// before TeamHub had a Windows disk-capacity probe.
const failedBuild = [
  "building...",
  "go: downloading github.com/gin-gonic/gin v1.10.1",
  "# github.com/simplexai-labs/linger/apps/teamhub/internal/artifact",
  "internal\\artifact\\storage.go:276:17: undefined: unix.Statfs_t",
  "internal\\artifact\\storage.go:277:17: undefined: unix.Statfs",
  "failed to build, error: exit status 1",
  "",
].join("\n");

test("a compile excerpt keeps the compiler's lines from the last build", () => {
  const earlier =
    "[06:50:00] building...\nold.go:1:1: gone\n[06:50:01] failed to build, error: exit status 1\n";
  expect(compileFailureExcerpt(earlier + failedBuild)).toBe(
    [
      "go: downloading github.com/gin-gonic/gin v1.10.1",
      "# github.com/simplexai-labs/linger/apps/teamhub/internal/artifact",
      "internal\\artifact\\storage.go:276:17: undefined: unix.Statfs_t",
      "internal\\artifact\\storage.go:277:17: undefined: unix.Statfs",
      "failed to build, error: exit status 1",
    ].join("\n"),
  );
  expect(compileFailureExcerpt("[06:58:58] building...\n")).toBe("");
});

test("a compile excerpt is bounded and redacted", () => {
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`);
  const text = [
    "building...",
    ...lines,
    `DATABASE_PASSWORD=hunter2 ${"x".repeat(400)}`,
    "\u001b[31mfailed to build, error: exit status 1\u001b[0m",
  ].join("\n");
  const excerpt = compileFailureExcerpt(text, 3);
  expect(excerpt.split("\n")).toHaveLength(3);
  expect(excerpt).toContain("line 39");
  expect(excerpt).not.toContain("hunter2");
  expect(excerpt).not.toContain("\u001b");
  expect(excerpt.split("\n")[1]!.length).toBeLessThanOrEqual(240);
});

test("a failed compile shows the compiler's lines on the setup page", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const logs = path.join(f.home, "instances", "native-flow", "native/logs");
  await mkdir(logs, { recursive: true, mode: 0o700 });
  // TeamHub exits after the failed build; the others keep running.
  vi.mocked(startNativeProcess).mockImplementation(async (options) => {
    if (options.name !== "teamhub") f.running.add(options.name);
    else
      await writeFile(path.join(logs, "teamhub.log"), failedBuild, {
        mode: 0o600,
        flag: "a",
      });
    return { running: true, pid: 100 };
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 503 })),
  );
  const result = await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "pi",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(result).toMatchObject({ code: 1 });
  expect(result.message).toContain(
    "# github.com/simplexai-labs/linger/apps/teamhub/internal/artifact\ninternal\\artifact\\storage.go:276:17: undefined: unix.Statfs_t",
  );
  expect(result.message).toContain(
    `Inspect ${path.join(logs, "teamhub.log")}.`,
  );
  expect(result.message).toMatch(/^Native teamhub failed to compile\.\n/);
  expect(inspectNativeListeners).not.toHaveBeenCalled();
});

test("readiness polling checks HTTP first and confirms listener ownership once without direct process inspections", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  let started = 0;
  vi.mocked(startNativeProcess).mockImplementation(async (options) => {
    f.running.add(options.name);
    if (++started === 3) {
      vi.mocked(inspectNativeProcess).mockClear();
      vi.mocked(inspectNativeListeners).mockClear();
    }
    return { running: true, pid: 100 };
  });
  const snapshotRounds: number[] = [];
  let healthCalls = 0;
  const baseFetch = globalThis.fetch;
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.mocked(inspectNativeListeners).mockImplementation(
      async (_root, listeners) => {
        snapshotRounds.push(Math.ceil(healthCalls / 4));
        return listeners.map(({ name }) => ({ running: f.running.has(name) }));
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init?: RequestInit) => {
        const text = String(url);
        if (!text.endsWith("/healthz") && !text.endsWith("/readyz"))
          return baseFetch(url, init);
        healthCalls += 1;
        const round = Math.ceil(healthCalls / 4);
        if (healthCalls > 1 && healthCalls % 4 === 1)
          vi.setSystemTime(Date.now() + 500);
        return new Response("{}", { status: round < 4 ? 503 : 200 });
      }),
    );
    const result = await installNativeSource({
      ...f,
      name: "native-flow",
      setupChoice: "pi",
      externalComputer: true,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(result.code).toBe(0);
    expect(healthCalls).toBe(20);
    expect(inspectNativeListeners).toHaveBeenCalledTimes(1);
    expect(snapshotRounds).toEqual([4]);
    expect(inspectNativeProcess).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("a service that exits silently while endpoints return 503 is caught on the periodic listener snapshot", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  let started = 0;
  vi.mocked(startNativeProcess).mockImplementation(async (options) => {
    if (options.name !== "teamhub") f.running.add(options.name);
    if (++started === 3) {
      vi.mocked(inspectNativeProcess).mockClear();
      vi.mocked(inspectNativeListeners).mockClear();
    }
    return { running: true, pid: 100 };
  });
  const snapshotRounds: number[] = [];
  let healthCalls = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.mocked(inspectNativeListeners).mockImplementation(
      async (_root, listeners) => {
        snapshotRounds.push(Math.ceil(healthCalls / 4));
        return listeners.map(({ name }) => ({ running: f.running.has(name) }));
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const text = String(url);
        if (text.endsWith("/healthz") || text.endsWith("/readyz")) {
          healthCalls += 1;
          if (healthCalls === 5) vi.setSystemTime(Date.now() + 2_000);
          else if (healthCalls === 9) vi.setSystemTime(Date.now() + 3_000);
        }
        return new Response("{}", { status: 503 });
      }),
    );
    const result = await installNativeSource({
      ...f,
      name: "native-flow",
      setupChoice: "pi",
      externalComputer: true,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(result).toMatchObject({ code: 1, state: "failed" });
    expect(result.message).toContain("Native teamhub stopped during startup.");
    expect(inspectNativeListeners).toHaveBeenCalledTimes(1);
    expect(snapshotRounds).toEqual([3]);
    expect(inspectNativeProcess).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("aborting during HTTP readiness polling exits without taking a listener snapshot", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  let started = 0;
  vi.mocked(startNativeProcess).mockImplementation(async (options) => {
    f.running.add(options.name);
    if (++started === 3) {
      vi.mocked(inspectNativeProcess).mockClear();
      vi.mocked(inspectNativeListeners).mockClear();
    }
    return { running: true, pid: 100 };
  });
  vi.mocked(inspectNativeListeners).mockImplementation(
    async (_root, listeners) =>
      listeners.map(({ name }) => ({ running: f.running.has(name) })),
  );
  const controller = new AbortController();
  const healthSignals: (AbortSignal | null | undefined)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url, init?: RequestInit) => {
      const requestSignal = init?.signal;
      healthSignals.push(requestSignal);
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () =>
          reject(requestSignal?.reason ?? new Error("aborted"));
        if (requestSignal?.aborted) {
          onAbort();
          return;
        }
        requestSignal?.addEventListener("abort", onAbort, { once: true });
        if (healthSignals.length === 4) controller.abort();
      });
    }),
  );
  const result = await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "pi",
    externalComputer: true,
    signal: controller.signal,
    onEvent: () => {},
  });
  expect(result).toMatchObject({ code: 130, state: "cancelled" });
  expect(healthSignals).toHaveLength(4);
  expect(healthSignals.every((signal) => signal?.aborted)).toBe(true);
  expect(inspectNativeListeners).not.toHaveBeenCalled();
  expect(inspectNativeProcess).not.toHaveBeenCalled();
});

test("a transient listener inspection error retries on the next tick instead of falsely reporting a stopped service", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  let started = 0;
  vi.mocked(startNativeProcess).mockImplementation(async (options) => {
    f.running.add(options.name);
    if (++started === 3) {
      vi.mocked(inspectNativeProcess).mockClear();
      vi.mocked(inspectNativeListeners).mockClear();
    }
    return { running: true, pid: 100 };
  });
  let snapshotAttempts = 0;
  vi.mocked(inspectNativeListeners).mockImplementation(
    async (_root, listeners) => {
      if (++snapshotAttempts === 1)
        throw new Error("transient listener query failure");
      return listeners.map(({ name }) => ({ running: f.running.has(name) }));
    },
  );
  const result = await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(result.code).toBe(0);
  expect(inspectNativeListeners).toHaveBeenCalledTimes(2);
  expect(inspectNativeProcess).not.toHaveBeenCalled();
});

test("post-snapshot HTTP confirmation prevents an exiting foreign listener from passing readiness", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  let started = 0;
  vi.mocked(startNativeProcess).mockImplementation(async (options) => {
    f.running.add(options.name);
    if (++started === 3) {
      vi.mocked(inspectNativeProcess).mockClear();
      vi.mocked(inspectNativeListeners).mockClear();
    }
    return { running: true, pid: 100 };
  });
  vi.mocked(inspectNativeListeners).mockImplementation(
    async (_root, listeners) =>
      listeners.map(({ name }) => ({ running: f.running.has(name) })),
  );
  let healthCalls = 0;
  const baseFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init?: RequestInit) => {
      const text = String(url);
      if (!text.endsWith("/healthz") && !text.endsWith("/readyz"))
        return baseFetch(url, init);
      healthCalls += 1;
      const round = Math.ceil(healthCalls / 4);
      // Round 1 mimics an exiting foreign listener answering 200; round 2 is
      // the post-snapshot confirmation failing with 503 after it exited.
      return new Response("{}", { status: round === 2 ? 503 : 200 });
    }),
  );
  const logs: string[] = [];
  const result = await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: (event) => {
      if (event.kind === "log") logs.push(event.message);
    },
  });
  expect(result.code).toBe(0);
  expect(healthCalls).toBe(16);
  expect(inspectNativeListeners).toHaveBeenCalledTimes(2);
  expect(inspectNativeProcess).not.toHaveBeenCalled();
  expect(logs.join("")).toContain(
    "Waiting for native compilation and readiness (0/4 ready).",
  );
});

test("a native module that has to compile installs Apple's tools and retries", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  let prepares = 0;
  const succeed = vi.mocked(runProcess).getMockImplementation()!;
  vi.mocked(runProcess).mockImplementation(async (command, args, options) => {
    if (args.includes("prepare") && ++prepares === 1) {
      options?.onOutput?.("gyp ERR! stack Error: not found: make\n");
      return { code: 1, stdout: "", stderr: "" };
    }
    return succeed(command, args, options);
  });
  vi.mocked(needsAppleDeveloperTools).mockImplementation(async (output) =>
    output.includes("gyp ERR!"),
  );
  vi.mocked(installAppleDeveloperTools).mockResolvedValue();
  const events: InstallerEvent[] = [];
  const result = await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  expect(result).toMatchObject({ code: 0 });
  expect(prepares).toBe(2);
  expect(installAppleDeveloperTools).toHaveBeenCalledTimes(1);
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "stage",
      stage: "images",
      state: "running",
      message: "Installing Apple developer tools…",
    }),
  );
});

test("a native step that fails again after Apple's tools are installed reports the failure", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  vi.mocked(runProcess).mockImplementation(async (_command, args, options) => {
    if (!args.includes("prepare")) return { code: 0, stdout: "", stderr: "" };
    options?.onOutput?.("gyp ERR! stack Error: not found: make\n");
    return { code: 1, stdout: "", stderr: "" };
  });
  vi.mocked(needsAppleDeveloperTools).mockResolvedValue(true);
  vi.mocked(installAppleDeveloperTools).mockResolvedValue();
  const result = await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(result).toMatchObject({ code: 1, state: "failed" });
  expect(result.message).toContain("Native source prepare failed (exit 1).");
  expect(installAppleDeveloperTools).toHaveBeenCalledTimes(1);
});

test("a failed checkout preparation reports its own cause, not the Runtime it stopped", async () => {
  const f = await fixture();
  vi.mocked(prepareNativeDependencies).mockRejectedValue(
    new Error("A verified private native tool could not execute."),
  );
  // Like prepareDependencies, the Runtime rethrows the abort that stopped it.
  vi.mocked(prepareRuntime).mockImplementation(
    (_choice, options) =>
      new Promise((_resolve, reject) =>
        options.signal.addEventListener("abort", () => {
          try {
            options.signal.throwIfAborted();
          } catch (error) {
            reject(error);
          }
        }),
      ),
  );
  const events: InstallerEvent[] = [];
  const result = await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "codex",
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  expect(result).toMatchObject({ code: 1, state: "failed" });
  expect(result.message).toMatch(
    /^A verified private native tool could not execute/,
  );
  expect(result.message).not.toContain("This operation was aborted");
  expect(result.details).toMatchObject({ stage: "release" });
});

test("a failed Runtime reports its own outcome while the checkout preparation stops", async () => {
  const f = await fixture();
  vi.mocked(prepareNativeDependencies).mockImplementation(
    (options) =>
      new Promise((_resolve, reject) =>
        options.signal.addEventListener("abort", () => {
          try {
            options.signal.throwIfAborted();
          } catch (error) {
            reject(error);
          }
        }),
      ),
  );
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 5,
    state: "failed",
    message: "codex could not be installed.",
  });
  const result = await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "codex",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(result).toMatchObject({
    code: 5,
    message: "codex could not be installed.",
  });
});

test.each(["returned", "thrown"])(
  "a %s BYOK failure after PostgreSQL startup fails the runtime stage",
  async (failure) => {
    const f = await fixture();
    let signalPostgresStarted!: () => void;
    const postgresStarted = new Promise<void>((resolve) => {
      signalPostgresStarted = resolve;
    });
    vi.mocked(prepareNativeDatabase).mockImplementation(async () => {
      f.running.add("postgres");
      signalPostgresStarted();
      return {};
    });
    const message = "Could not mount the model endpoint: ConnectionResetError.";
    vi.mocked(prepareByokRuntime).mockImplementation(async (_byok, options) => {
      await postgresStarted;
      options.onEvent({
        kind: "stage",
        stage: "runtime",
        state: "running",
        message: "Mounting BYOK endpoint on local Bifrost gateway…",
      });
      if (failure === "thrown") throw new Error(message);
      return { code: 1, state: "failed", message };
    });
    const events: InstallerEvent[] = [];
    const result = await installNativeSource({
      ...f,
      name: "native-flow",
      byok: {
        baseUrl: "https://example.test",
        path: "/v1",
        endpoint: "/chat/completions",
        protocol: "openai-chat",
        modelId: "test",
        apiKey: "test-key",
        runtime: "pi",
      },
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });
    expect(result).toMatchObject({
      state: "failed",
      message: expect.stringContaining(message),
      details: { stage: "runtime" },
    });
    expect(events.filter((event) => event.state === "failed")).toEqual([
      { kind: "stage", stage: "runtime", state: "failed", message },
    ]);
    expect(f.running.size).toBe(0);
  },
);

test("an invalid checkout fails preflight before starting the runtime", async () => {
  const f = await fixture();
  const events: InstallerEvent[] = [];
  const result = await installNativeSource({
    ...f,
    name: "native-flow",
    repo: path.join(f.repo, "missing"),
    setupChoice: "pi",
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  expect(result).toMatchObject({
    state: "failed",
    details: { stage: "preflight" },
  });
  expect(events.filter((event) => event.state === "failed")).toEqual([
    {
      kind: "stage",
      stage: "preflight",
      state: "failed",
      message: expect.any(String),
    },
  ]);
  expect(prepareRuntime).not.toHaveBeenCalled();
});

test("an installation stopped from outside stays cancelled", async () => {
  const f = await fixture();
  const controller = new AbortController();
  vi.mocked(prepareNativeDependencies).mockImplementation(
    (options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          try {
            options.signal.throwIfAborted();
          } catch (error) {
            reject(error);
          }
        });
        controller.abort();
      }),
  );
  vi.mocked(prepareRuntime).mockImplementation(
    (_choice, options) =>
      new Promise((_resolve, reject) => {
        if (options.signal.aborted) reject(new Error("x"));
        options.signal.addEventListener("abort", () => reject(new Error("x")));
      }),
  );
  const result = await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "codex",
    signal: controller.signal,
    onEvent: () => {},
  });
  expect(result).toMatchObject({ code: 130, state: "cancelled" });
});

test("an abort without a cause names the step instead of the bare abort", async () => {
  const f = await fixture();
  vi.mocked(prepareNativeDependencies).mockRejectedValue(
    new DOMException("This operation was aborted", "AbortError"),
  );
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const events: InstallerEvent[] = [];
  const result = await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "codex",
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  expect(result).toMatchObject({ code: 1, state: "failed" });
  expect(result.message).toMatch(
    /^Setup stopped unexpectedly while preparing private native toolchains and PostgreSQL\./,
  );
  expect(result.message).not.toContain("This operation was aborted");
  // The raw error stays in the installer log for diagnosis.
  expect(
    events.some(
      (event) =>
        event.kind === "log" &&
        event.message.includes("AbortError: This operation was aborted"),
    ),
  ).toBe(true);
});

test("bundled TeamHub binaries that verify spare the Go toolchain", async () => {
  const f = await fixture();
  const directory = path.join(f.repo, TEAMHUB_BINARY_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const binaries: Record<string, object> = {};
  for (const command of TEAMHUB_COMMANDS) {
    const body = `${command} binary`;
    await writeFile(path.join(directory, `${command}.exe`), body);
    binaries[command] = {
      file: `${command}.exe`,
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: body.length,
    };
  }
  const manifest = {
    target: `${process.platform}-${process.arch}`,
    sourceCommit: "a".repeat(40),
    sourceArchiveSha256: "b".repeat(64),
    goVersion: "1.26.5",
    binaries,
  };
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify(manifest),
  );
  vi.mocked(prepareNativeDependencies).mockRejectedValue(new Error("stop"));
  const install = async () => {
    const logs: string[] = [];
    await installNativeSource({
      ...f,
      name: "native-flow",
      setupChoice: "pi",
      signal: new AbortController().signal,
      onEvent: (event) => logs.push(event.message),
    });
    return logs;
  };
  expect(await install()).toContain(
    "Using the bundled TeamHub binaries; Go is not needed.\n",
  );
  expect(vi.mocked(prepareNativeDependencies).mock.lastCall?.[0].go).toBe(
    false,
  );
  // A changed binary is dropped, and Native compiles TeamHub with Go.
  await writeFile(path.join(directory, "migrate.exe"), "migrate binarY");
  expect(await install()).toContain(
    "The bundled TeamHub binaries do not verify; compiling TeamHub instead.\n",
  );
  expect(vi.mocked(prepareNativeDependencies).mock.lastCall?.[0].go).toBe(true);
  expect(existsSync(directory)).toBe(false);
});

// The services a desktop build unpacks into the checkout
// (build-native-runtime.mjs), with their manifest.
async function bundledRuntime(repo: string) {
  const directory = path.join(repo, NATIVE_RUNTIME_DIRECTORY);
  const files: Record<string, object> = {};
  for (const file of [
    "web/static-host.mjs",
    "web/dist/index.html",
    "node-services/dist/main.js",
    "node-services/dist/supervisor.js",
  ]) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), file);
    files[file] = {
      bytes: file.length,
      sha256: createHash("sha256").update(file).digest("hex"),
    };
  }
  await writeFile(
    path.join(directory, NATIVE_RUNTIME_FILES),
    JSON.stringify({
      schema: 1,
      target: `${process.platform}-${process.arch}`,
      sourceCommit: "a".repeat(40),
      sourceArchiveSha256: "b".repeat(64),
      files,
    }),
  );
  return directory;
}

test("native timings count only Runtime work that outlasts PostgreSQL", async () => {
  const f = await fixture();
  // A service still running keeps the install sequential, where the Runtime
  // wait sits on the critical path between PostgreSQL and the migrations.
  f.running.add("web");
  let clock = 0;
  let startRuntime!: () => void;
  let finishRuntime!: () => void;
  const runtimeStarted = new Promise<void>((resolve) => {
    startRuntime = resolve;
  });
  const runtimeFinished = new Promise<void>((resolve) => {
    finishRuntime = resolve;
  });
  vi.mocked(prepareRuntime).mockImplementation(async (_runtime, options) => {
    options.onEvent?.({
      kind: "stage",
      stage: "runtime",
      state: "running",
      message: "Preparing Pi…",
    });
    startRuntime();
    await runtimeFinished;
    return { code: 0, state: "ready", message: "ready" };
  });
  vi.mocked(prepareNativeDatabase).mockImplementation(async () => {
    await runtimeStarted;
    clock += 3000;
    f.running.add("postgres");
    // Let the install reach its Runtime wait before completing the probe.
    setImmediate(() => {
      clock += 7000;
      finishRuntime();
    });
    return {};
  });
  const run = vi.mocked(runProcess).getMockImplementation()!;
  vi.mocked(runProcess).mockImplementation(async (command, args, options) => {
    if (args.includes("migrate")) clock += 2000;
    return run(command, args, options);
  });
  const runtimeStages: InstallerEvent["state"][] = [];
  const result = await installNativeSource(
    {
      ...f,
      name: "native-timings",
      setupChoice: "pi",
      externalComputer: true,
      signal: new AbortController().signal,
      onEvent: (event) => {
        if (event.kind === "stage" && event.stage === "runtime")
          runtimeStages.push(event.state);
      },
    },
    () => clock,
  );
  expect(result).toMatchObject({
    code: 0,
    details: { timings: { services: 5, runtime: 7 } },
  });
  expect(runtimeStages).toEqual(["running", "succeeded"]);
});

test("overlapped timings count Runtime only for the wait beyond services and account", async () => {
  const f = await fixture();
  let clock = 0;
  let ownerRan = false;
  let timerMoved!: () => void;
  const runtimeEntered = new Promise<void>((resolve) => {
    timerMoved = resolve;
  });
  // Only the stage timer reads this clock. After the owner command, its next
  // read is the move to "runtime" once the account branch has settled.
  const now = () => {
    if (ownerRan) timerMoved();
    return clock;
  };
  vi.mocked(prepareRuntime).mockImplementation(async () => {
    await runtimeEntered;
    clock += 4000;
    return { code: 0, state: "ready", message: "ready" };
  });
  const run = vi.mocked(runProcess).getMockImplementation()!;
  vi.mocked(runProcess).mockImplementation(async (command, args, options) => {
    if (args.includes("migrate")) clock += 2000;
    if (args.includes("owner")) {
      clock += 1000;
      const result = await run(command, args, options);
      ownerRan = true;
      return result;
    }
    return run(command, args, options);
  });
  // A fresh setup with no services running takes the overlapped path.
  const result = await installNativeSource(
    {
      ...f,
      name: "native-timings-overlap",
      setupChoice: "pi",
      externalComputer: true,
      signal: new AbortController().signal,
      onEvent: () => {},
    },
    now,
  );
  expect(result.code, result.message).toBe(0);
  const timings = (result.details as { timings: Record<string, number> })
    .timings;
  expect(timings).toMatchObject({ services: 2, account: 1, runtime: 4 });
  const total = Object.values(timings).reduce((sum, value) => sum + value, 0);
  expect(total).toBeCloseTo(clock / 1000, 1);
});

test("bundled services that verify install no packages and record stage times", async () => {
  const f = await fixture();
  await bundledRuntime(f.repo);
  vi.mocked(prepareNativeDependencies).mockResolvedValue({
    env: {},
    postgresBin: "/private/postgres/bin",
    toolchainRoot: "/private/tools",
    registries: [],
  });
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const stages: string[] = [];
  const logs: string[] = [];
  let clock = 0;
  const result = await installNativeSource(
    {
      home: f.home,
      repo: f.repo,
      name: "native-desktop",
      setupChoice: "pi",
      externalComputer: true,
      signal: new AbortController().signal,
      onEvent: (event) => {
        logs.push(event.message);
        if (event.kind === "stage" && event.state !== "running")
          stages.push(`${event.stage}:${event.state}`);
      },
    },
    () => (clock += 1000),
  );
  expect(result).toMatchObject({ code: 0, state: "ready" });
  expect(logs).toContain(
    "Using the bundled Native services; no packages are installed.\n",
  );
  expect(vi.mocked(prepareNativeDependencies).mock.lastCall?.[0].packages).toBe(
    false,
  );
  expect(stages).toContain("images:skipped");
  const operations = vi.mocked(runProcess).mock.calls.map((row) => row[1]);
  expect(operations.some((args) => args.includes("prepare"))).toBe(false);
  expect(operations.some((args) => args.includes("migrate"))).toBe(true);
  const timings = (result.details as { timings: Record<string, number> })
    .timings;
  expect(Object.keys(timings)).toEqual(
    expect.arrayContaining(["preflight", "release", "images", "services"]),
  );
  expect(Object.values(timings).every((seconds) => seconds > 0)).toBe(true);
  expect(timings).not.toHaveProperty("runtime");
  expect(
    logs.some((line) => line.startsWith("Native install timings (s): ")),
  ).toBe(true);
});

test("bundled services that do not verify fall back to installing packages", async () => {
  const f = await fixture();
  const directory = await bundledRuntime(f.repo);
  await writeFile(path.join(directory, "web/dist/index.html"), "changed");
  vi.mocked(prepareNativeDependencies).mockRejectedValue(new Error("stop"));
  const logs: string[] = [];
  await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: (event) => logs.push(event.message),
  });
  expect(logs).toContain(
    "The bundled Native services do not verify; installing the checkout's packages instead.\n",
  );
  expect(vi.mocked(prepareNativeDependencies).mock.lastCall?.[0].packages).toBe(
    true,
  );
  expect(existsSync(directory)).toBe(false);
});
async function installVoice(
  tools: "bundled" | "absent" | "failed",
  keys: Record<string, string> = {},
  f?: Awaited<ReturnType<typeof fixture>>,
) {
  f ??= await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  if (Object.keys(keys).length)
    await updateUserKeys(path.join(f.home, "instances", "native-voice"), keys);
  const bin = path.join(f.home, "voice", "bin");
  if (tools === "failed")
    vi.mocked(prepareNativeVoiceTools).mockRejectedValue(
      new Error("voice tools download failed"),
    );
  else
    vi.mocked(prepareNativeVoiceTools).mockResolvedValue(
      tools === "bundled"
        ? { bin, livekit: path.join(bin, "livekit-server") }
        : undefined,
    );
  const settings = {
    httpPort: 30000,
    rtcPort: 30001,
    apiKey: "APIabcdef123456",
    apiSecret: "s".repeat(64),
  };
  vi.mocked(readLiveKitSettings).mockResolvedValue(settings);
  const events: string[] = [];
  await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-voice",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event.message),
  });
  const services = vi
    .mocked(startNativeProcess)
    .mock.calls.map(([options]) => options)
    .filter((options) => options.name !== "postgres");
  const env = (name: string) =>
    services.find((options) => options.name === name)!.env;
  return { f, bin, settings, events: events.join(""), services, env };
}

for (const keys of [{}, { SONIOX_API_KEY: "soniox-1" }] as Record<
  string,
  string
>[])
  test(`voice tools start LiveKit and put ffmpeg on PATH ${Object.keys(keys).length ? "with" : "without"} a voice key`, async () => {
    const { bin, settings, events, services, env } = await installVoice(
      "bundled",
      keys,
    );
    expect(prepareNativeVoiceTools).toHaveBeenCalled();
    for (const options of services)
      expect(JSON.parse(options.settings!).voice).toBe(bin);
    expect(startNativeLiveKit).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: path.join(bin, "livekit-server"),
        settings,
      }),
    );
    for (const name of ["teamhub", "node-services"]) {
      expect(env(name).PATH!.split(path.delimiter)[0]).toBe(bin);
      expect(env(name).TEAMHUB_VOICE_MEDIA).toBeUndefined();
      expect(env(name).LIVEKIT_API_KEY).toBeTruthy();
    }
    // A key in user.env passes through unchanged.
    expect(env("node-services").SONIOX_API_KEY).toBe(
      "SONIOX_API_KEY" in keys ? "soniox-1" : undefined,
    );
    expect(events).not.toContain("soniox-1");
  });

test("LiveKit holds its port before the model controller chooses one", async () => {
  const f = await fixture();
  const livekit = net.createServer();
  const modelController = net.createServer();
  const listen = (server: net.Server, port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        server.off("error", reject);
        resolve();
      });
    });
  const close = (server: net.Server) =>
    new Promise<void>((resolve) => {
      if (server.listening) server.close(() => resolve());
      else resolve();
    });
  const actual = await vi.importActual<typeof import("./native-livekit.js")>(
    "./native-livekit.js",
  );
  vi.mocked(readLiveKitSettings).mockImplementation(actual.readLiveKitSettings);
  vi.mocked(prepareNativeVoiceTools).mockResolvedValue({
    bin: path.join(f.home, "voice"),
    livekit: path.join(f.home, "voice", "livekit-server"),
  });
  vi.mocked(startNativeLiveKit).mockImplementation(async ({ settings }) => {
    if (!livekit.listening) await listen(livekit, settings.httpPort);
    f.running.add("livekit");
  });
  vi.mocked(prepareFoundationServices).mockImplementation(async (instance) => {
    if (modelController.listening) return;
    const settings = (await actual.readLiveKitSettings(instance.root))!;
    // Force the allocation observed on a cold setup: the controller gets
    // LiveKit's assigned port whenever LiveKit has not bound it yet.
    try {
      await listen(modelController, settings.httpPort);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      await listen(modelController, 0);
    }
  });
  const stop = vi.mocked(stopNativeProcess).getMockImplementation()!;
  vi.mocked(stopNativeProcess).mockImplementation(async (root, name) => {
    if (name === "livekit") await close(livekit);
    await stop(root, name);
  });
  try {
    const installed = await runFlow(f);
    expect(installed.code, installed.message).toBe(0);
    const livekitAddress = livekit.address();
    const controllerAddress = modelController.address();
    expect(livekitAddress).not.toBeNull();
    expect(controllerAddress).not.toBeNull();
    expect(controllerAddress).not.toEqual(livekitAddress);

    // On a retry after a later startup failure, roll back only the LiveKit
    // this run started; keep the controller and reuse the original port.
    const instanceRoot = path.join(f.home, "instances", "native-flow");
    await stopNativeProcess(instanceRoot, "livekit");
    vi.mocked(prepareModelGateway).mockRejectedValueOnce(
      new Error("test gateway startup failure"),
    );
    expect(await runFlow(f)).toMatchObject({
      code: 1,
      message: expect.stringContaining("test gateway startup failure"),
    });
    expect(livekit.listening).toBe(false);
    expect(modelController.address()).toEqual(controllerAddress);
    expect(await runFlow(f)).toMatchObject({ code: 0 });
    expect(livekit.address()).toEqual(livekitAddress);
  } finally {
    await Promise.all([close(livekit), close(modelController)]);
  }
});

test("an overlapped setup binds LiveKit before the runtime branch prepares foundation services", async () => {
  const f = await fixture();
  const actual = await vi.importActual<typeof import("./native-livekit.js")>(
    "./native-livekit.js",
  );
  vi.mocked(readLiveKitSettings).mockImplementation(actual.readLiveKitSettings);
  vi.mocked(prepareNativeVoiceTools).mockResolvedValue({
    bin: path.join(f.home, "voice"),
    livekit: path.join(f.home, "voice", "livekit-server"),
  });
  const order: string[] = [];
  // A slow bind gives a racing runtime branch time to reach the controller.
  vi.mocked(startNativeLiveKit).mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    f.running.add("livekit");
    order.push("livekit bound");
  });
  vi.mocked(prepareFoundationServices).mockImplementation(async () => {
    order.push("foundations ensure");
  });
  const events: InstallerEvent[] = [];
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  // A fresh setup with no services running takes the overlapped path.
  const result = await installNativeSource({
    ...f,
    name: "native-flow-overlap-livekit",
    setupChoice: "pi",
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  expect(result.code, result.message).toBe(0);
  expect(order).toEqual(["livekit bound", "foundations ensure"]);
  const servicesRunning = events.findIndex(
    (event) =>
      event.kind === "stage" &&
      event.stage === "services" &&
      event.state === "running" &&
      event.message === "Starting native collaboration services…",
  );
  expect(servicesRunning).toBeGreaterThanOrEqual(0);
});

for (const tools of ["absent", "failed"] as const)
  test(`voice stays off and the install continues when voice tools are ${tools}`, async () => {
    const { events, services, env } = await installVoice(tools, {
      SONIOX_API_KEY: "soniox-1",
    });
    for (const options of services)
      expect(JSON.parse(options.settings!).voice).toBe("off");
    expect(startNativeLiveKit).not.toHaveBeenCalled();
    expect(env("teamhub").TEAMHUB_VOICE_MEDIA).toBe("off");
    expect(env("node-services").SONIOX_API_KEY).toBe("soniox-1");
    expect(events).toContain("Voice stays off");
    if (tools === "failed")
      expect(events).toContain("voice tools download failed");
    expect(events).not.toContain("soniox-1");
  });

test("voice stays off and the install continues when LiveKit UDP port allocation fails", async () => {
  vi.mocked(prepareLiveKitSettings).mockRejectedValueOnce(
    new PortAllocationError("udp", "127.0.0.1 bind: EADDRINUSE", 54_321),
  );
  const { events, services, env } = await installVoice("bundled", {
    SONIOX_API_KEY: "soniox-1",
  });
  for (const options of services)
    expect(JSON.parse(options.settings!).voice).toBe("off");
  expect(startNativeLiveKit).not.toHaveBeenCalled();
  expect(env("teamhub").TEAMHUB_VOICE_MEDIA).toBe("off");
  expect(env("teamhub").LIVEKIT_URL).toBeUndefined();
  expect(events).toContain(
    "Voice stays off: LiveKit could not reserve a local port",
  );
  expect(events).toContain("UDP: 127.0.0.1 bind: EADDRINUSE (port 54321)");
});

test("voice still stays off on LiveKit port exhaustion even when checkout .env defines LIVEKIT_URL", async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.repo, ".env"),
    "LIVEKIT_URL=ws://127.0.0.1:17880\n",
  );
  const bin = path.join(f.home, "voice");
  vi.mocked(prepareNativeVoiceTools).mockResolvedValue({
    bin,
    livekit: path.join(bin, "livekit-server"),
  });
  vi.mocked(readLiveKitSettings).mockResolvedValue({
    httpPort: 30000,
    rtcPort: 30001,
    apiKey: "APIabcdef123456",
    apiSecret: "s".repeat(64),
  });
  vi.mocked(prepareLiveKitSettings).mockRejectedValueOnce(
    new PortAllocationError("udp", "127.0.0.1 bind: EADDRINUSE", 54_322),
  );
  const events: string[] = [];
  const outcome = await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-voice-checkout-env",
    setupChoice: "pi",
    externalComputer: false,
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event.message),
  });
  expect(outcome.code, outcome.message).toBe(0);
  const services = vi
    .mocked(startNativeProcess)
    .mock.calls.map(([options]) => options)
    .filter((options) => options.name !== "postgres");
  for (const options of services)
    expect(JSON.parse(options.settings!).voice).toBe("off");
  expect(startNativeLiveKit).not.toHaveBeenCalled();
  const teamhub = services.find((options) => options.name === "teamhub")!;
  expect(teamhub.env.TEAMHUB_VOICE_MEDIA).toBe("off");
  expect(events.join("")).toContain(
    "Voice stays off: LiveKit could not reserve a local port",
  );
});

test("non-port LiveKit configuration errors still fail preflight", async () => {
  const f = await fixture();
  vi.mocked(prepareLiveKitSettings).mockRejectedValueOnce(
    new Error("disk permission denied"),
  );
  const outcome = await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-voice-error",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(outcome.code).toBe(1);
  expect(outcome.message).toContain("disk permission denied");
});

test("a changed voice key leaves the voice setting alone", async () => {
  const first = await installVoice("bundled", { XAI_API_KEY: "xai-1" });
  vi.mocked(startNativeProcess).mockClear();
  const second = await installVoice(
    "bundled",
    { XAI_API_KEY: "xai-2" },
    first.f,
  );
  const voice = (run: typeof first) =>
    run.services.map((options) => JSON.parse(options.settings!).voice);
  expect(voice(second)).toEqual(voice(first));
  expect(second.env("node-services").XAI_API_KEY).toBe("xai-2");
});

test("cold first install defers voice tools extraction, reserves LiveKit HTTP port, and commits after releasing it", async () => {
  const f = await fixture();
  const actual = await vi.importActual<typeof import("./native-livekit.js")>(
    "./native-livekit.js",
  );
  vi.mocked(readLiveKitSettings).mockImplementation(actual.readLiveKitSettings);
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const bin = path.join(
    f.home,
    "tools",
    "native",
    "components",
    "a".repeat(64),
    "bin",
  );
  const livekit = path.join(bin, "livekit-server");
  vi.mocked(resolveNativeVoiceToolsPlan).mockResolvedValue({
    bin,
    livekit,
    prepared: false,
    damaged: false,
  });

  const tryBind = (port: number) =>
    new Promise<"free" | "in_use">((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") resolve("in_use");
        else reject(error);
      });
      probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        probe.close(() => resolve("free"));
      });
    });

  let portStateDuringRuntime: "free" | "in_use" | undefined;
  vi.mocked(prepareRuntime).mockImplementation(async () => {
    const root = path.join(f.home, "instances", "native-voice-async");
    const liveKitSettings = (await actual.readLiveKitSettings(root))!;
    portStateDuringRuntime = await tryBind(liveKitSettings.httpPort);
    return { code: 0, state: "ready", message: "ready" };
  });

  let liveKitHttpPort: number | undefined;
  let portStateDuringFoundation: "free" | "in_use" | undefined;
  vi.mocked(prepareFoundationServices).mockImplementation(async (instance) => {
    const liveKitSettings = (await actual.readLiveKitSettings(instance.root))!;
    liveKitHttpPort = liveKitSettings.httpPort;
    portStateDuringFoundation = await tryBind(liveKitHttpPort);
  });

  const order: string[] = [];
  let portStateAtLaunch: Promise<"free" | "in_use"> | undefined;
  vi.mocked(reclaimNativeOrphans).mockImplementation(async () => {
    order.push("reclaim");
    return [];
  });
  let portStateAtCommit: Promise<"free" | "in_use"> | undefined;
  const commit = vi.fn(() => {
    order.push("commit");
    if (liveKitHttpPort !== undefined) {
      portStateAtCommit = tryBind(liveKitHttpPort);
    }
  });
  const abort = vi.fn(() => {
    order.push("abort");
  });
  const launchVoiceToolsBackground = vi.fn(() => {
    order.push("launch");
    const root = path.join(f.home, "instances", "native-voice-async");
    portStateAtLaunch = actual
      .readLiveKitSettings(root)
      .then((settings) => tryBind(settings!.httpPort));
    return { commit, abort };
  });
  const events: string[] = [];

  const result = await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-voice-async",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event.message),
    launchVoiceToolsBackground,
  });

  expect(result.code, result.message).toBe(0);
  expect(launchVoiceToolsBackground).toHaveBeenCalledTimes(1);
  expect(prepareNativeVoiceTools).not.toHaveBeenCalled();
  expect(startNativeLiveKit).not.toHaveBeenCalled();
  expect(portStateDuringRuntime).toBe("in_use");
  expect(await portStateAtLaunch).toBe("in_use");
  expect(portStateDuringFoundation).toBe("in_use");
  expect(await portStateAtCommit).toBe("free");
  expect(order).toEqual(["reclaim", "launch", "commit"]);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(abort).not.toHaveBeenCalled();
  expect(events.join("")).toContain(
    "Voice tools preparation and LiveKit startup are continuing in the background.",
  );

  const services = vi
    .mocked(startNativeProcess)
    .mock.calls.map(([options]) => options)
    .filter((options) => options.name !== "postgres");
  const env = (name: string) =>
    services.find((options) => options.name === name)!.env;
  for (const options of services) {
    expect(JSON.parse(options.settings!).voice).toBe(bin);
  }
  expect(env("teamhub").TEAMHUB_VOICE_TOOLS_BIN).toBe(bin);
  expect(env("node-services").TEAMHUB_VOICE_TOOLS_BIN).toBeUndefined();
  expect(env("web").TEAMHUB_VOICE_TOOLS_BIN).toBeUndefined();
  for (const name of ["teamhub", "node-services"]) {
    expect(env(name).PATH!.split(path.delimiter)[0]).toBe(bin);
    expect(env(name).TEAMHUB_VOICE_MEDIA).toBeUndefined();
    expect(env(name).LIVEKIT_URL).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(env(name).LIVEKIT_API_KEY).toBeTruthy();
    expect(env(name).LIVEKIT_API_SECRET).toBeTruthy();
  }
});

test("cold install rollback releases LiveKit port reservation and aborts background voice worker", async () => {
  const f = await fixture();
  const actual = await vi.importActual<typeof import("./native-livekit.js")>(
    "./native-livekit.js",
  );
  vi.mocked(readLiveKitSettings).mockImplementation(actual.readLiveKitSettings);
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const bin = path.join(
    f.home,
    "tools",
    "native",
    "components",
    "b".repeat(64),
    "bin",
  );
  vi.mocked(resolveNativeVoiceToolsPlan).mockResolvedValue({
    bin,
    livekit: path.join(bin, "livekit-server"),
    prepared: false,
    damaged: false,
  });

  let reservedPort: number | undefined;
  vi.mocked(prepareFoundationServices).mockImplementation(async (instance) => {
    reservedPort = (await actual.readLiveKitSettings(instance.root))!.httpPort;
    throw new Error("foundation failed");
  });

  const commit = vi.fn();
  const abort = vi.fn();
  const result = await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-voice-async-fail",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: () => {},
    launchVoiceToolsBackground: () => ({ commit, abort }),
  });

  expect(result.code).toBe(1);
  expect(abort).toHaveBeenCalledTimes(1);
  expect(commit).not.toHaveBeenCalled();
  expect(reservedPort).toBeDefined();
  const portAfterFailure = await new Promise<"free" | "in_use">(
    (resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") resolve("in_use");
        else reject(error);
      });
      probe.listen(
        { host: "127.0.0.1", port: reservedPort!, exclusive: true },
        () => {
          probe.close(() => resolve("free"));
        },
      );
    },
  );
  expect(portAfterFailure).toBe("free");
});

test("prepareVoiceToolsAndStartLiveKit starts LiveKit only on go when the instance is still running", async () => {
  const f = await fixture();
  const { prepareNativeConfiguration } = await import("./native-source.js");
  const configured = await prepareNativeConfiguration(f.repo, {
    home: f.home,
    name: "native-bg-worker",
    externalComputer: true,
  });
  const liveKitSettings = {
    httpPort: 31234,
    rtcPort: 31235,
    apiKey: "APIabcdef123456",
    apiSecret: "s".repeat(64),
  };
  const livekitBin = path.join(f.home, "voice", "bin", "livekit-server");
  vi.mocked(prepareNativeVoiceTools).mockResolvedValue({
    bin: path.dirname(livekitBin),
    livekit: livekitBin,
  });
  vi.mocked(readLiveKitSettings).mockResolvedValue(liveKitSettings);

  async function* chunks(items: string[]) {
    for (const item of items) yield item;
  }

  // Running postgres + teamhub + "go\n" starts LiveKit.
  f.running.add("postgres");
  f.running.add("teamhub");
  await prepareVoiceToolsAndStartLiveKit({
    home: f.home,
    instanceName: configured.instance.name,
    waitForGoOnStdin: true,
    stdin: chunks(["go\n"]),
  });
  expect(prepareNativeVoiceTools).toHaveBeenCalledTimes(1);
  expect(startNativeLiveKit).toHaveBeenCalledTimes(1);
  expect(startNativeLiveKit).toHaveBeenCalledWith(
    expect.objectContaining({
      root: configured.instance.root,
      executable: livekitBin,
      settings: liveKitSettings,
    }),
  );

  // "abort\n" skips LiveKit.
  vi.mocked(startNativeLiveKit).mockClear();
  await prepareVoiceToolsAndStartLiveKit({
    home: f.home,
    instanceName: configured.instance.name,
    waitForGoOnStdin: true,
    stdin: chunks(["abort\n"]),
  });
  expect(startNativeLiveKit).not.toHaveBeenCalled();

  // Empty EOF skips LiveKit.
  await prepareVoiceToolsAndStartLiveKit({
    home: f.home,
    instanceName: configured.instance.name,
    waitForGoOnStdin: true,
    stdin: chunks([]),
  });
  expect(startNativeLiveKit).not.toHaveBeenCalled();

  // Only postgres running (teamhub stopped by --stop) skips LiveKit.
  f.running.clear();
  f.running.add("postgres");
  await prepareVoiceToolsAndStartLiveKit({
    home: f.home,
    instanceName: configured.instance.name,
    waitForGoOnStdin: true,
    stdin: chunks(["go\n"]),
  });
  expect(startNativeLiveKit).not.toHaveBeenCalled();

  // Already running livekit skips duplicate startup.
  f.running.add("teamhub");
  f.running.add("livekit");
  await prepareVoiceToolsAndStartLiveKit({
    home: f.home,
    instanceName: configured.instance.name,
    waitForGoOnStdin: true,
    stdin: chunks(["go\n"]),
  });
  expect(startNativeLiveKit).not.toHaveBeenCalled();

  // Serializes with withInstanceLock: waits until lock is released before starting LiveKit.
  f.running.delete("livekit");
  let lockHeld!: () => void;
  let releaseLock!: () => void;
  const held = new Promise<void>((resolve) => {
    lockHeld = resolve;
  });
  const holder = withInstanceLock(configured.instance, async () => {
    lockHeld();
    await new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
  });
  await held;
  const lockedRun = prepareVoiceToolsAndStartLiveKit({
    home: f.home,
    instanceName: configured.instance.name,
    waitForGoOnStdin: true,
    stdin: chunks(["go\n"]),
    lockWaitMs: 5_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(startNativeLiveKit).not.toHaveBeenCalled();
  releaseLock();
  await holder;
  await lockedRun;
  expect(startNativeLiveKit).toHaveBeenCalledTimes(1);

  const log = await readFile(
    path.join(configured.instance.root, "native", "logs", "livekit.log"),
    "utf8",
  );
  expect(log).toContain(
    "Instance core services are not running; skipping background LiveKit startup.",
  );
  expect(log).toContain(
    "Native LiveKit is already running; skipping duplicate startup.",
  );
});

test("existing provisioned account, configured voice key, or damaged cache keeps voice tools synchronous", async () => {
  for (const scenario of [
    "provisioned_account",
    "soniox_key",
    "xai_key",
    "damaged_cache",
  ] as const) {
    const f = await fixture();
    const actual = await vi.importActual<typeof import("./native-livekit.js")>(
      "./native-livekit.js",
    );
    vi.mocked(readLiveKitSettings).mockImplementation(
      actual.readLiveKitSettings,
    );
    vi.mocked(prepareRuntime).mockResolvedValue({
      code: 0,
      state: "ready",
      message: "ready",
    });
    const instanceName = `native-sync-${scenario.replace(/_/g, "-")}`;
    const instanceRoot = path.join(f.home, "instances", instanceName);
    if (scenario === "provisioned_account") {
      const { prepareNativeConfiguration } = await import("./native-source.js");
      await prepareNativeConfiguration(f.repo, {
        home: f.home,
        name: instanceName,
        externalComputer: true,
      });
      await atomicPrivate(
        path.join(instanceRoot, "local-account.json"),
        JSON.stringify({
          email: "owner@example.com",
          password: "secret-password-123",
          provisioned: true,
        }),
      );
    } else if (scenario === "soniox_key") {
      await updateUserKeys(instanceRoot, { SONIOX_API_KEY: "soniox-key" });
    } else if (scenario === "xai_key") {
      await updateUserKeys(instanceRoot, { XAI_API_KEY: "xai-key" });
    }

    const bin = path.join(f.home, "voice", "bin");
    const livekit = path.join(bin, "livekit-server");
    vi.mocked(resolveNativeVoiceToolsPlan).mockResolvedValue({
      bin,
      livekit,
      prepared: false,
      damaged: scenario === "damaged_cache",
    });
    vi.mocked(prepareNativeVoiceTools).mockResolvedValue({ bin, livekit });
    const launchVoiceToolsBackground = vi.fn();

    const result = await installNativeSource({
      home: f.home,
      repo: f.repo,
      name: instanceName,
      setupChoice: "pi",
      externalComputer: true,
      signal: new AbortController().signal,
      onEvent: () => {},
      launchVoiceToolsBackground,
    });

    expect(result.code, `${scenario}: ${result.message}`).toBe(0);
    expect(launchVoiceToolsBackground).not.toHaveBeenCalled();
    expect(prepareNativeVoiceTools).toHaveBeenCalled();
    expect(startNativeLiveKit).toHaveBeenCalled();
    vi.mocked(prepareNativeVoiceTools).mockClear();
    vi.mocked(startNativeLiveKit).mockClear();
  }
});

test("persistent EADDRINUSE on LiveKit port disables voice instead of deferring unreserved", async () => {
  const f = await fixture();
  const actual = await vi.importActual<typeof import("./native-livekit.js")>(
    "./native-livekit.js",
  );
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const blocker = net.createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      blocker.off("error", reject);
      resolve();
    });
  });
  const occupiedPort = (blocker.address() as net.AddressInfo).port;
  try {
    const blockedSettings = {
      httpPort: occupiedPort,
      rtcPort: occupiedPort + 1,
      apiKey: "APIabcdef123456",
      apiSecret: "s".repeat(64),
    };
    vi.mocked(prepareLiveKitSettings).mockResolvedValueOnce(blockedSettings);
    vi.mocked(readLiveKitSettings).mockImplementation(
      actual.readLiveKitSettings,
    );
    const bin = path.join(f.home, "voice", "bin");
    vi.mocked(resolveNativeVoiceToolsPlan).mockResolvedValue({
      bin,
      livekit: path.join(bin, "livekit-server"),
      prepared: false,
      damaged: false,
    });
    const launchVoiceToolsBackground = vi.fn();
    const events: string[] = [];

    const result = await installNativeSource({
      home: f.home,
      repo: f.repo,
      name: "native-voice-eaddrinuse",
      setupChoice: "pi",
      externalComputer: true,
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event.message),
      launchVoiceToolsBackground,
    });

    expect(result.code, result.message).toBe(0);
    expect(launchVoiceToolsBackground).not.toHaveBeenCalled();
    expect(prepareNativeVoiceTools).not.toHaveBeenCalled();
    expect(startNativeLiveKit).not.toHaveBeenCalled();
    expect(events.join("")).toContain(
      `Voice stays off: LiveKit could not reserve local port ${occupiedPort} (EADDRINUSE).`,
    );
    const teamhub = vi
      .mocked(startNativeProcess)
      .mock.calls.map(([options]) => options)
      .find((options) => options.name === "teamhub")!;
    expect(teamhub.env.TEAMHUB_VOICE_MEDIA).toBe("off");
    expect(teamhub.env.TEAMHUB_VOICE_TOOLS_BIN).toBeUndefined();
    expect(JSON.parse(teamhub.settings!).voice).toBe("off");
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test("non-desktop install aborted during computer stage aborts background voice worker instead of committing", async () => {
  const f = await fixture();
  const actual = await vi.importActual<typeof import("./native-livekit.js")>(
    "./native-livekit.js",
  );
  vi.mocked(readLiveKitSettings).mockImplementation(actual.readLiveKitSettings);
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const bin = path.join(f.home, "voice", "bin");
  vi.mocked(resolveNativeVoiceToolsPlan).mockResolvedValue({
    bin,
    livekit: path.join(bin, "livekit-server"),
    prepared: false,
    damaged: false,
  });

  const controller = new AbortController();
  const commit = vi.fn();
  const abort = vi.fn();
  vi.mocked(connectComputer).mockImplementationOnce(async () => {
    controller.abort();
    throw new DOMException("Aborted", "AbortError");
  });

  const result = await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-voice-computer-abort",
    setupChoice: "pi",
    externalComputer: false,
    signal: controller.signal,
    onEvent: () => {},
    launchVoiceToolsBackground: () => ({ commit, abort }),
  });

  expect(result.code).toBe(130);
  expect(result.state).toBe("cancelled");
  expect(commit).not.toHaveBeenCalled();
  expect(abort).toHaveBeenCalledTimes(1);
});

test("prepareVoiceToolsAndStartLiveKit cancels in-flight extraction cleanly on stdin abort", async () => {
  const f = await fixture();
  const { prepareNativeConfiguration } = await import("./native-source.js");
  const configured = await prepareNativeConfiguration(f.repo, {
    home: f.home,
    name: "native-bg-abort-inflight",
    externalComputer: true,
  });

  let extractionStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    extractionStarted = resolve;
  });
  let extractionAborted = false;
  vi.mocked(prepareNativeVoiceTools).mockImplementation(
    ({ signal }) =>
      new Promise((_resolve, reject) => {
        extractionStarted();
        const abortNow = () => {
          extractionAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        };
        if (signal.aborted) {
          abortNow();
          return;
        }
        signal.addEventListener("abort", abortNow, { once: true });
      }),
  );

  let sendAbort!: () => void;
  async function* controlledStdin() {
    await new Promise<void>((resolve) => {
      sendAbort = resolve;
    });
    yield "abort\n";
  }

  const running = prepareVoiceToolsAndStartLiveKit({
    home: f.home,
    instanceName: configured.instance.name,
    waitForGoOnStdin: true,
    stdin: controlledStdin(),
  });
  await started;
  sendAbort();
  await expect(running).resolves.toBeUndefined();
  expect(extractionAborted).toBe(true);
  expect(startNativeLiveKit).not.toHaveBeenCalled();

  const log = await readFile(
    path.join(configured.instance.root, "native", "logs", "livekit.log"),
    "utf8",
  );
  expect(log).toContain('installer signaled "abort"');
});

test("createVoiceToolsBackgroundLauncher spawns the explicit script path and delivers commit or abort over stdin", async () => {
  const dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "linger-voice-launcher-")),
  );
  try {
    const script = path.join(dir, "custom-entry.mjs");
    await writeFile(
      script,
      [
        'import { renameSync, writeFileSync } from "node:fs";',
        'let stdin = "";',
        "for await (const chunk of process.stdin) stdin += String(chunk);",
        "const out = process.env.VOICE_LAUNCHER_OUT;",
        "const tmp = `${out}.tmp`;",
        "writeFileSync(tmp, JSON.stringify({ argv: process.argv.slice(1), stdin, marker: process.env.VOICE_LAUNCHER_MARKER }));",
        "renameSync(tmp, out);",
      ].join("\n"),
    );

    const relativeScript = path.relative(process.cwd(), script);
    const launcher = createVoiceToolsBackgroundLauncher(relativeScript);
    const home = path.join(dir, "home");

    const commitOut = path.join(dir, "commit.json");
    const commitHandle = launcher({
      home,
      instanceName: "voice-commit",
      env: {
        ...process.env,
        VOICE_LAUNCHER_OUT: commitOut,
        VOICE_LAUNCHER_MARKER: "commit-marker",
      },
    });
    commitHandle.commit();
    commitHandle.abort();
    await vi.waitFor(() => expect(existsSync(commitOut)).toBe(true), {
      timeout: 10_000,
    });
    expect(JSON.parse(await readFile(commitOut, "utf8"))).toEqual({
      argv: [
        path.resolve(relativeScript),
        "--prepare-voice-tools",
        "--home",
        home,
        "--instance",
        "voice-commit",
      ],
      stdin: "go\n",
      marker: "commit-marker",
    });

    const abortOut = path.join(dir, "abort.json");
    const abortHandle = launcher({
      home,
      instanceName: "voice-abort",
      env: {
        ...process.env,
        VOICE_LAUNCHER_OUT: abortOut,
        VOICE_LAUNCHER_MARKER: "abort-marker",
      },
    });
    abortHandle.abort();
    abortHandle.commit();
    await vi.waitFor(() => expect(existsSync(abortOut)).toBe(true), {
      timeout: 10_000,
    });
    expect(JSON.parse(await readFile(abortOut, "utf8"))).toEqual({
      argv: [
        path.resolve(relativeScript),
        "--prepare-voice-tools",
        "--home",
        home,
        "--instance",
        "voice-abort",
      ],
      stdin: "abort\n",
      marker: "abort-marker",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("omitting launchVoiceToolsBackground keeps voice tools synchronous regardless of process.argv[1]", async () => {
  const f = await fixture();
  const actual = await vi.importActual<typeof import("./native-livekit.js")>(
    "./native-livekit.js",
  );
  vi.mocked(readLiveKitSettings).mockImplementation(actual.readLiveKitSettings);
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const bin = path.join(f.home, "voice", "bin");
  const livekit = path.join(bin, "livekit-server");
  vi.mocked(resolveNativeVoiceToolsPlan).mockResolvedValue({
    bin,
    livekit,
    prepared: false,
    damaged: false,
  });
  vi.mocked(prepareNativeVoiceTools).mockResolvedValue({ bin, livekit });

  const originalArgv1 = process.argv[1];
  process.argv[1] = "/opt/linger/dist/installer.js";
  try {
    const result = await installNativeSource({
      home: f.home,
      repo: f.repo,
      name: "native-voice-no-argv-sniff",
      setupChoice: "pi",
      externalComputer: true,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(result.code, result.message).toBe(0);
    expect(prepareNativeVoiceTools).toHaveBeenCalledTimes(1);
    expect(startNativeLiveKit).toHaveBeenCalledTimes(1);
  } finally {
    if (originalArgv1 === undefined) process.argv.splice(1, 1);
    else process.argv[1] = originalArgv1;
  }
});

test("fresh install overlaps migrate, services, and account with pending runtime while holding succeeded until both finish", async () => {
  const f = await fixture();
  let resolveRuntime!: (outcome: InstallOutcome) => void;
  vi.mocked(prepareRuntime).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveRuntime = resolve;
      }),
  );
  const baseRun = vi.mocked(runProcess).getMockImplementation()!;
  let resolveOwner!: () => void;
  const ownerCalled = new Promise<void>((resolve) => {
    resolveOwner = resolve;
  });
  vi.mocked(runProcess).mockImplementation(async (command, args, options) => {
    const result = await baseRun(command, args, options);
    if (args.includes("owner")) resolveOwner();
    return result;
  });
  const events: InstallerEvent[] = [];
  const runPromise = installNativeSource({
    ...f,
    name: "native-flow-overlap",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  // migrate, services, and account owner provisioning complete while runtime is still pending.
  await ownerCalled;
  expect(
    events.some(
      (event) =>
        event.kind === "stage" &&
        (event.stage === "services" || event.stage === "account") &&
        event.state === "succeeded",
    ),
  ).toBe(false);
  resolveRuntime({ code: 0, state: "ready", message: "ready" });
  const outcome = await runPromise;
  expect(outcome.code).toBe(0);
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "stage",
      stage: "services",
      state: "succeeded",
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "stage",
      stage: "account",
      state: "succeeded",
    }),
  );
});

test("upgrade keeps migrate sequential after runtime when account is already provisioned", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const firstOutcome = await installNativeSource({
    ...f,
    name: "native-flow-upgrade",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(firstOutcome.code).toBe(0);

  let runtimeResolved = false;
  let resolveRuntime!: (outcome: InstallOutcome) => void;
  vi.mocked(prepareRuntime).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveRuntime = (outcome) => {
          runtimeResolved = true;
          resolve(outcome);
        };
      }),
  );
  const baseRun = vi.mocked(runProcess).getMockImplementation()!;
  let migrateSawRuntimeResolved = false;
  let resolveMigrateReached!: () => void;
  const migrateReached = new Promise<void>((resolve) => {
    resolveMigrateReached = resolve;
  });
  vi.mocked(runProcess).mockImplementation(async (command, args, options) => {
    if (args.includes("migrate")) {
      migrateSawRuntimeResolved = runtimeResolved;
      resolveMigrateReached();
    }
    return baseRun(command, args, options);
  });
  const runPromise = installNativeSource({
    ...f,
    name: "native-flow-upgrade",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  await vi.waitFor(() => expect(resolveRuntime).toBeTypeOf("function"));
  await new Promise((resolve) => setTimeout(resolve, 25));
  resolveRuntime({ code: 0, state: "ready", message: "ready" });
  await migrateReached;
  const outcome = await runPromise;
  expect(outcome.code).toBe(0);
  expect(migrateSawRuntimeResolved).toBe(true);
});

test("mid-flight migrate failure aborts runtime and drains both branches before rollback", async () => {
  const f = await fixture();
  let runtimeAborted = false;
  let runtimeSettled = false;
  vi.mocked(prepareRuntime).mockImplementation(
    (_choice, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          runtimeAborted = true;
          setTimeout(() => {
            runtimeSettled = true;
            reject(new Error("aborted"));
          }, 15);
        });
      }),
  );
  let settledBeforeStop = false;
  vi.mocked(stopNativeProcess).mockImplementation(async () => {
    settledBeforeStop = runtimeSettled;
  });
  const baseRun = vi.mocked(runProcess).getMockImplementation()!;
  vi.mocked(runProcess).mockImplementation(async (command, args, options) => {
    if (args.includes("migrate")) return { code: 1, stdout: "", stderr: "" };
    return baseRun(command, args, options);
  });
  const failed = await installNativeSource({
    ...f,
    name: "native-flow-fail-drain",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(failed).toMatchObject({ code: 1, state: "failed" });
  expect(failed.message).toContain("Native source migrate failed (exit 1).");
  expect(runtimeAborted).toBe(true);
  expect(settledBeforeStop).toBe(true);
});

test("fresh-install overlap preserves RUNTIME_AUTH_REQUIRED without aborting services", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 4,
    state: "action_required",
    message: "auth required",
    details: {
      code: "RUNTIME_AUTH_REQUIRED",
      runtime: "pi",
      executable: "/pi",
      loginCommand: "pi login",
    },
  });
  const events: InstallerEvent[] = [];
  const authOutcome = await installNativeSource({
    ...f,
    name: "native-flow-auth-pending",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  expect(authOutcome.code).toBe(0);
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "stage",
      stage: "runtime",
      state: "waiting_user",
    }),
  );
});

for (const failingStep of [
  "prepareFoundationServices",
  "prepareModelGateway",
] as const)
  test(`fresh-install overlap reports runtime when ${failingStep} fails after account starts`, async () => {
    const f = await fixture();
    vi.mocked(prepareRuntime).mockResolvedValue({
      code: 0,
      state: "ready",
      message: "ready",
    });
    let resolveOwnerStarted!: () => void;
    const ownerStarted = new Promise<void>((resolve) => {
      resolveOwnerStarted = resolve;
    });
    const baseRun = vi.mocked(runProcess).getMockImplementation()!;
    vi.mocked(runProcess).mockImplementation(async (command, args, options) => {
      if (args.includes("owner")) {
        resolveOwnerStarted();
        return new Promise((_resolve, reject) => {
          const abort = () => {
            try {
              options?.signal?.throwIfAborted();
            } catch (error) {
              reject(error);
            }
          };
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener("abort", abort);
        });
      }
      return baseRun(command, args, options);
    });
    if (failingStep === "prepareFoundationServices") {
      vi.mocked(prepareFoundationServices).mockImplementation(async () => {
        await ownerStarted;
        throw new Error("foundation services failed");
      });
    } else {
      vi.mocked(prepareFoundationServices).mockImplementation(async () => {
        await ownerStarted;
      });
      vi.mocked(prepareModelGateway).mockImplementation(async () => {
        throw new Error("model gateway failed");
      });
    }
    const events: InstallerEvent[] = [];
    const failed = await installNativeSource({
      ...f,
      name:
        failingStep === "prepareFoundationServices"
          ? "native-flow-overlap-foundation"
          : "native-flow-overlap-gateway",
      setupChoice: "pi",
      externalComputer: true,
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });
    expect(failed).toMatchObject({
      code: 1,
      state: "failed",
      details: { stage: "runtime" },
    });
    expect(failed.message).toContain(
      failingStep === "prepareFoundationServices"
        ? "foundation services failed"
        : "model gateway failed",
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "stage",
        stage: "runtime",
        state: "failed",
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: "stage",
        stage: "account",
        state: "failed",
      }),
    );
    if (failingStep === "prepareModelGateway") {
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "log",
          stage: "runtime",
          message: expect.stringContaining(
            "Preparing foundation services took",
          ),
        }),
      );
    }
  });

test("fresh-install overlap reports account when account provisioning fails", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockImplementation(
    (_choice, options) =>
      new Promise((_resolve, reject) => {
        const abort = () => {
          try {
            options.signal.throwIfAborted();
          } catch (error) {
            reject(error);
          }
        };
        if (options.signal.aborted) abort();
        else options.signal.addEventListener("abort", abort);
      }),
  );
  const baseRun = vi.mocked(runProcess).getMockImplementation()!;
  vi.mocked(runProcess).mockImplementation(async (command, args, options) => {
    if (args.includes("owner")) return { code: 1, stdout: "", stderr: "" };
    return baseRun(command, args, options);
  });
  const events: InstallerEvent[] = [];
  const failed = await installNativeSource({
    ...f,
    name: "native-flow-overlap-account-fail",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  expect(failed).toMatchObject({
    code: 1,
    state: "failed",
    details: { stage: "account" },
  });
  expect(failed.message).toContain(
    "Local account sign-in failed after creation (HTTP 401).",
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "stage",
      stage: "account",
      state: "failed",
    }),
  );
});

test("cold resume skips pre-inspection env probe, reuses installed runtime, forwards descriptors, and overlaps services", async () => {
  const f = await fixture();
  // First install provisions the instance and saved account.
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const initial = await installNativeSource({
    ...f,
    name: "native-flow-cold-resume",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(initial.code).toBe(0);
  const saved = await loadInstance({
    name: "native-flow-cold-resume",
    home: f.home,
  });
  await stopNativeSource(saved!, new AbortController().signal);

  vi.mocked(managedRuntimeEnvironment).mockClear();
  let releaseRuntime!: () => void;
  let migrateStartedBeforeRuntimeDone = false;
  let runtimeDone = false;
  const descriptor: RuntimeDescriptor = {
    runtime: "pi",
    executable: "/mock/pi",
    argvPrefix: [],
    installed: true,
    authenticated: true,
    authMode: "api_key",
    loginCommand: null,
  };
  vi.mocked(prepareRuntime).mockImplementationOnce(async (_choice, options) => {
    expect(options.reuseInstalled).toBe(true);
    expect(options.env).toBeUndefined();
    await new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    runtimeDone = true;
    options.onDescriptor?.(descriptor);
    return { code: 0, state: "ready", message: "ready" };
  });
  const baseRun = vi.mocked(runProcess).getMockImplementation()!;
  vi.mocked(runProcess).mockImplementation(async (command, args, options) => {
    if (args.includes("migrate")) {
      migrateStartedBeforeRuntimeDone = !runtimeDone;
      releaseRuntime();
    }
    return baseRun(command, args, options);
  });

  const forwarded: RuntimeDescriptor[][] = [];
  const resumed = await installNativeSource({
    ...f,
    name: "native-flow-cold-resume",
    externalComputer: true,
    resume: true,
    onRuntimeDescriptors: (descriptors) => forwarded.push(descriptors),
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(resumed.code).toBe(0);
  expect(vi.mocked(managedRuntimeEnvironment)).not.toHaveBeenCalled();
  expect(migrateStartedBeforeRuntimeDone).toBe(true);
  expect(forwarded).toEqual([[descriptor]]);
});

test("resume stays sequential when services are already running", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const initial = await installNativeSource({
    ...f,
    name: "native-flow-resume-seq",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(initial.code).toBe(0);

  // Services from the initial install are still running, so resume stays sequential.
  let runtimeDone = false;
  let migrateSawRuntimeDone = false;
  vi.mocked(prepareRuntime).mockImplementationOnce(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    runtimeDone = true;
    return { code: 0, state: "ready", message: "ready" };
  });
  const baseRun = vi.mocked(runProcess).getMockImplementation()!;
  vi.mocked(runProcess).mockImplementation(async (command, args, options) => {
    if (args.includes("migrate")) {
      migrateSawRuntimeDone = runtimeDone;
    }
    return baseRun(command, args, options);
  });

  const resumed = await installNativeSource({
    ...f,
    name: "native-flow-resume-seq",
    externalComputer: true,
    resume: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(resumed.code).toBe(0);
  expect(migrateSawRuntimeDone).toBe(true);
});

test("overlap runtime failure returns the runtime outcome and stops started services in reverse order", async () => {
  const f = await fixture();
  let failRuntime!: () => void;
  vi.mocked(prepareRuntime).mockImplementation(
    () =>
      new Promise((resolve) => {
        failRuntime = () =>
          resolve({ code: 1, state: "failed", message: "runtime failed" });
      }),
  );
  const baseStart = vi.mocked(startNativeProcess).getMockImplementation()!;
  const started: string[] = [];
  vi.mocked(startNativeProcess).mockImplementation(async (options) => {
    started.push(options.name);
    return baseStart(options);
  });
  const stopped: string[] = [];
  vi.mocked(stopNativeProcess).mockImplementation(async (_root, name) => {
    stopped.push(name);
  });
  const baseRun = vi.mocked(runProcess).getMockImplementation()!;
  vi.mocked(runProcess).mockImplementation(async (command, args, options) => {
    if (args.includes("owner")) failRuntime();
    return baseRun(command, args, options);
  });
  const events: InstallerEvent[] = [];
  const failed = await installNativeSource({
    ...f,
    name: "native-flow-overlap-runtime-fail",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  // The Runtime's own outcome is the cause, not the aborted services branch.
  expect(failed).toMatchObject({
    code: 1,
    state: "failed",
    message: "runtime failed",
  });
  expect(events).not.toContainEqual(
    expect.objectContaining({ stage: "account", state: "failed" }),
  );
  expect(started.length).toBeGreaterThan(0);
  // PostgreSQL starts first through its own path, so it stops last.
  expect(stopped).toEqual([...started].reverse().concat("postgres"));
});

test("a service start that fails at once waits for the other starts before rollback", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const baseStart = vi.mocked(startNativeProcess).getMockImplementation()!;
  const settled = new Set<string>();
  vi.mocked(startNativeProcess).mockImplementation(async (options) => {
    if (options.name === "teamhub")
      throw new Error("teamhub identity cannot be verified");
    if (options.name === "web" || options.name === "node-services") {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const result = await baseStart(options);
      settled.add(options.name);
      return result;
    }
    return baseStart(options);
  });
  const stopsBeforeSettled: string[] = [];
  const stopped: string[] = [];
  vi.mocked(stopNativeProcess).mockImplementation(async (_root, name) => {
    if (settled.size < 2) stopsBeforeSettled.push(name);
    stopped.push(name);
    f.running.delete(name);
  });
  const failed = await installNativeSource({
    ...f,
    name: "native-flow-start-settle",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(failed.code).not.toBe(0);
  expect(settled).toEqual(new Set(["web", "node-services"]));
  expect(stopsBeforeSettled).toEqual([]);
  expect(stopped).toEqual(
    expect.arrayContaining(["teamhub", "node-services", "web"]),
  );
});

for (const variant of ["resume", "setup choice"] as const)
  test(`a ${variant} onto another checkout keeps migrate after the runtime`, async () => {
    const f = await fixture();
    const name = `native-flow-switch-${variant.replace(" ", "-")}`;
    vi.mocked(prepareRuntime).mockResolvedValue({
      code: 0,
      state: "ready",
      message: "ready",
    });
    const initial = await installNativeSource({
      ...f,
      name,
      setupChoice: "pi",
      externalComputer: true,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(initial.code).toBe(0);
    const saved = await loadInstance({ name, home: f.home });
    await stopNativeSource(saved!, new AbortController().signal);
    // Without a provisioned account a setup choice would overlap too, so
    // only the checkout switch keeps it sequential.
    if (variant === "setup choice")
      await rm(path.join(saved!.root, "local-account.json"));
    const next = path.join(f.home, "next");
    await cp(f.repo, next, { recursive: true });

    let runtimeDone = false;
    let releaseRuntime!: () => void;
    vi.mocked(prepareRuntime).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseRuntime = resolve;
      });
      runtimeDone = true;
      return { code: 0, state: "ready", message: "ready" };
    });
    const baseRun = vi.mocked(runProcess).getMockImplementation()!;
    let migrateSawRuntimeDone: boolean | undefined;
    vi.mocked(runProcess).mockImplementation(async (command, args, options) => {
      if (args.includes("migrate")) migrateSawRuntimeDone = runtimeDone;
      return baseRun(command, args, options);
    });
    const runPromise = installNativeSource({
      ...f,
      repo: next,
      name,
      externalComputer: true,
      ...(variant === "resume" ? { resume: true } : { setupChoice: "pi" }),
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    await vi.waitFor(() => expect(releaseRuntime).toBeTypeOf("function"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(migrateSawRuntimeDone).toBeUndefined();
    releaseRuntime();
    expect((await runPromise).code).toBe(0);
    expect(migrateSawRuntimeDone).toBe(true);
  });

test("checkout switch orders runtime, migrate, and LiveKit, then runs local stack in parallel with services and defers source binding", async () => {
  const f = await fixture();
  const name = "native-flow-switch-parallel";
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const initial = await installNativeSource({
    ...f,
    name,
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(initial.code).toBe(0);
  const saved = await loadInstance({ name, home: f.home });
  const repoA = saved!.releaseDir;
  await stopNativeSource(saved!, new AbortController().signal);

  const next = path.join(f.home, "next");
  await cp(f.repo, next, { recursive: true });
  const repoB = await realpath(next);

  const actualLiveKit = await vi.importActual<
    typeof import("./native-livekit.js")
  >("./native-livekit.js");
  vi.mocked(readLiveKitSettings).mockImplementation(
    actualLiveKit.readLiveKitSettings,
  );
  vi.mocked(prepareNativeVoiceTools).mockResolvedValue({
    bin: path.join(f.home, "voice"),
    livekit: path.join(f.home, "voice", "livekit-server"),
  });

  const order: string[] = [];
  let runtimeDone = false;
  let liveKitBound = false;
  vi.mocked(prepareRuntime).mockImplementationOnce(async () => {
    runtimeDone = true;
    order.push("runtime");
    return { code: 0, state: "ready", message: "ready" };
  });

  const baseRun = vi.mocked(runProcess).getMockImplementation()!;
  vi.mocked(runProcess).mockImplementation(async (command, args, options) => {
    if (args.includes("migrate")) {
      expect(runtimeDone).toBe(true);
      order.push("migrate");
    }
    return baseRun(command, args, options);
  });

  vi.mocked(startNativeLiveKit).mockClear();
  vi.mocked(startNativeLiveKit).mockImplementationOnce(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    f.running.add("livekit");
    liveKitBound = true;
    order.push("livekit");
  });

  vi.mocked(prepareFoundationServices).mockImplementationOnce(async () => {
    expect(liveKitBound).toBe(true);
    order.push("foundation");
  });

  // Bidirectional barrier proves prepareModelGateway and startNativeProcess
  // run concurrently: sequential execution in either order would deadlock.
  let markGatewayEntered!: () => void;
  const gatewayEntered = new Promise<void>((resolve) => {
    markGatewayEntered = resolve;
  });
  let markServiceStartEntered!: () => void;
  const serviceStartEntered = new Promise<void>((resolve) => {
    markServiceStartEntered = resolve;
  });
  let releaseGateway!: () => void;
  const gatewayReleased = new Promise<void>((resolve) => {
    releaseGateway = resolve;
  });

  vi.mocked(prepareModelGateway).mockImplementationOnce(async () => {
    markGatewayEntered();
    await serviceStartEntered;
    await gatewayReleased;
  });

  const baseStart = vi.mocked(startNativeProcess).getMockImplementation()!;
  vi.mocked(startNativeProcess).mockImplementation(async (options) => {
    markServiceStartEntered();
    await gatewayEntered;
    return baseStart(options);
  });

  let clock = 0;
  let loginCalled = false;
  let markWaitingForBranch1!: () => void;
  const waitingForBranch1 = new Promise<void>((resolve) => {
    markWaitingForBranch1 = resolve;
  });
  const baseFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init?: RequestInit) => {
      const response = await baseFetch(url, init);
      if (String(url).endsWith("/v0/auth/login")) loginCalled = true;
      return response;
    }),
  );

  const events: InstallerEvent[] = [];
  const runPromise = installNativeSource(
    {
      ...f,
      repo: next,
      name,
      externalComputer: true,
      resume: true,
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    },
    () => {
      // After /v0/auth/login finishes, the next stageTimer read is
      // timer.enter("runtime") once branch2 has settled while branch1 is open.
      if (loginCalled) markWaitingForBranch1();
      return clock;
    },
  );

  await waitingForBranch1;
  // Branch 2 finished service startup and account verification while Branch 1
  // is still pending: source binding and succeeded events must stay deferred.
  expect((await loadInstance({ name, home: f.home }))?.releaseDir).toBe(repoA);
  expect(
    events.some(
      (event) =>
        event.kind === "stage" &&
        (event.stage === "services" || event.stage === "account") &&
        event.state === "succeeded",
    ),
  ).toBe(false);

  clock += 3000;
  releaseGateway();
  const outcome = await runPromise;

  expect(outcome.code, outcome.message).toBe(0);
  expect(startNativeLiveKit).toHaveBeenCalledTimes(1);
  expect(order).toEqual(["runtime", "migrate", "livekit", "foundation"]);
  expect((await loadInstance({ name, home: f.home }))?.releaseDir).toBe(repoB);
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "stage",
      stage: "services",
      state: "succeeded",
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "stage",
      stage: "account",
      state: "succeeded",
    }),
  );
  expect(
    (outcome.details as { timings: Record<string, number> }).timings.runtime,
  ).toBe(3);
});

for (const failureKind of ["throw", "outcome"] as const)
  test(`checkout switch skips migrate, local stack, and service start when runtime fails by ${failureKind}`, async () => {
    const f = await fixture();
    const name = `native-flow-switch-runtime-${failureKind}`;
    vi.mocked(prepareRuntime).mockResolvedValue({
      code: 0,
      state: "ready",
      message: "ready",
    });
    const initial = await installNativeSource({
      ...f,
      name,
      setupChoice: "pi",
      externalComputer: true,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(initial.code).toBe(0);
    const saved = await loadInstance({ name, home: f.home });
    const repoA = saved!.releaseDir;
    await stopNativeSource(saved!, new AbortController().signal);

    const next = path.join(f.home, "next");
    await cp(f.repo, next, { recursive: true });

    vi.mocked(runProcess).mockClear();
    vi.mocked(prepareFoundationServices).mockClear();
    vi.mocked(prepareModelGateway).mockClear();
    vi.mocked(startNativeProcess).mockClear();

    // Hold runtime failure until PostgreSQL is ready so execution reaches the
    // !overlapWithRuntime runtime wait immediately before migrate().
    let markDatabaseReady!: () => void;
    const databaseReady = new Promise<void>((resolve) => {
      markDatabaseReady = resolve;
    });
    const baseDb = vi.mocked(prepareNativeDatabase).getMockImplementation()!;
    vi.mocked(prepareNativeDatabase).mockImplementationOnce(async (options) => {
      const result = await baseDb(options);
      markDatabaseReady();
      return result;
    });
    vi.mocked(prepareRuntime).mockImplementationOnce(async () => {
      await databaseReady;
      if (failureKind === "throw") throw new Error("runtime upgrade failed");
      return {
        code: 4,
        state: "action_required",
        message: "The runtime is not ready.",
        details: { code: "LOCAL_MODELS_RECOVERY_REQUIRED" },
      };
    });

    const outcome = await installNativeSource({
      ...f,
      repo: next,
      name,
      externalComputer: true,
      resume: true,
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    if (failureKind === "throw") {
      expect(outcome).toMatchObject({
        code: 1,
        state: "failed",
        details: { stage: "runtime" },
      });
      expect(outcome.message).toContain("runtime upgrade failed");
    } else {
      expect(outcome).toMatchObject({
        code: 4,
        state: "action_required",
        message: "The runtime is not ready.",
        details: {
          code: "LOCAL_MODELS_RECOVERY_REQUIRED",
          stage: "runtime",
        },
      });
    }
    expect(
      vi
        .mocked(runProcess)
        .mock.calls.some(([, args]) => args.includes("migrate")),
    ).toBe(false);
    expect(prepareFoundationServices).not.toHaveBeenCalled();
    expect(prepareModelGateway).not.toHaveBeenCalled();
    expect(startNativeProcess).not.toHaveBeenCalled();
    expect((await loadInstance({ name, home: f.home }))?.releaseDir).toBe(
      repoA,
    );
  });

test("checkout switch gateway failure aborts service startup, drains before rollback, and preserves earlier checkout binding", async () => {
  const f = await fixture();
  const name = "native-flow-switch-gateway-fail";
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const initial = await installNativeSource({
    ...f,
    name,
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(initial.code).toBe(0);
  const saved = await loadInstance({ name, home: f.home });
  const repoA = saved!.releaseDir;
  await stopNativeSource(saved!, new AbortController().signal);

  const next = path.join(f.home, "next");
  await cp(f.repo, next, { recursive: true });

  vi.mocked(startNativeProcess).mockClear();
  vi.mocked(stopNativeProcess).mockClear();

  let markReadyzEntered!: () => void;
  const readyzEntered = new Promise<void>((resolve) => {
    markReadyzEntered = resolve;
  });
  let branch2Aborted = false;
  let pendingReadyz = 0;
  const baseFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init?: RequestInit) => {
      if (String(url).endsWith("/readyz")) {
        pendingReadyz += 1;
        markReadyzEntered();
        return new Promise<Response>((_resolve, reject) => {
          const onAbort = () => {
            branch2Aborted = true;
            setTimeout(() => {
              pendingReadyz -= 1;
              reject(new DOMException("Aborted", "AbortError"));
            }, 15);
          };
          if (init?.signal?.aborted) onAbort();
          else init?.signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      return baseFetch(url, init);
    }),
  );

  vi.mocked(prepareModelGateway).mockImplementationOnce(async () => {
    await readyzEntered;
    throw new Error("gateway failed during upgrade");
  });

  const baseStop = vi.mocked(stopNativeProcess).getMockImplementation()!;
  let rollbackSawPendingBranch2 = false;
  const stopped: string[] = [];
  vi.mocked(stopNativeProcess).mockImplementation(async (root, service) => {
    if (pendingReadyz > 0) rollbackSawPendingBranch2 = true;
    stopped.push(service);
    await baseStop(root, service);
  });

  const outcome = await installNativeSource({
    ...f,
    repo: next,
    name,
    externalComputer: true,
    resume: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });

  expect(outcome).toMatchObject({
    code: 1,
    state: "failed",
    details: { stage: "runtime" },
  });
  expect(outcome.message).toContain("gateway failed during upgrade");
  expect(branch2Aborted).toBe(true);
  expect(pendingReadyz).toBe(0);
  expect(rollbackSawPendingBranch2).toBe(false);
  expect(stopped).toEqual(["web", "node-services", "teamhub", "postgres"]);
  expect(f.running.size).toBe(0);
  expect((await loadInstance({ name, home: f.home }))?.releaseDir).toBe(repoA);
});

for (const failingStage of ["services", "account"] as const)
  test(`checkout switch ${failingStage} failure aborts local stack branch, drains before rollback, and preserves earlier checkout binding`, async () => {
    const f = await fixture();
    const name = `native-flow-switch-${failingStage}-fail`;
    vi.mocked(prepareRuntime).mockResolvedValue({
      code: 0,
      state: "ready",
      message: "ready",
    });
    const initial = await installNativeSource({
      ...f,
      name,
      setupChoice: "pi",
      externalComputer: true,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(initial.code).toBe(0);
    const saved = await loadInstance({ name, home: f.home });
    const repoA = saved!.releaseDir;
    await stopNativeSource(saved!, new AbortController().signal);

    const next = path.join(f.home, "next");
    await cp(f.repo, next, { recursive: true });

    vi.mocked(stopNativeProcess).mockClear();

    let markBranch1Entered!: () => void;
    const branch1Entered = new Promise<void>((resolve) => {
      markBranch1Entered = resolve;
    });
    let branch1Aborted = false;
    let branch1Settled = false;
    const holdUntilAborted = (signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        markBranch1Entered();
        const onAbort = () => {
          branch1Aborted = true;
          setTimeout(() => {
            branch1Settled = true;
            reject(new DOMException("Aborted", "AbortError"));
          }, 15);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });

    if (failingStage === "services") {
      vi.mocked(prepareFoundationServices).mockImplementationOnce(
        (_instance, _choice, options) => holdUntilAborted(options.signal),
      );
      const baseStart = vi.mocked(startNativeProcess).getMockImplementation()!;
      vi.mocked(startNativeProcess).mockImplementation(async (options) => {
        if (options.name === "teamhub") {
          await branch1Entered;
          throw new Error("teamhub failed on upgrade");
        }
        return baseStart(options);
      });
    } else {
      vi.mocked(prepareModelGateway).mockImplementationOnce(
        (_instance, _choice, options) => holdUntilAborted(options.signal),
      );
      const baseFetch = vi.mocked(fetch).getMockImplementation()!;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url, init?: RequestInit) => {
          if (String(url).endsWith("/v0/auth/login")) {
            await branch1Entered;
            return new Response("{}", { status: 401 });
          }
          return baseFetch(url, init);
        }),
      );
      const baseRun = vi.mocked(runProcess).getMockImplementation()!;
      vi.mocked(runProcess).mockImplementation(
        async (command, args, options) => {
          if (args.includes("owner"))
            return { code: 1, stdout: "", stderr: "" };
          return baseRun(command, args, options);
        },
      );
    }

    const baseStop = vi.mocked(stopNativeProcess).getMockImplementation()!;
    let settledBeforeRollback = true;
    vi.mocked(stopNativeProcess).mockImplementation(async (root, service) => {
      if (!branch1Settled) settledBeforeRollback = false;
      await baseStop(root, service);
    });

    const outcome = await installNativeSource({
      ...f,
      repo: next,
      name,
      externalComputer: true,
      resume: true,
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    expect(outcome).toMatchObject({
      code: 1,
      state: "failed",
      details: { stage: failingStage },
    });
    expect(branch1Aborted).toBe(true);
    expect(branch1Settled).toBe(true);
    expect(settledBeforeRollback).toBe(true);
    expect((await loadInstance({ name, home: f.home }))?.releaseDir).toBe(
      repoA,
    );
    expect(
      (outcome.details as { timings?: Record<string, number> }).timings,
    ).not.toHaveProperty("runtime");
  });

test("checkout switch degraded local-models resume swallows non-abort gateway failure while running in parallel", async () => {
  const f = await fixture();
  const name = "native-flow-switch-degraded-local";
  vi.mocked(prepareLocalModels).mockResolvedValueOnce(undefined);
  const initial = await installNativeSource({
    ...f,
    name,
    setupChoice: "local-models",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(initial.code).toBe(0);
  const saved = await loadInstance({ name, home: f.home });
  await stopNativeSource(saved!, new AbortController().signal);

  const next = path.join(f.home, "next");
  await cp(f.repo, next, { recursive: true });
  const repoB = await realpath(next);

  vi.mocked(prepareLocalModels).mockResolvedValueOnce({
    code: 4,
    state: "action_required",
    message: "The upstream tool could not verify the local stack binding.",
    details: {
      code: "LOCAL_MODELS_RECOVERY_REQUIRED",
      reasons: ["binding-unavailable"],
    },
  });

  let markGatewayEntered!: () => void;
  const gatewayEntered = new Promise<void>((resolve) => {
    markGatewayEntered = resolve;
  });
  let markServiceStartEntered!: () => void;
  const serviceStartEntered = new Promise<void>((resolve) => {
    markServiceStartEntered = resolve;
  });
  vi.mocked(prepareModelGateway).mockImplementationOnce(async () => {
    markGatewayEntered();
    await serviceStartEntered;
    throw new Error("local model gateway unavailable");
  });
  const baseStart = vi.mocked(startNativeProcess).getMockImplementation()!;
  vi.mocked(startNativeProcess).mockImplementation(async (options) => {
    markServiceStartEntered();
    await gatewayEntered;
    return baseStart(options);
  });

  const logs: InstallerEvent[] = [];
  const upgraded = await installNativeSource({
    ...f,
    repo: next,
    name,
    externalComputer: true,
    resume: true,
    signal: new AbortController().signal,
    onEvent: (event) => {
      if (event.kind === "log") logs.push(event);
    },
  });

  expect(upgraded).toMatchObject({
    code: 0,
    state: "ready",
    details: {
      localModelsDegraded: {
        code: "LOCAL_MODELS_RECOVERY_REQUIRED",
        message: "The upstream tool could not verify the local stack binding.",
        reasons: ["binding-unavailable"],
      },
    },
  });
  expect((await loadInstance({ name, home: f.home }))?.releaseDir).toBe(repoB);
  expect(logs).toContainEqual(
    expect.objectContaining({
      kind: "log",
      stage: "runtime",
      message: expect.stringContaining(
        "Local model gateway preparation skipped during degraded resume: local model gateway unavailable",
      ),
    }),
  );
  expect(logs.map((event) => event.message).join("")).toContain(
    "Linger is starting without local models",
  );
});

test("a repeated resume after a successful resume succeeds without provisioning the owner again", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const input = {
    ...f,
    name: "native-flow-resume-twice",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  };
  expect(
    (await installNativeSource({ ...input, setupChoice: "pi" })).code,
  ).toBe(0);
  const saved = await loadInstance({ name: input.name, home: f.home });
  await stopNativeSource(saved!, new AbortController().signal);
  const owners = () =>
    vi.mocked(runProcess).mock.calls.filter((row) => row[1].includes("owner"))
      .length;
  expect((await installNativeSource({ ...input, resume: true })).code).toBe(0);
  const afterFirstResume = owners();
  expect((await installNativeSource({ ...input, resume: true })).code).toBe(0);
  expect(owners()).toBe(afterFirstResume);
});

test("a cold resume degrades gracefully instead of blocking when local models cannot be verified", async () => {
  const f = await fixture();
  const name = "native-flow-local-models-degraded-resume";
  vi.mocked(prepareLocalModels).mockResolvedValueOnce(undefined);
  const installed = await installNativeSource({
    ...f,
    name,
    setupChoice: "local-models",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(installed.code).toBe(0);
  const saved = await loadInstance({ name, home: f.home });
  await stopNativeSource(saved!, new AbortController().signal);

  vi.mocked(prepareLocalModels).mockResolvedValueOnce({
    code: 4,
    state: "action_required",
    message: "The upstream tool could not verify the local stack binding.",
    details: {
      code: "LOCAL_MODELS_RECOVERY_REQUIRED",
      reasons: ["binding-unavailable"],
    },
  });
  vi.mocked(prepareModelGateway).mockRejectedValueOnce(
    new Error("local model gateway unavailable"),
  );
  const logs: string[] = [];
  const resumed = await installNativeSource({
    ...f,
    name,
    externalComputer: true,
    resume: true,
    signal: new AbortController().signal,
    onEvent: (event) => {
      if (event.kind === "log") logs.push(event.message);
    },
  });
  expect(resumed).toMatchObject({
    code: 0,
    state: "ready",
    details: {
      localModelsDegraded: {
        code: "LOCAL_MODELS_RECOVERY_REQUIRED",
        message: "The upstream tool could not verify the local stack binding.",
        reasons: ["binding-unavailable"],
      },
    },
  });
  expect(logs.join("")).toContain("Linger is starting without local models");
});

test("an app update degrades a local model stack an earlier release stopped instead of failing the start", async () => {
  // A 0.1.6 home that was quit before the update: its deployment is marked
  // removed in the shared tools directory, so the saved plan cannot come back
  // and the new kit reports it changed.
  const f = await fixture();
  const name = "native-flow-local-models-degraded-update";
  vi.mocked(prepareLocalModels).mockResolvedValueOnce(undefined);
  const installed = await installNativeSource({
    ...f,
    name,
    setupChoice: "local-models",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(installed.code).toBe(0);
  const saved = await loadInstance({ name, home: f.home });
  await stopNativeSource(saved!, new AbortController().signal);

  const changed = {
    code: 4,
    state: "action_required" as const,
    message:
      "This computer's state or local model runtime changed since the plan was approved (llm, harness).",
    details: {
      code: "LOCAL_MODELS_RECOVERY_REQUIRED",
      causeCode: "STACK_PLAN_CHANGED",
      reasons: ["deployment-unavailable"],
    },
  };
  vi.mocked(prepareLocalModels).mockResolvedValueOnce(changed);
  vi.mocked(prepareModelGateway).mockRejectedValueOnce(
    new Error("local model gateway unavailable"),
  );
  const updated = await installNativeSource({
    ...f,
    name,
    externalComputer: true,
    degradeLocalModels: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(updated).toMatchObject({
    code: 0,
    state: "ready",
    details: {
      localModelsDegraded: {
        code: "LOCAL_MODELS_RECOVERY_REQUIRED",
        reasons: ["deployment-unavailable"],
      },
    },
  });

  // Choosing local models again in setup still fails on the same refusal.
  vi.mocked(prepareLocalModels).mockResolvedValueOnce(changed);
  const chosen = await installNativeSource({
    ...f,
    name,
    setupChoice: "local-models",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(chosen.code).toBe(4);
});

test("a cold resume degrades gracefully when local model preparation throws", async () => {
  const f = await fixture();
  const name = "native-flow-local-models-throw-resume";
  vi.mocked(prepareLocalModels).mockResolvedValueOnce(undefined);
  const installed = await installNativeSource({
    ...f,
    name,
    setupChoice: "local-models",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(installed.code).toBe(0);
  const saved = await loadInstance({ name, home: f.home });
  await stopNativeSource(saved!, new AbortController().signal);

  vi.mocked(prepareLocalModels).mockRejectedValueOnce(
    new Error("Invalid upstream local model binding."),
  );
  vi.mocked(prepareModelGateway).mockRejectedValueOnce(
    new Error("local model gateway unavailable"),
  );
  const resumed = await installNativeSource({
    ...f,
    name,
    externalComputer: true,
    resume: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(resumed).toMatchObject({
    code: 0,
    state: "ready",
    details: {
      localModelsDegraded: {
        code: "LOCAL_MODELS_RECOVERY_REQUIRED",
        message: "Invalid upstream local model binding.",
      },
    },
  });
});

test("the system proxy reaches only TeamHub and node-services, and restarts them when it changes", async () => {
  const f = await fixture();
  vi.stubEnv("HTTPS_PROXY", undefined);
  vi.stubEnv("https_proxy", undefined);
  vi.stubEnv("NO_PROXY", undefined);
  vi.stubEnv("no_proxy", undefined);
  const install = async () => {
    vi.mocked(startNativeProcess).mockClear();
    vi.mocked(runProcess).mockClear();
    const result = await installNativeSource({
      home: f.home,
      repo: f.repo,
      name: "native-flow",
      setupChoice: "local-models",
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(result.code).toBe(0);
    return Object.fromEntries(
      vi
        .mocked(startNativeProcess)
        .mock.calls.map(([options]) => [options.name, options]),
    );
  };
  try {
    const direct = await install();
    // Without a system proxy the settings are what they were before it.
    expect(Object.keys(JSON.parse(direct.teamhub!.settings!))).toEqual([
      "env",
      "voice",
      "identity",
    ]);
    expect(JSON.parse(direct["node-services"]!.settings!)).toEqual(
      JSON.parse(direct.web!.settings!),
    );
    for (const options of Object.values(direct))
      expect(options.env.HTTPS_PROXY).toBeUndefined();

    vi.stubEnv("LINGER_SYSTEM_HTTPS_PROXY", "http://127.0.0.1:7890");
    const proxied = await install();
    for (const name of ["teamhub", "node-services"]) {
      expect(proxied[name]!.env).toMatchObject({
        HTTPS_PROXY: "http://127.0.0.1:7890",
        NO_PROXY: "localhost,127.0.0.1,::1",
      });
      expect(JSON.parse(proxied[name]!.settings!).proxy).toBe(
        "http://127.0.0.1:7890",
      );
      expect(proxied[name]!.settings).not.toBe(direct[name]!.settings);
    }
    expect(proxied.web!.env.HTTPS_PROXY).toBeUndefined();
    expect(proxied.web!.settings).toBe(direct.web!.settings);
    // The installer's own commands (pnpm, migrations) connect as before.
    for (const [, , options] of vi.mocked(runProcess).mock.calls)
      expect(options?.env?.HTTPS_PROXY).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
  }
});

test("logs per-service readiness timings, summary, and region resolution metadata during startup", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ok",
  });
  let probeRound = 0;
  const baseFetch = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/healthz") || target.endsWith("/readyz")) {
        // Probe endpoints are called in groups of 4 per round:
        // web (/healthz), teamhub (/healthz), node-services (/readyz), document-runtime (/readyz).
        const round = Math.floor(probeRound / 4);
        probeRound += 1;
        // Round 0: only web & teamhub ready; Round 1: all 4 ready.
        if (round === 0 && target.endsWith("/readyz"))
          return new Response("not ready", { status: 503 });
        return new Response("ok", { status: 200 });
      }
      return baseFetch(url, init);
    }),
  );
  const logs: InstallerEvent[] = [];
  const result = await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-readiness-timings",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: (event) => {
      if (event.kind === "log") logs.push(event);
    },
  });
  expect(result.code).toBe(0);
  const messages = logs.map((event) => event.message);
  expect(
    messages.some((message) =>
      /^Download region: global \(cache, \d+ms\)\.\n$/.test(message),
    ),
  ).toBe(true);
  const serviceReadyLines = logs.filter(
    (event) =>
      event.stage === "services" &&
      /^Native service \S+ ready in [\d.]+s\.\n$/.test(event.message),
  );
  // Each service is logged exactly once even when probed across multiple rounds.
  expect(serviceReadyLines).toHaveLength(4);
  for (const service of ["web", "teamhub", "node-services", "document-runtime"])
    expect(
      serviceReadyLines.some((event) =>
        event.message.startsWith(`Native service ${service} ready in `),
      ),
    ).toBe(true);
  expect(logs).toContainEqual({
    kind: "log",
    stage: "services",
    message: expect.stringMatching(
      /^Native collaboration services ready \(s\): web [\d.]+, teamhub [\d.]+, node-services [\d.]+, document-runtime [\d.]+\.\n$/,
    ),
  });
});

test("logs per-step stop timings and a summary even on partial stop failure", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ok",
  });
  const installed = await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-stop-timings",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(installed.code).toBe(0);
  const saved = await loadInstance({
    name: "native-stop-timings",
    home: f.home,
  });

  const okLogs: string[] = [];
  await stopNativeSource(saved!, new AbortController().signal, {
    log: (message) => okLogs.push(message),
  });
  expect(okLogs).toEqual([
    expect.stringMatching(/^Stopped native computer in [\d.]+s\.$/),
    expect.stringMatching(/^Stopped native web in [\d.]+s\.$/),
    expect.stringMatching(/^Stopped native node-services in [\d.]+s\.$/),
    expect.stringMatching(/^Stopped native teamhub in [\d.]+s\.$/),
    expect.stringMatching(/^Stopped native livekit in [\d.]+s\.$/),
    expect.stringMatching(/^Stopped native postgres in [\d.]+s\.$/),
    expect.stringMatching(/^Stopped native orphans in [\d.]+s\.$/),
    expect.stringMatching(/^Stopped native model gateway in [\d.]+s\.$/),
    expect.stringMatching(
      /^Native stop timings \(s\): computer [\d.]+, web [\d.]+, node-services [\d.]+, teamhub [\d.]+, livekit [\d.]+, postgres [\d.]+, orphans [\d.]+, gateway [\d.]+\.$/,
    ),
  ]);

  vi.mocked(stopNativeProcess).mockImplementation(async (_root, name) => {
    if (name === "teamhub") throw new Error("teamhub stuck");
  });
  const failLogs: string[] = [];
  await expect(
    stopNativeSource(saved!, new AbortController().signal, {
      log: (message) => failLogs.push(message),
    }),
  ).rejects.toThrow("teamhub stuck");
  expect(failLogs).toContainEqual(
    expect.stringMatching(/^Stopping native teamhub failed after [\d.]+s\.$/),
  );
  expect(failLogs.at(-1)).toMatch(
    /^Native stop timings \(s\): computer [\d.]+, web [\d.]+, node-services [\d.]+, teamhub [\d.]+\.$/,
  );
});

async function makeMinimalSkeletonRepo(repo: string) {
  await mkdir(path.join(repo, "apps/teamhub"), { recursive: true });
  await mkdir(path.join(repo, "scripts"), { recursive: true });
  await writeFile(path.join(repo, ".env.example"), "");
  await writeFile(
    path.join(repo, "apps/teamhub/go.mod"),
    "module example.com/teamhub\n",
  );
  await writeFile(
    path.join(repo, "scripts/env-inventory.json"),
    JSON.stringify({ variables: [] }),
  );
  await writeFile(path.join(repo, "scripts/local-defaults.env"), "");
  await writeFile(path.join(repo, "scripts/replace-process.mjs"), "");
  await writeFile(path.join(repo, "scripts/with-local-env.mjs"), "");
}

async function seedVerifiedTeamhubBinaries(repo: string) {
  const directory = path.join(repo, TEAMHUB_BINARY_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const binaries: Record<string, object> = {};
  for (const command of TEAMHUB_COMMANDS) {
    const body = `${command} binary`;
    await writeFile(path.join(directory, `${command}.exe`), body);
    binaries[command] = {
      file: `${command}.exe`,
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: body.length,
    };
  }
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      target: `${process.platform}-${process.arch}`,
      sourceCommit: "a".repeat(40),
      sourceArchiveSha256: "b".repeat(64),
      goVersion: "1.26.5",
      binaries,
    }),
  );
  return directory;
}

test("minimal 8-file release skeleton fails fast without Go or pnpm fallback when prebuilt binaries or offline services are missing or damaged", async () => {
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });

  // 0. Source skeleton classification distinguishes synthetic fixtures, minimal skeletons, and full checkouts.
  {
    const f = await fixture();
    expect(await isMinimalSourceSkeleton(f.repo)).toBe(false);
    expect(await canCompileTeamhubFromSource(f.repo)).toBe(true);
    expect(await canBuildNativeServicesFromSource(f.repo)).toBe(true);

    await makeMinimalSkeletonRepo(f.repo);
    expect(await isMinimalSourceSkeleton(f.repo)).toBe(true);
    expect(await canCompileTeamhubFromSource(f.repo)).toBe(false);
    expect(await canBuildNativeServicesFromSource(f.repo)).toBe(false);

    await mkdir(path.join(f.repo, "apps/teamhub/cmd"), { recursive: true });
    await mkdir(path.join(f.repo, "apps/node-services"), { recursive: true });
    await mkdir(path.join(f.repo, "apps/web"), { recursive: true });
    await writeFile(path.join(f.repo, "pnpm-lock.yaml"), "");
    await writeFile(path.join(f.repo, "apps/node-services/package.json"), "{}");
    await writeFile(path.join(f.repo, "apps/web/package.json"), "{}");
    expect(await isMinimalSourceSkeleton(f.repo)).toBe(false);
    expect(await canCompileTeamhubFromSource(f.repo)).toBe(true);
    expect(await canBuildNativeServicesFromSource(f.repo)).toBe(true);
  }

  // 1. Missing TeamHub binaries on minimal skeleton.
  {
    const f = await fixture();
    await makeMinimalSkeletonRepo(f.repo);
    const logs: string[] = [];
    const outcome = await installNativeSource({
      ...f,
      name: "skeleton-missing-teamhub",
      setupChoice: "pi",
      externalComputer: true,
      signal: new AbortController().signal,
      onEvent: (event) => logs.push(event.message),
    });
    expect(outcome.code).toBe(1);
    expect(outcome.message).toContain(
      "The bundled TeamHub binaries are missing and this release does not include Go source files to compile them.",
    );
    expect(logs).not.toContain(
      "The bundled TeamHub binaries do not verify; compiling TeamHub instead.\n",
    );
    expect(prepareNativeDependencies).not.toHaveBeenCalled();
  }

  // 2. Damaged TeamHub binaries on minimal skeleton.
  {
    const f = await fixture();
    await makeMinimalSkeletonRepo(f.repo);
    const binDir = await seedVerifiedTeamhubBinaries(f.repo);
    await writeFile(path.join(binDir, "migrate.exe"), "corrupted");
    const logs: string[] = [];
    const outcome = await installNativeSource({
      ...f,
      name: "skeleton-damaged-teamhub",
      setupChoice: "pi",
      externalComputer: true,
      signal: new AbortController().signal,
      onEvent: (event) => logs.push(event.message),
    });
    expect(outcome.code).toBe(1);
    expect(outcome.message).toContain(
      "The bundled TeamHub binaries are damaged and could not be verified. Reinstall Linger to restore them.",
    );
    expect(logs).not.toContain(
      "The bundled TeamHub binaries do not verify; compiling TeamHub instead.\n",
    );
    expect(prepareNativeDependencies).not.toHaveBeenCalled();
  }

  // 3. Missing offline runtime on minimal skeleton.
  {
    const f = await fixture();
    await makeMinimalSkeletonRepo(f.repo);
    await seedVerifiedTeamhubBinaries(f.repo);
    const logs: string[] = [];
    const outcome = await installNativeSource({
      ...f,
      name: "skeleton-missing-runtime",
      setupChoice: "pi",
      externalComputer: true,
      signal: new AbortController().signal,
      onEvent: (event) => logs.push(event.message),
    });
    expect(outcome.code).toBe(1);
    expect(outcome.message).toContain(
      "The bundled offline Linger services are unavailable",
    );
    expect(logs).not.toContain(
      "The bundled Native services do not verify; installing the checkout's packages instead.\n",
    );
    expect(prepareNativeDependencies).not.toHaveBeenCalled();
  }

  // 4. Damaged offline runtime on minimal skeleton.
  {
    const f = await fixture();
    await makeMinimalSkeletonRepo(f.repo);
    await seedVerifiedTeamhubBinaries(f.repo);
    const runtimeDir = await bundledRuntime(f.repo);
    await writeFile(path.join(runtimeDir, "web/dist/index.html"), "tampered");
    const logs: string[] = [];
    const outcome = await installNativeSource({
      ...f,
      name: "skeleton-damaged-runtime",
      setupChoice: "pi",
      externalComputer: true,
      signal: new AbortController().signal,
      onEvent: (event) => logs.push(event.message),
    });
    expect(outcome.code).toBe(1);
    expect(outcome.message).toContain(
      "The bundled offline Linger services are damaged and could not be verified. Reinstall Linger to restore them.",
    );
    expect(logs).not.toContain(
      "The bundled Native services do not verify; installing the checkout's packages instead.\n",
    );
    expect(prepareNativeDependencies).not.toHaveBeenCalled();
  }
});
