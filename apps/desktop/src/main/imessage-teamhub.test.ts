import { describe, expect, it, vi } from "vitest";

import {
  filenameFromDisposition,
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

  it("opens the isolated Another Me channel Room", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: "room_imessage", channel: "imessage" }),
          {
            status: 201,
          },
        ),
    );
    expect(await client(fetch).openChannelRoom("imessage")).toEqual({
      ok: true,
      value: { roomId: "room_imessage" },
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(
      "https://linger.test/v0/tenants/t1/another-me/channels/imessage",
    );
    expect(init.method).toBe("POST");
  });

  it("uploads an attachment and posts an attachment-only Message", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "upload.token" }), { status: 201 }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 201 }));
    const th = client(fetch);
    const uploaded = await th.uploadAttachment("r1", {
      idempotencyKey: "imessage:G2:att:0",
      filename: "note.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("hello"),
    });
    expect(uploaded).toEqual({ ok: true, value: { uploadId: "upload.token" } });
    const [uploadUrl, uploadInit] = fetch.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(String(uploadUrl)).toBe(
      "https://linger.test/v0/rooms/r1/message-attachment-uploads",
    );
    expect(
      (uploadInit.headers as Record<string, string>)["idempotency-key"],
    ).toBe("imessage:G2:att:0");
    expect(uploadInit.body).toBeInstanceOf(FormData);
    expect(
      await th.postMessage("r1", "imessage:G2", "", {
        attachmentUploadIds: ["upload.token"],
      }),
    ).toEqual({ ok: true, value: undefined });
    const [, postInit] = fetch.mock.calls[1] as unknown as [URL, RequestInit];
    expect(JSON.parse(postInit.body as string)).toEqual({
      raw_message: "",
      segments: [],
      attachment_upload_ids: ["upload.token"],
    });
  });

  it("downloads a Document with 202 rendering retry and filename parsing", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 202 }))
      .mockResolvedValueOnce(
        new Response("report body", {
          status: 200,
          headers: {
            "content-type": "text/markdown; charset=utf-8",
            "content-disposition":
              "attachment; filename*=UTF-8''news%20report.md",
          },
        }),
      );
    const th = new IMessageTeamHubClient({
      serverUrl: () => "https://linger.test",
      tenantId: () => "t1",
      cookie: async () => "sid=1",
      fetch,
      wait: async () => {},
    });
    const downloaded = await th.downloadDocument("doc_1");
    expect(downloaded.ok).toBe(true);
    if (downloaded.ok) {
      expect(downloaded.value.filename).toBe("news report.md");
      expect(downloaded.value.mediaType).toBe("text/markdown");
      expect(new TextDecoder().decode(downloaded.value.bytes)).toBe(
        "report body",
      );
    }
    expect(filenameFromDisposition('attachment; filename="a.pdf"')).toBe(
      "a.pdf",
    );
  });
});
