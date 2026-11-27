import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { composeProject, instanceRoot, type Instance } from "./instance.js";
import {
  inspectNativeProcess,
  startNativeProcess,
  stopNativeProcess,
} from "./native-process.js";
import {
  BUNDLE_RUNTIME_SCHEMA,
  parseNativeRuntime,
  resolveBundleRuntimeEnv,
} from "./native-runtime.js";
import {
  planBundleNativeCommand,
  restoreBaselineNativeRelease,
  switchNativeRelease,
} from "./native-source.js";
import {
  parseLocalReleaseDescriptor,
  parseReleasePointer,
  readJsonIfExists,
  resolveSafeHomePath,
  writeJsonAtomic,
  type LocalReleaseDescriptor,
} from "./release-descriptor.js";
import { parseTeamhubBinaries } from "./teamhub-binaries.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("V2 local-installation release descriptors & decoupled bundles", () => {
  it("parses V2 runtime & teamhub manifests without sourceArchiveSha256", () => {
    const rt = parseNativeRuntime({
      schema: BUNDLE_RUNTIME_SCHEMA,
      target: "darwin-arm64",
      artifactId: "node-services-a1b2c3d4e5f6",
      nativeDepsHash: `sha256:${"a".repeat(64)}`,
      files: {
        "dist/main.js": { bytes: 100, sha256: "b".repeat(64) },
      },
    });
    expect(rt.artifactId).toBe("node-services-a1b2c3d4e5f6");
    expect(rt.sourceArchiveSha256).toBeUndefined();

    const th = parseTeamhubBinaries({
      target: "darwin-arm64",
      artifactId: "teamhub-darwin-arm64-a1b2c3d4e5f6",
      goVersion: "1.26.0",
      binaries: {
        teamhub: { file: "teamhub", sha256: "c".repeat(64), bytes: 10 },
        migrate: { file: "migrate", sha256: "d".repeat(64), bytes: 10 },
        account: { file: "account", sha256: "e".repeat(64), bytes: 10 },
      },
    });
    expect(th.artifactId).toBe("teamhub-darwin-arm64-a1b2c3d4e5f6");
    expect(th.sourceArchiveSha256).toBeUndefined();
  });

  it("writes/reads release descriptors atomically, blocks path escapes, and plans bundle commands", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "linger-li-"));
    tempDirs.push(home);

    expect(() => resolveSafeHomePath(home, "../escape")).toThrow(
      "Unsafe relative path",
    );
    expect(() => resolveSafeHomePath(home, "/etc/passwd")).toThrow(
      "Unsafe relative path",
    );

    const mk = (mod: string) => ({
      artifactId: `${mod}-111111111111`,
      originAppVersion: "0.2.15",
      sha256: "a".repeat(64),
      path: `store/${mod}/${mod}-111111111111`,
    });
    const descriptor: LocalReleaseDescriptor = {
      schema: 1,
      appVersion: "0.2.15",
      channel: "stable",
      installedAt: "2026-11-24T12:00:00Z",
      source: "incremental-update",
      compat: {
        minShellVersion: "0.2.0",
        minNativeDepsHash: `sha256:${"a".repeat(64)}`,
        runnerGatewayProtocol: 1,
        dbSchemaEpoch: 892,
        rollbackSafe: true,
      },
      infra: {
        node: "infra/node/v26",
        postgres: "infra/postgres/pg17",
        voiceTools: "infra/voice-tools/lk1",
        nodeDeps: "infra/node-deps/nd-aaaaaaaaaaaaaaaa",
      },
      modules: {
        web: mk("web"),
        backend: mk("backend"),
      },
    };

    const file = path.join(home, "releases/0.2.15/release.json");
    await writeJsonAtomic(file, descriptor);
    const loaded = await readJsonIfExists(file, parseLocalReleaseDescriptor);
    expect(loaded?.appVersion).toBe("0.2.15");

    const ptrFile = path.join(home, "state/current.json");
    await writeJsonAtomic(ptrFile, {
      appVersion: "0.2.15",
      releaseFile: "releases/0.2.15/release.json",
      updatedAt: "2026-11-24T12:00:00Z",
    });
    expect(
      (await readJsonIfExists(ptrFile, parseReleasePointer))?.appVersion,
    ).toBe("0.2.15");

    const nodeEnv = resolveBundleRuntimeEnv({
      nodeDepsDir: path.join(home, "infra/node-deps/nd-aaaaaaaaaaaaaaaa"),
      promptsDir: path.join(
        home,
        "store/backend/backend-111111111111/node-services/prompts",
      ),
    });
    expect(nodeEnv.NODE_PATH).toContain("nd-aaaaaaaaaaaaaaaa");
    expect(nodeEnv.LINGER_PROMPTS_DIR).toContain("prompts");

    const webCmd = planBundleNativeCommand("web", home, descriptor, {
      platform: "darwin",
      webControlToken: "tok123",
    });
    expect(webCmd.command).toBe(path.join(home, "infra/node/v26/bin/node"));
    expect(webCmd.args[0]).toBe(
      path.join(home, "store/web/web-111111111111/static-host.mjs"),
    );
    expect(webCmd.env.LINGER_WEB_CONTROL_TOKEN).toBe("tok123");
    expect(webCmd.env.LINGER_WEB_ARTIFACT_ID).toBe("web-111111111111");

    const thCmd = planBundleNativeCommand("teamhub", home, descriptor, {
      platform: "win32",
    });
    expect(thCmd.command).toBe(
      path.join(home, "store/backend/backend-111111111111/teamhub/teamhub.exe"),
    );
    expect(thCmd.env.TEAMHUB_SKILLS_DIR).toBe(
      path.join(home, "store/backend/backend-111111111111/skills"),
    );

    const fallbackDeps = path.join(
      home,
      "repo/.simplexai-runtime/offline/node-services",
    );
    const nsCmd = planBundleNativeCommand("node-services", home, descriptor, {
      platform: "darwin",
      fallbackNodeDepsDir: fallbackDeps,
    });
    expect(nsCmd.args[0]).toBe("--import");
    expect(nsCmd.args[1]).toContain("v2-esm-resolve.mjs");
    expect(nsCmd.args[2]).toBe("--conditions=linger-production");
    expect(nsCmd.args[3]).toBe(
      path.join(
        home,
        "store/backend/backend-111111111111/node-services/dist/supervisor.js",
      ),
    );
    expect(nsCmd.env.LINGER_NODE_DEPS_DIR).toBe(
      path.join(home, "infra/node-deps/nd-aaaaaaaaaaaaaaaa"),
    );
    expect(nsCmd.env.LINGER_FALLBACK_NODE_DEPS_DIR).toBe(fallbackDeps);
    expect(nsCmd.env.NODE_PATH?.split(path.delimiter).slice(0, 2)).toEqual([
      path.join(home, "infra/node-deps/nd-aaaaaaaaaaaaaaaa", "node_modules"),
      path.join(fallbackDeps, "node_modules"),
    ]);
    expect(nsCmd.env.LINGER_VOICE_RUNTIME_DIR).toBe(
      path.join(
        home,
        "store/backend/backend-111111111111/node-services/voice-runtime",
      ),
    );
    expect(nsCmd.env.NODE_OPTIONS).toContain("--import=file://");
    expect(nsCmd.env.LINGER_PROMPTS_DIR).toBe(
      path.join(
        home,
        "store/backend/backend-111111111111/node-services/prompts",
      ),
    );
  });

  it("switchNativeRelease restarts web onto the new bundle LINGER_WEB_ROOT while keeping postgres untouched", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "linger-switch-web-"));
    tempDirs.push(home);
    const root = instanceRoot({ name: "desktop", home });
    const repo = path.join(home, "repo");
    const offlineWebDir = path.join(
      repo,
      ".simplexai-runtime",
      "offline",
      "web",
    );
    await mkdir(root, { recursive: true });
    await mkdir(offlineWebDir, { recursive: true });

    const observedFile = path.join(home, "web-observed.json");
    // Simulate esbuild-bundled offline static-host.mjs that stays alive and logs LINGER_WEB_ROOT, HOST, API keys, and PATH.
    const voiceBin = path.join(
      home,
      "tools",
      "native",
      "components",
      "voice-sha",
      "bin",
    );
    await mkdir(voiceBin, { recursive: true });
    const exe = process.platform === "win32" ? ".exe" : "";
    await writeFile(path.join(voiceBin, `ffmpeg${exe}`), "", "utf8");
    await writeFile(path.join(voiceBin, `ffprobe${exe}`), "", "utf8");
    await writeFile(
      path.join(root, "livekit.env"),
      "LIVEKIT_HTTP_PORT=7880\nLIVEKIT_RTC_PORT=7881\nLIVEKIT_API_KEY=lkkey12345678\nLIVEKIT_API_SECRET=lksec12345678901234567890123456789012\n",
      { mode: 0o600 },
    );
    await writeFile(
      path.join(root, "user.env"),
      "COMPOSIO_API_KEY=comp-019\nXAI_API_KEY=xai-019\nSONIOX_API_KEY=soniox-019\n",
      { mode: 0o600 },
    );
    await writeFile(
      path.join(offlineWebDir, "static-host.mjs"),
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(observedFile)}, JSON.stringify({
  webRoot: process.env.LINGER_WEB_ROOT,
  artifactId: process.env.LINGER_WEB_ARTIFACT_ID,
  host: process.env.HOST,
  composio: process.env.COMPOSIO_API_KEY,
  xai: process.env.XAI_API_KEY,
  soniox: process.env.SONIOX_API_KEY,
  path: process.env.PATH,
  pid: process.pid,
}));
setInterval(() => {}, 60_000);
`,
      "utf8",
    );

    // Stage V2 web bundle whose static-host.mjs imports unbundled "sirv" (no local node_modules).
    const webDir = path.join(home, "store", "web", "web-222222222222");
    const webDistDir = path.join(webDir, "dist");
    await mkdir(webDistDir, { recursive: true });
    await writeFile(
      path.join(webDistDir, "index.html"),
      "<html>v2</html>",
      "utf8",
    );
    await writeFile(
      path.join(webDir, "static-host.mjs"),
      'import sirv from "sirv";\nconsole.log(sirv);\n',
      "utf8",
    );

    const descriptor: LocalReleaseDescriptor = {
      schema: 1,
      appVersion: "0.1.10-v2test.1",
      channel: "stable",
      installedAt: "2026-11-25T10:00:00Z",
      source: "incremental-update",
      compat: {
        minShellVersion: "0.1.10",
        minNativeDepsHash: `sha256:${"a".repeat(64)}`,
        runnerGatewayProtocol: 1,
        dbSchemaEpoch: 892,
        rollbackSafe: true,
      },
      infra: {
        node: "infra/node/v26",
        postgres: "infra/postgres/pg17",
        voiceTools: "infra/voice-tools/lk1",
        nodeDeps: "infra/node-deps/nd-aaaaaaaaaaaaaaaa",
      },
      modules: {
        web: {
          artifactId: "web-222222222222",
          originAppVersion: "0.1.10-v2test.1",
          sha256: "2".repeat(64),
          path: "store/web/web-222222222222",
        },
        backend: {
          artifactId: "backend-111111111111",
          originAppVersion: "0.1.10-v2test.0",
          sha256: "1".repeat(64),
          path: "store/backend/backend-111111111111",
        },
      },
    };
    await writeJsonAtomic(
      path.join(home, "releases", "0.1.10-v2test.1", "release.json"),
      descriptor,
    );

    const instance: Instance = {
      schemaVersion: 1,
      name: "desktop",
      mode: "source-native",
      root,
      project: composeProject(root, "desktop"),
      origin: "http://localhost:3100",
      port: 3100,
      releaseDir: repo,
      computerConfig: path.join(root, "computer.json"),
      computerExecutable: "/bin/true",
      source: {
        repo,
        ports: {
          web: 3100,
          teamhub: 3101,
          nodeServices: 3102,
          document: 3103,
          postgres: 3104,
        },
      },
    };

    try {
      // Start a live dummy postgres process to prove switchNativeRelease never restarts it.
      await startNativeProcess({
        root,
        name: "postgres",
        executable: process.execPath,
        args: ["-e", "setInterval(() => {}, 60000)"],
        cwd: home,
        env: process.env,
        settings: "pg-v1",
      });
      const pgBefore = await inspectNativeProcess(root, "postgres");
      expect(pgBefore.running).toBe(true);
      expect(pgBefore.pid).toBeDefined();

      const result = await switchNativeRelease(instance, {
        home,
        appVersion: "0.1.10-v2test.1",
        services: ["web"],
      });

      expect(result.restarted).toEqual(["web"]);
      expect(result.webArtifactId).toBe("web-222222222222");

      // Postgres PID stayed 100% untouched!
      const pgAfter = await inspectNativeProcess(root, "postgres");
      expect(pgAfter.running).toBe(true);
      expect(pgAfter.pid).toBe(pgBefore.pid);

      // Web started cleanly with LINGER_WEB_ROOT, artifactId, loopback HOST, preserved 0.1.9 user.env keys, and cached voiceTools PATH!
      await vi.waitFor(
        async () => {
          const observed = JSON.parse(await readFile(observedFile, "utf8")) as {
            webRoot: string;
            artifactId: string;
            host: string;
            composio: string;
            xai: string;
            soniox: string;
            path: string;
          };
          expect(observed.webRoot).toBe(webDistDir);
          expect(observed.artifactId).toBe("web-222222222222");
          expect(observed.host).toBe("127.0.0.1,::1");
          expect(observed.composio).toBe("comp-019");
          expect(observed.xai).toBe("xai-019");
          expect(observed.soniox).toBe("soniox-019");
          expect(observed.path.split(path.delimiter)[0]).toBe(voiceBin);
        },
        { timeout: 3_000 },
      );
    } finally {
      await stopNativeProcess(root, "web").catch(() => undefined);
      await stopNativeProcess(root, "postgres").catch(() => undefined);
    }
  }, 15_000);

  it("restoreBaselineNativeRelease restarts selected services from .simplexai-runtime baseline while keeping postgres untouched", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "linger-restore-baseline-"));
    tempDirs.push(home);
    const root = instanceRoot({ name: "desktop", home });
    const repo = path.join(home, "repo");
    const offlineWebDir = path.join(
      repo,
      ".simplexai-runtime",
      "offline",
      "web",
    );
    const offlineNsDist = path.join(
      repo,
      ".simplexai-runtime",
      "offline",
      "node-services",
      "dist",
    );
    await mkdir(root, { recursive: true });
    await mkdir(offlineWebDir, { recursive: true });
    await mkdir(offlineNsDist, { recursive: true });

    const observedWeb = path.join(home, "baseline-web.json");
    const observedNs = path.join(home, "baseline-ns.json");
    await writeFile(
      path.join(offlineWebDir, "static-host.mjs"),
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(observedWeb)}, JSON.stringify({
  mode: "baseline-web",
  webRoot: process.env.LINGER_WEB_ROOT ?? null,
  artifactId: process.env.LINGER_WEB_ARTIFACT_ID ?? null,
}));
setInterval(() => {}, 60_000);
`,
      "utf8",
    );
    await writeFile(
      path.join(offlineNsDist, "supervisor.js"),
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(observedNs)}, JSON.stringify({
  mode: "baseline-ns",
  depsDir: process.env.LINGER_NODE_DEPS_DIR ?? null,
  fallbackDir: process.env.LINGER_FALLBACK_NODE_DEPS_DIR ?? null,
}));
setInterval(() => {}, 60_000);
`,
      "utf8",
    );

    const instance: Instance = {
      schemaVersion: 1,
      name: "desktop",
      mode: "source-native",
      root,
      project: composeProject(root, "desktop"),
      origin: "http://localhost:3200",
      port: 3200,
      releaseDir: repo,
      computerConfig: path.join(root, "computer.json"),
      computerExecutable: "/bin/true",
      source: {
        repo,
        ports: {
          web: 3200,
          teamhub: 3201,
          nodeServices: 3202,
          document: 3203,
          postgres: 3204,
        },
      },
    };

    try {
      await startNativeProcess({
        root,
        name: "postgres",
        executable: process.execPath,
        args: ["-e", "setInterval(() => {}, 60000)"],
        cwd: home,
        env: process.env,
        settings: "pg-baseline",
      });
      const pgBefore = await inspectNativeProcess(root, "postgres");
      expect(pgBefore.running).toBe(true);

      const restored = await restoreBaselineNativeRelease(instance, {
        home,
        services: ["node-services", "web"],
      });
      expect(restored).toEqual({
        appVersion: "baseline",
        restarted: ["node-services", "web"],
      });

      const pgAfter = await inspectNativeProcess(root, "postgres");
      expect(pgAfter.running).toBe(true);
      expect(pgAfter.pid).toBe(pgBefore.pid);

      await vi.waitFor(
        async () => {
          const web = JSON.parse(await readFile(observedWeb, "utf8")) as {
            mode: string;
            webRoot: string | null;
            artifactId: string | null;
          };
          const ns = JSON.parse(await readFile(observedNs, "utf8")) as {
            mode: string;
            depsDir: string | null;
            fallbackDir: string | null;
          };
          expect(web).toEqual({
            mode: "baseline-web",
            webRoot: null,
            artifactId: null,
          });
          expect(ns).toEqual({
            mode: "baseline-ns",
            depsDir: null,
            fallbackDir: null,
          });
        },
        { timeout: 3_000 },
      );
    } finally {
      await stopNativeProcess(root, "web").catch(() => undefined);
      await stopNativeProcess(root, "node-services").catch(() => undefined);
      await stopNativeProcess(root, "postgres").catch(() => undefined);
    }
  }, 15_000);
});
