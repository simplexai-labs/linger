import { describe, expect, it } from "vitest";
import { formatKnowledgeCliOutput } from "./knowledge/format-output.js";
async function query(input: Record<string, unknown>, response: unknown) {
  return formatKnowledgeCliOutput("search", input, response);
}
async function readEvidence(input: Record<string, unknown>, response: unknown) {
  return formatKnowledgeCliOutput("read", input, response);
}
describe("Knowledge output parsing", () => {
  const entry = (citeAs: string, kind: string, extra = {}) => ({
    citeAs,
    evidenceId: "raw_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbb",
    kind,
    title: "Source",
    snippet: "Grounded evidence",
    sections: [{ sectionId: "chunk-1", title: "Chat" }],
    ...extra,
  });
  const grounded = (items: unknown[], summaries: unknown[] = []) => ({
    gaps: [],
    indexedAt: "2026-09-01T12:00:00Z",
    items,
    summaries,
    page: 1,
    schemaVersion: 2 as const,
    status: "grounded" as const,
  });
  const sessionFact = {
    text: "User cleaned white Adidas sneakers in April 2026 | When: April 2026 | Involving: user",
    factType: "world" as const,
    entities: ["user", "white Adidas"],
    occurredStart: "2026-04-01",
    occurredEnd: "2026-04-30",
    mentionedAt: "2026-05-24T01:00:00.000Z",
    evidenceId: "raw_1111111111111111_bbbbbbbbbbbbbbbb",
    sectionId: "chunk-1",
  };

  it("keeps both lists and the kind each entry names", async () => {
    const result = (await query(
      { query: "question" },
      grounded(
        [entry("S1", "room", { content: "Chat text", roomId: "room_1" })],
        [entry("W1", "wiki")],
      ),
    )) as {
      items: { kind: string; roomId: string }[];
      summaries: { kind: string }[];
    };
    expect(result.items[0]).toMatchObject({ kind: "room", roomId: "room_1" });
    expect(result.summaries[0]!.kind).toBe("wiki");
  });

  it("drops an invalid fact instead of failing the search", async () => {
    const result = await query(
      { query: "shoes" },
      {
        ...grounded([
          entry("S1", "room", { content: "I cleaned my white Adidas." }),
        ]),
        facts: [{ ...sessionFact, entities: ["x".repeat(97)] }, sessionFact],
      },
    );
    expect(result.items).toHaveLength(1);
    expect(
      (result.facts as { text: string }[]).map(({ text }) => text),
    ).toEqual([sessionFact.text]);
  });

  it("rejects undeclared fields in an evidence response", async () => {
    const returned = {
      ...evidenceResponse(),
      privatePath: "/private/source.md",
    };

    await expect(
      readEvidence(
        {
          evidenceId: evidenceResponse().evidenceId,
          sectionRequests: [{ sectionId: "work_ownership" }],
        },
        returned,
      ),
    ).rejects.toMatchObject({
      code: "personal_knowledge_unavailable",
      retryable: true,
    });
  });

  it("rejects undeclared entry fields and non-contiguous citation labels", async () => {
    for (const returned of [
      grounded([
        entry("S1", "room", { sourceUri: "teamhub://rooms/x/messages" }),
      ]),
      grounded([entry("S2", "room")]),
      grounded([entry("S1", "room"), entry("S3", "room")]),
      grounded([], [entry("S1", "wiki")]),
    ])
      await expect(
        query({ query: "question" }, returned),
      ).rejects.toMatchObject({
        code: "personal_knowledge_unavailable",
        retryable: true,
      });
  });

  it("accepts a later page that continues the labels", async () => {
    await expect(
      query(
        { query: "question", page: 2 },
        {
          ...grounded([entry("S6", "room"), entry("S7", "room")]),
          page: 2,
        },
      ),
    ).resolves.toMatchObject({ page: 2 });
  });

  it("accepts an empty result instead of turning missing knowledge into an error", async () => {
    await expect(
      query(
        { query: "question" },
        {
          gaps: [{ code: "no_relevant_evidence" }],
          indexedAt: null,
          items: [],
          summaries: [],
          page: 1,
          schemaVersion: 2 as const,
          status: "empty" as const,
        },
      ),
    ).resolves.toMatchObject({ status: "empty", items: [], summaries: [] });
  });
});

function evidenceResponse() {
  return {
    complete: false,
    directory: [
      { id: "work_ownership", level: 2, title: "Work ownership" },
      {
        id: "external_dependencies",
        level: 2,
        purpose: "Commitments assigned to other people.",
        title: "External dependencies",
      },
    ],
    evidenceId: "raw_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbb",
    missingSections: ["external_dependencies"],
    schemaVersion: 1 as const,
    sections: [
      {
        content: "- Zhang owns the hardware brief.",
        id: "work_ownership",
        level: 2,
        nextOffset: 32,
        offset: 0,
        title: "Work ownership",
        truncated: true,
      },
    ],
    source: {
      kind: "raw",
      ref: "raw_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbb",
    },
    timeHint: "2026-09-09",
    title: "Hardware partnership meeting",
  };
}
