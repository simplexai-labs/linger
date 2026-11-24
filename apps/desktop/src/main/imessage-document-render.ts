import path from "node:path";

import { imessageText } from "./imessage-text.js";

const GENERIC_PROJECTION_BASENAMES = new Set([
  "latest",
  "document",
  "export",
  "content",
]);

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

export interface MarkdownDocumentInput {
  readonly markdown: string;
  readonly downloadedFilename: string;
  readonly label: string;
}

export interface RenderedOutboundDocument {
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly format: "pdf" | "txt";
}

export type HtmlToPdfRenderer = (html: string) => Promise<Uint8Array>;

export function isMarkdownDocument(
  filename: string,
  mediaType?: string,
): boolean {
  const mime = mediaType?.split(";")[0]?.trim().toLowerCase();
  if (mime === "text/markdown" || mime === "text/x-markdown") return true;
  const ext = path.extname(filename.trim()).toLowerCase();
  return MARKDOWN_EXTENSIONS.has(ext);
}

// Native Document downloads return generic names like "latest.md". Prefer the
// Document's own title from the message card when available so the file shown
// in iMessage carries a human-readable name.
export function chooseDocumentBaseName(
  downloadedFilename: string,
  label: string,
): string {
  const cleanDownloaded = path
    .basename(downloadedFilename.replace(/\\/g, "/"))
    .trim();
  const downloadedExt = path.extname(cleanDownloaded);
  const downloadedBase = downloadedExt
    ? cleanDownloaded.slice(0, -downloadedExt.length).trim()
    : cleanDownloaded;
  const cleanLabel = label.trim();
  const labelExt = path.extname(cleanLabel);
  const labelBase =
    labelExt && MARKDOWN_EXTENSIONS.has(labelExt.toLowerCase())
      ? cleanLabel.slice(0, -labelExt.length).trim()
      : cleanLabel;
  if (
    (!downloadedBase ||
      GENERIC_PROJECTION_BASENAMES.has(downloadedBase.toLowerCase())) &&
    labelBase
  ) {
    return labelBase;
  }
  return downloadedBase || labelBase || "document";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHref(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  return undefined;
}

function renderInlineMarkdown(text: string): string {
  const parts = text.split(/(`+)([^`]+?)\1/);
  let out = "";
  for (let i = 0; i < parts.length; i += 1) {
    if (i % 3 === 1) continue;
    if (i % 3 === 2) {
      out += `<code>${escapeHtml(parts[i]!)}</code>`;
      continue;
    }
    let segment = escapeHtml(parts[i]!);
    segment = segment.replace(
      /!?\[([^\]]*)\]\(\s*(?:&lt;)?([^)\s]+?)(?:&gt;)?(?:\s+&quot;[^&]*&quot;)?\s*\)/g,
      (_match, labelText: string, rawUrl: string) => {
        const href = safeHref(rawUrl);
        const visible = labelText || rawUrl;
        return href ? `<a href="${href}">${visible}</a>` : visible;
      },
    );
    segment = segment
      .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "<strong>$1</strong>")
      .replace(/__(?=\S)(.+?)(?<=\S)__/g, "<strong>$1</strong>")
      .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "<del>$1</del>")
      .replace(/(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, "<em>$1</em>")
      .replace(/(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])/g, "<em>$1</em>");
    out += segment;
  }
  return out;
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  if (!trimmed.includes("-")) return false;
  return trimmed.split("|").every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function markdownBodyToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }

    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const fence = fenceMatch[1]!;
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length) {
        const closeMatch = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]!);
        if (
          closeMatch &&
          closeMatch[1]![0] === fence[0] &&
          closeMatch[1]!.length >= fence.length
        ) {
          i += 1;
          break;
        }
        codeLines.push(lines[i]!);
        i += 1;
      }
      blocks.push(
        `<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`,
      );
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push("<hr />");
      i += 1;
      continue;
    }

    const headingMatch = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+\s*)?$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      blocks.push(
        `<h${String(level)}>${renderInlineMarkdown(headingMatch[2]!)}</h${String(level)}>`,
      );
      i += 1;
      continue;
    }

    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1]!)
    ) {
      const headers = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) {
        rows.push(splitTableRow(lines[i]!));
        i += 1;
      }
      const thead = `<thead><tr>${headers.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr></thead>`;
      const tbody = rows.length
        ? `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`
        : "";
      blocks.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i]!)) {
        quoteLines.push(lines[i]!.replace(/^\s{0,3}>\s?/, ""));
        i += 1;
      }
      blocks.push(
        `<blockquote>${markdownBodyToHtml(quoteLines.join("\n"))}</blockquote>`,
      );
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        items.push(
          `<li>${renderInlineMarkdown(lines[i]!.replace(/^\s*[-*+]\s+/, ""))}</li>`,
        );
        i += 1;
      }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(
          `<li>${renderInlineMarkdown(lines[i]!.replace(/^\s*\d+\.\s+/, ""))}</li>`,
        );
        i += 1;
      }
      blocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^\s{0,3}(`{3,}|~{3,}|#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/.test(lines[i]!)
    ) {
      paragraph.push(lines[i]!.trim());
      i += 1;
    }
    blocks.push(
      `<p>${paragraph.map((part) => renderInlineMarkdown(part)).join("<br />")}</p>`,
    );
  }

  return blocks.join("\n");
}

// Self-contained printable HTML document with no external network requests or
// scripts, styled for clean mobile PDF reading via iOS Quick Look.
export function markdownToPrintHtml(markdown: string, title: string): string {
  const safeTitle = escapeHtml(title.trim() || "Document");
  const trimmed = markdown.trim();
  const hasLeadingHeading = /^\s{0,3}#\s+/.test(trimmed);
  const titleHeader =
    title.trim() && !hasLeadingHeading ? `<h1>${safeTitle}</h1>\n` : "";
  const body = markdownBodyToHtml(trimmed);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;" />
<title>${safeTitle}</title>
<style>
  @page { margin: 16mm 14mm; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Helvetica Neue", Arial, sans-serif;
    font-size: 15px;
    line-height: 1.7;
    color: #18181b;
    max-width: 720px;
    margin: 0 auto;
    word-wrap: break-word;
  }
  h1 { font-size: 24px; line-height: 1.3; margin: 0 0 14px; padding-bottom: 8px; border-bottom: 1px solid #e4e4e7; }
  h2 { font-size: 19px; line-height: 1.35; margin: 22px 0 10px; }
  h3 { font-size: 16px; line-height: 1.4; margin: 18px 0 8px; }
  h4, h5, h6 { font-size: 15px; margin: 14px 0 6px; }
  p { margin: 0 0 12px; }
  ul, ol { margin: 0 0 12px; padding-left: 22px; }
  li { margin: 4px 0; }
  blockquote {
    margin: 12px 0;
    padding: 8px 14px;
    border-left: 3px solid #a1a1aa;
    background: #fafafa;
    color: #3f3f46;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 13px;
    background: #f4f4f5;
    padding: 1px 5px;
    border-radius: 4px;
  }
  pre {
    background: #f4f4f5;
    padding: 12px 14px;
    border-radius: 8px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 12px 0;
  }
  pre code { background: none; padding: 0; font-size: 12.5px; }
  table { border-collapse: collapse; width: 100%; margin: 14px 0; font-size: 13.5px; }
  th, td { border: 1px solid #d4d4d8; padding: 7px 10px; text-align: left; }
  th { background: #f4f4f5; font-weight: 600; }
  hr { border: none; border-top: 1px solid #e4e4e7; margin: 18px 0; }
  a { color: #2563eb; text-decoration: none; }
</style>
</head>
<body>
${titleHeader}${body}
</body>
</html>`;
}

