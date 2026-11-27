import { describe, expect, it, vi } from "vitest";
import { MemoryChunkIndex } from "../../src/memory/chunk-index.js";
import { chunkSource } from "../../src/memory/search/chunks.js";
import {
  sourceSearchText,
  wikiPageRawSource,
} from "../../src/memory/search/source-store.js";

describe("Wiki literal index profile", () => {
  it.each(["raw-md-v5", "raw-md-v6", "raw-md-v7"])(
    "reindexes stored %s chunks only when their text profile changed",
    async (profile) => {
      const markdown =
        "# Example\n\nUse `values[R1]` and `lookup(R2)`. Approved [R3].\n";
      const source = wikiPageRawSource({
        identity: {
          agent_id: "agent_1",
          tenant_id: "tenant_1",
          user_artifact_owner_actor_id: "human_1",
        },
        pageKey: "topics/example.md",
        title: "Example",
        documentId: "document_example",
        documentVersionId: "version_example",
        publishedAt: "2026-09-16T00:00:00Z",
        revision: "revision_1",
        markdown,
      });
      const chunks = chunkSource(sourceSearchText("wiki_page", markdown));
      const written: string[] = [];
      const sql = Object.assign(
        vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
          const query = parts.join("?");
          if (query.includes("SELECT source.active_sha256"))
            return [
              {
                active_sha256: source.contentHash,
                index_profile: profile,
                raw_present: true,
                chunk_count: chunks.length,
                indexed_chunk_count: chunks.length,
              },
            ];
          if (query.includes("UPDATE memory_index.sources"))
            return [{ id: "source_1" }];
          if (
            query.includes("SELECT content FROM memory_index.source_versions")
          )
            return [{ content: markdown }];
          if (query.includes("INSERT INTO memory_index.chunks"))
            written.push(values[7] as string);
          return [];
        }),
        {
          json: (value: unknown) => value,
          begin: vi.fn(
            async (run: (transaction: unknown) => Promise<boolean>) => run(sql),
          ),
        },
      );
      const index = new MemoryChunkIndex({
        dataRoot: "/tmp/wiki-literal-index",
        sql: sql as never,
      });
      try {
        expect(await index.indexDatabaseSource(source, markdown)).toBe(
          profile !== "raw-md-v7",
        );
        if (profile === "raw-md-v7") {
          expect(sql.begin).not.toHaveBeenCalled();
        } else {
          expect(written).toEqual(chunks.map((chunk) => chunk.content));
          expect(written.join("\n")).toContain("`values[R1]` and `lookup(R2)`");
          expect(written.join("\n")).not.toContain("[R3]");
        }
      } finally {
        await index.close();
      }
    },
  );
});
