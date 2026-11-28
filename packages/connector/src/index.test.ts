import { describe, expect, it } from "vitest";
import { createSeen } from "./index.js";

describe("createSeen", () => {
  it("reports the first sighting only", () => {
    const firstSighting = createSeen([], 60_000, () => 1_000);
    expect(firstSighting("a")).toBe(true);
    expect(firstSighting("a")).toBe(false);
  });

  it("lets the same id through after the window, because a surface may reuse it", () => {
    let now = 0;
    const firstSighting = createSeen([], 60_000, () => now);
    expect(firstSighting("a")).toBe(true);
    now = 60_001;
    expect(firstSighting("a")).toBe(true);
  });

  it("distinguishes two messages that carry the same text", () => {
    // A person really does send "1" twice; deduplicating on text would swallow
    // the second one and leave them unanswered.
    const firstSighting = createSeen([], 60_000, () => 0);
    expect(firstSighting("m1")).toBe(true);
    expect(firstSighting("m2")).toBe(true);
  });

  it("seeds from ids the host already handled, so a restart does not replay them", () => {
    const firstSighting = createSeen(["a"], 60_000, () => 0);
    expect(firstSighting("a")).toBe(false);
  });
});
