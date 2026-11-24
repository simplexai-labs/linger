// Pure helpers shared by network IM channels (Node Services) and local IM
// bridges (Desktop) for Markdown-to-plain-text formatting, grapheme-safe
// chunking, numbered question-card replies, and idempotency keys.

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+\s*)?$/;
const BULLET = /^(\s*)[*+-]\s+/;
const QUOTE = /^\s{0,3}>\s?/;
// Sentence ends, including fullwidth punctuation.
const SENTENCE_END = /[.!?\u3002\uff01\uff1f]\s/g;
const LINK = /!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const KEY_UNSAFE = /[^A-Za-z0-9._:-]/g;

export interface ChannelPlainTextOptions {
  /** When false, omit raw URLs from Markdown links (for channels whose links are not clickable). */
  readonly includeLinkUrls?: boolean;
}

function stripEmphasis(text: string): string {
  return text
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1")
    .replace(/__(?=\S)(.+?)(?<=\S)__/g, "$1")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
    .replace(/(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])/g, "$1");
}

function formatInline(line: string, includeLinkUrls: boolean): string {
  return line
    .split(/(`+)([^`]+?)\1/)
    .map((part, index) => {
      if (index % 3 === 1) return "";
      if (index % 3 === 2) return part;
      return stripEmphasis(
        part.replace(LINK, (_match, label: string, url: string) => {
          if (!label || label === url) return url;
          return includeLinkUrls ? `${label} (${url})` : label;
        }),
      );
    })
    .join("");
}

/** Strips Markdown markers while preserving readable wording, code, and links. */
export function channelPlainText(
  markdown: string,
  options: ChannelPlainTextOptions = {},
): string {
  const includeLinkUrls = options.includeLinkUrls ?? true;
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const opener = FENCE.exec(line)?.[1];
    if (fence) {
      if (opener && opener[0] === fence[0] && opener.length >= fence.length) {
        fence = undefined;
      } else {
        out.push(line);
      }
      continue;
    }
    if (opener) {
      fence = opener;
      continue;
    }
    const heading = HEADING.exec(line);
    let text = heading ? heading[1]! : line.replace(QUOTE, "");
    text = text.replace(BULLET, "$1- ");
    out.push(formatInline(text, includeLinkUrls));
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemeCut(text: string, maxChars: number): number {
  let cut = 0;
  for (const { index } of segmenter.segment(text.slice(0, maxChars + 1))) {
    if (index > maxChars) break;
    cut = index;
  }
  return cut > 0 ? cut : maxChars;
}

function findBoundary(window: string): number {
  const half = Math.floor(window.length / 2);
  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph >= half) return paragraph;
  const line = window.lastIndexOf("\n");
  if (line >= half) return line;
  let sentence = -1;
  for (const match of window.matchAll(SENTENCE_END)) sentence = match.index;
  if (sentence >= half) return sentence + 1;
  const space = window.lastIndexOf(" ");
  if (space >= half) return space;
  return -1;
}

/** Splits plain text into chunks of at most `maxChars` UTF-16 units without breaking graphemes. */
export function channelChunks(text: string, maxChars: number): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = findBoundary(rest.slice(0, limit));
    if (cut <= 0) cut = graphemeCut(rest, limit);
    const chunk = rest.slice(0, cut).trim();
    if (chunk) chunks.push(chunk);
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Converts Markdown to plain text and splits it to fit the channel limit. */
export function channelText(
  markdown: string,
  maxChars: number,
  options?: ChannelPlainTextOptions,
): string[] {
  return channelChunks(channelPlainText(markdown, options), maxChars);
}

