import { useEffect } from "react";

/** How long after the last scroll the pill stays before fading out. */
const SCROLL_IDLE_MS = 900;

/**
 * Marks the workspace scroll panes while they are scrolling, so the floating
 * scrollbar pill can fade in and out. One capturing document listener covers
 * every pane, so individual panes need no wiring.
 */
export function useScrollPaneActivity() {
  useEffect(() => {
    const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
    const onScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const isPane =
        target.classList.contains("room-timeline") ||
        target.classList.contains("room-secondary-navigation-list");
      if (!isPane) return;
      target.setAttribute("data-scrolling", "true");
      clearTimeout(timers.get(target));
      timers.set(
        target,
        setTimeout(
          () => target.removeAttribute("data-scrolling"),
          SCROLL_IDLE_MS,
        ),
      );
    };
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, []);
}
