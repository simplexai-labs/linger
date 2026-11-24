import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";

import { sleep } from "@linger/service-kit";
import type { JsonLogger } from "@linger/service-kit/node";

import type {
  AdapterRunContext,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelPairingProvider,
  InboundChannelAttachment,
  OutboundChannelMedia,
  OutboundChannelMessage,
  PairingPollResult,
  SendOutcome,
} from "../adapter.js";

// Protocol constants aligned with @tencent-weixin/openclaw-weixin v2.4.10.
export const WECHAT_ILINK_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const WECHAT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const ILINK_APP_ID = "bot";
const ILINK_CHANNEL_VERSION = "2.4.10";
const ILINK_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 10);
const ILINK_BOT_AGENT = "Linger/1.0";
const ILINK_BOT_TYPE = "3";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;
const DEFAULT_CDN_TIMEOUT_MS = 60_000;
const QR_POLL_TIMEOUT_MS = 35_000;
const PAIRING_TTL_MS = 10 * 60_000;
const STALE_TOKEN_ERRCODE = -14;
const COOLDOWN_DURATION_MS = 60 * 60 * 1000;
const TYPING_TICKET_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const CONFLICT_BACKOFF_MS = 60_000;
const MAX_INBOUND_MEDIA_ITEMS = 5;
const MAX_INBOUND_MEDIA_BYTES = 25 * 1024 * 1024;

const MESSAGE_TYPE_USER = 1;
const MESSAGE_TYPE_BOT = 2;
const MESSAGE_STATE_FINISH = 2;
const ITEM_TYPE_TEXT = 1;
const ITEM_TYPE_IMAGE = 2;
const ITEM_TYPE_VOICE = 3;
const ITEM_TYPE_FILE = 4;
const ITEM_TYPE_VIDEO = 5;
const UPLOAD_MEDIA_IMAGE = 1;
const UPLOAD_MEDIA_VIDEO = 2;
const UPLOAD_MEDIA_FILE = 3;
const TYPING_START = 1;
const TYPING_CANCEL = 2;

const LOSSLESS_ID_FIELDS = new Set(["message_id", "msg_id", "svr_id"]);

export const WECHAT_CAPABILITIES: ChannelCapabilities = Object.freeze({
  maxTextChars: 3800,
  supportsClickableLinks: false,
  supportsTyping: true,
  supportsMarkdown: false,
});

interface WeixinCdnMedia {
  readonly encrypt_query_param?: string;
  readonly aes_key?: string;
  readonly encrypt_type?: number;
  readonly full_url?: string;
}

interface WeixinMessageItem {
  readonly type?: number;
  readonly text_item?: { readonly text?: string };
  readonly voice_item?: { readonly text?: string };
  readonly image_item?: {
    readonly media?: WeixinCdnMedia;
    readonly aeskey?: string;
    readonly url?: string;
  };
  readonly file_item?: {
    readonly media?: WeixinCdnMedia;
    readonly file_name?: string;
    readonly len?: string;
  };
  readonly video_item?: {
    readonly media?: WeixinCdnMedia;
    readonly video_size?: number;
  };
}

interface GetUploadUrlResp {
  readonly upload_param?: string;
  readonly upload_full_url?: string;
  readonly ret?: number;
  readonly errcode?: number;
  readonly errmsg?: string;
}

interface WeixinMessage {
  readonly message_id?: string;
  readonly seq?: number;
  readonly from_user_id?: string;
  readonly to_user_id?: string;
  readonly create_time_ms?: number;
  readonly group_id?: string;
  readonly message_type?: number;
  readonly item_list?: readonly WeixinMessageItem[];
  readonly context_token?: string;
}

interface GetUpdatesResp {
  readonly ret?: number;
  readonly errcode?: number;
  readonly errmsg?: string;
  readonly msgs?: readonly WeixinMessage[];
  readonly get_updates_buf?: string;
  readonly longpolling_timeout_ms?: number;
}

interface SendMessageResp {
  readonly message_id?: string;
  readonly ret?: number;
  readonly errcode?: number;
  readonly errmsg?: string;
}

interface GetConfigResp {
  readonly ret?: number;
  readonly errmsg?: string;
  readonly typing_ticket?: string;
}

interface QRCodeResp {
  readonly qrcode: string;
  readonly qrcode_img_content: string;
}

interface QRStatusResp {
  readonly status:
    | "wait"
    | "scaned"
    | "confirmed"
    | "expired"
    | "scaned_but_redirect"
    | "need_verifycode"
    | "verify_code_blocked"
    | "binded_redirect";
  readonly bot_token?: string;
  readonly ilink_bot_id?: string;
  readonly baseurl?: string;
  readonly ilink_user_id?: string;
  readonly redirect_host?: string;
}

/**
 * Quotes uint64 message identifier fields before JSON.parse so 64-bit WeChat
 * IDs do not lose precision in JS numbers.
 */
