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
): (() => void) | undefined {
  if (child.webContents.opener !== opener.mainFrame) {
    child.destroy();
    return undefined;
  }
  previous?.();
  return adoptVoiceWindow(child, opener, platform);
}

// Floats `child` over other apps and ties it to `opener`. Returns a function
// that closes it.
export function adoptVoiceWindow(
  child: BrowserWindow,
  opener: WebContents,
  platform: VoiceWindowPlatform,
): () => void {
  child.setAlwaysOnTop(true, "floating");
  if (platform === "darwin")
    child.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
  child.setMenuBarVisibility(false);
  // The page names the window in the interface language ("Meeting", "会议");
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
  const close = (): void => {
    if (!child.isDestroyed()) child.close();
  };
  // The window belongs to the page that filled it: a reload or a crash leaves
  // nothing to drive it.
  const onNavigate = (details: {
    isMainFrame: boolean;
    isSameDocument: boolean;
  }): void => {
    if (details.isMainFrame && !details.isSameDocument) close();
  };
  opener.on("did-start-navigation", onNavigate);
  opener.on("render-process-gone", close);
  child.on("closed", () => {
    opener.off("did-start-navigation", onNavigate);
    opener.off("render-process-gone", close);
    hold(opener, -1);
  });
  return close;
}
