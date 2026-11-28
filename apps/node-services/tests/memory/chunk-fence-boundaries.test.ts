import { describe, expect, it, vi } from "vitest";
import { MemoryChunkIndex } from "../../src/memory/chunk-index.js";
import { chunkSource } from "../../src/memory/search/chunks.js";
import { documentRawSource } from "../../src/memory/search/source-store.js";

function expectSections(text: string, headings: string[]) {
  const chunks = chunkSource(text);
  expect(chunks.map((chunk) => chunk.heading)).toEqual(headings);
  expect(chunks.map((chunk) => chunk.content).join("")).toBe(text);
  expect(chunkSource(text)).toEqual(chunks);
  for (const chunk of chunks) {
    expect(chunk.headingPath).toEqual([chunk.heading]);
    expect(text.slice(chunk.start, chunk.end)).toBe(chunk.content);
    expect(chunk.lineStart).toBe(text.slice(0, chunk.start).split("\n").length);
    expect(chunk.lineEnd).toBe(text.slice(0, chunk.end - 1).split("\n").length);
  }
}

describe("Memory chunk fence boundaries", () => {
  it.each([
    ["```", "\n"],
    ["~~~", "\n"],
    ["```", "\r\n"],
    ["~~~", "\r\n"],
  ])("keeps %s lines with trailing text inside code (%j)", (fence, eol) => {
    const text = [
      "# Example",
      "",
      `${fence}md`,
      `${fence} still code`,
      "# Not a section",
      fence,
      "",
      "# After",
      "Visible section.",
      "",
    ].join(eol);
    expectSections(text, ["Example", "After"]);
  });

  it("does not open a backtick fence with backticks in its info string", () => {
    expectSections("# Example\n\n```with `ticks`\n\n# After\nText.\n", [
      "Example",
      "After",
    ]);
  });

  it("does not open a fence indented with a tab", () => {
    expectSections("# Example\n\n\t```\n\n# After\nText.\n", [
      "Example",
      "After",
    ]);
  });

  it("does not close a fence indented with a tab", () => {
    expectSections(
      "# Example\n\n```\n\t```\n# Not a section\n```\n\n# After\nText.\n",
      ["Example", "After"],
    );
  });

  it("keeps shorter and mismatched fences inside code", () => {
    expectSections(
      "# Example\n\n````\n```\n# Still code\n~~~~\n# Also code\n````\n\n# After\n",
      ["Example", "After"],
    );
  });

  it("accepts a longer closing fence with spaces and tabs after it", () => {
    expectSections(
      "# Example\r\n\r\n   ~~~with `ticks`\r\n# Still code\r\n  ~~~~~ \t\r\n\r\n# After\r\n",
      ["Example", "After"],
    );
  });

  it("reindexes an older profile even when the source hash and chunk count match", async () => {
    const text =
      "# Example\n\n```\n``` still code\n# Not a section\n```\n\n# After\n";
    const source = documentRawSource({
      identity: {
        agent_id: "agent_1",
        tenant_id: "tenant_1",
        user_artifact_owner_actor_id: "owner_1",
      },
      documentId: "document_1",
      textSourceKind: "file_version",
      textSourceId: "version_1",
      title: "Example",
      filename: "example.md",
      mediaType: "text/markdown",
      date: "2026-11-20",
      markdown: text,
    });
    const current = {
      active_sha256: source.contentHash,
      index_profile: "raw-md-v5",
      raw_present: true,
      chunk_count: 2,
      indexed_chunk_count: 2,
    };
    const headings: string[][] = [];
    const begin = vi.fn();
    const sql = Object.assign(
      vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
        const query = parts.join("?");
        if (query.includes("SELECT source.active_sha256"))
          return [{ ...current }];
        if (query.includes("UPDATE memory_index.sources")) {
          current.index_profile = values[3] as string;
          return [{ id: "source_1" }];
        }
        if (query.includes("SELECT content FROM memory_index.source_versions"))
          return [{ content: text }];
        if (query.includes("INSERT INTO memory_index.chunks"))
          headings.push(values[8] as string[]);
        return [];
      }),
      { begin, json: (value: unknown) => value },
    );
    begin.mockImplementation(
      async (operation: (transaction: typeof sql) => Promise<unknown>) =>
        operation(sql),
    );
    const index = new MemoryChunkIndex({
      dataRoot: "unused",
      sql: sql as never,
    });
    try {
      await expect(index.indexDatabaseSource(source, text)).resolves.toBe(true);
      expect(headings).toEqual([["Example"], ["After"]]);
      expect(current.index_profile).not.toBe("raw-md-v5");
      await expect(index.indexDatabaseSource(source, text)).resolves.toBe(
        false,
      );
      expect(begin).toHaveBeenCalledTimes(1);
    } finally {
      await index.close();
    }
  });
});
