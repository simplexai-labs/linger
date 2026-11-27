import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  atomicPrivate,
  composeProject,
  instanceRoot,
  privateDirectory,
} from "@linger/local-installation/instance";
import { describe, expect, it, vi } from "vitest";

import { NODE_RUNTIME_VERSION } from "../../../../scripts/local-computer-node-distributions.mjs";
import { ConfigStore } from "./config.js";
import { CredentialStore } from "./computer-credential.js";
import { EnrollmentModule } from "./enrollment.js";
import {
  isManagedLocalServerConfig,
  LocalServerModule,
  LocalServerUnverifiedError,
  type LocalServerIdentity,
} from "./local-server.js";
import { EventBus, ModuleHost } from "./modules.js";
import {
  fixtureNode,
  stubModule,
  tempDirectory,
  waitForInstaller,
} from "./test-support.js";

// These tests run the installer stub in real subprocesses.
if (process.platform === "win32") vi.setConfig({ testTimeout: 20_000 });

async function writeDesktopInstance(home: string, port: number): Promise<void> {
  const root = instanceRoot({ name: "desktop", home });
  await privateDirectory(root);
  await atomicPrivate(
    path.join(root, "instance.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "desktop",
      mode: "source-native",
      root,
      project: composeProject(root, "desktop"),
      origin: `http://localhost:${port}`,
      port,
      releaseDir: "/source",
      computerConfig: path.join(root, "computer", "config.json"),
      computerExecutable: "linger-computer",
    }) + "\n",
  );
}

function setupResumeFixture(
  installerScript: string,
  options: {
    fetch?: typeof fetch;
    serverIdentity?: (
      home: string,
      origin: string,
    ) => Promise<LocalServerIdentity>;
    proveServer?: (server: LocalServerIdentity) => Promise<void>;
    resolveProxy?: (url: string) => Promise<string>;
    watchMs?: number;
    unreachableGraceMs?: number;
    withRecord?: boolean;
    initialConfig?: Parameters<ConfigStore["update"]>[0];
  } = {},
) {
  const root = tempDirectory();
  const home = path.join(root, "home");
  const installerDirectory = path.join(root, "installer");
  mkdirSync(installerDirectory, { recursive: true });
  writeFileSync(path.join(installerDirectory, "installer.js"), installerScript);
  writeFileSync(
    path.join(installerDirectory, "package.json"),
    '{"type":"commonjs"}',
  );
  const node = path.join(home, "desktop", "node", `v${NODE_RUNTIME_VERSION}`);
  mkdirSync(path.join(node, "bin"), { recursive: true });
  fixtureNode(path.join(node, "bin", "node"));
  if (options.withRecord !== false) {
    mkdirSync(path.join(home, "desktop"), { recursive: true });
    writeFileSync(
      path.join(home, "desktop", "local-server.json"),
      JSON.stringify({
        home,
        repo: "/source",
        origin: "http://localhost:3000",
      }),
    );
  }

  const logs: Array<{
    level: string;
    event: string;
    fields?: Record<string, unknown>;
  }> = [];
  const setServer = vi.fn(() => true);
  const hide = vi.fn();
  const loadServer = vi.fn();
  const showStarting = vi.fn();
  const showUpdating = vi.fn();
  const showStartFailed = vi.fn();
  const unenroll = vi.fn(async () => {});
  const bus = new EventBus();
  const config = new ConfigStore(path.join(root, "config.json"), {
    serverUrl: "http://localhost:3000",
    computerId: "cmp_1",
    ...options.initialConfig,
  });

  const module = new LocalServerModule({
    home,
    version: "0.16.20",
    installerDirectory,
    platform: "linux",
    arch: "x64",
    pollMs: 10,
    signIn: async () => {},
    ...(options.serverIdentity
      ? { serverIdentity: options.serverIdentity }
      : {}),
    ...(options.proveServer ? { proveServer: options.proveServer } : {}),
    fetch:
      options.fetch ??
      ((async () => {
        throw new Error("offline");
      }) as typeof fetch),
    resolveProxy: options.resolveProxy,
    ...(options.watchMs ? { watchMs: options.watchMs } : {}),
    ...(options.unreachableGraceMs
      ? { unreachableGraceMs: options.unreachableGraceMs }
      : {}),
  });

  const host = new ModuleHost(
    [
      {
        ...stubModule("WindowManager"),
        setServer,
        hide,
        loadServer,
        showStarting,
        showUpdating,
        showStartFailed,
      } as never,
      {
        ...stubModule("Enrollment"),
        unenroll,
      } as never,
      module,
    ],
    {
      config,
      bus,
      log: {
        info: (event, fields) => logs.push({ level: "info", event, fields }),
        warn: (event, fields) => logs.push({ level: "warn", event, fields }),
        error: (event, fields) => logs.push({ level: "error", event, fields }),
      },
    },
  );

  return {
    home,
    installerDirectory,
    module,
    host,
    bus,
    config,
    logs,
    setServer,
    hide,
    loadServer,
    showStarting,
    showUpdating,
    showStartFailed,
  };
}

