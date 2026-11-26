import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { EventEmitter } =
    require("node:events") as typeof import("node:events");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const windows: MockBrowserWindow[] = [];

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
    readonly show = vi.fn();
    readonly focus = vi.fn();
    readonly close = vi.fn(() => {
      this.destroyed = true;
      this.emit("closed");
    });
    readonly destroy = vi.fn(() => {
      this.destroyed = true;
    });
    readonly loadURL = vi.fn(async () => {});
    isDestroyed(): boolean {
      return this.destroyed;
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

  return { windows, MockBrowserWindow, cookies, partitionSession };
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
    handle: vi.fn(),
    removeHandler: vi.fn(),
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

import { ConfigStore } from "./config.js";
import { LanguageModule } from "./language.js";
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
      status: () => ({ phase: "idle" }),
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
      stubModule("Diagnostics"),
      stubModule("Enrollment"),
      stubModule("PowerGuard"),
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
  return { host, config, inspect, cancelPrestage, setup };
}

describe("SetupWindowModule", () => {
  beforeEach(() => {
    state.windows.length = 0;
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
});
