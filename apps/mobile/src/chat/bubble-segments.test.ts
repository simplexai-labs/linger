import { describe, expect, it } from "vitest";

import type { Message } from "../api/types";
import { bubbleSegments } from "./bubble-segments";

function message(
  segments: unknown[],
  attachments: { document_id: string; document_version_id: string }[],
): Message {
  return { segments, attachments } as unknown as Message;
}

describe("bubbleSegments", () => {
  it("leaves attached files, attached Document cards and meeting notes out of the text", () => {
    const segments = bubbleSegments(
      message(
        [
          { type: "text", content: "Here you go.\n" },
          {
            type: "document",
            content: "source.m4a",
            document_id: "d1",
            presentation: "card",
          },
          { type: "file", content: "a.png", document_version_id: "v2" },
          {
            type: "meeting_notes",
            content: "Meeting summary",
            capture_id: "c",
          },
        ],
        [
          { document_id: "d1", document_version_id: "v1" },
          { document_id: "d2", document_version_id: "v2" },
        ],
      ),
    );
    expect(segments.map((segment) => segment.content)).toEqual([
      "Here you go.\n",
    ]);
  });

  it("keeps an inline Document link and a card nothing attached", () => {
    const segments = bubbleSegments(
      message(
        [
          {
            type: "document",
            content: "Plan",
            document_id: "d1",
            presentation: "inline",
          },
          {
            type: "document",
            content: "Spec",
            document_id: "d9",
            presentation: "card",
          },
        ],
        [{ document_id: "d1", document_version_id: "v1" }],
      ),
    );
    expect(segments.map((segment) => segment.content)).toEqual([
      "Plan",
      "Spec",
    ]);
  });
});
