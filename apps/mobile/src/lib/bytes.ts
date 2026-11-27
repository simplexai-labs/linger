// Byte helpers that do not depend on Node's Buffer, which React Native lacks.
const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const REVERSE = new Map<string, number>(
  [...ALPHABET].map((char, index) => [char, index]),
);

/** Standard base64 with padding, as data URIs expect. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    out += ALPHABET[(triple >> 18) & 63];
    out += ALPHABET[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? ALPHABET[(triple >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? ALPHABET[triple & 63] : "=";
  }
  return out;
}

/** Unpadded base64url, the encoding the pairing code and keys use. */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decodes base64 or base64url, padded or not; throws on any other input. */
export function fromBase64Url(text: string): Uint8Array {
  const normalized = text
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/=+$/, "");
  if (normalized.length % 4 === 1) throw new Error("invalid base64");
  const out = new Uint8Array(Math.floor((normalized.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of normalized) {
    const value = REVERSE.get(char);
    if (value === undefined) throw new Error("invalid base64");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index] = (buffer >> bits) & 0xff;
      index += 1;
    }
  }
  return out;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** A random identifier for idempotency keys and multipart boundaries. */
export function randomId(): string {
  return Array.from(randomBytes(16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
