import type { ReactNode } from "react";

/**
 * The rarely used actions of an Agent or Room panel, such as leaving or
 * removing it. They sit quietly at the bottom of the panel as text buttons
 * rather than as cards that compete with the settings above.
 */
export function PanelFooterActions({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div
      aria-label={label}
      className="mt-auto flex flex-wrap items-center justify-center gap-1 px-3 pt-6"
      role="group"
    >
      {children}
    </div>
  );
}

export function PanelFooterAction({
  children,
  danger = false,
  onClick,
  "data-voice-risk": voiceRisk,
}: {
  children: ReactNode;
  danger?: boolean;
  onClick: () => void;
  "data-voice-risk"?: "never";
}) {
  return (
    <button
      className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        danger
          ? "text-destructive hover:bg-destructive/5"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      }`}
      data-voice-risk={voiceRisk}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}
