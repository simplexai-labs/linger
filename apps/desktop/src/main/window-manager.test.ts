import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { EventEmitter } =
    require("node:events") as typeof import("node:events");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const windows: MockBaseWindow[] = [];
  const views: MockWebContentsView[] = [];
  const netFetch = vi.fn();

  class MockWebContents extends EventEmitter {
    readonly id = 1;
    readonly navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: () => {},
      goForward: () => {},
    };
    url = "";
    loading = false;
    destroyed = false;
    readonly loadURL = vi.fn(async (nextUrl: string) => {
      this.url = nextUrl;
      this.loading = true;
    });
    readonly reload = vi.fn();
    readonly focus = vi.fn();
    readonly send = vi.fn();
    readonly close = vi.fn(() => {
      this.destroyed = true;
    });
    readonly setWindowOpenHandler = vi.fn();
    getURL(): string {
      return this.url;
    }
    isLoading(): boolean {
      return this.loading;
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
  }

  class MockWebContentsView {
    readonly webContents = new MockWebContents();
    readonly setBackgroundColor = vi.fn();
    readonly setBounds = vi.fn();
    constructor() {
      views.push(this);
    }
  }

  class MockBaseWindow extends EventEmitter {
    readonly contentView = { addChildView: vi.fn() };
    readonly show = vi.fn(() => {
      this.visible = true;
    });
    readonly hide = vi.fn(() => {
      this.visible = false;
    });
    readonly focus = vi.fn();
    readonly restore = vi.fn();
    readonly minimize = vi.fn();
    readonly maximize = vi.fn();
    readonly unmaximize = vi.fn();
    readonly close = vi.fn();
    readonly destroy = vi.fn(() => {
      this.destroyed = true;
    });
    readonly getContentBounds = () => ({ width: 1280, height: 820 });
    readonly getNormalBounds = () => ({ x: 0, y: 0, width: 1280, height: 820 });
    readonly isMinimized = () => false;
    readonly isMaximized = () => false;
    readonly isFocused = () => true;
    readonly isDestroyed = () => this.destroyed;
    visible: boolean;
    destroyed = false;
    readonly options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      super();
      this.options = options;
      this.visible = options.show !== false;
      windows.push(this);
    }
  }

  return { windows, views, netFetch, MockBaseWindow, MockWebContentsView };
});

vi.mock("electron", () => ({
  BaseWindow: state.MockBaseWindow,
  WebContentsView: state.MockWebContentsView,
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  nativeImage: {
    createFromBuffer: vi.fn(() => ({})),
  },
  net: {
    fetch: (...args: unknown[]) => state.netFetch(...args),
  },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
    unhandle: vi.fn(),
  },
  session: {
    defaultSession: {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      webRequest: { onHeadersReceived: vi.fn() },
    },
  },
  shell: {
    openExternal: vi.fn(async () => {}),
  },
}));

vi.mock("../../resources/icon.png", () => ({
  default: new Uint8Array([1, 2]),
}));
vi.mock("../shell/offline.html", () => ({
  default: '<html lang="en"><script>/* offline */</script></html>',
}));
vi.mock("../shell/titlebar.html", () => ({
  default: '<html lang="en"><script>/* titlebar */</script></html>',
}));
vi.mock("../shell/messages.html", () => ({
  default: "<script>/* messages */</script>",
}));

import { protocol, session } from "electron";

import { IPC } from "../shared/api.js";
import { ConfigStore } from "./config.js";
import zhCN from "../i18n/locales/zh-CN.json" with { type: "json" };
import { LanguageModule } from "./language.js";
import { EventBus, ModuleHost, type Module } from "./modules.js";
import { PreviewViews } from "./preview-views.js";
import { tempDirectory } from "./test-support.js";
import { WindowManagerModule } from "./window-manager.js";

const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

