import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { Translate } from "../i18n/language.js";
import { normalizeIMessageHandle } from "./config.js";
import type { ChannelStore, PendingCard } from "./imessage-state.js";
import {
  TeamHubStreamError,
  type IMessageTeamHub,
  type TeamHubCardChanged,
  type TeamHubDecisionCard,
  type TeamHubMessage,
  type TeamHubMessageCreated,
  type TeamHubResult,
  type TeamHubRoomEvent,
} from "./imessage-teamhub.js";
import { imessageMessages as m } from "./imessage.messages.js";
import { imessageChunks, imessageText } from "./imessage-text.js";
import type {
  IMessageTransport,
  IMsgAttachment,
  IMsgMessage,
  IMsgSendOptions,
  IMsgSendTarget,
} from "./imsg-rpc.js";
import type { Logger } from "./log.js";

// Every text the channel sends starts with this. Messages to one's own Apple
// ID come back as a new inbound row with a new GUID, so the prefix is the
// only way to tell the channel's own texts from the person's.
export const OUTBOUND_PREFIX = "\u{1F916} ";

export type BridgeState =
  | "starting"
  | "running"
  | "signed_out"
  | "no_another_me"
  | "other_account"
  | "error";

export interface InboundAttachment {
  readonly path: string;
  readonly filename: string;
  readonly mediaType?: string;
}

export type Admission =
  | {
      readonly accept: true;
      readonly text: string;
      readonly attachments: readonly InboundAttachment[];
      readonly chatId?: number;
    }
  | { readonly accept: false; readonly reason: string };

export interface OutboundDocument {
  readonly documentId: string;
  readonly label: string;
}

const MAX_INBOUND_ATTACHMENTS = 5;
const MAX_INBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_OUTBOUND_DOCUMENT_BYTES = 50 * 1024 * 1024;
const STAGED_CLEANUP_DELAY_MS = 60_000;

const MEDIA_TYPE_EXTENSIONS: Record<string, string> = {
  "text/markdown": ".md",
  "text/plain": ".txt",
  "text/html": ".html",
  "text/csv": ".csv",
  "application/json": ".json",
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

function sanitizeFilename(raw: string, mediaType?: string): string {
  const base = Array.from(path.basename(raw.replace(/\\/g, "/")), (char) => {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || '/:*?"<>|'.includes(char)) return "_";
    return char;
  })
    .join("")
    .trim();
  let name = base && base !== "." && base !== ".." ? base : "document";
  if (!path.extname(name) && mediaType) {
    const ext = MEDIA_TYPE_EXTENSIONS[mediaType.toLowerCase()];
    if (ext) name += ext;
  }
  return name.slice(0, 180);
}

function inboundAttachments(
  attachments: readonly IMsgAttachment[] | undefined,
): InboundAttachment[] {
  if (!attachments || attachments.length === 0) return [];
  const out: InboundAttachment[] = [];
  for (const item of attachments) {
    if (item.missing || item.is_sticker) continue;
    const filePath = item.original_path?.trim();
    if (!filePath) continue;
    const rawName =
      item.transfer_name?.trim() ||
      item.filename?.trim() ||
      path.basename(filePath);
    const mediaType = item.mime_type?.trim() || undefined;
    out.push({
      path: filePath,
      filename: sanitizeFilename(rawName, mediaType),
      ...(mediaType ? { mediaType } : {}),
    });
    if (out.length >= MAX_INBOUND_ATTACHMENTS) break;
  }
  return out;
}

// Which Messages rows become the person's own Messages in their iMessage
// Channel Room: new one-to-one texts or attachments from one of their handles
// that the channel did not send itself.
export function admitInbound(
  message: IMsgMessage,
  handles: readonly string[],
): Admission {
  if (message.type) return { accept: false, reason: "mutation" };
  if (message.is_group !== false) return { accept: false, reason: "group" };
  if (message.is_from_me !== false) return { accept: false, reason: "from_me" };
  const raw = message.sender?.trim() ? message.sender : message.chat_identifier;
  const sender = raw ? normalizeIMessageHandle(raw) : undefined;
  if (!sender || !handles.includes(sender))
    return { accept: false, reason: "unknown_sender" };
  const text = (message.text ?? "").trim();
  if (text.startsWith(OUTBOUND_PREFIX))
    return { accept: false, reason: "own_echo" };
  const attachments = inboundAttachments(message.attachments);
  if (!text && attachments.length === 0)
    return { accept: false, reason: "empty" };
  return {
    accept: true,
    text,
    attachments,
    ...(typeof message.chat_id === "number" ? { chatId: message.chat_id } : {}),
  };
}

