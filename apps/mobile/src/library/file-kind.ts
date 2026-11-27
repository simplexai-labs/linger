// What a file is and where it opens. The kinds and labels follow the web
// (apps/web/src/features/rooms/files/artifact-file-kind.ts) so a file looks
// the same on both. The phone opens every type the desktop previews inside
// the app: text, Markdown, images, audio and video natively, and the rest in
// the offline viewer page (file-viewer.tsx). Only what the desktop cannot
// preview either goes to the system viewer.
import type { Translate } from "../i18n/language";
import type { Message } from "../i18n/messages";
import { fileKindMessages as m } from "./file-kind.messages";
import type { WebKind } from "./file-viewer";

export type FileKind =
  | "archive"
  | "audio"
  | "code"
  | "document"
  | "html"
  | "image"
  | "markdown"
  | "pdf"
  | "presentation"
  | "spreadsheet"
  | "text"
  | "video";

const byExtension: Record<string, FileKind> = {};
function add(kind: FileKind, extensions: string) {
  for (const extension of extensions.split(" ")) byExtension[extension] = kind;
}
add("archive", "7z bz2 gz gzip rar tar xz zip");
add("audio", "aac flac m4a mp3 ogg opus wav");
add(
  "code",
  "c cpp css go h hpp java js json jsx less mermaid mmd py rs scss sh sql toml ts tsx xml yaml yml",
);
add("image", "avif bmp gif heic heif ico jpeg jpg png svg webp");
add("spreadsheet", "csv ods tsv xls xlsx");
add("video", "avi m4v mkv mov mp4 webm");
add("pdf", "pdf");
add("document", "doc docx pages rtf odt");
add("presentation", "ppt pptx key odp");
add("markdown", "md markdown");
add("html", "htm html");
add("text", "log txt");

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

function kindFromMediaType(mediaType: string): FileKind | undefined {
  const type = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type === "application/pdf") return "pdf";
  if (type === "text/markdown" || type === "text/x-markdown") return "markdown";
  if (type === "text/html") return "html";
  if (type === "text/csv") return "spreadsheet";
  if (type === "text/plain") return "text";
  if (type === "application/json" || type.endsWith("+json")) return "code";
  if (type.startsWith("text/")) return "code";
  return undefined;
}

export function fileKind(filename: string, mediaType = ""): FileKind {
  return (
    byExtension[extensionOf(filename)] ??
    kindFromMediaType(mediaType) ??
    "document"
  );
}

const labels: Record<FileKind, Message | string> = {
  archive: m.archive,
  audio: m.audio,
  code: m.code,
  document: m.document,
  html: "HTML",
  image: m.image,
  markdown: "Markdown",
  pdf: "PDF",
  presentation: m.presentation,
  spreadsheet: m.spreadsheet,
  text: m.text,
  video: m.video,
};

export function fileTypeLabel(
  t: Translate,
  filename: string,
  mediaType = "",
): string {
  const extension = extensionOf(filename);
  if (extension === "doc" || extension === "docx") return "Word";
  if (extension === "ppt" || extension === "pptx") return "PowerPoint";
  if (extension === "xls" || extension === "xlsx") return "Excel";
  if (extension === "csv" || extension === "tsv") return "CSV";
  const label = labels[fileKind(filename, mediaType)];
  return typeof label === "string" ? label : t(label);
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The desktop's preview limit, which the phone shares. */
export const MAX_VIEW_BYTES = 50 * 1024 * 1024;
/** Text past this renders in the viewer page, not as native text. */
const MAX_NATIVE_TEXT_BYTES = 2 * 1024 * 1024;
/** Images past this decode in the viewer page, not natively. */
const MAX_NATIVE_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Where a file opens: drawn natively as a page or an image, played natively
 * as audio or video, rendered by the viewer page, or, for what the desktop
 * cannot preview either, handed to the system viewer.
 */
export type Viewer =
  | "page"
  | "image"
  | "audio"
  | "video"
  | { readonly web: WebKind }
  | "system";

function webKind(filename: string, mediaType: string): WebKind | undefined {
  const extension = extensionOf(filename);
  switch (fileKind(filename, mediaType)) {
    case "pdf":
      return "pdf";
    case "document":
    case "presentation":
      return /^(docx?|pptx?)$/.test(extension) ? "office" : undefined;
    case "spreadsheet":
      if (extension === "csv") return "csv";
      if (extension === "tsv") return "tsv";
      return /^xlsx?$/.test(extension) ? "office" : undefined;
    case "html":
      return "html";
    case "image":
      return /^(heic|heif|ico)$/.test(extension) ? undefined : "image";
    case "video":
      // AVPlayer and ExoPlayer do not both read WebM; the WebView does.
      return extension === "webm" ? "video" : undefined;
    case "markdown":
    case "text":
    case "code":
      return /^(mmd|mermaid)$/.test(extension) ? "mermaid" : "text";
    default:
      return undefined;
  }
}

/** size, when known, moves a large text or image into the viewer page. */
export function viewerFor(
  filename: string,
  mediaType = "",
  size?: number,
): Viewer {
  const kind = fileKind(filename, mediaType);
  const extension = extensionOf(filename);
  if (size !== undefined && size > MAX_VIEW_BYTES)
    return kind === "audio" ? "audio" : "system";
  if (kind === "audio") return "audio";
  if (kind === "video" && /^(mp4|m4v|mov)$/.test(extension)) return "video";
  if (
    (kind === "markdown" || kind === "text" || kind === "code") &&
    !/^(mmd|mermaid)$/.test(extension) &&
    (size === undefined || size <= MAX_NATIVE_TEXT_BYTES)
  )
    return "page";
  if (
    kind === "image" &&
    /^(png|jpe?g|gif|webp)$/.test(extension) &&
    (size === undefined || size <= MAX_NATIVE_IMAGE_BYTES)
  )
    return "image";
  const web = webKind(filename, mediaType);
  return web ? { web } : "system";
}
