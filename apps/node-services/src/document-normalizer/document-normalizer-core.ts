import {
  DocumentNormalizationError,
  MAX_DOCUMENT_MARKDOWN_BYTES,
  MAX_DOCUMENT_SOURCE_BYTES,
  type DocumentNormalizationInput,
} from "./document-normalizer.js";
import {
  archiveEntryHeading,
  inflateGzip,
  listSafeZipFiles,
  stripGzipExtension,
} from "./document-archive-extract.js";
import {
  escapeMarkdownTableCell,
  extractDocText,
  extractOfficeMarkdown,
  extractSpreadsheetMarkdown,
  hasOleSignature,
  hasZipSignature,
} from "./document-office-extract.js";
import {
  codeFenceLanguage,
  isInProcessDocumentSource,
  resolveDocumentSourceKind,
} from "./document-source-kind.js";

export { isInProcessDocumentSource, resolveDocumentSourceKind };

const MAX_ARCHIVE_NESTING = 1;

function nextArchiveDepth(current: number | undefined): number {
  const depth = current ?? 0;
  if (depth >= MAX_ARCHIVE_NESTING) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_UNSUPPORTED");
  }
  return depth + 1;
}

export async function normalizeDocumentContent(
  input: DocumentNormalizationInput,
  maxOutputBytes = MAX_DOCUMENT_MARKDOWN_BYTES,
): Promise<Uint8Array> {
  if (input.source.byteLength > MAX_DOCUMENT_SOURCE_BYTES) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_TOO_LARGE");
  }
  const kind = resolveDocumentSourceKind(input);
  let markdown: string;
  switch (kind) {
    case "pdf":
      markdown = await (
        await import("./document-pdf-extract.js")
      ).extractPdfMarkdown(input.source);
      break;
    case "doc":
      markdown = hasZipSignature(input.source)
        ? await extractOfficeMarkdown(input.source, "docx")
        : await extractDocText(input.source);
      break;
    case "docx":
      markdown = hasOleSignature(input.source)
        ? await extractDocText(input.source)
        : await extractOfficeMarkdown(input.source, "docx");
      break;
    case "xlsx":
      markdown = await extractSpreadsheetMarkdown(input.source);
      break;
    case "pptx":
    case "odt":
    case "ods":
    case "odp":
    case "epub":
      markdown = await extractOfficeMarkdown(input.source, kind);
      break;
    case "mail":
      markdown = await (
        await import("./document-mail-extract.js")
      ).extractMailMarkdown(input.source);
      break;
    case "zip":
      markdown = await extractZipMarkdown(input);
      break;
    case "gzip":
      markdown = await extractGzipMarkdown(input);
      break;
    case "svg":
      markdown = (await import("./document-svg-extract.js")).svgToMarkdown(
        decodeUtf8Text(input.source),
        input.filename,
      );
      break;
    case "html":
      decodeUtf8Text(input.source);
      markdown = await extractOfficeMarkdown(input.source, "html");
      break;
    case "csv":
      markdown = delimitedToMarkdown(
        decodeUtf8Text(input.source),
        ",",
        maxOutputBytes,
      );
      break;
    case "tsv":
      markdown = delimitedToMarkdown(
        decodeUtf8Text(input.source),
        "\t",
        maxOutputBytes,
      );
      break;
    case "json":
      markdown = jsonToMarkdown(decodeUtf8Text(input.source));
      break;
    case "xml":
      markdown = fencedBlock("xml", decodeUtf8Text(input.source));
      break;
    case "yaml":
      markdown = fencedBlock("yaml", decodeUtf8Text(input.source));
      break;
    case "code":
      markdown = fencedBlock(
        codeFenceLanguage(input.filename),
        decodeUtf8Text(input.source),
      );
      break;
    case "markdown":
    case "plain":
      markdown = decodeUtf8Text(input.source);
      break;
    default:
      throw new DocumentNormalizationError("DOCUMENT_SOURCE_UNSUPPORTED");
  }
  return canonicalizeMarkdown(markdown, maxOutputBytes);
}

export function canonicalizeMarkdown(
  markdown: string,
  maxOutputBytes = MAX_DOCUMENT_MARKDOWN_BYTES,
): Uint8Array {
  const normalized = markdown
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .normalize("NFC")
    .replace(/\n+$/u, "");
  if (!normalized.trim()) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_EMPTY");
  }
  const encoded = new TextEncoder().encode(`${normalized}\n`);
  if (encoded.byteLength > maxOutputBytes) {
    throw new DocumentNormalizationError("DOCUMENT_MARKDOWN_TOO_LARGE");
  }
  return encoded;
}