function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 5 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d // -
  );
}

// Renders a Markdown Document to PDF so iOS Messages Quick Look opens it
// directly; falls back to plain UTF-8 text (.txt) if PDF rendering fails.
export async function renderMarkdownDocument(
  input: MarkdownDocumentInput,
  renderHtmlToPdf?: HtmlToPdfRenderer,
  maxBytes?: number,
): Promise<RenderedOutboundDocument> {
  const baseName = chooseDocumentBaseName(
    input.downloadedFilename,
    input.label,
  );
  if (renderHtmlToPdf) {
    try {
      const html = markdownToPrintHtml(input.markdown, baseName);
      const pdfBytes = await renderHtmlToPdf(html);
      if (
        looksLikePdf(pdfBytes) &&
        (maxBytes === undefined || pdfBytes.byteLength <= maxBytes)
      ) {
        return {
          filename: `${baseName}.pdf`,
          mediaType: "application/pdf",
          bytes: pdfBytes,
          format: "pdf",
        };
      }
    } catch {
      // Fall through to plain text so iOS Messages can still open the file.
    }
  }
  const plain =
    imessageText(input.markdown).join("\n\n").trim() || input.markdown.trim();
  const txtBytes = new TextEncoder().encode(plain);
  return {
    filename: `${baseName}.txt`,
    mediaType: "text/plain; charset=utf-8",
    bytes: txtBytes,
    format: "txt",
  };
}
