// What the run status line shows for each Agent Run in a Room, built from
// `agent_run.status_changed` and the Run's runtime presentation events the
// way Web's Dock does.
import type {
  RoomRunStatus,
  RuntimePresentationEventRecord,
} from "../api/types";

/** What a Run is doing when it has not said in its own words. */
export type RunPhase = "working" | "thinking" | "queued";

export interface RunView {
  readonly run: RoomRunStatus;
  /**
   * The short line under the Agent's name, in the Run's own words; when
   * absent the screen words `phase`.
   */
  readonly line: string | undefined;
  readonly phase: RunPhase;
  /** The last presentation event ordinal folded into line. */
  readonly appliedOrdinal: string | undefined;
}

/** A Run the Agent is still working on: active and not yet replied. */
export function isWorking(run: RoomRunStatus): boolean {
  return run.status === "active" && !run.replied;
}

/** Keeps the newer of two snapshots of one Run; equal ordinals take the incoming one. */
export function mergeRun(
  current: RunView | undefined,
  incoming: RoomRunStatus,
): RunView {
  if (current && incoming.event_ordinal < current.run.event_ordinal)
    return current;
  return {
    run: incoming,
    line: current?.line,
    phase: current?.phase ?? "working",
    appliedOrdinal: current?.appliedOrdinal,
  };
}

/** Whether the Run has presentation events the view has not read yet. */
export function needsEvents(view: RunView): boolean {
  if (!isWorking(view.run)) return false;
  const applied =
    view.appliedOrdinal === undefined ? 0 : Number(view.appliedOrdinal);
  return view.run.event_ordinal > applied;
}

export function applyPresentationEvents(
  view: RunView,
  records: readonly RuntimePresentationEventRecord[],
  publishedThrough: string,
): RunView {
  let line = view.line;
  let phase = view.phase;
  const titles = new Map<string, string>();
  for (const record of records) {
    const event = record.event;
    switch (event.type) {
      case "status.changed":
        if (event.status === "thinking" || event.status === "queued") {
          phase = event.status;
          line = event.title || undefined;
        } else if (event.status === "working") {
          phase = "working";
          line = undefined;
        }
        break;
      case "activity.started":
        titles.set(event.activity_id, event.title);
        line = event.title;
        break;
      case "activity.updated":
        if (event.detail) line = event.detail;
        break;
      case "plan.updated": {
        const step = event.steps.find(
          (candidate) => candidate.status === "in_progress",
        );
        if (step) line = step.content;
        break;
      }
      default:
        break;
    }
  }
  return { ...view, line, phase, appliedOrdinal: publishedThrough };
}
