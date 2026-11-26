import { useSyncExternalStore } from "react";

import { translate } from "@/i18n/language";
import type { Message } from "@/i18n/messages";
import { voiceWindowMessages } from "./voice-window.messages";

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

/**
 * Only the desktop app can float a window without browser-owned chrome: it
 * marks that with `window.lingerDesktop.voiceWindow`, opens the blank window
 * the page asks for under `desktopWindowTarget` and keeps it on top, also
 * while its main window is minimized or closed to the tray. There the voice
 * windows live only in that window; a browser keeps them in the page.
 */
export function voicePipSupported() {
  const voiceWindow = (
    window as Window & {
      lingerDesktop?: {
        voiceWindow?: { floats?: unknown; showMainWindow?: unknown };
      };
    }
  ).lingerDesktop?.voiceWindow;
  // Apps before `floats` marked it with their way back to the main window.
  return (
    voiceWindow?.floats === true ||
    typeof voiceWindow?.showMainWindow === "function"
  );
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
    opened.document.title = translate(pipTitles[owner]);
    const stopMirroring = mirrorStyles(opened.document);
    opened.addEventListener("pagehide", () => {
      stopMirroring();
      if (pip?.window !== opened) return;
      // Closed from the window itself rather than from the page: the desktop
      // window has no way back into the page, so this ends its session.
      publish(undefined);
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
  // window controls the way the desktop app's main window does on macOS. The
  // desktop preload may mark the new window as well, so the mark is removed.
  const copyRoot = () => {
    for (const { name, value } of Array.from(root.attributes))
      if (name !== "data-desktop-chrome")
        target.documentElement.setAttribute(name, value);
    target.documentElement.removeAttribute("data-desktop-chrome");
  };
  copyRoot();
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
  // The language or theme the page switches to later follows into the window.
  const rootObserver = new MutationObserver(copyRoot);
  rootObserver.observe(root, { attributes: true });
  return () => {
    observer.disconnect();
    rootObserver.disconnect();
  };
}

export function resetVoicePipForTest() {
  pip = undefined;
  listeners.clear();
  closedByHuman.clear();
}
