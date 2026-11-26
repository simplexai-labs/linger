import { useSyncExternalStore } from "react";

import { translate } from "@/i18n/language";
import type { Message } from "@/i18n/messages";
import { voiceWindowMessages } from "./voice-window.messages";

/**
 * The desktop app's floating window (`window.lingerDesktop.voiceWindow`): the
 * page opens a blank window under `desktopWindowTarget` and the app keeps it
 * on top, also while its main window is minimized or closed to the tray.
 */
interface DesktopVoiceWindow {
  showMainWindow(): Promise<void>;
}

/**
 * The window name the desktop app recognizes; it floats the window opened
 * under it. The suffix keeps a window that is still closing from being reused.
 */
const desktopWindowTarget = "linger-voice-window";
let desktopWindowCount = 0;

interface PipSize {
  height: number;
  width: number;
}

/** Voice Mode and Recording never run together; each asks for its own window. */
export type VoicePipOwner = "voice-mode" | "recording";

// Initial dimensions for each desktop window; the Human can resize it.
const pipSizes = {
  // Voice Mode floats as its island alone; the desktop app keeps it 96px tall.
  "voice-mode": { height: 96, width: 360 },
  recording: { height: 720, width: 420 },
} satisfies Record<VoicePipOwner, PipSize>;

// What the desktop shows as the window's name.
const pipTitles = {
  "voice-mode": voiceWindowMessages.title,
  recording: voiceWindowMessages.meetingTitle,
} satisfies Record<VoicePipOwner, Message<string>>;

let pip: { owner: VoicePipOwner; window: Window } | undefined;
const listeners = new Set<() => void>();
const closedByHuman = new Set<(owner: VoicePipOwner) => void>();
/** Set while the voice window's return button closes the floating window. */
let returning = false;
/** How the floating window last closed, when that is known for sure. */
let returnedByButton: boolean | undefined;

function desktopVoiceWindow(): DesktopVoiceWindow | undefined {
  const voiceWindow = (
    window as Window & {
      lingerDesktop?: { voiceWindow?: Partial<DesktopVoiceWindow> };
    }
  ).lingerDesktop?.voiceWindow;
  return typeof voiceWindow?.showMainWindow === "function"
    ? (voiceWindow as DesktopVoiceWindow)
    : undefined;
}

/** Only the desktop app can float a window without browser-owned chrome. */
export function voicePipSupported() {
  return desktopVoiceWindow() !== undefined;
}

function publish(next: typeof pip) {
  pip = next;
  for (const listener of listeners) listener();
}

/**
 * Opens the always-on-top window a voice window moves into, so it stays
 * visible over other tabs and apps and can be dragged anywhere on the desktop.
 * Call it synchronously from the click handler so the desktop window opens
 * under that gesture. Resolves undefined when the client refuses.
 */
export async function openVoicePip(
  owner: VoicePipOwner,
): Promise<Window | undefined> {
  if (!voicePipSupported()) return undefined;
  // A page gets one such window; the newest owner takes it.
  if (pip?.owner === owner) return pip.window;
  if (pip) closeVoicePip(pip.owner);
  try {
    const { height, width } = pipSizes[owner];
    const opened = window.open(
      "",
      `${desktopWindowTarget}-${++desktopWindowCount}`,
      `popup=yes,width=${width},height=${height}`,
    );
    if (!opened) return undefined;
    returning = false;
    returnedByButton = undefined;
    opened.document.title = translate(pipTitles[owner]);
    const stopMirroring = mirrorStyles(opened.document);
    opened.addEventListener("pagehide", () => {
      stopMirroring();
      if (pip?.window !== opened) return;
      // Closed from the window itself rather than from the page.
      publish(undefined);
      returnedByButton = returning;
      returning = false;
      for (const listener of closedByHuman) listener(owner);
    });
    publish({ owner, window: opened });
    return opened;
  } catch {
    return undefined;
  }
}

export function closeVoicePip(owner: VoicePipOwner) {
  if (pip?.owner !== owner) return;
  const current = pip.window;
  publish(undefined);
  current.close();
}

/** Returns a desktop voice window to the main page without ending its session. */
export function returnVoicePipToPage(owner: VoicePipOwner) {
  if (pip?.owner !== owner) return;
  returning = true;
  // The session still moves into the page if the main window cannot be shown.
  void desktopVoiceWindow()
    ?.showMainWindow()
    .catch(() => undefined);
  pip.window.close();
}

/** Only the desktop window's own return button keeps the session in the page. */
export function returnedToOpener(): Promise<boolean> {
  const returned = returnedByButton === true;
  returnedByButton = undefined;
  return Promise.resolve(returned);
}

/** Runs when this owner's window closes from the window, not from the page. */
export function onVoicePipClosedByHuman(
  owner: VoicePipOwner,
  listener: () => void,
) {
  const forOwner = (closed: VoicePipOwner) => {
    if (closed === owner) listener();
  };
  closedByHuman.add(forOwner);
  return () => {
    closedByHuman.delete(forOwner);
  };
}

/** This owner's desktop floating window, when it is open. */
export function useVoicePip(owner: VoicePipOwner) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (pip?.owner === owner ? pip.window : undefined),
    () => undefined,
  );
}

/**
 * Copies the page's styles and theme into the new window, including styles a
 * lazily loaded chunk adds later, so the window looks the same in both places.
 */
function mirrorStyles(target: Document) {
  const root = document.documentElement;
  // The floating window has a title bar of its own, so it takes no room for
  // window controls the way the desktop app's main window does on macOS.
  for (const { name, value } of Array.from(root.attributes))
    if (name !== "data-desktop-chrome")
      target.documentElement.setAttribute(name, value);
  const copy = (node: Node) => {
    if (
      node instanceof HTMLStyleElement ||
      (node instanceof HTMLLinkElement && node.rel === "stylesheet")
    )
      target.head.append(node.cloneNode(true));
  };
  document.head.childNodes.forEach(copy);
  target.body.style.margin = "0";
  const observer = new MutationObserver((records) => {
    for (const record of records) record.addedNodes.forEach(copy);
  });
  observer.observe(document.head, { childList: true });
  return () => observer.disconnect();
}

export function resetVoicePipForTest() {
  pip = undefined;
  listeners.clear();
  closedByHuman.clear();
  returning = false;
  returnedByButton = undefined;
}
