import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryInternalClient,
  type PersonalKnowledgeQueryRequest,
} from "@linger/wire-contracts/node-services-internal/client";
import { startMemoryServer } from "../../src/memory/server.js";
import { MemoryScheduler } from "../../src/memory/scheduler.js";
import {
  knowledgeOutputBudget,
  queryPersonalKnowledge as queryWithDatabase,
  readPersonalKnowledgeEvidence as readWithDatabase,
} from "../../src/memory/knowledge-query.js";
import {
  listRawSources,
  listRawSourcesForAgent,
  readRawSource,
  readWorkspaceText,
  storeSessionSource as stageSessionSource,
  documentRawSource,
  wikiPageRawSource,
  type DocumentRawSourceInput,
  type RawSource,
} from "../../src/memory/search/source-store.js";
import type { SessionlyCollection } from "../../src/memory/types.js";
import { chunkSource } from "../../src/memory/search/chunks.js";
import { resolveSearchRawSources } from "../../src/memory/search/raw-query.js";

import { RawDatabaseFixture } from "./raw-database-fixture.js";
/** The text an entry shows: its body, else its snippet. */
const shown = (entry: { content?: string; snippet?: string }) =>
  entry.content ?? entry.snippet ?? "";
const databases = new Map<string, RawDatabaseFixture>();
async function captureDatabase(root: string) {
  const database = databases.get(root) ?? new RawDatabaseFixture();
  for (const source of await listRawSources(
    path.join(root, "agent_1"),
    identity,
  )) {
    const content = await readRawSource(path.join(root, "agent_1"), source);
    if (content !== undefined) database.put(source, content);
  }
  databases.set(root, database);
  return database;
}
async function storeSessionSource(
  ...args: Parameters<typeof stageSessionSource>
) {
  const result = await stageSessionSource(...args);
  await captureDatabase(args[0]);
  return result;
}
/** TeamHub documents exist only in the database, never as local Raw files. */
function storeDocumentSource(
  root: string,
  input: DocumentRawSourceInput,
): RawSource {
  const database = databases.get(root) ?? new RawDatabaseFixture();
  databases.set(root, database);
  const source = documentRawSource(input);
  database.put(source, input.markdown);
  return source;
}
function providerFor(
  root: string,
  override?: Parameters<typeof queryWithDatabase>[2],
) {
  const database = databases.get(root)!;
  return {
    search: database.search.bind(database),
    resolveRawSources: database.resolveRawSources.bind(database),
    readRawSource: database.readRawSource.bind(database),
    ...override?.chunkSearch,
  };
}
const queryPersonalKnowledge: typeof queryWithDatabase = (
  root,
  input,
  options,
) =>
  queryWithDatabase(root, input, {
    ...options,
    chunkSearch: providerFor(root, options),
  });
const readPersonalKnowledgeEvidence: typeof readWithDatabase = (
  root,
  input,
  options,
) =>
  readWithDatabase(root, input, {
    ...options,
    rawSourceProvider: { ...providerFor(root), ...options?.rawSourceProvider },
  });
