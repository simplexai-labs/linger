// Plaintext frames inside a session: u8 type | u32 stream (big endian) |
// payload. docs/mobile.md is the specification.
export const FrameType = {
  request: 1,
  data: 2,
  end: 3,
  response: 4,
  reset: 5,
  socket: 6,
  text: 7,
  control: 8,
  window: 9,
} as const;

export type FrameKind = (typeof FrameType)[keyof typeof FrameType];

export interface Frame {
  readonly kind: FrameKind;
  readonly stream: number;
  readonly payload: Uint8Array;
}

export const CONTROL_STREAM = 0;
export const DATA_CHUNK = 60 * 1024;
export const STREAM_WINDOW = 256 * 1024;
const HEADER = 5;
const MAX_PAYLOAD = 65535 - 16 - HEADER;

export function encodeFrame(
  kind: FrameKind,
  stream: number,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  if (payload.length > MAX_PAYLOAD)
    throw new Error(`frame payload of ${payload.length} bytes is too large`);
  const out = new Uint8Array(HEADER + payload.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, stream >>> 0, false);
  out.set(payload, HEADER);
  return out;
}

export function decodeFrame(raw: Uint8Array): Frame {
  if (raw.length < HEADER) throw new Error("malformed frame");
  const kind = raw[0] as FrameKind;
  if (kind < FrameType.request || kind > FrameType.window)
    throw new Error("malformed frame");
  const stream = new DataView(
    raw.buffer,
    raw.byteOffset,
    raw.byteLength,
  ).getUint32(1, false);
  return { kind, stream, payload: raw.subarray(HEADER) };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(decoder.decode(bytes));
}

export function utf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}
