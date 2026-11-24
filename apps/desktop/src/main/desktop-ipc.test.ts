import { afterEach, describe, expect, it, vi } from "vitest";

import { IPC } from "../shared/api.js";
import type { UpdateState } from "./updater.js";

const handlers = vi.hoisted(
  () => new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
);
const focusApp = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({
  app: { focus: focusApp },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, ...args: unknown[]) => unknown,
    ) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));

const { DesktopIpcModule } = await import("./desktop-ipc.js");
const { LanguageModule } = await import("./language.js");
const { EventBus } = await import("./modules.js");
const { stubModule, testHost } = await import("./test-support.js");

const SERVER = "http://localhost:3000";
const PASSWORD = "a-private-password";

const fixture = async (
  localServer: {
    ownsWindow?: () => Promise<boolean>;
    servesWindow?: () => Promise<boolean>;
    signInWithAccount?: () => Promise<void>;
  } = {},
) => {
  const local = {
    ...stubModule("LocalServer"),
    ownsWindow: vi.fn(localServer.ownsWindow ?? (async () => true)),
    servesWindow: vi.fn(localServer.servesWindow ?? (async () => true)),
    signInWithAccount: vi.fn(localServer.signInWithAccount ?? (async () => {})),
  };
  let updateState: UpdateState = { kind: "idle" };
  const updater = {
    ...stubModule("Updater"),
    state: () => updateState,
    install: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
  };
  const diagnostics = {
    ...stubModule("Diagnostics"),
    save: vi.fn(async () => "/Users/me/Downloads/linger-diagnostics.zip"),
  };
  let alwaysOn = false;
  const power = {
    ...stubModule("PowerGuard"),
    alwaysOn: () => alwaysOn,
    active: () => alwaysOn,
    setAlwaysOn: vi.fn((on: boolean) => {
      alwaysOn = on;
      bus.emit("power.changed");
    }),
  };
  const daemon = {
    ...stubModule("ComputerDaemon"),
    connection: () => "online",
    state: () => "ready",
    running: () => 0,
  };
  const driverUpdater = {
    capabilities: vi.fn(() => ({
      platform: "win32" as const,
      nvidiaApp: "nvidia_app" as const,
      directInstallSupported: false,
    })),
    openNvidiaApp: vi.fn(async () => ({ ok: true as const })),
    openOfficialDownload: vi.fn(async () => ({ ok: true as const })),
    openGuide: vi.fn(async () => ({ ok: true as const })),
    installState: vi.fn(() => ({ phase: "idle" as const })),
    startInstall: vi.fn(async () => ({
      ok: false as const,
      reason: "unsupported" as const,
    })),
    clearInstallState: vi.fn(),
  };
  const send = vi.fn();
  const windows = {
    ...stubModule("WindowManager"),
    webContents: () => ({ send }),
    show: vi.fn(),
  };
  const bus = new EventBus();
  const language = new LanguageModule({ systemLanguages: () => ["en-US"] });
  const host = testHost(
    [
      stubModule("Config"),
      language,
      stubModule("Enrollment"),
      power as never,
      daemon as never,
      diagnostics as never,
      windows as never,
      stubModule("WorkspaceGrants"),
      updater as never,
      local as never,
      new DesktopIpcModule({ defaultDisplayName: "Desk", driverUpdater }),
    ],
    { serverUrl: SERVER },
    bus,
  );
  await host.start();
  const invoke = (channel: string, origin = SERVER, ...args: unknown[]) =>
    handlers.get(channel)!({ senderFrame: { origin } }, ...args);
  const setUpdate = (state: UpdateState) => {
    updateState = state;
    bus.emit("update.changed", state.kind);
  };
  return {
    host,
    bus,
    diagnostics,
    driverUpdater,
    language,
    local,
    power,
    updater,
    send,
    setUpdate,
    invoke,
    windows,
  };
};

afterEach(() => handlers.clear());

