// multipart/form-data bodies built as bytes: the session carries raw bodies,
// so there is no FormData serializer to lean on.
import { concat } from "../session/noise";
import { randomId } from "../lib/bytes";

export interface MultipartField {
  readonly name: string;
  readonly value: string | Uint8Array;
  /** Present for file parts. */
  readonly filename?: string;
  readonly contentType?: string;
}

export interface MultipartBody {
  readonly contentType: string;
  readonly body: Uint8Array;
}

const encoder = new TextEncoder();

/** Quotes a header parameter the way browsers do for form-data names. */
function quoted(value: string): string {
  return `"${value.replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/"/g, "%22")}"`;
}

export function buildMultipart(
  fields: readonly MultipartField[],
  boundary = `linger-${randomId()}`,
): MultipartBody {
  const parts: Uint8Array[] = [];
  for (const field of fields) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name=${quoted(field.name)}`;
    if (field.filename !== undefined)
      head += `; filename=${quoted(field.filename)}`;
    head += "\r\n";
    if (field.contentType) head += `Content-Type: ${field.contentType}\r\n`;
    head += "\r\n";
    parts.push(encoder.encode(head));
    parts.push(
      typeof field.value === "string"
        ? encoder.encode(field.value)
        : field.value,
    );
    parts.push(encoder.encode("\r\n"));
  }
  parts.push(encoder.encode(`--${boundary}--\r\n`));
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: concat(...parts),
  };
}
