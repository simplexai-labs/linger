import { dateTimeFormat } from "@/lib/date-format";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowLeft01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubMessage,
  TeamHubRunStatus,
  TeamHubTaskExecution,
} from "@/features/teamhub/teamhub-types";
import {
  isTaskActivityNotFound,
  taskExecutionStopped,
  useTaskActivities,
} from "@/features/work-items/use-task-activities";
import { roomMessagesInfiniteQueryOptions } from "../../room-queries";
import { RuntimeActivityPath } from "../../runtime-status/runtime-activity-path-view";
import { useTaskActivityEvents } from "../../runtime-status/use-task-activity-events";
import { PanelLoading } from "../panel-loading";

const stageLabels: Record<TeamHubTaskExecution["status"], string> = {
  running: "Running",
  waiting_for_approval: "Waiting for approval",
  idle: "Reported",
  failed: "Failed",
  canceled: "Stopped",
};

/** One Task's activity: each of its runs, newest last, and nothing else. */
export function TaskActivitiesPanelTab({
  hidden,
  onBack,
  taskId,
  tenantId,
  title,
}: {
  hidden: boolean;
  onBack?: () => void;
  taskId: string;
  tenantId: string;
  title?: string;
}) {
  const data = useTaskActivities({ tenantId, taskId, enabled: !hidden });
  const { client } = useTeamHubRuntime();
  const messages = useInfiniteQuery({
    ...roomMessagesInfiniteQueryOptions(client, tenantId, data.roomId ?? ""),
    enabled: !hidden && Boolean(data.roomId),
    refetchInterval:
      !hidden && data.roomId && !taskExecutionStopped(data.execution.data)
        ? 2_000
        : false,
  });
  const publicMessages =
    messages.data?.pages.flatMap((page) => page.items) ?? [];
  const execution = data.execution.data;
  const stopped = taskExecutionStopped(execution);
  const refresh = () => {
    void data.item.refetch();
    void data.execution.refetch();
    void data.activities.refetch();
    if (data.roomId) void messages.refetch();
  };
  return (
    <section
      className={hidden ? "hidden" : "flex h-full min-h-0 flex-col bg-card"}
      hidden={hidden || undefined}
      inert={hidden || undefined}
      data-testid="task-activities-panel"
      aria-label="Task activities"
    >
      <header className="flex min-h-14 shrink-0 items-center gap-2.5 border-b border-app-border px-4 py-2">
        {onBack ? (
          <button
            aria-label="Back to activity"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-app-focus"
            onClick={onBack}
            title="Back to activity"
            type="button"
          >
            <Icon icon={ArrowLeft01Icon} size={16} />
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-foreground">
            {title ?? data.item.data?.title ?? "Task"}
          </h2>
          <p className="truncate text-xs text-app-muted">
            {execution ? stageLabels[execution.status] : "Task"}
          </p>
        </div>
        <button
          type="button"
          aria-label="Refresh task"
          onClick={refresh}
          title="Refresh"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Icon icon={RefreshIcon} size={16} />
        </button>
      </header>
      <div className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto">
        {data.activities.error ? (
          <State>
            {isTaskActivityNotFound(data.activities.error)
              ? "You do not have access to this task’s work room activity."
              : "Activity could not be loaded. Try refreshing."}
          </State>
        ) : data.activities.isPending ? (
          <State busy>Loading activity…</State>
        ) : (
          <>
            {data.roomId && !data.connected ? (
              <State>Reconnecting to live activity…</State>
            ) : null}
            {!data.runStatuses.length ? <State>No activity yet.</State> : null}
            {data.roomId
              ? data.runStatuses.map((runStatus) => (
                  <TaskActivityGroup
                    key={runStatus.id}
                    runStatus={runStatus}
                    tenantId={tenantId}
                    roomId={data.roomId!}
                    visible={!hidden}
                    stopped={stopped}
                    paused={execution?.status === "waiting_for_approval"}
                    messages={publicMessages}
                    labeled={data.runStatuses.length > 1}
                  />
                ))
              : null}
            {data.activities.hasNextPage ? (
              <div className="px-4 py-3">
                <Button
                  size="compact"
                  tone="ghost"
                  disabled={data.activities.isFetchingNextPage}
                  onClick={() => void data.activities.fetchNextPage()}
                >
                  Load earlier activity
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

/** One run of the Task; a Task resumed more than once labels each run. */
function TaskActivityGroup({
  runStatus,
  tenantId,
  roomId,
  visible,
  stopped,
  paused: taskPaused,
  messages,
  labeled,
}: {
  runStatus: TeamHubRunStatus;
  tenantId: string;
  roomId: string;
  visible: boolean;
  stopped: boolean;
  paused: boolean;
  messages: TeamHubMessage[];
  labeled: boolean;
}) {
  const active = runStatus.status === "active" && !stopped;
  const paused = runStatus.status === "active" && taskPaused;
  const events = useTaskActivityEvents({
    tenantId,
    roomId,
    runStatusId: runStatus.id,
    revision: runStatus.revision,
    enabled: visible,
  });
  const interrupted =
    (runStatus.status === "aborted" &&
      runStatus.stop_reason !== "task_terminal") ||
    (runStatus.status === "active" && stopped);
  const lifecycle = active
    ? "active"
    : paused
      ? "paused"
      : interrupted
        ? "interrupted"
        : "ended";
  return (
    <div>
      {labeled ? (
        <p className="px-4 pt-3 text-2xs text-app-muted">
          {formatTime(runStatus.created_at)}
        </p>
      ) : null}
      {events.error ? (
        <State>Activity could not be loaded.</State>
      ) : !events.data ? (
        <State busy>Loading activity…</State>
      ) : (
        <RuntimeActivityPath
          records={events.data.items}
          messages={messages}
          lifecycle={lifecycle}
          embedded
        />
      )}
    </div>
  );
}
function State({
  busy = false,
  children,
}: {
  busy?: boolean;
  children: string;
}) {
  if (busy) return <PanelLoading label={children} />;
  return (
    <p className="flex items-center gap-2 px-4 py-5 text-xs leading-5 text-app-muted">
      {children}
    </p>
  );
}
function formatTime(value: string) {
  return dateTimeFormat({
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
