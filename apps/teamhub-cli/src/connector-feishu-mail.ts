import { readConnectorFile } from "./connector-files.js";
import {
  cursor,
  nextCursor,
  optionalFields,
  record,
  requiredString,
  type ConnectorRuntime,
  type Json,
} from "./connector-runtime.js";
import { CliError } from "./errors.js";

/**
 * TeamHub runs Feishu Mail's tools itself, without Composio, through the
 * owner's own lark-cli on their Computer, and they return mail already in the
 * CLI's shape. Sending always goes through a draft, so
 * the sponsor confirms the send of exactly what the draft holds.
 */
export const FEISHU_MAIL_TOOLS = {
  list: "FEISHU_MAIL_LIST_MESSAGES",
  get: "FEISHU_MAIL_GET_MESSAGE",
  thread: "FEISHU_MAIL_GET_THREAD",
  getDraft: "FEISHU_MAIL_GET_DRAFT",
  attachment: "FEISHU_MAIL_GET_ATTACHMENT",
  createDraft: "FEISHU_MAIL_CREATE_DRAFT",
  updateDraft: "FEISHU_MAIL_UPDATE_DRAFT",
  sendDraft: "FEISHU_MAIL_SEND_DRAFT",
  archive: "FEISHU_MAIL_ARCHIVE",
} as const;
const T = FEISHU_MAIL_TOOLS;

export function feishuMailBindings(action: string, input: Json): string[] {
  switch (action) {
    case "list":
      return [T.list];
    case "read":
      return input.draftId
        ? [T.getDraft]
        : input.thread
          ? [T.get, T.thread]
          : [T.get];
    case "send":
      return input.draftId ? [T.sendDraft] : [T.createDraft, T.sendDraft];
    case "reply":
      return [T.createDraft, T.sendDraft];
    case "draft":
      return input.updateDraftId ? [T.updateDraft] : [T.createDraft];
    case "archive":
      return [T.archive];
    default:
      return [T.get, T.attachment];
  }
}

export async function executeFeishuMail(
  action: string,
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  switch (action) {
    case "list":
      return listFeishuMail(input, runtime);
    case "read":
      return readFeishuMail(input, runtime);
    case "archive": {
      const raw = await runtime.call(
        T.archive,
        { message_id: input.messageId },
        true,
      );
      return {
        action: "archived",
        acknowledged: true,
        messageId: requiredString(raw.message_id, "archived message ID"),
      };
    }
    case "draft":
      return input.updateDraftId
        ? updateFeishuDraft(input, runtime)
        : feishuWrite("drafted", await createFeishuDraft(input, runtime));
    default:
      return sendFeishuMail(action, input, runtime);
  }
}

async function listFeishuMail(
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  const fingerprint = {
    account: runtime.account.connection_id,
    app: "feishu-mail",
    folder: input.folder,
    query: input.query ?? "",
    unreadOnly: input.unreadOnly ?? false,
    limit: input.limit,
  };
  const state = cursor(input.cursor, fingerprint);
  const raw = await runtime.call(
    T.list,
    optionalFields({
      folder: input.folder,
      query: input.query,
      unread_only: input.unreadOnly === true ? true : undefined,
      page_size: Math.min(Number(input.limit), 20),
      page_token: state.token,
    }),
  );
  if (!Array.isArray(raw.messages))
    throw new CliError(
      "incomplete_response",
      "The mailbox list has no message array.",
    );
  const token = raw.next_page_token;
  return {
    messages: raw.messages.map((x) => record(x)),
    hasMore: Boolean(token),
    ...(token ? { nextCursor: nextCursor({ token }, fingerprint) } : {}),
  };
}