export function parseWeixinApiJson<T>(rawText: string): T {
  let output = "";
  let index = 0;
  while (index < rawText.length) {
    if (rawText[index] !== '"') {
      output += rawText[index++];
      continue;
    }
    const stringStart = index;
    index++;
    let escaped = false;
    while (index < rawText.length) {
      const ch = rawText[index++];
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        break;
      }
    }
    const stringToken = rawText.slice(stringStart, index);
    output += stringToken;

    let cursor = index;
    while (/\s/.test(rawText[cursor] ?? "")) cursor++;
    if (rawText[cursor] !== ":") continue;

    let key: unknown;
    try {
      key = JSON.parse(stringToken);
    } catch {
      continue;
    }
    if (typeof key !== "string" || !LOSSLESS_ID_FIELDS.has(key)) continue;

    output += rawText.slice(index, cursor + 1);
    cursor++;
    while (/\s/.test(rawText[cursor] ?? "")) {
      output += rawText[cursor++];
    }
    const numberStart = cursor;
    if (rawText[cursor] === "-") cursor++;
    while (/\d/.test(rawText[cursor] ?? "")) cursor++;
    if (
      cursor > numberStart &&
      !(cursor === numberStart + 1 && rawText[numberStart] === "-")
    ) {
      output += `"${rawText.slice(numberStart, cursor)}"`;
      index = cursor;
    } else {
      index = numberStart;
    }
  }
  return JSON.parse(output) as T;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildBaseInfo(): {
  readonly channel_version: string;
  readonly bot_agent: string;
} {
  return {
    channel_version: ILINK_CHANNEL_VERSION,
    bot_agent: ILINK_BOT_AGENT,
  };
}

function buildCommonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": ILINK_CLIENT_VERSION,
  };
}

function buildPostHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...buildCommonHeaders(),
  };
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

class HttpStatusError extends Error {
  readonly status: number;

  constructor(label: string, status: number, body: string) {
    super(`${label} HTTP ${String(status)}: ${body.slice(0, 200)}`);
    this.status = status;
  }
}

async function ilinkGet(params: {
  baseUrl: string;
  endpoint: string;
  timeoutMs: number;
  label: string;
  fetchImpl: typeof fetch;
}): Promise<string> {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl));
  const res = await params.fetchImpl(url.toString(), {
    method: "GET",
    headers: buildCommonHeaders(),
    signal: AbortSignal.timeout(params.timeoutMs),
  });
  const raw = await res.text();
  if (!res.ok) throw new HttpStatusError(params.label, res.status, raw);
  return raw;
}

async function ilinkPost(params: {
  baseUrl: string;
  endpoint: string;
  body: Record<string, unknown>;
  token?: string;
  timeoutMs: number;
  label: string;
  fetchImpl: typeof fetch;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl));
  const timeoutSignal = AbortSignal.timeout(params.timeoutMs);
  const signal = params.abortSignal
    ? AbortSignal.any([timeoutSignal, params.abortSignal])
    : timeoutSignal;
  const res = await params.fetchImpl(url.toString(), {
    method: "POST",
    headers: buildPostHeaders(params.token),
    body: JSON.stringify(params.body),
    signal,
  });
  const raw = await res.text();
  if (!res.ok) throw new HttpStatusError(params.label, res.status, raw);
  return raw;
}

function encryptAesEcb(plaintext: Uint8Array, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptAesEcb(ciphertext: Uint8Array, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/**
 * Parses WeChat CDNMedia.aes_key (either base64(16 raw bytes) or
 * base64(32 ASCII hex chars)) or hex image_item.aeskey into a 16-byte Buffer.
 */
function parseWeChatAesKey(
  base64Key?: string,
  hexKey?: string,
): Buffer | undefined {
  if (hexKey && /^[0-9a-fA-F]{32}$/.test(hexKey.trim())) {
    return Buffer.from(hexKey.trim(), "hex");
  }
  if (!base64Key?.trim()) return undefined;
  const decoded = Buffer.from(base64Key.trim(), "base64");
  if (decoded.length === 16) return decoded;
  if (
    decoded.length === 32 &&
    /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))
  ) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  return undefined;
}

function sniffImageFormat(bytes: Uint8Array): { ext: string; mime: string } {
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { ext: ".png", mime: "image/png" };
  }
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46
  ) {
    return { ext: ".gif", mime: "image/gif" };
  }
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45
  ) {
    return { ext: ".webp", mime: "image/webp" };
  }
  return { ext: ".jpg", mime: "image/jpeg" };
}

