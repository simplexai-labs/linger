import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { z } from "zod";

const chatTarget = z.union([
  z.object({ chatId: z.number().int() }),
  z.object({ to: z.string().min(1) }),
]);

const pendingQuestionStep = z.object({
  id: z.string().min(1),
  prompt: z.string(),
  input: z.enum(["radio", "checkbox"]),
  options: z
    .array(z.object({ id: z.string().min(1), label: z.string() }))
    .min(1),
});

const pendingQuestionCard = z.object({
  kind: z.literal("question"),
  chatTarget,
  messageId: z.string().min(1),
  decisionId: z.string().min(1),
  version: z.number().int(),
  title: z.string(),
  questions: z.array(pendingQuestionStep).min(1),
  currentIndex: z.number().int().min(0),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
});

const pendingApprovalCard = z.object({
  kind: z.literal("approval"),
  chatTarget,
  messageId: z.string().min(1),
  decisionId: z.string().min(1),
  version: z.number().int(),
  title: z.string(),
  decisionKind: z.string().min(1),
});

// Legacy single-question shape retained for upgrade compatibility with existing state.json.
const legacyPendingCard = z.object({
  chatTarget,
  messageId: z.string().min(1),
  decisionId: z.string().min(1),
  version: z.number().int(),
  questionId: z.string().min(1),
  input: z.enum(["radio", "checkbox"]),
  optionIds: z.array(z.string().min(1)).min(1),
});

const pendingCard = z.union([
  pendingQuestionCard,
  pendingApprovalCard,
  legacyPendingCard,
]);
export type PendingCard = z.infer<typeof pendingCard>;

const channelState = z.object({
  // The server and Human Actor the bridge first ran for; it follows no other.
  serverUrl: z.string().optional(),
  actorId: z.string().optional(),
  // The highest Messages row the channel finished with.
  rowid: z.number().int().optional(),
  // The chat the person last wrote from; replies go there.
  replyChatId: z.number().int().optional(),
  // The Another Me Chat and its last handled room_seq.
  roomId: z.string().optional(),
  roomSeq: z.number().int().optional(),
  // A room_seq whose sends started but did not finish; never sent again.
  inFlightSeq: z.number().int().nullable().optional(),
  pendingCard: pendingCard.nullable().optional(),
});
export type ChannelState = z.infer<typeof channelState>;

export interface ChannelStore {
  get(): ChannelState;
  update(patch: Partial<ChannelState>): void;
}

// What the module changes while no bridge runs.
export interface ChannelStateReset {
  // Forgets everything, so the next start begins at the current ends.
  clear(): void;
  // Forgets where replies go, after the handles changed.
  resetTarget(): void;
}

// `<userData>/imessage/state.json`. A damaged file starts over empty, which
// only skips what arrived meanwhile: the channel never replays history.
export class IMessageStateStore implements ChannelStore, ChannelStateReset {
  readonly #file: string;
  #value: ChannelState;

  constructor(file: string) {
    this.#file = file;
    let stored: unknown;
    try {
      stored = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      stored = {};
    }
    const parsed = channelState.safeParse(stored);
    this.#value = parsed.success ? parsed.data : {};
  }

  get(): ChannelState {
    return this.#value;
  }

  clear(): void {
    this.#value = {};
    rmSync(this.#file, { force: true });
  }

  resetTarget(): void {
    const { replyChatId: _chat, pendingCard: _card, ...rest } = this.#value;
    this.#value = rest;
    this.update({});
  }

  update(patch: Partial<ChannelState>): void {
    this.#value = channelState.parse({ ...this.#value, ...patch });
    mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const staged = `${this.#file}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(staged, `${JSON.stringify(this.#value)}\n`, { mode: 0o600 });
    renameSync(staged, this.#file);
  }
}
