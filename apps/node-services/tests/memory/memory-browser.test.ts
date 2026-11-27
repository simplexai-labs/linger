import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ subjects: vi.fn() }));

vi.mock("../../src/memory/collector.js", () => ({
  loadWikiGraphSubjectsForActor: mocks.subjects,
}));

import {
  getMemoryEntry,
  listMemoryEntries,
  MemoryBrowserNotFoundError,
} from "../../src/memory/memory-browser.js";
import { agentMemoryRoot, agentWorkspaceRoot } from "../../src/memory/paths.js";

const tenantId = "tenant-1";
const ownerActorId = "actor-1";
const agentId = "agent-1";
let dataRoot: string;

beforeEach(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-browser-"));
  mocks.subjects.mockResolvedValue([{ tenantId, agentManagementId: agentId }]);
});

afterEach(async () => {
  await fs.rm(dataRoot, { force: true, recursive: true });
});

async function writePage(relativePath: string, title: string, modified?: Date) {
  const target = path.join(agentMemoryRoot(dataRoot, agentId), relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `---\ntitle: ${title}\n---\n${title} body\n`);
  if (modified) await fs.utimes(target, modified, modified);
  return target;
}

async function writeReport(
  relativePath: string,
  content: string,
  modified?: Date,
) {
  const target = path.join(agentMemoryRoot(dataRoot, agentId), relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  if (modified) await fs.utimes(target, modified, modified);
  return target;
}

async function bump(token: string) {
  await fs.mkdir(agentWorkspaceRoot(dataRoot, agentId), { recursive: true });
  await fs.writeFile(
    path.join(agentWorkspaceRoot(dataRoot, agentId), "memory.revision"),
    `${token}\n`,
  );
}

describe("memory browser", () => {
  it("lists pages without their content and reads one by id", async () => {
    await writePage(
      "timeline/daily/2026-01-01.md",
      "First",
      new Date("2026-01-01T00:00:00Z"),
    );
    await writePage(
      "timeline/weekly/2026-W01.md",
      "Week one",
      new Date("2026-01-02T00:00:00Z"),
    );
    await bump("revision-1");

    const page = await listMemoryEntries({
      dataRoot,
      tenantId,
      ownerActorId,
    });
    expect(page.items.map((item) => item.title)).toEqual(["Week one", "First"]);
    expect(page.items.every((item) => item.content === "")).toBe(true);

    const entry = await getMemoryEntry({
      dataRoot,
      tenantId,
      ownerActorId,
      entryId: page.items[0]!.id,
    });
    expect(entry.path).toBe("timeline/weekly/2026-W01.md");
    expect(entry.content).toContain("Week one body");
  });

  it("pages with a cursor that a newer page cannot shift", async () => {
    await writePage(
      "timeline/daily/2026-01-01.md",
      "A",
      new Date("2026-01-01T00:00:00Z"),
    );
    await writePage(
      "timeline/daily/2026-01-02.md",
      "B",
      new Date("2026-01-02T00:00:00Z"),
    );
    await writePage(
      "timeline/daily/2026-01-03.md",
      "C",
      new Date("2026-01-03T00:00:00Z"),
    );
    await bump("revision-1");

    const first = await listMemoryEntries({
      dataRoot,
      tenantId,
      ownerActorId,
      limit: 2,
    });
    expect(first.items.map((item) => item.title)).toEqual(["C", "B"]);

    await writePage(
      "timeline/daily/2026-01-04.md",
      "D",
      new Date("2026-01-04T00:00:00Z"),
    );
    await bump("revision-2");
    const second = await listMemoryEntries({
      dataRoot,
      tenantId,
      ownerActorId,
      cursor: first.next_cursor,
    });
    expect(second.items.map((item) => item.title)).toEqual(["A"]);
  });

  it("lists and reads reports beside a file with malformed metadata", async () => {
    const broken =
      "---\nsources: [unfinished\n---\n\n# Recovered report\n\nThe body remains readable.\n";
    const healthy =
      "---\ntitle: Healthy report\n---\n\n# Daily\n\nA separate report is intact.\n";
    const brokenPath = await writeReport(
      "timeline/daily/2026-11-18.md",
      broken,
      new Date("2026-11-18T00:00:00Z"),
    );
    await writeReport(
      "timeline/daily/2026-11-19.md",
      healthy,
      new Date("2026-11-19T00:00:00Z"),
    );
    await bump("revision-374");

    const page = await listMemoryEntries({
      dataRoot,
      tenantId,
      ownerActorId,
    });
    expect(page.items).toHaveLength(2);
    expect(page.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Recovered report",
          summary: "The body remains readable.",
          date: "2026-11-18",
        }),
        expect.objectContaining({ title: "Healthy report" }),
      ]),
    );
    for (const [title, content] of [
      ["Recovered report", broken],
      ["Healthy report", healthy],
    ] as const) {
      const entryId = page.items.find((item) => item.title === title)!.id;
      expect(
        await getMemoryEntry({ dataRoot, tenantId, ownerActorId, entryId }),
      ).toMatchObject({ title, content });
    }
    expect(await fs.readFile(brokenPath, "utf8")).toBe(broken);
  });

  it("reports a page deleted outside the service as not found", async () => {
    const target = await writePage(
      "timeline/daily/2026-02-01.md",
      "Gone soon",
      new Date("2026-02-01T00:00:00Z"),
    );
    await bump("revision-2");
    const page = await listMemoryEntries({
      dataRoot,
      tenantId,
      ownerActorId,
    });
    const entryId = page.items[0]!.id;
    await fs.rm(target);
    await expect(
      getMemoryEntry({ dataRoot, tenantId, ownerActorId, entryId }),
    ).rejects.toBeInstanceOf(MemoryBrowserNotFoundError);
  });

  it("reports a missing page as not found", async () => {
    await bump("revision-1");
    await expect(
      getMemoryEntry({
        dataRoot,
        tenantId,
        ownerActorId,
        entryId: "memory_missing",
      }),
    ).rejects.toBeInstanceOf(MemoryBrowserNotFoundError);
  });
});
