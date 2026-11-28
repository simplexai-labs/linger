import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { EventEmitter } =
    require("node:events") as typeof import("node:events");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const windows: MockBrowserWindow[] = [];
  const ipcHandlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown
  >();

  class MockWebContents extends EventEmitter {
    destroyed = false;
    readonly send = vi.fn();
    readonly setWindowOpenHandler = vi.fn();
    isDestroyed(): boolean {
      return this.destroyed;
    }
  }

  class MockBrowserWindow extends EventEmitter {
    readonly webContents = new MockWebContents();
    destroyed = false;
    visible = false;
    readonly show = vi.fn(() => {
      this.visible = true;
      this.emit("show");
    });
    readonly focus = vi.fn();
    readonly close = vi.fn(() => {
      this.destroyed = true;
      this.visible = false;
      this.emit("closed");
    });
    readonly destroy = vi.fn(() => {
      this.destroyed = true;
      this.visible = false;
    });
    readonly loadURL = vi.fn(async () => {});
    isDestroyed(): boolean {
      return this.destroyed;
    }
    isVisible(): boolean {
      return this.visible;
    }
    constructor() {
      super();
      windows.push(this);
    }
  }

  const cookies = new EventEmitter();
  const partitionSession = {
    protocol: {
      handle: vi.fn(),
      unhandle: vi.fn(),
    },
  };

  return { windows, ipcHandlers, MockBrowserWindow, cookies, partitionSession };
});

vi.mock("electron", () => ({
  BrowserWindow: state.MockBrowserWindow,
  Notification: class {
    static isSupported(): boolean {
      return false;
    }
  },
  clipboard: { readText: vi.fn(() => ""), writeText: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn(
      (
        channel: string,
        handler: (event: unknown, ...args: unknown[]) => unknown,
      ) => {
        state.ipcHandlers.set(channel, handler);
      },
    ),
    removeHandler: vi.fn((channel: string) => {
      state.ipcHandlers.delete(channel);
    }),
  },
  nativeImage: {
    createFromBuffer: vi.fn(() => ({})),
  },
  session: {
    defaultSession: { cookies: state.cookies },
    fromPartition: vi.fn(() => state.partitionSession),
  },
  shell: {
    openExternal: vi.fn(async () => {}),
    showItemInFolder: vi.fn(),
  },
}));

vi.mock("../../resources/icon.png", () => ({
  default: new Uint8Array([1, 2]),
}));
vi.mock("../../resources/logo-horizontal.png", () => ({
  default: new Uint8Array([1, 2]),
}));
vi.mock("../../resources/brand/codex.png", () => ({
  default: new Uint8Array([1, 2]),
}));
vi.mock(
  "../../../linger-installer/public/onboarding/welcome-scene.png",
  () => ({
    default: new Uint8Array([1, 2]),
  }),
);
vi.mock(
  "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2",
  () => ({
    default: new Uint8Array([1, 2]),
  }),
);
vi.mock("../shell/messages.html", () => ({
  default: "<script>/* messages */</script>",
}));
vi.mock("../shell/setup.html", () => ({
  default: '<html lang="en"><script>/* setup */</script></html>',
}));

import { SETUP_IPC, type SetupState } from "../shared/setup.js";
import { ConfigStore } from "./config.js";
import { LanguageModule } from "./language.js";
import type { LocalServerStatus } from "./local-server.js";
import { EventBus, ModuleHost, type Module } from "./modules.js";
import { SetupWindowModule } from "./setup-window.js";
import {
  silentLog,
  stubModule,
  tempDirectory,
  testHost,
} from "./test-support.js";

