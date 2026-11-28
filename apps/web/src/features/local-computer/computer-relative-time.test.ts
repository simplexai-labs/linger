import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { relativeTime } from "./computer-relative-time";

const now = Date.parse("2026-11-22T12:00:00Z");
const minute = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("relativeTime", () => {
  it("chooses the unit from the value it prints", () => {
    const seen = (ms: number) => relativeTime(new Date(now - ms).toISOString());
    expect(seen(59 * minute)).toBe("59 minutes ago");
    expect(seen(59.6 * minute)).toBe("1 hour ago");
    expect(seen(23.6 * 60 * minute)).toBe("yesterday");
    expect(seen(2 * 86_400_000)).toBe("2 days ago");
  });

  it("keeps the values the ladder already named", () => {
    const seen = (ms: number) => relativeTime(new Date(now - ms).toISOString());
    expect(seen(30_000)).toBe("just now");
    expect(seen(5 * minute)).toBe("5 minutes ago");
    expect(seen(3 * 60 * minute)).toBe("3 hours ago");
    expect(seen(0)).toBe("just now");
  });
});