// Ordered, deduplicated documents and attachments attached to an Agent Message.
export function outboundDocuments(message: TeamHubMessage): OutboundDocument[] {
  const seen = new Set<string>();
  const out: OutboundDocument[] = [];
  for (const attachment of message.attachments ?? []) {
    if (!attachment.available || seen.has(attachment.document_id)) continue;
    seen.add(attachment.document_id);
    out.push({
      documentId: attachment.document_id,
      label: attachment.filename,
    });
  }
  for (const segment of message.segments ?? []) {
    if (segment.type !== "document" || seen.has(segment.document_id)) continue;
    seen.add(segment.document_id);
    out.push({
      documentId: segment.document_id,
      label: segment.content,
    });
  }
  return out;
}

// Message body without trailing document-card labels that are delivered as
// separate file attachments right after the text.
export function outboundMessageBody(
  message: TeamHubMessage,
  deliveringDocuments: readonly OutboundDocument[],
): string {
  if (deliveringDocuments.length === 0 || !message.segments?.length)
    return message.raw_message;
  const deliveredIds = new Set(deliveringDocuments.map((d) => d.documentId));
  let omittedCard = false;
  const parts: string[] = [];
  for (const segment of message.segments) {
    if (
      segment.type === "document" &&
      deliveredIds.has(segment.document_id) &&
      (segment.presentation === "card" || segment.presentation === "canvas")
    ) {
      omittedCard = true;
      continue;
    }
    parts.push(segment.content);
  }
  return omittedCard ? parts.join("") : message.raw_message;
}

// The numbers of a numbered reply: one for radio, a comma list for
// checkbox, each in 1..count and none twice.
export function parseNumberedAnswer(
  text: string,
  input: "radio" | "checkbox",
  count: number,
): number[] | undefined {
  const trimmed = text.trim();
  const grammar = input === "radio" ? /^\d+$/ : /^\d+(\s*,\s*\d+)*$/;
  if (!grammar.test(trimmed)) return undefined;
  const numbers = trimmed.split(",").map((part) => Number(part.trim()));
  if (numbers.some((n) => n < 1 || n > count)) return undefined;
  if (new Set(numbers).size !== numbers.length) return undefined;
  return numbers;
}

export interface QuestionCardText {
  readonly text: string;
  readonly decisionId: string;
  readonly version: number;
  readonly questionId: string;
  readonly input: "radio" | "checkbox";
  readonly optionIds: string[];
}

// Only question cards are answered from Messages. The other kinds approve
// actions that cannot be taken back or need inputs (connections, keys,
// files) Messages cannot carry, so they stay in Linger.
export function questionCardText(
  card: TeamHubDecisionCard,
  humanActorId: string | undefined,
  t: Translate,
): QuestionCardText | undefined {
  if (card.kind !== "question" || card.status !== "pending") return undefined;
  if (!humanActorId || card.decision_owner.id !== humanActorId)
    return undefined;
  const questions = card.question?.questions;
  if (questions?.length !== 1) return undefined;
  const question = questions[0]!;
  if (question.input !== "radio" && question.input !== "checkbox")
    return undefined;
  const lines = [card.title];
  if (question.prompt.trim() !== card.title.trim()) lines.push(question.prompt);
  question.options.forEach((option, index) =>
    lines.push(`${String(index + 1)}. ${option.label}`),
  );
  lines.push(
    t(question.input === "radio" ? m.replyWithNumber : m.replyWithNumbers),
  );
  return {
    text: lines.join("\n"),
    decisionId: card.decision_id,
    version: card.version,
    questionId: question.id,
    input: question.input,
    optionIds: question.options.map((option) => option.id),
  };
}

