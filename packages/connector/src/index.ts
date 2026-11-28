/**
 * A Connector is the seam between a chat surface and a Room.
 *
 * It owns four verbs and no policy: authenticate, receive, send, and say what
 * the surface can do. It deliberately does not know what a Room, a Run or an
 * Actor is. A Connector returns events; the collaboration layer decides that an
 * event becomes a Message attributed to the human, and therefore that a turn
 * runs.
 *
 * That separation is the whole point. Relaying an inbound message into the
 * Agent's own conversation looks correct and does nothing: an Agent's own
 * message is output, not input, so no turn starts and the human sees their
 * words echoed back. Only the collaboration layer can write a Message whose
 * author is the human, and that author is what makes the Agent run.
 */

/** What a surface can render, so a sender never degrades content it did not have to. */
export interface Capabilities {
  /** The surface renders Markdown in message text. */
  markdown: boolean;
  /** The largest single text item, in characters. */
  maxTextLength: number;
  /** The surface accepts images. */
  images: boolean;
  /** The surface accepts arbitrary file attachments. */
  files: boolean;
  /** The surface delivers group conversation, not only direct messages. */
  groups: boolean;
  /** The surface can reference an earlier message from a reply. */
  replies: boolean;
}

/** One person's message on the surface, as the Connector read it. */
export interface InboundMessage {
  /** Stable identifier on the surface. Re-delivery of the same value is one event. */
  externalId: string;
  /** The surface's identifier for the sender, and for the conversation it arrived in. */
  peerId: string;
  conversationId: string;
  text: string;
  /** Milliseconds since the epoch, as the surface reports it. */
  sentAt: number;
  /** An opaque credential the surface needs to answer this peer right now. */
  replyToken?: string;
  /** An image or file the surface will hand over on request. */
  media?: InboundMedia[];
}

export interface InboundMedia {
  externalId: string;
  kind: "image" | "file";
  filename?: string;
}

/**
 * A unit of work the Connector hands to its host.
 *
 * `message` is the only kind today. A Connector that later receives a reaction
 * or an edit adds a kind here rather than smuggling it through message text.
 */
export interface InboundEvent {
  kind: "message";
  message: InboundMessage;
}

export interface OutboundText {
  kind: "text";
  text: string;
  /** Answer this inbound message, where the surface supports it. */
  replyTo?: string;
}

export interface OutboundMedia {
  kind: "image" | "file";
  /** Local path the host may read; the Connector uploads it. */
  path: string;
  caption?: string;
}

export type Outbound = OutboundText | OutboundMedia;

/** The result of one outbound attempt, so the host never assumes delivery. */
export interface SendResult {
  delivered: boolean;
  /** Why it did not deliver, when `delivered` is false. Retryable or not is the host's call. */
  reason?:
    | "session-stale"
    | "blocked"
    | "too-large"
    | "unsupported"
    | "unknown";
  /** The surface's message identifier, when it delivered. */
  externalId?: string;
  detail?: string;
}

/**
 * One thing to send, and to whom.
 *
 * The peer is part of the request because a Connector sends *to* a
 * conversation: it holds no ambient "current user", and the reply token that
 * keeps a thread together belongs to the message being answered, not to the
 * Connector.
 */
export interface SendRequest {
  /** The conversation's peer, as `InboundMessage.peerId` reported it. */
  peerId: string;
  item: Outbound;
  /** The `externalId` this answers, for a host that logs a thread. */
  replyTo?: string;
  /** The token the answered message carried, where the surface issues one. */
  replyToken?: string;
}

export interface Connector {
  /** A stable name for logs and for the host's per-surface state, e.g. `ilink`. */
  readonly name: string;

  /** Establish or restore credentials. Idempotent. */
  authenticate(): Promise<void>;

  /** What this surface can render, so the host formats once and correctly. */
  describeCapabilities(): Capabilities;

  /**
   * Read events that arrived since the last call.
   *
   * The host calls this on whatever cadence it likes; a webhook Connector
   * resolves this from a queue the webhook fills. Returning an empty array is
   * normal and must not be an error.
   */
  poll(): Promise<InboundEvent[]>;

  /** Send one outbound item. A `false` result is a fact, not an exception. */
  send(request: SendRequest): Promise<SendResult>;
}

/**
 * Removes events the host has already handled.
 *
 * Surfaces re-deliver. iLink replays an unacknowledged message, and a poll that
 * overlapped a restart replays its whole window. The host must deduplicate by
 * `externalId`, not by text, because a person really does send "1" twice.
 */
export function createSeen(
  externalIds: Iterable<string>,
  ttlMs: number,
  now = Date.now,
) {
  const seen = new Map<string, number>();
  for (const id of externalIds) seen.set(id, now());
  return function firstSighting(id: string): boolean {
    const at = seen.get(id);
    const current = now();
    if (at !== undefined && current - at < ttlMs) return false;
    seen.set(id, current);
    for (const [key, when] of seen)
      if (current - when >= ttlMs) seen.delete(key);
    return true;
  };
}