function setupHost(options: {
  initialComputerId?: string;
  onLocalServerStart?: (config: ConfigStore) => void;
  show: boolean | ((config: ConfigStore) => boolean);
  localStatus?: () => LocalServerStatus;
  refreshLocationSpace?: () => Promise<void>;
}) {
  const config = new ConfigStore(path.join(tempDirectory(), "config.json"), {
    ...(options.initialComputerId
      ? {
          serverUrl: "http://localhost:3000",
          computerId: options.initialComputerId,
        }
      : {}),
  });
  const inspect = vi.fn();
  const cancelPrestage = vi.fn();
  const refreshLocationSpace = vi.fn(
    options.refreshLocationSpace ?? (async () => {}),
  );
  const defaultStatus = (): LocalServerStatus => ({
    available: true,
    phase: "idle",
    message: "",
    steps: ["prepare", "services", "connect", "agents"],
    step: "prepare",
    progress: 0,
    attempt: 0,
    localModels: { state: "unchecked" },
    location: { path: "/tmp/linger", custom: false },
    keys: { composio: false },
  });
  const localServer: Module = {
    name: "LocalServer",
    dependsOn: ["WindowManager", "Enrollment"],
    start: async () => {
      options.onLocalServerStart?.(config);
    },
    stop: async () => {},
    ...({
      inspect,
      cancelPrestage,
      refreshLocationSpace,
      status: () => options.localStatus?.() ?? defaultStatus(),
    } as Record<string, unknown>),
  };
  const showOption = options.show;
  const setup = new SetupWindowModule({
    preload: "/preload/setup.cjs",
    version: "0.16.20",
    defaultDisplayName: "Desk",
    show:
      typeof showOption === "function" ? () => showOption(config) : showOption,
    loginItem: { get: () => false, set: () => {} },
  });
  const host = new ModuleHost(
    [
      stubModule("Config"),
      new LanguageModule({ systemLanguages: () => ["en-US"] }),
      {
        ...stubModule("Diagnostics"),
        ...({
          uploadUrl: () => undefined,
          sender: { state: () => ({ phase: "idle" }) },
        } as Record<string, unknown>),
      },
      {
        ...stubModule("Enrollment"),
        ...({ signedIn: async () => false } as Record<string, unknown>),
      },
      {
        ...stubModule("PowerGuard"),
        ...({ alwaysOn: () => false } as Record<string, unknown>),
      },
      stubModule("WindowManager"),
      stubModule("WorkspaceGrants"),
      localServer,
      setup,
    ],
    {
      config,
      log: silentLog,
      bus: new EventBus(),
    },
  );
  return {
    host,
    config,
    inspect,
    cancelPrestage,
    refreshLocationSpace,
    setup,
  };
}

