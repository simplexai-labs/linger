import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGraph } from "openwiki/dist/visualize/graph.js";
import { buildWikiGraph } from "../../src/memory/graph/build.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((value) => fs.rm(value, { recursive: true, force: true })),
  );
});
describe("Wiki knowledge graph", () => {
  it("builds the same nodes and Markdown edges as OpenWiki, without period reports", async () => {
    const pages = {
      "index.md": "# Wiki\n\n[Project](projects/alpha.md)",
      "projects/alpha.md":
        "---\ntitle: Alpha\ntype: Project\ngraph:\n  about: [phantom]\nsources: [{resource: raw:shared}]\n---\n# Alpha\n\n[Session](../sessions/2026-09-01/a.md)",
      "sessions/2026-09-01/a.md":
        "---\ntitle: Session\ntype: Session\nsources: [{resource: raw:shared}]\n---\n# Session\n\n[Back](../../projects/alpha.md)",
      "topics/index.md": "# Files\n\n[Alpha](../projects/alpha.md)",
      "me/daily/2026-09-01.md": "---\ntitle: Daily\ntype: Daily\n---\n# Daily",
      "me/weekly/2026-09-01.md":
        "---\ntitle: Weekly\ntype: Weekly\n---\n# Weekly",
    };
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-graph-"));
    roots.push(root);
    for (const [key, content] of Object.entries(pages)) {
      await fs.mkdir(path.dirname(path.join(root, key)), { recursive: true });
      await fs.writeFile(path.join(root, key), content);
    }
    const native = await buildGraph(root);
    const isReport = (id: string) =>
      id.startsWith("me/daily/") || id.startsWith("me/weekly/");

    const { graph } = buildWikiGraph(
      Object.entries(pages).map(([key, content]) => ({ key, content })),
      "wiki-r1",
    );

    expect(graph.wikiRevision).toBe("wiki-r1");
    expect(graph.nodes).toEqual(
      native.nodes
        .filter((node) => !isReport(node.id))
        .map((node) => ({
          ...node,
          links: node.links.filter((id) => !isReport(id)),
          backlinks: node.backlinks.filter((id) => !isReport(id)),
        })),
    );
    expect(graph.edges).toEqual(
      native.edges.filter(
        (edge) => !isReport(edge.source) && !isReport(edge.target),
      ),
    );
    expect(graph.nodes.map((node) => node.id)).not.toContain("phantom");
  });
  it("reads aliases from the frontmatter of pages others can name", () => {
    const { aliases } = buildWikiGraph(
      [
        {
          key: "projects/atlas.md",
          content: '---\n{"aliases":["Atlas Rollout"]}\n---\n# Atlas',
        },
        {
          key: "topics/notes.md",
          content: '---\n{"aliases":["Notes"]}\n---\n# Notes',
        },
      ],
      "wiki-r1",
    );
    expect([...aliases]).toEqual([["projects/atlas", ["Atlas Rollout"]]]);
  });
  it("reads the YAML aliases a published page writes", () => {
    const { graph, aliases } = buildWikiGraph(
      [
        {
          key: "projects/atlas.md",
          content:
            "---\ntitle: Atlas Rollout\ntype: Project\naliases:\n  - Atlas Program\n---\n# Atlas Rollout\n\nDelivery notes.",
        },
        {
          key: "sessions/2026-09-01/a.md",
          content:
            "---\ntitle: Session\ntype: Session\n---\n# Session\n\nThe Atlas Program review finished.",
        },
      ],
      "wiki-r1",
    );
    expect([...aliases]).toEqual([["projects/atlas", ["Atlas Program"]]]);
    expect(
      graph.inferredEdges?.some(
        (edge) =>
          edge.kind === "mention" &&
          edge.source === "sessions/2026-09-01/a" &&
          edge.target === "projects/atlas",
      ),
    ).toBe(true);
  });

  it("reads aliases through the same parser the entity registry uses", () => {
    // A page with no closing delimiter is not frontmatter; the shared parser says
    // so, and the graph therefore adds no aliases instead of guessing.
    const { aliases } = buildWikiGraph(
      [
        {
          key: "projects/broken.md",
          content: "---\ntitle: Broken\naliases:\n  - Nope\n",
        },
      ],
      "wiki-r1",
    );
    expect([...aliases.keys()]).toEqual([]);
  });
});
