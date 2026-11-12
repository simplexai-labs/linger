import { expect, it } from "vitest";
import { formatKnowledgeCliOutput } from "./domains/knowledge/format-output.js";

it("retains both lists, their kinds, bodies and section handles without clipping", () => {
  const entry = (prefix: string, index: number, kind: string) => ({
    citeAs: `${prefix}${index + 1}`,
    evidenceId: `raw_0123456789abcdef_${index.toString(16).padStart(16, "0")}`,
    kind,
    title: "Research",
    timeHint: "2026-09-01",
    content: "€✓".repeat(1500),
    sections: [{ sectionId: "summary", title: "Summary" }],
  });
  const items = Array.from({ length: 20 }, (_, index) =>
    entry("S", index, "room"),
  );
  const summaries = Array.from({ length: 10 }, (_, index) =>
    entry("W", index, "wiki"),
  );
  const result = formatKnowledgeCliOutput(
    "search",
    {},
    {
      schemaVersion: 2,
      status: "grounded",
      indexedAt: null,
      gaps: [],
      items,
      summaries,
      page: 1,
    },
  );
  expect(result.items).toEqual(items);
  expect(result.summaries).toEqual(summaries);
  expect(result.gaps).toEqual([]);
});

it("preserves exact read continuation and rejects a response for different requested offsets", () => {
  const evidenceId = "raw_0123456789abcdef_0123456789abcdef";
  const response = {
    schemaVersion: 1,
    evidenceId,
    title: "Research",
    source: { kind: "raw", ref: "source" },
    directory: [{ id: "summary", title: "Summary", level: 1 }],
    sections: [
      {
        id: "summary",
        title: "Summary",
        level: 1,
        content: "Content",
        offset: 4,
        truncated: true,
        nextOffset: 11,
      },
    ],
    missingSections: [],
    complete: false,
  };
  const result = formatKnowledgeCliOutput(
    "read",
    { evidenceId, sectionRequests: [{ sectionId: "summary", offset: 4 }] },
    response,
  );
  expect(result.sections).toEqual([
    {
      sectionId: "summary",
      title: "Summary",
      level: 1,
      content: "Content",
      offset: 4,
      truncated: true,
      nextOffset: 11,
    },
  ]);
  expect(result.schemaVersion).toBe(2);
  expect(() =>
    formatKnowledgeCliOutput(
      "read",
      { evidenceId, sectionRequests: [{ sectionId: "summary", offset: 0 }] },
      response,
    ),
  ).toThrow();
});
