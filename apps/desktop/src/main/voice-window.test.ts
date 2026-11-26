import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  acceptVoiceWindow,
  adoptVoiceWindow,
  voiceWindowLevel,
  voiceWindowOptions,
  voiceWindowPosition,
} from "./voice-window.js";

// Electron stand-ins: only what the module touches.
function fakes() {
  const childContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: vi.fn(),
    opener: undefined as unknown,
  });
  const child = Object.assign(new EventEmitter(), {
    webContents: childContents,
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    setMenuBarVisibility: vi.fn(),
    setTitle: vi.fn(),
    isDestroyed: vi.fn(() => false),
    close: vi.fn(() => child.emit("closed")),
    destroy: vi.fn(),
  });
  const mainFrame = {};
  const opener = Object.assign(new EventEmitter(), {
    mainFrame,
    isDestroyed: vi.fn(() => false),
    setBackgroundThrottling: vi.fn(),
  });
  return { child, childContents, opener };
}

const adopt = (
  { child, opener }: ReturnType<typeof fakes>,
  platform: NodeJS.Platform = "linux",
) => adoptVoiceWindow(child as never, opener as never, platform);

describe("adoptVoiceWindow", () => {
  it("floats the window over other apps and keeps the page running", () => {
    const f = fakes();
    adopt(f);
    expect(f.child.setAlwaysOnTop).toHaveBeenCalledWith(true, "pop-up-menu");
    expect(f.opener.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
    expect(f.child.setVisibleOnAllWorkspaces).not.toHaveBeenCalled();
  });

  it.each([
    ["darwin", "floating"],
    // Up to "status", Electron puts a Windows window behind the taskbar each
    // time it is activated.
    ["win32", "pop-up-menu"],
    ["linux", "pop-up-menu"],
  ] as const)(
    "floats at a level above ordinary windows on %s",
    (platform, level) => {
      expect(voiceWindowLevel(platform)).toBe(level);
      const f = fakes();
      adopt(f, platform);
      expect(f.child.setAlwaysOnTop).toHaveBeenCalledWith(true, level);
    },
  );

  it("goes back on top when the main window returns or a screen changes, until it closes", () => {
    const f = fakes();
    const main = new EventEmitter();
    const screen = new EventEmitter();
    adoptVoiceWindow(f.child as never, f.opener as never, "win32", [
      [main, ["show", "restore", "focus"]],
      [screen, ["display-removed"]],
    ]);
    f.child.setAlwaysOnTop.mockClear();
    main.emit("focus");
    main.emit("restore");
    screen.emit("display-removed");
    f.child.emit("show");
    expect(f.child.setAlwaysOnTop).toHaveBeenCalledTimes(4);
    // Restacking only: never off and on again, which drops other apps'
    // always-on-top windows on Windows (electron#31536).
    expect(
      f.child.setAlwaysOnTop.mock.calls.every(
        ([flag, level]) => flag === true && level === "pop-up-menu",
      ),
    ).toBe(true);

    f.child.emit("closed");
    f.child.setAlwaysOnTop.mockClear();
    main.emit("focus");
    screen.emit("display-removed");
    expect(f.child.setAlwaysOnTop).not.toHaveBeenCalled();
    expect(main.listenerCount("focus")).toBe(0);
    expect(screen.listenerCount("display-removed")).toBe(0);
  });

  it("is a movable window apart from the main window, in the taskbar only where it must be", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const options = voiceWindowOptions(platform);
      expect(options).toMatchObject({ movable: true, minimizable: false });
      // No parent and no modal: it neither minimizes with the main window nor
      // sits under it.
      expect(options).not.toHaveProperty("parent");
      expect(options).not.toHaveProperty("modal");
      expect(options.skipTaskbar).toBe(platform === "win32");
    }
  });

  it("follows the person across Spaces on macOS", () => {
    const f = fakes();
    adopt(f, "darwin");
    expect(f.child.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
  });

  it("lets the page throttle again once the window closes", () => {
    const f = fakes();
    adopt(f);
    f.child.emit("closed");
    expect(f.opener.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
    expect(f.opener.listenerCount("did-start-navigation")).toBe(0);
  });

  it("keeps the page running when one window replaces another", () => {
    const first = fakes();
    adopt(first);
    const second = fakes();
    adoptVoiceWindow(second.child as never, first.opener as never, "linux");
    // The old window's close can land after the new one was adopted.
    first.child.emit("closed");
    expect(first.opener.setBackgroundThrottling).toHaveBeenLastCalledWith(
      false,
    );
    second.child.emit("closed");
    expect(first.opener.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
  });

  it("closes when the page navigates to another document or crashes", () => {
    const sameDocument = fakes();
    adopt(sameDocument);
    sameDocument.opener.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: true,
    });
    sameDocument.opener.emit("did-start-navigation", {
      isMainFrame: false,
      isSameDocument: false,
    });
    expect(sameDocument.child.close).not.toHaveBeenCalled();
    sameDocument.opener.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
    });
    expect(sameDocument.child.close).toHaveBeenCalledOnce();

    const crashed = fakes();
    adopt(crashed);
    crashed.opener.emit("render-process-gone");
    expect(crashed.child.close).toHaveBeenCalledOnce();
  });

  it("returns a close function that is safe after the window is gone", () => {
    const f = fakes();
    const close = adopt(f);
    f.child.isDestroyed.mockReturnValue(true);
    close();
    expect(f.child.close).not.toHaveBeenCalled();
  });

  it("keeps the window on its empty page", () => {
    const f = fakes();
    adopt(f);
    const handler = f.childContents.setWindowOpenHandler.mock.calls[0]![0] as (
      details: unknown,
    ) => unknown;
    expect(handler({})).toEqual({ action: "deny" });
    const event = { preventDefault: vi.fn() };
    f.childContents.emit("will-navigate", event);
    f.child.emit("page-title-updated", event, "about:blank");
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(f.child.setTitle).not.toHaveBeenCalled();
  });

  it("takes the title the page gives it in the interface language", () => {
    const f = fakes();
    adopt(f);
    const event = { preventDefault: vi.fn() };
    // "Meeting" in Chinese.
    f.child.emit("page-title-updated", event, "\u4f1a\u8bae");
    expect(f.child.setTitle).toHaveBeenCalledWith("\u4f1a\u8bae");
    f.child.emit("page-title-updated", event, "  ");
    expect(f.child.setTitle).toHaveBeenCalledOnce();
  });
});

