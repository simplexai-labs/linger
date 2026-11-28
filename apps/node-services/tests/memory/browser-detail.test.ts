import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  getMemoryEntry,
  listMemoryEntries,
  MemoryBrowserNotFoundError,
} from "../../src/memory/memory-browser.js";

vi.mock("../../src/memory/collector.js", () => ({
  loadWikiGraphSubjectsForActor: async () => [
    { tenantId: "tenant_1", agentManagementId: "agent_alice" },
  ],
}));

let dataRoot: string;
const subject = { tenantId: "tenant_1", ownerActorId: "actor_alice" };
beforeEach(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-detail-"));
  for (const kind of ["daily", "weekly"]) {
    const dir = path.join(dataRoot, "agent_alice", "memory", "timeline", kind);
    await fs.mkdir(dir, { recursive: true });
    for (let day = 1; day <= 20; day += 1) {
      await fs.writeFile(
        path.join(dir, `2026-11-${String(day).padStart(2, "0")}.md`),
        `---\ntitle: ${kind} ${day}\n---\n\n# Report\n\n${kind} report ${day}.\n`,
      );
    }
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dataRoot, { recursive: true, force: true });
});

it.each(["daily", "weekly"])(
  "reads only the selected %s report body",
  async (kind) => {
    const input = { dataRoot, ...subject };
    const page = await listMemoryEntries(input);
    const selected = page.items.find((item) => item.title === `${kind} 20`)!;
    const read = vi.spyOn(fs, "readFile");
    const stat = vi.spyOn(fs, "stat");
    const entry = await getMemoryEntry({ ...input, entryId: selected.id });
    expect(entry).toMatchObject({
      ...selected,
      content: `---\ntitle: ${kind} 20\n---\n\n# Report\n\n${kind} report 20.\n`,
    });
    const file = path.join(dataRoot, "agent_alice", "memory", selected.path);
    expect(read.mock.calls.map(([target]) => target)).toEqual([file, file]);
    expect(stat.mock.calls.map(([target]) => target)).toEqual([file]);
  },
);

it("does not read report bodies for an unknown entry", async () => {
  const read = vi.spyOn(fs, "readFile");
  await expect(
    getMemoryEntry({ dataRoot, ...subject, entryId: "memory_unknown" }),
  ).rejects.toBeInstanceOf(MemoryBrowserNotFoundError);
  expect(read).not.toHaveBeenCalled();
});

it("still reads all reports when listing entries", async () => {
  const read = vi.spyOn(fs, "readFile");
  const page = await listMemoryEntries({ dataRoot, ...subject });
  expect(page.items).toHaveLength(40);
  expect(read).toHaveBeenCalledTimes(40);
});
