import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { validateOkfDocument } from "@linger/knowledge-format";
import { afterEach, expect, it, vi } from "vitest";

import { parseMemoryMarkdown } from "../../src/memory/markdown.js";
import {
  getMemoryEntry,
  listMemoryEntries,
} from "../../src/memory/memory-browser.js";
import { publishMemoryWiki } from "../../src/memory/published-memory-files.js";

vi.mock("../../src/memory/collector.js", () => ({
  loadWikiGraphSubjectsForActor: async () => [
    { tenantId: "tenant_1", agentManagementId: "agent_alice" },
  ],
}));

const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-newlines-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

const fields = [
  "type: Project Memory",
  "title: Authoritative title",
  "description: Metadata summary.",
  "date: 2026-11-18",
  "tags:",
  "  - planning",
];

for (const [label, eol] of [
  ["LF", "\n"],
  ["CRLF", "\r\n"],
] as const) {
  it(`retains the heading fallback with ${label} line endings`, () => {
    expect(
      parseMemoryMarkdown(["# Heading title", "", "Body detail."].join(eol)),
    ).toMatchObject({
      title: "Heading title",
      summary: "Body detail.",
    });
  });
  it.each(["frontmatter", "YAML fence"])(
    `reads %s metadata with ${label} line endings`,
    (format) => {
      const content = (
        format === "frontmatter"
          ? ["---", ...fields, "---", "", "# Body heading", "", "Body detail."]
          : [
              "# Body heading",
              "",
              "```yaml",
              ...fields,
              "```",
              "",
              "Body detail.",
            ]
      ).join(eol);
      expect(parseMemoryMarkdown(content)).toMatchObject({
        title: "Authoritative title",
        summary: "Metadata summary.",
        metadata: {
          type: "Project Memory",
          title: "Authoritative title",
          description: "Metadata summary.",
          date: "2026-11-18",
          tags: ["planning"],
        },
      });
    },
  );
}

it("keeps the colon-bearing scalar repair when metadata uses CRLF", () => {
  const content = [
    "---",
    "title: Planning: migration",
    "---",
    "",
    "# Body heading",
  ].join("\r\n");
  expect(parseMemoryMarkdown(content)).toMatchObject({
    title: "Planning: migration",
    metadata: { title: "Planning: migration" },
  });
});

it("keeps readable Wiki filenames and links when valid pages change to CRLF", async () => {
  const root = await fixture();
  const project = {
    page: { documentId: "doc_project", path: "projects/site.md" },
    content: ["---", ...fields, "---", "", "# Body heading", ""].join("\n"),
  };
  const other = {
    page: { documentId: "doc_other", path: "projects/other.md" },
    content:
      "---\ntype: Project Memory\ntitle: Other\n---\n\n[Project](site.md)\n",
  };
  await publishMemoryWiki(root, "agent_alice", [project, other], new Map());
  project.content = project.content.replaceAll("\n", "\r\n");
  expect(
    validateOkfDocument(project.content, { relativePath: project.page.path }),
  ).toMatchObject({
    valid: true,
    issues: [],
  });
  await publishMemoryWiki(root, "agent_alice", [project, other], new Map());
  const dir = path.join(root, "agent_alice", "memory", "knowledge", "projects");
  expect((await fs.readdir(dir)).sort()).toEqual([
    "Authoritative title.md",
    "Other.md",
  ]);
  expect(
    await fs.readFile(path.join(dir, "Authoritative title.md"), "utf8"),
  ).toBe(project.content);
  expect(await fs.readFile(path.join(dir, "Other.md"), "utf8")).toContain(
    "[Project](Authoritative%20title.md)",
  );
});

it("retains CRLF report metadata through the real list and detail entries", async () => {
  const dataRoot = await fixture();
  const dir = path.join(dataRoot, "agent_alice", "memory", "timeline", "daily");
  await fs.mkdir(dir, { recursive: true });
  const content = [
    "---",
    ...fields,
    "---",
    "",
    "# Body heading",
    "",
    "Body detail.",
  ].join("\r\n");
  await fs.writeFile(path.join(dir, "2026-11-20.md"), content);
  const input = { dataRoot, tenantId: "tenant_1", ownerActorId: "actor_alice" };
  const page = await listMemoryEntries(input);
  expect(page.items).toHaveLength(1);
  const item = page.items[0]!;
  expect(item).toMatchObject({
    title: "Authoritative title",
    summary: "Metadata summary.",
    date: "2026-11-18",
  });
  expect(await getMemoryEntry({ ...input, entryId: item.id })).toMatchObject({
    ...item,
    content,
  });
});
