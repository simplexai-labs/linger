import { ArrowRight01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { type ReactNode, useId } from "react";

import { Icon } from "@/components/ui/icon";
import type { TeamHubAgentReasoningEffort } from "@/features/teamhub/teamhub-types";
import { useT } from "@/i18n/use-translation";

import type { LocalComputer } from "./agent-move-target";
import { agentRuntimeMessages } from "./agent-runtime.messages";

/* The pieces Runtime settings and Create local agent share: a heading for the
   model, rows that open in place onto their choices, and the choices. */

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

export function Placeholder({ children }: { children: ReactNode }) {
  return (
    <span className="truncate font-normal text-muted-foreground">
      {children}
    </span>
  );
}

/** One setting as a row: its name and current value, opening in place onto
 * the choices for it. */
export function SettingRow({
  children,
  disabled = false,
  label,
  onToggle,
  open,
  value,
}: {
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onToggle: () => void;
  open: boolean;
  value: ReactNode;
}) {
  const panelId = useId();
  const expanded = open && !disabled;
  return (
    // Open, the row and its choices share one tinted block, like a menu
    // that unfolds from the row.
    <div className={`rounded-lg ${expanded ? "bg-accent" : ""}`}>
      <button
        aria-controls={expanded ? panelId : undefined}
        aria-expanded={disabled ? undefined : expanded}
        className={`flex w-full items-center gap-3 rounded-lg p-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default ${expanded ? "" : "enabled:hover:bg-accent"}`}
        disabled={disabled}
        onClick={onToggle}
        type="button"
      >
        <span className="w-28 shrink-0 whitespace-nowrap text-muted-foreground">
          {label}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 font-medium text-foreground">
          {value}
        </span>
        {disabled ? null : (
          <Icon
            className={`shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
            icon={ArrowRight01Icon}
          />
        )}
      </button>
      {expanded ? (
        <div className="px-1.5 pb-1.5" id={panelId}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

export interface Option {
  description?: ReactNode;
  disabled?: boolean;
  label: string;
  leading?: ReactNode;
  value: string;
}

/** The choices of one setting as radios, the chosen one ticked. */
export function OptionList({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: readonly Option[];
  value: string;
}) {
  const name = useId();
  return (
    <div aria-label={label} className="flex flex-col gap-0.5" role="radiogroup">
      {options.map((option) => (
        <OptionRow
          checked={option.value === value}
          key={option.value}
          name={name}
          onChange={onChange}
          option={option}
        />
      ))}
    </div>
  );
}

function OptionRow({
  checked,
  name,
  onChange,
  option,
}: {
  checked: boolean;
  name: string;
  onChange: (value: string) => void;
  option: Option;
}) {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors hover:bg-background/60 has-[:checked]:bg-background has-[:disabled]:cursor-default has-[:disabled]:opacity-50 has-[:disabled]:hover:bg-transparent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
      <input
        aria-describedby={option.description ? descriptionId : undefined}
        aria-labelledby={labelId}
        checked={checked}
        className="sr-only"
        disabled={option.disabled}
        name={name}
        onChange={() => onChange(option.value)}
        type="radio"
        value={option.value}
      />
      {option.leading}
      <span
        className="min-w-0 flex-1 truncate font-medium text-foreground"
        id={labelId}
      >
        {option.label}
      </span>
      {option.description ? (
        <span
          className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
          id={descriptionId}
        >
          {option.description}
        </span>
      ) : null}
      <span className="flex w-4 shrink-0 justify-center">
        {checked ? <Icon icon={Tick02Icon} size={14} /> : null}
      </span>
    </label>
  );
}

/** Reasoning efforts as one segmented choice. */
export function EffortSegments({
  efforts,
  label,
  labelOf,
  onChange,
  value,
}: {
  efforts: readonly TeamHubAgentReasoningEffort[];
  label: string;
  labelOf: (effort: TeamHubAgentReasoningEffort) => string;
  onChange: (value: TeamHubAgentReasoningEffort) => void;
  value?: TeamHubAgentReasoningEffort;
}) {
  const name = useId();
  return (
    <div
      aria-label={label}
      className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-md bg-background/50 p-[3px]"
      role="radiogroup"
    >
      {efforts.map((effort) => (
        <label
          className="cursor-pointer rounded-md py-1.5 text-center text-[13px] text-muted-foreground transition-colors has-[:checked]:bg-background has-[:checked]:font-medium has-[:checked]:text-foreground has-[:checked]:shadow-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
          key={effort}
        >
          <input
            checked={effort === value}
            className="sr-only"
            name={name}
            onChange={() => onChange(effort)}
            type="radio"
            value={effort}
          />
          {labelOf(effort)}
        </label>
      ))}
    </div>
  );
}
