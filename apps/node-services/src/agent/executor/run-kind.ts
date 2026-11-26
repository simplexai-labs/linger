import { isRecord } from "@linger/service-kit";
import { runPriorities, type RunKind } from "../../model-tasks.js";
import type { ExecutionContextRef } from "./context-ref.js";
import type { Message } from "./types.js";

/** The fields of one queued Inbox Message that say what it is. */
interface QueuedMessageOrigin {
  readonly authorType?: string;
  readonly messageKind?: string;
  readonly firedRoutine?: boolean;
  /** A Human acted through this hidden Message and waits for the answer. */
  readonly humanWaiting?: boolean;
}

function messageRunKind(origin: QueuedMessageOrigin): RunKind {
  if (origin.messageKind === "agent_runtime") {
    if (origin.humanWaiting) return "chat";
    return origin.firedRoutine ? "routine" : "proactive";
  }
  if (origin.messageKind === "task_terminal_notice") return "task_callback";
  return origin.authorType === "agent" ? "agent_message" : "chat";
}

function inputRunKinds(message: Message): readonly RunKind[] {
  const notification = (message as unknown as Record<string, unknown>)
    .acceptedNotification;
  // Only a feature's follow-up turn has no Inbox notification in a Meta Context.
  if (!isRecord(notification)) return ["follow_up"];
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

const kindOrder = Object.keys(runPriorities) as RunKind[];

function highestKind(kinds: readonly RunKind[]): RunKind {
  return kinds.length
    ? kinds.reduce((best, kind) =>
        (runPriorities[kind] - runPriorities[best] ||
          kindOrder.indexOf(kind) - kindOrder.indexOf(best)) < 0
          ? kind
          : best,
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
