import { describe, expect, it } from "vitest";

import type { Translate } from "../i18n/language";
import { formatMessage } from "../i18n/messages";
import { fileKind, fileSize, fileTypeLabel, viewerFor } from "./file-kind";

const t: Translate = (message, ...values) =>
  formatMessage(message, "en", undefined, values[0]);

describe("fileKind", () => {
  it("reads the extension first, then the media type", () => {
    expect(fileKind("source.m4a")).toBe("audio");
    expect(fileKind("report.PDF")).toBe("pdf");
    expect(fileKind("notes", "text/markdown; charset=utf-8")).toBe("markdown");
    expect(fileKind("clip", "video/mp4")).toBe("video");
    expect(fileKind("mystery.bin", "application/octet-stream")).toBe(
      "document",
    );
  });
});

describe("viewerFor", () => {
  it("opens what the desktop previews inside the app", () => {
    expect(viewerFor("transcript.md")).toBe("page");
    expect(viewerFor("data.json")).toBe("page");
    expect(viewerFor("photo.png")).toBe("image");
    expect(viewerFor("source.m4a")).toBe("audio");
    expect(viewerFor("clip.mov")).toBe("video");
    expect(viewerFor("paper.pdf")).toEqual({ web: "pdf" });
    expect(viewerFor("deck.pptx")).toEqual({ web: "office" });
    expect(viewerFor("plan.doc")).toEqual({ web: "office" });
    expect(viewerFor("sheet.xlsx")).toEqual({ web: "office" });
    expect(viewerFor("table.csv")).toEqual({ web: "csv" });
    expect(viewerFor("table.tsv")).toEqual({ web: "tsv" });
    expect(viewerFor("page.html")).toEqual({ web: "html" });
    expect(viewerFor("flow.mmd")).toEqual({ web: "mermaid" });
    expect(viewerFor("logo.svg")).toEqual({ web: "image" });
    expect(viewerFor("clip.webm")).toEqual({ web: "video" });
  });

  it("moves large text and images into the viewer page", () => {
    expect(viewerFor("log.txt", "", 3 * 1024 * 1024)).toEqual({ web: "text" });
    expect(viewerFor("scan.jpg", "", 30 * 1024 * 1024)).toEqual({
      web: "image",
    });
  });

  it("hands the system what the desktop cannot preview either", () => {
    expect(viewerFor("photo.heic")).toBe("system");
    expect(viewerFor("bundle.zip")).toBe("system");
    expect(viewerFor("notes.pages")).toBe("system");
    expect(viewerFor("paper.pdf", "", 60 * 1024 * 1024)).toBe("system");
  });
});

describe("labels", () => {
  it("names the type and size like the web", () => {
    expect(fileTypeLabel(t, "plan.docx")).toBe("Word");
    expect(fileTypeLabel(t, "table.csv")).toBe("CSV");
    expect(fileTypeLabel(t, "source.m4a")).toBe("Audio");
    expect(fileSize(645_384)).toBe("630 KB");
    expect(fileSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