async function extractZipMarkdown(
  input: DocumentNormalizationInput,
): Promise<string> {
  const nestedDepth = nextArchiveDepth(input.archiveDepth);
  const entries = await listSafeZipFiles(input.source);
  const sections: string[] = [];
  for (const entry of entries) {
    try {
      const markdown = await normalizeDocumentContent({
        archiveDepth: nestedDepth,
        filename: entry.filename,
        mediaType: "application/octet-stream",
        source: entry.bytes,
      });
      const body = new TextDecoder().decode(markdown).trim();
      if (!body) continue;
      sections.push(`## ${archiveEntryHeading(entry.filename)}\n\n${body}`);
    } catch (error) {
      if (!(error instanceof DocumentNormalizationError)) throw error;
      if (
        error.code === "DOCUMENT_SOURCE_TOO_LARGE" ||
        error.code === "DOCUMENT_MARKDOWN_TOO_LARGE"
      ) {
        throw error;
      }
    }
  }
  return sections.join("\n\n");
}

async function extractGzipMarkdown(
  input: DocumentNormalizationInput,
): Promise<string> {
  const nestedDepth = nextArchiveDepth(input.archiveDepth);
  const inflated = inflateGzip(input.source);
  return new TextDecoder().decode(
    await normalizeDocumentContent({
      archiveDepth: nestedDepth,
      filename: stripGzipExtension(input.filename),
      mediaType: "application/octet-stream",
      source: inflated,
    }),
  );
}

function decodeUtf8Text(source: Uint8Array): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }
  if (decoded.includes("\u0000")) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }
  return decoded;
}

function delimitedToMarkdown(
  text: string,
  delimiter: string,
  maxOutputBytes: number,
): string {
  const rows = parseDelimitedRows(text, delimiter);
  if (rows.length === 0) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_EMPTY");
  }
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  // Even empty cells need separators. Reject sparse inputs before padding their
  // rows into a potentially much larger table.
  if ((rows.length + 1) * width > maxOutputBytes) {
    throw new DocumentNormalizationError("DOCUMENT_MARKDOWN_TOO_LARGE");
  }
  const lines: string[] = [];
  let bytes = 0;
  const append = (cells: string[]) => {
    // Match canonicalization before counting: decomposed Unicode may fit after
    // NFC, and each complete line contributes its eventual trailing newline.
    const line = `| ${cells.join(" | ")} |`.normalize("NFC");
    bytes += Buffer.byteLength(line, "utf8") + 1;
    if (bytes > maxOutputBytes) {
      throw new DocumentNormalizationError("DOCUMENT_MARKDOWN_TOO_LARGE");
    }
    lines.push(line);
  };
  for (const [index, row] of rows.entries()) {
    append(
      Array.from({ length: width }, (_, column) =>
        escapeMarkdownTableCell(row[column] ?? ""),
      ),
    );
    if (index === 0) append(Array<string>(width).fill("---"));
  }
  return lines.join("\n");
}

function parseDelimitedRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      inQuotes = true;
      continue;
    }
    if (character === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (character === "\n") {
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (character === "\r") continue;
    field += character;
  }
  if (inQuotes) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((value) => value.trim())) rows.push(row);
  }
  return rows;
}

function jsonToMarkdown(text: string): string {
  try {
    // Node 26 provides raw JSON values; the project's ES2022 types omit them.
    const json = JSON as typeof JSON & {
      rawJSON(source: string): unknown;
    };
    const parsed: unknown = JSON.parse(
      text,
      (_key: string, value: unknown, context?: { source?: string }): unknown =>
        typeof value === "number" && context?.source !== undefined
          ? json.rawJSON(context.source)
          : value,
    );
    return fencedBlock("json", JSON.stringify(parsed, null, 2));
  } catch {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_INVALID");
  }
}

function fencedBlock(language: string, body: string): string {
  const normalized = body.replace(/^\uFEFF/u, "").replace(/\n+$/u, "");
  let fenceLength = 3;
  for (const run of normalized.matchAll(/`+/gu)) {
    fenceLength = Math.max(fenceLength, run[0].length + 1);
  }
  const fence = "`".repeat(fenceLength);
  const info = /^[^`\r\n]*$/u.test(language) ? language : "text";
  return `${fence}${info}\n${normalized}\n${fence}`;
}
