// The pairing code a computer shows as a QR code:
// linger://pair?d=<base64url JSON>. docs/mobile.md defines the payload.
import { fromBase64Url } from "../lib/bytes";
import { hostIdOf } from "../session/noise";
import {
  normalizeOrigin,
  parseRelayNodes,
  type RelayNode,
} from "./relay-nodes";

export { normalizeOrigin };

export interface PairingLink {
  readonly computerName: string;
  readonly hostKey: Uint8Array;
  readonly hostId: string;
  readonly invite: string;
  readonly expiresAt: Date;
  /** The first node, from a computer that names only one. */
  readonly relay: string | null;
  /** Every node, from a computer that lists them; absent from older ones. */
  readonly relays?: readonly RelayNode[];
  readonly lan: readonly string[];
}

export type PairingLinkProblem =
  | "NOT_A_PAIRING_CODE"
  | "UNSUPPORTED_VERSION"
  | "EXPIRED";

export class PairingLinkError extends Error {
  constructor(readonly problem: PairingLinkProblem) {
    super(`Invalid pairing code: ${problem}`);
    this.name = "PairingLinkError";
  }
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Reads the `d` parameter of a pairing link, or returns undefined. */
export function pairingPayloadParameter(uri: string): string | undefined {
  const match = /^linger:\/\/pair\/?\?(.*)$/i.exec(uri.trim());
  if (!match) return undefined;
  for (const part of (match[1] ?? "").split("&")) {
    const [name, value] = part.split("=");
    if (name === "d" && value) return decodeURIComponent(value);
  }
  return undefined;
}

/** Parses and validates a pairing link or its bare `d` payload. */
export function parsePairingLink(
  input: string,
  now: Date = new Date(),
): PairingLink {
  const encoded = pairingPayloadParameter(input) ?? input.trim();
  if (!BASE64URL.test(encoded))
    throw new PairingLinkError("NOT_A_PAIRING_CODE");
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(fromBase64Url(encoded)),
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("not an object");
    payload = parsed as Record<string, unknown>;
  } catch {
    throw new PairingLinkError("NOT_A_PAIRING_CODE");
  }
  if (payload.v !== 1) {
    throw new PairingLinkError(
      typeof payload.v === "number"
        ? "UNSUPPORTED_VERSION"
        : "NOT_A_PAIRING_CODE",
    );
  }
  const {
    name,
    host_key: hostKeyText,
    invite,
    expires_at: expiresText,
  } = payload;
  if (
    typeof name !== "string" ||
    typeof hostKeyText !== "string" ||
    typeof invite !== "string" ||
    typeof expiresText !== "string" ||
    !BASE64URL.test(hostKeyText) ||
    !BASE64URL.test(invite)
  ) {
    throw new PairingLinkError("NOT_A_PAIRING_CODE");
  }
  let hostKey: Uint8Array;
  try {
    hostKey = fromBase64Url(hostKeyText);
  } catch {
    throw new PairingLinkError("NOT_A_PAIRING_CODE");
  }
  if (hostKey.length !== 32) throw new PairingLinkError("NOT_A_PAIRING_CODE");
  const expiresAt = new Date(expiresText);
  if (Number.isNaN(expiresAt.getTime()))
    throw new PairingLinkError("NOT_A_PAIRING_CODE");
  if (expiresAt.getTime() <= now.getTime())
    throw new PairingLinkError("EXPIRED");

  let relay: string | null = null;
  if (payload.relay !== null && payload.relay !== undefined) {
    const origin = normalizeOrigin(payload.relay);
    if (!origin) throw new PairingLinkError("NOT_A_PAIRING_CODE");
    relay = origin;
  }
  if (payload.lan !== undefined && !Array.isArray(payload.lan))
    throw new PairingLinkError("NOT_A_PAIRING_CODE");
  const lan = ((payload.lan as unknown[] | undefined) ?? [])
    .map(normalizeOrigin)
    .filter((origin): origin is string => origin !== undefined);
  const relays = parseRelayNodes(payload.relays);
  if (lan.length === 0 && relay === null && !relays?.length)
    throw new PairingLinkError("NOT_A_PAIRING_CODE");

  return {
    computerName: name.trim() || "Computer",
    hostKey,
    hostId: hostIdOf(hostKey),
    invite,
    expiresAt,
    relay: relay ?? relays?.[0]?.url ?? null,
    relays,
    lan: [...new Set(lan)],
  };
}

/** The WebSocket URL that reaches one computer through an origin. */
export function connectUrl(origin: string, hostId: string): string {
  return `${origin}/v1/connect/${hostId}`;
}