describe("LocalServerModule resume coordination", () => {
  it("passes resume_ready and emits structured stage logs", async () => {
    const f = setupResumeFixture(`
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ code: 0, details: { origin: "http://localhost:3000" } }) + "\\n");
      }, 40);
    `);

    await f.host.start();

    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    expect(f.showStarting).toHaveBeenCalledOnce();
    expect(f.setServer).toHaveBeenCalledWith(
      "http://localhost:3000",
      "http://localhost:3000",
      { reason: "resume_ready" },
    );

    const events = f.logs.map((entry) => entry.event);
    expect(events).toContain("local_server.resume_started");
    expect(events).toContain("local_server.resume_succeeded");
    const stages = f.logs
      .filter((entry) => entry.event === "local_server.resume_stage")
      .map((entry) => entry.fields?.stage);
    expect(stages).toEqual([
      "fast_ready_check",
      "ensure_node",
      "installer_resume",
    ]);

    const succeeded = f.logs.find(
      (entry) => entry.event === "local_server.resume_succeeded",
    );
    expect(typeof succeeded?.fields?.total_ms).toBe("number");
    expect(
      f.logs.find(
        (entry) => entry.event === "local_server.installer_resume_timings",
      ),
    ).toBeUndefined();
    await f.host.stop("quit");
  });

  it("logs valid warm and cold installer resumeTimings and ignores malformed shapes", async () => {
    const warm = setupResumeFixture(`
      process.stdout.write(JSON.stringify({
        code: 0,
        details: { origin: "http://localhost:3000" },
        resumeTimings: {
          path: "warm",
          probeMs: 42,
          totalMs: 185,
          restoreLocalModelsMs: 90,
          restoreByokGatewayMs: 12,
        },
      }) + "\\n");
    `);
    await warm.host.start();
    await vi.waitFor(() => expect(warm.module.status().phase).toBe("ready"));
    expect(
      warm.logs.find(
        (entry) => entry.event === "local_server.installer_resume_timings",
      ),
    ).toEqual({
      level: "info",
      event: "local_server.installer_resume_timings",
      fields: {
        instance: "desktop",
        path: "warm",
        probe_ms: 42,
        total_ms: 185,
        restore_local_models_ms: 90,
        restore_byok_gateway_ms: 12,
      },
    });
    await warm.host.stop("quit");

    const cold = setupResumeFixture(`
      process.stdout.write(JSON.stringify({
        code: 0,
        details: { origin: "http://localhost:3000" },
        resumeTimings: {
          path: "cold",
          probeMs: 15,
          coldStartMs: 2400,
          totalMs: 2450,
          restoreLocalModelsMs: -5,
        },
      }) + "\\n");
    `);
    await cold.host.start();
    await vi.waitFor(() => expect(cold.module.status().phase).toBe("ready"));
    expect(
      cold.logs.find(
        (entry) => entry.event === "local_server.installer_resume_timings",
      ),
    ).toEqual({
      level: "info",
      event: "local_server.installer_resume_timings",
      fields: {
        instance: "desktop",
        path: "cold",
        probe_ms: 15,
        total_ms: 2450,
        cold_start_ms: 2400,
      },
    });
    await cold.host.stop("quit");

    for (const invalid of [
      null,
      "warm",
      { path: "unknown", probeMs: 10, totalMs: 20 },
      { path: "warm", probeMs: -1, totalMs: 20 },
      { path: "warm", probeMs: 10 },
      { path: "cold", probeMs: 10, totalMs: "20" },
    ]) {
      const f = setupResumeFixture(`
        process.stdout.write(JSON.stringify({
          code: 0,
          details: { origin: "http://localhost:3000" },
          resumeTimings: ${JSON.stringify(invalid)},
        }) + "\\n");
      `);
      await f.host.start();
      await vi.waitFor(() => expect(f.module.status().phase).toBe("ready"));
      expect(
        f.logs.find(
          (entry) => entry.event === "local_server.installer_resume_timings",
        ),
      ).toBeUndefined();
      await f.host.stop("quit");
    }
  });

  it.each([
    ["PROXY 127.0.0.1:7890; DIRECT", "system", "http://127.0.0.1:7890"],
    ["DIRECT", "none", ""],
  ])(
    "passes the system proxy %s to the resume as LINGER_SYSTEM_HTTPS_PROXY",
    async (resolution, source, passed) => {
      vi.stubEnv("HTTPS_PROXY", undefined);
      vi.stubEnv("https_proxy", undefined);
      const resolveProxy = vi.fn(async () => resolution);
      const f = setupResumeFixture(
        `
      require("node:fs").writeFileSync(require("node:path").join(__dirname, "proxy.txt"), process.env.LINGER_SYSTEM_HTTPS_PROXY ?? "");
      process.stdout.write(JSON.stringify({ code: 0, details: { origin: "http://localhost:3000" } }) + "\\n");
    `,
        { resolveProxy },
      );
      try {
        await f.host.start();
        await waitForInstaller(() =>
          expect(f.module.status().phase).toBe("ready"),
        );
        expect(resolveProxy).toHaveBeenCalledWith(
          "wss://stt-rt.soniox.com/transcribe-websocket",
        );
        expect(
          readFileSync(path.join(f.installerDirectory, "proxy.txt"), "utf8"),
        ).toBe(passed);
        expect(
          f.logs.find((entry) => entry.event === "local_server.system_proxy")
            ?.fields?.source,
        ).toBe(source);
        await f.host.stop("quit");
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("resumes without a proxy when resolving it hangs", async () => {
    vi.stubEnv("HTTPS_PROXY", undefined);
    vi.stubEnv("https_proxy", undefined);
    const f = setupResumeFixture(
      `
      process.stdout.write(JSON.stringify({ code: 0, details: { origin: "http://localhost:3000" } }) + "\\n");
    `,
      { resolveProxy: () => new Promise<string>(() => undefined) },
    );
    try {
      await f.host.start();
      await vi.waitFor(() => expect(f.module.status().phase).toBe("ready"), {
        timeout: 5_000,
      });
      expect(
        f.logs.find((entry) => entry.event === "local_server.system_proxy")
          ?.fields?.source,
      ).toBe("unavailable");
      await f.host.stop("quit");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("logs a BYOK gateway that did not come back and still resumes", async () => {
    const f = setupResumeFixture(`
      process.stdout.write(JSON.stringify({ code: 0, details: { origin: "http://localhost:3000", byokGateway: { code: "BYOK_UNREACHABLE", message: "Endpoint did not answer." } } }) + "\\n");
    `);

    await f.host.start();

    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    expect(f.showStartFailed).not.toHaveBeenCalled();
    expect(f.module.status().localModelsDegraded).toBeUndefined();
    expect(
      f.logs.find(
        (entry) => entry.event === "local_server.byok_gateway_unavailable",
      ),
    ).toEqual({
      level: "warn",
      event: "local_server.byok_gateway_unavailable",
      fields: { code: "BYOK_UNREACHABLE", message: "Endpoint did not answer." },
    });
    await f.host.stop("quit");
  });

  it("logs degraded local models and still resumes the workspace", async () => {
    const f = setupResumeFixture(`
      process.stdout.write(JSON.stringify({ code: 0, details: { origin: "http://localhost:3000", localModelsDegraded: { code: "LOCAL_MODELS_RECOVERY_REQUIRED", message: "The upstream tool could not verify the local stack binding.", reasons: ["binding-unavailable"] } } }) + "\\n");
    `);

    await f.host.start();

    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    expect(f.showStartFailed).not.toHaveBeenCalled();
    expect(f.module.status().localModelsDegraded).toEqual({
      code: "LOCAL_MODELS_RECOVERY_REQUIRED",
      message: "The upstream tool could not verify the local stack binding.",
      reasons: ["binding-unavailable"],
    });
    expect(
      f.logs.find(
        (entry) => entry.event === "local_server.local_models_unavailable",
      ),
    ).toEqual({
      level: "warn",
      event: "local_server.local_models_unavailable",
      fields: {
        code: "LOCAL_MODELS_RECOVERY_REQUIRED",
        message: "The upstream tool could not verify the local stack binding.",
        reasons: ["binding-unavailable"],
      },
    });
    await f.host.stop("quit");
  });

  it("notifies the Computer Daemon once when resume restores local models with an unchanged runtime environment", async () => {
    const f = setupResumeFixture(`
      process.stdout.write(JSON.stringify({
        code: 0,
        details: {
          origin: "http://localhost:3000",
          localModelsRestored: true,
          restoredLocalModels: ["spark-x2.6-4b:Q4_K_M"],
        },
      }) + "\\n");
    `);
    const runtimeEvents = vi.fn();
    f.bus.on("computer.runtime", runtimeEvents);

    await f.host.start();

    await vi.waitFor(() => expect(f.module.status().phase).toBe("ready"));
    expect(runtimeEvents).toHaveBeenCalledTimes(1);
    expect(
      f.logs.find(
        (entry) => entry.event === "local_server.local_models_restored",
      ),
    ).toEqual({
      level: "info",
      event: "local_server.local_models_restored",
      fields: { models: ["spark-x2.6-4b:Q4_K_M"] },
    });
    await f.host.stop("quit");
  });

  it("does not emit computer.runtime twice when resume both updates runtimeEnvironment and restores local models", async () => {
    const f = setupResumeFixture(`
      process.stdout.write(JSON.stringify({
        code: 0,
        details: {
          origin: "http://localhost:3000",
          localModelsRestored: true,
          restoredLocalModels: ["spark-x2.6-4b:Q4_K_M"],
        },
        runtime: {
          setupChoice: "claude",
          environment: { LINGER_CLAUDE_PATH: "/mock/claude" },
        },
      }) + "\\n");
    `);
    const runtimeEvents = vi.fn();
    f.bus.on("computer.runtime", runtimeEvents);

    await f.host.start();

    await vi.waitFor(() => expect(f.module.status().phase).toBe("ready"));
    expect(runtimeEvents).toHaveBeenCalledTimes(1);
    await f.host.stop("quit");
  });

  it("redacts query, hash, and secrets and bounds resume_failed errors to 500 chars", async () => {
    const longPadding = "x".repeat(600);
    const f = setupResumeFixture(`
      process.stdout.write(JSON.stringify({
        code: 1,
        message: "Failed at https://linger.example.com/auth?token=secret123#frag with Bearer super-secret-token-123 ${longPadding}"
      }) + "\\n");
    `);

    await f.host.start();
    await waitForInstaller(() =>
      expect(f.module.status().phase).toBe("failed"),
    );

    const failed = f.logs.find(
      (entry) => entry.event === "local_server.resume_failed",
    );
    expect(failed).toBeDefined();
    expect(failed?.fields?.stage).toBe("installer_resume");
    expect(typeof failed?.fields?.total_ms).toBe("number");
    const errorText = String(failed?.fields?.error ?? "");
    expect(errorText.length).toBeLessThanOrEqual(500);
    expect(errorText).not.toContain("token=secret123");
    expect(errorText).not.toContain("#frag");
    expect(errorText).not.toContain("super-secret-token-123");
    await f.host.stop("quit");
  });

  it("reports resumable() true for the resuming origin only, true for a valid matching record, and false for malformed or incomplete records", async () => {
    const f = setupResumeFixture(`
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ code: 0, details: { origin: "http://localhost:3000" } }) + "\\n");
      }, 60);
    `);

    await f.host.start();
    // An active resume vouches only for the origin it resumes, not for a
    // remote server the user switched to meanwhile.
    await expect(f.module.resumable("http://localhost:3000")).resolves.toBe(
      true,
    );
    await expect(f.module.resumable("http://localhost:9999")).resolves.toBe(
      false,
    );

    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    await expect(
      f.module.resumable("http://localhost:3000/rooms/1"),
    ).resolves.toBe(true);
    await expect(f.module.resumable("http://localhost:3001")).resolves.toBe(
      false,
    );

    const recordFile = path.join(f.home, "desktop", "local-server.json");
    writeFileSync(recordFile, "{not json");
    await expect(f.module.resumable("http://localhost:3000")).resolves.toBe(
      false,
    );

    writeFileSync(
      recordFile,
      JSON.stringify({ home: f.home, origin: "http://localhost:3000" }),
    );
    await expect(f.module.resumable("http://localhost:3000")).resolves.toBe(
      false,
    );
    await f.host.stop("quit");
  });

  it("completes cold reopen onto a new port even when a detached grandchild keeps stdout open", async () => {
    const f = setupResumeFixture(`
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const path = require("node:path");
      // Keep the write end of stdout open after the installer exits, as a
      // detached service on Windows can when inheriting pipe handles.
      const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        detached: true,
        stdio: ["ignore", 1, "ignore"],
      });
      holder.unref();
      writeFileSync(path.join(process.env.LINGER_HOME, "holder.pid"), String(holder.pid));
      process.stdout.write(JSON.stringify({
        code: 0,
        details: { origin: "http://localhost:63009" },
      }) + "\\n", () => process.exit(0));
    `);

    try {
      await f.host.start();
      await vi.waitFor(() => expect(f.module.status().phase).toBe("ready"), {
        timeout: 5_000,
      });
      expect(f.setServer).toHaveBeenCalledWith(
        "http://localhost:63009",
        "http://localhost:3000",
        { reason: "resume_ready" },
      );
      const saved = JSON.parse(
        readFileSync(path.join(f.home, "desktop", "local-server.json"), "utf8"),
      ) as { origin: string };
      expect(saved.origin).toBe("http://localhost:63009");
      await expect(f.module.isStarting("http://localhost:63009")).resolves.toBe(
        false,
      );
    } finally {
      await f.host.stop("quit");
      const pidFile = path.join(f.home, "holder.pid");
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      } catch {
        // Already exited.
      }
    }
  });

  it("parses the installer outcome line even when a detached grandchild writes trailing non-JSON output", async () => {
    const f = setupResumeFixture(`
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const path = require("node:path");
      // Emit the installer outcome JSON, then have a detached grandchild write
      // both plain text and non-outcome JSON log lines while holding stdout open.
      const holder = spawn(
        process.execPath,
        [
          "-e",
          "process.stdout.write('service started\\n'); process.stdout.write(JSON.stringify({ level: 'info', msg: 'ready' }) + '\\n'); setTimeout(() => {}, 30000);",
        ],
        {
          detached: true,
          stdio: ["ignore", 1, "ignore"],
        },
      );
      holder.unref();
      writeFileSync(path.join(process.env.LINGER_HOME, "holder.pid"), String(holder.pid));
      process.stdout.write(JSON.stringify({
        code: 0,
        details: { origin: "http://localhost:63010" },
      }) + "\\n");
      setTimeout(() => process.exit(0), 60);
    `);

    try {
      await f.host.start();
      await vi.waitFor(() => expect(f.module.status().phase).toBe("ready"), {
        timeout: 5_000,
      });
      expect(f.setServer).toHaveBeenCalledWith(
        "http://localhost:63010",
        "http://localhost:3000",
        { reason: "resume_ready" },
      );
    } finally {
      await f.host.stop("quit");
      const pidFile = path.join(f.home, "holder.pid");
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      } catch {
        // Already exited.
      }
    }
  });

  it("adopts a verified live moved port from instance.json before showing Starting", async () => {
    const proved: LocalServerIdentity[] = [];
    const f = setupResumeFixture(
      `
        setTimeout(() => {
          process.stdout.write(JSON.stringify({ code: 0, details: { origin: "http://localhost:63009" } }) + "\\n");
        }, 40);
      `,
      {
        serverIdentity: async (_home, origin) => ({
          origin,
          teamhub: "http://127.0.0.1:8080",
          key: new Uint8Array([1, 2, 3]),
        }),
        proveServer: async (server) => {
          proved.push(server);
        },
        fetch: (async (input: string | URL | Request) => {
          const url = String(input);
          if (url === "http://localhost:63009")
            return new Response(null, { status: 200 });
          throw new Error("connection refused");
        }) as typeof fetch,
      },
    );
    await writeDesktopInstance(f.home, 63009);

    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    expect(proved).toEqual([
      expect.objectContaining({ origin: "http://localhost:63009" }),
    ]);
    expect(f.showStarting).not.toHaveBeenCalled();
    expect(f.setServer).toHaveBeenNthCalledWith(
      1,
      "http://localhost:63009",
      "http://localhost:3000",
      { reason: "port_moved" },
    );
    expect(f.setServer).toHaveBeenNthCalledWith(
      2,
      "http://localhost:63009",
      "http://localhost:63009",
      { reason: "resume_ready" },
    );
    await f.host.stop("quit");
  });

  it("does not adopt a moved port on the fast path when server identity verification fails", async () => {
    const f = setupResumeFixture(
      `
        setTimeout(() => {
          process.stdout.write(JSON.stringify({ code: 0, details: { origin: "http://localhost:63011" } }) + "\\n");
        }, 40);
      `,
      {
        serverIdentity: async (_home, origin) => ({
          origin,
          teamhub: "http://127.0.0.1:8080",
          key: new Uint8Array([1, 2, 3]),
        }),
        proveServer: async () => {
          throw new LocalServerUnverifiedError("proof_mismatch");
        },
        fetch: (async (input: string | URL | Request) => {
          const url = String(input);
          // Unrelated server answers 200 on the moved port.
          if (url === "http://localhost:63009")
            return new Response(null, { status: 200 });
          throw new Error("connection refused");
        }) as typeof fetch,
      },
    );
    await writeDesktopInstance(f.home, 63009);

    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    expect(f.showStarting).toHaveBeenCalledOnce();
    expect(f.setServer).toHaveBeenCalledExactlyOnceWith(
      "http://localhost:63011",
      "http://localhost:3000",
      { reason: "resume_ready" },
    );
    await f.host.stop("quit");
  });

  it("reports isStarting() true only while resuming and false once settled", async () => {
    const f = setupResumeFixture(`
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ code: 0, details: { origin: "http://localhost:3000" } }) + "\\n");
      }, 60);
    `);

    // Before start(), a valid matching record signals boot is about to resume.
    await expect(f.module.isStarting("http://localhost:3000")).resolves.toBe(
      true,
    );
    await f.host.start();
    await expect(f.module.isStarting("http://localhost:3000")).resolves.toBe(
      true,
    );
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    await expect(f.module.isStarting("http://localhost:3000")).resolves.toBe(
      false,
    );
    await f.host.stop("quit");
  });

  describe("a ready server that stops answering", () => {
    // Counts its resumes, and succeeds at once.
    const counting = `
      if (process.argv.includes("--resume"))
        require("node:fs").appendFileSync(require("node:path").join(__dirname, "runs"), "x");
      process.stdout.write(JSON.stringify({ code: 0, details: { origin: "http://localhost:3000" } }) + "\\n");
    `;
    const runs = (f: { installerDirectory: string }) => {
      try {
        return readFileSync(path.join(f.installerDirectory, "runs"), "utf8")
          .length;
      } catch {
        return 0;
      }
    };
    const answering = () => {
      const state = { up: true, unanswered: 0 };
      const probe = (async () => {
        if (!state.up) {
          state.unanswered++;
          throw new Error("offline");
        }
        return new Response(null, { status: 200 });
      }) as typeof fetch;
      return { state, fetch: probe };
    };
    const recoveries = (f: {
      logs: Array<{ event: string; fields?: unknown }>;
    }) =>
      f.logs
        .filter((entry) => entry.event === "local_server.unreachable_resume")
        .map((entry) => entry.fields);

    it("Retry resumes it again although the last resume succeeded", async () => {
      const server = answering();
      const f = setupResumeFixture(counting, { fetch: server.fetch });
      await f.host.start();
      await waitForInstaller(() =>
        expect(f.module.status().phase).toBe("ready"),
      );
      expect(runs(f)).toBe(1);
      server.state.up = false;
      f.bus.emit("local-server.retry");
      await waitForInstaller(() => expect(runs(f)).toBe(2));
      await waitForInstaller(() =>
        expect(f.module.status().phase).toBe("ready"),
      );
      expect(recoveries(f)).toEqual([{ trigger: "retry" }]);
      expect(f.showStarting).toHaveBeenCalledOnce();
      await f.host.stop("quit");
    });

    it("Retry leaves a ready server that answers alone", async () => {
      const server = answering();
      const f = setupResumeFixture(counting, { fetch: server.fetch });
      await f.host.start();
      await waitForInstaller(() =>
        expect(f.module.status().phase).toBe("ready"),
      );
      f.bus.emit("local-server.retry");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(runs(f)).toBe(1);
      expect(recoveries(f)).toEqual([]);
      await f.host.stop("quit");
    });

    it("a failed load resumes it once its supervisor had time to restart it", async () => {
      const server = answering();
      const f = setupResumeFixture(counting, {
        fetch: server.fetch,
        unreachableGraceMs: 100,
      });
      await f.host.start();
      await waitForInstaller(() =>
        expect(f.module.status().phase).toBe("ready"),
      );
      server.state.up = false;
      f.bus.emit("local-server.unreachable");
      // Further failed loads while it waits change nothing.
      f.bus.emit("local-server.unreachable");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runs(f)).toBe(1);
      await waitForInstaller(() => expect(runs(f)).toBe(2));
      // Three checks in a row went unanswered, then the resume's own one.
      expect(server.state.unanswered).toBeGreaterThanOrEqual(4);
      await waitForInstaller(() =>
        expect(f.module.status().phase).toBe("ready"),
      );
      expect(recoveries(f)).toEqual([{ trigger: "load_failed" }]);
      await f.host.stop("quit");
    });

    it("a server its supervisor brings back within the grace is not resumed", async () => {
      const server = answering();
      const f = setupResumeFixture(counting, {
        fetch: server.fetch,
        unreachableGraceMs: 150,
      });
      await f.host.start();
      await waitForInstaller(() =>
        expect(f.module.status().phase).toBe("ready"),
      );
      server.state.up = false;
      f.bus.emit("local-server.unreachable");
      setTimeout(() => {
        server.state.up = true;
      }, 50);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(runs(f)).toBe(1);
      expect(recoveries(f)).toEqual([]);
      await f.host.stop("quit");
    });

    it("the watch resumes it while no window load fails, at most once a minute", async () => {
      const server = answering();
      const f = setupResumeFixture(counting, {
        fetch: server.fetch,
        watchMs: 30,
        unreachableGraceMs: 30,
      });
      await f.host.start();
      await waitForInstaller(() =>
        expect(f.module.status().phase).toBe("ready"),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(runs(f)).toBe(1);
      server.state.up = false;
      await waitForInstaller(() => expect(runs(f)).toBe(2));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(runs(f)).toBe(2);
      expect(recoveries(f)).toEqual([{ trigger: "watch" }]);
      await f.host.stop("quit");
    });

    it("a server that answers slower than the launch check is not taken for a stopped one", async () => {
      // Answers every check after 1.5 s, past the launch's 1 s fast check.
      const slow = (async (_input, init) => {
        if (init?.method !== "HEAD") throw new Error("offline");
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 1_500);
          init.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("timed out"));
            },
            { once: true },
          );
        });
        return new Response(null, { status: 200 });
      }) as typeof fetch;
      const f = setupResumeFixture(counting, {
        fetch: slow,
        watchMs: 30,
        unreachableGraceMs: 30,
      });
      await f.host.start();
      await vi.waitFor(() => expect(f.module.status().phase).toBe("ready"), {
        timeout: 5_000,
      });
      // The launch's fast check gave up on it, as before.
      expect(f.showStarting).toHaveBeenCalledOnce();
      f.bus.emit("local-server.unreachable");
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(runs(f)).toBe(1);
      expect(recoveries(f)).toEqual([]);
      expect(f.showStarting).toHaveBeenCalledOnce();
      await f.host.stop("quit");
    }, 15_000);

    it("a server that misses fewer checks in a row than required is not resumed", async () => {
      const server = answering();
      let misses = 0;
      const flaky = (async (input, init) => {
        if (init?.method === "HEAD" && misses > 0) {
          misses--;
          throw new Error("offline");
        }
        return server.fetch(input, init);
      }) as typeof fetch;
      const f = setupResumeFixture(counting, {
        fetch: flaky,
        unreachableGraceMs: 60,
      });
      await f.host.start();
      await waitForInstaller(() =>
        expect(f.module.status().phase).toBe("ready"),
      );
      // Two of the three checks go unanswered, the last one answers.
      misses = 2;
      f.bus.emit("local-server.unreachable");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(misses).toBe(0);
      expect(runs(f)).toBe(1);
      expect(recoveries(f)).toEqual([]);
      await f.host.stop("quit");
    });

    it("a stop ends the watch and a pending recovery", async () => {
      const server = answering();
      const f = setupResumeFixture(counting, {
        fetch: server.fetch,
        watchMs: 30,
        unreachableGraceMs: 100,
      });
      await f.host.start();
      await waitForInstaller(() =>
        expect(f.module.status().phase).toBe("ready"),
      );
      server.state.up = false;
      f.bus.emit("local-server.unreachable");
      await f.host.stop("quit");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(runs(f)).toBe(1);
    });
  });

  describe("localServer config flag lifecycle", () => {
    const VALID_TOKEN = "sr1.payload." + "b".repeat(32);

    function startNextLaunch(options: {
      home: string;
      config: ConfigStore;
      credentials: CredentialStore;
      probe: typeof fetch;
    }) {
      const bus = new EventBus();
      const hide = vi.fn();
      const loadServer = vi.fn();
      const logs: Array<{
        level: string;
        event: string;
        fields?: Record<string, unknown>;
      }> = [];
      const local = new LocalServerModule({
        home: options.home,
        version: "0.16.20",
        installerDirectory: tempDirectory(),
        platform: "linux",
        arch: "x64",
        pollMs: 10,
        signIn: async () => {},
        fetch: options.probe,
      });
      const host = new ModuleHost(
        [
          stubModule("Config"),
          new EnrollmentModule({
            defaultDisplayName: "Desk",
            credentials: options.credentials,
            sessionCookie: async () => undefined,
          }),
          {
            ...stubModule("WindowManager"),
            setServer: vi.fn(() => true),
            hide,
            loadServer,
            showStarting: vi.fn(),
            showUpdating: vi.fn(),
            showStartFailed: vi.fn(),
          } as never,
          local,
        ],
        {
          config: options.config,
          bus,
          log: {
            info: (event, fields) =>
              logs.push({ level: "info", event, fields }),
            warn: (event, fields) =>
              logs.push({ level: "warn", event, fields }),
            error: (event, fields) =>
              logs.push({ level: "error", event, fields }),
          },
        },
      );
      return { host, bus, hide, loadServer, logs };
    }

    it("stamps localServer on resume, preserves it on server.moved, and sets it false on server.changed", async () => {
      const f = setupResumeFixture(`
        process.stdout.write(JSON.stringify({ code: 0, details: { origin: "http://localhost:3000" } }) + "\\n");
      `);
      await f.host.start();
      await vi.waitFor(() => expect(f.module.status().phase).toBe("ready"));
      expect(f.config.get().localServer).toBe(true);

      // Moving ports for the same local server preserves localServer.
      f.bus.emit(
        "server.moved",
        "http://localhost:3000",
        "http://localhost:3001",
      );
      expect(f.config.get().localServer).toBe(true);

      // Switching to another server explicitly marks localServer false.
      f.bus.emit("server.changed", "https://team.example.com");
      expect(f.config.get().localServer).toBe(false);
      await f.host.stop("quit");
    });

    it("keeps preferredRuntime and runtimeEnvironment on reset and does not wipe an external localhost dev server after server.changed", async () => {
      const f = setupResumeFixture(
        `
          process.stdout.write(JSON.stringify({ code: 0, details: { origin: "http://localhost:3000" } }) + "\\n");
        `,
        {
          initialConfig: {
            localServer: true,
            preferredRuntime: "pi",
            runtimeEnvironment: { LINGER_PI_PATH: "/home/.simplexai/bin/pi" },
          },
        },
      );
      await f.host.start();
      await vi.waitFor(() => expect(f.module.status().phase).toBe("ready"));

      const opened = vi.fn();
      f.bus.on("setup.open", opened);
      f.bus.emit("local-server.reset");
      await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
      expect(f.hide).toHaveBeenCalledOnce();
      expect(f.loadServer).toHaveBeenCalledOnce();
      expect(f.config.get().serverUrl).toBeUndefined();
      expect(f.config.get().localServer).toBeUndefined();
      expect(f.config.get().preferredRuntime).toBe("pi");
      expect(f.config.get().runtimeEnvironment).toEqual({
        LINGER_PI_PATH: "/home/.simplexai/bin/pi",
      });

      // User connects to an external localhost dev server instead; switching
      // servers emits server.changed, which explicitly marks localServer false.
      const credentials = new CredentialStore(
        path.join(tempDirectory(), "credential.json"),
      );
      credentials.write({
        computerId: "cmp_dev",
        gatewayUrl: "ws://127.0.0.1:5173/v1/runner-gateway",
        token: VALID_TOKEN,
      });
      f.config.update({
        serverUrl: "http://localhost:5173",
        computerId: "cmp_dev",
        ownerActorId: "act_dev",
      });
      f.bus.emit("server.changed", "http://localhost:5173");
      expect(f.config.get().localServer).toBe(false);
      await f.host.stop("quit");

      // Next launch with the external dev server stopped leaves it intact.
      const probe = vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch;
      const next = startNextLaunch({
        home: f.home,
        config: f.config,
        credentials,
        probe,
      });
      await next.host.start();
      expect(probe).not.toHaveBeenCalled();
      expect(f.config.get().serverUrl).toBe("http://localhost:5173");
      expect(f.config.get().computerId).toBe("cmp_dev");
      expect(f.config.get().preferredRuntime).toBe("pi");
      expect(f.config.get().runtimeEnvironment).toEqual({
        LINGER_PI_PATH: "/home/.simplexai/bin/pi",
      });
      expect(credentials.read()?.computerId).toBe("cmp_dev");
      await next.host.stop("quit");
    });

    it.each([
      { label: "modern localServer: true", localServer: true as const },
      { label: "legacy unset localServer", localServer: undefined },
    ])(
      "marks localServer false on server.changed ($label) so a stopped external localhost dev server is not wiped on next launch",
      async ({ localServer }) => {
        const f = setupResumeFixture(
          `
            process.stdout.write(JSON.stringify({ code: 0, details: { origin: "http://localhost:3000" } }) + "\\n");
          `,
          {
            withRecord: localServer === true,
            initialConfig: {
              ...(localServer !== undefined ? { localServer } : {}),
              preferredRuntime: "claude",
              runtimeEnvironment: {
                LINGER_CLAUDE_PATH: "/home/.simplexai/bin/claude",
              },
            },
            fetch: (async () =>
              new Response(null, { status: 200 })) as typeof fetch,
          },
        );
        await f.host.start();
        if (localServer === true) {
          await vi.waitFor(() => expect(f.module.status().phase).toBe("ready"));
          rmSync(path.join(f.home, "desktop", "local-server.json"), {
            force: true,
          });
        }

        f.config.update({
          serverUrl: "http://localhost:5173",
          computerId: "cmp_dev",
          ownerActorId: "act_dev",
        });
        f.bus.emit("server.changed", "http://localhost:5173");
        expect(f.config.get().localServer).toBe(false);
        await f.host.stop("quit");

        const credentials = new CredentialStore(
          path.join(tempDirectory(), "credential.json"),
        );
        credentials.write({
          computerId: "cmp_dev",
          gatewayUrl: "ws://127.0.0.1:5173/v1/runner-gateway",
          token: VALID_TOKEN,
        });
        const probe = vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch;
        const next = startNextLaunch({
          home: f.home,
          config: f.config,
          credentials,
          probe,
        });
        await next.host.start();
        expect(probe).not.toHaveBeenCalled();
        expect(f.config.get().serverUrl).toBe("http://localhost:5173");
        expect(f.config.get().computerId).toBe("cmp_dev");
        expect(credentials.read()?.computerId).toBe("cmp_dev");
        await next.host.stop("quit");
      },
    );

    it("clears the active local origin on server.changed so local -> remote -> external localhost on the same port sets localServer false", async () => {
      const f = setupResumeFixture(
        `
          process.stdout.write(JSON.stringify({ code: 0, details: { origin: "http://localhost:3000" } }) + "\\n");
        `,
        {
          initialConfig: {
            preferredRuntime: "codex",
          },
        },
      );
      await f.host.start();
      await vi.waitFor(() => expect(f.module.status().phase).toBe("ready"));
      expect(f.config.get().localServer).toBe(true);

      // Local -> remote clears both the tracked local origin and localServer.
      f.config.update({ serverUrl: "https://team.example.com" });
      f.bus.emit("server.changed", "https://team.example.com");
      expect(f.config.get().localServer).toBe(false);

      // Remove the local record and point manually at an external server on
      // the same loopback port; #origin was cleared so server.changed does not
      // treat it as Desktop's own local server.
      rmSync(path.join(f.home, "desktop", "local-server.json"), {
        force: true,
      });
      f.config.update({
        serverUrl: "http://localhost:3000",
        localServer: undefined,
      });
      f.bus.emit("server.changed", "http://localhost:3000");
      expect(f.config.get().localServer).toBe(false);
      await expect(f.module.ownsWindow()).resolves.toBe(false);
      await f.host.stop("quit");
    });
  });
});

