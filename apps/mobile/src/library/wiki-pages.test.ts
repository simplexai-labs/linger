import { describe, expect, it } from "vitest";

import type { Translate } from "../i18n/language";
import { formatMessage } from "../i18n/messages";
import { wikiPageTitle, wikiSections } from "./wiki-pages";

const t: Translate = (message, ...values) =>
  formatMessage(message, "en", undefined, values[0]);

function page(title: string, pageKey?: string, kind = "wiki_page") {
  return {
    title,
    from: [
      {
        binding_kind: kind as "wiki_page",
        context_id: "wiki_1",
        ...(pageKey ? { page_key: pageKey } : {}),
      },
    ],
  };
}

describe("wikiSections", () => {
  it("groups generated pages by collection and keeps the list order", () => {
    const sections = wikiSections(
      [
        page("Topic b", "topics/b.md"),
        page("Acme", "clients/acme.md"),
        page("Topic a", "topics/a.md"),
        page("Room abc", "sessions/2026-11-20/room_abc.md"),
        page("Overview", "overview.md"),
      ],
      t,
    );
    expect(
      sections.map((section) => [
        section.label,
        section.entries.map((entry) => entry.title),
      ]),
    ).toEqual([
      ["Topics", ["Topic b", "Topic a"]],
      ["Companies", ["Acme"]],
      ["Conversations", ["Conversation"]],
      ["Pages", ["Overview"]],
    ]);
    expect(sections[2]!.entries[0]!.sessionDate).toBe("2026-11-20");
  });

  it("leaves out indexes and Wiki sources, as the desktop does", () => {
    expect(
      wikiSections(
        [
          page("Index", "index.md"),
          page("Projects", "projects/index.md"),
          page("notes.pdf", undefined, "wiki_source"),
        ],
        t,
      ),
    ).toEqual([]);
  });

  it("lists meeting notes with the conversations of their day", () => {
    const sections = wikiSections(
      [
        page(
          "Capture session 7db5d734e00fd667",
          "sessions/2026-11-20/capture_session_7db5d734e00fd667.md",
        ),
      ],
      t,
    );
    expect(sections.map((section) => section.label)).toEqual(["Conversations"]);
    expect(sections[0]!.entries[0]).toMatchObject({
      title: "Meeting notes",
      sessionDate: "2026-11-20",
    });
  });

  it("names meeting notes after their meeting when it is known", () => {
    const [section] = wikiSections(
      [
        page(
          "Capture session 7db5",
          "sessions/2026-11-20/capture_session_7db5.md",
        ),
      ],
      t,
      new Map([["capture_session_7db5", "Launch review"]]),
    );
    expect(section!.entries[0]!.title).toBe("Launch review");
  });
});

describe("wikiPageTitle", () => {
  it("names Session pages by kind instead of their file name", () => {
    expect(
      wikiPageTitle(
        page(
          "Capture session 7db5",
          "sessions/2026-11-20/capture_session_7db5.md",
        ),
        t,
      ),
    ).toBe("Meeting notes");
    expect(
      wikiPageTitle(page("Room x", "sessions/2026-11-20/room_x.md"), t),
    ).toBe("Conversation");
    expect(wikiPageTitle(page("Acme", "clients/acme.md"), t)).toBe("Acme");
  });
});
