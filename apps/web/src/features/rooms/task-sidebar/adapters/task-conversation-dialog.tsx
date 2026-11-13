import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTaskActivities } from "@/features/work-items/use-task-activities";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubRunStatus } from "@/features/teamhub/teamhub-types";

import { CancelTaskButton } from "../../chat/cancel-task-button";
import { MessageMarkdown } from "../../chat/message-markdown";
import { useCancelRoomBackgroundTask } from "../../chat/use-room-background-tasks";
import { createRoomCardDecisionController } from "../../cards/room-card-decision-controller";
import {
  knownRoomMessageCard,
  RoomMessageCard,
} from "../../cards/room-message-card";
import { ActorAvatar } from "../../members/actor-avatar";
import { teamHubIdentityQueryOptions } from "../../room-queries";
import { RuntimeActivityPath } from "../../runtime-status/runtime-activity-path-view";
import {
  TaskActivityLinksProvider,
  TaskStatusPill,
} from "../../runtime-status/task-activity-block";
import { useTaskActivityEvents } from "../../runtime-status/use-task-activity-events";
import { PanelLoading } from "../panel-loading";
import { RunningDots } from "../running-dots";
import { RuntimeTrajectoryView } from "./runtime-trajectory-view";

/** Lets the task blocks in an activity log open their Task's conversation. */
export function TaskConversationProvider({
  children,
  roomId,
  tenantId,
}: {
  children: ReactNode;
  /** The Room whose Meta delegated these Tasks. */
  roomId: string;
  tenantId: string;
}) {
  const [task, setTask] = useState<{ id: string; title: string }>();
  return (
    <TaskActivityLinksProvider
      openTask={(id, title) => setTask({ id, title })}
      roomId={roomId}
      tenantId={tenantId}
    >
      {children}
      {task ? (
        <TaskConversationDialog
          onClose={() => setTask(undefined)}
          originRoomId={roomId}
          taskId={task.id}
          tenantId={tenantId}
          title={task.title}
        />
      ) : null}
    </TaskActivityLinksProvider>
  );
}

/**
 * A Task, read like a Room: the Meta's brief and follow-ups on the right, and
 * on the left everything its AlterEgo thought, ran and replied, with the cards
 * it raised, answerable here.
 */
export function TaskConversationDialog({
  onClose,
  originRoomId,
  taskId,
  tenantId,
  title,
}: {
  onClose: () => void;
  /** The Room whose Meta delegated the Task; its members can cancel it. */
  originRoomId: string;
  taskId: string;
  tenantId: string;
  title: string;
}) {
  const { client } = useTeamHubRuntime();
  const cancel = useCancelRoomBackgroundTask({
    client,
    roomId: originRoomId,
    tenantId,
  });
  const data = useTaskActivities({ enabled: true, taskId, tenantId });
  const execution = data.execution.data;
  const live =
    execution?.status === "running" ||
    execution?.status === "waiting_for_approval";
  const conversation = useQuery({
    queryKey: ["teamhub", tenantId, "task-conversation", taskId],
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/tasks/{taskId}/conversation", {
          params: { path: { taskId } },
        }),
      ),
    refetchInterval: live ? 3_000 : false,
  });
  const entries = useMemo(
    () =>
      [
        ...(conversation.data?.inputs ?? []).map((input) => ({
          at: input.created_at,
          input,
          key: `input:${input.id}`,
          kind: "input" as const,
        })),
        ...data.runStatuses.map((runStatus) => ({
          at: runStatus.created_at,
          key: `run:${runStatus.id}`,
          kind: "run" as const,
          runStatus,
        })),
        ...(conversation.data?.cards ?? []).map((card) => ({
          at: card.created_at,
          card,
          key: `card:${card.decision_id}`,
          kind: "card" as const,
        })),
      ].sort((a, b) => a.at.localeCompare(b.at)),
    [conversation.data, data.runStatuses],
  );
  const stopped =
    execution?.status === "canceled" || execution?.status === "failed";
  return (
    <ModalDialog
      closeOnBackdrop
      footer={
        live ? (
          <CancelTaskButton
            cancel={async () => {
              await cancel(taskId);
              await data.execution.refetch();
            }}
            prominent
            title={title}
          />
        ) : undefined
      }
      onClose={onClose}
      size="lg"
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{title}</span>
          {execution ? <TaskStatusPill status={execution.status} /> : null}
        </span>
      }
    >
      <div
        aria-label="Task conversation"
        className="flex min-h-64 flex-col gap-3 px-5 py-4 text-[15px] leading-[22px]"
        role="log"
      >
        {conversation.isPending || data.activities.isPending ? (
          <PanelLoading label="Loading task" />
        ) : (
          entries.map((entry) =>
            entry.kind === "input" ? (
              entry.input.source === "system" ? (
                <p
                  className="px-12 text-center text-xs text-app-muted"
                  key={entry.key}
                >
                  {entry.input.body}
                </p>
              ) : (
                <div
                  className="room-message-card pl-12"
                  data-current-actor="true"
                  key={entry.key}
                >
                  <div className="room-message-bubble max-w-[85%]">
                    <MessageMarkdown
                      authorKind={entry.input.author.kind}
                      body={entry.input.body}
                    />
                  </div>
                </div>
              )
            ) : entry.kind === "run" ? (
              <TaskConversationRun
                key={entry.key}
                paused={execution?.status === "waiting_for_approval"}
                roomId={data.roomId ?? ""}
                runStatus={entry.runStatus}
                stopped={stopped}
                tenantId={tenantId}
              />
            ) : (
              <div className="pr-12 pl-11" key={entry.key}>
                <TaskApprovalCard
                  messageId={entry.card.message_id}
                  roomId={entry.card.room_id}
                  tenantId={tenantId}
                />
              </div>
            ),
          )
        )}
      </div>
    </ModalDialog>
  );
}