const roots: string[] = [];
const identity = {
  agent_id: "agent_1",
  agent_actor_id: "actor_1",
  tenant_id: "tenant_1",
  user_artifact_owner_actor_id: "human_1",
};
const meetingMarkdown = [
  "# Hardware meeting",
  "## Speaker decision",
  "We drop the speaker; feedback plays through the phone app.",
  "## Open items",
  "Confirm BLE latency, battery life and certification scope.",
].join("\n\n");
const meetingDocument = {
  identity,
  documentId: "document_meeting",
  textSourceKind: "file_version" as const,
  textSourceId: "version_meeting",
  title: "Hardware meeting",
  filename: "meeting.md",
  mediaType: "text/markdown",
  date: "2026-09-02",
  markdown: meetingMarkdown,
};
const request = (query: string): PersonalKnowledgeQueryRequest => ({
  ...identity,
  query,
});
afterEach(async () => {
  vi.restoreAllMocks();
  databases.clear();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-bm25-raw-"));
  roots.push(root);
  const workspace = path.join(root, "agent_1");
  const anchorPath = "memory-state/evidence/2026-09-15/sessions/room_1.md";
  await fs.mkdir(path.dirname(path.join(workspace, anchorPath)), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(workspace, anchorPath),
    "---\ntype: Session Memory\ntitle: Acme delivery\ndate: 2026-09-15\nroom_id: room_1\nmemory_subject_key: agent_1\n---\n# Acme delivery\n\n## Summary\n\nProject is active.\n",
  );
  // A workspace file outside every Raw directory.
  const targetPath = path.join(workspace, "memory-state/outside.json");
  await fs.writeFile(targetPath, "{}\n");
  const collection: SessionlyCollection = {
    schemaVersion: 1,
    date: "2026-09-15",
    timeZone: "Asia/Shanghai",
    generatedAt: "2026-09-15T00:00:00Z",
    source: {
      teamhubDatabaseUrlSet: true,
      memoryRoot: root,
    },
    subjects: [
      {
        tenantId: "tenant_1",
        agentActorId: "actor_1",
        agentManagementId: "agent_1",
        agentDisplayName: "Agent",
        representedHumanActorId: "human_1",
        representedHumanDisplayName: "Alice",
        representedHumanAccountId: null,
        memorySubjectKey: "agent_1",
      },
    ],
    rooms: [
      {
        tenantId: "tenant_1",
        roomId: "room_1",
        roomName: "Acme delivery",
        agentActorId: "actor_1",
        agentManagementId: "agent_1",
        representedHumanActorId: "human_1",
        memorySubjectKey: "agent_1",
        relation: {
          agentIsMember: true,
          representedHumanIsMember: true,
          agentIsCreator: false,
          representedHumanIsCreator: false,
          includedBecause: ["agent_member"],
        },
        messages: [
          {
            id: "message_1",
            roomId: "room_1",
            authorActorId: "human_1",
            authorDisplayName: "Alice",
            authorKind: "human",
            messageKind: "text",
            createdAt: "2026-09-15T10:00:00+08:00",
            attachments: [],
            body: "The Cobalt limit is exactly 37.5k USD. It must not exceed this amount.",
          },
        ],
      },
    ],
    sourceCursor: {
      after: { messageId: "message_1", createdAt: "2026-09-15T10:00:00+08:00" },
    },
  };
  await storeSessionSource(root, collection);
  return { root, workspace, anchorPath, targetPath, collection };
}

function rawDirectory(workspace: string, date = "2026-09-15", room = "room_1") {
  return path.join(workspace, "memory-state/raw", ...date.split("-"), room);
}

describe("Raw Chunk search with PG Raw BM25 fallback", () => {
  it("uses the persisted chunk path through the existing knowledge interface", async () => {
    const fixtureData = await fixture();
    const [source] = await listRawSources(fixtureData.workspace, identity);
    const text = await readRawSource(fixtureData.workspace, source!);
    const chunk = chunkSource(text!).find((item) =>
      item.content.includes("37.5"),
    )!;
    let searched = false;
    const result = await queryPersonalKnowledge(
      fixtureData.root,
      request("Project is active"),
      {
        chunkSearch: {
          search: async (input) => {
            searched = true;
            expect(input).toMatchObject({
              agent_id: "agent_1",
              tenant_id: "tenant_1",
              user_artifact_owner_actor_id: "human_1",
            });
            expect(input.sourceIds).toBeUndefined();
            return [
              {
                chunkId: chunk.id,
                mergedChunkIds: [chunk.id],
                score: 1 / 61,
                sourceId: source!.id,
              },
            ];
          },
        },
      },
    );
    expect(searched).toBe(true);
    const [raw] = result.items;
    expect(raw).toMatchObject({
      kind: "room",
      roomId: "room_1",
      sections: expect.arrayContaining([
        expect.objectContaining({ sectionId: chunk.id }),
      ]),
    });
    expect(raw!.content).toContain("37.5");
    // Internal identifiers stay out of the result.
    expect(JSON.stringify(result)).not.toContain(fixtureData.anchorPath);
  });

  it("keeps the fused chunk order of each list", async () => {
    const fixtureData = await fixture();
    const source = storeDocumentSource(fixtureData.root, meetingDocument);
    const chunks = chunkSource(meetingMarkdown);
    const [first, last] = [chunks[0]!, chunks.at(-1)!];
    const limits: (number | undefined)[] = [];
    const result = await queryPersonalKnowledge(
      fixtureData.root,
      request("battery life"),
      {
        chunkSearch: {
          search: async (input) => {
            limits.push(input.limit);
            return [first, last].map((chunk, index) => ({
              chunkId: chunk.id,
              mergedChunkIds: [chunk.id],
              score: 1 / (61 + index),
              sourceId: source.id,
            }));
          },
        },
      },
    );
    // One ranked search per list.
    expect(limits).toEqual([60, 60]);
    expect(result.items[0]!.content).toContain(first.content.slice(0, 20));
  });

  it("returns Session facts beside Raw candidates without changing them", async () => {
    const fixtureData = await fixture();
    const [source] = await listRawSources(fixtureData.workspace, identity);
    const text = await readRawSource(fixtureData.workspace, source!);
    const chunk = chunkSource(text!)[0]!;
    const search = async () => [
      {
        chunkId: chunk.id,
        mergedChunkIds: [chunk.id],
        score: 1 / 61,
        sourceId: source!.id,
      },
    ];
    const fact = {
      text: "The project is active.",
      factType: "world" as const,
      mentionedAt: "2026-09-15T01:00:00.000Z",
      evidenceId: "raw_0123456789abcdef_0123456789abcdef",
      sectionId: chunk.id,
    };
    const without = await queryPersonalKnowledge(
      fixtureData.root,
      request("Project is active"),
      { chunkSearch: { search } },
    );
    const withFacts = await queryPersonalKnowledge(
      fixtureData.root,
      request("Project is active"),
      { chunkSearch: { search, searchFacts: async () => [fact] } },
    );
    expect(without.facts).toBeUndefined();
    expect(withFacts.facts).toEqual([fact]);
    expect(withFacts.items).toEqual(without.items);
  });

  it("returns one evidence candidate when several Chunk matches belong to the same Raw source", async () => {
    const fixtureData = await fixture();
    const [source] = await listRawSources(fixtureData.workspace, identity);
    const text = await readRawSource(fixtureData.workspace, source!);
    const chunks = chunkSource(text!);
    const chunk = chunks[0]!;
    const result = await queryPersonalKnowledge(
      fixtureData.root,
      request("Cobalt 37.5 limit"),
      {
        chunkSearch: {
          search: async () => [
            {
              chunkId: chunk.id,
              mergedChunkIds: [chunk.id],
              score: 1 / 61,
              sourceId: source!.id,
            },
            {
              chunkId: chunk.id,
              mergedChunkIds: [chunk.id],
              score: 1 / 62,
              sourceId: source!.id,
            },
          ],
        },
      },
    );
    expect(result.items).toHaveLength(1);
    expect(
      result.items[0]!.sections.map((section) => section.sectionId),
    ).toEqual(expect.arrayContaining([chunk.id]));
  });

  it("shows each entry's best match and lists its matched sections", async () => {
    const fixtureData = await fixture();
    const source = storeDocumentSource(fixtureData.root, meetingDocument);
    const chunks = chunkSource(meetingMarkdown);
    expect(chunks.length).toBeGreaterThan(1);
    const [first, last] = [chunks[0]!, chunks.at(-1)!];
    const match = (chunkId: string, rank: number) => ({
      chunkId,
      mergedChunkIds: [chunkId],
      score: 1 / (60 + rank),
      sourceId: source.id,
    });
    const result = await queryPersonalKnowledge(
      fixtureData.root,
      request("speaker latency"),
      {
        chunkSearch: {
          search: async () => [match(last.id, 1), match(first.id, 2)],
        },
      },
    );

    expect(result.items).toHaveLength(1);
    const [entry] = result.items;
    expect(entry!.content).toContain(last.content.slice(0, 20));
    expect(entry!.sections.map((section) => section.sectionId)).toEqual(
      expect.arrayContaining([first.id, last.id]),
    );
    expect(Object.keys(entry!).sort()).toEqual([
      "citeAs",
      "content",
      "evidenceId",
      "kind",
      "sections",
      "timeHint",
      "title",
    ]);
  });

  it("ranks originals and summaries in separate lists", async () => {
    const fixtureData = await fixture();
    const [room] = await listRawSources(fixtureData.workspace, identity);
    const roomChunk = chunkSource(
      (await readRawSource(fixtureData.workspace, room!))!,
    )[0]!;
    const markdown = `# Cobalt\n\n## Budget\n\n${"Cobalt budget history. ".repeat(40)}`;
    const wiki = wikiPageRawSource({
      identity,
      pageKey: "projects/cobalt",
      title: "Cobalt",
      documentId: "document_wiki_cobalt",
      documentVersionId: "version_wiki_cobalt",
      publishedAt: "2026-09-16T00:00:00Z",
      revision: "revision_1",
      markdown,
    });
    databases.get(fixtureData.root)!.put(wiki, markdown);
    const wikiChunk = chunkSource(markdown).at(-1)!;
    const kinds: (readonly string[] | undefined)[] = [];
    const result = await queryPersonalKnowledge(
      fixtureData.root,
      request("Cobalt budget"),
      {
        chunkSearch: {
          // Each list asks only for its own origins; the summary ranks first
          // here, as a long report can on keyword scores alone.
          search: async (input) => {
            kinds.push(input.originKinds);
            return [
              {
                chunkId: wikiChunk.id,
                mergedChunkIds: [wikiChunk.id],
                score: 1 / 61,
                sourceId: wiki.id,
              },
              {
                chunkId: roomChunk.id,
                mergedChunkIds: [roomChunk.id],
                score: 1 / 62,
                sourceId: room!.id,
              },
            ];
          },
        },
      },
    );

    expect(kinds).toEqual([
      ["room", "recording", "mail", "my_pages", "pocket_note", "profile"],
      ["wiki", "period_summary"],
    ]);
    expect(result.items.map(({ citeAs, kind }) => [citeAs, kind])).toEqual([
      ["S1", "room"],
    ]);
    expect(result.summaries.map(({ citeAs, kind }) => [citeAs, kind])).toEqual([
      ["W1", "wiki"],
    ]);
    expect(result.items[0]!.content).toContain("37.5");
    expect(result.summaries[0]!.content).toContain("Cobalt budget history");
  });

  it("searches one list with the whole budget when scoped", async () => {
    const fixtureData = await fixture();
    const kinds: (readonly string[] | undefined)[] = [];
    const result = await queryPersonalKnowledge(
      fixtureData.root,
      { ...request("Cobalt"), scope: "summaries" },
      {
        chunkSearch: {
          search: async (input) => {
            kinds.push(input.originKinds);
            return [];
          },
          resolveRawSources: async () => [],
        },
      },
    );
    expect(kinds).toEqual([["wiki", "period_summary"]]);
    expect(result).toMatchObject({ scope: "summaries", items: [], page: 1 });
  });

  it("uses PG-backed Raw manifests and bytes when the filesystem projection is absent", async () => {
    const fixtureData = await fixture();
    const [source] = await listRawSources(fixtureData.workspace, identity);
    const text = await readRawSource(fixtureData.workspace, source!);
    const chunk = chunkSource(text!).find((item) =>
      item.content.includes("37.5"),
    )!;
    await fs.rm(path.join(fixtureData.workspace, "memory-state/raw"), {
      recursive: true,
    });
    const provider = {
      resolveRawSources: async () => [source!],
      readRawSource: async () => text,
      search: async () => [
        {
          chunkId: chunk.id,
          mergedChunkIds: [chunk.id],
          score: 1 / 61,
          sourceId: source!.id,
        },
      ],
    };

    const result = await queryPersonalKnowledge(
      fixtureData.root,
      request("What is the exact Cobalt limit?"),
      { chunkSearch: provider },
    );
    const [raw] = result.items;
    expect(shown(raw!)).toContain("37.5k USD");

    const evidence = await readPersonalKnowledgeEvidence(
      fixtureData.root,
      {
        ...identity,
        evidence_id: raw!.evidenceId,
        section_requests: [{ section_id: raw!.sections[0]!.sectionId }],
      },
      { rawSourceProvider: provider },
    );
    expect(evidence.sections[0]?.content).toContain("37.5k USD");
  });

  it("falls back to scoped Raw BM25 when the configured chunk index returns no candidates", async () => {
    const fixtureData = await fixture();
    const result = await queryPersonalKnowledge(
      fixtureData.root,
      request("What is the exact Cobalt limit?"),
      {
        chunkSearch: {
          search: async () => [],
        },
      },
    );

    expect(
      result.items.some((item) => item.evidenceId.startsWith("raw_")),
    ).toBe(true);
  });

  it("reports a limited BM25 fallback with candidates as partial", async () => {
    const fixtureData = await fixture();
    for (let index = 0; index < 31; index += 1) {
      storeDocumentSource(fixtureData.root, {
        ...meetingDocument,
        documentId: `document_${index}`,
        textSourceId: `version_${index}`,
        title: `Cobalt note ${index}`,
        markdown: `# Cobalt note ${index}\n\nThe Cobalt limit was discussed.`,
      });
    }
    const result = await queryPersonalKnowledge(
      fixtureData.root,
      request("Cobalt limit"),
      { chunkSearch: { search: async () => [] } },
    );

    expect(result.items.length).toBeGreaterThan(0);
    expect(result.gaps).toEqual([{ code: "source_search_limited" }]);
    expect(result.status).toBe("partial");
  });

  it("never revives local Raw when the database has no current source", async () => {
    const f = await fixture();
    const provider = {
      search: async () => [],
      resolveRawSources: async () => [],
      readRawSource: async () => undefined,
    };
    const result = await queryWithDatabase(
      f.root,
      request("Cobalt exact amount"),
      { chunkSearch: provider },
    );
    expect(
      result.items.some((item) => item.evidenceId.startsWith("raw_")),
    ).toBe(false);
    const unconfigured = await queryWithDatabase(
      f.root,
      request("Cobalt exact amount"),
    );
    expect(
      unconfigured.items.some((item) => item.evidenceId.startsWith("raw_")),
    ).toBe(false);
  });

  it("uses PG Raw for BM25 fallback after the local projection is lost", async () => {
    const fixtureData = await fixture();
    const [source] = await listRawSources(fixtureData.workspace, identity);
    const text = await readRawSource(fixtureData.workspace, source!);
    await fs.rm(rawDirectory(fixtureData.workspace), { recursive: true });
    const result = await queryPersonalKnowledge(
      fixtureData.root,
      request("What is the exact Cobalt limit?"),
      {
        chunkSearch: {
          search: async () => [],
          resolveRawSources: async () => [source!],
          readRawSource: async () => text,
        },
      },
    );
    expect(
      result.items.some((item) => item.evidenceId.startsWith("raw_")),
    ).toBe(true);
    await expect(
      fs.stat(rawDirectory(fixtureData.workspace)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves a Document only while the database holds it", async () => {
    const fixtureData = await fixture();
    const source = storeDocumentSource(fixtureData.root, {
      identity,
      documentId: "document_retired",
      textSourceKind: "file_version",
      textSourceId: "version_retired",
      title: "Retired",
      filename: "retired.md",
      mediaType: "text/markdown",
      date: "2026-09-15",
      markdown: "# Retired\n\nPrivate evidence.",
    });
    const references = [
      {
        kind: "document",
        sourceId: source.id,
        anchorPath: source.anchorPath,
        date: source.date,
      },
    ];
    expect(
      (
        await resolveSearchRawSources(
          fixtureData.workspace,
          identity,
          references,
          databases.get(fixtureData.root),
        )
      ).sources,
    ).toHaveLength(1);
    const provider = {
      search: async () => [],
      resolveRawSources: async () => [],
    };
    expect(
      (
        await resolveSearchRawSources(
          fixtureData.workspace,
          identity,
          references,
          provider,
        )
      ).sources,
    ).toEqual([]);
  });

  it("does not widen local fallback to another owner", async () => {
    const fixtureData = await fixture();
    const [source] = await listRawSources(fixtureData.workspace, identity);
    const references = [
      {
        kind: "room",
        sourceId: source!.id,
        anchorPath: source!.anchorPath,
        date: source!.date,
      },
    ];
    const provider = {
      search: async () => [],
      resolveRawSources: async () => [],
    };
    const resolved = await resolveSearchRawSources(
      fixtureData.workspace,
      { ...identity, user_artifact_owner_actor_id: "another_owner" },
      references,
      provider,
    );
    expect(resolved.sources).toEqual([]);
  });

  it("returns a visible partial-result gap on chunk failure without using local Raw BM25", async () => {
    const fixtureData = await fixture();
    await expect(
      queryPersonalKnowledge(
        fixtureData.root,
        request("What is the exact Cobalt limit?"),
        {
          chunkSearch: {
            search: async () => {
              throw new Error("chunk index unavailable");
            },
          },
        },
      ),
    ).resolves.toMatchObject({
      status: "partial",
      gaps: expect.arrayContaining([{ code: "raw_chunk_search_unavailable" }]),
    });
  });

  it("reads query-returned raw IDs through authenticated HTTP without relaxing source authorization", async () => {
    const fixtureData = await fixture();
    const server = await startMemoryServer({
      dataRoot: fixtureData.root,
      host: "127.0.0.1",
      port: 0,
      scheduler: new MemoryScheduler(
        {
          concurrency: 1,
          timeZone: "Asia/Shanghai",
          weeklyDay: 1,
        },
        async () => undefined,
      ),
      serviceToken: "memory-test-token",
      chunkSearch: databases.get(fixtureData.root),
    });
    const client = createMemoryInternalClient({
      baseUrl: server.url,
      getAccessToken: async () => "memory-test-token",
    });
    try {
      const candidates = await client.query(request("Cobalt source text"));
      expect(candidates.status).toBe("grounded");
      expect(candidates.items[0]?.content).toBeTruthy();
      const candidate = candidates.items[0]!;
      const input = {
        ...identity,
        evidence_id: candidate.evidenceId,
        section_requests: [{ section_id: candidate.sections[0]!.sectionId }],
      };
      const evidence = await client.readEvidence(input);
      expect(evidence.evidenceId).toBe(candidate.evidenceId);
      expect(evidence.source.kind).toBe("room");
      const sharedEvidence = await client.readEvidence({
        ...input,
        agent_actor_id: "actor_general_same_owner",
      });
      expect(sharedEvidence).toEqual(evidence);
      expect(
        evidence.sections.map((section) => section.content).join("\n"),
      ).toContain("37.5");
      for (const changed of [
        { tenant_id: "tenant_2" },
        { user_artifact_owner_actor_id: "human_2" },
        { agent_id: "agent_2" },
      ]) {
        await expect(
          client.readEvidence({ ...input, ...changed }),
        ).rejects.toMatchObject({ status: 404 });
      }
      for (const evidenceId of [
        "raw_1_2",
        `raw_${"a".repeat(64)}`,
        "../../memory/secret.md",
      ]) {
        await expect(
          client.readEvidence({ ...input, evidence_id: evidenceId }),
        ).rejects.toMatchObject({ status: 400 });
      }
      const unauthorized = createMemoryInternalClient({
        baseUrl: server.url,
        getAccessToken: async () => "wrong-token",
      });
      await expect(unauthorized.readEvidence(input)).rejects.toMatchObject({
        status: 401,
      });
    } finally {
      await server.close();
    }
  });

  it("stores a business-dated snapshot without changing source or evidence identity", async () => {
    const f = await fixture();
    const [source] = await listRawSources(f.workspace, identity);
    expect(source?.id).toBe(
      "b2e531135f4678a6d3280ae0da6d2fc2151ae6b8c3fda7e7c65c6b9d19d1a329",
    );
    expect(await fs.readdir(rawDirectory(f.workspace))).toEqual(
      expect.arrayContaining(["manifest.json", `${source!.contentHash}.md`]),
    );
    expect(await readRawSource(f.workspace, source!)).toContain("37.5");
    expect(
      await listRawSourcesForAgent(f.workspace, identity.agent_id),
    ).toEqual([source]);
    const item = (await queryPersonalKnowledge(f.root, request("Cobalt")))
      .items[0]!;
    expect(item.evidenceId).toBe(
      `raw_${source!.id.slice(0, 16)}_${source!.contentHash.slice(0, 16)}`,
    );
    expect(JSON.stringify(item)).not.toContain("graph/raw");
  });

  it("never falls back past an invalid dated manifest", async () => {
    const f = await fixture();
    const [source] = await listRawSources(f.workspace, identity);
    expect(await readRawSource(f.workspace, source!)).toContain("37.5");

    await fs.writeFile(
      path.join(rawDirectory(f.workspace), "manifest.json"),
      "invalid",
    );
    expect(await readRawSource(f.workspace, source!)).toBeUndefined();
    expect(
      await listRawSourcesForAgent(f.workspace, identity.agent_id),
    ).toEqual([]);
    expect(
      (await queryPersonalKnowledge(f.root, request("Cobalt"))).items.some(
        (item) => shown(item).includes("37.5"),
      ),
    ).toBe(true);
  });

  it("reclaims replaced snapshots while retaining other Rooms, dates and unrelated files", async () => {
    const f = await fixture();
    const [before] = await listRawSources(f.workspace, identity);
    for (const [date, roomId] of [
      ["2026-09-14", "room_1"],
      ["2026-09-15", "room_2"],
    ]) {
      const collection = structuredClone(f.collection);
      collection.date = date!;
      collection.rooms[0]!.roomId = roomId!;
      const anchor = path.join(
        f.workspace,
        `memory-state/evidence/${date}/sessions/${roomId}.md`,
      );
      await fs.mkdir(path.dirname(anchor), { recursive: true });
      await fs.writeFile(anchor, "Other session summary");
      await storeSessionSource(f.root, collection);
    }
    await fs.writeFile(
      path.join(rawDirectory(f.workspace), "notes.txt"),
      "keep",
    );
    f.collection.rooms[0]!.messages[0]!.body = "Cobalt updated to 39";
    await storeSessionSource(f.root, f.collection);
    const sources = await listRawSources(f.workspace, identity);
    expect(sources).toHaveLength(3);
    const after = sources.find((source) => source.id === before!.id)!;
    expect(after.contentHash).not.toBe(before!.contentHash);
    expect(await fs.readdir(rawDirectory(f.workspace))).toEqual(
      expect.arrayContaining([
        "notes.txt",
        "manifest.json",
        `${after.contentHash}.md`,
      ]),
    );
    expect(await fs.readdir(rawDirectory(f.workspace))).toHaveLength(3);
    for (const source of sources)
      expect(await readRawSource(f.workspace, source)).toBeDefined();
  });

  it("preserves the previous published snapshot when a new manifest cannot be committed", async () => {
    const f = await fixture();
    const [before] = await listRawSources(f.workspace, identity);
    f.collection.rooms[0]!.messages[0]!.body = "Cobalt updated to 39";
    const rename = fs.rename.bind(fs);
    const failure = vi
      .spyOn(fs, "rename")
      .mockImplementation(async (from, to) => {
        if (to === path.join(rawDirectory(f.workspace), "manifest.json"))
          throw new Error("manifest publication failed");
        return rename(from, to);
      });
    await expect(storeSessionSource(f.root, f.collection)).rejects.toThrow(
      "manifest publication failed",
    );
    expect(await listRawSources(f.workspace, identity)).toEqual([before]);
    expect(await readRawSource(f.workspace, before!)).toContain("37.5");
    failure.mockRestore();
    await storeSessionSource(f.root, f.collection);
    expect(await fs.readdir(rawDirectory(f.workspace))).toHaveLength(2);
    expect(
      shown(
        (await queryPersonalKnowledge(f.root, request("Cobalt"))).items[0]!,
      ),
    ).toContain("39");
  });

  it("does not overwrite or prune another identity at the same date and Room path", async () => {
    const f = await fixture();
    const [before] = await listRawSources(f.workspace, identity);
    for (const changed of ["tenant", "owner"] as const) {
      const collection = structuredClone(f.collection);
      if (changed === "tenant") {
        collection.subjects[0]!.tenantId = "tenant_2";
        collection.rooms[0]!.tenantId = "tenant_2";
      } else {
        collection.subjects[0]!.representedHumanActorId = "human_2";
      }
      await expect(storeSessionSource(f.root, collection)).rejects.toThrow(
        "destination identity",
      );
    }
    expect(await listRawSources(f.workspace, identity)).toEqual([before]);
    expect(await readRawSource(f.workspace, before!)).toContain("37.5");
  });

  it("serializes concurrent source replacements so cleanup cannot remove the current snapshot", async () => {
    const f = await fixture();
    await Promise.all(
      Array.from({ length: 6 }, (_, index) => {
        const collection = structuredClone(f.collection);
        collection.rooms[0]!.messages[0]!.body = `Cobalt revision ${index}`;
        return storeSessionSource(f.root, collection);
      }),
    );
    const [source] = await listRawSources(f.workspace, identity);
    expect(await readRawSource(f.workspace, source!)).toContain("revision 5");
    expect(await fs.readdir(rawDirectory(f.workspace))).toHaveLength(2);
  });

  it("rejects invalid business dates, misplaced manifests and symlinked date directories", async () => {
    const f = await fixture();
    for (const date of ["2026-02-30", "2026/09/15", "../../outside"]) {
      const collection = structuredClone(f.collection);
      collection.date = date;
      await expect(storeSessionSource(f.root, collection)).rejects.toThrow(
        "Invalid Session source",
      );
    }
    const misplaced = rawDirectory(f.workspace, "2026-09-16");
    await fs.mkdir(path.dirname(misplaced), { recursive: true });
    await fs.rename(rawDirectory(f.workspace), misplaced);
    expect(await listRawSources(f.workspace, identity)).toEqual([]);
    expect(
      await listRawSourcesForAgent(f.workspace, identity.agent_id),
    ).toEqual([]);
    await fs.rename(misplaced, rawDirectory(f.workspace));
    const year = path.join(f.workspace, "memory-state/raw/2026");
    const outside = path.join(f.root, "outside-year");
    await fs.rename(year, outside);
    await fs.symlink(outside, year);
    expect(await listRawSources(f.workspace, identity)).toEqual([]);
    await expect(storeSessionSource(f.root, f.collection)).rejects.toThrow(
      "Unsafe source directory",
    );
    expect(await fs.readdir(path.join(outside, "09/15/room_1"))).toHaveLength(
      2,
    );
  });

  it("finds raw-only facts with zero graph keyword hits and reads exact chunks", async () => {
    const f = await fixture();
    const result = await queryPersonalKnowledge(
      f.root,
      request("Cobalt limit exactly how much"),
    );
    const [item] = result.items;
    expect(item).toMatchObject({ kind: "room", roomId: "room_1" });
    expect(shown(item!)).toContain("37.5");
    expect(JSON.stringify(result)).not.toContain(f.root);
    const read = await readPersonalKnowledgeEvidence(f.root, {
      ...identity,
      evidence_id: item!.evidenceId,
      section_requests: [{ section_id: item!.sections[0]!.sectionId }],
    });
    expect(read.sections[0]?.content).toContain("Alice");
    expect(read.sections[0]?.content).toContain("must not exceed this amount");
    expect(read.complete).toBe(true);
    expect(result.status).toBe("grounded");
    expect(item!.content).toContain("must not exceed this amount");
  });

  it("rejects cross-tenant, cross-owner and cross-Agent reads, even with a known evidence ID", async () => {
    const f = await fixture();
    const result = await queryPersonalKnowledge(f.root, request("Cobalt"));
    const item = result.items[0]!;
    for (const changed of [
      { tenant_id: "tenant_2" },
      { user_artifact_owner_actor_id: "human_2" },
      { agent_id: "agent_2" },
    ]) {
      expect(
        (
          await queryPersonalKnowledge(f.root, {
            ...request("Cobalt"),
            ...changed,
          })
        ).items,
      ).toEqual([]);
      await expect(
        readPersonalKnowledgeEvidence(f.root, {
          ...identity,
          ...changed,
          evidence_id: item.evidenceId,
          section_requests: [{ section_id: item.sections[0]!.sectionId }],
        }),
      ).rejects.toThrow("not found");
    }
  });

  it("keeps authorized Raw readable without writing graph files", async () => {
    const f = await fixture();
    const result = await queryPersonalKnowledge(
      f.root,
      request("Cobalt limit source text"),
    );
    const item = result.items[0]!;
    expect(shown(item)).toContain("37.5");
    const read = await readPersonalKnowledgeEvidence(f.root, {
      ...identity,
      evidence_id: item.evidenceId,
      section_requests: [{ section_id: item.sections[0]!.sectionId }],
    });
    expect(read.sections[0]?.content).toContain("37.5");
    await expect(
      fs.access(path.join(f.workspace, "memory/subject-graph.json")),
    ).rejects.toThrow();
  });

  it("uses database bytes even when the filesystem projection is changed or deleted", async () => {
    const f = await fixture();
    const item = (
      await queryPersonalKnowledge(f.root, request("Cobalt exact amount"))
    ).items[0]!;
    await fs.writeFile(
      path.join(f.workspace, f.anchorPath),
      "Forged projection",
    );
    await fs.rm(path.join(f.workspace, "memory-state/raw"), {
      recursive: true,
      force: true,
    });
    const read = await readPersonalKnowledgeEvidence(f.root, {
      ...identity,
      evidence_id: item.evidenceId,
      section_requests: [{ section_id: item.sections[0]!.sectionId }],
    });
    expect(read.sections[0]?.content).toContain("37.5");
    expect(read.sections[0]?.content).not.toContain("Forged");
  });

  it("rejects path traversal and symlinks instead of following them", async () => {
    const f = await fixture();
    await fs.symlink(
      f.targetPath,
      path.join(f.workspace, "memory-state/linked.md"),
    );
    expect(
      await readWorkspaceText(f.workspace, "memory-state/linked.md"),
    ).toBeUndefined();
    expect(
      await readWorkspaceText(
        f.workspace,
        "../agent_1/memory-state/outside.json",
      ),
    ).toBeUndefined();
    const source = (await listRawSources(f.workspace, identity))[0]!;
    const rawPath = path.join(
      f.workspace,
      "memory-state/raw/2026/09/15/room_1",
      `${source.contentHash}.md`,
    );
    await fs.unlink(rawPath);
    await fs.symlink(f.targetPath, rawPath);
    expect(
      (await queryPersonalKnowledge(f.root, request("Cobalt"))).items.some(
        (item) => shown(item).includes("37.5"),
      ),
    ).toBe(true);
  });

  it("reuses identical snapshot identity and refuses a changed snapshot through an old evidence ID", async () => {
    const f = await fixture();
    const first = (await queryPersonalKnowledge(f.root, request("Cobalt")))
      .items[0]!;
    await storeSessionSource(f.root, f.collection);
    expect(
      (await queryPersonalKnowledge(f.root, request("Cobalt"))).items[0]
        ?.evidenceId,
    ).toBe(first.evidenceId);
    f.collection.rooms[0]!.messages[0]!.body =
      "The Cobalt limit is updated to 39k USD.";
    await fs.writeFile(
      path.join(f.workspace, f.anchorPath),
      "# Acme updated\n\nNew summary.",
    );
    await storeSessionSource(f.root, f.collection);
    expect(
      (await queryPersonalKnowledge(f.root, request("Cobalt"))).items[0]
        ?.evidenceId,
    ).not.toBe(first.evidenceId);
    await expect(
      readPersonalKnowledgeEvidence(f.root, {
        ...identity,
        evidence_id: first.evidenceId,
        section_requests: [{ section_id: first.sections[0]!.sectionId }],
      }),
    ).rejects.toThrow("not found");
  });
});

describe("knowledge output budget", () => {
  // Small enough that these fixtures always overflow it.
  const OUTPUT_BUDGET_CHARS = 4_000;
  const chars = (value: unknown) => JSON.stringify(value).length;
  // Unspaced text of three UTF-8 bytes per character, as in CJK sources.
  const wide = (seed: number, length: number) =>
    Array.from({ length }, (_, index) =>
      String.fromCodePoint(0x4e00 + ((seed * 131 + index * 7) % 2_000)),
    ).join("");
  const document = (index: number, sections: string[]) => {
    const markdown = [
      `# Report ${index}`,
      ...sections.map((text, section) => `## Part ${section}\n\n${text}`),
    ].join("\n\n");
    return {
      markdown,
      input: {
        ...meetingDocument,
        documentId: `document_${index}`,
        textSourceId: `version_${index}`,
        title: `Report ${index}`,
        filename: `report-${index}.md`,
        markdown,
      },
    };
  };

  it("drops entries without a body, then facts, but keeps the floor bodies within the budget", async () => {
    const fixtureData = await fixture();
    const matches = Array.from({ length: 10 }, (_, index) => {
      const { input, markdown } = document(index, [
        wide(index, 1_200),
        wide(index + 50, 1_200),
      ]);
      const source = storeDocumentSource(fixtureData.root, input);
      return chunkSource(markdown).map((chunk) => ({
        chunkId: chunk.id,
        mergedChunkIds: [chunk.id],
        sourceId: source.id,
      }));
    });
    const ranked = [
      ...matches.map((chunks) => chunks[0]!),
      ...matches.map((chunks) => chunks.at(-1)!),
    ].map((match, rank) => ({ ...match, score: 1 / (61 + rank) }));
    const facts = Array.from({ length: 30 }, (_, index) => ({
      text: wide(index + 100, 300),
      factType: "world" as const,
      mentionedAt: "2026-09-15T01:00:00.000Z",
      evidenceId: "raw_0123456789abcdef_0123456789abcdef",
      sectionId: ranked[0]!.chunkId,
    }));

    const result = await queryPersonalKnowledge(
      fixtureData.root,
      request("Report"),
      {
        chunkSearch: {
          search: async () => ranked,
          searchFacts: async () => facts,
        },
        outputBudgetChars: OUTPUT_BUDGET_CHARS,
      },
    );

    expect(chars(result)).toBeLessThanOrEqual(OUTPUT_BUDGET_CHARS);
    expect(result.gaps.map((gap) => gap.code)).toContain("results_trimmed");
    expect(result.status).toBe("partial");
    // Entries without a body go first, from the lowest rank; the floor
    // entries keep their bodies and every entry stays in rank order.
    expect(result.facts ?? []).toEqual(
      facts.slice(0, result.facts?.length ?? 0),
    );
    expect(result.items.length).toBeGreaterThanOrEqual(3);
    expect(result.items.length).toBeLessThan(10);
    expect(result.items.map((item) => item.title)).toEqual(
      result.items.map((_, index) => `Report ${index}`),
    );
    expect(result.items.map((item) => item.citeAs)).toEqual(
      result.items.map((_, index) => `S${index + 1}`),
    );
    for (const item of result.items.slice(0, 3))
      expect(item.content).toBeTruthy();
    // Room left over gives later entries a body too; the rest show a snippet.
    for (const item of result.items) {
      expect(shown(item).length).toBeGreaterThan(0);
      expect(item.sections.length).toBeGreaterThan(0);
    }
    expect(result.summaries).toEqual([]);
  });

  it("continues the same search on the next page", async () => {
    const fixtureData = await fixture();
    const ranked = Array.from({ length: 12 }, (_, index) => {
      const { input, markdown } = document(index, [wide(index, 1_200)]);
      const source = storeDocumentSource(fixtureData.root, input);
      const chunk = chunkSource(markdown).at(-1)!;
      return {
        chunkId: chunk.id,
        mergedChunkIds: [chunk.id],
        sourceId: source.id,
        score: 1 / (61 + index),
      };
    });
    const search = (page?: number) =>
      queryPersonalKnowledge(
        fixtureData.root,
        { ...request("Report"), ...(page ? { page } : {}) },
        {
          chunkSearch: { search: async () => ranked },
          outputBudgetChars: OUTPUT_BUDGET_CHARS,
        },
      );

    const first = await search();
    const second = await search(first.nextPage);
    expect(first).toMatchObject({ page: 1, nextPage: 2 });
    expect(second.page).toBe(2);
    const titles = [...first.items, ...second.items].map((item) => item.title);
    expect(titles).toEqual(titles.map((_, index) => `Report ${index}`));
    expect(second.items[0]!.citeAs).toBe(`S${first.items.length + 1}`);
  });

  it("sizes the budget by the model's context window", () => {
    expect(knowledgeOutputBudget(undefined)).toBe(14_400);
    expect(knowledgeOutputBudget(8_192)).toBe(1_474);
    expect(knowledgeOutputBudget(64_896)).toBe(11_681);
    expect(knowledgeOutputBudget(1_000_000)).toBe(30_000);
  });

  it("stays within the Daemon's tool output limit", async () => {
    // Memory cannot import the Daemon, so this reads its constants: a change
    // on one side that the other misses would let a Runtime cut results.
    const source = await fs.readFile(
      new URL(
        "../../../computer/local-daemon/internal/provider/native/tool_output.go",
        import.meta.url,
      ),
      "utf8",
    );
    const constant = (name: string) =>
      Number(new RegExp(`\\b${name} = (\\d+)`).exec(source)?.[1]);
    const percent = constant("toolOutputWindowPercent");
    const unknown = constant("toolOutputTokens");
    const max = constant("maxToolOutputTokens");
    // The Daemon's limit admits limit×4/3 characters; Memory keeps 90%.
    const charsFor = (tokens: number) => Math.floor((tokens * 4 * 0.9) / 3);
    expect(knowledgeOutputBudget(undefined)).toBe(charsFor(unknown));
    expect(knowledgeOutputBudget(64_896)).toBe(
      charsFor((64_896 * percent) / 100),
    );
    expect(knowledgeOutputBudget(10_000_000)).toBe(charsFor(max));
  });

  it("keeps more of a result within a larger budget", async () => {
    const fixtureData = await fixture();
    const matches = Array.from({ length: 6 }, (_, index) => {
      const { input, markdown } = document(index, [wide(index, 1_200)]);
      const source = storeDocumentSource(fixtureData.root, input);
      const chunk = chunkSource(markdown).at(-1)!;
      return {
        chunkId: chunk.id,
        mergedChunkIds: [chunk.id],
        sourceId: source.id,
        score: 1 / (61 + index),
      };
    });
    const search = (outputBudgetChars: number) =>
      queryPersonalKnowledge(fixtureData.root, request("Report"), {
        chunkSearch: { search: async () => matches },
        outputBudgetChars,
      });

    const small = await search(OUTPUT_BUDGET_CHARS);
    const large = await search(knowledgeOutputBudget(131_072));
    expect(small.gaps.map((gap) => gap.code)).toContain("results_trimmed");
    expect(large.gaps).toEqual([]);
    expect(large.status).toBe("grounded");
    expect(JSON.stringify(large).length).toBeLessThanOrEqual(
      knowledgeOutputBudget(131_072),
    );
    expect(large.items.filter((item) => item.content).length).toBeGreaterThan(
      small.items.filter((item) => item.content).length,
    );
  });

  it("keeps a result that fits whole", async () => {
    const fixtureData = await fixture();
    const source = storeDocumentSource(fixtureData.root, meetingDocument);
    const chunk = chunkSource(meetingMarkdown)[0]!;
    const result = await queryPersonalKnowledge(
      fixtureData.root,
      request("speaker"),
      {
        chunkSearch: {
          search: async () => [
            {
              chunkId: chunk.id,
              mergedChunkIds: [chunk.id],
              score: 1 / 61,
              sourceId: source.id,
            },
          ],
        },
      },
    );
    expect(result.gaps).toEqual([]);
    expect(result.status).toBe("grounded");
    expect(result.items[0]!.content).toContain(chunk.content.slice(0, 20));
  });

  it("pages every requested section within the budget and continues exactly", async () => {
    const fixtureData = await fixture();
    const smile = String.fromCodePoint(0x1f600);
    const { input, markdown } = document(
      1,
      Array.from({ length: 8 }, (_, index) =>
        index === 0 ? `a${smile.repeat(900)}` : wide(index, 900),
      ),
    );
    const source = storeDocumentSource(fixtureData.root, input);
    const result = await queryPersonalKnowledge(
      fixtureData.root,
      request("Report"),
      {
        chunkSearch: {
          search: async () =>
            chunkSource(markdown).map((chunk, rank) => ({
              chunkId: chunk.id,
              mergedChunkIds: [chunk.id],
              score: 1 / (61 + rank),
              sourceId: source.id,
            })),
        },
      },
    );
    const evidenceId = result.items[0]!.evidenceId;
    const chunks = chunkSource(markdown)
      .filter((chunk) => chunk.content.length > 500)
      .slice(0, 8);
    expect(chunks).toHaveLength(8);

    const read = await readPersonalKnowledgeEvidence(
      fixtureData.root,
      {
        ...identity,
        evidence_id: evidenceId,
        section_requests: chunks.map((chunk) => ({ section_id: chunk.id })),
      },
      { outputBudgetChars: OUTPUT_BUDGET_CHARS },
    );

    expect(chars(read)).toBeLessThanOrEqual(OUTPUT_BUDGET_CHARS);
    expect(read.complete).toBe(false);
    expect(read.missingSections).toEqual([]);
    expect(read.sections.map((section) => section.id)).toEqual(
      chunks.map((chunk) => chunk.id),
    );
    for (const section of read.sections) {
      expect(section.content.length).toBeGreaterThan(0);
      expect(section.truncated).toBe(true);
      expect(section.nextOffset).toBe(section.offset + section.content.length);
    }

    // Reading on from each nextOffset returns the section's text exactly,
    // never splitting a surrogate pair.
    const [first] = chunks;
    let offset = 0;
    let text = "";
    for (;;) {
      const page = await readPersonalKnowledgeEvidence(fixtureData.root, {
        ...identity,
        evidence_id: evidenceId,
        section_requests: [{ section_id: first!.id, offset }],
      });
      const section = page.sections[0]!;
      expect(Buffer.from(section.content).toString()).toBe(section.content);
      text += section.content;
      if (!section.truncated) break;
      offset = section.nextOffset!;
    }
    expect(text).toBe(first!.content);
  });
});