/** Extracts plain text from an inbound WeChat message, including server ASR for voice notes. */
export function extractWeChatInboundText(
  message: WeixinMessage,
): string | undefined {
  if (message.message_type !== MESSAGE_TYPE_USER) return undefined;
  if (message.group_id?.trim()) return undefined;
  const items = message.item_list ?? [];
  const parts: string[] = [];
  for (const item of items) {
    if (item.type === ITEM_TYPE_TEXT) {
      const text = item.text_item?.text?.trim();
      if (text) parts.push(text);
    } else if (item.type === ITEM_TYPE_VOICE) {
      const transcript = item.voice_item?.text?.trim();
      if (transcript) parts.push(transcript);
    }
  }
  const combined = parts.join("\n").trim();
  return combined || undefined;
}

interface ActiveWeChatPairing {
  readonly pairingId: string;
  readonly qrcode: string;
  readonly qrCodeUrl: string;
  readonly startedAt: number;
  currentBaseUrl: string;
  pendingVerifyCode?: string;
}

export interface WeChatPairingOptions {
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  readonly logger: JsonLogger;
}

/** Manages interactive QR-scan pairing sessions against WeChat iLink v2.4.10. */
export class WeChatPairingManager implements ChannelPairingProvider {
  readonly provider = "wechat" as const;
  readonly #fetchImpl: typeof fetch;
  readonly #baseUrl: string;
  readonly #logger: JsonLogger;
  readonly #sessions = new Map<string, ActiveWeChatPairing>();

  constructor(options: WeChatPairingOptions) {
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#baseUrl = options.baseUrl ?? WECHAT_ILINK_DEFAULT_BASE_URL;
    this.#logger = options.logger;
  }

  async startPairing(
    localTokens: readonly string[] = [],
  ): Promise<PairingPollResult> {
    this.#pruneExpired();
    const raw = await ilinkPost({
      baseUrl: this.#baseUrl,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(ILINK_BOT_TYPE)}`,
      body: { local_token_list: localTokens.slice(0, 10) },
      timeoutMs: DEFAULT_API_TIMEOUT_MS,
      label: "getBotQrcode",
      fetchImpl: this.#fetchImpl,
    });
    const parsed = JSON.parse(raw) as QRCodeResp;
    if (!parsed.qrcode || !parsed.qrcode_img_content) {
      throw new Error("WeChat iLink returned an incomplete QR payload");
    }
    const pairingId = `wxp_${randomUUID().replace(/-/g, "")}`;
    this.#sessions.set(pairingId, {
      pairingId,
      qrcode: parsed.qrcode,
      qrCodeUrl: parsed.qrcode_img_content,
      startedAt: Date.now(),
      currentBaseUrl: this.#baseUrl,
    });
    return {
      pairingId,
      provider: "wechat",
      status: "waiting_scan",
      qrCodeUrl: parsed.qrcode_img_content,
    };
  }

  async pollPairing(pairingId: string): Promise<PairingPollResult | undefined> {
    this.#pruneExpired();
    const session = this.#sessions.get(pairingId);
    if (!session) return undefined;
    return this.#pollOnce(session);
  }

  async submitVerifyCode(
    pairingId: string,
    verifyCode: string,
  ): Promise<PairingPollResult | undefined> {
    this.#pruneExpired();
    const session = this.#sessions.get(pairingId);
    if (!session) return undefined;
    session.pendingVerifyCode = verifyCode.trim();
    return this.#pollOnce(session);
  }

  async #pollOnce(session: ActiveWeChatPairing): Promise<PairingPollResult> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.qrcode)}`;
    if (session.pendingVerifyCode) {
      endpoint += `&verify_code=${encodeURIComponent(session.pendingVerifyCode)}`;
    }
    let resp: QRStatusResp;
    try {
      const raw = await ilinkGet({
        baseUrl: session.currentBaseUrl,
        endpoint,
        timeoutMs: QR_POLL_TIMEOUT_MS,
        label: "getQrcodeStatus",
        fetchImpl: this.#fetchImpl,
      });
      resp = JSON.parse(raw) as QRStatusResp;
    } catch (err) {
      // Client or gateway long-poll timeout is normal while waiting for a scan.
      if (err instanceof Error && err.name === "TimeoutError") {
        return {
          pairingId: session.pairingId,
          provider: "wechat",
          status: "waiting_scan",
          qrCodeUrl: session.qrCodeUrl,
        };
      }
      this.#logger.log("warn", "channels.wechat_qr_poll_transient_error", {
        pairing_id: session.pairingId,
        error: String(err),
      });
      return {
        pairingId: session.pairingId,
        provider: "wechat",
        status: "waiting_scan",
        qrCodeUrl: session.qrCodeUrl,
      };
    }

    switch (resp.status) {
      case "wait":
        return {
          pairingId: session.pairingId,
          provider: "wechat",
          status: "waiting_scan",
          qrCodeUrl: session.qrCodeUrl,
        };
      case "scaned":
        session.pendingVerifyCode = undefined;
        return {
          pairingId: session.pairingId,
          provider: "wechat",
          status: "scanned",
          qrCodeUrl: session.qrCodeUrl,
        };
      case "scaned_but_redirect":
        if (resp.redirect_host) {
          session.currentBaseUrl = `https://${resp.redirect_host}`;
        }
        return {
          pairingId: session.pairingId,
          provider: "wechat",
          status: "scanned",
          qrCodeUrl: session.qrCodeUrl,
        };
      case "need_verifycode":
        return {
          pairingId: session.pairingId,
          provider: "wechat",
          status: "need_verify_code",
          qrCodeUrl: session.qrCodeUrl,
        };
      case "verify_code_blocked":
        session.pendingVerifyCode = undefined;
        this.#sessions.delete(session.pairingId);
        return {
          pairingId: session.pairingId,
          provider: "wechat",
          status: "verify_code_blocked",
          errorCode: "WECHAT_VERIFY_CODE_BLOCKED",
        };
      case "binded_redirect":
        this.#sessions.delete(session.pairingId);
        return {
          pairingId: session.pairingId,
          provider: "wechat",
          status: "already_connected",
        };
      case "expired":
        this.#sessions.delete(session.pairingId);
        return {
          pairingId: session.pairingId,
          provider: "wechat",
          status: "expired",
          errorCode: "WECHAT_QR_EXPIRED",
        };
      case "confirmed": {
        this.#sessions.delete(session.pairingId);
        if (!resp.bot_token || !resp.ilink_bot_id) {
          return {
            pairingId: session.pairingId,
            provider: "wechat",
            status: "failed",
            errorCode: "WECHAT_PAIRING_INCOMPLETE",
          };
        }
        return {
          pairingId: session.pairingId,
          provider: "wechat",
          status: "confirmed",
          credentials: {
            bot_token: resp.bot_token,
            base_url: resp.baseurl || session.currentBaseUrl,
          },
          config: {
            bot_id: resp.ilink_bot_id,
            ...(resp.ilink_user_id
              ? { remote_user_id: resp.ilink_user_id }
              : {}),
            display_label: "WeChat",
          },
        };
      }
    }
  }

  #pruneExpired(): void {
    const cutoff = Date.now() - PAIRING_TTL_MS;
    for (const [id, session] of this.#sessions) {
      if (session.startedAt < cutoff) {
        this.#sessions.delete(id);
      }
    }
  }
}

