import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";

import { Icon, type IconSvgElement } from "@/components/ui/icon";
import { cn } from "@/lib/cn";

import { Hint } from "./computer-hint";

/** The building blocks the Computers list and detail share. */

export function StatusDot({
  tone,
}: {
  tone: "neutral" | "success" | "warning";
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        tone === "success"
          ? "bg-app-success"
          : tone === "warning"
            ? "bg-app-warning"
            : "bg-muted-foreground/50",
      )}
    />
  );
}

/** One soft tinted status pill in the Computer summary footer. */
export function ProgressChip({
  accent = "neutral",
  align = "start",
  attentionIcon,
  hint,
  icon,
  label,
  leading,
  onClick,
  state,
}: {
  /** Subtle tint for positive live connection pills. */
  accent?: "neutral" | "success";
  align?: "center" | "end" | "start";
  /** The icon an attention item carries, naming what the step asks for. */
  attentionIcon?: IconSvgElement;
  hint: string;
  icon?: IconSvgElement;
  label: string;
  leading?: ReactNode;
  onClick?: () => void;
  state: "attention" | "done" | "optional";
}) {
  const interactive = Boolean(onClick);
  const className = cn(
    "group inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors duration-150 motion-reduce:transition-none",
    state === "attention"
      ? "bg-[var(--app-status-warning-surface)] text-app-warning"
      : state === "optional"
        ? "bg-muted/55 text-muted-foreground"
        : accent === "success"
          ? "bg-[var(--app-status-success-surface)] text-app-success"
          : "bg-muted/65 text-foreground/90",
    interactive &&
      "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  );
  const content = (
    <>
      {leading ? (
        <span className="flex shrink-0 items-center">{leading}</span>
      ) : icon ? (
        <Icon icon={icon} size={14} />
      ) : null}
      <span className="truncate">{label}</span>
      {state === "attention" && attentionIcon ? (
        <Icon className="text-app-warning" icon={attentionIcon} size={12} />
      ) : null}
      {interactive ? (
        <Icon
          className="text-muted-foreground/55 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:transition-none"
          icon={ArrowRight01Icon}
          size={12}
        />
      ) : null}
    </>
  );
  return (
    <Hint align={align} focusable={!interactive} placement="top" text={hint}>
      {onClick ? (
        <button className={className} onClick={onClick} type="button">
          {content}
        </button>
      ) : (
        <span className={className}>{content}</span>
      )}
    </Hint>
  );
}

/** A clean settings list row: a quiet icon tile, title, subtitle, and optional action. */
export function ComputerRow({
  action,
  dimmed = false,
  hint,
  mark,
  onClick,
  showChevron,
  subtitle,
  title,
}: {
  action?: ReactNode;
  dimmed?: boolean;
  hint?: string;
  mark: ReactNode;
  onClick?: () => void;
  /** Forces a trailing chevron beside custom actions on navigable rows. */
  showChevron?: boolean;
  subtitle: ReactNode;
  title: ReactNode;
}) {
  const body = (
    <>
      <span
        className={cn("relative shrink-0", dimmed && "opacity-50 grayscale")}
      >
        {mark}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span
          className={cn(
            "block truncate text-sm font-medium",
            dimmed ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {title}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {subtitle}
        </span>
      </span>
    </>
  );
  const trailingChevron = (
    <Icon
      className="shrink-0 text-muted-foreground/45 transition-transform duration-150 group-hover/row:translate-x-0.5 group-hover/row:text-muted-foreground motion-reduce:transition-none"
      icon={ArrowRight01Icon}
      size={15}
    />
  );
  const row = onClick ? (
    <button
      className="group/row flex min-h-14 w-full items-center gap-3.5 px-4 py-3 transition-colors duration-150 hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
      onClick={onClick}
      type="button"
    >
      {body}
      {action}
      {showChevron || !action ? trailingChevron : null}
    </button>
  ) : (
    <div className="flex min-h-14 w-full items-center gap-3.5 px-4 py-3">
      {body}
      {action}
    </div>
  );
  return hint ? (
    <Hint align="start" fullWidth placement="top" text={hint}>
      {row}
    </Hint>
  ) : (
    row
  );
}

const rowMarkTones = {
  card: "bg-card text-foreground shadow-outline",
  neutral: "bg-muted/55 text-foreground/65",
} as const;

export type RowMarkTone = keyof typeof rowMarkTones;

export function RowMark({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: RowMarkTone;
}) {
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg",
        rowMarkTones[tone],
      )}
    >
      {children}
    </span>
  );
}
