import {
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { DropdownOption, DropdownOptions } from "./dropdown-options";
import type { SelectItemProps } from "./select";
import {
  selectPopupContainingBlock,
  selectPopupFrame,
  selectPopupPosition,
  type SelectPopupPositionOptions,
} from "./select-popup-layout";

export interface AnchoredSelectPopupInput {
  readonly align?: SelectPopupPositionOptions["align"];
  /** Applies an exact `width` instead of `minWidth` on the popup container. */
  readonly fixedWidth?: boolean;
  /** Re-runs placement when list size changes (for example after filtering). */
  readonly layoutKey?: number;
  readonly onClose: (focusTrigger?: boolean) => void;
  readonly resolveWidth?: (input: {
    readonly triggerWidth: number;
    readonly viewportWidth: number;
  }) => number;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
}

/**
 * Shared top-layer popover lifecycle for Select and searchable picker popups:
 * `<dialog>`-aware portal placement, resize/scroll tracking, Escape and outside
 * pointer dismissal without resubscribing listeners when callbacks change.
 */
export function useAnchoredSelectPopup({
  align,
  fixedWidth = false,
  layoutKey = 0,
  onClose,
  resolveWidth,
  triggerRef,
}: AnchoredSelectPopupInput) {
  const popupRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({
    anchored: false,
    left: 0,
    maxWidth: 0,
    side: "bottom" as "bottom" | "top",
    top: 0,
    width: 0,
  });
  const closePopup = useEffectEvent(onClose);
  const supportsPopover =
    typeof HTMLElement.prototype.showPopover === "function";

  const place = useEffectEvent(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const portalRoot = trigger.closest("dialog") ?? document.body;
    const origin = supportsPopover
      ? null
      : selectPopupContainingBlock(portalRoot);
    const frame = selectPopupFrame(trigger.getBoundingClientRect(), origin, {
      height: window.innerHeight,
      width: window.innerWidth,
    });
    const resolvedWidth = resolveWidth?.({
      triggerWidth: frame.trigger.width,
      viewportWidth: frame.viewport.width,
    });
    const maxViewportWidth = Math.max(0, frame.viewport.width - 16);
    const measuredWidth = popupRef.current?.offsetWidth ?? 0;
    const placementWidth =
      resolvedWidth ??
      (measuredWidth > frame.trigger.width
        ? Math.min(measuredWidth, maxViewportWidth || measuredWidth)
        : undefined);
    const next = selectPopupPosition(
      frame.trigger,
      frame.viewport,
      popupRef.current?.offsetHeight,
      { align, width: placementWidth },
    );
    const styleWidth = resolvedWidth ?? frame.trigger.width;
    const anchored = Boolean(origin);
    const side: "bottom" | "top" =
      next.top < frame.trigger.top ? "top" : "bottom";
    setPosition((current) =>
      current.anchored === anchored &&
      current.left === next.left &&
      current.maxWidth === maxViewportWidth &&
      current.side === side &&
      current.top === next.top &&
      current.width === styleWidth
        ? current
        : {
            anchored,
            left: next.left,
            maxWidth: maxViewportWidth,
            side,
            top: next.top,
            width: styleWidth,
          },
    );
  });

  useLayoutEffect(() => {
    const popup = popupRef.current;
    // Keep the DOM inside the modal for focus, but escape its clipping in the top layer.
    if (supportsPopover) popup?.showPopover();

    const handleViewportChange = () => place();
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      if (supportsPopover) popup?.hidePopover();
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [supportsPopover, triggerRef]);

  useLayoutEffect(() => {
    place();
  }, [align, layoutKey, position.width, supportsPopover, triggerRef]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        !triggerRef.current?.contains(target) &&
        !popupRef.current?.contains(target)
      ) {
        closePopup();
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closePopup(true);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [triggerRef]);

  const portalRoot = triggerRef.current?.closest("dialog") ?? document.body;
  const style: CSSProperties = {
    inset: "auto",
    left: position.left,
    ...(position.maxWidth > 0 && !fixedWidth
      ? { maxWidth: position.maxWidth }
      : {}),
    position: position.anchored ? "absolute" : "fixed",
    top: position.top,
    // At least as wide as its trigger unless the caller sets a fixed width.
    ...(position.width > 0
      ? fixedWidth
        ? { width: position.width }
        : { minWidth: position.width }
      : {}),
  };

  return {
    popupRef,
    portalRoot,
    position,
    style,
    supportsPopover,
  };
}

export function SelectPopup({
  align,
  id,
  onChoose,
  onClose,
  options,
  triggerRef,
  value,
}: {
  align?: SelectPopupPositionOptions["align"];
  id: string;
  onChoose: (option: SelectItemProps) => void;
  onClose: (focusTrigger?: boolean) => void;
  options: SelectItemProps[];
  triggerRef: RefObject<HTMLButtonElement | null>;
  value: string;
}) {
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const { popupRef, portalRoot, position, style, supportsPopover } =
    useAnchoredSelectPopup({
      align,
      layoutKey: options.length,
      onClose,
      triggerRef,
    });

  useEffect(() => {
    const selected = options.findIndex((option) => option.value === value);
    const initial =
      selected >= 0
        ? selected
        : options.findIndex((option) => !option.disabled);
    const frameId = requestAnimationFrame(() =>
      optionRefs.current[initial]?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frameId);
  }, [options, value]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      onClose();
      return;
    }
    const direction =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    const current = optionRefs.current.findIndex(
      (option) => option === document.activeElement,
    );
    for (let offset = 1; offset <= options.length; offset += 1) {
      const index =
        (current + direction * offset + options.length) % options.length;
      if (!options[index]?.disabled) {
        optionRefs.current[index]?.focus();
        return;
      }
    }
  }

  return createPortal(
    <DropdownOptions
      className="z-[100] m-0 text-app-ink"
      data-select-portal=""
      data-side={position.side}
      id={id}
      onKeyDown={handleKeyDown}
      popover={supportsPopover ? "manual" : undefined}
      ref={popupRef}
      role="listbox"
      style={style}
    >
      {options.map((option, index) => (
        <DropdownOption
          aria-label={
            typeof option.children === "string" ? option.children : undefined
          }
          aria-selected={option.value === value}
          disabled={option.disabled}
          key={option.value}
          onClick={() => onChoose(option)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onChoose(option);
            }
          }}
          ref={(node) => {
            optionRefs.current[index] = node;
          }}
          role="option"
          tabIndex={-1}
        >
          {option.children}
        </DropdownOption>
      ))}
    </DropdownOptions>,
    portalRoot,
  );
}
