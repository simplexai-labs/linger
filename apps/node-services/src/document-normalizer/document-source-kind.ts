import { MIMEType } from "node:util";

import {
  DocumentNormalizationError,
  type DocumentNormalizationInput,
} from "./document-normalizer.js";

export type DocumentSourceKind =
  | "markdown"
  | "plain"
  | "html"
  | "csv"
  | "tsv"
  | "json"
  | "xml"
  | "yaml"
  | "code"
  | "pdf"
  | "doc"
  | "docx"
  | "xlsx"
  | "pptx"
  | "odt"
  | "ods"
  | "odp"
  | "epub"
  | "mail"
  | "zip"
  | "gzip"
  | "svg"
  | "unsupported";

const TEXT_DOCUMENT_SOURCE_KINDS = new Set<DocumentSourceKind>([
  "markdown",
  "plain",
  "html",
  "csv",
  "tsv",
  "json",
  "xml",
  "yaml",
  "code",
  "svg",
]);

const ZIP_DOCUMENT_KINDS = new Set<DocumentSourceKind>([
  "docx",
  "xlsx",
  "pptx",
  "odt",
  "ods",
  "odp",
  "epub",
]);

const MEDIA_TYPE_KINDS: Record<string, DocumentSourceKind> = {
  "application/epub+zip": "epub",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template":
    "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.template":
    "pptx",
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow":
    "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template":
    "xlsx",
  "message/rfc822": "mail",
  "multipart/related": "mail",
  "application/x-mimearchive": "mail",
  "application/csv": "csv",
  "application/ecmascript": "code",
  "application/javascript": "code",
  "application/json": "json",
  "application/ld+json": "json",
  "application/msword": "doc",
  "application/pdf": "pdf",
  "application/sql": "code",
  "application/toml": "code",
  "application/vnd.ms-word": "doc",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/gzip": "gzip",
  "application/x-gzip": "gzip",
  "application/x-javascript": "code",
  "application/x-msword": "doc",
  "application/x-yaml": "yaml",
  "application/x-zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/xhtml+xml": "html",
  "application/xml": "xml",
  "application/yaml": "yaml",
  "application/zip": "zip",
  "image/svg+xml": "svg",
  "text/comma-separated-values": "csv",
  "text/css": "code",
  "text/csv": "csv",
  "text/html": "html",
  "text/javascript": "code",
  "text/json": "json",
  "text/markdown": "markdown",
  "text/plain": "plain",
  "text/tab-separated-values": "tsv",
  "text/tsv": "tsv",
  "text/x-markdown": "markdown",
  "text/x-python": "code",
  "text/x-sh": "code",
  "text/x-sql": "code",
  "text/x-yaml": "yaml",
  "text/xml": "xml",
  "text/yaml": "yaml",
};

const EXPLICITLY_UNSUPPORTED_MEDIA_TYPES = new Set([
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.rar",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/x-tar",
]);

const EXTENSION_KINDS: Record<string, DocumentSourceKind> = {
  odt: "odt",
  ods: "ods",
  odp: "odp",
  epub: "epub",
  eml: "mail",
  mht: "mail",
  mhtml: "mail",
  dotx: "docx",
  potx: "pptx",
  ppsx: "pptx",
  xltx: "xlsx",
  c: "code",
  cpp: "code",
  css: "code",
  avif: "unsupported",
  bmp: "unsupported",
  csv: "csv",
  doc: "doc",
  docx: "docx",
  gif: "unsupported",
  go: "code",
  gz: "gzip",
  gzip: "gzip",
  h: "code",
  heic: "unsupported",
  heif: "unsupported",
  hpp: "code",
  htm: "html",
  html: "html",
  ico: "unsupported",
  java: "code",
  jpeg: "unsupported",
  jpg: "unsupported",
  js: "code",
  json: "json",
  jsx: "code",
  less: "code",
  log: "plain",
  markdown: "markdown",
  md: "markdown",
  mmd: "code",
  pdf: "pdf",
  png: "unsupported",
  pptx: "pptx",
  py: "code",
  rs: "code",
  scss: "code",
  sh: "code",
  sql: "code",
  svg: "svg",
  tif: "unsupported",
  tiff: "unsupported",
  toml: "code",
  ts: "code",
  tsv: "tsv",
  tsx: "code",
  txt: "plain",
  webp: "unsupported",
  xlsx: "xlsx",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zip: "zip",
};

const REPRESENTATION_KINDS: Record<string, DocumentSourceKind> = {
  csv: "csv",
  doc: "doc",
  docx: "docx",
  gzip: "gzip",
  html: "html",
  json: "json",
  markdown: "markdown",
  pdf: "pdf",
  plain_text: "plain",
  png: "unsupported",
  pptx: "pptx",
  svg: "svg",
  tsv: "tsv",
  xlsx: "xlsx",
  xml: "xml",
  yaml: "yaml",
  zip: "zip",
};

