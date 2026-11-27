// Pairs the phone with a computer from a scanned pairing code: LAN origins
// first and then the Relay, one route at a time, so the single-use invite is
// spent at most once. docs/mobile.md ("Pairing") is the specification.
import {
  SessionRefused,
  type Hello,
  type SocketFactory,
} from "../session/session";
import type { Message } from "../i18n/messages";
import type { KeyPair } from "../session/noise";
import type { ManagedSession, OpenSession, Route } from "./connection";
import { relayNodesOf } from "./relay-nodes";
import { connectUrl, type PairingLink } from "./pairing-link";
import { computerPairingMessages as m } from "./pairing.messages";

export type PairingFailure =
  | "INVITE_INVALID"
  | "PAIRING_EXPIRED"
  | "RATE_LIMITED"
  | "BAD_HELLO"
  | "UNAVAILABLE"
  | "PHONE_REMOVED"
  | "PHONE_UNKNOWN"
  | "UNREACHABLE";

export class PairingError extends Error {
  constructor(readonly failure: PairingFailure) {
    super(`Pairing failed: ${failure}`);
    this.name = "PairingError";
  }
}

const KNOWN_FAILURES = new Set<string>([
  "INVITE_INVALID",
  "PAIRING_EXPIRED",
  "RATE_LIMITED",
  "BAD_HELLO",
  "UNAVAILABLE",
  "PHONE_REMOVED",
  "PHONE_UNKNOWN",
]);

/**
 * What the phone tells the Human for each way pairing can fail, translated
 * where it is shown.
 */
export function pairingFailureMessage(
  failure: PairingFailure,
): Message<string> {
  switch (failure) {
    case "INVITE_INVALID":
      return m.inviteInvalid;
    case "PAIRING_EXPIRED":
      return m.expired;
    case "RATE_LIMITED":
      return m.rateLimited;
    case "BAD_HELLO":
      return m.badHello;
    case "UNAVAILABLE":
      return m.unavailable;
    case "PHONE_REMOVED":
    case "PHONE_UNKNOWN":
      return m.notApproved;
    case "UNREACHABLE":
      return m.unreachable;
  }
}

export interface PairingResult<S> {
  readonly session: S;
  readonly route: Route;
}

export interface PairingInput<S> {
  readonly link: PairingLink;
  readonly staticKey: KeyPair;
  readonly deviceName: string;
  readonly platform: "ios" | "android";
  readonly socketFactory: SocketFactory;
  readonly open: OpenSession<S>;
  readonly signal?: AbortSignal;
}

/**
 * Runs the pairing handshake. Resolves with a session that is either
 * pending (show welcome.code) or already approved.
 */
export async function pairWithComputer<S extends ManagedSession>(
  input: PairingInput<S>,
): Promise<PairingResult<S>> {
  const dials: { route: Route; url: string }[] = [
    ...input.link.lan.map((origin) => ({
      route: "lan" as const,
      url: connectUrl(origin, input.link.hostId),
    })),
    ...relayNodesOf(input.link).map((node) => ({
      route: "relay" as const,
      url: connectUrl(node.url, input.link.hostId),
    })),
  ];
  const pair: Hello = {
    type: "pair",
    invite: input.link.invite,
    name: input.deviceName.slice(0, 100) || "Phone",
    platform: input.platform,
  };
  // A dial that failed without a refusal may have delivered the hello and
  // lost the reply; the computer then already spent the invite.
  let helloMayHaveArrived = false;
  let resumed = false;
  for (const dial of dials) {
    if (input.signal?.aborted) break;
    const open = (hello: Hello) =>
      input.open({
        url: dial.url,
        computerPublicKey: input.link.hostKey,
        staticKey: input.staticKey,
        hello,
        socketFactory: input.socketFactory,
        signal: input.signal,
      });
    try {
      return { session: await open(pair), route: dial.route };
    } catch (error) {
      if (!(error instanceof SessionRefused)) {
        helloMayHaveArrived = true;
        continue;
      }
      if (error.code === "INVITE_INVALID" && helloMayHaveArrived && !resumed) {
        resumed = true;
        try {
          return { session: await open({ type: "resume" }), route: dial.route };
        } catch (resumeError) {
          // The computer does not know this key either: the invite was
          // spent by someone else, not by the lost hello.
          if (resumeError instanceof SessionRefused)
            throw resumeError.code === "PHONE_UNKNOWN"
              ? new PairingError("INVITE_INVALID")
              : refusal(resumeError);
          continue;
        }
      }
      throw refusal(error);
    }
  }
  throw new PairingError("UNREACHABLE");
}

function refusal(error: SessionRefused): PairingError {
  return new PairingError(
    KNOWN_FAILURES.has(error.code)
      ? (error.code as PairingFailure)
      : "UNAVAILABLE",
  );
}
