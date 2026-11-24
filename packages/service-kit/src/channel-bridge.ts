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
  readonly runtime_permission?: {
    readonly title?: string;
    readonly rationale?: string;
    readonly tool?: string;
  };
  readonly connector_write?: {
    readonly title?: string;
    readonly summary?: string;
    readonly app_name?: string;
  };
  readonly agent_change?: {
    readonly action?: string;
    readonly agent_name?: string;
  };
  readonly room_creation?: {
    readonly name?: string;
    readonly description?: string;
  };
}

export interface PendingQuestionStep {
  readonly id: string;
  readonly prompt: string;
  readonly input: "radio" | "checkbox";
  readonly options: readonly QuestionCardOption[];
}

export interface PendingQuestionCardState {
  readonly kind: "question";
  readonly decisionId: string;
  readonly version: number;
  readonly title: string;
  readonly questions: readonly PendingQuestionStep[];
  readonly currentIndex: number;
  readonly answers: Readonly<Record<string, string | readonly string[]>>;
}

export interface PendingApprovalCardState {
  readonly kind: "approval";
  readonly decisionId: string;
  readonly version: number;
  readonly title: string;
  readonly decisionKind: string;
}

export type PendingCardState =
  | PendingQuestionCardState
  | PendingApprovalCardState;

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

export interface CardFormattingHints {
  readonly replyRadioOrOther: string;
  readonly replyCheckboxOrOther: string;
  readonly approveOption: string;
  readonly denyOption: string;
  readonly replyApproveOrDeny: string;
  readonly openLingerToReview: (title: string, url?: string) => string;
}

const DEFAULT_QUESTION_HINTS: QuestionCardHints = {
  replyWithNumber: "Reply with a number.",
  replyWithNumbers: "Reply with numbers, e.g. 1,3.",
};

const DEFAULT_CARD_HINTS: CardFormattingHints = {
  replyRadioOrOther: "Reply with a number, or type your own answer.",
  replyCheckboxOrOther:
    "Reply with numbers (e.g. 1,3), or type your own answer.",
  approveOption: "Approve",
  denyOption: "Deny",
  replyApproveOrDeny: "Reply 1 to approve or 2 to deny.",
  openLingerToReview: (title, url) =>
    url ? `${title} — open Linger: ${url}` : `Open Linger to review: ${title}`,
};

const APPROVAL_CARD_KINDS = new Set([
  "runtime_permission",
  "connector_write",
  "agent_change",
  "room_creation",
]);

