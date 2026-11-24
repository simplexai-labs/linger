import { describe, expect, it, vi } from "vitest";

import type { LocalmodelsToolSource } from "@linger/local-installation/localmodels-manifest";
import type {
  LocalmodelsUpdateCheckResult,
  StagedLocalmodelsUpdate,
} from "@linger/local-installation/localmodels-update";

import { LocalModelsUpdaterModule } from "./local-models-updater.js";
import { EventBus } from "./modules.js";
import { stubModule, testHost } from "./test-support.js";

const BASELINE: LocalmodelsToolSource = {
  version: "0.1.0.dev47",
  npmVersion: "0.1.0-dev.47",
  url: "https://d2ikbbcl3j6jz9.cloudfront.net/cli/localmodels/0.1.0.dev47/linux-x64.tgz",
  sha256: "a".repeat(64),
  bytes: 20_000_000,
  sourceCommit: "1".repeat(40),
  manifestSha256: "b".repeat(64),
};

const NEXT_KIT: LocalmodelsToolSource = {
  version: "0.1.0.dev48",
  npmVersion: "0.1.0-dev.48",
  url: "https://d2ikbbcl3j6jz9.cloudfront.net/cli/localmodels/0.1.0.dev48/linux-x64.tgz",
  sha256: "c".repeat(64),
  bytes: 21_000_000,
  sourceCommit: "2".repeat(40),
  manifestSha256: "d".repeat(64),
};

const AVAILABLE_RESULT: LocalmodelsUpdateCheckResult = {
  kind: "available",
  verified: {
    manifest: {
      schema: 1,
      version: "0.1.0.dev48",
      npmVersion: "0.1.0-dev.48",
      sourceCommit: "2".repeat(40),
      compatibility: {
        cliContract: "v2",
        archiveLayout: "npm-package-v1",
      },
      summary: "Adds Qwen3.8 models.",
      notesUrl: "https://docs.linger.com/models/changelog",
      kits: { "linux-x64": NEXT_KIT },
    },
    raw: "{}",
    signature: "c2ln\n",
  },
  kit: NEXT_KIT,
};

function makeFixture(
  overrides: {
    running?: number;
    localModelsBusy?: number;
    autoCheck?: boolean;
    checkResult?: LocalmodelsUpdateCheckResult;
  } = {},
) {
  let running = overrides.running ?? 0;
  let localModelsBusy = overrides.localModelsBusy ?? 0;
  const bus = new EventBus();
  const daemon = {
    ...stubModule("ComputerDaemon"),
    running: () => running,
    localModelsBusy: () => localModelsBusy,
  };
  const openExternal = vi.fn(async () => {});
  const resolveEffective = vi.fn(async () => ({
    source: BASELINE,
    origin: "bundled" as const,
    version: "0.1.0.dev47",
    npmVersion: "0.1.0-dev.47",
  }));
  const checkUpdate = vi.fn(
    async (): Promise<LocalmodelsUpdateCheckResult> =>
      overrides.checkResult ?? AVAILABLE_RESULT,
  );
  const staged: StagedLocalmodelsUpdate = {
    verified:
      AVAILABLE_RESULT.kind === "available"
        ? AVAILABLE_RESULT.verified
        : (undefined as never),
    kit: NEXT_KIT,
    tool: {
      python: "/tmp/home/tools/localmodels/next/python/bin/python3",
      moduleDirectory: "/tmp/home/tools/localmodels/next/modules",
      stateDirectory: "/tmp/home/runtime/localmodels/state",
      baseDirectory: "/tmp/home/runtime/localmodels/models",
    },
  };
  const stageUpdate = vi.fn(async (opts) => {
    opts.onProgress?.(10_000_000, NEXT_KIT.bytes);
    opts.onPhase?.("verifying");
    return staged;
  });
  const activateUpdate = vi.fn(async () => staged.tool);
  const rollbackUpdate = vi.fn(async () => {});

  const updater = new LocalModelsUpdaterModule({
    home: "/tmp/home",
    desktopVersion: "0.16.36",
    baseline: BASELINE,
    target: "linux-x64",
    openExternal,
    checkDelayMs: 60_000,
    checkIntervalMs: 60_000,
    resolveEffective,
    checkUpdate,
    stageUpdate,
    activateUpdate,
    rollbackUpdate,
  });

  const host = testHost(
    [stubModule("Config"), daemon as never, updater],
    {
      localModelsAutoCheck: overrides.autoCheck ?? true,
      runtimeEnvironment: {
        LINGER_PI_PATH: "/tmp/home/runtime/harness/pi",
        LINGER_LOCALMODELS_PYTHON: "/tmp/home/tools/localmodels/old/python3",
        LINGER_LOCALMODELS_MODULE_DIR:
          "/tmp/home/tools/localmodels/old/modules",
        LINGER_LOCALMODELS_STATE: "/tmp/home/runtime/localmodels/state",
        LINGER_LOCALMODELS_BASE_DIR: "/tmp/home/runtime/localmodels/models",
      },
    },
    bus,
  );

  return {
    host,
    bus,
    updater,
    openExternal,
    resolveEffective,
    checkUpdate,
    stageUpdate,
    activateUpdate,
    rollbackUpdate,
    setBusy(nextRunning: number, nextJobs: number) {
      running = nextRunning;
      localModelsBusy = nextJobs;
      bus.emit("runtime.activity", running);
      bus.emit("local-models.activity", localModelsBusy);
    },
  };
}

