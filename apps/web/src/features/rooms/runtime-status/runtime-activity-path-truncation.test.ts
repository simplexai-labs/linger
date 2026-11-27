import { describe, expect, it } from "vitest";

import type { TeamHubRuntimePresentationEventRecord } from "@/features/teamhub/teamhub-types";

import { projectRuntimeActivityPath } from "./runtime-activity-path";

function record(
  id: string,
  event: Record<string, unknown>,
): TeamHubRuntimePresentationEventRecord {
  return {
    id,
    room_id: "room-1",
    run_status_id: "status-1",
    message_id: "message-1",
    event_ordinal: id,
    segment_id: "segment-1",
    event: { activity_id: "run", ...event },
  } as unknown as TeamHubRuntimePresentationEventRecord;
}

/** A high surrogate with no low surrogate after it is half a character. */
function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

describe("runtime activity command preview", () => {
  it("keeps a command up to the truncate threshold in full", () => {
    // The row shortened only above 88 before this change; 86 to 88 still fit.
    const command = "a".repeat(87);
    const items = projectRuntimeActivityPath([
      record("1", {
        type: "activity.started",
        kind: "command",
        title: "Bash",
        content: [{ content: command, format: "code", label: "Input" }],
      }),
    ]);
    const [item] = items;
    if (item?.kind !== "command") throw new Error("expected a command row");
    expect(item.name).toBe(command);
  });

  it("cuts a long command between characters, never inside one", () => {
    // 84 ASCII characters put the 85th code point across a unit cut.
    const command = `${"a".repeat(84)}\u{1F600}tail`;
    const items = projectRuntimeActivityPath([
      record("1", {
        type: "activity.started",
        kind: "command",
        title: "Bash",
        content: [{ content: command, format: "code", label: "Input" }],
      }),
    ]);
    const [item] = items;
    if (item?.kind !== "command") throw new Error("expected a command row");
    const summary = item.name;
    expect(hasLoneSurrogate(summary)).toBe(false);
    expect(summary.startsWith(`${"a".repeat(84)}\u{1F600}`)).toBe(true);
  });
});