async function readFeishuMail(
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  if (input.draftId) {
    const raw = await runtime.call(T.getDraft, { draft_id: input.draftId });
    return {
      draft: {
        draftId: requiredString(raw.draft_id, "draft ID"),
        mail: record(raw.message, "draft message"),
      },
    };
  }
  const mail = record(
    (await runtime.call(T.get, { message_id: input.messageId })).message,
    "message",
  );
  if (!input.thread) return { mail };
  const threadId = requiredString(mail.threadId, "thread ID");
  const fingerprint = {
    account: runtime.account.connection_id,
    app: "feishu-mail",
    messageId: input.messageId,
    threadId,
    limit: input.limit,
  };
  const state = cursor(input.cursor, fingerprint);
  const raw = await runtime.call(
    T.thread,
    optionalFields({
      thread_id: threadId,
      page_size: Math.min(Number(input.limit), 20),
      page_token: state.token,
    }),
  );
  if (!Array.isArray(raw.messages))
    throw new CliError(
      "incomplete_response",
      "The thread has no message array.",
    );
  const token = raw.next_page_token;
  return {
    thread: {
      threadId,
      messages: raw.messages.map((x) => record(x)),
      hasMore: Boolean(token),
      ...(token ? { nextCursor: nextCursor({ token }, fingerprint) } : {}),
    },
  };
}

async function draftAttachments(runtime: ConnectorRuntime): Promise<Json[]> {
  const attachments: Json[] = [];
  for (const file of runtime.files) {
    attachments.push({
      name: file.name,
      content_type: file.mimetype,
      content_base64: Buffer.from(await readConnectorFile(file)).toString(
        "base64",
      ),
    });
  }
  return attachments;
}

function bodyFields(input: Json): Json {
  return optionalFields({
    body: input.content,
    body_format:
      input.content === undefined
        ? undefined
        : input.bodyFormat === "html"
          ? "html"
          : "text",
  });
}

async function createFeishuDraft(
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  const attachments = await draftAttachments(runtime);
  const raw = await runtime.call(
    T.createDraft,
    optionalFields({
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      ...bodyFields(input),
      reply_to_message_id: input.messageId,
      reply_all: input.replyAll === true ? true : undefined,
      attachments: attachments.length ? attachments : undefined,
    }),
    true,
  );
  requiredString(raw.draft_id, "created draft ID");
  return raw;
}

async function updateFeishuDraft(
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  const attachments = await draftAttachments(runtime);
  const raw = await runtime.call(
    T.updateDraft,
    optionalFields({
      draft_id: input.updateDraftId,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      ...bodyFields(input),
      attachments: attachments.length ? attachments : undefined,
    }),
    true,
  );
  return feishuWrite("draft_updated", raw);
}

/** Sends a saved draft, or a new message or reply through a fresh draft. */
async function sendFeishuMail(
  action: string,
  input: Json,
  runtime: ConnectorRuntime,
): Promise<Json> {
  if (action === "send" && input.draftId)
    return feishuWrite(
      "sent",
      await runtime.call(T.sendDraft, { draft_id: input.draftId }, true),
      input.draftId,
    );
  const draftId = requiredString(
    (await createFeishuDraft(input, runtime)).draft_id,
    "draft ID",
  );
  try {
    return feishuWrite(
      "sent",
      await runtime.call(T.sendDraft, { draft_id: draftId }, true),
      draftId,
    );
  } catch {
    // A held send surfaces as its confirmation card before this error.
    throw new CliError(
      "outcome_unknown",
      "A draft exists; check it before sending again.",
      { draft_id: draftId },
    );
  }
}

function feishuWrite(action: string, raw: Json, draftId?: unknown): Json {
  return optionalFields({
    action,
    acknowledged: true,
    draftId: draftId ?? raw.draft_id,
    messageId: raw.message_id,
    threadId: raw.thread_id,
  });
}

/** The message's attachments in the shape the shared download flow selects from. */
export async function feishuMailAttachments(
  messageId: unknown,
  runtime: ConnectorRuntime,
): Promise<Json[]> {
  const mail = record(
    (await runtime.call(T.get, { message_id: messageId })).message,
    "message",
  );
  return (Array.isArray(mail.attachments) ? mail.attachments : []).map((x) => ({
    ...record(x),
    type: "file",
  }));
}

/** One attachment's bytes, which TeamHub fetches from Feishu. */
export async function feishuMailAttachmentBytes(
  messageId: unknown,
  attachmentId: unknown,
  runtime: ConnectorRuntime,
): Promise<Uint8Array> {
  const raw = await runtime.call(T.attachment, {
    message_id: messageId,
    attachment_id: attachmentId,
  });
  return Buffer.from(
    requiredString(raw.content_base64, "attachment content"),
    "base64",
  );
}
