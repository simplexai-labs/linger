import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { publishMemoryWiki } from "../../src/memory/published-memory-files.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

const literalCases = [
  ["inline code", "`[Example](target.md)`"],
  ["fenced code", "```md\n[Example](target.md)\n```"],
  ["indented code", "    [Example](target.md)"],
  ["escaped link syntax", "\\[Example](target.md)"],
  ["quoted code fence", "> ~~~md\n> [Example](target.md)\n> ~~~"],
  ["unavailable meeting in code", "`[Missing](../sessions/gone.md)`"],
].map(([name, literal]) => ({
  name: name!,
  literal: literal!,
  expected: literal!,
}));
literalCases.push({
  name: "code inside a link label",
  literal: "[`[Example](target.md)`](target.md)",
  expected: "[`[Example](target.md)`](Target.md)",
});

it.each(literalCases)(
  "keeps $name literal while publishing real links",
  async ({ literal, expected }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "published-links-"));
    roots.push(root);
    const content = `# Guide\n\n${literal}\n\n[Actual](target.md#details "Title")\n`;
    await publishMemoryWiki(
      root,
      "alice",
      [
        { page: { documentId: "guide", path: "projects/guide.md" }, content },
        {
          page: { documentId: "target", path: "projects/target.md" },
          content: "# Target\n",
        },
      ],
      new Map(),
    );
    const published = await fs.readFile(
      path.join(root, "alice/memory/knowledge/projects/Guide.md"),
      "utf8",
    );
    expect(published).toBe(
      content
        .replace(literal, expected)
        .replace(
          '[Actual](target.md#details "Title")',
          '[Actual](Target.md#details "Title")',
        ),
    );
  },
);
