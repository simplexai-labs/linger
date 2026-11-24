import { setTimeout as delay } from "node:timers/promises";

import type { components } from "@linger/wire-contracts/teamhub-internal/types";

export type InternalIMChannelBinding =
  components["schemas"]["InternalIMChannelBinding"];
export type InternalIMChannelStatusReport =
  components["schemas"]["InternalIMChannelStatusReport"];
export type InternalIMChannelInboundRequest =
  components["schemas"]["InternalIMChannelInboundRequest"];
export type InternalIMChannelInboundResponse =
  components["schemas"]["InternalIMChannelInboundResponse"];
export type InternalIMChannelOutboundEvent =
  components["schemas"]["InternalIMChannelOutboundEvent"];
export type InternalIMChannelOutboundPage =
  components["schemas"]["InternalIMChannelOutboundPage"];

export interface DownloadedChannelDocument {
  readonly bytes: Uint8Array;
  readonly filename?: string;
  readonly mediaType?: string;
}

export interface ChannelAttachmentUploadInput {
  readonly idempotencyKey: string;
  readonly filename: string;
  readonly mediaType?: string;
  readonly bytes: Uint8Array;
}

export interface ChannelsTeamHubClient {
  listEnabledBindings(): Promise<
    readonly InternalIMChannelBinding[] | undefined
  >;
  reportStatus(
    bindingId: string,
    report: InternalIMChannelStatusReport,
  ): Promise<void>;
  ingestInbound(
    bindingId: string,
    request: InternalIMChannelInboundRequest,
  ): Promise<InternalIMChannelInboundResponse | undefined>;
  listOutbound(
    bindingId: string,
    afterSeq: number,
    limit?: number,
  ): Promise<InternalIMChannelOutboundPage | undefined>;
  downloadDocument?(
    bindingId: string,
    documentId: string,
    maxBytes?: number,
  ): Promise<DownloadedChannelDocument | undefined>;
  uploadAttachment?(
    bindingId: string,
    input: ChannelAttachmentUploadInput,
  ): Promise<string | undefined>;
}

export interface HttpChannelsTeamHubOptions {
  readonly baseUrl: string;
  readonly credential: string;
  readonly fetchImpl?: typeof fetch;
}

const REQUEST_TIMEOUT_MS = 10_000;
const MEDIA_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const RENDER_RETRY_ATTEMPTS = 8;
const RENDER_RETRY_MS = 1_500;

function parseDispositionFilename(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*UTF-8''([^;\r\n]+)/i.exec(header);
  if (star?.[1]) {
    try {
      const decoded = decodeURIComponent(star[1].trim());
      if (decoded) return decoded;
    } catch {
      // Fall through to plain filename parameter.
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]+)"|([^;\r\n]+))/i.exec(header);
  return (plain?.[1] ?? plain?.[2])?.trim() || undefined;
}

async function readBoundedBytes(
  res: Response,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const lengthHeader = Number(res.headers.get("content-length"));
  if (Number.isFinite(lengthHeader) && lengthHeader > maxBytes) {
    await res.body?.cancel();
    return undefined;
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.byteLength <= maxBytes ? buf : undefined;
}

/** Calls TeamHub's teamhub-internal IM channel routes using the shared internal bearer token. */
export class HttpChannelsTeamHubClient implements ChannelsTeamHubClient {
  readonly #baseUrl: string;
  readonly #credential: string;
  readonly #fetchImpl: typeof fetch;

  constructor(options: HttpChannelsTeamHubOptions) {
    this.#baseUrl = options.baseUrl;
    this.#credential = options.credential;
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  async listEnabledBindings(): Promise<
    readonly InternalIMChannelBinding[] | undefined
  > {
    const res = await this.#request("/internal/v1/channels/bindings", {
      method: "GET",
    });
    if (!res?.ok) return undefined;
    const body = (await res.json()) as {
      bindings?: InternalIMChannelBinding[];
    };
    return Array.isArray(body.bindings) ? body.bindings : [];
  }

  async reportStatus(
    bindingId: string,
    report: InternalIMChannelStatusReport,
  ): Promise<void> {
    await this.#request(
      `/internal/v1/channels/bindings/${encodeURIComponent(bindingId)}/status`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(report),
      },
    );
  }

  async ingestInbound(
    bindingId: string,
    request: InternalIMChannelInboundRequest,
  ): Promise<InternalIMChannelInboundResponse | undefined> {
    const res = await this.#request(
      `/internal/v1/channels/bindings/${encodeURIComponent(bindingId)}/inbound`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
    );
    if (!res?.ok) return undefined;
    return (await res.json()) as InternalIMChannelInboundResponse;
  }

  async listOutbound(
    bindingId: string,
    afterSeq: number,
    limit = 50,
  ): Promise<InternalIMChannelOutboundPage | undefined> {
    const path = `/internal/v1/channels/bindings/${encodeURIComponent(bindingId)}/outbound?after_seq=${encodeURIComponent(String(afterSeq))}&limit=${encodeURIComponent(String(limit))}`;
    const res = await this.#request(path, { method: "GET" });
    if (!res?.ok) return undefined;
    return (await res.json()) as InternalIMChannelOutboundPage;
  }

  async downloadDocument(
    bindingId: string,
    documentId: string,
    maxBytes = DEFAULT_MAX_DOWNLOAD_BYTES,
  ): Promise<DownloadedChannelDocument | undefined> {
    const path = `/internal/v1/channels/bindings/${encodeURIComponent(bindingId)}/documents/${encodeURIComponent(documentId)}`;
    for (let attempt = 0; attempt <= RENDER_RETRY_ATTEMPTS; attempt += 1) {
      const res = await this.#request(
        path,
        { method: "GET" },
        MEDIA_TIMEOUT_MS,
      );
      if (!res) return undefined;
      if (res.status === 202) {
        await res.body?.cancel();
        if (attempt === RENDER_RETRY_ATTEMPTS) return undefined;
        await delay(RENDER_RETRY_MS);
        continue;
      }
      if (!res.ok) return undefined;
      const bytes = await readBoundedBytes(res, maxBytes);
      if (!bytes) return undefined;
      const mediaType =
        res.headers.get("content-type")?.split(";")[0]?.trim() || undefined;
      const filename = parseDispositionFilename(
        res.headers.get("content-disposition"),
      );
      return {
        bytes,
        ...(filename ? { filename } : {}),
        ...(mediaType ? { mediaType } : {}),
      };
    }
    return undefined;
  }

  async uploadAttachment(
    bindingId: string,
    input: ChannelAttachmentUploadInput,
  ): Promise<string | undefined> {
    const form = new FormData();
    form.set("filename", input.filename);
    if (input.mediaType) form.set("media_type", input.mediaType);
    const bytes = new Uint8Array(input.bytes.byteLength);
    bytes.set(input.bytes);
    form.set(
      "content",
      new Blob([bytes], {
        type: input.mediaType || "application/octet-stream",
      }),
      input.filename,
    );
    const res = await this.#request(
      `/internal/v1/channels/bindings/${encodeURIComponent(bindingId)}/attachments`,
      {
        method: "POST",
        headers: { "idempotency-key": input.idempotencyKey },
        body: form,
      },
      MEDIA_TIMEOUT_MS,
    );
    if (!res?.ok) return undefined;
    try {
      const body = (await res.json()) as { id?: string };
      return body.id || undefined;
    } catch {
      return undefined;
    }
  }

  async #request(
    path: string,
    init: RequestInit,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Response | undefined> {
    try {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${this.#credential}`);
      return await this.#fetchImpl(new URL(path, this.#baseUrl), {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return undefined;
    }
  }
}
