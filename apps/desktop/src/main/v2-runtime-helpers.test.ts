import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { LocalReleaseDescriptor } from "@linger/local-installation/release-descriptor";
import { BundleStoreModule } from "./bundle-store.js";
import { ConfigStore } from "./config.js";
import { HealthWatchdogModule } from "./health-watchdog.js";
import { EventBus, ModuleHost } from "./modules.js";
import { ReleaseOrchestratorModule } from "./release-orchestrator.js";
import {
  buildV2HealthProbes,
  resolveColdStartDaemonLaunch,
  resolveToolsNodePath,
} from "./v2-runtime-helpers.js";

const tempDirs: string[] = [];
const servers: Server[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function mkRelease(version: string, suffix: string): LocalReleaseDescriptor {
  return {
    schema: 1,
    appVersion: version,
    channel: "stable",
    installedAt: new Date().toISOString(),
    source: "incremental-update",
    compat: {
      minShellVersion: "0.1.0",
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
        artifactId: "web-111111111111",
        originAppVersion: "0.1.10-v2test.2",
        sha256: "1".repeat(64),
        path: "store/web/web-111111111111",
      },
      backend: {
        artifactId: `backend-${suffix}`,
        originAppVersion: version,
        sha256: suffix.padEnd(64, "0"),
        path: `store/backend/backend-${suffix}`,
      },
    },
  };
}

async function listenJson(
  handler: (url: string) => { status: number; body: unknown },
): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const out = handler(req.url ?? "/");
    res.statusCode = out.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(out.body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  return { server, port: typeof addr === "object" && addr ? addr.port : 0 };
}

