import { BotIcon } from "@hugeicons/core-free-icons";

import { Icon } from "@/components/ui/icon";
import { ActorAvatar } from "@/features/rooms/members/actor-avatar";
import {
  availabilityLabel,
  availabilitySummary,
} from "@/features/rooms/members/agent-availability-text";
import type { TeamHubTenantAgent } from "@/features/teamhub/teamhub-types";
import type { Translate } from "@/i18n/language";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import { availabilityOf, type AgentAvailability } from "./agent-availability";
import { Hint } from "./computer-hint";
import { appNames } from "./computer-readiness";
import { StatusDot } from "./computer-row";
import { computersMessages } from "./computers.messages";

type AgentStatus = AgentAvailability["status"];

const statusOrder: Record<AgentStatus, number> = {
  error: 0,
  offline: 1,
  unknown: 2,
  online: 3,
};

/**
 * The Agents placed on one Computer as compact horizontal cards meant for a
 * single-row scrollable rail.
 */
export function AgentChips({
  agentAvailabilities,
  agents,
  onOpenAgent,
}: {
  agentAvailabilities: ReadonlyMap<string, AgentAvailability>;
  agents: TeamHubTenantAgent[];
  onOpenAgent: (actorId: string) => void;
}) {
  const t = useT();
  if (agents.length === 0) {
    return (
      <div className="flex w-full items-center gap-2.5 rounded-2xl bg-muted/45 px-3.5 py-2.5 text-xs text-muted-foreground">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-card text-muted-foreground shadow-outline">
          <Icon icon={BotIcon} size={16} />
        </span>
        <p className="min-w-0 flex-1">{t(computersMessages.noAgents)}</p>
      </div>
    );
  }
  const sorted = [...agents].sort(
    (left, right) =>
      statusOrder[availabilityOf(agentAvailabilities, left, t).status] -
        statusOrder[availabilityOf(agentAvailabilities, right, t).status] ||
      left.actor.display_name.localeCompare(right.actor.display_name),
  );
  return (
    <>
      {sorted.map((agent) => (
        <AgentChip
          agent={agent}
          availability={availabilityOf(agentAvailabilities, agent, t)}
          key={agent.actor.id}
          onOpen={() => onOpenAgent(agent.actor.id)}
        />
      ))}
    </>
  );
}

function AgentChip({
  agent,
  availability,
  onOpen,
}: {
  agent: TeamHubTenantAgent;
  availability: AgentAvailability;
  onOpen: () => void;
}) {
  const t = useT();
  const tone = chipTone(availability);
  const warning = tone === "warning";
  const statusLine = compactStatusText(agent, availability, t);
  const dotTone = warning
    ? "warning"
    : availability.status === "online"
      ? "success"
      : "neutral";

  return (
    <Hint
      align="start"
      className="shrink-0"
      floating
      placement="top"
      text={`${agent.actor.display_name} · ${availabilityText(agent, availability, t)}`}
    >
      <button
        className={cn(
          "flex min-w-[164px] max-w-[232px] items-center gap-2.5 rounded-2xl px-3 py-2 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
          warning
            ? "bg-[var(--app-status-warning-surface)] hover:brightness-95"
            : "bg-muted/50 hover:bg-muted/85",
        )}
        onClick={onOpen}
        type="button"
      >
        <span
          className={cn(
            "relative shrink-0",
            availability.status === "offline" &&
              !warning &&
              "opacity-50 grayscale",
          )}
        >
          <ActorAvatar
            actorId={agent.actor.id}
            kind="agent"
            name={agent.actor.display_name}
            showTitle={false}
            size="nav"
          />
          {tone ? (
            <span
              aria-hidden
              className={cn(
                "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-card",
                tone === "warning"
                  ? "bg-app-warning"
                  : tone === "success"
                    ? "bg-app-success"
                    : "bg-muted-foreground/50",
              )}
            />
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium leading-tight text-foreground">
            {agent.actor.display_name}
          </span>
          <span
            className={cn(
              "mt-0.5 flex items-center gap-1.5 text-[11px] leading-tight",
              warning ? "text-app-warning" : "text-muted-foreground",
            )}
          >
            <StatusDot tone={dotTone} />
            <span className="truncate">{statusLine}</span>
          </span>
        </span>
      </button>
    </Hint>
  );
}

/** Whether an Agent requires owner attention on this page. */
export function agentNeedsAttention(availability: AgentAvailability) {
  return availability.status === "error" || needsSignIn(availability);
}

function needsSignIn(availability: AgentAvailability) {
  return (
    availability.localRuntimeStatus?.status === "authentication_required" &&
    availability.localRuntimeStatus.computer_status === "online"
  );
}

/** Amber marks something the user can fix on this page; grey is waiting. */
function chipTone(
  availability: AgentAvailability,
): "neutral" | "success" | "warning" | null {
  if (agentNeedsAttention(availability)) return "warning";
  if (availability.status === "online")
    return availability.activeTaskCount > 0 ? "success" : null;
  return "neutral";
}

function compactStatusText(
  agent: TeamHubTenantAgent,
  availability: AgentAvailability,
  t: Translate,
) {
  const runtimeType =
    availability.localRuntimeStatus?.runtime_type ??
    agent.runtime.placement?.runtime_type;
  const app = runtimeType ? appNames[runtimeType] : undefined;
  const wording = {
    current_activity: availability.currentActivity,
    label: availability.label,
    reason: availability.reason,
    status: availability.status,
  };
  const label = availabilityLabel(wording, t);
  const reason = availabilitySummary(wording, t);
  if (needsSignIn(availability) && app) {
    return t(computersMessages.appSignInNeeded, { app });
  }
  if (availability.status === "error") {
    return reason ?? (app ? `${label} · ${app}` : label);
  }
  if (availability.status === "online") {
    const tasks = availability.activeTaskCount;
    if (tasks) {
      return [app, t(computersMessages.tasksRunning, { count: tasks })]
        .filter(Boolean)
        .join(" · ");
    }
    return app ?? label;
  }
  return [label, app].filter(Boolean).join(" · ");
}

function availabilityText(
  agent: TeamHubTenantAgent,
  availability: AgentAvailability,
  t: Translate,
) {
  const runtimeType =
    availability.localRuntimeStatus?.runtime_type ??
    agent.runtime.placement?.runtime_type;
  const app = runtimeType ? appNames[runtimeType] : undefined;
  const wording = {
    current_activity: availability.currentActivity,
    label: availability.label,
    reason: availability.reason,
    status: availability.status,
  };
  const label = availabilityLabel(wording, t);
  const reason = availabilitySummary(wording, t);
  if (availability.status === "online") {
    const tasks = availability.activeTaskCount;
    return [
      label,
      app,
      tasks ? t(computersMessages.tasksRunning, { count: tasks }) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (needsSignIn(availability) && app)
    return `${label} · ${t(computersMessages.appSignInNeeded, { app })}`;
  return reason ? `${label} · ${reason}` : label;
}
