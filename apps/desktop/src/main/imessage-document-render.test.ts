import { describe, expect, it, vi } from "vitest";

import {
  chooseDocumentBaseName,
  isMarkdownDocument,
  markdownToPrintHtml,
  renderMarkdownDocument,
} from "./imessage-document-render.js";

describe("imessage-document-render", () => {
  it("detects Markdown documents by media type or file extension", () => {
    expect(isMarkdownDocument("latest.md", "text/markdown")).toBe(true);
    expect(isMarkdownDocument("notes.MARKDOWN")).toBe(true);
    expect(isMarkdownDocument("export", "text/markdown; charset=utf-8")).toBe(
      true,
    );
    expect(isMarkdownDocument("report.pdf", "application/pdf")).toBe(false);
    expect(isMarkdownDocument("photo.png", "image/png")).toBe(false);
  });

  it("prefers the document title over generic projection filenames like latest.md", () => {
    expect(chooseDocumentBaseName("latest.md", "Trip Plan")).toBe("Trip Plan");
    expect(chooseDocumentBaseName("latest.md", "notes.md")).toBe("notes");
    expect(chooseDocumentBaseName("quarterly-summary.md", "Summary")).toBe(
      "quarterly-summary",
    );
    expect(chooseDocumentBaseName("", "")).toBe("document");
  });

  it("builds self-contained escaped HTML from Markdown", () => {
    const html = markdownToPrintHtml(
      [
        "## Overview",
        "",
        "Bring a **coat** and see [Forecast](https://example.com).",
        "",
        "- Item 1",
        "- <script>alert(1)</script>",
        "",
        "| Day | Temp |",
        "| --- | --- |",
        "| Tue | 14C |",
      ].join("\n"),
      "Weather Guide",
    );

    expect(html).toContain("<h1>Weather Guide</h1>");
    expect(html).toContain("<h2>Overview</h2>");
    expect(html).toContain("<strong>coat</strong>");
    expect(html).toContain('<a href="https://example.com">Forecast</a>');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("<table><thead><tr><th>Day</th><th>Temp</th></tr>");
  });

  it("renders Markdown to PDF when renderer succeeds", async () => {
    const pdfBytes = new TextEncoder().encode("%PDF-1.7\nbody");
    const renderer = vi.fn(async () => pdfBytes);

    const out = await renderMarkdownDocument(
      {
        markdown: "# Plan\n\n- Step one",
        downloadedFilename: "latest.md",
        label: "Weekend Plan",
      },
      renderer,
    );

    expect(renderer).toHaveBeenCalledTimes(1);
    expect(out.format).toBe("pdf");
    expect(out.filename).toBe("Weekend Plan.pdf");
    expect(out.mediaType).toBe("application/pdf");
    expect(out.bytes).toBe(pdfBytes);
  });

  it("falls back to readable .txt when PDF rendering fails or is absent", async () => {
    const failing = vi.fn(async () => {
      throw new Error("print failed");
    });

    const out = await renderMarkdownDocument(
      {
        markdown: "# Weather\n\n**Sunny** all day.",
        downloadedFilename: "latest.md",
        label: "Weather Note",
      },
      failing,
    );

    expect(out.format).toBe("txt");
    expect(out.filename).toBe("Weather Note.txt");
    expect(out.mediaType).toBe("text/plain; charset=utf-8");
    expect(new TextDecoder().decode(out.bytes)).toBe(
      "Weather\n\nSunny all day.",
    );
  });
});
