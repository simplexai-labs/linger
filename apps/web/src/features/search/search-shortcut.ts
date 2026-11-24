import { useEffectEvent, useLayoutEffect } from "react";

export function isMacLikePlatform() {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/** Label shown next to the Search entry; Mac keyboards read ⌘K, everything else Ctrl K. */
export function searchShortcutLabel() {
  return isMacLikePlatform() ? "⌘K" : "Ctrl K";
}

/**
 * Cmd/Ctrl+K opens global search from anywhere, including the composer and
 * the Document editor. An IME composition in flight keeps the keystroke.
 */
export function isGlobalSearchShortcut(event: KeyboardEvent) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
    return false;
  }
  if (event.isComposing) return false;
  return event.key.toLowerCase() === "k";
}

export function useGlobalSearchShortcut(onOpen: () => void) {
  const open = useEffectEvent(onOpen);
  // A layout effect arms the shortcut in the same commit that paints the
  // shell; a passive effect can run later, dropping a keystroke pressed as
  // soon as the shell appears.
  useLayoutEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isGlobalSearchShortcut(event)) return;
      // Capture phase plus stopPropagation: editors that bind the same key
      // (the Markdown editor's link command) never see it, so search wins.
      event.preventDefault();
      event.stopPropagation();
      open();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
