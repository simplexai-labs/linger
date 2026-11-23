import { describe, expect, it, vi } from "vitest";

import {
  IMessageTeamHubClient,
  parseSse,
  TeamHubStreamError,
} from "./imessage-teamhub.js";

async function* bytes(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield new TextEncoder().encode(part);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

const client = (fetch: typeof globalThis.fetch, cookie = "sid=1") =>
  new IMessageTeamHubClient({
    serverUrl: () => "https://linger.test",
    tenantId: () => "t1",
    cookie: async () => cookie || undefined,
    fetch,
  });

describe("parseSse", () => {
  it("splits events across chunks and drops comments", async () => {
    expect(
      await collect(
        parseSse(
          bytes(
            ": heartbeat\n\nevent: room.event\nda",
            'ta: {"a":1}\r\n\r\nevent: stream.resync\ndata: x\ndata: y\n\n',
          ),
        ),
      ),
    ).toEqual([
      { event: "room.event", data: '{"a":1}' },
      { event: "stream.resync", data: "x\ny" },
    ]);
  });
});

describe("IMessageTeamHubClient", () => {
  it("posts a Message with the cookie and idempotency key", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 201 }));
    const result = await client(fetch).postMessage("r1", "imessage:G", "hi");
    expect(result).toEqual({ ok: true, value: undefined });
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://linger.test/v0/rooms/r1/messages");
    expect(init.headers).toMatchObject({
      cookie: "sid=1",
      "idempotency-key": "imessage:G",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      raw_message: "hi",
      segments: [{ type: "text", content: "hi" }],
    });
  });

  it("reports the status and error code of a refusal", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "CONFLICT" } }), {
          status: 409,
        }),
    );
    expect(await client(fetch).decide("d1", {} as never)).toEqual({
      ok: false,
      status: 409,
      code: "CONFLICT",
    });
  });

  it("is signed out without a session cookie", async () => {
    const fetch = vi.fn();
    expect(await client(fetch, "").me()).toEqual({ ok: false, status: 401 });
    await expect(
      collect(client(fetch, "").events("r1", 3, new AbortController().signal)),
    ).rejects.toEqual(new TeamHubStreamError(401));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("finds the Human Actor of the workspace", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            account: {},
            actors: [
              { id: "a0", kind: "human", tenant_id: "t0" },
              { id: "a1", kind: "human", tenant_id: "t1" },
            ],
          }),
        ),
    );
    expect(await client(fetch).me()).toEqual({
      ok: true,
      value: { actorId: "a1" },
    });
  });

  it("follows the Chat from its cursor", async () => {
    const fetch = vi.fn(
      async () =>
        new Response('event: room.event\ndata: {"room_seq":4}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const events = await collect(
      client(fetch).events("r1", 3, new AbortController().signal),
    );
    expect(events).toEqual([{ event: "room.event", data: '{"room_seq":4}' }]);
    const [url] = fetch.mock.calls[0] as unknown as [URL];
    expect(url.searchParams.getAll("room")).toEqual(["r1:3"]);
  });
});