describe("DesktopIpcModule local account", () => {
  it("offers the account only for the installed server", async () => {
    const f = await fixture({ servesWindow: async () => false });
    expect(await f.invoke(IPC.localAccountAvailable)).toBe(false);
    f.local.servesWindow.mockResolvedValue(true);
    expect(await f.invoke(IPC.localAccountAvailable)).toBe(true);
    await f.host.stop("quit");
  });

  it("reports whether the window points at the installed local server", async () => {
    const f = await fixture({ ownsWindow: async () => false });
    expect(await f.invoke(IPC.localServerOwned)).toBe(false);
    f.local.ownsWindow.mockResolvedValue(true);
    expect(await f.invoke(IPC.localServerOwned)).toBe(true);
    expect(() =>
      f.invoke(IPC.localServerOwned, "https://evil.example.com"),
    ).toThrow("Not allowed");
    await f.host.stop("quit");
  });

  it("rejects pages from any other origin", async () => {
    const f = await fixture();
    expect(() =>
      f.invoke(IPC.localAccountSignIn, "https://evil.example.com"),
    ).toThrow("Not allowed");
    expect(() =>
      f.invoke(IPC.localAccountAvailable, "https://evil.example.com"),
    ).toThrow("Not allowed");
    expect(f.local.signInWithAccount).not.toHaveBeenCalled();
    await f.host.stop("quit");
  });

  it("signs in and returns no account data to the page", async () => {
    const f = await fixture();
    expect(await f.invoke(IPC.localAccountSignIn)).toEqual({ ok: true });
    expect(f.local.signInWithAccount).toHaveBeenCalledOnce();
    await f.host.stop("quit");
  });

  it("returns why signing in failed", async () => {
    const f = await fixture({
      signInWithAccount: async () => {
        throw new Error(
          "The local account file must be private and owned by the current user (chmod 600).",
        );
      },
    });
    const result = await f.invoke(IPC.localAccountSignIn);
    expect(result).toEqual({
      ok: false,
      message:
        "The local account file must be private and owned by the current user (chmod 600).",
    });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    await f.host.stop("quit");
  });
});

describe("DesktopIpcModule voice window", () => {
  it("shows the main window for the server's page only", async () => {
    const f = await fixture();
    await f.invoke(IPC.voiceWindowShowMain);
    expect(f.windows.show).toHaveBeenCalledOnce();
    // macOS raises a window only inside the active app.
    expect(focusApp).toHaveBeenCalledTimes(
      process.platform === "darwin" ? 1 : 0,
    );
    expect(() =>
      f.invoke(IPC.voiceWindowShowMain, "https://evil.example.com"),
    ).toThrow("Not allowed");
    expect(f.windows.show).toHaveBeenCalledOnce();
    await f.host.stop("quit");
  });
});

describe("DesktopIpcModule diagnostics", () => {
  it("saves through the tray's save and returns no path to the page", async () => {
    const f = await fixture();
    expect(await f.invoke(IPC.diagnosticsSave)).toBeUndefined();
    expect(f.diagnostics.save).toHaveBeenCalledOnce();
    expect(() =>
      f.invoke(IPC.diagnosticsSave, "https://evil.example.com"),
    ).toThrow("Not allowed");
    expect(f.diagnostics.save).toHaveBeenCalledOnce();
    await f.host.stop("quit");
  });

  it("rejects when saving fails", async () => {
    const f = await fixture();
    f.diagnostics.save.mockRejectedValueOnce(new Error("disk full"));
    await expect(f.invoke(IPC.diagnosticsSave)).rejects.toThrow("disk full");
    await f.host.stop("quit");
  });
});

