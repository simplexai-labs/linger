import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { publishMemoryWiki } from "../../src/memory/published-memory-files.js";

const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "device-names-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

it("keeps a Windows device name out of a published page's file name", async () => {
  const root = await fixture();
  const titles = ["CON", "nul.txt", "com1", "Auxiliary report"];
  await publishMemoryWiki(
    root,
    "alice",
    titles.map((title, index) => ({
      page: { documentId: `doc_${index}`, path: `projects/page-${index}.md` },
      content: `# ${title}\n`,
    })),
    new Map(),
  );
  expect(
    (
      await fs.readdir(path.join(root, "alice/memory/knowledge/projects"))
    ).sort(),
  ).toEqual(
    ["_CON.md", "_com1.md", "_nul.txt.md", "Auxiliary report.md"].sort(),
  );
});

it("keeps the superscript device numbers out too", async () => {
  const root = await fixture();
  // Windows reserves COM¹ / LPT³ as well as COM1. The CLI pattern is the one this
  // reader now matches, so both copies agree on the superscripts; the console
  // aliases CONIN$/CONOUT$ are the daemon's own extra rule and are not checked
  // here.
  const titles = ["COM\u00b9", "com\u00b3"];
  await publishMemoryWiki(
    root,
    "alice",
    titles.map((title, index) => ({
      page: { documentId: `doc_s${index}`, path: `projects/sup-${index}.md` },
      content: `# ${title}\n`,
    })),
    new Map(),
  );
  expect(
    (
      await fs.readdir(path.join(root, "alice/memory/knowledge/projects"))
    ).sort(),
  ).toEqual(["_COM\u00b9.md", "_com\u00b3.md"].sort());
});

it("leaves names that only look like a device name alone", async () => {
  const root = await fixture();
  const titles = ["console", "com0", "company notes", "lpt\u00b3 plan"];
  await publishMemoryWiki(
    root,
    "alice",
    titles.map((title, index) => ({
      page: { documentId: `doc_t${index}`, path: `projects/ok-${index}.md` },
      content: `# ${title}\n`,
    })),
    new Map(),
  );
  const names = (
    await fs.readdir(path.join(root, "alice/memory/knowledge/projects"))
  ).sort();
  expect(names.every((name) => !name.startsWith("_"))).toBe(true);
});