/** One AlterEgo turn, step by step: its own history, or live progress. */
function TaskConversationRun({
  paused,
  roomId,
  runStatus,
  stopped,
  tenantId,
}: {
  paused: boolean;
  roomId: string;
  runStatus: TeamHubRunStatus;
  stopped: boolean;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const active = runStatus.status === "active" && !stopped;
  // Native history is read from the Runtime's session file on the Computer,
  // so it is read again only when the Run publishes a new step, which bumps
  // its revision, never on a timer.
  const history = useQuery({
    enabled: Boolean(roomId),
    placeholderData: keepPreviousData,
    queryKey: [
      "teamhub",
      tenantId,
      "rooms",
      roomId,
      "runs",
      runStatus.id,
      "activities",
      runStatus.revision,
    ],
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/rooms/{roomId}/runs/{runId}/activities", {
          params: { path: { roomId, runId: runStatus.run_id } },
        }),
      ),
    retry: false,
  });
  // Native history links a turn by its tool calls, so a turn without one,
  // or a live turn the Runtime has not written yet, has none; its published
  // steps stand in.
  const native =
    history.data?.status === "available" && history.data.records.length > 0
      ? history.data.records
      : undefined;
  const events = useTaskActivityEvents({
    tenantId,
    roomId,
    runStatusId: runStatus.id,
    revision: runStatus.revision,
    enabled: Boolean(roomId) && !native && !history.isPending,
  });
  const interrupted =
    (runStatus.status === "aborted" &&
      runStatus.stop_reason !== "task_terminal") ||
    (runStatus.status === "active" && stopped);
  return (
    <div className="flex gap-2 pr-12">
      <ActorAvatar
        actorId={runStatus.agent.id}
        kind="agent"
        name={runStatus.agent.display_name}
        size="sm"
      />
      <div className="min-w-0 flex-1">
        <p className="mb-1 flex items-center gap-2 text-sm text-app-ink">
          {runStatus.agent.display_name}
          {active && !paused ? (
            <span className="flex items-center gap-1.5 text-xs text-app-muted">
              Working
              <span
                aria-label="Agent working"
                className="flex h-3.5 items-center text-app-info"
                role="img"
              >
                <RunningDots />
              </span>
            </span>
          ) : null}
        </p>
        {native ? (
          <RuntimeTrajectoryView live={active} records={native} />
        ) : events.data ? (
          <div className="[&_ol]:px-0 [&_ol]:py-1">
            <RuntimeActivityPath
              embedded
              lifecycle={
                active
                  ? paused
                    ? "paused"
                    : "active"
                  : interrupted
                    ? "interrupted"
                    : "ended"
              }
              messages={[]}
              records={events.data.items}
            />
          </div>
        ) : (
          <PanelLoading label="Loading activity" />
        )}
      </div>
    </div>
  );
}

/**
 * A card the Task's AlterEgo raised. The card itself is a Message in the Room
 * that delegated the Task; it is answerable here too.
 */
function TaskApprovalCard({
  messageId,
  roomId,
  tenantId,
}: {
  messageId: string;
  roomId: string;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => ["teamhub", tenantId, "rooms", roomId, "messages", messageId],
    [messageId, roomId, tenantId],
  );
  const message = useQuery({
    queryKey,
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/rooms/{roomId}/messages/{messageId}", {
          params: { path: { roomId, messageId } },
        }),
      ),
    retry: false,
  });
  const controller = useMemo(
    () =>
      createRoomCardDecisionController({
        client,
        onResolved: (resolved) => {
          queryClient.setQueryData(queryKey, resolved);
          void queryClient.invalidateQueries({
            queryKey: ["teamhub", tenantId, "task-conversation"],
          });
        },
        roomId,
        tenantId,
      }),
    [client, queryClient, queryKey, roomId, tenantId],
  );
  const identity = useQuery(teamHubIdentityQueryOptions(client));
  const currentActorId = identity.data?.actors.find(
    (actor) => actor.tenant_id === tenantId,
  )?.id;
  const card = knownRoomMessageCard(message.data?.card);
  if (!card) return null;
  return (
    <RoomMessageCard
      card={card}
      currentActorId={currentActorId}
      messageId={messageId}
      onDecision={async (decision) => {
        await controller.decide(decision);
      }}
      roomId={roomId}
      tenantId={tenantId}
    />
  );
}
