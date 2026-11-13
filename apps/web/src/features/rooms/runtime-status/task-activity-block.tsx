import {
  SentIcon,
  TaskAdd01Icon,
  TaskDaily01Icon,
  TaskDone01Icon,
} from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";

import { Icon } from "@/components/ui/icon";
import { StatusPill } from "@/components/ui/status-pill";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubTaskExecution } from "@/features/teamhub/teamhub-types";
import { tenantWorkItemTargetQueryOptions } from "@/features/work-items/work-item-queries";

import { RunningDots } from "../task-sidebar/running-dots";
import type { TaskCommand } from "./task-command";

interface TaskActivityLinks {
  tenantId: string;
  openTask?: (taskId: string, title: string) => void;
}

const TaskActivityLinksContext = createContext<TaskActivityLinks | null>(null);

/** Lets task blocks inside an activity log read Tasks and open one. */
export function TaskActivityLinksProvider({
  children,
  openTask,
  tenantId,
}: TaskActivityLinks & { children: ReactNode }) {
  return (
    <TaskActivityLinksContext.Provider value={{ openTask, tenantId }}>
      {children}
    </TaskActivityLinksContext.Provider>
  );
}

const VERBS: Record<TaskCommand["operation"], string> = {
  create: "Started",
  send: "Sent to",
  stop: "Stopped",
  check: "Checked on tasks",
};
const GLYPHS = {
  create: TaskAdd01Icon,
  send: SentIcon,
  stop: TaskDone01Icon,
  check: TaskDaily01Icon,
};

/**
 * One `teamhub task …` step of a Meta's activity: what it did, to which Task,
 * and that Task's current state. Opening it shows the Task's own activity.
 */
export function TaskActivityBlock({
  active = false,
  command,
  failed = false,
  taskId,
}: {
  active?: boolean;
  command: TaskCommand;
  failed?: boolean;
  taskId?: string;
}) {
  const links = useContext(TaskActivityLinksContext);
  const { client } = useTeamHubRuntime();
  const tenantId = links?.tenantId ?? "";
  const readable = Boolean(taskId && tenantId) && command.operation !== "check";
  const item = useQuery({
    ...tenantWorkItemTargetQueryOptions(client, tenantId, taskId ?? ""),
    enabled: readable && !command.name,
    retry: false,
  });
  const execution = useQuery({
    queryKey: ["teamhub", tenantId, "task-execution", taskId],
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/tasks/{taskId}/execution", {
          params: { path: { taskId: taskId ?? "" } },
        }),
      ),
    enabled: readable,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.status === "running" ||
      query.state.data?.status === "waiting_for_approval"
        ? 5_000
        : false,
  });
  const title =
    command.operation === "check"
      ? undefined
      : (command.name ?? item.data?.title);
  const open =
    taskId && title !== undefined && links?.openTask
      ? () => links.openTask?.(taskId, title)
      : undefined;
  const row = (
    <>
      <Icon className="shrink-0" icon={GLYPHS[command.operation]} size={15} />
      <span className={`shrink-0 ${active ? "town-shimmer-text" : ""}`}>
        {VERBS[command.operation]}
      </span>
      <span className="min-w-0 flex-1 truncate text-app-ink">{title}</span>
      {failed ? (
        <span className="shrink-0 text-app-danger">Failed</span>
      ) : execution.data ? (
        <TaskState execution={execution.data} />
      ) : null}
    </>
  );
  const rowClass = "flex min-h-8 w-full items-center gap-2 py-1.5 text-left";
  return (
    <li className="runtime-activity-step text-app-muted">
      {open ? (
        <button
          aria-label={`Open task ${title}`}
          className={`${rowClass} rounded-md hover:text-app-body focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-app-focus`}
          onClick={open}
          type="button"
        >
          {row}
        </button>
      ) : (
        <span className={rowClass}>{row}</span>
      )}
      {command.operation === "send" && command.message ? (
        <p className="-mt-1 mb-1 line-clamp-2 pl-[1.45rem] text-app-muted">
          “{command.message}”
        </p>
      ) : null}
    </li>
  );
}

function TaskState({ execution }: { execution: TeamHubTaskExecution }) {
  switch (execution.status) {
    case "running":
      return (
        <span
          aria-label="Task running"
          className="flex shrink-0 items-center text-app-info"
          role="img"
        >
          <RunningDots />
        </span>
      );
    case "waiting_for_approval":
      return <StatusPill tone="warning">Needs approval</StatusPill>;
    case "idle":
      return <StatusPill tone="success">Reported</StatusPill>;
    case "failed":
      return <StatusPill tone="danger">Failed</StatusPill>;
    case "canceled":
      return <StatusPill>Stopped</StatusPill>;
  }
}
