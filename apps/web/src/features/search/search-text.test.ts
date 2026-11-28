import { describe, expect, it } from "vitest";

import { formatLocale, translate } from "@/i18n/language";

import { relativeTimeLabel } from "./search-text";

const now = Date.parse("2026-11-22T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const minute = 60_000;

describe("relativeTimeLabel", () => {
  it("never reaches the next unit's name from below", () => {
    expect(relativeTimeLabel(ago(59 * minute), translate, now)).toBe("59m");
    expect(relativeTimeLabel(ago(59.6 * minute), translate, now)).toBe("1h");
    expect(relativeTimeLabel(ago(23.6 * 60 * minute), translate, now)).toBe(
      "1d",
    );
    expect(relativeTimeLabel(ago(6.9 * 24 * 60 * minute), translate, now)).toBe(
      new Date(now - 6.9 * 24 * 60 * minute).toLocaleDateString(
        formatLocale(),
        {
          day: "numeric",
          month: "short",
          year: "numeric",
        },
      ),
    );
  });

  it("keeps the compact ladder for whole values", () => {
    expect(relativeTimeLabel(ago(30_000), translate, now)).toBe("now");
    expect(relativeTimeLabel(ago(5 * minute), translate, now)).toBe("5m");
    expect(relativeTimeLabel(ago(3 * 60 * minute), translate, now)).toBe("3h");
    expect(relativeTimeLabel(ago(2 * 24 * 60 * minute), translate, now)).toBe(
      "2d",
    );
  });
});