describe("acceptVoiceWindow", () => {
  const accept = (f: ReturnType<typeof fakes>, previous?: () => void) =>
    acceptVoiceWindow(f.child as never, f.opener as never, previous, "linux");

  it("adopts a window the page's main frame opened", () => {
    const f = fakes();
    f.childContents.opener = f.opener.mainFrame;
    expect(accept(f)).toBeTypeOf("function");
    expect(f.child.destroy).not.toHaveBeenCalled();
    expect(f.child.setAlwaysOnTop).toHaveBeenCalled();
  });

  it("destroys a window a frame of the page opened", () => {
    const f = fakes();
    f.childContents.opener = {};
    const previous = vi.fn();
    expect(accept(f, previous)).toBeUndefined();
    expect(f.child.destroy).toHaveBeenCalledOnce();
    expect(f.child.setAlwaysOnTop).not.toHaveBeenCalled();
    // The voice window already open stays.
    expect(previous).not.toHaveBeenCalled();
  });

  it("destroys a window with no known opener", () => {
    const f = fakes();
    f.childContents.opener = null;
    expect(accept(f)).toBeUndefined();
    expect(f.child.destroy).toHaveBeenCalledOnce();
  });

  it("closes the previous window when a second one opens", () => {
    const f = fakes();
    f.childContents.opener = f.opener.mainFrame;
    const previous = vi.fn();
    expect(accept(f, previous)).toBeTypeOf("function");
    expect(previous).toHaveBeenCalledOnce();
  });
});

describe("voiceWindowPosition", () => {
  const workArea = { x: 0, y: 25, width: 1470, height: 931 };

  it("opens at the bottom right of the screen", () => {
    expect(voiceWindowPosition({ width: 320, height: 240 }, workArea)).toEqual({
      x: 1126,
      y: 692,
    });
  });

  it("keeps a window larger than the screen at its top left", () => {
    expect(
      voiceWindowPosition({ width: 2000, height: 1200 }, workArea),
    ).toEqual({ x: 0, y: 25 });
  });

  it("follows a screen left of the main one", () => {
    expect(
      voiceWindowPosition(
        { width: 320, height: 240 },
        { x: -2560, y: -400, width: 2560, height: 1415 },
      ),
    ).toEqual({ x: -344, y: 751 });
  });
});