const KEY_UNSAFE = /[^A-Za-z0-9._:-]/g;

// Replaying one Messages row posts its Message once.
export function inboundIdempotencyKey(message: IMsgMessage): string {
  const id = message.guid ? message.guid : `rowid-${String(message.id)}`;
  return `imessage:${id.replace(KEY_UNSAFE, "-")}`.slice(0, 128);
}

export function maskHandle(handle: string): string {
  return handle.length <= 4 ? "***" : `***${handle.slice(-2)}`;
}

export interface IMessageChannelOptions {
  readonly transport: IMessageTransport;
  readonly teamhub: IMessageTeamHub;
  readonly store: ChannelStore;
  readonly handles: readonly string[];
  // The Chat in the web app, for cards answered there.
  readonly chatUrl: (roomId: string) => string | undefined;
  // The Document page in the web app, used as fallback when a file cannot be
  // sent through Messages.
  readonly documentUrl?: (documentId: string) => string | undefined;
  readonly log: Logger;
  // The shell's language, for the texts the bridge writes itself.
  readonly t: Translate;
  readonly onState: (state: BridgeState) => void;
  // The server the window uses now, and the Human the Computer is enrolled
  // for, if any.
  readonly serverUrl: () => string | undefined;
  readonly ownerActorId?: () => string | undefined;
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly readAttachment?: (
    filePath: string,
    maxBytes: number,
  ) => Promise<Uint8Array | undefined>;
  readonly stageAttachment?: (
    filename: string,
    bytes: Uint8Array,
  ) => Promise<{
    readonly filePath: string;
    readonly cleanup: () => Promise<void>;
  }>;
}

const SIGNED_OUT_PROBE_MS = 30_000;
const NO_ANOTHER_ME_PROBE_MS = 60_000;
const SEND_ATTEMPTS = 5;
// How long a send waits for a restarting imsg before it gives up.
const SEND_NOT_RUNNING_MAX_MS = 120_000;
const SEND_NOT_RUNNING_WAIT_MS = 2_000;

function backoff(failures: number): number {
  return Math.min(1_000 * 2 ** Math.max(failures - 1, 0), 30_000);
}

function retryable(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

type Step = "done" | "retry" | "blocked";
type SessionOutcome =
  | "signed_out"
  | "other_account"
  | "no_another_me"
  | "retry";

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return delay(ms, undefined, { signal }).catch(() => undefined);
}

async function defaultReadAttachment(
  filePath: string,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size <= 0 || info.size > maxBytes)
      return undefined;
    return new Uint8Array(await readFile(filePath));
  } catch {
    return undefined;
  }
}

