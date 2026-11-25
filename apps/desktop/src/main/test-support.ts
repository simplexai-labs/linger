import { copyFileSync, linkSync, mkdtempSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConfigStore, type DesktopConfig } from "./config.js";
import type { Logger } from "./log.js";
import { EventBus, ModuleHost, type Module } from "./modules.js";

export const silentLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export const tempDirectory = (): string =>
  mkdtempSync(path.join(os.tmpdir(), "desktop-test-"));

/**
 * Places the running Node.js at a simulated runtime's binary path. The runtime
 * keeps its target layout, but the installer stub runs on the host: Windows
 * can hardlink without Developer Mode and spawns the .exe.
 */
export function fixtureNode(binary: string): void {
  if (process.platform !== "win32") {
    symlinkSync(process.execPath, binary);
    return;
  }
  const put = (file: string) => {
    try {
      linkSync(process.execPath, file);
    } catch {
      copyFileSync(process.execPath, file);
    }
  };
  put(binary);
  if (path.extname(binary) !== ".exe") put(binary + ".exe");
}

export const testHost = (
  modules: readonly Module[],
  defaults: Partial<DesktopConfig> = {},
  bus = new EventBus(),
): ModuleHost =>
  new ModuleHost(modules, {
    config: new ConfigStore(
      path.join(tempDirectory(), "config.json"),
      defaults,
    ),
    log: silentLog,
    bus,
  });

export const stubModule = (name: string, dependsOn: string[] = []): Module => ({
  name,
  dependsOn,
  start: async () => {},
  stop: async () => {},
});
