import { describe, expect, it } from "vitest";

import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";

import { selectAutoOpenMessageFile } from "./auto-open-message-file";
import { artifactPreviewMaxFileBytes } from "./files/artifact-preview-limits";

function makeMessage(overrides: Partial<TeamHubMessage> = {}): TeamHubMessage {
  return {
    id: "message-1",
    tenant_id: "tenant-1",
    room_id: "room-1",
    author: {
      id: "actor-agent",
      kind: "agent",
      display_name: "Codex",
      tenant_id: "tenant-1",
    },
    message_kind: "conversation",
    raw_message: "",
    segments: [],
    attachments: [],
    created_at: "2026-11-27T10:00:00Z",
    ...overrides,
  };
}

function makeAttachment(
  overrides: Partial<TeamHubMessage["attachments"][number]> = {},
): TeamHubMessage["attachments"][number] {
  return {
    id: "att-1",
    document_id: "doc-1",
    document_version_id: "ver-1",
    filename: "report.html",
    media_type: "text/html",
    size_bytes: 1024,
    sha256: "a".repeat(64),
    available: true,
    ...overrides,
  };
}

describe("selectAutoOpenMessageFile", () => {
  it("opens a canvas document regardless of author or message kind and gives it priority over earlier files or cards", () => {
    const humanCanvas = makeMessage({
      author: {
        id: "actor-human",
        kind: "human",
        display_name: "Jenny",
        tenant_id: "tenant-1",
      },
      message_kind: "room_notice",
      segments: [
        {
          type: "file",
          content: "preview.html",
          document_id: "doc-file",
          document_version_id: "ver-file",
          filename: "preview.html",
          media_type: "text/html",
        },
        {
          type: "document",
          content: "Earlier Card",
          document_id: "doc-card",
          presentation: "card",
        },
        {
          type: "document",
          content: "Draft Email",
          document_id: "doc-canvas",
          presentation: "canvas",
        },
      ],
    });

    expect(selectAutoOpenMessageFile(humanCanvas)).toEqual({
      kind: "file",
      documentId: "doc-canvas",
      title: "Draft Email",
    });

    const agentWithEarlierFile = makeMessage({
      segments: [
        {
          type: "file",
          content: "preview.html",
          document_id: "doc-file",
          document_version_id: "ver-file",
          filename: "preview.html",
          media_type: "text/html",
        },
        {
          type: "document",
          content: "Live Canvas",
          document_id: "doc-canvas",
          presentation: "canvas",
        },
      ],
      attachments: [
        makeAttachment({
          document_id: "doc-file",
          document_version_id: "ver-file",
          filename: "preview.html",
          media_type: "text/html",
        }),
      ],
    });

    expect(selectAutoOpenMessageFile(agentWithEarlierFile)).toEqual({
      kind: "file",
      documentId: "doc-canvas",
      title: "Live Canvas",
    });
  });

  it.each([
    { filename: "demo.html", mediaType: "text/html" },
    { filename: "brief.pdf", mediaType: "application/pdf" },
    { filename: "notes.md", mediaType: "text/markdown" },
    { filename: "chart.png", mediaType: "image/png" },
    {
      filename: "budget.xlsx",
      mediaType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    {
      filename: "proposal.docx",
      mediaType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    { filename: "script.py", mediaType: "text/x-python" },
  ])(
    "auto-opens an Agent conversation file segment for previewable $filename",
    ({ filename, mediaType }) => {
      const message = makeMessage({
        segments: [
          { type: "text", content: "Here is the file." },
          {
            type: "file",
            content: filename,
            document_id: "doc-file",
            document_version_id: "ver-file",
            filename,
            media_type: mediaType,
          },
        ],
        attachments: [
          makeAttachment({
            document_id: "doc-file",
            document_version_id: "ver-file",
            filename,
            media_type: mediaType,
          }),
        ],
      });

      expect(selectAutoOpenMessageFile(message)).toEqual({
        kind: "file",
        documentId: "doc-file",
        title: filename,
        previewCurrentVersion: true,
      });
    },
  );

  it("falls back to attachment metadata when file segment omits filename and media_type", () => {
    const message = makeMessage({
      segments: [
        {
          type: "file",
          content: "attached",
          document_id: "doc-html",
          document_version_id: "ver-html",
        },
      ],
      attachments: [
        makeAttachment({
          document_id: "doc-html",
          document_version_id: "ver-html",
          filename: "dashboard.html",
          media_type: "text/html",
        }),
      ],
    });

    expect(selectAutoOpenMessageFile(message)).toEqual({
      kind: "file",
      documentId: "doc-html",
      title: "dashboard.html",
      previewCurrentVersion: true,
    });
  });

  it("opens an Agent document segment with card presentation without previewCurrentVersion or versionId", () => {
    const message = makeMessage({
      segments: [
        {
          type: "document",
          content: "Launch Spec",
          document_id: "doc-spec",
          presentation: "card",
        },
      ],
    });

    const target = selectAutoOpenMessageFile(message);
    expect(target).toEqual({
      kind: "file",
      documentId: "doc-spec",
      title: "Launch Spec",
    });
    expect(target).not.toHaveProperty("previewCurrentVersion");
    expect(target).not.toHaveProperty("versionId");
  });

  it("opens a document card whose matching attachment is available and previewable", () => {
    const message = makeMessage({
      segments: [
        {
          type: "document",
          content: "Quarterly Report",
          document_id: "doc-report",
          presentation: "card",
        },
      ],
      attachments: [
        makeAttachment({
          document_id: "doc-report",
          document_version_id: "ver-report",
          filename: "quarterly-report.pdf",
          media_type: "application/pdf",
          size_bytes: 2048,
          available: true,
        }),
      ],
    });

    expect(selectAutoOpenMessageFile(message)).toEqual({
      kind: "file",
      documentId: "doc-report",
      title: "Quarterly Report",
    });
  });

  it("skips a document card whose attachment is unavailable, non-previewable, or oversized", () => {
    const unavailableCard = makeMessage({
      segments: [
        {
          type: "document",
          content: "Removed Report",
          document_id: "doc-unavail",
          presentation: "card",
        },
      ],
      attachments: [
        makeAttachment({
          document_id: "doc-unavail",
          document_version_id: "ver-unavail",
          filename: "report.html",
          media_type: "text/html",
          available: false,
        }),
      ],
    });
    expect(selectAutoOpenMessageFile(unavailableCard)).toBeNull();

    const zipCard = makeMessage({
      segments: [
        {
          type: "document",
          content: "Archive",
          document_id: "doc-zip",
          presentation: "card",
        },
      ],
      attachments: [
        makeAttachment({
          document_id: "doc-zip",
          document_version_id: "ver-zip",
          filename: "archive.zip",
          media_type: "application/zip",
        }),
      ],
    });
    expect(selectAutoOpenMessageFile(zipCard)).toBeNull();

    const oversizedThenPreviewable = makeMessage({
      segments: [
        {
          type: "document",
          content: "Huge HTML",
          document_id: "doc-huge",
          presentation: "card",
        },
        {
          type: "file",
          content: "summary.html",
          document_id: "doc-summary",
          document_version_id: "ver-summary",
          filename: "summary.html",
          media_type: "text/html",
        },
      ],
      attachments: [
        makeAttachment({
          id: "att-1",
          document_id: "doc-huge",
          document_version_id: "ver-huge",
          filename: "huge.html",
          media_type: "text/html",
          size_bytes: artifactPreviewMaxFileBytes + 1,
        }),
        makeAttachment({
          id: "att-2",
          document_id: "doc-summary",
          document_version_id: "ver-summary",
          filename: "summary.html",
          media_type: "text/html",
        }),
      ],
    });
    expect(selectAutoOpenMessageFile(oversizedThenPreviewable)).toEqual({
      kind: "file",
      documentId: "doc-summary",
      title: "summary.html",
      previewCurrentVersion: true,
    });
  });

  it("does not auto-open voice capture completion messages containing meeting_notes", () => {
    const meetingCompletion = makeMessage({
      segments: [
        {
          type: "document",
          content: "recording.webm",
          document_id: "doc-audio",
          presentation: "card",
        },
        {
          type: "document",
          content: "Transcript",
          document_id: "doc-transcript",
          presentation: "card",
        },
        {
          type: "meeting_notes",
          content: "Quick notes",
          capture_id: "capture-1",
        },
      ],
      attachments: [
        makeAttachment({
          document_id: "doc-audio",
          document_version_id: "ver-audio",
          filename: "recording.webm",
          media_type: "audio/webm",
        }),
      ],
    });

    expect(selectAutoOpenMessageFile(meetingCompletion)).toBeNull();
  });

  it("ignores inline or omitted-presentation document references", () => {
    for (const presentation of ["inline", undefined] as const) {
      const message = makeMessage({
        segments: [
          {
            type: "document",
            content: "@Spec",
            document_id: "doc-spec",
            ...(presentation ? { presentation } : {}),
          },
        ],
      });
      expect(selectAutoOpenMessageFile(message)).toBeNull();
    }
  });

  it("opens an artifact_tree entry document when entry IDs are present and ignores trees without an entry", () => {
    const withEntry = makeMessage({
      segments: [
        {
          type: "artifact_tree",
          content: "site/",
          publication_group_id: "pub-1",
          root_path: "site",
          file_count: 3,
          directory_count: 1,
          total_bytes: 4096,
          entry_document_id: "doc-entry",
          entry_document_version_id: "ver-entry",
        },
      ],
    });

    expect(selectAutoOpenMessageFile(withEntry)).toEqual({
      kind: "file",
      documentId: "doc-entry",
      title: "site",
      versionId: "ver-entry",
    });

    const withoutEntry = makeMessage({
      segments: [
        {
          type: "artifact_tree",
          content: "assets/",
          publication_group_id: "pub-2",
          root_path: "assets",
          file_count: 2,
          directory_count: 0,
          total_bytes: 2048,
        },
      ],
    });

    expect(selectAutoOpenMessageFile(withoutEntry)).toBeNull();
  });

  it("returns null for non-previewable, unavailable, or oversized files", () => {
    const zipMessage = makeMessage({
      segments: [
        {
          type: "file",
          content: "bundle.zip",
          document_id: "doc-zip",
          document_version_id: "ver-zip",
          filename: "bundle.zip",
          media_type: "application/zip",
        },
      ],
      attachments: [
        makeAttachment({
          document_id: "doc-zip",
          document_version_id: "ver-zip",
          filename: "bundle.zip",
          media_type: "application/zip",
        }),
      ],
    });
    expect(selectAutoOpenMessageFile(zipMessage)).toBeNull();

    const binMessage = makeMessage({
      segments: [
        {
          type: "file",
          content: "payload.bin",
          document_id: "doc-bin",
          document_version_id: "ver-bin",
          filename: "payload.bin",
          media_type: "application/octet-stream",
        },
      ],
      attachments: [
        makeAttachment({
          document_id: "doc-bin",
          document_version_id: "ver-bin",
          filename: "payload.bin",
          media_type: "application/octet-stream",
        }),
      ],
    });
    expect(selectAutoOpenMessageFile(binMessage)).toBeNull();

    const unavailableMessage = makeMessage({
      segments: [
        {
          type: "file",
          content: "report.html",
          document_id: "doc-unavail",
          document_version_id: "ver-unavail",
          filename: "report.html",
          media_type: "text/html",
        },
      ],
      attachments: [
        makeAttachment({
          document_id: "doc-unavail",
          document_version_id: "ver-unavail",
          filename: "report.html",
          media_type: "text/html",
          available: false,
        }),
      ],
    });
    expect(selectAutoOpenMessageFile(unavailableMessage)).toBeNull();

    const oversizedMessage = makeMessage({
      segments: [
        {
          type: "file",
          content: "huge.html",
          document_id: "doc-huge",
          document_version_id: "ver-huge",
          filename: "huge.html",
          media_type: "text/html",
        },
      ],
      attachments: [
        makeAttachment({
          document_id: "doc-huge",
          document_version_id: "ver-huge",
          filename: "huge.html",
          media_type: "text/html",
          size_bytes: artifactPreviewMaxFileBytes + 1,
        }),
      ],
    });
    expect(selectAutoOpenMessageFile(oversizedMessage)).toBeNull();
  });

  it("skips an earlier non-previewable file and opens a later previewable file", () => {
    const message = makeMessage({
      segments: [
        {
          type: "file",
          content: "bundle.zip",
          document_id: "doc-zip",
          document_version_id: "ver-zip",
          filename: "bundle.zip",
          media_type: "application/zip",
        },
        {
          type: "file",
          content: "preview.html",
          document_id: "doc-html",
          document_version_id: "ver-html",
          filename: "preview.html",
          media_type: "text/html",
        },
      ],
      attachments: [
        makeAttachment({
          id: "att-1",
          document_id: "doc-zip",
          document_version_id: "ver-zip",
          filename: "bundle.zip",
          media_type: "application/zip",
        }),
        makeAttachment({
          id: "att-2",
          document_id: "doc-html",
          document_version_id: "ver-html",
          filename: "preview.html",
          media_type: "text/html",
        }),
      ],
    });

    expect(selectAutoOpenMessageFile(message)).toEqual({
      kind: "file",
      documentId: "doc-html",
      title: "preview.html",
      previewCurrentVersion: true,
    });
  });

  it("opens the first previewable file when multiple previewable files are delivered", () => {
    const message = makeMessage({
      segments: [
        {
          type: "file",
          content: "first.html",
          document_id: "doc-first",
          document_version_id: "ver-first",
          filename: "first.html",
          media_type: "text/html",
        },
        {
          type: "file",
          content: "second.pdf",
          document_id: "doc-second",
          document_version_id: "ver-second",
          filename: "second.pdf",
          media_type: "application/pdf",
        },
      ],
      attachments: [
        makeAttachment({
          id: "att-1",
          document_id: "doc-first",
          document_version_id: "ver-first",
          filename: "first.html",
          media_type: "text/html",
        }),
        makeAttachment({
          id: "att-2",
          document_id: "doc-second",
          document_version_id: "ver-second",
          filename: "second.pdf",
          media_type: "application/pdf",
        }),
      ],
    });

    expect(selectAutoOpenMessageFile(message)).toEqual({
      kind: "file",
      documentId: "doc-first",
      title: "first.html",
      previewCurrentVersion: true,
    });
  });

  it("keeps inline html_fragment messages in chat even when a backing HTML attachment is present", () => {
    const message = makeMessage({
      segments: [
        {
          type: "html_fragment",
          content: "visual-fragment.html",
          html: "<div>Inline widget</div>",
        },
      ],
      attachments: [
        makeAttachment({
          document_id: "doc-fragment",
          document_version_id: "ver-fragment",
          filename: "visual-fragment.html",
          media_type: "text/html",
        }),
      ],
    });

    expect(selectAutoOpenMessageFile(message)).toBeNull();
  });

  it("does not auto-open files or document cards sent by a Human", () => {
    const humanAuthor = {
      id: "actor-human",
      kind: "human" as const,
      display_name: "Jenny",
      tenant_id: "tenant-1",
    };

    const humanFile = makeMessage({
      author: humanAuthor,
      segments: [
        {
          type: "file",
          content: "index.html",
          document_id: "doc-html",
          document_version_id: "ver-html",
          filename: "index.html",
          media_type: "text/html",
        },
      ],
      attachments: [makeAttachment({ filename: "index.html" })],
    });
    expect(selectAutoOpenMessageFile(humanFile)).toBeNull();

    const humanCard = makeMessage({
      author: humanAuthor,
      segments: [
        {
          type: "document",
          content: "Shared Spec",
          document_id: "doc-spec",
          presentation: "card",
        },
      ],
    });
    expect(selectAutoOpenMessageFile(humanCard)).toBeNull();
  });

  it("does not auto-open non-conversation messages or decision card messages unless they carry a canvas", () => {
    const fileSegment = {
      type: "file" as const,
      content: "report.html",
      document_id: "doc-html",
      document_version_id: "ver-html",
      filename: "report.html",
      media_type: "text/html",
    };

    for (const message_kind of ["room_notice", "agent_runtime"] as const) {
      expect(
        selectAutoOpenMessageFile(
          makeMessage({
            message_kind,
            segments: [fileSegment],
            attachments: [makeAttachment()],
          }),
        ),
      ).toBeNull();
    }

    const decisionCard = {
      decision_id: "dec-1",
      kind: "question",
      status: "pending",
      title: "Pick one",
    } as unknown as NonNullable<TeamHubMessage["card"]>;

    expect(
      selectAutoOpenMessageFile(
        makeMessage({
          card: decisionCard,
          segments: [fileSegment],
          attachments: [makeAttachment()],
        }),
      ),
    ).toBeNull();

    expect(
      selectAutoOpenMessageFile(
        makeMessage({
          card: decisionCard,
          segments: [
            fileSegment,
            {
              type: "document",
              content: "Decision Canvas",
              document_id: "doc-canvas",
              presentation: "canvas",
            },
          ],
          attachments: [makeAttachment()],
        }),
      ),
    ).toEqual({
      kind: "file",
      documentId: "doc-canvas",
      title: "Decision Canvas",
    });
  });
});
