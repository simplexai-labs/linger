// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineGlobalProperty } from "@/test/global-properties";

import {
  closeVoicePip,
  onVoicePipClosedByHuman,
  openVoicePip,
  resetVoicePipForTest,
  showLingerFromVoicePip,
  voicePipSupported,
} from "./voice-pip";

/** A stand-in for the browser's picture-in-picture window. */
function installFakeVoicePip() {
  const frame = window.document.createElement("iframe");
  window.document.body.append(frame);
  const document = frame.contentDocument!;
  const listeners: (() => void)[] = [];
  const pipWindow = {
    document,
    addEventListener: (type: string, listener: () => void) => {
      if (type === "pagehide") listeners.push(listener);
    },
    // A closed window is gone; the next request opens a fresh one.
    close: vi.fn(() => listeners.splice(0).forEach((listener) => listener())),
  };
  const requestWindow = vi.fn(async () => pipWindow as unknown as Window);
  defineGlobalProperty(window, "documentPictureInPicture", {
    configurable: true,
    value: { requestWindow },
  });
  return { document, frame, pipWindow, requestWindow };
}

/** A stand-in for the desktop app's bridge and the window it lets the page open. */
function installFakeDesktopVoiceWindow() {
  const frame = window.document.createElement("iframe");
  window.document.body.append(frame);
  const document = frame.contentDocument!;
  const listeners: (() => void)[] = [];
  const voiceWindow = {
    document,
    addEventListener: (type: string, listener: () => void) => {
      if (type === "pagehide") listeners.push(listener);
    },
    close: vi.fn(() => listeners.splice(0).forEach((listener) => listener())),
  };
  const open = vi.fn(
    (_url?: string, _target?: string, _features?: string) =>
      voiceWindow as unknown as Window,
  );
  const showMain = vi.fn(async () => {});
  defineGlobalProperty(window, "open", { value: open });
  defineGlobalProperty(window, "lingerDesktop", {
    value: { voiceWindow: { showMainWindow: showMain } },
  });
  return { document, open, showMain, voiceWindow };
}

function removeFakeVoicePip() {
  document.querySelectorAll("iframe").forEach((frame) => frame.remove());
  Reflect.deleteProperty(window, "documentPictureInPicture");
  resetVoicePipForTest();
}

afterEach(() => {
  removeFakeVoicePip();
  Reflect.deleteProperty(window, "lingerDesktop");
  document.head.querySelectorAll("[data-test-style]").forEach((node) => {
    node.remove();
  });
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-desktop-shell");
  document.documentElement.removeAttribute("data-desktop-chrome");
});

