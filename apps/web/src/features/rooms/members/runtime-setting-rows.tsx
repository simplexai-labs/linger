import type { ReactNode } from "react";

import { Select } from "@/components/ui/select";
import { useT } from "@/i18n/use-translation";

import type { LocalComputer } from "./agent-move-target";
import { agentRuntimeMessages } from "./agent-runtime.messages";

/* The pieces Runtime settings and Create local agent share: a row per
   setting with the product's Select, and the status shown beside a choice. */

export type StatusTone = "ok" | "off" | "warn";

const statusDotClass: Record<StatusTone, string> = {
  off: "bg-muted-foreground/50",
  ok: "bg-[var(--app-status-success-text)]",
  warn: "bg-[var(--app-status-warning-text)]",
};

export function StatusDot({ tone }: { tone: StatusTone }) {
  return (
    <span
      aria-hidden="true"
      className={`size-[7px] shrink-0 rounded-full ${statusDotClass[tone]}`}
    />
  );
}

/** A Computer's connection as a dot, with the words when it isn't simply
 * online or when `labelled` asks for them. */
export function ComputerStatus({
  computer,
  labelled = false,
}: {
  computer: LocalComputer;
  labelled?: boolean;
}) {
  const t = useT();
  const online = computer.status === "online";
  const tone: StatusTone = computer.upgrade_required
    ? "warn"
    : online
      ? "ok"
      : "off";
  const words = computer.upgrade_required
    ? t(
        online
          ? agentRuntimeMessages.onlineUpgrade
          : agentRuntimeMessages.offlineUpgrade,
      )
    : online
      ? t(agentRuntimeMessages.online)
      : t(agentRuntimeMessages.offline);
  return (
    <>
      <StatusDot tone={tone} />
      {labelled || tone !== "ok" ? (
        <span
          className={
            labelled
              ? undefined
              : "truncate text-xs font-normal text-muted-foreground"
          }
        >
          {words}
        </span>
      ) : (
        <span className="sr-only">{words}</span>
      )}
    </>
  );
}

/**
 * One setting as a row: its name on the left and the product's Select on
 * the right, whose choices open in the shared floating list.
 */
export function SettingSelect({
  "aria-label": ariaLabel,
  children,
  disabled = false,
  label,
  onValueChange,
  placeholder,
  value,
}: {
  "aria-label": string;
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 py-0.5">
      <span className="w-28 shrink-0 whitespace-nowrap pl-2.5 text-sm text-muted-foreground">
        {label}
      </span>
      <Select
        aria-label={ariaLabel}
        className="w-full min-w-0 flex-1"
        disabled={disabled}
        onValueChange={onValueChange}
        placeholder={placeholder}
        value={value}
      >
        {children}
      </Select>
    </div>
  );
}

/** A choice's content: an optional mark, its name, and its status after it. */
export function ChoiceLabel({
  leading,
  name,
  status,
}: {
  leading?: ReactNode;
  name: string;
  status?: ReactNode;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {leading}
      <span className="min-w-0 truncate">{name}</span>
      {status ? (
        <span className="flex shrink-0 items-center gap-1.5 pl-1 text-xs text-muted-foreground">
          {status}
        </span>
      ) : null}
    </span>
  );
}
