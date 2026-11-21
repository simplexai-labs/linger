import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MemoryCatalog } from "../../src/memory/memory-catalog.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

async function workspace() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-catalog-"));
  roots.push(dataRoot);
  const agentId = "agent-1";
  return {
    agentId,
    memoryRoot: path.join(dataRoot, agentId, "memory"),
    workspaceRoot: path.join(dataRoot, agentId),
  };
}

async function page(
  memoryRoot: string,
  relativePath: string,
  title: string,
  modified?: Date,
) {
  const target = path.join(memoryRoot, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // A distinct size per title keeps size-based change detection honest even
  // when two writes land in the same millisecond.
  await fs.writeFile(target, `---\ntitle: ${title}\n---\n${title}\n`);
  if (modified) await fs.utimes(target, modified, modified);
  return target;
}

async function bump(workspaceRoot: string, token: string) {
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "memory.revision"), `${token}\n`);
}

function open(options: {
  agentId: string;
  memoryRoot: string;
  workspaceRoot: string;
  maxStalenessMs?: number;
}) {
  const reads: string[] = [];
  const readFile = (async (target: string, encoding: BufferEncoding) => {
    reads.push(target);
    return await fs.readFile(target, encoding);
  }) as typeof fs.readFile;
  const catalog = new MemoryCatalog({
    agentId: options.agentId,
    root: options.memoryRoot,
    workspaceRoot: options.workspaceRoot,
    readFile,
    maxStalenessMs: options.maxStalenessMs ?? 60_000,
  });
  return {
    catalog,
    pageReads: () => reads.filter((target) => target.endsWith(".md")).length,
  };
}