describe("LocalModelsUpdaterModule", () => {
  it("checks metadata only in background and installs only when requested", async () => {
    const f = makeFixture();
    await f.host.start();
    expect(f.updater.state()).toMatchObject({
      kind: "idle",
      currentVersion: "0.1.0.dev47",
      source: "bundled",
      autoCheck: true,
    });

    await f.updater.check(false);
    expect(f.stageUpdate).not.toHaveBeenCalled();
    expect(f.activateUpdate).not.toHaveBeenCalled();
    expect(f.updater.state()).toMatchObject({
      kind: "available",
      version: "0.1.0.dev48",
      summary: "Adds Qwen3.8 models.",
      hasNotes: true,
      bytes: NEXT_KIT.bytes,
    });

    await f.updater.openNotes();
    expect(f.openExternal).toHaveBeenCalledWith(
      "https://docs.linger.com/models/changelog",
    );

    const runtimeEvents: number[] = [];
    f.bus.on("computer.runtime", () => runtimeEvents.push(1));

    await f.updater.install();
    expect(f.stageUpdate).toHaveBeenCalledOnce();
    expect(f.activateUpdate).toHaveBeenCalledOnce();
    expect(runtimeEvents).toHaveLength(1);
    expect(f.host.ctx.config.get().runtimeEnvironment).toMatchObject({
      LINGER_PI_PATH: "/tmp/home/runtime/harness/pi",
      LINGER_LOCALMODELS_PYTHON:
        "/tmp/home/tools/localmodels/next/python/bin/python3",
      LINGER_LOCALMODELS_MODULE_DIR: "/tmp/home/tools/localmodels/next/modules",
    });
    expect(f.updater.state()).toMatchObject({
      kind: "idle",
      currentVersion: "0.1.0.dev48",
      source: "updated",
    });
    await f.host.stop("quit");
  });

  it("waits for both active agent runs and local model jobs before activating", async () => {
    const f = makeFixture({ running: 1, localModelsBusy: 1 });
    await f.host.start();
    await f.updater.check(true);
    await f.updater.install();

    expect(f.stageUpdate).toHaveBeenCalledOnce();
    expect(f.activateUpdate).not.toHaveBeenCalled();
    expect(f.updater.state()).toMatchObject({
      kind: "waiting",
      version: "0.1.0.dev48",
    });

    // Clearing only agent runs still waits for local model jobs.
    f.setBusy(0, 1);
    await Promise.resolve();
    expect(f.activateUpdate).not.toHaveBeenCalled();

    // Once both reach zero, activation completes.
    f.setBusy(0, 0);
    await vi.waitFor(() => expect(f.activateUpdate).toHaveBeenCalledOnce());
    expect(f.updater.state()).toMatchObject({
      kind: "idle",
      currentVersion: "0.1.0.dev48",
      source: "updated",
    });
    await f.host.stop("quit");
  });

  it("rolls back automatically if the daemon fails to start after activation", async () => {
    const f = makeFixture();
    await f.host.start();
    await f.updater.check(true);
    await f.updater.install();
    expect(f.updater.state()?.currentVersion).toBe("0.1.0.dev48");

    f.bus.emit("computer.failed", "exit code 1");
    await vi.waitFor(() =>
      expect(f.updater.state()).toMatchObject({
        kind: "failed",
        currentVersion: "0.1.0.dev47",
        source: "bundled",
      }),
    );
    expect(f.rollbackUpdate).toHaveBeenCalledOnce();
    expect(
      f.host.ctx.config.get().runtimeEnvironment?.LINGER_LOCALMODELS_PYTHON,
    ).toBe("/tmp/home/tools/localmodels/old/python3");
    await f.host.stop("quit");
  });

  it("respects autoCheck toggle and reports requires_app_update without downloading", async () => {
    const f = makeFixture({
      autoCheck: false,
      checkResult: {
        kind: "requires_app_update",
        manifest:
          AVAILABLE_RESULT.kind === "available"
            ? AVAILABLE_RESULT.verified.manifest
            : (undefined as never),
        minLingerVersion: "0.20.0",
      },
    });
    await f.host.start();
    // Background check is skipped while autoCheck is false.
    await f.updater.check(false);
    expect(f.checkUpdate).not.toHaveBeenCalled();

    // Manual check still runs and surfaces requires_app_update.
    await f.updater.check(true);
    expect(f.updater.state()).toMatchObject({
      kind: "requires_app_update",
      version: "0.1.0.dev48",
      minLingerVersion: "0.20.0",
    });
    await f.updater.install();
    expect(f.stageUpdate).not.toHaveBeenCalled();

    f.updater.setAutoCheck(true);
    expect(f.host.ctx.config.get().localModelsAutoCheck).toBe(true);
    expect(f.updater.state()?.autoCheck).toBe(true);
    await f.host.stop("quit");
  });
});
