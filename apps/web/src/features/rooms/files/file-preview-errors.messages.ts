import { defineMessages } from "@/i18n/messages";

/**
 * Why a File is not previewed, or its preview did not load. Chat rows read
 * the renderer policy too, so these stay apart from the preview surface's
 * own messages in `file-preview.messages.ts`.
 */
export const filePreviewErrorMessages = defineMessages("filePreview", {
  svgTooLarge: "This file is larger than the safe SVG preview limit.",
  pdfTooLarge: "This file is larger than the safe PDF preview limit.",
  officeTooLarge:
    "This file is larger than the {mebibytes} MiB basic Office preview limit.",
  imageTooLarge: "This image is larger than the safe preview limit.",
  textTooLarge: "This text file is larger than the safe preview limit.",
  markdownTooLarge: "This file is larger than the safe Markdown preview limit.",
  mermaidTooLarge: "This file is larger than the safe Mermaid preview limit.",
  htmlTooLarge: "This file is larger than the safe HTML preview limit.",
  downloadOnly: "This format is available as a download only.",
  mediaTypeMismatch: "This file can't be previewed. Download it instead.",
  versionNotInDocument: "This version can't be previewed here.",
  noUsableMediaType: "This file can't be previewed. Download it instead.",
  mediaTypeChanged: "This file changed while loading. Reload to preview it.",
  noUsableDigest: "This file can't be previewed. Download it instead.",
  digestMismatch: "This file changed while loading. Reload to preview it.",
});
