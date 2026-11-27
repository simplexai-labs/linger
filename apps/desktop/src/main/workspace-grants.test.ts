import { existsSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ConfigStore } from "./config.js";
import { EventBus, ModuleHost } from "./modules.js";
import {
  silentLog,
  stubModule,
  tempDirectory,
  testHost,
} from "./test-support.js";
import { WorkspaceGrantsModule } from "./workspace-grants.js";

const pickNothing = async () => undefined;

describe("WorkspaceGrantsModule", () => {
  it("grants the default folder on start for a connected computer", async () => {
    const directory = path.join(tempDirectory(), "Linger");
    const grants = new WorkspaceGrantsModule({
      pickDirectory: pickNothing,
      defaultDirectory: directory,
    });
    const host = testHost([stubModule("Config"), grants], {
      computerId: "computer_1",
    });
    await host.start();

    expect(existsSync(directory)).toBe(true);
    expect(grants.list()).toMatchObject([
      { path: realpathSync(directory), label: "Linger", access: "read_write" },
    ]);
    await host.stop("quit");
  });

  it("grants the default folder once the computer connects", async () => {
    const directory = path.join(tempDirectory(), "Linger");
    const grants = new WorkspaceGrantsModule({
      pickDirectory: pickNothing,
      defaultDirectory: directory,
    });
    const bus = new EventBus();
    const host = new ModuleHost([stubModule("Config"), grants], {
      config: new ConfigStore(path.join(tempDirectory(), "config.json"), {}),
      log: silentLog,
      bus,
    });
    await host.start();
    expect(grants.list()).toEqual([]);

    const changed = new Promise<void>((resolve) =>
      bus.on("grants.changed", () => resolve()),
    );
    bus.emit("computer.changed", "computer_1");
    await changed;
    expect(grants.list().map((g) => g.label)).toEqual(["Linger"]);
    await host.stop("quit");
  });

  it("keeps folders the user already granted", async () => {
    const existing = tempDirectory();
    const grants = new WorkspaceGrantsModule({
      pickDirectory: pickNothing,
      defaultDirectory: path.join(tempDirectory(), "Linger"),
    });
    const host = testHost([stubModule("Config"), grants], {
      computerId: "computer_1",
      workspaceGrants: [
        {
          grantId: "grant_1",
          path: existing,
          label: "mine",
          access: "read_write",
          createdAt: "2026-10-20T00:00:00.000Z",
        },
      ],
    });
    await host.start();

    expect(grants.list().map((g) => g.grantId)).toEqual(["grant_1"]);
    await host.stop("quit");
  });

  it("serializes concurrent ensureDefault calls without creating duplicates", async () => {
    const directory = path.join(tempDirectory(), "Linger");
    const grants = new WorkspaceGrantsModule({
      pickDirectory: pickNothing,
      defaultDirectory: directory,
    });
    const host = testHost([stubModule("Config"), grants], {});
    await host.start();

    await Promise.all([
      grants.ensureDefault(),
      grants.ensureDefault(),
      grants.ensureDefault(),
    ]);

    expect(grants.list()).toHaveLength(1);
    expect(grants.list()[0]?.path).toBe(realpathSync(directory));
    await host.stop("quit");
  });

  it("logs and records default workspace grant failure without throwing, then clears once a folder is added", async () => {
    const blockedPath = path.join(tempDirectory(), "Linger");
    // A regular file at the default folder path prevents mkdir from creating a directory.
    writeFileSync(blockedPath, "not a directory");
    const grants = new WorkspaceGrantsModule({
      pickDirectory: pickNothing,
      defaultDirectory: blockedPath,
    });
    const errorLog = vi.fn();
    const host = new ModuleHost([stubModule("Config"), grants], {
      config: new ConfigStore(path.join(tempDirectory(), "config.json"), {
        computerId: "computer_1",
      }),
      log: { ...silentLog, error: errorLog },
      bus: new EventBus(),
    });

    await host.start();

    expect(grants.list()).toEqual([]);
    expect(grants.defaultFailure()).toMatchObject({
      directory: blockedPath,
    });
    expect(grants.defaultFailure()?.error).toBeTruthy();
    expect(errorLog).toHaveBeenCalledWith(
      "workspace_grant.default_failed",
      expect.objectContaining({
        directory: blockedPath,
        error: expect.any(String),
      }),
    );

    // Adding a valid folder clears the recorded failure.
    const fallbackDir = tempDirectory();
    await grants.add(fallbackDir);
    expect(grants.defaultFailure()).toBeUndefined();
    await host.stop("quit");
  });
});
