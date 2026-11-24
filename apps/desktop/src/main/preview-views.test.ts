import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { EventEmitter } =
    require("node:events") as typeof import("node:events");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const views: MockView[] = [];

  class MockContents extends EventEmitter {
    url = "";
    destroyed = false;
    openHandler:
      | ((details: { url: string; disposition: string }) => unknown)
      | undefined;
    readonly navigationHistory = {
      canGoBack: () => true,
      canGoForward: () => false,
      goBack: vi.fn(),
      goForward: vi.fn(),
    };
    readonly loadURL = vi.fn(async (url: string) => {
      this.url = url;
    });
    readonly reload = vi.fn();
    readonly send = vi.fn();
    readonly close = vi.fn(() => {
      this.destroyed = true;
    });
    readonly setWindowOpenHandler = vi.fn(
      (handler: MockContents["openHandler"]) => {
        this.openHandler = handler;
      },
    );
    getURL = () => this.url;
    isDestroyed = () => this.destroyed;
  }

  class MockPopup extends EventEmitter {
    readonly webContents = new MockContents();
    destroyed = false;
    readonly setTitle = vi.fn();
    readonly close = vi.fn(() => {
      this.destroyed = true;
      this.emit("closed");
    });
    isDestroyed = () => this.destroyed;
  }

  class MockView {
    readonly webContents = new MockContents();
    visible = true;
    readonly options: unknown;
    readonly setBackgroundColor = vi.fn();
    readonly setBounds = vi.fn();
    readonly setVisible = vi.fn((visible: boolean) => {
      this.visible = visible;
    });
    constructor(options: unknown) {
      this.options = options;
      views.push(this);
    }
  }

  return { handlers, views, MockContents, MockPopup, MockView };
});

const previewSession = vi.hoisted(() => ({
  setPermissionRequestHandler: vi.fn(),
  setPermissionCheckHandler: vi.fn(),
}));

vi.mock("electron", () => ({
  WebContentsView: state.MockView,
  ipcMain: {
    handle: (channel: string, run: (...args: unknown[]) => unknown) =>
      state.handlers.set(channel, run),
    removeHandler: (channel: string) => state.handlers.delete(channel),
  },
  session: { fromPartition: vi.fn(() => previewSession) },
}));

import { IPC } from "../shared/api.js";
import {
  PREVIEW_PARTITION,
  PreviewViews,
  previewUrl,
  windowBounds,
} from "./preview-views.js";
import { session } from "electron";

const server = "https://linger.example";

function setup() {
  const page = new state.MockContents();
  page.url = `${server}/rooms/a`;
  const mainFrame = {};
  Object.assign(page, { mainFrame, getZoomFactor: () => 1.25 });
  const content = {
    webContents: page,
    getBounds: () => ({ x: 0, y: 40, width: 1280, height: 780 }),
  };
  const window = {
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  };
  const warn = vi.fn();
  const previews = new PreviewViews({
    window: () => window as never,
    content: () => content as never,
    serverUrl: () => server,
    warn,
  });
  const remove = previews.register();
  const call = (channel: string, ...args: unknown[]) =>
    state.handlers.get(channel)!(
      { sender: page, senderFrame: mainFrame },
      ...args,
    );
  return { page, window, call, remove, mainFrame, previews, warn };
}

beforeEach(() => {
  state.handlers.clear();
  state.views.length = 0;
});