afterEach(async () => {
  while (servers.length > 0) {
    const srv = servers.pop()!;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("resolveToolsNodePath (P0-A)", () => {
  it("falls back to Shell resources/runtime/bin/node when infra/node is absent", async () => {
    const root = await makeTempDir("linger-tools-node-");
    const home = path.join(root, "home");
    const resourcesPath = path.join(root, "Linger.app", "Contents", "Resources");
    const shellNode = path.join(resourcesPath, "runtime", "bin", "node");
    await mkdir(path.dirname(shellNode), { recursive: true });
    await writeFile(shellNode, "#!/bin/sh\n", "utf8");

    const resolved = resolveToolsNodePath({
      home,
      releaseInfraNode: "infra/node/v26.5.0",
      resourcesPath,
      isPackaged: true,
      platform: "darwin",
      env: {},
    });
    expect(resolved).toBe(shellNode);
  });

  it("prefers infra/node when present, falls back to desktop/node, and returns undefined if none exist", async () => {
    const root = await makeTempDir("linger-tools-node-order-");
    const home = path.join(root, "home");
    const resourcesPath = path.join(root, "resources");

    // Nothing exists -> returns undefined (never injects a nonexistent path).
    expect(
      resolveToolsNodePath({
        home,
        releaseInfraNode: "infra/node/v26.5.0",
        resourcesPath,
        isPackaged: true,
        platform: "darwin",
        env: {},
      }),
    ).toBeUndefined();

    // Only <home>/desktop/node/<ver>/bin/node exists.
    const desktopNode = path.join(home, "desktop", "node", "v26.5.0", "bin", "node");
    await mkdir(path.dirname(desktopNode), { recursive: true });
    await writeFile(desktopNode, "#!/bin/sh\n", "utf8");
    expect(
      resolveToolsNodePath({
        home,
        releaseInfraNode: "infra/node/v26.5.0",
        resourcesPath,
        isPackaged: true,
        platform: "darwin",
        env: {},
      }),
    ).toBe(desktopNode);

    // Once infra/node exists, it takes precedence over desktop/node.
    const infraNode = path.join(home, "infra", "node", "v26.5.0", "bin", "node");
    await mkdir(path.dirname(infraNode), { recursive: true });
    await writeFile(infraNode, "#!/bin/sh\n", "utf8");
    expect(
      resolveToolsNodePath({
        home,
        releaseInfraNode: "infra/node/v26.5.0",
        resourcesPath,
        isPackaged: true,
        platform: "darwin",
        env: {},
      }),
    ).toBe(infraNode);

    // Explicit env override wins when it exists.
    const customNode = path.join(root, "custom-node");
    await writeFile(customNode, "#!/bin/sh\n", "utf8");
    expect(
      resolveToolsNodePath({
        home,
        releaseInfraNode: "infra/node/v26.5.0",
        resourcesPath,
        isPackaged: true,
        platform: "darwin",
        env: { LINGER_TOOLS_NODE_PATH: customNode },
      }),
    ).toBe(customNode);
  });
});

describe("buildV2HealthProbes (P0-C)", () => {
  it("probes real teamhub and node-services ports and triggers rollback when teamhub is down even if Web returns 200", async () => {
    const home = await makeTempDir("linger-probes-home-");

    // Web static-host stays 200 OK the whole time.
    const web = await listenJson(() => ({ status: 200, body: { ok: true, service: "linger-web" } }));
    // Node services stays 200 OK.
    const nodeServices = await listenJson(() => ({ status: 200, body: { status: "ok" } }));
    // TeamHub simulates exit code 42 -> port closed / unreachable.
    const closedTeamhub = await listenJson(() => ({ status: 200, body: { ok: true } }));
    const deadTeamhubPort = closedTeamhub.port;
    await new Promise<void>((resolve) => closedTeamhub.server.close(() => resolve()));

    const store = new BundleStoreModule({ home, target: "darwin-arm64" });
    const watchdog = new HealthWatchdogModule();
    const restartedVersions: string[] = [];
    const orchestrator = new ReleaseOrchestratorModule({
      activeOperations: () => 0,
      healthGateTimeoutMs: 250,
      healthGateIntervalMs: 40,
      restartServices: async (release) => {
        restartedVersions.push(release.appVersion);
      },
      buildHealthProbes: (_release, changed) =>
        buildV2HealthProbes({
          changed,
          localOrigin: `http://127.0.0.1:${web.port}`,
          isPackaged: true,
          loadLocalPorts: async () => ({
            web: web.port,
            teamhub: deadTeamhubPort,
            nodeServices: nodeServices.port,
          }),
          probeTimeoutMs: 150,
        }),
    });

    const noopLog = { info: () => {}, warn: () => {}, error: () => {} };
    const host = new ModuleHost(
      [
        { name: "Config", dependsOn: [], start: async () => {}, stop: async () => {} },
        store,
        watchdog,
        orchestrator,
      ],
      {
        config: new ConfigStore(path.join(home, "config.json"), {
          serverUrl: `http://127.0.0.1:${web.port}`,
        }),
        log: noopLog,
        bus: new EventBus(),
      },
    );
    await host.start();
    try {
      const healthy = mkRelease("0.1.10-v2test.2", "222222222222");
      await store.writeReleaseDescriptor(healthy);
      await store.beginPending({
        appVersion: healthy.appVersion,
        releaseFile: `releases/${healthy.appVersion}/release.json`,
        updatedAt: new Date().toISOString(),
      });
      await store.commitPending();

      const faulty = mkRelease("0.1.10-v2test.3", "333333333333");
      await store.writeReleaseDescriptor(faulty);
      await orchestrator.onBundleStaged(faulty.appVersion);
      const applied = await orchestrator.applyStaged();

      expect(applied).toBe(false);
      // Rolled back cleanly to 0.1.10-v2test.2 and denylisted 0.1.10-v2test.3.
      expect((await store.readCurrent())?.appVersion).toBe("0.1.10-v2test.2");
      expect(await store.isDenylisted("0.1.10-v2test.3")).toBe(true);
      expect(restartedVersions).toEqual(["0.1.10-v2test.3", "0.1.10-v2test.2"]);
    } finally {
      await host.stop("quit");
    }
  });

  it("fails backend health probe when node-services is down or local ports are unavailable", async () => {
    const web = await listenJson(() => ({ status: 200, body: { ok: true } }));
    const teamhub = await listenJson(() => ({ status: 200, body: { ok: true } }));
    const deadNs = await listenJson(() => ({ status: 200, body: { status: "ok" } }));
    const deadNsPort = deadNs.port;
    await new Promise<void>((resolve) => deadNs.server.close(() => resolve()));

    const probes = buildV2HealthProbes({
      changed: ["backend"],
      localOrigin: `http://127.0.0.1:${web.port}`,
      isPackaged: true,
      loadLocalPorts: async () => ({
        web: web.port,
        teamhub: teamhub.port,
        nodeServices: deadNsPort,
      }),
      probeTimeoutMs: 150,
    });
    expect(probes.map((p) => p.name)).toEqual([
      "teamhub-healthz",
      "node-services-healthz",
    ]);
    expect(await probes[0]!.check()).toBe(true);
    expect(await probes[1]!.check()).toBe(false);

    // Missing ports must NOT fall back to Web /healthz.
    const missingPortProbes = buildV2HealthProbes({
      changed: ["backend"],
      localOrigin: `http://127.0.0.1:${web.port}`,
      isPackaged: true,
      loadLocalPorts: async () => undefined,
      probeTimeoutMs: 150,
    });
    expect(await missingPortProbes[0]!.check()).toBe(false);
    expect(await missingPortProbes[1]!.check()).toBe(false);
  });
});

describe("resolveColdStartDaemonLaunch", () => {
  it("falls back to shell daemon when state/current.json is absent", async () => {
    const home = await makeTempDir("linger-cold-daemon-");
    const launch = await resolveColdStartDaemonLaunch({
      home,
      shellDaemonPath: "/shell/linger-computer-daemon",
      shellTeamhubCliDirectory: "/shell/teamhub-cli",
      env: {},
    });
    expect(launch).toEqual({
      daemonPath: "/shell/linger-computer-daemon",
      teamhubCliDirectory: "/shell/teamhub-cli",
      source: "shell",
    });
  });

  it("loads committed V2 store computer-daemon, teamhub-cli, and toolsNodePath on cold start", async () => {
    const home = await makeTempDir("linger-cold-daemon-");
    const store = new BundleStoreModule({ home });
    const release = mkRelease("0.1.10-v2test.4", "444444444444");
    await store.writeReleaseDescriptor(release);
    await store.beginPending({
      appVersion: release.appVersion,
      releaseFile: `releases/${release.appVersion}/release.json`,
      updatedAt: new Date().toISOString(),
    });
    await store.commitPending();

    const daemonDir = path.join(
      home,
      release.modules.backend.path,
      "computer-daemon",
    );
    const daemonExe = path.join(daemonDir, "linger-computer-daemon");
    const cliDir = path.join(daemonDir, "teamhub-cli");
    const infraNode = path.join(home, release.infra.node, "bin", "node");
    await mkdir(cliDir, { recursive: true });
    await mkdir(path.dirname(infraNode), { recursive: true });
    await writeFile(daemonExe, "#!/bin/sh\n");
    await writeFile(infraNode, "#!/bin/sh\n");

    const launch = await resolveColdStartDaemonLaunch({
      home,
      shellDaemonPath: "/shell/linger-computer-daemon",
      shellTeamhubCliDirectory: "/shell/teamhub-cli",
      platform: "darwin",
      env: {},
    });
    expect(launch).toEqual({
      daemonPath: daemonExe,
      teamhubCliDirectory: cliDir,
      toolsNodePath: infraNode,
      source: "store",
      appVersion: "0.1.10-v2test.4",
    });
  });

  it("honors LINGER_COMPUTER_DAEMON override over V2 store", async () => {
    const home = await makeTempDir("linger-cold-daemon-");
    const launch = await resolveColdStartDaemonLaunch({
      home,
      shellDaemonPath: "/shell/linger-computer-daemon",
      shellTeamhubCliDirectory: "/shell/teamhub-cli",
      env: { LINGER_COMPUTER_DAEMON: "/custom/daemon" },
    });
    expect(launch).toEqual({
      daemonPath: path.resolve("/custom/daemon"),
      teamhubCliDirectory: "/shell/teamhub-cli",
      source: "env",
    });
  });
});