describe("Voice Mode picture-in-picture window", () => {
  it("is unavailable where the browser lacks it", async () => {
    await expect(openVoicePip("voice-mode")).resolves.toBeUndefined();
  });

  it("stays in the page inside a desktop app that offers no voice window", async () => {
    const fake = installFakeVoicePip();
    const open = vi.fn();
    defineGlobalProperty(window, "open", { value: open });
    const desktop = window as { lingerDesktop?: unknown };
    for (const bridge of [{}, { voiceWindow: {} }]) {
      desktop.lingerDesktop = bridge;
      try {
        expect(voicePipSupported()).toBe(false);
        expect(voicePipSupported()).toBe(false);
        await expect(openVoicePip("voice-mode")).resolves.toBeUndefined();
        expect(fake.requestWindow).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
      } finally {
        delete desktop.lingerDesktop;
      }
    }
  });

  it("keeps both Voice Mode and Meeting in the page even when browser picture-in-picture is available", async () => {
    // The browser's own title bar on that window cannot be hidden or styled.
    const fake = installFakeVoicePip();
    expect(voicePipSupported()).toBe(false);
    await expect(openVoicePip("voice-mode")).resolves.toBeUndefined();
    expect(fake.requestWindow).not.toHaveBeenCalled();
    expect(voicePipSupported()).toBe(false);
    await expect(openVoicePip("recording")).resolves.toBeUndefined();
    expect(fake.requestWindow).not.toHaveBeenCalled();
  });

  it("floats in the desktop app's own window where the app offers one", async () => {
    const browser = installFakeVoicePip();
    const fake = installFakeDesktopVoiceWindow();
    document.documentElement.setAttribute("data-desktop-shell", "");
    document.documentElement.setAttribute("data-desktop-chrome", "inset");
    expect(voicePipSupported()).toBe(true);

    await expect(openVoicePip("voice-mode")).resolves.toBe(fake.voiceWindow);
    expect(fake.open).toHaveBeenCalledOnce();
    expect(fake.open).toHaveBeenCalledWith(
      "",
      expect.stringMatching(/^linger-voice-window-\d+$/),
      "popup=yes,width=360,height=96",
    );
    expect(browser.requestWindow).not.toHaveBeenCalled();
    expect(fake.document.title).toBe("Voice Mode");
    // The window has a title bar of its own, so it leaves no room for the
    // main window's controls.
    const root = fake.document.documentElement;
    expect(root.hasAttribute("data-desktop-shell")).toBe(true);
    expect(root.hasAttribute("data-desktop-chrome")).toBe(false);

    await openVoicePip("recording");
    expect(fake.open).toHaveBeenLastCalledWith(
      "",
      expect.stringMatching(/^linger-voice-window-\d+$/),
      "popup=yes,width=420,height=720",
    );
    // A window still closing is never reused under the same name.
    expect(fake.open.mock.calls[0]?.[1]).not.toBe(fake.open.mock.calls[1]?.[1]);
    expect(fake.document.title).toBe("Meeting");
  });

  it("stays in the page when the desktop app refuses the window", async () => {
    const fake = installFakeDesktopVoiceWindow();
    fake.open.mockReturnValueOnce(null as unknown as Window);
    await expect(openVoicePip("voice-mode")).resolves.toBeUndefined();
  });

  it("shows the main window from the desktop app's window and keeps floating", async () => {
    const fake = installFakeDesktopVoiceWindow();
    const closedByHuman = vi.fn();
    const stop = onVoicePipClosedByHuman("voice-mode", closedByHuman);
    try {
      await openVoicePip("voice-mode");
      showLingerFromVoicePip();
      expect(fake.showMain).toHaveBeenCalledOnce();
      // There is no in-page window to go back to in the desktop app.
      expect(fake.voiceWindow.close).not.toHaveBeenCalled();
      expect(closedByHuman).not.toHaveBeenCalled();

      // The window's close button ends the session.
      fake.voiceWindow.close();
      document.dispatchEvent(new Event("visibilitychange"));
      expect(closedByHuman).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });

  it("keeps floating when the main window cannot be shown", async () => {
    const fake = installFakeDesktopVoiceWindow();
    fake.showMain.mockRejectedValueOnce(new Error("no window"));
    await openVoicePip("voice-mode");
    showLingerFromVoicePip();
    await Promise.resolve();
    expect(fake.voiceWindow.close).not.toHaveBeenCalled();
  });

  it("carries the page's styles and theme, including later ones", async () => {
    const early = document.createElement("style");
    early.dataset.testStyle = "";
    early.textContent = ".early {}";
    document.head.append(early);
    document.documentElement.setAttribute("data-theme", "dark");
    const fake = installFakeDesktopVoiceWindow();

    await openVoicePip("recording");
    expect(fake.document.documentElement.dataset.theme).toBe("dark");
    expect(fake.document.head.textContent).toContain(".early {}");

    const late = document.createElement("style");
    late.dataset.testStyle = "";
    late.textContent = ".late {}";
    document.head.append(late);
    await vi.waitFor(() =>
      expect(fake.document.head.textContent).toContain(".late {}"),
    );
  });

  it("follows a later language change and drops the desktop title-bar mark", async () => {
    document.documentElement.setAttribute("lang", "en");
    document.documentElement.setAttribute("data-desktop-chrome", "inset");
    const fake = installFakeDesktopVoiceWindow();
    // The desktop preload marks every window it runs in.
    fake.document.documentElement.setAttribute("data-desktop-chrome", "inset");
    try {
      await openVoicePip("recording");
      expect(
        fake.document.documentElement.hasAttribute("data-desktop-chrome"),
      ).toBe(false);
      document.documentElement.setAttribute("lang", "zh-CN");
      await vi.waitFor(() =>
        expect(fake.document.documentElement.lang).toBe("zh-CN"),
      );
    } finally {
      document.documentElement.removeAttribute("data-desktop-chrome");
      document.documentElement.setAttribute("lang", "en");
    }
  });

  it("opens one window and tells a desktop close apart from the page closing it", async () => {
    const fake = installFakeDesktopVoiceWindow();
    const first = await openVoicePip("recording");
    await expect(openVoicePip("recording")).resolves.toBe(first);
    expect(fake.open).toHaveBeenCalledOnce();
    const closedByHuman = vi.fn();
    const stop = onVoicePipClosedByHuman("recording", closedByHuman);
    closeVoicePip("recording");
    expect(fake.voiceWindow.close).toHaveBeenCalledOnce();
    expect(closedByHuman).not.toHaveBeenCalled();

    await openVoicePip("recording");
    fake.voiceWindow.close();
    expect(closedByHuman).toHaveBeenCalledOnce();
    stop();
  });

  it("gives the window to one owner at a time", async () => {
    const fake = installFakeDesktopVoiceWindow();
    const voiceModeClosed = vi.fn();
    const stop = onVoicePipClosedByHuman("voice-mode", voiceModeClosed);
    await openVoicePip("voice-mode");
    // Recording takes the page's one window; Voice Mode's closes, not by the Human.
    await openVoicePip("recording");
    expect(fake.voiceWindow.close).toHaveBeenCalledOnce();
    expect(voiceModeClosed).not.toHaveBeenCalled();
    // Closing someone else's window does nothing.
    closeVoicePip("voice-mode");
    expect(fake.voiceWindow.close).toHaveBeenCalledOnce();
    stop();
  });
});
