import type { components } from "@linger/wire-contracts/teamhub-public/types";

type Schemas = components["schemas"];
export type TeamHubRoomEvent = Schemas["RoomEventEnvelope"];
export type TeamHubMessage = Schemas["Message"];
export type TeamHubDecisionCard = Schemas["DecisionRequestedMessageCard"];
export type TeamHubDecisionRequest = Schemas["DecisionRequest"];
export type TeamHubMessageCreated = Schemas["MessageSnapshotPayload"];
export type TeamHubCardChanged = Schemas["CardChangedPayload"];

// `status` 0: no response (network, timeout).
export type TeamHubResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly code?: string };

export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

export class TeamHubStreamError extends Error {
  constructor(readonly status: number) {
    super(`Event stream failed (${String(status)})`);
  }
}

// The TeamHub calls the iMessage channel makes as the signed-in person.
export interface IMessageTeamHub {
  // The person's Human Actor in this workspace.
  me(): Promise<TeamHubResult<{ actorId: string }>>;
  anotherMe(): Promise<
    TeamHubResult<{ agentActorId?: string; roomId?: string }>
  >;
  latestRoomSeq(roomId: string): Promise<TeamHubResult<number>>;
  postMessage(
    roomId: string,
    idempotencyKey: string,
    text: string,
  ): Promise<TeamHubResult<void>>;
  decide(
    decisionId: string,
    body: TeamHubDecisionRequest,
  ): Promise<TeamHubResult<void>>;
  // Yields until the stream ends; throws TeamHubStreamError when it cannot
  // open.
  events(
    roomId: string,
    roomSeq: number,
    signal: AbortSignal,
  ): AsyncIterable<SseEvent>;
}

export interface IMessageTeamHubOptions {
  readonly serverUrl: () => string | undefined;
  readonly tenantId: () => string | undefined;
  // The window session's cookie header, read fresh for every call.
  readonly cookie: (serverUrl: string) => Promise<string | undefined>;
  readonly fetch?: typeof fetch;
  readonly requestTimeoutMs?: number;
  // The server sends heartbeat comments; a silent stream is reopened.
  readonly streamIdleMs?: number;
}

// Parses a text/event-stream body into events; comments are dropped.
export async function* parseSse(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffered = "";
  let event = "";
  let data: string[] = [];
  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffered.search(/\r\n|\r|\n/)) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(
        newline + (buffered.startsWith("\r\n", newline) ? 2 : 1),
      );
      if (line === "") {
        if (data.length)
          yield { event: event || "message", data: data.join("\n") };
        event = "";
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
  }
}

function errorCode(body: unknown): string | undefined {
  const code = (body as { error?: { code?: unknown } } | undefined)?.error
    ?.code;
  return typeof code === "string" ? code : undefined;
}

export class IMessageTeamHubClient implements IMessageTeamHub {
  readonly #options: IMessageTeamHubOptions;

  constructor(options: IMessageTeamHubOptions) {
    this.#options = options;
  }

  async me(): Promise<TeamHubResult<{ actorId: string }>> {
    const result = await this.#json<Schemas["CurrentIdentity"]>("/v0/me");
    if (!result.ok) return result;
    const tenantId = this.#options.tenantId();
    const human = result.value.actors.find(
      (actor) =>
        actor.kind === "human" && (!tenantId || actor.tenant_id === tenantId),
    );
    return human
      ? { ok: true, value: { actorId: human.id } }
      : { ok: false, status: 403, code: "NO_HUMAN_ACTOR" };
  }