const CODE_LANGUAGES: Record<string, string> = {
  c: "c",
  cpp: "cpp",
  css: "css",
  go: "go",
  h: "c",
  hpp: "cpp",
  java: "java",
  js: "javascript",
  jsx: "jsx",
  less: "less",
  mmd: "mermaid",
  py: "python",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
};

export function resolveDocumentSourceKind(
  input: Pick<
    DocumentNormalizationInput,
    "filename" | "mediaType" | "representationFormat"
  >,
): DocumentSourceKind {
  const parsed = parseMediaType(input.mediaType);
  const fromMedia = kindFromMediaType(parsed.essence);
  if (fromMedia) {
    if (fromMedia === "zip") {
      const officeKind = zipDocumentKind(input);
      if (officeKind) return officeKind;
    }
    assertCompatibleCharset(fromMedia, parsed.charset);
    return fromMedia;
  }
  const fromName = kindFromFilename(input.filename);
  if (fromName) {
    assertCompatibleCharset(fromName, parsed.charset);
    return fromName;
  }
  const fromFormat = kindFromRepresentation(input.representationFormat);
  if (fromFormat) {
    assertCompatibleCharset(fromFormat, parsed.charset);
    return fromFormat;
  }
  if (parsed.essence.startsWith("text/")) {
    assertCompatibleCharset("plain", parsed.charset);
    return "plain";
  }
  return "unsupported";
}

export function isInProcessDocumentSource(
  input: Pick<
    DocumentNormalizationInput,
    "filename" | "mediaType" | "representationFormat"
  >,
): boolean {
  const kind = resolveDocumentSourceKind(input);
  // Structured parsing can block shared roles even when the source is text.
  return (
    kind !== "json" && kind !== "html" && TEXT_DOCUMENT_SOURCE_KINDS.has(kind)
  );
}

export function codeFenceLanguage(filename: string | undefined): string {
  const extension = fileExtension(filename);
  return ownValue(CODE_LANGUAGES, extension) ?? extension ?? "text";
}

function kindFromMediaType(essence: string): DocumentSourceKind | undefined {
  if (!essence || essence === "application/octet-stream") return undefined;
  const mapped = ownValue(MEDIA_TYPE_KINDS, essence);
  if (mapped) return mapped;
  if (
    essence.startsWith("image/") ||
    essence.startsWith("audio/") ||
    essence.startsWith("video/") ||
    EXPLICITLY_UNSUPPORTED_MEDIA_TYPES.has(essence)
  ) {
    return "unsupported";
  }
  return undefined;
}

function zipDocumentKind(
  input: Pick<DocumentNormalizationInput, "filename" | "representationFormat">,
): DocumentSourceKind | undefined {
  const fromName = kindFromFilename(input.filename);
  if (fromName && ZIP_DOCUMENT_KINDS.has(fromName)) return fromName;
  const fromFormat = kindFromRepresentation(input.representationFormat);
  if (fromFormat && ZIP_DOCUMENT_KINDS.has(fromFormat)) return fromFormat;
  return undefined;
}

function kindFromFilename(
  filename: string | undefined,
): DocumentSourceKind | undefined {
  const extension = fileExtension(filename);
  return extension ? ownValue(EXTENSION_KINDS, extension) : undefined;
}

function kindFromRepresentation(
  representationFormat: string | undefined,
): DocumentSourceKind | undefined {
  const normalized = representationFormat?.trim().toLocaleLowerCase("en-US");
  if (!normalized) return undefined;
  return (
    ownValue(REPRESENTATION_KINDS, normalized) ??
    ownValue(EXTENSION_KINDS, normalized)
  );
}

function parseMediaType(value: string): {
  essence: string;
  charset: string | null;
} {
  const separator = value.indexOf(";");
  const essence = (separator < 0 ? value : value.slice(0, separator))
    .trim()
    .toLocaleLowerCase("en-US");
  // Parse parameters independently so an absent or generic essence can still
  // fall back to the filename or representation format.
  const parameters = separator < 0 ? "" : value.slice(separator);
  const charset = new MIMEType(
    `application/octet-stream${parameters}`,
  ).params.get("charset");
  return { essence, charset };
}

function assertCompatibleCharset(
  kind: DocumentSourceKind,
  charset: string | null,
): void {
  if (!TEXT_DOCUMENT_SOURCE_KINDS.has(kind)) return;
  if (
    charset !== null &&
    !["utf-8", "utf8"].includes(charset.toLocaleLowerCase("en-US"))
  ) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_UNSUPPORTED");
  }
}

function fileExtension(filename: string | undefined): string {
  if (!filename) return "";
  const basename = filename.split(/[/\\]/u).at(-1) ?? "";
  const separator = basename.lastIndexOf(".");
  if (separator <= 0 || separator === basename.length - 1) return "";
  return basename.slice(separator + 1).toLocaleLowerCase("en-US");
}

function ownValue<T>(mapping: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(mapping, key) ? mapping[key] : undefined;
}