/** Returns true when a URL points to a reachable non-loopback host for mobile links. */
export function isReachableExternalUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl?.trim()) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return (
      host !== "localhost" &&
      host !== "127.0.0.1" &&
      host !== "::1" &&
      host !== "[::1]" &&
      !host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

/**
 * Returns true when a card Message's raw_message is only TeamHub's generated
 * mention + title placeholder so IM bridges avoid sending a duplicate line.
 */
export function isCardPlaceholderMessage(
  rawMessage: string | undefined,
  card: DecisionCardLike | undefined,
): boolean {
  if (!card?.title?.trim()) return false;
  const trimmed = (rawMessage ?? "").trim();
  if (!trimmed) return true;
  const withoutLeadingMention = trimmed.replace(/^@\S+\s+/, "").trim();
  const title = card.title.trim();
  return (
    withoutLeadingMention === title ||
    withoutLeadingMention === `Approval needed: ${title}`
  );
}

/** Formats the active question step of a single- or multi-question card. */
export function formatQuestionStep(
  state: PendingQuestionCardState,
  hints: Partial<CardFormattingHints> = {},
): string {
  const h = { ...DEFAULT_CARD_HINTS, ...hints };
  const question = state.questions[state.currentIndex];
  if (!question) return "";
  const total = state.questions.length;
  const header =
    total > 1
      ? `${state.title} (${String(state.currentIndex + 1)}/${String(total)})`
      : state.title;
  const lines = [header];
  if (question.prompt.trim() && question.prompt.trim() !== state.title.trim()) {
    lines.push(question.prompt.trim());
  }
  question.options.forEach((option, index) => {
    lines.push(`${String(index + 1)}. ${option.label}`);
  });
  lines.push(
    question.input === "radio" ? h.replyRadioOrOther : h.replyCheckboxOrOther,
  );
  return lines.join("\n");
}

/**
 * Formats a pending Decision Card that can be answered over plain-text IM:
 * - question cards (1..N radio/checkbox questions, including custom "Other" text)
 * - approval cards (runtime_permission, connector_write, agent_change, room_creation)
 * Cards needing OAuth, API keys, browser pairing, or macOS permissions return undefined.
 */
export function formatPendingCard(
  card: DecisionCardLike,
  humanActorId: string | undefined,
  hints: Partial<CardFormattingHints> = {},
): { readonly state: PendingCardState; readonly text: string } | undefined {
  if (card.status !== "pending") return undefined;
  if (!humanActorId || card.decision_owner?.id !== humanActorId) {
    return undefined;
  }
  if (!card.decision_id || typeof card.version !== "number" || !card.title) {
    return undefined;
  }
  const h = { ...DEFAULT_CARD_HINTS, ...hints };

  if (card.kind === "question") {
    const rawQuestions = card.question?.questions ?? [];
    if (rawQuestions.length === 0) return undefined;
    const steps: PendingQuestionStep[] = [];
    for (const q of rawQuestions) {
      if (q.input !== "radio" && q.input !== "checkbox") return undefined;
      const options = q.options ?? [];
      if (options.length === 0) return undefined;
      steps.push({
        id: q.id,
        prompt: q.prompt,
        input: q.input,
        options: options.map((opt) => ({ id: opt.id, label: opt.label })),
      });
    }
    const state: PendingQuestionCardState = {
      kind: "question",
      decisionId: card.decision_id,
      version: card.version,
      title: card.title,
      questions: steps,
      currentIndex: 0,
      answers: {},
    };
    return { state, text: formatQuestionStep(state, h) };
  }

  if (card.kind && APPROVAL_CARD_KINDS.has(card.kind)) {
    const lines = [card.title];
    const detail = approvalCardDetail(card);
    if (detail) lines.push(detail);
    lines.push(`1. ${h.approveOption}`);
    lines.push(`2. ${h.denyOption}`);
    lines.push(h.replyApproveOrDeny);
    const state: PendingApprovalCardState = {
      kind: "approval",
      decisionId: card.decision_id,
      version: card.version,
      title: card.title,
      decisionKind: card.kind,
    };
    return { state, text: lines.join("\n") };
  }

  return undefined;
}

function approvalCardDetail(card: DecisionCardLike): string | undefined {
  if (card.kind === "runtime_permission" && card.runtime_permission) {
    const parts = [
      card.runtime_permission.rationale?.trim(),
      card.runtime_permission.tool?.trim()
        ? `Tool: ${card.runtime_permission.tool.trim()}`
        : undefined,
    ].filter((part): part is string => Boolean(part));
    return parts.join("\n") || undefined;
  }
  if (card.kind === "connector_write" && card.connector_write) {
    const summary = card.connector_write.summary?.trim();
    if (summary && summary !== card.title?.trim()) return summary;
  }
  if (
    card.kind === "room_creation" &&
    card.room_creation?.description?.trim()
  ) {
    return card.room_creation.description.trim();
  }
  return undefined;
}

/** Formats a safe fallback notice for cards that must be completed in Linger. */
export function formatUnsupportedCardNotice(
  card: DecisionCardLike,
  chatUrl: string | undefined,
  hints: Partial<CardFormattingHints> = {},
): string | undefined {
  if (card.status !== "pending" || !card.title?.trim()) return undefined;
  const h = { ...DEFAULT_CARD_HINTS, ...hints };
  const safeUrl = isReachableExternalUrl(chatUrl) ? chatUrl : undefined;
  return h.openLingerToReview(card.title.trim(), safeUrl);
}

export type PendingCardAdvanceResult =
  | {
      readonly action: "next_question";
      readonly nextState: PendingQuestionCardState;
      readonly nextPrompt: string;
    }
  | {
      readonly action: "submit_question";
      readonly decisionId: string;
      readonly version: number;
      readonly answers: Readonly<Record<string, string | readonly string[]>>;
    }
  | {
      readonly action: "decide_approval";
      readonly decisionId: string;
      readonly version: number;
      readonly decision: "approve" | "deny";
    }
  | { readonly action: "passthrough" };

/**
 * Interprets a user's plain-text IM reply against the active pending card:
 * - question cards accept 1-based option numbers or custom free text ("Other")
 * - multi-question cards advance one question at a time before submitting all answers
 * - approval cards accept 1 (approve) or 2 (deny); any other text passes through as chat
 */
export function advancePendingCard(
  state: PendingCardState,
  rawText: string,
  hints: Partial<CardFormattingHints> = {},
): PendingCardAdvanceResult {
  const trimmed = rawText.trim();
  if (!trimmed) return { action: "passthrough" };

  if (state.kind === "approval") {
    if (trimmed === "1") {
      return {
        action: "decide_approval",
        decisionId: state.decisionId,
        version: state.version,
        decision: "approve",
      };
    }
    if (trimmed === "2") {
      return {
        action: "decide_approval",
        decisionId: state.decisionId,
        version: state.version,
        decision: "deny",
      };
    }
    return { action: "passthrough" };
  }

  const current = state.questions[state.currentIndex];
  if (!current) return { action: "passthrough" };

  const picks = parseNumberedAnswer(
    trimmed,
    current.input,
    current.options.length,
  );
  let answerValue: string | readonly string[];
  if (picks) {
    answerValue =
      current.input === "radio"
        ? current.options[picks[0]! - 1]!.id
        : picks.map((n) => current.options[n - 1]!.id);
  } else {
    // Free-text "Other..." response accepted by TeamHub for every question card.
    answerValue =
      current.input === "radio"
        ? trimmed.slice(0, 10_000)
        : [trimmed.slice(0, 200)];
  }

  const nextAnswers: Record<string, string | readonly string[]> = {
    ...state.answers,
    [current.id]: answerValue,
  };
  const nextIndex = state.currentIndex + 1;
  if (nextIndex < state.questions.length) {
    const nextState: PendingQuestionCardState = {
      ...state,
      currentIndex: nextIndex,
      answers: nextAnswers,
    };
    return {
      action: "next_question",
      nextState,
      nextPrompt: formatQuestionStep(nextState, hints),
    };
  }
  return {
    action: "submit_question",
    decisionId: state.decisionId,
    version: state.version,
    answers: nextAnswers,
  };
}

/**
 * Formats a single-question radio/checkbox Decision Card for plain-text IM
 * reply. Retained for compatibility; prefer formatPendingCard for full support.
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
