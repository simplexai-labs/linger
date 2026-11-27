// Message bodies as the browser builds them: an @ for each chosen member
// becomes a reference segment, and in a direct chat with an Agent every
// message leads with that Agent's @ so it is the Agent's to answer. The
// screen hides that leading @ again. Mirrors
// apps/web/src/features/rooms/chat/direct-room-message.ts.
import type { ActorRef, Message, MessageCreateRequest } from "../api/types";

type Segment = MessageCreateRequest["segments"][number];

export interface Mentionable {
  readonly id: string;
  readonly kind: ActorRef["kind"];
  readonly display_name: string;
}

export function mentionToken(actor: Pick<Mentionable, "display_name">): string {
  const name = actor.display_name.trim().replace(/^@+/, "");
  return `@${name.replace(/\s+/g, " ")}`;
}

function targetType(actor: Mentionable): "user" | "agent" {
  return actor.kind === "human" ? "user" : "agent";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Text and reference segments for the chosen members' tokens in `text`. */
export function messageSegments(
  text: string,
  mentions: readonly Mentionable[],
): Segment[] {
  if (!text) return [];
  const byToken = new Map<string, Mentionable>();
  for (const actor of mentions) byToken.set(mentionToken(actor), actor);
  const tokens = [...byToken.keys()].sort((a, b) => b.length - a.length);
  if (tokens.length === 0) return [{ type: "text", content: text }];
  const matcher = new RegExp(
    `(?:${tokens.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_-])`,
    "gu",
  );
  const segments: Segment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(matcher)) {
    const actor = byToken.get(match[0]);
    if (!actor) continue;
    if (match.index > cursor)
      segments.push({ type: "text", content: text.slice(cursor, match.index) });
    segments.push({
      type: "reference",
      content: match[0],
      target: actor.id,
      target_type: targetType(actor),
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length)
    segments.push({ type: "text", content: text.slice(cursor) });
  return segments;
}

/**
 * The raw text and segments to send. Only members still named in the text
 * count; a direct chat's Agent leads every message.
 */
export function composeMessage(input: {
  readonly text: string;
  readonly mentions: readonly Mentionable[];
  readonly directAgent?: Mentionable;
}): Pick<MessageCreateRequest, "raw_message" | "segments"> {
  const { text, directAgent } = input;
  const mentions = input.mentions.filter(
    (actor) => actor.id !== directAgent?.id,
  );
  if (!directAgent)
    return { raw_message: text, segments: messageSegments(text, mentions) };
  const token = mentionToken(directAgent);
  const raw = text ? `${token} ${text}` : token;
  return {
    raw_message: raw,
    segments: messageSegments(raw, [directAgent, ...mentions]),
  };
}

/** A Human's message in a direct Agent chat without its leading @. */
export function presentDirectMessage(
  message: Message,
  directAgentId: string | undefined,
): Message {
  if (!directAgentId || message.author.kind !== "human") return message;
  const [first, ...rest] = message.segments;
  if (
    first?.type !== "reference" ||
    first.target !== directAgentId ||
    first.target_type !== "agent"
  )
    return message;
  const segments = dropLeadingWhitespace(rest);
  const raw = segments.map((segment) => segment.content).join("");
  if (segments.length === 0 || !raw) return message;
  return { ...message, raw_message: raw, segments };
}

/** What a waiting message shows: its text without the direct chat's @. */
export function pendingText(
  body: Pick<MessageCreateRequest, "raw_message" | "segments">,
  directAgentId: string | undefined,
): string {
  const [first, ...rest] = body.segments;
  if (
    !directAgentId ||
    first?.type !== "reference" ||
    first.target !== directAgentId
  )
    return body.raw_message;
  return rest
    .map((segment) => segment.content)
    .join("")
    .trimStart();
}

function dropLeadingWhitespace(
  segments: Message["segments"],
): Message["segments"] {
  const first = segments[0];
  if (!first || first.type !== "text") return segments;
  const content = first.content.replace(/^\s+/, "");
  if (!content) return dropLeadingWhitespace(segments.slice(1));
  return [{ ...first, content }, ...segments.slice(1)];
}

/** The `@query` the caret sits in, or undefined. */
export function mentionQuery(
  text: string,
  caret: number,
): { readonly start: number; readonly query: string } | undefined {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const match = /(^|\s)@([\p{L}\p{N}_-]*)$/u.exec(before);
  if (!match) return undefined;
  const query = match[2] ?? "";
  return { start: before.length - query.length - 1, query };
}

/** Replaces the `@query` at `start` with the member's token and a space. */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  actor: Mentionable,
): { readonly text: string; readonly caret: number } {
  const token = `${mentionToken(actor)} `;
  const next = text.slice(0, start) + token + text.slice(caret);
  return { text: next, caret: start + token.length };
}