function setup(
  configPatch: Record<string, unknown> = {},
  options: {
    background?: boolean;
    localServerResumable?: (serverUrl: string) => Promise<boolean>;
  } = {},
) {
  const logs: Array<{
    level: string;
    event: string;
    fields?: Record<string, unknown>;
  }> = [];
  const bus = new EventBus();
  const config = new ConfigStore(
    path.join(tempDirectory(), "config.json"),
    configPatch,
  );
  const diagnosticsStub: Module = {
    name: "Diagnostics",
    dependsOn: [],
    start: async () => {},
    stop: async () => {},
  };
  Object.assign(diagnosticsStub, { uploadUrl: () => undefined });
  const language = new LanguageModule({ systemLanguages: () => ["en-US"] });
  const manager = new WindowManagerModule({
    preload: "/preload.cjs",
    shellPreload: "/shell.cjs",
    background: options.background ?? false,
    ...(options.localServerResumable
      ? { localServerResumable: options.localServerResumable }
      : {}),
  });
  const host = new ModuleHost(
    [
      {
        name: "Config",
        dependsOn: [],
        start: async () => {},
        stop: async () => {},
      },
      diagnosticsStub,
      language,
      manager,
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
  return { manager, host, config, bus, logs, language };
}

function contentView() {
  return state.views.at(-1)!;
}

function titlebarView() {
  return state.views.length > 1 ? state.views[0] : undefined;
}

describe("WindowManagerModule", () => {
  beforeEach(() => {
    state.windows.length = 0;
    state.views.length = 0;
    state.netFetch.mockReset();
  });

  it("skips duplicate loadURL on hot start when local_ready matches boot origin", async () => {
    const local = "http://localhost:3000";
    const { manager, host } = setup({ serverUrl: local });
    await host.start();

    const content = contentView().webContents;
    expect(content.loadURL).toHaveBeenCalledTimes(1);
    expect(content.loadURL).toHaveBeenCalledWith(local);

    manager.setServer(local, undefined, { reason: "local_ready" });
    await flush();
    expect(content.loadURL).toHaveBeenCalledTimes(1);
    await host.stop("quit");
  });

  it("shows starting instead of offline on cold resume failure and reloads once ready", async () => {
    const local = "http://localhost:3000";
    const { manager, host } = setup(
      { serverUrl: local },
      { localServerResumable: async () => true },
    );
    await host.start();

    const content = contentView().webContents;
    expect(content.loadURL).toHaveBeenCalledTimes(1);

    content.emit(
      "did-fail-load",
      {},
      -102,
      "ERR_CONNECTION_REFUSED",
      local,
      true,
    );
    await flush();
    expect(content.loadURL).toHaveBeenCalledTimes(2);
    expect(content.loadURL).toHaveBeenLastCalledWith(
      "app://offline/?starting=1",
    );

    manager.setServer(local, local, { reason: "resume_ready" });
    await flush();
    expect(content.loadURL).toHaveBeenCalledTimes(3);
    expect(content.loadURL).toHaveBeenLastCalledWith(local);
    await host.stop("quit");
  });

  it("leaves app://offline/?starting=1, syncs the titlebar to the new port, and ignores stale old-port load failures", async () => {
    const previousPort = "http://localhost:62986";
    const movedPort = "http://localhost:63009";
    let resolveResumable!: (value: boolean) => void;
    const { manager, host, config } = setup(
      { serverUrl: previousPort },
      {
        localServerResumable: () =>
          new Promise<boolean>((resolve) => {
            resolveResumable = resolve;
          }),
      },
    );
    await host.start();

    const content = contentView().webContents;
    const titlebar = titlebarView()?.webContents;
    // Simulate boot failing on the old port while resume moves it to 63009.
    content.emit(
      "did-fail-load",
      {},
      -102,
      "ERR_CONNECTION_REFUSED",
      `${previousPort}/`,
      true,
    );
    manager.showStarting();
    expect(content.loadURL).toHaveBeenLastCalledWith(
      "app://offline/?starting=1",
    );

    manager.setServer(movedPort, previousPort, { reason: "resume_ready" });
    // Titlebar updates immediately on serverUrl change before setImmediate.
    expect(config.get().serverUrl).toBe(movedPort);
    if (titlebar) {
      expect(titlebar.send).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({ title: "localhost:63009" }),
      );
    }

    // Late resolution of the old port's resumable check and a late
    // did-fail-load for the superseded port must not trap the window on
    // Starting.
    resolveResumable(true);
    await flush();
    expect(content.loadURL).toHaveBeenLastCalledWith(movedPort);

    const loadsAfterMove = content.loadURL.mock.calls.length;
    content.emit(
      "did-fail-load",
      {},
      -102,
      "ERR_CONNECTION_REFUSED",
      `${previousPort}/`,
      true,
    );
    await flush();
    expect(content.loadURL).toHaveBeenCalledTimes(loadsAfterMove);
    expect(content.loadURL).toHaveBeenLastCalledWith(movedPort);
    await host.stop("quit");
  });

  it("ignores stale localServerResumable checks from an earlier did-fail-load on the same origin", async () => {
    const local = "http://localhost:3000";
    const resolvers: Array<(value: boolean) => void> = [];
    const { manager, host } = setup(
      { serverUrl: local },
      {
        localServerResumable: () =>
          new Promise<boolean>((resolve) => {
            resolvers.push(resolve);
          }),
      },
    );
    await host.start();

    const content = contentView().webContents;
    // First load fails while localServerResumable is still pending.
    content.emit(
      "did-fail-load",
      {},
      -102,
      "ERR_CONNECTION_REFUSED",
      `${local}/`,
      true,
    );
    // A retry triggers a new load that also fails.
    manager.loadServer("retry");
    content.emit(
      "did-fail-load",
      {},
      -102,
      "ERR_CONNECTION_REFUSED",
      `${local}/`,
      true,
    );
    expect(resolvers).toHaveLength(2);

    // Resolving the first (superseded) check with true must not trap the window
    // on Starting; the second check decides the fallback page.
    resolvers[0]!(true);
    await flush();
    expect(content.loadURL).toHaveBeenLastCalledWith(local);

    resolvers[1]!(false);
    await flush();
    expect(content.loadURL).toHaveBeenLastCalledWith(
      `app://offline/?server=${encodeURIComponent(local)}&error=ERR_CONNECTION_REFUSED`,
    );
    await host.stop("quit");
  });

  it("reloads on port move and keeps a user-selected remote server", async () => {
    const local = "http://localhost:3000";
    const moved = "http://localhost:3001";
    const remote = "https://remote.example.com";
    const { manager, host, bus, config } = setup({ serverUrl: local });
    const movedListener = vi.fn();
    bus.on("server.moved", movedListener);
    await host.start();

    const content = contentView().webContents;
    content.loading = false;
    content.emit("did-finish-load");

    manager.setServer(moved, local, { reason: "resume_ready" });
    await flush();
    expect(movedListener).toHaveBeenCalledWith(local, moved);
    expect(config.get().serverUrl).toBe(moved);
    expect(content.loadURL).toHaveBeenLastCalledWith(moved);

    manager.setServer(remote, undefined, { reason: "server_changed" });
    await flush();
    expect(config.get().serverUrl).toBe(remote);
    expect(content.loadURL).toHaveBeenLastCalledWith(remote);

    const loadsBefore = content.loadURL.mock.calls.length;
    manager.setServer(moved, local, { reason: "resume_ready" });
    await flush();
    expect(config.get().serverUrl).toBe(remote);
    expect(content.loadURL).toHaveBeenCalledTimes(loadsBefore);
    await host.stop("quit");
  });

  it("reloads on retry after start-failed or remote offline failure", async () => {
    const remote = "https://remote.example.com";
    const { manager, host, bus } = setup(
      { serverUrl: remote },
      { localServerResumable: async () => false },
    );
    const unreachable = vi.fn();
    bus.on("local-server.unreachable", unreachable);
    await host.start();

    const content = contentView().webContents;
    content.emit(
      "did-fail-load",
      {},
      -105,
      "ERR_NAME_NOT_RESOLVED",
      remote,
      true,
    );
    await flush();
    expect(content.loadURL).toHaveBeenLastCalledWith(
      `app://offline/?server=${encodeURIComponent(remote)}&error=ERR_NAME_NOT_RESOLVED`,
    );
    // The local server, when it is the one shown, checks itself.
    expect(unreachable).toHaveBeenCalledOnce();

    manager.loadServer("retry");
    expect(content.loadURL).toHaveBeenLastCalledWith(remote);

    manager.showStartFailed("broken");
    expect(content.loadURL).toHaveBeenLastCalledWith(
      "app://offline/?failed=broken",
    );

    manager.loadServer("retry");
    expect(content.loadURL).toHaveBeenLastCalledWith(remote);
    await host.stop("quit");
  });

  it("logs window.did_finish_load without query or hash and records zero setup-to-load when already loaded", async () => {
    const remote = "https://remote.example.com";
    const { manager, host, logs } = setup({ serverUrl: remote });
    await host.start();

    const content = contentView().webContents;
    content.url = `${remote}/rooms/1?token=secret#frag`;
    content.loading = false;
    content.emit("did-finish-load");

    expect(logs).toContainEqual({
      level: "info",
      event: "window.did_finish_load",
      fields: {
        reason: "boot",
        duration_ms: expect.any(Number),
        target: `${remote}/rooms/1`,
      },
    });

    manager.markOpenFromSetup();
    expect(logs).toContainEqual({
      level: "info",
      event: "local_server.timing",
      fields: { step: "open_linger_to_load", ms: 0 },
    });
    await host.stop("quit");
  });

  it("preloads authenticated window hidden and reveals it on show without reloading", async () => {
    const local = "http://localhost:3000";
    const { manager, host } = setup(
      { serverUrl: local, computerId: "cmp_1" },
      { background: true },
    );
    await host.start();
    expect(state.windows).toHaveLength(0);

    manager.preloadAuthenticated(local);
    expect(state.windows).toHaveLength(1);
    const win = state.windows[0]!;
    expect(win.options.show).toBe(false);
    expect(win.show).not.toHaveBeenCalled();

    const content = contentView().webContents;
    expect(content.loadURL).toHaveBeenCalledTimes(1);
    expect(content.loadURL).toHaveBeenCalledWith(local);

    content.loading = false;
    content.emit("did-finish-load");
    expect(win.show).not.toHaveBeenCalled();

    manager.setServer(local, local, { reason: "resume_ready" });
    await flush();
    expect(content.loadURL).toHaveBeenCalledTimes(1);

    manager.show();
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(content.loadURL).toHaveBeenCalledTimes(1);
    await host.stop("quit");
  });

  it("prewarms / and /assets/* static assets and swallows errors", async () => {
    const local = "http://localhost:3000";
    const { manager, host } = setup({ serverUrl: local }, { background: true });
    await host.start();

    state.netFetch.mockImplementation(async (url: string) => {
      if (url === `${local}/`) {
        return new Response(
          '<html><head><link rel="modulepreload" href="/assets/vendor.js"><link href="/assets/app.css" rel="stylesheet"></head><body><script type="module" src="/assets/index.js"></script></body></html>',
          { status: 200 },
        );
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });

    await manager.prewarmAssets(local);
    expect(state.netFetch.mock.calls.map((c) => c[0])).toEqual([
      `${local}/`,
      `${local}/assets/index.js`,
      `${local}/assets/vendor.js`,
      `${local}/assets/app.css`,
    ]);

    state.netFetch.mockRejectedValueOnce(new Error("offline"));
    await expect(manager.prewarmAssets(local)).resolves.toBeUndefined();
    await host.stop("quit");
  });

  it("registers no ready-to-show listener on BaseWindow and reveals on did-finish-load", async () => {
    const remote = "https://remote.example.com";
    const { host } = setup({ serverUrl: remote });
    await host.start();

    const win = state.windows[0]!;
    expect(win.listenerCount("ready-to-show")).toBe(0);
    expect(win.show).not.toHaveBeenCalled();

    const content = contentView().webContents;
    content.loading = false;
    content.emit("did-finish-load");

    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);

    // Subsequent loads do not re-reveal the window.
    content.emit("did-finish-load");
    expect(win.show).toHaveBeenCalledTimes(1);
    await host.stop("quit");
  });

  it("reveals the hidden window on did-fail-load without waiting for fallback load", async () => {
    const remote = "https://remote.example.com";
    const { host } = setup(
      { serverUrl: remote },
      { localServerResumable: async () => false },
    );
    await host.start();

    const win = state.windows[0]!;
    expect(win.show).not.toHaveBeenCalled();

    const content = contentView().webContents;
    content.emit(
      "did-fail-load",
      {},
      -105,
      "ERR_NAME_NOT_RESOLVED",
      remote,
      true,
    );

    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);

    await flush();
    content.emit("did-finish-load");
    expect(win.show).toHaveBeenCalledTimes(1);
    await host.stop("quit");
  });

  it("reveals the hidden window via timeout fallback when load stalls", async () => {
    vi.useFakeTimers();
    try {
      const remote = "https://slow.example.com";
      const { host } = setup({ serverUrl: remote });
      await host.start();

      const win = state.windows[0]!;
      expect(win.show).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1_499);
      expect(win.show).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(win.show).toHaveBeenCalledTimes(1);
      expect(win.focus).toHaveBeenCalledTimes(1);
      await host.stop("quit");
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the previews of a page that navigates away or crashes", async () => {
    const closeAll = vi.spyOn(PreviewViews.prototype, "closeAll");
    const { host } = setup({ serverUrl: "http://localhost:3000" });
    await host.start();
    const content = contentView().webContents;
    closeAll.mockClear();
    content.emit("did-navigate-in-page");
    expect(closeAll).not.toHaveBeenCalled();
    content.emit("did-navigate");
    content.emit("render-process-gone");
    expect(closeAll).toHaveBeenCalledTimes(2);
    await host.stop("quit");
    closeAll.mockRestore();
  });

  it("keeps framing rules for the preview frame and reports a refusal", async () => {
    const local = "http://localhost:3000";
    const { host } = setup({ serverUrl: local });
    await host.start();
    const content = contentView().webContents;
    const onHeaders = vi.mocked(
      session.defaultSession.webRequest.onHeadersReceived,
    );
    const handler = onHeaders.mock.calls.at(-1)![0] as unknown as (
      details: Record<string, unknown>,
      done: (response: Record<string, unknown>) => void,
    ) => void;
    const respond = (details: Record<string, unknown>) => {
      const done = vi.fn();
      handler(
        {
          resourceType: "subFrame",
          webContentsId: content.id,
          statusCode: 200,
          url: "https://linear.app/a",
          responseHeaders: {
            "X-Frame-Options": ["DENY"],
            "Content-Type": ["text/html"],
          },
          ...details,
        },
        done,
      );
      return done.mock.calls[0]![0];
    };

    expect(respond({ frame: { name: "" } })).toEqual({
      responseHeaders: { "Content-Type": ["text/html"] },
    });
    expect(content.send).not.toHaveBeenCalled();

    expect(
      respond({ frame: { name: "linger-url-preview:a" }, statusCode: 302 }),
    ).toEqual({});
    expect(content.send).not.toHaveBeenCalled();

    expect(respond({ frame: { name: "linger-url-preview:a" } })).toEqual({});
    expect(content.send).toHaveBeenCalledExactlyOnceWith(
      IPC.previewFrameRefused,
      "linger-url-preview:a",
      "https://linear.app/a",
    );

    expect(
      respond({ frame: { name: "linger-url-preview:a" }, webContentsId: 99 }),
    ).toEqual({});
    expect(respond({ resourceType: "mainFrame" })).toEqual({});
    expect(content.send).toHaveBeenCalledTimes(1);
    await host.stop("quit");
  });

  it("serves the shell pages in the shell's language and redraws the title bar on a change", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    // Only Windows and Linux draw the title bar.
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const { host, language } = setup({ serverUrl: "http://localhost:3000" });
      await host.start();
      const serve = vi.mocked(protocol.handle).mock.calls.at(-1)![1];
      const page = async (url: string) =>
        (await serve(new Request(url) as never)).text();
      expect(await page("app://shell/titlebar")).toContain('lang="en"');

      const titlebar = state.views[0]!.webContents;
      language.choose("zh-CN");
      expect(titlebar.reload).toHaveBeenCalledOnce();
      const titlebarPage = await page("app://shell/titlebar");
      expect(titlebarPage).toContain('<html lang="zh-CN"');
      expect(titlebarPage).toContain(zhCN.titlebar.close);
      expect(await page("app://offline/")).toContain(
        zhCN.offline.unreachableTitle,
      );
      await host.stop("quit");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});
