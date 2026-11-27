import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";

import { selectArtifactRenderer } from "./files/artifact-renderer-policy";
import type { OpenPanelTabInput } from "./room-connectivity";

/**
 * Selects the side-panel file tab to auto-open when a live message arrives in
 * an open Room. Canvas segments keep priority for any author; otherwise only
 * ordinary Agent conversation messages auto-open their first previewable file,
 * delivered Document card, or artifact tree entry.
 */
export function selectAutoOpenMessageFile(
  message: TeamHubMessage,
): OpenPanelTabInput | null {
  for (const segment of message.segments) {
    if (segment.type === "document" && segment.presentation === "canvas") {
      return {
        kind: "file",
        documentId: segment.document_id,
        title: segment.content,
      };
    }
  }

  if (
    message.author.kind !== "agent" ||
    message.message_kind !== "conversation" ||
    message.card ||
    // Voice recording completion posts meeting_notes alongside audio/transcript
    // document cards; keep those messages quiet instead of popping open audio.
    message.segments.some((segment) => segment.type === "meeting_notes")
  ) {
    return null;
  }

  const attachmentsByVersion = new Map<
    string,
    TeamHubMessage["attachments"][number]
  >();
  const attachmentsByDocument = new Map<
    string,
    TeamHubMessage["attachments"][number]
  >();
  for (const attachment of message.attachments ?? []) {
    if (!attachmentsByVersion.has(attachment.document_version_id)) {
      attachmentsByVersion.set(attachment.document_version_id, attachment);
    }
    if (!attachmentsByDocument.has(attachment.document_id)) {
      attachmentsByDocument.set(attachment.document_id, attachment);
    }
  }

  // Only inspect explicit message segments; inline html_fragment cards also
  // carry a backing HTML attachment and must stay inline in chat.
  for (const segment of message.segments) {
    if (segment.type === "document" && segment.presentation === "card") {
      const attachment = attachmentsByDocument.get(segment.document_id);
      if (attachment) {
        if (attachment.available === false) {
          continue;
        }
        const decision = selectArtifactRenderer({
          filename: attachment.filename,
          mediaType: attachment.media_type,
          sizeBytes: attachment.size_bytes,
        });
        if (decision.kind === "download") {
          continue;
        }
      }
      return {
        kind: "file",
        documentId: segment.document_id,
        title: segment.content,
      };
    }

    if (segment.type === "file") {
      const attachment =
        attachmentsByVersion.get(segment.document_version_id) ??
        attachmentsByDocument.get(segment.document_id);
      if (attachment?.available === false) {
        continue;
      }
      const filename =
        segment.filename ?? attachment?.filename ?? segment.content;
      const mediaType = segment.media_type ?? attachment?.media_type ?? "";
      const sizeBytes = attachment?.size_bytes ?? 0;
      const decision = selectArtifactRenderer({
        filename,
        mediaType,
        sizeBytes,
      });
      if (decision.kind !== "download") {
        return {
          kind: "file",
          documentId: segment.document_id,
          title: filename,
          previewCurrentVersion: true,
        };
      }
      continue;
    }

    if (
      segment.type === "artifact_tree" &&
      segment.entry_document_id &&
      segment.entry_document_version_id
    ) {
      return {
        kind: "file",
        documentId: segment.entry_document_id,
        title: segment.root_path,
        versionId: segment.entry_document_version_id,
      };
    }
  }

  return null;
}