describe("SetupWindowModule", () => {
  beforeEach(() => {
    state.windows.length = 0;
    state.ipcHandlers.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("evaluates a show predicate after LocalServer.start() so orphaned recovery opens Setup", async () => {
    const { host, inspect, setup } = setupHost({
      initialComputerId: "cmp_orphaned",
      onLocalServerStart: (config) => {
        // Simulates LocalServer.start() resetting an orphaned local server.
        config.update({
          serverUrl: undefined,
          computerId: undefined,
          localServer: undefined,
        });
      },
      show: (config) => !config.get().computerId,
    });

    await host.start();

    expect(state.windows).toHaveLength(1);
    expect(setup.visible()).toBe(true);
    expect(inspect).toHaveBeenCalledOnce();
    await host.stop("quit");
  });

  it("stays closed when the show predicate returns false (enrolled or --background)", async () => {
    const enrolled = setupHost({
      initialComputerId: "cmp_1",
      show: (config) => !config.get().computerId,
    });
    await enrolled.host.start();
    expect(state.windows).toHaveLength(0);
    expect(enrolled.setup.visible()).toBe(false);
    await enrolled.host.stop("quit");

    const background = setupHost({
      show: () => false,
    });
    await background.host.start();
    expect(state.windows).toHaveLength(0);
    await background.host.stop("quit");
  });

  it("serves the Local models page's logos to the setup page", async () => {
    const shown = setupHost({ show: true });
    await shown.host.start();
    try {
      const serve = state.partitionSession.protocol.handle.mock.calls.at(
        -1,
      )![1] as (request: Request) => Response;
      const svg = serve(new Request("app://setup/model-logo/qwen.svg"));
      expect(svg.status).toBe(200);
      expect(svg.headers.get("content-type")).toBe("image/svg+xml");
      const png = serve(
        new Request("app://setup/model-logo/thinkingmachines.png"),
      );
      expect(png.headers.get("content-type")).toBe("image/png");
      // Nothing else under the folder, and no prototype keys.
      expect(
        serve(new Request("app://setup/model-logo/other.svg")).headers.get(
          "content-type",
        ),
      ).not.toMatch(/^image\//);
      expect(
        serve(new Request("app://setup/constructor")).headers.get(
          "content-type",
        ),
      ).not.toMatch(/^image\//);
    } finally {
      await shown.host.stop("quit");
    }
  });

  it("still accepts a boolean show option", async () => {
    const shown = setupHost({ show: true });
    await shown.host.start();
    expect(state.windows).toHaveLength(1);
    await shown.host.stop("quit");
  });

  it("cancels idle pre-staging when the setup window closes", async () => {
    const inspect = vi.fn();
    const cancelPrestage = vi.fn();
    const bus = new EventBus();
    const setup = new SetupWindowModule({
      preload: "/preload.js",
      version: "0.17.0",
      defaultDisplayName: "My Mac",
      show: true,
      loginItem: { get: () => false, set: () => {} },
    });

    const host = testHost(
      [
        {
          ...stubModule("Diagnostics"),
          uploadUrl: () => undefined,
          sender: { state: () => ({ phase: "idle" }), cancel: vi.fn() },
        } as never,
        {
          ...stubModule("Enrollment"),
          signedIn: vi.fn(async () => false),
        } as never,
        {
          ...stubModule("Language"),
          current: () => "en",
          t: (message: { en: string }) => message.en,
        } as never,
        {
          ...stubModule("LocalServer"),
          inspect,
          cancelPrestage,
          refreshLocationSpace: vi.fn(async () => {}),
          account: vi.fn(),
          status: () => ({
            available: true,
            phase: "idle",
            message: "",
            steps: [],
            step: "prepare",
            progress: 0,
            attempt: 0,
            localModels: { state: "unchecked" },
            location: { path: "/home", custom: false },
            keys: { composio: false },
          }),
        } as never,
        {
          ...stubModule("PowerGuard"),
          alwaysOn: () => false,
        } as never,
        {
          ...stubModule("WindowManager"),
          show: vi.fn(),
          markOpenFromSetup: vi.fn(),
        } as never,
        {
          ...stubModule("WorkspaceGrants"),
        } as never,
        setup,
      ],
      {},
      bus,
    );

    await host.start();
    expect(state.windows).toHaveLength(1);
    expect(inspect).toHaveBeenCalledOnce();
    expect(cancelPrestage).not.toHaveBeenCalled();

    state.windows[0]!.emit("closed");
    expect(cancelPrestage).toHaveBeenCalledOnce();

    await host.stop("quit");
  });

  it("awaits refreshLocationSpace before returning initial state over SETUP_IPC.state", async () => {
    const GiB = 1024 ** 3;
    let freeBytes: number | undefined;
    let finishRefresh!: () => void;
    const { host, refreshLocationSpace } = setupHost({
      show: true,
      localStatus: () => ({
        available: true,
        phase: "idle",
        message: "",
        steps: ["prepare", "services", "connect", "agents"],
        step: "prepare",
        progress: 0,
        attempt: 0,
        localModels: { state: "unchecked" },
        location: {
          path: "/tmp/linger",
          custom: false,
          ...(freeBytes !== undefined
            ? { freeBytes, minFreeBytes: 20 * GiB }
            : {}),
        },
        keys: { composio: false },
      }),
      refreshLocationSpace: async () => {
        await new Promise<void>((resolve) => {
          finishRefresh = () => {
            freeBytes = 12 * GiB;
            resolve();
          };
        });
      },
    });
    await host.start();
    try {
      const window = state.windows[0]!;
      const handler = state.ipcHandlers.get(SETUP_IPC.state)!;
      const pending = handler({
        sender: window.webContents,
        senderFrame: { url: "app://setup/" },
      }) as Promise<SetupState>;
      expect(refreshLocationSpace).toHaveBeenCalledOnce();
      finishRefresh();
      const result = await pending;
      expect(result.localServer.location).toEqual({
        path: "/tmp/linger",
        custom: false,
        freeBytes: 12 * GiB,
        minFreeBytes: 20 * GiB,
      });
    } finally {
      await host.stop("quit");
    }
  });

  it("refreshes location space on window focus with throttling and skips when ready or unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
    let available = true;
    let phase: LocalServerStatus["phase"] = "idle";
    const { host, refreshLocationSpace } = setupHost({
      show: true,
      localStatus: () => ({
        available,
        phase,
        message: "",
        steps: ["prepare", "services", "connect", "agents"],
        step: "prepare",
        progress: 0,
        attempt: 0,
        localModels: { state: "unchecked" },
        location: { path: "/tmp/linger", custom: false },
        keys: { composio: false },
      }),
    });
    await host.start();
    try {
      const window = state.windows[0]!;
      window.emit("focus");
      expect(refreshLocationSpace).toHaveBeenCalledTimes(1);

      // Within the 2000 ms throttle window: skipped.
      vi.advanceTimersByTime(1999);
      window.emit("focus");
      expect(refreshLocationSpace).toHaveBeenCalledTimes(1);

      // Past 2000 ms while failed: refreshes again.
      phase = "failed";
      vi.advanceTimersByTime(1);
      window.emit("focus");
      expect(refreshLocationSpace).toHaveBeenCalledTimes(2);

      // Ready phase: skipped even past the throttle window.
      phase = "ready";
      vi.advanceTimersByTime(3000);
      window.emit("focus");
      expect(refreshLocationSpace).toHaveBeenCalledTimes(2);

      // Unavailable: skipped.
      phase = "idle";
      available = false;
      vi.advanceTimersByTime(3000);
      window.emit("focus");
      expect(refreshLocationSpace).toHaveBeenCalledTimes(2);
    } finally {
      await host.stop("quit");
    }
  });

  it("throttles immediate focus refresh after SETUP_IPC.state and shortens rejectedPath under homedir", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
    const home = os.homedir();
    const rejectedInHome = path.join(home, "locked-linger");
    const { host, refreshLocationSpace } = setupHost({
      show: true,
      localStatus: () => ({
        available: true,
        phase: "idle",
        message: "",
        steps: ["prepare", "services", "connect", "agents"],
        step: "prepare",
        progress: 0,
        attempt: 0,
        localModels: { state: "unchecked" },
        location: {
          path: path.join(home, ".linger"),
          custom: false,
          error: "Linger can't write to this folder. Choose another one.",
          rejectedPath: rejectedInHome,
        },
        keys: { composio: false },
      }),
    });
    await host.start();
    try {
      const window = state.windows[0]!;
      const handler = state.ipcHandlers.get(SETUP_IPC.state)!;
      const result = (await handler({
        sender: window.webContents,
        senderFrame: { url: "app://setup/" },
      })) as SetupState;
      expect(refreshLocationSpace).toHaveBeenCalledTimes(1);
      expect(result.localServer.location.path).toBe(`~${path.sep}.linger`);
      expect(result.localServer.location.rejectedPath).toBe(
        `~${path.sep}locked-linger`,
      );

      // An immediate focus event right after SETUP_IPC.state does not fire a redundant probe.
      window.emit("focus");
      expect(refreshLocationSpace).toHaveBeenCalledTimes(1);

      // Past the 2000 ms throttle window, focus refreshes again.
      vi.advanceTimersByTime(2000);
      window.emit("focus");
      expect(refreshLocationSpace).toHaveBeenCalledTimes(2);
    } finally {
      await host.stop("quit");
    }
  });

  it("tracks windowShown from false before ready-to-show to true on show and resets on close", async () => {
    const { host, setup } = setupHost({ show: true });
    await host.start();
    try {
      const first = state.windows[0]!;
      const handler = state.ipcHandlers.get(SETUP_IPC.state)!;
      const beforeShow = (await handler({
        sender: first.webContents,
        senderFrame: { url: "app://setup/" },
      })) as SetupState;
      expect(beforeShow.windowShown).toBe(false);

      first.emit("ready-to-show");
      expect(first.show).toHaveBeenCalledOnce();
      expect(first.webContents.send).toHaveBeenCalledWith(
        SETUP_IPC.stateEvent,
        expect.objectContaining({ windowShown: true }),
      );
      const afterShow = (await handler({
        sender: first.webContents,
        senderFrame: { url: "app://setup/" },
      })) as SetupState;
      expect(afterShow.windowShown).toBe(true);

      // Closing and recreating resets windowShown until the new window shows.
      first.close();
      setup.show();
      const second = state.windows[1]!;
      const reopened = (await handler({
        sender: second.webContents,
        senderFrame: { url: "app://setup/" },
      })) as SetupState;
      expect(reopened.windowShown).toBe(false);
    } finally {
      await host.stop("quit");
    }
  });
});