describe("MemoryCatalog", () => {
  it("serves the cached index without reading pages again", async () => {
    const { agentId, memoryRoot, workspaceRoot } = await workspace();
    await page(memoryRoot, "timeline/daily/2026-01-01.md", "First");
    await page(memoryRoot, "timeline/daily/2026-01-02.md", "Second");
    await bump(workspaceRoot, "revision-1");
    const { catalog, pageReads } = open({ agentId, memoryRoot, workspaceRoot });

    const first = await catalog.list({});
    expect(first.items.map((item) => item.title)).toEqual(["Second", "First"]);
    expect(pageReads()).toBe(2);

    const second = await catalog.list({ kind: "daily" });
    expect(second.items).toHaveLength(2);
    expect(pageReads()).toBe(2);
  });

  it("reads only the page whose size or modification time changed", async () => {
    const { agentId, memoryRoot, workspaceRoot } = await workspace();
    await page(memoryRoot, "timeline/daily/2026-01-01.md", "First");
    await page(memoryRoot, "timeline/daily/2026-01-02.md", "Second");
    await bump(workspaceRoot, "revision-1");
    const { catalog, pageReads } = open({ agentId, memoryRoot, workspaceRoot });
    await catalog.list({});
    expect(pageReads()).toBe(2);

    await page(memoryRoot, "timeline/daily/2026-01-02.md", "Second, revised");
    await bump(workspaceRoot, "revision-2");
    const revised = await catalog.list({});
    expect(revised.items.map((item) => item.title)).toEqual([
      "Second, revised",
      "First",
    ]);
    expect(pageReads()).toBe(3);
  });

  it("adds and removes pages after a revision bump", async () => {
    const { agentId, memoryRoot, workspaceRoot } = await workspace();
    const first = await page(
      memoryRoot,
      "timeline/daily/2026-01-01.md",
      "First",
    );
    await bump(workspaceRoot, "revision-1");
    const { catalog } = open({ agentId, memoryRoot, workspaceRoot });
    expect((await catalog.list({})).items).toHaveLength(1);

    await page(memoryRoot, "timeline/weekly/2026-W01.md", "Week one");
    await bump(workspaceRoot, "revision-2");
    expect((await catalog.list({})).items).toHaveLength(2);

    await fs.rm(first);
    await bump(workspaceRoot, "revision-3");
    const afterRemoval = await catalog.list({});
    expect(afterRemoval.items.map((item) => item.title)).toEqual(["Week one"]);
  });

  it("finds a page written without a revision bump", async () => {
    const { agentId, memoryRoot, workspaceRoot } = await workspace();
    await bump(workspaceRoot, "revision-1");
    const { catalog } = open({
      agentId,
      memoryRoot,
      workspaceRoot,
      maxStalenessMs: 0,
    });
    expect((await catalog.list({})).items).toHaveLength(0);

    await page(memoryRoot, "timeline/daily/2026-01-03.md", "Unannounced");
    const listed = await catalog.list({});
    expect(listed.items.map((item) => item.title)).toEqual(["Unannounced"]);
  });

  it("keeps a stable cursor when a newer page arrives", async () => {
    const { agentId, memoryRoot, workspaceRoot } = await workspace();
    await page(
      memoryRoot,
      "timeline/daily/2026-01-01.md",
      "A",
      new Date("2026-01-01T00:00:00Z"),
    );
    await page(
      memoryRoot,
      "timeline/daily/2026-01-02.md",
      "B",
      new Date("2026-01-02T00:00:00Z"),
    );
    await page(
      memoryRoot,
      "timeline/daily/2026-01-03.md",
      "C",
      new Date("2026-01-03T00:00:00Z"),
    );
    await page(
      memoryRoot,
      "timeline/daily/2026-01-04.md",
      "D",
      new Date("2026-01-04T00:00:00Z"),
    );
    await bump(workspaceRoot, "revision-1");
    const { catalog } = open({ agentId, memoryRoot, workspaceRoot });

    const first = await catalog.list({ limit: 2 });
    expect(first.items.map((item) => item.title)).toEqual(["D", "C"]);
    expect(first.nextCursor).toBeDefined();

    await page(
      memoryRoot,
      "timeline/daily/2026-01-05.md",
      "E",
      new Date("2026-01-05T00:00:00Z"),
    );
    await bump(workspaceRoot, "revision-2");
    const second = await catalog.list({
      cursor: first.nextCursor,
      limit: 2,
    });
    expect(second.items.map((item) => item.title)).toEqual(["B", "A"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("answers a legacy offset cursor", async () => {
    const { agentId, memoryRoot, workspaceRoot } = await workspace();
    await page(
      memoryRoot,
      "timeline/daily/2026-01-01.md",
      "A",
      new Date("2026-01-01T00:00:00Z"),
    );
    await page(
      memoryRoot,
      "timeline/daily/2026-01-02.md",
      "B",
      new Date("2026-01-02T00:00:00Z"),
    );
    await page(
      memoryRoot,
      "timeline/daily/2026-01-03.md",
      "C",
      new Date("2026-01-03T00:00:00Z"),
    );
    await bump(workspaceRoot, "revision-1");
    const { catalog } = open({ agentId, memoryRoot, workspaceRoot });
    expect((await catalog.list({ cursor: "2" })).items[0]?.title).toBe("A");
  });

  it("rejects an unreadable cursor", async () => {
    const { agentId, memoryRoot, workspaceRoot } = await workspace();
    const { catalog } = open({ agentId, memoryRoot, workspaceRoot });
    await expect(catalog.list({ cursor: "not-a-cursor" })).rejects.toThrow(
      /cursor/i,
    );
  });

  it("reads page content fresh for an open entry", async () => {
    const { agentId, memoryRoot, workspaceRoot } = await workspace();
    const target = await page(
      memoryRoot,
      "timeline/daily/2026-01-01.md",
      "First",
    );
    await bump(workspaceRoot, "revision-1");
    const { catalog } = open({ agentId, memoryRoot, workspaceRoot });
    const file = (await catalog.list({})).items[0]!;
    expect(await catalog.read(file)).toContain("First");

    await fs.writeFile(target, "---\ntitle: First\n---\nchanged body\n");
    expect(await catalog.read(file)).toContain("changed body");
  });

  it("keeps the published entry id for a page path", async () => {
    const { agentId, memoryRoot, workspaceRoot } = await workspace();
    await page(memoryRoot, "timeline/daily/2026-01-01.md", "First");
    await bump(workspaceRoot, "revision-1");
    const { catalog } = open({ agentId, memoryRoot, workspaceRoot });
    const file = (await catalog.list({})).items[0]!;
    const expected = `memory_${createHash("sha256")
      .update(`${agentId}\0timeline/daily/2026-01-01.md`)
      .digest("hex")
      .slice(0, 24)}`;
    expect(file.id).toBe(expected);
  });
});