describe("orphaned local server recovery during LocalServerModule.start()", () => {
  const VALID_TOKEN = "sr1.payload." + "a".repeat(32);

  function setupOrphanStart(
    initial: Parameters<ConfigStore["update"]>[0],
    options: {
      record?: "valid" | "corrupt" | "notdir" | "missing";
      reachable?: boolean;
    } = {},
  ) {
    const root = tempDirectory();
    const home = path.join(root, "home");
    const installerDirectory = path.join(root, "installer");
    mkdirSync(installerDirectory, { recursive: true });
    writeFileSync(
      path.join(installerDirectory, "installer.js"),
      `process.stdout.write(JSON.stringify({ code: 0, details: { origin: "http://localhost:3000" } }) + "\\n");`,
    );
    writeFileSync(
      path.join(installerDirectory, "package.json"),
      '{"type":"commonjs"}',
    );
    const config = new ConfigStore(path.join(root, "config.json"), {
      ownerActorId: "act_1",
      ...initial,
    });
    const credentials = new CredentialStore(path.join(root, "credential.json"));
    credentials.write({
      computerId: initial.computerId ?? "cmp_1",
      gatewayUrl: "ws://127.0.0.1:4100/v1/runner-gateway",
      token: VALID_TOKEN,
    });
    if (options.record === "valid" || options.record === "corrupt") {
      mkdirSync(path.join(home, "desktop"), { recursive: true });
      if (options.record === "valid") {
        const node = path.join(
          home,
          "desktop",
          "node",
          `v${NODE_RUNTIME_VERSION}`,
        );
        mkdirSync(path.join(node, "bin"), { recursive: true });
        fixtureNode(path.join(node, "bin", "node"));
        writeFileSync(
          path.join(home, "desktop", "local-server.json"),
          JSON.stringify({
            home,
            repo: "/source",
            origin: initial.serverUrl ?? "http://localhost:3000",
          }),
        );
      } else {
        writeFileSync(
          path.join(home, "desktop", "local-server.json"),
          "{not json",
        );
      }
    } else if (options.record === "notdir") {
      mkdirSync(home, { recursive: true });
      // Putting a file where the desktop directory belongs triggers ENOTDIR.
      writeFileSync(path.join(home, "desktop"), "not-a-dir");
    }
    const logs: Array<{
      level: string;
      event: string;
      fields?: Record<string, unknown>;
    }> = [];
    const probe = vi.fn(async () => {
      if (options.reachable) return new Response(null, { status: 200 });
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const hide = vi.fn();
    const loadServer = vi.fn();
    const bus = new EventBus();
    const setupOpened = vi.fn();
    const computerChanged = vi.fn();
    bus.on("setup.open", setupOpened);
    bus.on("computer.changed", computerChanged);

    const enrollment = new EnrollmentModule({
      defaultDisplayName: "Desk",
      credentials,
      sessionCookie: async () => undefined,
    });
    const module = new LocalServerModule({
      home,
      version: "0.16.20",
      installerDirectory,
      platform: "linux",
      arch: "x64",
      pollMs: 10,
      signIn: async () => {},
      fetch: probe,
    });
    const host = new ModuleHost(
      [
        stubModule("Config"),
        enrollment,
        {
          ...stubModule("WindowManager"),
          setServer: vi.fn(() => true),
          hide,
          loadServer,
          showStarting: vi.fn(),
          showUpdating: vi.fn(),
          showStartFailed: vi.fn(),
        } as never,
        module,
      ],
      {
        config,
        bus,
        log: {
          info: (event, fields) => logs.push({ level: "info", event, fields }),
          warn: (event, fields) => logs.push({ level: "warn", event, fields }),
          error: (event, fields) =>
            logs.push({ level: "error", event, fields }),
        },
      },
    );
    return {
      home,
      config,
      credentials,
      logs,
      probe,
      hide,
      loadServer,
      setupOpened,
      computerChanged,
      host,
      module,
    };
  }

  it("resets stale local config via Enrollment.unenroll() and hides the main window when local-server.json is ENOENT and localhost is unreachable", async () => {
    const f = setupOrphanStart({
      serverUrl: "http://localhost:3000",
      localServer: true,
      computerId: "cmp_1",
      tenantId: "ten_1",
      ownerActorId: "act_1",
      daemonId: "dmn_1",
      preferredRuntime: "pi",
      runtimeEnvironment: { LINGER_PI_PATH: "/home/.simplexai/bin/pi" },
      language: "zh-CN",
      preventSleep: true,
      permissionsAsked: ["folders"],
      updateFeedUrl: "https://updates.example.com/releases",
      diagnosticsUploadUrl: "https://diagnostics.example.com/upload",
      window: { x: 10, y: 20, width: 1200, height: 800 },
    });

    await f.host.start();

    expect(f.credentials.read()).toBeUndefined();
    expect(f.computerChanged).toHaveBeenCalledWith(undefined);
    expect(f.hide).toHaveBeenCalledOnce();
    expect(f.loadServer).toHaveBeenCalledOnce();
    expect(f.setupOpened).toHaveBeenCalledOnce();
    expect(f.config.get()).toMatchObject({
      serverUrl: undefined,
      localServer: undefined,
      computerId: undefined,
      tenantId: undefined,
      ownerActorId: undefined,
      daemonId: undefined,
      preferredRuntime: "pi",
      runtimeEnvironment: { LINGER_PI_PATH: "/home/.simplexai/bin/pi" },
      language: "zh-CN",
      preventSleep: true,
      permissionsAsked: ["folders"],
      updateFeedUrl: "https://updates.example.com/releases",
      diagnosticsUploadUrl: "https://diagnostics.example.com/upload",
      window: { x: 10, y: 20, width: 1200, height: 800 },
    });
    expect(f.logs).toContainEqual({
      level: "warn",
      event: "local_server.orphaned_config_reset",
      fields: { server_url: "http://localhost:3000" },
    });
    expect(f.logs).toContainEqual({
      level: "info",
      event: "enrollment.cleared",
      fields: undefined,
    });
    await f.host.stop("quit");
  });

  it.each([
    {
      label: "preferredRuntime",
      extra: { preferredRuntime: "claude" as const },
    },
    {
      label: "runtimeEnvironment",
      extra: { runtimeEnvironment: { LINGER_CODEX_PATH: "/opt/codex" } },
    },
  ])(
    "recovers legacy local configs without localServer flag when $label is set",
    async ({ extra }) => {
      const f = setupOrphanStart({
        serverUrl: "http://127.0.0.1:3000",
        computerId: "cmp_legacy",
        ...extra,
      });

      await f.host.start();

      expect(f.config.get().computerId).toBeUndefined();
      expect(f.config.get().serverUrl).toBeUndefined();
      expect(f.credentials.read()).toBeUndefined();
      expect(f.setupOpened).toHaveBeenCalledOnce();
      await f.host.stop("quit");
    },
  );

  it("does not reset an external localhost developer server config", async () => {
    const f = setupOrphanStart({
      serverUrl: "http://localhost:3000",
      computerId: "cmp_dev",
    });

    await f.host.start();

    expect(f.probe).not.toHaveBeenCalled();
    expect(f.setupOpened).not.toHaveBeenCalled();
    expect(f.config.get().computerId).toBe("cmp_dev");
    expect(f.config.get().serverUrl).toBe("http://localhost:3000");
    expect(f.credentials.read()?.computerId).toBe("cmp_dev");
    await f.host.stop("quit");
  });

  it("does not reset an external localhost config explicitly marked localServer: false", async () => {
    const f = setupOrphanStart({
      serverUrl: "http://localhost:3000",
      localServer: false,
      computerId: "cmp_dev",
      preferredRuntime: "codex",
      runtimeEnvironment: { LINGER_CODEX_PATH: "/opt/codex" },
    });

    await f.host.start();

    expect(f.probe).not.toHaveBeenCalled();
    expect(f.setupOpened).not.toHaveBeenCalled();
    expect(f.config.get().computerId).toBe("cmp_dev");
    expect(f.credentials.read()?.computerId).toBe("cmp_dev");
    await f.host.stop("quit");
  });

  it("does not reset a remote team server config", async () => {
    const f = setupOrphanStart({
      serverUrl: "https://team.example.com",
      computerId: "cmp_team",
      preferredRuntime: "codex",
    });

    await f.host.start();

    expect(f.probe).not.toHaveBeenCalled();
    expect(f.setupOpened).not.toHaveBeenCalled();
    expect(f.config.get().computerId).toBe("cmp_team");
    expect(f.credentials.read()?.computerId).toBe("cmp_team");
    await f.host.stop("quit");
  });

  it("does not reset when the localhost server still answers even if local-server.json is missing", async () => {
    const f = setupOrphanStart(
      {
        serverUrl: "http://localhost:3000",
        localServer: true,
        computerId: "cmp_alive",
      },
      { reachable: true },
    );

    await f.host.start();

    expect(f.probe).toHaveBeenCalledOnce();
    expect(f.setupOpened).not.toHaveBeenCalled();
    expect(f.config.get().computerId).toBe("cmp_alive");
    expect(f.credentials.read()?.computerId).toBe("cmp_alive");
    await f.host.stop("quit");
  });

  it("does not reset when local-server.json still exists (valid or corrupt)", async () => {
    const valid = setupOrphanStart(
      {
        serverUrl: "http://localhost:3000",
        localServer: true,
        computerId: "cmp_1",
      },
      { record: "valid", reachable: false },
    );
    await valid.host.start();
    await vi.waitFor(() => expect(valid.module.status().phase).toBe("ready"));
    expect(valid.setupOpened).not.toHaveBeenCalled();
    expect(valid.config.get().computerId).toBe("cmp_1");
    expect(valid.credentials.read()?.computerId).toBe("cmp_1");
    await valid.host.stop("quit");

    const corrupt = setupOrphanStart(
      {
        serverUrl: "http://localhost:3000",
        localServer: true,
        computerId: "cmp_corrupt",
      },
      { record: "corrupt", reachable: false },
    );
    await corrupt.host.start();
    expect(corrupt.probe).not.toHaveBeenCalled();
    expect(corrupt.setupOpened).not.toHaveBeenCalled();
    expect(corrupt.config.get().computerId).toBe("cmp_corrupt");
    expect(corrupt.credentials.read()?.computerId).toBe("cmp_corrupt");
    await corrupt.host.stop("quit");
  });

  it("does not reset when reading local-server.json fails with a non-ENOENT error", async () => {
    const f = setupOrphanStart(
      {
        serverUrl: "http://localhost:3000",
        localServer: true,
        computerId: "cmp_notdir",
      },
      { record: "notdir" },
    );

    await f.host.start();

    expect(f.probe).not.toHaveBeenCalled();
    expect(f.setupOpened).not.toHaveBeenCalled();
    expect(f.config.get().computerId).toBe("cmp_notdir");
    expect(f.credentials.read()?.computerId).toBe("cmp_notdir");
    await f.host.stop("quit");
  });

  it("recognizes IPv6 loopback hosts in isManagedLocalServerConfig", () => {
    expect(
      isManagedLocalServerConfig({
        serverUrl: "http://[::1]:3000",
        localServer: true,
      }),
    ).toBe(true);
    expect(
      isManagedLocalServerConfig({
        serverUrl: "http://[::1]:3000",
        localServer: false,
        preferredRuntime: "codex",
      }),
    ).toBe(false);
  });
});
