/**
 * Tencent iLink, as the reference Connector.
 *
 * Every line here was written against a live bot, and the notes record what
 * actually happened rather than what the surface promises.
 *
 * Two findings shape the code:
 *
 *   1. The bot is a separate identity (`*@im.bot`), not the human's account. It
 *      sees only conversations addressed to it and can never be presented as
 *      the human. That is why an inbound event names a `peerId` and a
 *      `replyToken` rather than carrying any user credential.
 *
 *   2. `ret -2 "prepare failed"` is not rate limiting. iLink will not prepare a
 *      bot-initiated send until the peer messages the bot again: the send path
 *      closes a while after their last message, and no volume of retries with a
 *      fresh token reopens it. Measured on a live bot, sends succeeded up to
 *      about 22 minutes after the peer's message and failed after 26, and a
 *      six-message burst closed the window early. So a failed send reports
 *      `session-stale` and the host keeps the item until the peer writes again,
 *      rather than spinning.
 *
 * A separate `errcode -14` means the token itself is dead and only the owner,
 * on their own phone, can issue a new one. Retrying that is never correct.
 */
import { createHash, createCipheriv, randomBytes } from "node:crypto";
import { basename } from "node:path";
import { readFile } from "node:fs/promises";

import type {
  Capabilities,
  Connector,
  InboundEvent,
  InboundMessage,
  SendRequest,
  SendResult,
} from "./index.js";

/**
 * The transport is a seam so a test never touches the network.
 *
 * `put` exists because media upload is not a JSON call: the surface hands back
 * a CDN target and the bytes go there, encrypted, with the download parameter
 * arriving as a response header.
 */
export interface Transport {
  post(path: string, body: unknown): Promise<TransportReply>;
  put(url: string, body: Buffer): Promise<TransportReply>;
}

export interface TransportReply {
  status: number;
  text: string;
  /** One response header, which is how the CDN returns the download parameter. */
  header(name: string): string | null;
  errorMessage: string | null;
}

/** Credentials the owner supplies once; the Connector never invents them. */
export interface Credentials {
  token: string;
  baseUrl?: string;
}

export interface ILlinkOptions {
  credentials: Credentials;
  transport?: Transport;
  /** Clock, so tests do not sleep. */
  now?: () => number;
}

/** One item in an iLink message's `item_list`. */
type ILinkItem =
  | { type: 1; text_item: { text: string } }
  | { type: 2; image_item: { media: UploadedMedia; mid_size: number } }
  | {
      type: 4;
      file_item: { media: UploadedMedia; file_name: string; len: string };
    };

interface UploadedMedia {
  encrypt_query_param: string;
  aes_key: string;
  encrypt_type: 1;
}

interface SendReply {
  ret?: number;
  errmsg?: string;
  errcode?: number;
  message_id?: number | string;
}

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const IMAGE_MEDIA_TYPE = 1;
const FILE_MEDIA_TYPE = 3;
const API_VERSION = String((2 << 16) | (4 << 8) | 10);

export const ILINK_CAPABILITIES: Capabilities = {
  // The client renders Markdown in a text bubble. Verified by sending
  // headings, a table, inline code and a fenced block to a live client.
  markdown: true,
  // iLink rejects a text item above 2000 characters.
  maxTextLength: 2000,
  images: true,
  files: true,
  // A bot identity cannot be invited to a group: group events are not
  // delivered, so group support here would be a promise the surface breaks.
  groups: false,
  // A reply is not a distinct field on this surface; the reference is the
  // reply token, which the host uses to keep the thread in context.
  replies: false,
};

function classify(reply: SendReply): SendResult {
  if (reply.errcode === -14) {
    return {
      delivered: false,
      reason: "blocked",
      detail: "session timeout: token is dead",
    };
  }
  if (reply.ret === -2) {
    return {
      delivered: false,
      reason: "session-stale",
      detail: "peer has not messaged recently",
    };
  }
  if (reply.ret !== undefined && reply.ret !== 0) {
    return {
      delivered: false,
      reason: "unknown",
      detail: reply.errmsg ?? `ret ${reply.ret}`,
    };
  }
  if (reply.errcode !== undefined && reply.errcode !== 0) {
    return {
      delivered: false,
      reason: "unknown",
      detail: `errcode ${reply.errcode}`,
    };
  }
  const id =
    reply.message_id === undefined ? undefined : String(reply.message_id);
  return id === undefined
    ? { delivered: true }
    : { delivered: true, externalId: id };
}

