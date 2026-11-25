import { copyFileSync, linkSync, mkdtempSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ThemeChoice } from "../shared/theme.js";
import { ConfigStore, type DesktopConfig } from "./config.js";
import type { Logger } from "./log.js";
import { EventBus, ModuleHost, type Module } from "./modules.js";
import type { NativeTheme } from "./theme.js";

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

/**
 * Electron's nativeTheme as the shell uses it. `setSystemDark` is the
 * operating system switching, which tells the listeners as Electron does.
 */
export const fakeNativeTheme = (
  systemDark = false,
): NativeTheme & {
  setSystemDark(dark: boolean): void;
  listeners(): number;
} => {
  const listeners = new Set<() => void>();
  let dark = systemDark;
  let source: ThemeChoice = "system";
  return {
    get themeSource() {
      return source;
    },
    set themeSource(next) {
      source = next;
    },
    get shouldUseDarkColors() {
      return source === "system" ? dark : source === "dark";
    },
    on: (_event, listener) => listeners.add(listener),
    off: (_event, listener) => listeners.delete(listener),
    setSystemDark(next) {
      dark = next;
      for (const listener of listeners) listener();
    },
    listeners: () => listeners.size,
  };
};
