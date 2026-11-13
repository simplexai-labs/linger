import { ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { useEffect, useId, useRef, useState } from "react";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubRoomBackgroundTask } from "@/features/teamhub/teamhub-types";
import { TaskConversationDialog } from "../task-sidebar/adapters/task-conversation-dialog";
import { CancelTaskButton } from "./cancel-task-button";
import {
  useCancelRoomBackgroundTask,
  useRoomBackgroundTasks,
} from "./use-room-background-tasks";

/**
 * One floating line above the composer while this Room's Meta has background
 * Tasks running. It opens a short list of what each one is doing, where
 * each can be opened or canceled, and disappears once every Task is done.
 */
export function BackgroundTasksIndicator({
  client,
  roomId,
  tenantId,
}: {
  client: TeamHubClient;
  roomId: string;
  tenantId: string;
}) {
  const tasks = useRoomBackgroundTasks({ client, roomId, tenantId });
  const cancel = useCancelRoomBackgroundTask({ client, roomId, tenantId });
  // The opened Task stays open after it finishes and leaves the list.
  const [opened, setOpened] = useState<TeamHubRoomBackgroundTask>();
  return (
    <>
      {tasks.length ? (
        // Floats over the bottom of the timeline instead of pushing the composer.
        <div className="relative h-0">
          <BackgroundTasksPill
            onCancel={cancel}
            onOpen={setOpened}
            tasks={tasks}
          />
        </div>
      ) : null}
      {opened ? (
        <TaskConversationDialog
          onClose={() => setOpened(undefined)}
          originRoomId={roomId}
          taskId={opened.id}
          tenantId={tenantId}
          title={opened.title}
        />
      ) : null}
    </>
  );
}

export function BackgroundTasksPill({
  now = Date.now(),
  onCancel,
  onOpen,
  tasks,
}: {
  now?: number;
  /** Stops one Task; it settles once the Task has left the list. */
  onCancel?: (taskId: string) => Promise<void>;
  /** Opens one Task's conversation. */
  onOpen?: (task: TeamHubRoomBackgroundTask) => void;
  tasks: readonly TeamHubRoomBackgroundTask[];
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  const count = tasks.length;
  return (
    <div
      className="absolute bottom-2 left-1/2 z-20 -translate-x-1/2"
      ref={root}
    >
      {open ? (
        <section
          aria-label="Background tasks"
          className="absolute bottom-full left-1/2 mb-1.5 w-[min(360px,calc(100vw-48px))] -translate-x-1/2 rounded-xl bg-popover p-1.5 shadow-md"
          id={listId}
        >
          <p className="px-2 pt-1 pb-1.5 text-[12px] leading-[18px] font-[470] text-app-muted">
            Background tasks
          </p>
          <ul className="flex flex-col">
            {tasks.map((task) => (
              <li
                className="flex items-center gap-1.5 rounded-md hover:bg-muted"
                key={task.id}
              >
                <button
                  aria-label={`Open task ${task.title}`}
                  className="grid min-w-0 flex-1 grid-cols-[6px_minmax(0,1fr)_auto] items-baseline gap-x-2.5 rounded-md py-1.5 pr-1 pl-2 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-app-focus disabled:cursor-default"
                  disabled={!onOpen}
                  onClick={() => {
                    setOpen(false);
                    onOpen?.(task);
                  }}
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className="size-1.5 self-center rounded-full bg-app-link"
                  />
                  <span className="truncate text-sm leading-5 text-app-ink">
                    {task.title}
                  </span>
                  <span className="text-[12px] leading-[18px] text-app-muted tabular-nums">
                    {runningFor(task.created_at, now)}
                  </span>
                  <span className="col-span-2 col-start-2 truncate text-[12px] leading-[18px] text-app-muted">
                    {task.requirement}
                  </span>
                </button>
                {onCancel ? (
                  <span className="shrink-0 pr-1">
                    <CancelTaskButton
                      cancel={() => onCancel(task.id)}
                      title={task.title}
                    />
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <button
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        className="flex h-7 items-center gap-1.5 rounded-full bg-app-surface pr-2.5 pl-2 text-[12px] leading-[18px] font-[470] whitespace-nowrap text-app-ink shadow-sm transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/40"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span
          aria-hidden="true"
          className="size-[11px] animate-spin rounded-full border-[1.5px] border-app-border-strong border-t-app-link motion-reduce:animate-none"
        />
        {count === 1
          ? "1 task running in the background"
          : `${count} tasks running in the background`}
        <span
          className={cn(
            "inline-flex text-app-muted transition-transform",
            open && "rotate-180",
          )}
        >
          <Icon icon={ArrowUp01Icon} size={12} />
        </span>
      </button>
    </div>
  );
}

/** How long a Task has been running, in the coarsest unit that fits. */
export function runningFor(createdAt: string, now: number) {
  const minutes = Math.max(
    0,
    Math.floor((now - new Date(createdAt).getTime()) / 60_000),
  );
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}