export interface WeChatAdapterOptions {
  readonly bindingId: string;
  readonly botToken: string;
  readonly baseUrl?: string;
  readonly remoteUserId?: string;
  readonly initialState?: Record<string, unknown>;
  readonly initialCooldownUntilMs?: number;
  readonly logger: JsonLogger;
  readonly fetchImpl?: typeof fetch;
}

/** Runs one WeChat ClawBot iLink long-poll loop and outbound sender. */
export class WeChatClawBotAdapter implements ChannelAdapter {
  readonly provider = "wechat" as const;
  readonly capabilities = WECHAT_CAPABILITIES;

  readonly #bindingId: string;
  readonly #botToken: string;
  readonly #baseUrl: string;
  readonly #logger: JsonLogger;
  readonly #fetchImpl: typeof fetch;

  #remoteUserId: string | undefined;
  #getUpdatesBuf: string;
  #lastContextToken: string | undefined;
  #typingTicket: string | undefined;
  #typingTicketFetchedAt = 0;
  #cooldownUntilMs: number;

  constructor(options: WeChatAdapterOptions) {
    this.#bindingId = options.bindingId;
    this.#botToken = options.botToken;
    this.#baseUrl = options.baseUrl || WECHAT_ILINK_DEFAULT_BASE_URL;
    this.#remoteUserId = options.remoteUserId;
    this.#logger = options.logger;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#getUpdatesBuf =
      typeof options.initialState?.get_updates_buf === "string"
        ? options.initialState.get_updates_buf
        : "";
    this.#lastContextToken =
      typeof options.initialState?.last_context_token === "string"
        ? options.initialState.last_context_token
        : undefined;
    this.#typingTicket =
      typeof options.initialState?.typing_ticket === "string"
        ? options.initialState.typing_ticket
        : undefined;
    this.#cooldownUntilMs = options.initialCooldownUntilMs ?? 0;
  }

