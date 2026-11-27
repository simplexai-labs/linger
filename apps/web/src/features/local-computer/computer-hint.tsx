import {
  type CSSProperties,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";

import { cn } from "@/lib/cn";

const viewportMarginPx = 12;

/**
 * Explanations on this page appear on hover or keyboard focus, so the page
 * itself only carries names, one-line states and actions.
 */
export function Hint({
  align = "center",
  children,
  className,
  floating = false,
  focusable = false,
  fullWidth = false,
  placement = "top",
  text,
}: {
  /** Horizontal anchor for the tooltip so edge triggers stay inside the viewport. */
  align?: "center" | "end" | "start";
  children: ReactNode;
  className?: string;
  /** Uses fixed viewport coordinates so tooltips escape overflow-x scroll containers. */
  floating?: boolean;
  /** Lets keyboard users reach a hint whose content is not itself a control. */
  focusable?: boolean;
  /** Uses block-level flex sizing without stacking competing display utilities. */
  fullWidth?: boolean;
  placement?: "top" | "bottom";
  text?: ReactNode;
}) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(
    null,
  );
  if (!text) return <>{children}</>;

  function measure() {
    if (!floating) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    const rawLeft =
      align === "start"
        ? rect.left
        : align === "end"
          ? rect.right
          : rect.left + rect.width / 2;
    const left = Math.min(
      Math.max(rawLeft, viewportMarginPx),
      window.innerWidth - viewportMarginPx,
    );
    const top = placement === "top" ? rect.top - 6 : rect.bottom + 6;
    setCoords({ left, top });
  }

  const floatingStyle: CSSProperties | undefined =
    floating && coords
      ? {
          left: coords.left,
          top: coords.top,
          transform:
            placement === "top"
              ? align === "start"
                ? "translateY(-100%)"
                : align === "end"
                  ? "translate(-100%, -100%)"
                  : "translate(-50%, -100%)"
              : align === "start"
                ? undefined
                : align === "end"
                  ? "translateX(-100%)"
                  : "translateX(-50%)",
        }
      : undefined;

  return (
    <span
      aria-describedby={focusable ? tooltipId : undefined}
      className={cn(
        "group/hint relative rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        fullWidth ? "flex w-full min-w-0" : "inline-flex",
        className,
      )}
      onFocus={measure}
      onPointerEnter={measure}
      ref={triggerRef}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the focusable wrapper reveals its hint for keyboard users
      tabIndex={focusable ? 0 : undefined}
    >
      {children}
      <span
        className={cn(
          "pointer-events-none invisible z-30 w-max max-w-60 rounded-md bg-primary px-2.5 py-1.5 text-left text-[11px] leading-snug font-normal text-primary-foreground shadow-sm opacity-0 transition-opacity delay-200 duration-150 group-focus-visible/hint:visible group-focus-visible/hint:opacity-100 group-has-[:focus-visible]/hint:visible group-has-[:focus-visible]/hint:opacity-100 group-hover/hint:visible group-hover/hint:opacity-100 motion-reduce:transition-none",
          floating
            ? "fixed"
            : cn(
                "absolute",
                align === "start"
                  ? "left-0"
                  : align === "end"
                    ? "right-0"
                    : "left-1/2 -translate-x-1/2",
                placement === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
              ),
        )}
        id={tooltipId}
        role="tooltip"
        style={floatingStyle}
      >
        {text}
      </span>
    </span>
  );
}

/**
 * A card for explanations that carry a command to copy. It opens on hover or
 * focus, and a tap on its trigger keeps it open, so touch screens reach it.
 */
export function HintCard({
  align = "start",
  children,
  content,
  floating = false,
  focusable = false,
}: {
  /** Which edge of the trigger the card lines up with. */
  align?: "start" | "end";
  children: ReactNode;
  content: ReactNode;
  /** Uses fixed viewport coordinates so the card escapes overflow-x scroll containers. */
  floating?: boolean;
  /** Lets keyboard users reach a card whose trigger is not itself a control. */
  focusable?: boolean;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [pinned, setPinned] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(
    null,
  );

  function measure() {
    if (!floating) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    const rawLeft = align === "end" ? rect.right : rect.left;
    const left = Math.min(
      Math.max(rawLeft, viewportMarginPx),
      window.innerWidth - viewportMarginPx,
    );
    setCoords({ left, top: rect.bottom });
  }

  const floatingStyle: CSSProperties | undefined =
    floating && coords
      ? {
          left: coords.left,
          top: coords.top,
          transform: align === "end" ? "translateX(-100%)" : undefined,
        }
      : undefined;

  return (
    <span
      className="group/card relative inline-flex"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setPinned(false);
      }}
      onFocus={measure}
      onPointerEnter={measure}
      onPointerUp={(event) => {
        // Taps inside the card, such as Copy, leave it open.
        if (!(event.target as Element).closest("[data-hint-card]")) {
          measure();
          setPinned((value) => !value);
        }
      }}
      ref={triggerRef}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the focusable wrapper reveals its card for keyboard users
      tabIndex={focusable ? 0 : undefined}
    >
      {children}
      {/* The transparent top padding bridges the gap so the card stays open while the pointer moves onto it. */}
      <span
        className={cn(
          "invisible z-30 w-80 pt-1.5 opacity-0 transition-opacity delay-150 duration-150 group-focus-within/card:visible group-focus-within/card:opacity-100 group-hover/card:visible group-hover/card:opacity-100 motion-reduce:transition-none",
          floating
            ? "fixed"
            : cn("absolute top-full", align === "end" ? "right-0" : "left-0"),
          pinned && "visible opacity-100",
        )}
        data-hint-card
        style={floatingStyle}
      >
        <span className="block rounded-lg bg-popover px-3 py-2.5 text-left text-xs text-muted-foreground shadow-md">
          {content}
        </span>
      </span>
    </span>
  );
}
