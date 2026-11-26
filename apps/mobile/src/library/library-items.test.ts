import { describe, expect, it } from "vitest";

import type { Translation } from "../i18n/language";
import { formatMessage } from "../i18n/messages";
import {
  dayHeading,
  documentFileName,
  documentTitle,
  groupByDay,
  shortWhen,
} from "./library-items";

const now = new Date(2026, 10, 23, 15, 0);
const english: Pick<Translation, "language" | "t"> = {
  language: "en",
  t: (message, ...values) => formatMessage(message, "en", undefined, values[0]),
};
const { t } = english;

describe("shortWhen", () => {
  it("reads like a phone list", () => {
    const today = new Date(2026, 10, 23, 9, 5);
    expect(shortWhen(today.toISOString(), english, now)).toBe(
      today.toLocaleTimeString("en", {
        hour: "numeric",
        minute: "2-digit",
      }),
    );
    expect(
      shortWhen(new Date(2026, 10, 22, 23).toISOString(), english, now),
    ).toBe("Yesterday");
    const monday = new Date(2026, 10, 17, 12);
    expect(shortWhen(monday.toISOString(), english, now)).toBe(
      monday.toLocaleDateString("en", { weekday: "short" }),
    );
    const older = new Date(2025, 2, 3, 12);
    expect(shortWhen(older.toISOString(), english, now)).toBe(
      older.toLocaleDateString("en", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
    );
    expect(shortWhen(undefined, english, now)).toBe("");
    expect(shortWhen("not a date", english, now)).toBe("");
  });

  it("treats a bare date as a local day", () => {
    expect(shortWhen("2026-11-22", english, now)).toBe("Yesterday");
  });
});

describe("groupByDay", () => {
  it("puts each day under one heading in first-seen order", () => {
    const items = [
      new Date(2026, 10, 23, 10).toISOString(),
      new Date(2026, 10, 22, 18).toISOString(),
      new Date(2026, 10, 23, 8).toISOString(),
    ];
    const groups = groupByDay(items, (item) => item, english, now);
    expect(groups.map((group) => [group.title, group.data.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
    ]);
    expect(dayHeading(undefined, english, now)).toBe("Earlier");
  });
});

describe("document names", () => {
  const base = { format: "pdf", representation_format: "pdf" };
  it("keeps a file's own name and gives a native Document its format", () => {
    expect(
      documentFileName(
        {
          ...base,
          title: "Report.pdf",
          draft_capability: "none",
        },
        t,
      ),
    ).toBe("Report.pdf");
    expect(
      documentFileName(
        { ...base, title: "Report", draft_capability: "none" },
        t,
      ),
    ).toBe("Report.pdf");
    const native = {
      format: "blocknote",
      representation_format: "markdown",
      title: "Plan.md",
      draft_capability: "write" as const,
    };
    expect(documentTitle(native, t)).toBe("Plan");
    expect(documentFileName(native, t)).toBe("Plan.md");
  });
});
