import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/memory/collector.js", () => ({
  loadWikiGraphSubjectsForActor: async () => [
    { tenantId: "tenant_1", agentManagementId: "agent_alice" },
  ],
}));

import type { MemoryScheduleConfig } from "../../src/memory/config.js";
import { MemoryScheduler } from "../../src/memory/scheduler.js";
import { startMemoryServer } from "../../src/memory/server.js";

const schedule: MemoryScheduleConfig = {
  concurrency: 1,
  timeZone: "Asia/Shanghai",
  weeklyDay: 1,
};
const token = "memory-http-token";
const quarantine: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(
    quarantine
      .splice(0)
      .map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

async function start(): Promise<{ dataRoot: string; url: string }> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-http-"));
  quarantine.push(dataRoot);
  const server = await startMemoryServer({
    dataRoot,
    host: "127.0.0.1",
    port: 0,
    scheduler: new MemoryScheduler(schedule, async () => {}),
    serviceToken: token,
  });
  closers.push(() => server.close());
  return { dataRoot, url: server.url };
}

async function page(dataRoot: string, date: string, title: string) {
  const directory = path.join(
    dataRoot,
    "agent_alice",
    "memory",
    "timeline",
    "daily",
  );
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, `${date}.md`);
  await fs.writeFile(target, `---\ntitle: ${title}\n---\n${title}\n`);
  const modified = new Date(`${date}T00:00:00Z`);
  await fs.utimes(target, modified, modified);
}

async function bump(dataRoot: string) {
  await fs.writeFile(
    path.join(dataRoot, "agent_alice", "memory.revision"),
    "revision-http\n",
  );
}

async function entries(
  url: string,
  query: Record<string, string>,
): Promise<Response> {
  const search = new URLSearchParams({
    owner_actor_id: "actor_alice",
    tenant_id: "tenant_1",
    ...query,
  });
  return await fetch(`${url}/internal/v1/memory/entries?${search}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("Memory entries HTTP paging", () => {
  it("pages with the catalog cursor the response returned", async () => {
    const { dataRoot, url } = await start();
    await page(dataRoot, "2026-04-01", "A");
    await page(dataRoot, "2026-04-02", "B");
    await page(dataRoot, "2026-04-03", "C");
    await bump(dataRoot);

    const first = await entries(url, { limit: "2" });
    expect(first.status).toBe(200);
    const firstPage = (await first.json()) as {
      items: Array<{ title: string }>;
      next_cursor?: string;
    };
    expect(firstPage.items.map((item) => item.title)).toEqual(["C", "B"]);
    expect(firstPage.next_cursor).toBeDefined();

    const second = await entries(url, {
      cursor: firstPage.next_cursor!,
      limit: "2",
    });
    expect(second.status).toBe(200);
    const secondPage = (await second.json()) as {
      items: Array<{ title: string }>;
      next_cursor?: string;
    };
    expect(secondPage.items.map((item) => item.title)).toEqual(["A"]);
    expect(secondPage.next_cursor).toBeUndefined();
  });

  it("rejects a cursor that is not opaque page data", async () => {
    const { url } = await start();
    expect((await entries(url, { cursor: "not a cursor!" })).status).toBe(400);
  });
});
