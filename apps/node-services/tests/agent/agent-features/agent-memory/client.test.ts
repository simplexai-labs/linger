import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryClient,
  type MemoryDocument,
} from "../../../../src/agent/agent-features/agent-memory/client.js";

const baseDocument: MemoryDocument = {
  revision: 3,
  summary: "",
  memory: "",
  cursors: {},
  sessions: {},
  pending: {
    stage: "extract",
    prompt: "extract prompt",
    attempt: 2,
    target: "computer-1\u0000codex\u0000gpt-5.4",
  },
};

describe("createMemoryClient rolling-deploy pending.target retry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cancels the 400 response body and retries once without pending.target", async () => {
    const sentBodies: MemoryDocument[] = [];
    const cancelSpy = vi.fn(async () => {});
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        const body = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as MemoryDocument;
        sentBodies.push(body);
        if (body.pending?.target !== undefined) {
          const response = new Response(
            JSON.stringify({ error: { code: "invalid_request" } }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
          vi.spyOn(response.body!, "cancel").mockImplementation(cancelSpy);
          return response;
        }
        return new Response(JSON.stringify({ ...body, revision: 4 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

    const client = createMemoryClient({
      baseUrl: "http://teamhub.test",
      serviceToken: "token-1",
    });

    const committed = await client.commit("agent-1", baseDocument);
    expect(committed.revision).toBe(4);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(sentBodies[0]?.pending?.target).toBe(
      "computer-1\u0000codex\u0000gpt-5.4",
    );
    expect(sentBodies[1]?.pending).toEqual({
      stage: "extract",
      prompt: "extract prompt",
      attempt: 2,
    });
    expect("target" in (sentBodies[1]?.pending ?? {})).toBe(false);
  });

  it("does not retry HTTP 400 when pending.target is absent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "invalid_request" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = createMemoryClient({
      baseUrl: "http://teamhub.test",
      serviceToken: "token-1",
    });

    const { target: _omitted, ...pendingWithoutTarget } = baseDocument.pending!;
    await expect(
      client.commit("agent-1", {
        ...baseDocument,
        pending: pendingWithoutTarget,
      }),
    ).rejects.toThrow("Agent memory request failed (400)");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