  async start(ctx: AdapterRunContext): Promise<void> {
    await this.#notifyBestEffort("ilink/bot/msg/notifystart");
    let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
    let consecutiveFailures = 0;
    let markedConnected = false;

    try {
      while (!ctx.signal.aborted) {
        const remainingCooldown = this.#cooldownUntilMs - Date.now();
        if (remainingCooldown > 0) {
          await sleep(remainingCooldown, ctx.signal).catch(() => undefined);
          continue;
        }

        try {
          const resp = await this.#getUpdates(nextTimeoutMs, ctx.signal);
          if (
            resp.longpolling_timeout_ms != null &&
            resp.longpolling_timeout_ms > 0
          ) {
            nextTimeoutMs = resp.longpolling_timeout_ms;
          }

          const isApiError =
            (resp.ret !== undefined && resp.ret !== 0) ||
            (resp.errcode !== undefined && resp.errcode !== 0);
          if (isApiError) {
            const isStale =
              resp.errcode === STALE_TOKEN_ERRCODE ||
              resp.ret === STALE_TOKEN_ERRCODE;
            if (isStale) {
              this.#cooldownUntilMs = Date.now() + COOLDOWN_DURATION_MS;
              markedConnected = false;
              consecutiveFailures = 0;
              await ctx.onStatus({
                runtimeStatus: "cooldown",
                errorCode: "WECHAT_SESSION_COOLDOWN",
                cooldownUntil: new Date(this.#cooldownUntilMs).toISOString(),
              });
              this.#logger.log("warn", "channels.wechat_session_cooldown", {
                binding_id: this.#bindingId,
                errcode: STALE_TOKEN_ERRCODE,
              });
              await sleep(COOLDOWN_DURATION_MS, ctx.signal).catch(
                () => undefined,
              );
              continue;
            }
            consecutiveFailures += 1;
            markedConnected = false;
            await ctx.onStatus({
              runtimeStatus: "error",
              errorCode: "WECHAT_API_ERROR",
            });
            const delayMs =
              consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
                ? BACKOFF_DELAY_MS
                : RETRY_DELAY_MS;
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              consecutiveFailures = 0;
            }
            await sleep(delayMs, ctx.signal).catch(() => undefined);
            continue;
          }

          consecutiveFailures = 0;
          const nextBuf =
            resp.get_updates_buf && resp.get_updates_buf !== ""
              ? resp.get_updates_buf
              : undefined;
          if (nextBuf) {
            this.#getUpdatesBuf = nextBuf;
          }
          if (!markedConnected || nextBuf) {
            markedConnected = true;
            await ctx.onStatus({
              runtimeStatus: "connected",
              errorCode: null,
              cooldownUntil: null,
              ...(nextBuf
                ? { adapterStatePatch: { get_updates_buf: nextBuf } }
                : {}),
            });
          }

          for (const msg of resp.msgs ?? []) {
            if (ctx.signal.aborted) return;
            await this.#handleInboundMessage(msg, ctx);
          }
        } catch (err) {
          if (ctx.signal.aborted) return;
          if (err instanceof HttpStatusError && err.status === 403) {
            markedConnected = false;
            await ctx.onStatus({
              runtimeStatus: "conflict",
              errorCode: "WECHAT_CONFLICT",
            });
            this.#logger.log("warn", "channels.wechat_poll_conflict", {
              binding_id: this.#bindingId,
            });
            await sleep(CONFLICT_BACKOFF_MS, ctx.signal).catch(() => undefined);
            continue;
          }
          consecutiveFailures += 1;
          markedConnected = false;
          this.#logger.log("warn", "channels.wechat_poll_error", {
            binding_id: this.#bindingId,
            failures: consecutiveFailures,
            error: String(err),
          });
          await ctx.onStatus({
            runtimeStatus: "error",
            errorCode: "WECHAT_NETWORK_ERROR",
          });
          const delayMs =
            consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
              ? BACKOFF_DELAY_MS
              : RETRY_DELAY_MS;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            consecutiveFailures = 0;
          }
          await sleep(delayMs, ctx.signal).catch(() => undefined);
        }
      }
    } finally {
      await this.#notifyBestEffort("ilink/bot/msg/notifystop");
    }
  }

  async sendText(message: OutboundChannelMessage): Promise<SendOutcome> {
    const remainingMs = this.#cooldownUntilMs - Date.now();
    if (remainingMs > 0) {
      return {
        ok: false,
        retryable: false,
        errorCode: "WECHAT_SESSION_COOLDOWN",
        runtimeStatus: "cooldown",
        cooldownSec: Math.ceil(remainingMs / 1000),
      };
    }
    if (!this.#remoteUserId) {
      return {
        ok: false,
        retryable: false,
        errorCode: "WECHAT_RECIPIENT_UNKNOWN",
      };
    }

    const clientId = `linger-${randomUUID()}`;
    try {
      const raw = await ilinkPost({
        baseUrl: this.#baseUrl,
        endpoint: "ilink/bot/sendmessage",
        body: {
          msg: {
            from_user_id: "",
            to_user_id: this.#remoteUserId,
            client_id: clientId,
            message_type: MESSAGE_TYPE_BOT,
            message_state: MESSAGE_STATE_FINISH,
            item_list: [
              {
                type: ITEM_TYPE_TEXT,
                text_item: { text: message.text },
              },
            ],
            ...(this.#lastContextToken
              ? { context_token: this.#lastContextToken }
              : {}),
          },
          base_info: buildBaseInfo(),
        },
        token: this.#botToken,
        timeoutMs: DEFAULT_API_TIMEOUT_MS,
        label: "sendMessage",
        fetchImpl: this.#fetchImpl,
      });
      const resp = raw.trim() ? parseWeixinApiJson<SendMessageResp>(raw) : {};
      if (
        resp.errcode === STALE_TOKEN_ERRCODE ||
        resp.ret === STALE_TOKEN_ERRCODE
      ) {
        this.#cooldownUntilMs = Date.now() + COOLDOWN_DURATION_MS;
        return {
          ok: false,
          retryable: false,
          errorCode: "WECHAT_SESSION_COOLDOWN",
          runtimeStatus: "cooldown",
          cooldownSec: Math.ceil(COOLDOWN_DURATION_MS / 1000),
        };
      }
      if (
        (resp.ret && resp.ret !== 0) ||
        (resp.errcode && resp.errcode !== 0)
      ) {
        return {
          ok: false,
          retryable: false,
          errorCode: "WECHAT_SEND_REJECTED",
        };
      }
      return { ok: true };
    } catch (err) {
      if (err instanceof HttpStatusError && err.status === 403) {
        return {
          ok: false,
          retryable: false,
          errorCode: "WECHAT_CONFLICT",
          runtimeStatus: "conflict",
        };
      }
      this.#logger.log("warn", "channels.wechat_send_failed", {
        binding_id: this.#bindingId,
        room_seq: message.roomSeq,
        error: String(err),
      });
      return {
        ok: false,
        retryable: true,
        errorCode: "WECHAT_NETWORK_ERROR",
      };
    }
  }

  async sendMedia(media: OutboundChannelMedia): Promise<SendOutcome> {
    const remainingMs = this.#cooldownUntilMs - Date.now();
    if (remainingMs > 0) {
      return {
        ok: false,
        retryable: false,
        errorCode: "WECHAT_SESSION_COOLDOWN",
        runtimeStatus: "cooldown",
        cooldownSec: Math.ceil(remainingMs / 1000),
      };
    }
    if (!this.#remoteUserId) {
      return {
        ok: false,
        retryable: false,
        errorCode: "WECHAT_RECIPIENT_UNKNOWN",
      };
    }
    const mime = (media.mediaType ?? "").toLowerCase();
    const isImage = mime.startsWith("image/");
    const isVideo = mime.startsWith("video/");
    const uploadMediaType = isImage
      ? UPLOAD_MEDIA_IMAGE
      : isVideo
        ? UPLOAD_MEDIA_VIDEO
        : UPLOAD_MEDIA_FILE;
    const rawsize = media.bytes.byteLength;
    const rawfilemd5 = createHash("md5").update(media.bytes).digest("hex");
    const filesize = aesEcbPaddedSize(rawsize);
    const filekey = randomBytes(16).toString("hex");
    const aeskey = randomBytes(16);
    const aeskeyHex = aeskey.toString("hex");

    try {
      const uploadUrlRaw = await ilinkPost({
        baseUrl: this.#baseUrl,
        endpoint: "ilink/bot/getuploadurl",
        body: {
          filekey,
          media_type: uploadMediaType,
          to_user_id: this.#remoteUserId,
          rawsize,
          rawfilemd5,
          filesize,
          no_need_thumb: true,
          aeskey: aeskeyHex,
          base_info: buildBaseInfo(),
        },
        token: this.#botToken,
        timeoutMs: DEFAULT_API_TIMEOUT_MS,
        label: "getUploadUrl",
        fetchImpl: this.#fetchImpl,
      });
      const uploadResp = JSON.parse(uploadUrlRaw) as GetUploadUrlResp;
      if (
        uploadResp.errcode === STALE_TOKEN_ERRCODE ||
        uploadResp.ret === STALE_TOKEN_ERRCODE
      ) {
        this.#cooldownUntilMs = Date.now() + COOLDOWN_DURATION_MS;
        return {
          ok: false,
          retryable: false,
          errorCode: "WECHAT_SESSION_COOLDOWN",
          runtimeStatus: "cooldown",
          cooldownSec: Math.ceil(COOLDOWN_DURATION_MS / 1000),
        };
      }
      const cdnUrl =
        uploadResp.upload_full_url?.trim() ||
        (uploadResp.upload_param
          ? `${WECHAT_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadResp.upload_param)}&filekey=${encodeURIComponent(filekey)}`
          : undefined);
      if (!cdnUrl) {
        return {
          ok: false,
          retryable: false,
          errorCode: "WECHAT_CDN_UPLOAD_URL_MISSING",
        };
      }
      const ciphertext = encryptAesEcb(media.bytes, aeskey);
      const cdnRes = await this.#fetchImpl(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
        signal: AbortSignal.timeout(DEFAULT_CDN_TIMEOUT_MS),
      });
      if (!cdnRes.ok) {
        return {
          ok: false,
          retryable: cdnRes.status >= 500,
          errorCode: "WECHAT_CDN_UPLOAD_FAILED",
        };
      }
      const downloadParam = cdnRes.headers.get("x-encrypted-param")?.trim();
      if (!downloadParam) {
        return {
          ok: false,
          retryable: false,
          errorCode: "WECHAT_CDN_PARAM_MISSING",
        };
      }

      const mediaRef = {
        encrypt_query_param: downloadParam,
        aes_key: Buffer.from(aeskeyHex).toString("base64"),
        encrypt_type: 1,
      };
      const item = isImage
        ? {
            type: ITEM_TYPE_IMAGE,
            image_item: { media: mediaRef, mid_size: filesize },
          }
        : isVideo
          ? {
              type: ITEM_TYPE_VIDEO,
              video_item: { media: mediaRef, video_size: filesize },
            }
          : {
              type: ITEM_TYPE_FILE,
              file_item: {
                media: mediaRef,
                file_name: media.filename,
                len: String(rawsize),
              },
            };

      const raw = await ilinkPost({
        baseUrl: this.#baseUrl,
        endpoint: "ilink/bot/sendmessage",
        body: {
          msg: {
            from_user_id: "",
            to_user_id: this.#remoteUserId,
            client_id: `linger-${randomUUID()}`,
            message_type: MESSAGE_TYPE_BOT,
            message_state: MESSAGE_STATE_FINISH,
            item_list: [item],
            ...(this.#lastContextToken
              ? { context_token: this.#lastContextToken }
              : {}),
          },
          base_info: buildBaseInfo(),
        },
        token: this.#botToken,
        timeoutMs: DEFAULT_API_TIMEOUT_MS,
        label: "sendMediaMessage",
        fetchImpl: this.#fetchImpl,
      });
      const resp = raw.trim() ? parseWeixinApiJson<SendMessageResp>(raw) : {};
      if (
        (resp.ret && resp.ret !== 0) ||
        (resp.errcode && resp.errcode !== 0)
      ) {
        return {
          ok: false,
          retryable: false,
          errorCode: "WECHAT_SEND_REJECTED",
        };
      }
      return { ok: true };
    } catch (err) {
      if (err instanceof HttpStatusError && err.status === 403) {
        return {
          ok: false,
          retryable: false,
          errorCode: "WECHAT_CONFLICT",
          runtimeStatus: "conflict",
        };
      }
      this.#logger.log("warn", "channels.wechat_media_send_failed", {
        binding_id: this.#bindingId,
        room_seq: media.roomSeq,
        error: String(err),
      });
      return {
        ok: false,
        retryable: true,
        errorCode: "WECHAT_NETWORK_ERROR",
      };
    }
  }

  async setTyping(active: boolean): Promise<void> {
    if (!this.#remoteUserId || this.#cooldownUntilMs > Date.now()) return;
    const ticket = await this.#ensureTypingTicket();
    if (!ticket) return;
    try {
      await ilinkPost({
        baseUrl: this.#baseUrl,
        endpoint: "ilink/bot/sendtyping",
        body: {
          ilink_user_id: this.#remoteUserId,
          typing_ticket: ticket,
          status: active ? TYPING_START : TYPING_CANCEL,
          base_info: buildBaseInfo(),
        },
        token: this.#botToken,
        timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
        label: "sendTyping",
        fetchImpl: this.#fetchImpl,
      });
    } catch {
      // Typing indicator is best-effort.
    }
  }

  async #handleInboundMessage(
    msg: WeixinMessage,
    ctx: AdapterRunContext,
  ): Promise<void> {
    const sender = msg.from_user_id?.trim();
    if (!sender) return;
    if (this.#remoteUserId && sender !== this.#remoteUserId) return;
    if (!this.#remoteUserId) {
      this.#remoteUserId = sender;
    }

    const patch: Record<string, unknown> = {
      last_user_msg_at: new Date().toISOString(),
    };
    if (this.#getUpdatesBuf) {
      patch.get_updates_buf = this.#getUpdatesBuf;
    }
    if (msg.context_token) {
      this.#lastContextToken = msg.context_token;
      patch.last_context_token = msg.context_token;
    }

    const text = extractWeChatInboundText(msg) ?? "";
    const attachments = await this.#downloadInboundAttachments(msg);
    if (!text && attachments.length === 0) return;

    const externalId =
      msg.message_id?.trim() ||
      (typeof msg.seq === "number" ? `seq-${String(msg.seq)}` : randomUUID());
    await ctx.onInbound({
      externalId,
      senderExternalId: sender,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      receivedAtMs: msg.create_time_ms ?? Date.now(),
      adapterStatePatch: patch,
    });
  }

  async #downloadInboundAttachments(
    msg: WeixinMessage,
  ): Promise<InboundChannelAttachment[]> {
    if (msg.message_type !== MESSAGE_TYPE_USER || msg.group_id?.trim()) {
      return [];
    }
    const out: InboundChannelAttachment[] = [];
    for (const item of msg.item_list ?? []) {
      if (out.length >= MAX_INBOUND_MEDIA_ITEMS) break;
      let media: WeixinCdnMedia | undefined;
      let hexKey: string | undefined;
      let directUrl: string | undefined;
      let defaultName: string;
      let mediaType: string | undefined;

      if (item.type === ITEM_TYPE_IMAGE && item.image_item) {
        media = item.image_item.media;
        hexKey = item.image_item.aeskey;
        directUrl = item.image_item.url;
        defaultName = "image.jpg";
        mediaType = "image/jpeg";
      } else if (item.type === ITEM_TYPE_FILE && item.file_item) {
        media = item.file_item.media;
        defaultName = item.file_item.file_name?.trim() || "file.bin";
      } else if (item.type === ITEM_TYPE_VIDEO && item.video_item) {
        media = item.video_item.media;
        defaultName = "video.mp4";
        mediaType = "video/mp4";
      } else {
        continue;
      }

      const downloadUrl =
        media?.full_url?.trim() ||
        (media?.encrypt_query_param
          ? `${WECHAT_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
          : directUrl?.trim());
      if (!downloadUrl) continue;

      try {
        const res = await this.#fetchImpl(downloadUrl, {
          method: "GET",
          signal: AbortSignal.timeout(DEFAULT_CDN_TIMEOUT_MS),
        });
        if (!res.ok) continue;
        const lengthHeader = Number(res.headers.get("content-length"));
        if (
          Number.isFinite(lengthHeader) &&
          lengthHeader > MAX_INBOUND_MEDIA_BYTES
        ) {
          await res.body?.cancel();
          continue;
        }
        const rawBytes = new Uint8Array(await res.arrayBuffer());
        if (
          rawBytes.byteLength === 0 ||
          rawBytes.byteLength > MAX_INBOUND_MEDIA_BYTES
        ) {
          continue;
        }
        const aesKey = parseWeChatAesKey(media?.aes_key, hexKey);
        const plain = aesKey
          ? new Uint8Array(decryptAesEcb(rawBytes, aesKey))
          : rawBytes;
        let filename = defaultName;
        if (item.type === ITEM_TYPE_IMAGE) {
          const sniffed = sniffImageFormat(plain);
          filename = `image-${String(out.length + 1)}${sniffed.ext}`;
          mediaType = sniffed.mime;
        }
        out.push({
          filename,
          ...(mediaType ? { mediaType } : {}),
          bytes: plain,
        });
      } catch (err) {
        this.#logger.log("warn", "channels.wechat_inbound_media_failed", {
          binding_id: this.#bindingId,
          item_type: item.type,
          error: String(err),
        });
      }
    }
    return out;
  }

  async #getUpdates(
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<GetUpdatesResp> {
    try {
      const raw = await ilinkPost({
        baseUrl: this.#baseUrl,
        endpoint: "ilink/bot/getupdates",
        body: {
          get_updates_buf: this.#getUpdatesBuf,
          base_info: buildBaseInfo(),
        },
        token: this.#botToken,
        timeoutMs,
        label: "getUpdates",
        fetchImpl: this.#fetchImpl,
        abortSignal: signal,
      });
      return parseWeixinApiJson<GetUpdatesResp>(raw);
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === "AbortError" || err.name === "TimeoutError")
      ) {
        return { ret: 0, msgs: [], get_updates_buf: this.#getUpdatesBuf };
      }
      throw err;
    }
  }

  async #ensureTypingTicket(): Promise<string | undefined> {
    if (
      this.#typingTicket &&
      Date.now() - this.#typingTicketFetchedAt < TYPING_TICKET_TTL_MS
    ) {
      return this.#typingTicket;
    }
    if (!this.#remoteUserId) return undefined;
    try {
      const raw = await ilinkPost({
        baseUrl: this.#baseUrl,
        endpoint: "ilink/bot/getconfig",
        body: {
          ilink_user_id: this.#remoteUserId,
          ...(this.#lastContextToken
            ? { context_token: this.#lastContextToken }
            : {}),
          base_info: buildBaseInfo(),
        },
        token: this.#botToken,
        timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
        label: "getConfig",
        fetchImpl: this.#fetchImpl,
      });
      const resp = JSON.parse(raw) as GetConfigResp;
      if (resp.typing_ticket) {
        this.#typingTicket = resp.typing_ticket;
        this.#typingTicketFetchedAt = Date.now();
      }
    } catch {
      // Typing ticket fetch is best-effort.
    }
    return this.#typingTicket;
  }

  async #notifyBestEffort(endpoint: string): Promise<void> {
    try {
      await ilinkPost({
        baseUrl: this.#baseUrl,
        endpoint,
        body: { base_info: buildBaseInfo() },
        token: this.#botToken,
        timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
        label: endpoint,
        fetchImpl: this.#fetchImpl,
      });
    } catch {
      // Lifecycle notifications are best-effort.
    }
  }
}