  async anotherMe(): Promise<
    TeamHubResult<{ agentActorId?: string; roomId?: string }>
  > {
    const tenantId = this.#options.tenantId();
    if (!tenantId) return { ok: false, status: 401 };
    const result = await this.#json<Schemas["AnotherMe"]>(
      `/v0/tenants/${encodeURIComponent(tenantId)}/another-me`,
    );
    if (!result.ok) return result;
    return {
      ok: true,
      value: {
        ...(result.value.agent_actor_id
          ? { agentActorId: result.value.agent_actor_id }
          : {}),
        ...(result.value.room_id ? { roomId: result.value.room_id } : {}),
      },
    };
  }

  async latestRoomSeq(roomId: string): Promise<TeamHubResult<number>> {
    const result = await this.#json<Schemas["RoomEventPage"]>(
      `/v0/rooms/${encodeURIComponent(roomId)}/events?after=0&limit=1`,
    );
    return result.ok
      ? { ok: true, value: result.value.latest_room_seq }
      : result;
  }

  async postMessage(
    roomId: string,
    idempotencyKey: string,
    text: string,
  ): Promise<TeamHubResult<void>> {
    const body: Schemas["MessageCreateRequest"] = {
      raw_message: text,
      segments: [{ type: "text", content: text }],
    };
    return this.#send(
      `/v0/rooms/${encodeURIComponent(roomId)}/messages`,
      body,
      { "idempotency-key": idempotencyKey },
    );
  }

  decide(
    decisionId: string,
    body: TeamHubDecisionRequest,
  ): Promise<TeamHubResult<void>> {
    return this.#send(`/v0/decisions/${encodeURIComponent(decisionId)}`, body);
  }

  async *events(
    roomId: string,
    roomSeq: number,
    signal: AbortSignal,
  ): AsyncGenerator<SseEvent> {
    const serverUrl = this.#options.serverUrl();
    const cookie = serverUrl
      ? await this.#options.cookie(serverUrl)
      : undefined;
    if (!serverUrl || !cookie) throw new TeamHubStreamError(401);
    const idle = new AbortController();
    const url = new URL("/v0/events", serverUrl);
    url.searchParams.append("room", `${roomId}:${String(roomSeq)}`);
    let response: Response;
    try {
      response = await (this.#options.fetch ?? fetch)(url, {
        headers: { accept: "text/event-stream", cookie },
        redirect: "error",
        signal: AbortSignal.any([signal, idle.signal]),
      });
    } catch {
      throw new TeamHubStreamError(0);
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new TeamHubStreamError(response.status);
    }
    const idleMs = this.#options.streamIdleMs ?? 120_000;
    let timer = setTimeout(() => idle.abort(), idleMs);
    const body = response.body;
    async function* watched(): AsyncGenerator<Uint8Array> {
      for await (const chunk of body) {
        clearTimeout(timer);
        timer = setTimeout(() => idle.abort(), idleMs);
        yield chunk;
      }
    }
    try {
      yield* parseSse(watched());
    } catch (error) {
      if (signal.aborted) return;
      // A dropped or silent connection ends the stream; the caller reopens.
      if (idle.signal.aborted) return;
      throw error instanceof TeamHubStreamError
        ? error
        : new TeamHubStreamError(0);
    } finally {
      clearTimeout(timer);
    }
  }

  async #json<T>(pathname: string): Promise<TeamHubResult<T>> {
    const response = await this.#call(pathname, { method: "GET" });
    if (!response.ok) return response;
    try {
      return { ok: true, value: (await response.value.json()) as T };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  async #send(
    pathname: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<TeamHubResult<void>> {
    const response = await this.#call(pathname, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
    });
    if (!response.ok) return response;
    await response.value.body?.cancel();
    return { ok: true, value: undefined };
  }

  async #call(
    pathname: string,
    init: { method: string; body?: string; headers?: Record<string, string> },
  ): Promise<TeamHubResult<Response>> {
    const serverUrl = this.#options.serverUrl();
    const cookie = serverUrl
      ? await this.#options.cookie(serverUrl)
      : undefined;
    if (!serverUrl || !cookie) return { ok: false, status: 401 };
    let response: Response;
    try {
      response = await (this.#options.fetch ?? fetch)(
        new URL(pathname, serverUrl),
        {
          method: init.method,
          headers: { accept: "application/json", cookie, ...init.headers },
          redirect: "error",
          signal: AbortSignal.timeout(this.#options.requestTimeoutMs ?? 30_000),
          ...(init.body === undefined ? {} : { body: init.body }),
        },
      );
    } catch {
      return { ok: false, status: 0 };
    }
    if (response.ok) return { ok: true, value: response };
    const code = errorCode(await response.json().catch(() => undefined));
    return { ok: false, status: response.status, ...(code ? { code } : {}) };
  }
}
