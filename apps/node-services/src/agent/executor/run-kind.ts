import { isRecord } from "@linger/service-kit";
import { runPriorities, type RunKind } from "../../model-tasks.js";
import type { ExecutionContextRef } from "./context-ref.js";
import type { RuntimeStateSchemas } from "./teamhub-runtime-state-client.js";
import type { Message } from "./types.js";

/** The fields of one queued Inbox Message that say what it is. */
interface QueuedMessageOrigin {
  readonly authorType?: string;
  readonly messageKind?: string;
  readonly firedRoutine?: boolean;
}

function messageRunKind(origin: QueuedMessageOrigin): RunKind {
  if (origin.messageKind === "agent_runtime")
    return origin.firedRoutine ? "routine" : "proactive";
  if (origin.messageKind === "task_terminal_notice") return "task_callback";
  return origin.authorType === "agent" ? "agent_message" : "chat";
}

function queuedNotification(message: Message) {
  const notification = (message as unknown as Record<string, unknown>)
    .acceptedNotification;
  return isRecord(notification) ? notification : undefined;
}

export function isTargetedRoomChat(message: Message, roomId: string): boolean {
  const notification = queuedNotification(message);
  return (
    notification?.inboxId === `room:${roomId}` &&
    notification.targeted === true &&
    Array.isArray(notification.messages) &&
    notification.messages.some(
      (entry: unknown) =>
        isRecord(entry) &&
        entry.authorType === "user" &&
        entry.messageKind === "conversation" &&
        entry.mentioned === true,
    )
  );
}

function inputRunKinds(message: Message): readonly RunKind[] {
  const notification = queuedNotification(message);
  // Only a feature's follow-up turn has no Inbox notification in a Meta Context.
  if (!notification) return ["follow_up"];
  if (
    typeof notification.inboxId === "string" &&
    notification.inboxId.startsWith("taskmeta:")
  )
    return ["task_callback"];
  return Array.isArray(notification.messages)
    ? (notification.messages as readonly QueuedMessageOrigin[]).map(
        messageRunKind,
      )
    : ["chat"];
}

/** Classifies the compact TeamHub projection with the same policy used after claim. */
export function queuedMetaRunKind(
  origins: readonly RuntimeStateSchemas["AgentRunInputOrigin"][],
): RunKind {
  return highestKind(
    origins.map((origin) => {
      if (!origin.notification) return "follow_up";
      if (origin.task_inbox) return "task_callback";
      return messageRunKind({
        authorType: origin.author_type,
        messageKind: origin.message_kind,
        firedRoutine: origin.fired_routine,
      });
    }),
  );
}

function highestKind(kinds: readonly RunKind[]): RunKind {
  return kinds.length
    ? kinds.reduce((best, kind) =>
        runPriorities[kind] < runPriorities[best] ? kind : best,
      )
    : "follow_up";
}

export function runKind(
  ref: ExecutionContextRef | undefined,
  messages: readonly Message[],
): RunKind {
  if (ref?.kind === "document") return "document";
  if (ref?.kind === "alter_ego") return "task";
  return highestKind(messages.flatMap(inputRunKinds));
}
