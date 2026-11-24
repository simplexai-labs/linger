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
}

export interface HttpChannelsTeamHubOptions {
  readonly baseUrl: string;
  readonly credential: string;
  readonly fetchImpl?: typeof fetch;
}

const REQUEST_TIMEOUT_MS = 10_000;

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

  async #request(
    path: string,
    init: RequestInit,
  ): Promise<Response | undefined> {
    try {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${this.#credential}`);
      return await this.#fetchImpl(new URL(path, this.#baseUrl), {
        ...init,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return undefined;
    }
  }
}
