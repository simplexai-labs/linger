import { describe, expect, it } from "vitest";

import type {
  RoomRunStatus,
  RuntimePresentationEventRecord,
} from "../api/types";
import {
  applyPresentationEvents,
  isWorking,
  mergeRun,
  needsEvents,
} from "./run-status";

function run(
  ordinal: number,
  status: RoomRunStatus["status"] = "active",
): RoomRunStatus {
  return {
    run_id: "run_1",
    room_id: "room_1",
    replied: false,
    agent: { id: "agent_1", kind: "agent", display_name: "Linger" },
    status,
    event_ordinal: ordinal,
    created_at: "2026-11-22T10:00:00Z",
    updated_at: "2026-11-22T10:00:00Z",
  };
}

describe("run status", () => {
  it("keeps the newer snapshot and asks for unread presentation events", () => {
    const first = mergeRun(undefined, run(3));
    expect(first.line).toBeUndefined();
    expect(first.phase).toBe("working");
    expect(needsEvents(first)).toBe(true);
    expect(mergeRun(first, run(2)).run.event_ordinal).toBe(3);
    const read = applyPresentationEvents(
      first,
      [
        {
          event_ordinal: "1",
          segment_id: "s",
          event: {
            type: "status.changed",
            status: "thinking",
            title: "Comparing flights",
          },
        },
        {
          event_ordinal: "2",
          segment_id: "s",
          event: {
            type: "activity.started",
            activity_id: "a1",
            kind: "search",
            title: "Searching the web",
          },
        },
      ] as RuntimePresentationEventRecord[],
      "3",
    );
    expect(read.line).toBe("Searching the web");
    expect(needsEvents(read)).toBe(false);
    expect(isWorking(mergeRun(read, run(4, "completed")).run)).toBe(false);
  });
});
