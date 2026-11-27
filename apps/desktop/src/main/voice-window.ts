// The floating voice window. The page opens it with `window.open("")` and
// fills it with the Voice Mode or Recording window, so the call and its state
// stay in the main page; this file only makes that window float, keeps it from
// outliving the page it belongs to, and keeps the page running while the main
// window is hidden. Electron types only, so a test can pass fakes.

import type { BrowserWindow, WebContents } from "electron";

export type VoiceWindowPlatform = NodeJS.Platform;

export interface VoiceWindowSize {
  readonly width: number;
  readonly height: number;
}

interface Area extends VoiceWindowSize {
  readonly x: number;
  readonly y: number;
}

// The smallest the window gets: the one-row minimized state still fits.
export const VOICE_WINDOW_MIN: VoiceWindowSize = { width: 240, height: 96 };
// The gap the window keeps from the screen's edges when it opens.
const VOICE_WINDOW_MARGIN = 24;

// Where the window opens: the bottom right of the main window's screen, as a
// browser places its picture-in-picture window. A window larger than the
// screen keeps its title bar on the screen.
export const voiceWindowPosition = (
  window: VoiceWindowSize,
  workArea: Area,
): { readonly x: number; readonly y: number } => ({
  x: Math.max(
    workArea.x,
    workArea.x + workArea.width - window.width - VOICE_WINDOW_MARGIN,
  ),
  y: Math.max(
    workArea.y,
    workArea.y + workArea.height - window.height - VOICE_WINDOW_MARGIN,
  ),
});

// How high the window floats: over the main window and every ordinary window.
// Windows and Linux know only on top or not, but on Windows Electron moves a
// window at the levels up to "status" behind the taskbar each time it is
// activated (electron#34814), so there it takes the first level above them.
// macOS keeps "floating", under menus and the Dock, and follows the person
// across Spaces and full-screen apps instead.
export type VoiceWindowLevel = "floating" | "pop-up-menu";
export const voiceWindowLevel = (
  platform: VoiceWindowPlatform,
): VoiceWindowLevel => (platform === "darwin" ? "floating" : "pop-up-menu");

// The window the page's request opens. It has no parent, so it neither
// minimizes nor hides with the main window and the main window never covers
// it; it is moved by its native title bar and only closed, never minimized,
// so it cannot get lost behind other windows. Windows lists every window in
// the taskbar; this one belongs to the main window's session, so it is left
// out there.
export const voiceWindowOptions = (platform: VoiceWindowPlatform) =>
  ({
    title: "Linger",
    // The page asks for the size of its content, as in a browser.
    useContentSize: true,
    minWidth: VOICE_WINDOW_MIN.width,
    minHeight: VOICE_WINDOW_MIN.height,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: platform === "win32",
    autoHideMenuBar: true,
  }) as const;

// Something whose events should put the window back on top.
export interface VoiceWindowRaiser {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}
export type VoiceWindowRaiseSource = readonly [
  VoiceWindowRaiser,
  readonly string[],
];

// Hiding or minimizing the main window would otherwise throttle the page's
// timers, which keep the call and the recording going. A window is counted
// from when it is adopted to when it closes, so a closing window cannot lift
// the hold its replacement took.
const holds = new WeakMap<WebContents, number>();
const hold = (opener: WebContents, delta: 1 | -1): void => {
  const count = (holds.get(opener) ?? 0) + delta;
  holds.set(opener, count);
  if (!opener.isDestroyed()) opener.setBackgroundThrottling(count <= 0);
};

// What the page's `window.open` produced. The open handler cannot tell which
// frame asked, so a window opened by a frame of the page, such as a site in
// the link preview, is destroyed instead of getting a window of this app. One
// voice window at a time: the newest request replaces `previous`. Returns the
// function that closes the adopted window, or undefined when it was refused.
export function acceptVoiceWindow(
  child: BrowserWindow,
  opener: WebContents,
  previous: (() => void) | undefined,
  platform: VoiceWindowPlatform,
  raiseOn: readonly VoiceWindowRaiseSource[] = [],
): (() => void) | undefined {
  if (child.webContents.opener !== opener.mainFrame) {
    child.destroy();
    return undefined;
  }
  previous?.();
  return adoptVoiceWindow(child, opener, platform, raiseOn);
}

// Floats `child` over other apps and ties it to `opener`. Returns a function
// that closes it. Each event of `raiseOn` (the main window coming back or
// taking focus, a screen being added, removed or rearranged) puts the window
// on top again: Windows can drop a window out of the always-on-top band, and
// asking again only restacks it without taking focus.
export function adoptVoiceWindow(
  child: BrowserWindow,
  opener: WebContents,
  platform: VoiceWindowPlatform,
  raiseOn: readonly VoiceWindowRaiseSource[] = [],
): () => void {
  const level = voiceWindowLevel(platform);
  const raise = (): void => {
    if (!child.isDestroyed()) child.setAlwaysOnTop(true, level);
  };
  raise();
  const sources: VoiceWindowRaiseSource[] = [
    [child, ["show", "restore"]],
    ...raiseOn,
  ];
  for (const [source, events] of sources)
    for (const event of events) source.on(event, raise);
  if (platform === "darwin")
    child.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
  child.setMenuBarVisibility(false);
  // The page names the window in the interface language (English "Meeting");
  // an empty or blank-page title keeps the window's own "Linger".
  child.on("page-title-updated", (event, title) => {
    event.preventDefault();
    const named = title.trim();
    if (named && named !== "about:blank" && !child.isDestroyed())
      child.setTitle(named);
  });

  const contents = child.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());

  hold(opener, 1);
  // Destroy rather than close on main-process teardown (navigation, crash,
  // replacement, or main-window close) so Electron does not dispatch popup
  // `pagehide` into a still-alive opener page as if the user clicked the
  // floating window's close button; Electron still emits `closed` on `child`.
  const close = (): void => {
    if (!child.isDestroyed()) child.destroy();
  };
  const onNavigate = (details: {
    isMainFrame: boolean;
    isSameDocument: boolean;
  }): void => {
    if (details.isMainFrame && !details.isSameDocument) close();
  };
  opener.on("did-start-navigation", onNavigate);
  opener.on("render-process-gone", close);
  child.on("closed", () => {
    for (const [source, events] of sources)
      for (const event of events) source.off(event, raise);
    opener.off("did-start-navigation", onNavigate);
    opener.off("render-process-gone", close);
    hold(opener, -1);
  });
  return close;
}
