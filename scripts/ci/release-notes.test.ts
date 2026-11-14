import { describe, expect, it } from "vitest";

import {
  assembleNotes,
  generatedChanges,
  MAX_BODY_LENGTH,
  publishedDesktopTags,
  summarize,
  truncateNotes,
} from "./release-notes.mjs";

const generated = "## What's Changed\n* fix(web): keep the draft by @a in #1\n";

function reply(body: unknown, ok = true) {
  return Promise.resolve({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe("assembleNotes", () => {
  it("puts the summary before the generated changes", () => {
    const notes = assembleNotes({
      version: "1.2.0",
      repo: "o/r",
      previousTag: "desktop-v1.1.0",
      summary: "## Faster Rooms",
      generated,
    });

    expect(notes).toContain(
      "[1.1.0](https://github.com/o/r/releases/tag/desktop-v1.1.0)",
    );
    expect(notes.indexOf("## Faster Rooms")).toBeLessThan(
      notes.indexOf("## What's Changed"),
    );
    expect(notes).toContain("SHA256SUMS.txt");
    expect(notes).not.toContain("Prerelease");
  });

  it("marks a prerelease and works without a summary or a previous release", () => {
    const notes = assembleNotes({
      version: "1.2.0-rc.1",
      repo: "o/r",
      previousTag: "",
      summary: "",
      generated,
    });

    expect(notes.startsWith("**Prerelease**")).toBe(true);
    expect(notes).not.toContain("Previous release");
  });
});

describe("truncateNotes", () => {
  it("keeps a short body and cuts a long one under the limit", () => {
    expect(truncateNotes("short")).toBe("short");
    const cut = truncateNotes("x".repeat(MAX_BODY_LENGTH + 500));
    expect(cut.length).toBeLessThanOrEqual(MAX_BODY_LENGTH);
    expect(cut).toContain("truncated");
  });
});

describe("GitHub and Anthropic calls", () => {
  it("lists only published releases across pages", async () => {
    const page = (start: number, draft: boolean) =>
      Array.from({ length: 100 }, (_, i) => ({
        tag_name: `t${start + i}`,
        draft,
      }));
    const pages = [
      page(0, false),
      [
        { tag_name: "last", draft: false },
        { tag_name: "wip", draft: true },
      ],
    ];
    let call = 0;
    const tags = await publishedDesktopTags(
      "o/r",
      "token",
      () => reply(pages[call++]) as never,
    );

    expect(tags).toHaveLength(101);
    expect(tags).toContain("last");
    expect(tags).not.toContain("wip");
  });

  it("asks for notes against the previous tag only when there is one", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return reply({ body: "notes" });
    };
    await generatedChanges({
      repo: "o/r",
      tag: "t2",
      commit: "c",
      previousTag: "t1",
      token: "x",
      fetchImpl: fetchImpl as never,
    });
    await generatedChanges({
      repo: "o/r",
      tag: "t2",
      commit: "c",
      previousTag: "",
      token: "x",
      fetchImpl: fetchImpl as never,
    });

    expect(bodies).toEqual([
      { tag_name: "t2", target_commitish: "c", previous_tag_name: "t1" },
      { tag_name: "t2", target_commitish: "c" },
    ]);
  });

  it("returns the summary text and rejects a failed or empty reply", async () => {
    const text = await summarize({
      changes: generated,
      apiKey: "k",
      model: "m",
      fetchImpl: () =>
        reply({ content: [{ type: "text", text: " ## Hi " }] }) as never,
    });
    expect(text).toBe("## Hi");
    await expect(
      summarize({
        changes: generated,
        apiKey: "k",
        model: "m",
        fetchImpl: () => reply({}, false) as never,
      }),
    ).rejects.toThrow("500");
    await expect(
      summarize({
        changes: generated,
        apiKey: "k",
        model: "m",
        fetchImpl: () => reply({ content: [] }) as never,
      }),
    ).rejects.toThrow("no text");
  });
});