describe("DesktopIpcModule updates", () => {
  it("gives the page the update state without its release page URL", async () => {
    const f = await fixture();
    expect(await f.invoke(IPC.updateState)).toEqual({ kind: "idle" });
    f.setUpdate({
      kind: "available",
      version: "0.2.0",
      url: "https://github.com/example/linger/releases/tag/v0.2.0",
    });
    expect(await f.invoke(IPC.updateState)).toEqual({
      kind: "available",
      version: "0.2.0",
    });
    expect(f.send).toHaveBeenLastCalledWith(IPC.updateStateEvent, {
      kind: "available",
      version: "0.2.0",
    });
    await f.host.stop("quit");
  });

  it("pushes each change the tray shows", async () => {
    const f = await fixture();
    f.setUpdate({ kind: "downloading", version: "0.2.0" });
    f.setUpdate({ kind: "ready", version: "0.2.0" });
    f.setUpdate({ kind: "failed", error: "Update package does not match" });
    expect(f.send.mock.calls).toEqual([
      [IPC.updateStateEvent, { kind: "downloading", version: "0.2.0" }],
      [IPC.updateStateEvent, { kind: "ready", version: "0.2.0" }],
      [
        IPC.updateStateEvent,
        { kind: "failed", error: "Update package does not match" },
      ],
    ]);
    await f.host.stop("quit");
    f.setUpdate({ kind: "idle" });
    expect(f.send).toHaveBeenCalledTimes(3);
  });

  it("installs and checks through the updater the tray uses", async () => {
    const f = await fixture();
    await f.invoke(IPC.updateInstall);
    await f.invoke(IPC.updateCheck);
    expect(f.updater.install).toHaveBeenCalledOnce();
    expect(f.updater.check).toHaveBeenCalledOnce();
    await f.host.stop("quit");
  });

  it("rejects update calls from any other origin", async () => {
    const f = await fixture();
    for (const channel of [IPC.updateState, IPC.updateInstall, IPC.updateCheck])
      expect(() => f.invoke(channel, "https://evil.example.com")).toThrow(
        "Not allowed",
      );
    expect(f.updater.install).not.toHaveBeenCalled();
    expect(f.updater.check).not.toHaveBeenCalled();
    await f.host.stop("quit");
  });
});

describe("DesktopIpcModule language", () => {
  it("keeps the page's choice and tells the shell once it changes", async () => {
    const f = await fixture();
    const changed = vi.fn();
    f.bus.on("language.changed", changed);
    expect(f.language.current()).toBe("en");
    await f.invoke(IPC.languageSet, SERVER, "zh-CN");
    expect(f.language.current()).toBe("zh-CN");
    expect(changed).toHaveBeenCalledExactlyOnceWith("zh-CN");
    // The page reports its language on every load; the same one is no news.
    await f.invoke(IPC.languageSet, SERVER, "zh-CN");
    expect(changed).toHaveBeenCalledOnce();
    await f.host.stop("quit");
  });

  it("accepts only the languages the shell speaks, from the server's page", async () => {
    const f = await fixture();
    expect(() => f.invoke(IPC.languageSet, SERVER, "fr")).toThrow();
    expect(() =>
      f.invoke(IPC.languageSet, "https://evil.example.com", "zh-CN"),
    ).toThrow("Not allowed");
    expect(f.language.current()).toBe("en");
    await f.host.stop("quit");
  });
});

