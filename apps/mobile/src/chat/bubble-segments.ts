// Which of a Message's segments read as text in its bubble. As on the web,
// files and Document cards stand on their own: an attached file or card shows
// once, as its file card, never again as its name in the text. Meeting notes
// live with the meeting in the Library, so their title alone is left out.
import type { Message } from "../api/types";

type Segment = Message["segments"][number];

export function bubbleSegments(message: Message): Segment[] {
  const versions = new Set(
    message.attachments.map((item) => item.document_version_id),
  );
  const documents = new Set(
    message.attachments.map((item) => item.document_id),
  );
  return message.segments.filter((segment) => {
    if (segment.type === "file")
      return !versions.has(segment.document_version_id);
    if (segment.type === "document")
      return !(
        (segment.presentation === "card" ||
          segment.presentation === "canvas") &&
        documents.has(segment.document_id)
      );
    return segment.type !== "meeting_notes";
  });
}