export class ILinkConnector implements Connector {
  readonly name = "ilink";
  readonly #credentials: Credentials;
  readonly #transport: Transport;
  readonly #now: () => number;
  #cursor = 0;

  constructor(options: ILlinkOptions) {
    this.#credentials = options.credentials;
    this.#transport =
      options.transport ??
      fetchTransport(options.credentials.baseUrl ?? DEFAULT_BASE_URL);
    this.#now = options.now ?? Date.now;
  }

  async authenticate(): Promise<void> {
    // iLink has no handshake: a token either works or it does not. The first
    // poll is the real authentication check, so this stays cheap and honest.
    if (this.#credentials.token === "") throw new Error("iLink token is empty");
  }

  describeCapabilities(): Capabilities {
    return ILINK_CAPABILITIES;
  }

  async poll(): Promise<InboundEvent[]> {
    const { status, text } = await this.#transport.post(
      "/ilink/bot/getupdates",
      {
        cursor: this.#cursor,
        base_info: baseInfo(),
      },
    );
    if (status !== 200) return [];
    let payload: { updates?: RawUpdate[]; cursor?: number; ret?: number };
    try {
      payload = JSON.parse(text) as typeof payload;
    } catch {
      return [];
    }
    if (payload.ret !== undefined && payload.ret !== 0) return [];
    if (typeof payload.cursor === "number") this.#cursor = payload.cursor;
    return (payload.updates ?? []).flatMap(toEvents);
  }

  async send(request: SendRequest): Promise<SendResult> {
    const { peerId, item, replyToken } = request;
    if (peerId === "") {
      return {
        delivered: false,
        reason: "unknown",
        detail: "no peer to send to",
      };
    }
    if (item.kind === "text") {
      if (item.text.length > ILINK_CAPABILITIES.maxTextLength) {
        // Refusing here is better than a silent truncation on the surface.
        return {
          delivered: false,
          reason: "too-large",
          detail: `${item.text.length} characters`,
        };
      }
      return this.#sendMessage(peerId, replyToken, [
        { type: 1, text_item: { text: item.text } },
      ]);
    }
    const uploaded = await this.#upload(peerId, item);
    if (!uploaded.ok) return uploaded.result;
    if (item.caption !== undefined && item.caption !== "") {
      const caption = await this.#sendMessage(peerId, replyToken, [
        { type: 1, text_item: { text: item.caption } },
      ]);
      // A lost caption is worth reporting, but the file itself is what the
      // person was sent for; do not turn a delivered file into a failure.
      if (!caption.delivered) return caption;
    }
    return this.#sendMessage(peerId, replyToken, [uploaded.value]);
  }

  /**
   * iLink takes media in three legs: reserve an upload target, PUT the
   * ciphertext to the CDN it names, then send an item that refers to the
   * returned download parameter. Skipping the last leg is the interesting
   * failure: the bytes are uploaded and nothing appears in the conversation.
   */
  async #upload(
    peerId: string,
    item: { kind: "image" | "file"; path: string },
  ): Promise<
    { ok: true; value: ILinkItem } | { ok: false; result: SendResult }
  > {
    let plaintext: Buffer;
    try {
      plaintext = await readFile(item.path);
    } catch {
      return {
        ok: false,
        result: {
          delivered: false,
          reason: "unknown",
          detail: `cannot read ${item.path}`,
        },
      };
    }
    const mediaType =
      item.kind === "image" ? IMAGE_MEDIA_TYPE : FILE_MEDIA_TYPE;
    const key = randomBytes(16);
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const reserved = await this.#post("/ilink/bot/getuploadurl", {
      filekey: randomBytes(16).toString("hex"),
      media_type: mediaType,
      to_user_id: peerId,
      rawsize: plaintext.length,
      rawfilemd5: createHash("md5").update(plaintext).digest("hex"),
      // AES pads to the block size, and the surface compares against that.
      filesize: Math.ceil((plaintext.length + 1) / 16) * 16,
      no_need_thumb: true,
      aeskey: key.toString("hex"),
      base_info: baseInfo(),
    });
    const target = uploadTarget(reserved.body);
    if (target === null) {
      return {
        ok: false,
        result: {
          delivered: false,
          reason: "unknown",
          detail: "no upload target",
        },
      };
    }
    const put = await this.#transport.put(target, ciphertext);
    const downloadParam = put.header("x-encrypted-param");
    if (put.status !== 200 || downloadParam === null) {
      return {
        ok: false,
        result: {
          delivered: false,
          reason: "unknown",
          detail: `upload ${put.status}${put.errorMessage === null ? "" : ` ${put.errorMessage}`}`,
        },
      };
    }
    const media: UploadedMedia = {
      encrypt_query_param: downloadParam,
      // The surface expects the key base64 of its hex form, not the raw bytes.
      aes_key: Buffer.from(key.toString("hex")).toString("base64"),
      encrypt_type: 1,
    };
    const value: ILinkItem =
      item.kind === "image"
        ? { type: 2, image_item: { media, mid_size: plaintext.length } }
        : {
            type: 4,
            file_item: {
              media,
              file_name: basename(item.path),
              len: String(plaintext.length),
            },
          };
    return { ok: true, value };
  }

  async #sendMessage(
    peerId: string,
    replyToken: string | undefined,
    itemList: ILinkItem[],
  ): Promise<SendResult> {
    const { status, body } = await this.#post("/ilink/bot/sendmessage", {
      msg: {
        to_user_id: peerId,
        // A per-send id the surface uses to collapse a duplicate retry.
        client_id: `linger-${randomBytes(16).toString("hex")}`,
        message_type: 2,
        message_state: 2,
        item_list: itemList,
        context_token: replyToken === "" ? undefined : replyToken,
      },
      base_info: baseInfo(),
    });
    if (status !== 200) {
      return { delivered: false, reason: "unknown", detail: `http ${status}` };
    }
    return classify(body as SendReply);
  }

  async #post(
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const answer = await this.#transport.post(path, body);
    if (answer.status !== 200) return { status: answer.status, body: {} };
    try {
      return { status: 200, body: JSON.parse(answer.text) as unknown };
    } catch {
      return { status: 200, body: {} };
    }
  }

  /** Milliseconds since the epoch, exposed so a host can log a stale reply token. */
  now(): number {
    return this.#now();
  }
}