describe("preview helpers", () => {
  it("accepts only http and https URLs without credentials", () => {
    expect(previewUrl("https://github.com/a")).toBe("https://github.com/a");
    expect(previewUrl("http://10.0.0.5:6001")).toBe("http://10.0.0.5:6001/");
    expect(previewUrl("file:///etc/passwd")).toBeUndefined();
    expect(previewUrl("javascript:alert(1)")).toBeUndefined();
    expect(previewUrl("https://u:p@a.example/")).toBeUndefined();
    expect(previewUrl(42)).toBeUndefined();
  });

  it("maps page pixels to the window through the page's offset and zoom", () => {
    expect(
      windowBounds(
        { x: 800, y: 44, width: 400, height: 600 },
        { x: 0, y: 40 },
        1.25,
      ),
    ).toEqual({ x: 1000, y: 95, width: 500, height: 750 });
    expect(
      windowBounds({ x: 0, y: 0, width: -1, height: 1 }, { x: 0, y: 0 }, 1),
    ).toBeUndefined();
    expect(
      windowBounds(
        { x: Number.NaN, y: 0, width: 1, height: 1 },
        { x: 0, y: 0 },
        1,
      ),
    ).toBeUndefined();
  });
});

describe("PreviewViews", () => {
  it("opens a hidden view in the preview session and places it over the panel", async () => {
    const { call, window } = setup();
    await call(IPC.previewOpen, "a", "https://github.com/");
    const view = state.views[0]!;
    expect(session.fromPartition).toHaveBeenCalledWith(PREVIEW_PARTITION);
    expect(view.options).toMatchObject({
      webPreferences: { session: previewSession, sandbox: true },
    });
    expect(view.setVisible).toHaveBeenCalledWith(false);
    expect(window.contentView.addChildView).toHaveBeenCalledWith(view);
    expect(view.webContents.loadURL).toHaveBeenCalledWith(
      "https://github.com/",
    );

    await call(IPC.previewPlace, "a", {
      x: 800,
      y: 4,
      width: 400,
      height: 600,
    });
    expect(view.setBounds).toHaveBeenCalledWith({
      x: 1000,
      y: 45,
      width: 500,
      height: 750,
    });
    expect(view.visible).toBe(true);

    await call(IPC.previewOpen, "a", "https://anthropic.com/");
    expect(state.views).toHaveLength(1);
    expect(view.webContents.loadURL).toHaveBeenLastCalledWith(
      "https://anthropic.com/",
    );
  });

  it("grants previewed sites no permission beyond clipboard writes", async () => {
    const { call } = setup();
    await call(IPC.previewOpen, "a", "https://github.com/");
    const request = previewSession.setPermissionRequestHandler.mock
      .calls[0]![0] as (
      contents: unknown,
      permission: string,
      done: (allowed: boolean) => void,
    ) => void;
    const done = vi.fn();
    request(null, "media", done);
    request(null, "clipboard-sanitized-write", done);
    expect(done.mock.calls).toEqual([[false], [true]]);
  });

  it("refuses calls from anything but the Linger page's main frame", () => {
    const { page, mainFrame } = setup();
    const open = state.handlers.get(IPC.previewOpen)!;
    expect(() =>
      open({ sender: page, senderFrame: {} }, "a", "https://github.com/"),
    ).toThrow("Not allowed");
    page.url = "https://evil.example/";
    expect(() =>
      open(
        { sender: page, senderFrame: mainFrame },
        "a",
        "https://github.com/",
      ),
    ).toThrow("Not allowed");
    expect(state.views).toHaveLength(0);
  });

  it("refuses URLs a view may not load and more than eight views", async () => {
    const { call } = setup();
    expect(() => call(IPC.previewOpen, "a", "file:///etc/hosts")).toThrow();
    for (let index = 0; index < 8; index += 1)
      await call(IPC.previewOpen, `v${index}`, "https://github.com/");
    expect(() =>
      call(IPC.previewOpen, "one-more", "https://github.com/"),
    ).toThrow("Too many previews");
    expect(state.views).toHaveLength(8);
  });

  it("hides at once, so a following place shows the view again", async () => {
    const { call } = setup();
    await call(IPC.previewOpen, "a", "https://github.com/");
    const view = state.views[0]!;
    const bounds = { x: 0, y: 0, width: 10, height: 10 };
    await call(IPC.previewPlace, "a", bounds);
    const hidden = call(IPC.previewHide, "a");
    await call(IPC.previewPlace, "a", bounds);
    await hidden;
    expect(view.visible).toBe(true);
  });

  it("keeps the view and its popups to http and https", async () => {
    const { call } = setup();
    await call(IPC.previewOpen, "a", "https://github.com/");
    const contents = state.views[0]!.webContents;
    for (const name of ["will-navigate", "will-redirect"]) {
      const blocked = { url: "zoommtg://join", preventDefault: vi.fn() };
      const allowed = { url: "https://github.com/x", preventDefault: vi.fn() };
      contents.emit(name, blocked);
      contents.emit(name, allowed);
      expect(blocked.preventDefault).toHaveBeenCalled();
      expect(allowed.preventDefault).not.toHaveBeenCalled();
    }
  });

  it("loads new-tab links in place and opens at most two titled popups, closed with the view", async () => {
    const { call } = setup();
    await call(IPC.previewOpen, "a", "https://github.com/");
    const contents = state.views[0]!.webContents;
    expect(
      contents.openHandler!({
        url: "https://github.com/login",
        disposition: "foreground-tab",
      }),
    ).toEqual({ action: "deny" });
    expect(contents.loadURL).toHaveBeenLastCalledWith(
      "https://github.com/login",
    );
    expect(
      contents.openHandler!({
        url: "zoommtg://join",
        disposition: "new-window",
      }),
    ).toEqual({ action: "deny" });

    const popups = [new state.MockPopup(), new state.MockPopup()];
    for (const popup of popups) {
      expect(
        contents.openHandler!({
          url: "https://accounts.google.com/o/oauth2",
          disposition: "new-window",
        }),
      ).toMatchObject({
        action: "allow",
        overrideBrowserWindowOptions: { title: "accounts.google.com" },
      });
      contents.emit("did-create-window", popup);
    }
    expect(
      contents.openHandler!({
        url: "https://accounts.google.com/o/oauth2",
        disposition: "new-window",
      }),
    ).toEqual({ action: "deny" });

    const titled = { preventDefault: vi.fn() };
    popups[0]!.emit("page-title-updated", titled);
    expect(titled.preventDefault).toHaveBeenCalled();
    popups[0]!.webContents.url = "https://phish.example/";
    popups[0]!.webContents.emit("did-navigate");
    expect(popups[0]!.setTitle).toHaveBeenCalledWith("phish.example");

    await call(IPC.previewClose, "a");
    expect(popups.every((popup) => popup.close.mock.calls.length === 1)).toBe(
      true,
    );
  });

  it("reports each navigation to the page and runs toolbar commands", async () => {
    const { call, page } = setup();
    await call(IPC.previewOpen, "a", "https://github.com/");
    const contents = state.views[0]!.webContents;
    contents.emit("did-navigate");
    expect(page.send).toHaveBeenCalledWith(IPC.previewState, "a", {
      url: "https://github.com/",
      canGoBack: true,
      canGoForward: false,
    });
    await call(IPC.previewCommand, "a", "back");
    expect(contents.navigationHistory.goBack).toHaveBeenCalled();
    await call(IPC.previewCommand, "a", "reload");
    expect(contents.reload).toHaveBeenCalledTimes(1);
  });

  it("reloads a crashed view once, not in a loop", async () => {
    const { call, warn } = setup();
    await call(IPC.previewOpen, "a", "https://github.com/");
    const contents = state.views[0]!.webContents;
    contents.emit("render-process-gone", {}, { reason: "crashed" });
    contents.emit("render-process-gone", {}, { reason: "crashed" });
    expect(contents.reload).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("closes every view when its handlers are removed", async () => {
    const { call, remove } = setup();
    await call(IPC.previewOpen, "a", "https://github.com/");
    await call(IPC.previewOpen, "b", "https://anthropic.com/");
    remove();
    expect(state.views.every((view) => view.webContents.destroyed)).toBe(true);
    expect(state.handlers.size).toBe(0);
  });
});
