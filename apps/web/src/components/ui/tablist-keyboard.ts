import { type KeyboardEvent, useRef } from "react";

export interface TablistItem<K extends string> {
  disabled?: boolean;
  id: K;
}

/**
 * WAI-ARIA APG horizontal tablist keyboard navigation with roving tabindex:
 * ArrowLeft/ArrowRight wrap across enabled tabs, Home/End jump to the first
 * and last enabled tabs, and only the active tab sits in the Tab order.
 */
export function useTablistKeyboard<K extends string>({
  items,
  onChange,
  value,
}: {
  items: readonly TablistItem<K>[];
  onChange: (id: K) => void;
  value: K;
}) {
  const tabRefs = useRef(new Map<K, HTMLButtonElement>());
  const enabledItems = items.filter((item) => !item.disabled);
  const tabStopId = enabledItems.some((item) => item.id === value)
    ? value
    : enabledItems[0]?.id;

  function registerTab(id: K) {
    return (node: HTMLButtonElement | null) => {
      if (node) tabRefs.current.set(id, node);
      else tabRefs.current.delete(id);
    };
  }

  function getTabProps(id: K, disabled = false) {
    return {
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
        if (enabledItems.length === 0) return;
        const currentIndex = enabledItems.findIndex((item) => item.id === id);
        const startIndex =
          currentIndex >= 0
            ? currentIndex
            : Math.max(
                0,
                enabledItems.findIndex((item) => item.id === tabStopId),
              );
        let nextIndex: number | undefined;
        if (event.key === "ArrowRight") {
          nextIndex = (startIndex + 1) % enabledItems.length;
        } else if (event.key === "ArrowLeft") {
          nextIndex =
            (startIndex - 1 + enabledItems.length) % enabledItems.length;
        } else if (event.key === "Home") {
          nextIndex = 0;
        } else if (event.key === "End") {
          nextIndex = enabledItems.length - 1;
        } else {
          return;
        }
        event.preventDefault();
        const next = enabledItems[nextIndex];
        if (!next) return;
        if (next.id !== value) onChange(next.id);
        tabRefs.current.get(next.id)?.focus();
      },
      tabIndex: !disabled && id === tabStopId ? 0 : -1,
    };
  }

  return { getTabProps, registerTab };
}