/** Parses 1-based numbered replies ("2" for radio, "1,3" for checkbox). */
export function parseNumberedAnswer(
  text: string,
  input: "radio" | "checkbox",
  optionCount: number,
): number[] | undefined {
  if (optionCount < 1) return undefined;
  const trimmed = text.trim();
  const grammar = input === "radio" ? /^\d+$/ : /^\d+(\s*,\s*\d+)*$/;
  if (!grammar.test(trimmed)) return undefined;
  const numbers = trimmed.split(",").map((part) => Number(part.trim()));
  if (numbers.some((n) => n < 1 || n > optionCount)) return undefined;
  if (new Set(numbers).size !== numbers.length) return undefined;
  return numbers;
}

export interface QuestionCardOption {
  readonly id: string;
  readonly label: string;
}

export interface QuestionCardItem {
  readonly id: string;
  readonly prompt: string;
  readonly input: string;
  readonly options?: readonly QuestionCardOption[];
}

export interface DecisionCardLike {
  readonly kind?: string;
  readonly status?: string;
  readonly title?: string;
  readonly decision_id?: string;
  readonly version?: number;
  readonly decision_owner?: { readonly id?: string };
  readonly question?: { readonly questions?: readonly QuestionCardItem[] };
}

export interface FormattedQuestionCard {
  readonly text: string;
  readonly decisionId: string;
  readonly version: number;
  readonly questionId: string;
  readonly input: "radio" | "checkbox";
  readonly optionIds: readonly string[];
}

export interface QuestionCardHints {
  readonly replyWithNumber: string;
  readonly replyWithNumbers: string;
}

const DEFAULT_QUESTION_HINTS: QuestionCardHints = {
  replyWithNumber: "Reply with a number.",
  replyWithNumbers: "Reply with numbers, e.g. 1,3.",
};

/**
 * Formats a single-question radio/checkbox Decision Card for plain-text IM
 * reply. Other card kinds stay in Linger because IM cannot safely carry
 * irreversible approvals or credentials.
 */
export function formatQuestionCard(
  card: DecisionCardLike,
  humanActorId: string | undefined,
  hints: QuestionCardHints = DEFAULT_QUESTION_HINTS,
): FormattedQuestionCard | undefined {
  if (card.kind !== "question" || card.status !== "pending") return undefined;
  if (!humanActorId || card.decision_owner?.id !== humanActorId) {
    return undefined;
  }
  if (!card.decision_id || typeof card.version !== "number" || !card.title) {
    return undefined;
  }
  const questions = card.question?.questions;
  if (questions?.length !== 1) return undefined;
  const question = questions[0]!;
  if (question.input !== "radio" && question.input !== "checkbox") {
    return undefined;
  }
  const options = question.options ?? [];
  if (options.length === 0) return undefined;

  const lines = [card.title];
  if (question.prompt.trim() && question.prompt.trim() !== card.title.trim()) {
    lines.push(question.prompt);
  }
  options.forEach((option, index) => {
    lines.push(`${String(index + 1)}. ${option.label}`);
  });
  lines.push(
    question.input === "radio" ? hints.replyWithNumber : hints.replyWithNumbers,
  );
  return {
    text: lines.join("\n"),
    decisionId: card.decision_id,
    version: card.version,
    questionId: question.id,
    input: question.input,
    optionIds: options.map((option) => option.id),
  };
}

/** Builds a valid TeamHub IdempotencyKey (8..128 chars) for an inbound IM message. */
export function channelIdempotencyKey(
  provider: string,
  externalId: string,
): string {
  const safeProvider =
    provider.replace(KEY_UNSAFE, "-").replace(/^[^A-Za-z0-9]+/, "") || "im";
  const safeId = externalId.replace(KEY_UNSAFE, "-") || "msg";
  const key = `im:${safeProvider}:${safeId}`;
  return (key.length < 8 ? key.padEnd(8, "0") : key).slice(0, 128);
}

/** Redacts an external IM handle or user identifier for safe display and logs. */
export function maskExternalId(id: string): string {
  const trimmed = id.trim();
  if (trimmed.length <= 4) return "***";
  return `***${trimmed.slice(-4)}`;
}