describe("DesktopIpcModule settings", () => {
  it("reads, updates, and pushes preventSleep in sync with PowerGuard", async () => {
    const f = await fixture();
    expect(await f.invoke(IPC.settingsGet)).toEqual({
      serverUrl: SERVER,
      displayName: "Desk",
      preventSleep: false,
    });

    expect(
      await f.invoke(IPC.settingsSet, SERVER, { preventSleep: true }),
    ).toEqual({
      serverUrl: SERVER,
      displayName: "Desk",
      preventSleep: true,
    });
    expect(f.power.setAlwaysOn).toHaveBeenCalledWith(true);
    expect(f.send).toHaveBeenCalledWith(IPC.settingsEvent, {
      serverUrl: SERVER,
      displayName: "Desk",
      preventSleep: true,
    });

    // Changes triggered from the tray push updated settings back to the page.
    f.power.setAlwaysOn(false);
    expect(f.send).toHaveBeenLastCalledWith(IPC.settingsEvent, {
      serverUrl: SERVER,
      displayName: "Desk",
      preventSleep: false,
    });
    await f.host.stop("quit");
  });

  it("rejects cross-origin or invalid settings updates", async () => {
    const f = await fixture();
    expect(() =>
      f.invoke(IPC.settingsSet, "https://evil.example.com", {
        preventSleep: true,
      }),
    ).toThrow("Not allowed");
    expect(() =>
      f.invoke(IPC.settingsSet, SERVER, { serverUrl: "https://evil.example" }),
    ).toThrow();
    expect(f.power.setAlwaysOn).not.toHaveBeenCalled();
    await f.host.stop("quit");
  });
});

describe("DesktopIpcModule driverUpdate", () => {
  it("forwards driver update queries and actions from the server origin", async () => {
    const f = await fixture();
    expect(await f.invoke(IPC.driverUpdateCapabilities)).toEqual({
      platform: "win32",
      nvidiaApp: "nvidia_app",
      directInstallSupported: false,
    });
    expect(await f.invoke(IPC.driverUpdateOpenNvidiaApp)).toEqual({ ok: true });
    expect(await f.invoke(IPC.driverUpdateOpenDownload)).toEqual({ ok: true });
    expect(await f.invoke(IPC.driverUpdateOpenGuide)).toEqual({ ok: true });
    expect(await f.invoke(IPC.driverUpdateInstallState)).toEqual({
      phase: "idle",
    });
    expect(
      await f.invoke(IPC.driverUpdateStartInstall, SERVER, {
        gpuName: "NVIDIA GeForce RTX 5060",
        requiredCuda: "13.0",
        resumeModelId: "inkling-2-mini-q3-poly:UD-Q3_K_XL",
      }),
    ).toEqual({ ok: false, reason: "unsupported" });
    expect(f.driverUpdater.openNvidiaApp).toHaveBeenCalledOnce();
    expect(f.driverUpdater.openOfficialDownload).toHaveBeenCalledOnce();
    expect(f.driverUpdater.openGuide).toHaveBeenCalledOnce();
    expect(f.driverUpdater.startInstall).toHaveBeenCalledWith({
      gpuName: "NVIDIA GeForce RTX 5060",
      requiredCuda: "13.0",
      resumeModelId: "inkling-2-mini-q3-poly:UD-Q3_K_XL",
    });

    await f.invoke(IPC.driverUpdateClearState);
    expect(f.driverUpdater.clearInstallState).toHaveBeenCalledOnce();

    f.driverUpdater.installState.mockReturnValue({
      phase: "verifying",
      version: "621.24",
    } as never);
    f.bus.emit("driver-update.changed");
    expect(f.send).toHaveBeenCalledWith(IPC.driverUpdateInstallStateEvent, {
      phase: "verifying",
      version: "621.24",
    });
    await f.host.stop("quit");
  });

  it("rejects untrusted origins and invalid startInstall payloads", async () => {
    const f = await fixture();
    for (const channel of [
      IPC.driverUpdateCapabilities,
      IPC.driverUpdateOpenNvidiaApp,
      IPC.driverUpdateOpenDownload,
      IPC.driverUpdateOpenGuide,
      IPC.driverUpdateInstallState,
      IPC.driverUpdateStartInstall,
      IPC.driverUpdateClearState,
    ]) {
      expect(() => f.invoke(channel, "https://evil.example.com")).toThrow(
        "Not allowed",
      );
    }
    expect(() =>
      f.invoke(IPC.driverUpdateStartInstall, SERVER, {
        requiredCuda: "bad;rm -rf /",
      }),
    ).toThrow();
    expect(f.driverUpdater.startInstall).not.toHaveBeenCalled();
    await f.host.stop("quit");
  });
});