async function defaultStageAttachment(
  filename: string,
  bytes: Uint8Array,
): Promise<{
  readonly filePath: string;
  readonly cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "linger-imsg-"));
  const filePath = path.join(dir, filename);
  await writeFile(filePath, bytes, { mode: 0o600 });
  return {
    filePath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// Connects the person's iMessage handles with their isolated iMessage Channel
// Room: inbound rows and attachments become their Messages, Another Me's
// Messages, attachments, and Documents go back over iMessage, and a
// single-question card takes a numbered reply.
export class IMessageChannel {
  readonly #options: IMessageChannelOptions;
  readonly #wait: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #readAttachment: (
    filePath: string,
    maxBytes: number,
  ) => Promise<Uint8Array | undefined>;
  readonly #stageAttachment: (
    filename: string,
    bytes: Uint8Array,
  ) => Promise<{
    readonly filePath: string;
    readonly cleanup: () => Promise<void>;
  }>;
  readonly #stopping = new AbortController();
  #connection: AbortController | undefined;
  #state: BridgeState | undefined;
  #roomId: string | undefined;
  #agentActorId: string | undefined;
  #humanActorId: string | undefined;
  #sessionExpired = false;
  #queue: IMsgMessage[] = [];
  // chat_id -> service, for this process.
  readonly #services = new Map<number, string | undefined>();
  readonly #pendingCleanups = new Set<() => Promise<void>>();
  readonly #cleanupTimers = new Set<NodeJS.Timeout>();
  #highestSeen: number;
  #draining: Promise<void> | undefined;
  // Inbound rows wait here while the channel is not running.
  #gate!: Promise<void>;
  #openGate!: () => void;
  #gateOpen = false;
  #loop: Promise<void> | undefined;

  constructor(options: IMessageChannelOptions) {
    this.#options = options;
    this.#wait = options.wait ?? abortableDelay;
    this.#readAttachment = options.readAttachment ?? defaultReadAttachment;
    this.#stageAttachment = options.stageAttachment ?? defaultStageAttachment;
    this.#highestSeen = options.store.get().rowid ?? 0;
    this.#closeGate();
  }

  #closeGate(): void {
    this.#gateOpen = false;
    this.#gate = new Promise((resolve) => {
      this.#openGate = resolve;
    });
  }

  start(): void {
    this.#setState("starting");
    this.#options.transport.start({
      cursor: () => this.#options.store.get().rowid,
      message: (message) => this.#enqueue(message),
    });
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#stopping.abort();
    this.#connection?.abort();
    this.#openGate();
    await this.#options.transport.stop();
    await this.#loop;
    await this.#draining;
    for (const timer of this.#cleanupTimers) clearTimeout(timer);
    this.#cleanupTimers.clear();
    await Promise.allSettled(
      Array.from(this.#pendingCleanups, (cleanup) => cleanup()),
    );
    this.#pendingCleanups.clear();
  }

  get #stopped(): boolean {
    return this.#stopping.signal.aborted;
  }

  #sleep(ms: number): Promise<void> {
    return this.#wait(ms, this.#stopping.signal);
  }

  #setState(state: BridgeState): void {
    if (state === this.#state) return;
    this.#state = state;
    if (state === "running") {
      this.#gateOpen = true;
      this.#openGate();
    } else if (this.#gateOpen) this.#closeGate();
    this.#options.log.info("imessage.bridge_state", { state });
    this.#options.onState(state);
  }

  #signedOut(): void {
    this.#sessionExpired = true;
    this.#setState("signed_out");
    this.#connection?.abort();
  }

  async #run(): Promise<void> {
    let failures = 0;
    while (!this.#stopped) {
      this.#sessionExpired = false;
      let outcome: SessionOutcome;
      try {
        outcome = await this.#session(() => {
          failures = 0;
        });
      } catch (error) {
        this.#unexpected(error);
        outcome = "retry";
      }
      if (this.#stopped) return;
      if (outcome === "signed_out" || outcome === "other_account") {
        this.#setState(outcome);
        await this.#sleep(SIGNED_OUT_PROBE_MS);
      } else if (outcome === "no_another_me") {
        this.#setState("no_another_me");
        await this.#sleep(NO_ANOTHER_ME_PROBE_MS);
      } else {
        failures += 1;
        await this.#sleep(backoff(failures));
      }
    }
  }

  // A bug or a full disk must not end the bridge silently.
  #unexpected(error: unknown): void {
    this.#options.log.error("imessage.bridge_failed", {
      error:
        (error as NodeJS.ErrnoException)?.code ??
        (error instanceof Error ? error.name : "unknown"),
    });
    this.#setState("error");
    this.#connection?.abort();
  }

  #failed(result: { status: number }): "signed_out" | "retry" {
    if (result.status === 401) return "signed_out";
    this.#setState("error");
    this.#options.log.warn("imessage.teamhub_failed", {
      status: result.status,
    });
    return "retry";
  }

  // One connection to the iMessage Channel Room; resolves with why it ended.
  async #session(connected: () => void): Promise<SessionOutcome> {
    const { teamhub, store, log } = this.#options;
    const me = await teamhub.me();
    if (!me.ok) return this.#failed(me);
    if (!this.#sameAccount(me.value.actorId)) return "other_account";
    const anotherMe = await teamhub.anotherMe();
    if (!anotherMe.ok) return this.#failed(anotherMe);
    const { agentActorId, roomId: directRoomId } = anotherMe.value;
    if (!agentActorId) return "no_another_me";
    let roomId: string | undefined;
    if (teamhub.openChannelRoom) {
      const channelRoom = await teamhub.openChannelRoom("imessage");
      if (channelRoom.ok) roomId = channelRoom.value.roomId;
      else if (
        channelRoom.status === 404 &&
        channelRoom.code === "ANOTHER_ME_NOT_FOUND"
      )
        return "no_another_me";
      else if (channelRoom.status === 404 && directRoomId) {
        // Older TeamHub without channel Rooms falls back to the primary Chat.
        roomId = directRoomId;
      } else return this.#failed(channelRoom);
    } else roomId = directRoomId;
    if (!roomId) return "no_another_me";
    this.#humanActorId = me.value.actorId;
    this.#roomId = roomId;
    this.#agentActorId = agentActorId;

    let state = store.get();
    if (state.roomId !== roomId || state.roomSeq === undefined) {
      // A new Chat starts at its current end: history is never sent.
      const latest = await teamhub.latestRoomSeq(roomId);
      if (!latest.ok) return this.#failed(latest);
      store.update({
        roomId,
        roomSeq: latest.value,
        inFlightSeq: null,
        pendingCard: null,
      });
      state = store.get();
    }
    if (state.inFlightSeq !== undefined && state.inFlightSeq !== null) {
      // Its texts may have gone out; sending again could double them.
      log.warn("imessage.send_skipped_after_restart", {
        room_seq: state.inFlightSeq,
      });
      store.update({
        roomSeq: Math.max(state.roomSeq ?? 0, state.inFlightSeq),
        inFlightSeq: null,
      });
    }

    this.#setState("running");
    const connection = new AbortController();
    this.#connection = connection;
    const signal = AbortSignal.any([connection.signal, this.#stopping.signal]);
    try {
      for await (const event of teamhub.events(
        roomId,
        store.get().roomSeq ?? 0,
        signal,
      )) {
        connected();
        if (event.event === "session.expired") return "signed_out";
        if (event.event !== "room.event") continue;
        let envelope: TeamHubRoomEvent;
        try {
          envelope = JSON.parse(event.data) as TeamHubRoomEvent;
        } catch {
          log.warn("imessage.room_event_invalid", {});
          continue;
        }
        await this.#roomEvent(envelope);
        if (this.#stopped || this.#sessionExpired) break;
      }
    } catch (error) {
      if (error instanceof TeamHubStreamError) {
        if (error.status === 401) return "signed_out";
        log.warn("imessage.stream_failed", { status: error.status });
      } else throw error;
    } finally {
      this.#connection = undefined;
    }
    return this.#sessionExpired ? "signed_out" : "retry";
  }

  async #roomEvent(event: TeamHubRoomEvent): Promise<void> {
    const { store } = this.#options;
    if (event.room_id !== this.#roomId) return;
    // The stream is at least once.
    if (event.room_seq <= (store.get().roomSeq ?? 0)) return;
    if (event.event_type === "message.created")
      await this.#outbound(
        (event.payload as TeamHubMessageCreated).message,
        event.room_seq,
      );
    else if (event.event_type === "card.changed") {
      const payload = event.payload as TeamHubCardChanged;
      const pending = store.get().pendingCard;
      if (
        pending &&
        pending.messageId === payload.message_id &&
        payload.version > pending.version
      )
        store.update({ pendingCard: null });
    }
    store.update({ roomSeq: event.room_seq, inFlightSeq: null });
  }

  // The bridge belongs to the account and server it first ran for; turning
  // iMessage off and on is the way to move it.
  #sameAccount(actorId: string): boolean {
    const { store, log } = this.#options;
    const serverUrl = this.#options.serverUrl();
    const owner = this.#options.ownerActorId?.();
    const bound = store.get();
    let same = !owner || owner === actorId;
    if (same && bound.actorId === undefined)
      store.update({ actorId, ...(serverUrl ? { serverUrl } : {}) });
    else if (bound.actorId !== actorId || bound.serverUrl !== serverUrl)
      same = false;
    if (!same) log.warn("imessage.other_account", {});
    return same;
  }

  #target(): IMsgSendTarget | undefined {
    const chatId = this.#options.store.get().replyChatId;
    if (chatId !== undefined) return { chatId };
    const handle = this.#options.handles[0];
    return handle ? { to: handle } : undefined;
  }

  async #outbound(message: TeamHubMessage, roomSeq: number): Promise<void> {
    const { store, log } = this.#options;
    if (
      message.author.kind !== "agent" ||
      message.author.id !== this.#agentActorId ||
      message.message_kind !== "conversation"
    )
      return;
    const target = this.#target();
    if (!target) {
      log.warn("imessage.send_no_target", { room_seq: roomSeq });
      return;
    }
    const documents = message.card ? [] : outboundDocuments(message);
    let chunks: string[];
    let pending: PendingCard | undefined;
    if (message.card) {
      const question = questionCardText(
        message.card,
        this.#humanActorId,
        this.#options.t,
      );
      if (question) {
        chunks = imessageChunks(question.text);
        const { text: _text, ...card } = question;
        pending = { ...card, chatTarget: target, messageId: message.id };
      } else
        chunks = imessageChunks(
          `${message.card.title}\n${this.#options.t(m.openToAnswer, { link: this.#chatLink() })}`,
        );
    } else chunks = imessageText(outboundMessageBody(message, documents));
    if (chunks.length === 0 && documents.length === 0) return;
    // Only the latest Message can be answered by number.
    store.update({ inFlightSeq: roomSeq, pendingCard: null });
    let sent = true;
    for (const chunk of chunks) {
      if (!(await this.#sendOne(target, `${OUTBOUND_PREFIX}${chunk}`))) {
        sent = false;
        break;
      }
    }
    let filesSent = 0;
    if (sent && documents.length > 0) {
      for (const doc of documents) {
        const ok = await this.#sendDocument(target, doc);
        if (ok) filesSent += 1;
      }
    }
    log.info("imessage.outbound", {
      room_seq: roomSeq,
      chunks: chunks.length,
      documents: documents.length || undefined,
      files_sent: filesSent || undefined,
      sent,
      card: pending ? "question" : message.card ? "link" : undefined,
    });
    if (sent && pending) store.update({ pendingCard: pending });
  }

  async #sendDocument(
    target: IMsgSendTarget,
    doc: OutboundDocument,
  ): Promise<boolean> {
    const { teamhub, log, t } = this.#options;
    const fallback = async (reason: string): Promise<boolean> => {
      log.warn("imessage.outbound_document_fallback", {
        document_id: doc.documentId,
        reason,
      });
      return this.#sendOne(
        target,
        `${OUTBOUND_PREFIX}${t(m.openDocument, {
          name: doc.label,
          link: this.#documentLink(doc.documentId),
        })}`,
      );
    };
    if (!teamhub.downloadDocument) return fallback("unsupported");
    const downloaded = await teamhub.downloadDocument(
      doc.documentId,
      MAX_OUTBOUND_DOCUMENT_BYTES,
    );
    if (!downloaded.ok) {
      if (downloaded.status === 401) {
        this.#signedOut();
        return false;
      }
      return fallback(downloaded.code ?? `http_${String(downloaded.status)}`);
    }
    const safeName = sanitizeFilename(
      downloaded.value.filename || doc.label,
      downloaded.value.mediaType,
    );
    let staged:
      | { readonly filePath: string; readonly cleanup: () => Promise<void> }
      | undefined;
    try {
      staged = await this.#stageAttachment(safeName, downloaded.value.bytes);
    } catch {
      return fallback("stage_failed");
    }
    // Sending with the bot prefix caption gives imsg reliable text-based
    // receipt verification and prevents self-chat echo loops.
    const ok = await this.#sendOne(target, `${OUTBOUND_PREFIX}${safeName}`, {
      file: staged.filePath,
    });
    this.#scheduleCleanup(staged.cleanup);
    if (!ok) return fallback("send_failed");
    return true;
  }

  #scheduleCleanup(cleanup: () => Promise<void>): void {
    this.#pendingCleanups.add(cleanup);
    const timer = setTimeout(() => {
      this.#cleanupTimers.delete(timer);
      this.#pendingCleanups.delete(cleanup);
      void cleanup().catch(() => undefined);
    }, STAGED_CLEANUP_DELAY_MS);
    timer.unref();
    this.#cleanupTimers.add(timer);
  }

  // At most once: only a send imsg proves was never dispatched is retried.
  async #sendOne(
    target: IMsgSendTarget,
    text: string,
    options?: IMsgSendOptions,
  ): Promise<boolean> {
    const { transport, log } = this.#options;
    let waited = 0;
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; ) {
      if (this.#stopped) return false;
      const result = await transport.send(target, text, options);
      if (result.ok) return true;
      if (result.notRunning) {
        // Nothing was dispatched, so waiting for imsg costs no attempt.
        if (waited >= SEND_NOT_RUNNING_MAX_MS) break;
        waited += SEND_NOT_RUNNING_WAIT_MS;
        await this.#sleep(SEND_NOT_RUNNING_WAIT_MS);
        continue;
      }
      if (!result.retrySafe) {
        log.warn("imessage.send_uncertain", {
          target: "chatId" in target ? "chat" : maskHandle(target.to),
        });
        return false;
      }
      await this.#sleep(backoff(attempt));
      attempt += 1;
    }
    log.warn("imessage.send_gave_up", { waited_ms: waited });
    return false;
  }

  #enqueue(message: IMsgMessage): void {
    // Edits and unsends reuse an earlier row and never move the cursor.
    if (message.type) return;
    // A resubscription replays rows already queued.
    if (message.id <= this.#highestSeen) return;
    this.#highestSeen = message.id;
    this.#queue.push(message);
    this.#draining ??= this.#drain().finally(() => {
      this.#draining = undefined;
    });
  }

  // One row at a time, in order; a row is done before the cursor moves past.
  async #drain(): Promise<void> {
    let failures = 0;
    while (this.#queue.length > 0 && !this.#stopped) {
      if (this.#state !== "running") {
        await this.#gate;
        continue;
      }
      let step: Step;
      try {
        step = await this.#inbound(this.#queue[0]!);
      } catch (error) {
        // The session restarts and reopens the gate.
        this.#unexpected(error);
        step = "retry";
      }
      if (step === "done") {
        this.#queue.shift();
        failures = 0;
      } else if (step === "retry") {
        failures += 1;
        await this.#sleep(backoff(failures));
      }
    }
  }

  async #inbound(message: IMsgMessage): Promise<Step> {
    const { store, teamhub, log, handles } = this.#options;
    const admission = admitInbound(message, handles);
    if (!admission.accept) {
      log.info("imessage.inbound_skipped", {
        rowid: message.id,
        reason: admission.reason,
      });
      store.update({ rowid: message.id });
      return "done";
    }
    const service = await this.#chatService(admission.chatId);
    if (service === "failed") return "retry";
    if (service?.toLowerCase() !== "imessage") {
      // SMS and other services are not end-to-end iMessage; only iMessage
      // chats reach Another Me.
      log.info("imessage.inbound_skipped", {
        rowid: message.id,
        reason: "not_imessage",
      });
      store.update({ rowid: message.id });
      return "done";
    }
    const done = (): Step => {
      store.update({
        rowid: message.id,
        ...(admission.chatId !== undefined
          ? { replyChatId: admission.chatId }
          : {}),
      });
      return "done";
    };
    const pending = store.get().pendingCard;
    if (
      pending &&
      admission.text &&
      admission.attachments.length === 0 &&
      (!("chatId" in pending.chatTarget) ||
        pending.chatTarget.chatId === admission.chatId)
    ) {
      const numbers = parseNumberedAnswer(
        admission.text,
        pending.input,
        pending.optionIds.length,
      );
      if (numbers) {
        const step = await this.#answer(pending, numbers);
        return step === "done" ? done() : step;
      }
    }
    const attachmentUploadIds: string[] = [];
    if (admission.attachments.length > 0 && teamhub.uploadAttachment) {
      for (const item of admission.attachments) {
        const bytes = await this.#readAttachment(
          item.path,
          MAX_INBOUND_ATTACHMENT_BYTES,
        );
        if (!bytes) {
          log.warn("imessage.inbound_attachment_unreadable", {
            rowid: message.id,
          });
          continue;
        }
        const uploaded = await teamhub.uploadAttachment(this.#roomId!, {
          filename: item.filename,
          ...(item.mediaType ? { mediaType: item.mediaType } : {}),
          bytes,
        });
        if (uploaded.ok) {
          attachmentUploadIds.push(uploaded.value.uploadId);
          continue;
        }
        const step = this.#rejected(uploaded);
        if (step !== "done") return step;
        log.warn("imessage.inbound_attachment_rejected", {
          rowid: message.id,
          status: uploaded.status,
          code: uploaded.code,
        });
      }
    }
    if (!admission.text && attachmentUploadIds.length === 0) {
      log.info("imessage.inbound_skipped", {
        rowid: message.id,
        reason: "attachments_unavailable",
      });
      return done();
    }
    const result =
      attachmentUploadIds.length > 0
        ? await teamhub.postMessage(
            this.#roomId!,
            inboundIdempotencyKey(message),
            admission.text,
            { attachmentUploadIds },
          )
        : await teamhub.postMessage(
            this.#roomId!,
            inboundIdempotencyKey(message),
            admission.text,
          );
    if (result.ok) {
      log.info("imessage.inbound_posted", {
        rowid: message.id,
        attachments: attachmentUploadIds.length || undefined,
      });
      return done();
    }
    const step = this.#rejected(result);
    if (step !== "done") return step;
    log.warn("imessage.inbound_rejected", {
      rowid: message.id,
      status: result.status,
      code: result.code,
    });
    // A Message TeamHub refuses must not hold up the ones behind it.
    store.update({ rowid: message.id });
    return "done";
  }

  async #chatService(
    chatId: number | undefined,
  ): Promise<string | undefined | "failed"> {
    if (chatId === undefined) return undefined;
    if (this.#services.has(chatId)) return this.#services.get(chatId);
    try {
      const service = await this.#options.transport.chatService(chatId);
      this.#services.set(chatId, service);
      return service;
    } catch {
      this.#options.log.warn("imessage.chat_lookup_failed", {});
      return "failed";
    }
  }

  #rejected(result: Extract<TeamHubResult<unknown>, { ok: false }>): Step {
    if (result.status === 401) {
      this.#signedOut();
      return "blocked";
    }
    return retryable(result.status) ? "retry" : "done";
  }

  async #answer(pending: PendingCard, numbers: number[]): Promise<Step> {
    const { store, teamhub, log } = this.#options;
    const chosen = numbers.map((n) => pending.optionIds[n - 1]!);
    const result = await teamhub.decide(pending.decisionId, {
      expected_version: pending.version,
      decision: "submit",
      answers: {
        [pending.questionId]: pending.input === "radio" ? chosen[0]! : chosen,
      },
    });
    if (result.ok) {
      log.info("imessage.card_answered", { decision_id: pending.decisionId });
      store.update({ pendingCard: null });
      return "done";
    }
    const step = this.#rejected(result);
    if (step !== "done") return step;
    store.update({ pendingCard: null });
    log.warn("imessage.card_answer_rejected", {
      decision_id: pending.decisionId,
      status: result.status,
      code: result.code,
    });
    const { t } = this.#options;
    await this.#sendOne(
      pending.chatTarget,
      OUTBOUND_PREFIX +
        (result.status === 409
          ? t(m.answerChanged)
          : t(m.answerFailed, { link: this.#chatLink() })),
    );
    return "done";
  }

  #chatLink(): string {
    return (this.#roomId && this.#options.chatUrl(this.#roomId)) || "Linger";
  }

  #documentLink(documentId: string): string {
    return this.#options.documentUrl?.(documentId) || this.#chatLink();
  }
}