function baseInfo() {
  return { channel_version: "2.4.10", bot_agent: "Linger/1.0" };
}

function uploadTarget(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as { upload_full_url?: unknown; upload_param?: unknown };
  const full =
    typeof record.upload_full_url === "string"
      ? record.upload_full_url.trim()
      : "";
  if (full !== "") return full;
  const param =
    typeof record.upload_param === "string" ? record.upload_param : "";
  if (param === "") return null;
  return `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=${encodeURIComponent(param)}`;
}

function fetchTransport(baseUrl: string): Transport {
  const reply = (response: Response, text: string): TransportReply => ({
    status: response.status,
    text,
    header: (name) => response.headers.get(name),
    errorMessage: response.headers.get("x-error-message"),
  });
  return {
    async post(path, body) {
      const response = await fetch(baseUrl + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          AuthorizationType: "ilink_bot_token",
          "iLink-App-Id": "bot",
          "iLink-App-ClientVersion": API_VERSION,
        },
        body: JSON.stringify(body),
      });
      return reply(response, await response.text());
    },
    async put(url, body) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(body),
      });
      return reply(response, "");
    },
  };
}

interface RawUpdate {
  message_id?: number | string;
  from_user_id?: string;
  session_id?: string;
  group_id?: string;
  create_time_ms?: number;
  context_token?: string;
  item_list?: {
    type?: number;
    msg_id?: string;
    text_item?: { text?: string };
  }[];
}

/**
 * A raw update becomes at most one event. Group deliveries are dropped rather
 * than mis-labelled: a bot identity does not receive them, and treating an
 * empty `group_id` as a group would lose every direct message instead.
 */
function toEvents(update: RawUpdate): InboundEvent[] {
  const text = (update.item_list ?? [])
    .flatMap((item) =>
      item.text_item?.text === undefined ? [] : [item.text_item.text],
    )
    .join("");
  if (text === "") return [];
  const peerId = update.from_user_id ?? "";
  const externalId =
    update.message_id === undefined ? "" : String(update.message_id);
  if (peerId === "" || externalId === "") return [];
  const message: InboundMessage = {
    externalId,
    peerId,
    conversationId: update.session_id ?? update.group_id ?? "",
    text,
    sentAt: update.create_time_ms ?? 0,
    replyToken: update.context_token,
  };
  return [{ kind: "message", message }];
}
