import { describe, expect, it } from "vitest";

import {
  readKnowledgeMarkdown,
  withoutLeadingHeading,
} from "./knowledge-markdown";

describe("readKnowledgeMarkdown", () => {
  it("hides JSON front matter and takes the title from it", () => {
    const metadata = JSON.stringify(
      {
        type: "Session",
        title: "Weekly sync",
        sources: [{ id: "R1", resource: "teamhub://documents/d/versions/v" }],
        generated: { by: "llm-wiki/1", at: "2026-11-20T10:00:00Z" },
      },
      null,
      2,
    );
    const page = readKnowledgeMarkdown(
      `---\n${metadata}\n---\n\n# Weekly sync\n\nWe agreed on the plan.`,
    );
    expect(page).toEqual({
      title: "Weekly sync",
      body: "# Weekly sync\n\nWe agreed on the plan.",
    });
  });

  it("hides YAML front matter", () => {
    expect(
      readKnowledgeMarkdown(
        '---\ntype: Project\ntitle: "Acme rollout"\ngenerated:\n  by: memory/1\n---\n\nBody.',
      ),
    ).toEqual({ title: "Acme rollout", body: "Body." });
  });

  it("hides a bare JSON metadata object and its closing rule", () => {
    expect(
      readKnowledgeMarkdown(
        '{ "type": "Session",\n  "title": "Café review" }\n---\n\nText.',
      ),
    ).toEqual({ title: "Café review", body: "Text." });
  });

  it("keeps a page that opens with ordinary JSON", () => {
    const markdown = '{ "x": 1 }\n\nText.';
    expect(readKnowledgeMarkdown(markdown)).toEqual({ body: markdown });
  });

  it("keeps an unclosed front matter as written", () => {
    expect(readKnowledgeMarkdown("---\nnot closed\n\nText").body).toBe(
      "---\nnot closed\n\nText",
    );
  });

  it("drops the Sources section, generator lines and citation labels", () => {
    const markdown = [
      "## Decisions",
      "- Ship on Friday [R1].",
      "- Evidence: [R2]",
      "Hire two people [R1, R3] this quarter.",
      "Keep `code [R1]` literal.",
      "generated: by memory/1",
      "",
      "## Sources",
      "- [R1] memory://one",
      "### Details",
      "private",
      "",
      "## Next",
      "Continue.",
    ].join("\n");
    expect(readKnowledgeMarkdown(markdown).body).toBe(
      [
        "## Decisions",
        "- Ship on Friday.",
        "Hire two people this quarter.",
        "Keep `code [R1]` literal.",
        "",
        "## Next",
        "Continue.",
      ].join("\n"),
    );
  });

  it("leaves Sources headings inside code fences alone", () => {
    const markdown = "```md\n## Sources\n- a\n```\n\nAfter.";
    expect(readKnowledgeMarkdown(markdown).body).toBe(markdown);
  });
});

describe("withoutLeadingHeading", () => {
  it("removes a leading H1 only", () => {
    expect(withoutLeadingHeading("# Title\n\nBody")).toBe("Body");
    expect(withoutLeadingHeading("## Section\n\nBody")).toBe(
      "## Section\n\nBody",
    );
  });
});
