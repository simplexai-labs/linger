import { describe, expect, it, vi } from "vitest";
import { readBodyWithLimit } from "../src/http-host.js";

describe("bounded request body chunk ownership", () => {
  it.each([0, 3])(
    "retains each chunk when the source reuses a buffer at offset %s",
    async (offset) => {
      const shared = new Uint8Array(offset + 4);
      const view = shared.subarray(offset);
      const chunks = ['{"a"', ":123", "456}"];
      let index = 0;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (index === chunks.length) {
              controller.close();
              return;
            }
            view.set(new TextEncoder().encode(chunks[index++]));
            controller.enqueue(view);
          },
        },
        { highWaterMark: 0 },
      );
      const request = streamRequest(stream);
      const body = await readBodyWithLimit(request, 12);
      expect(body?.toString("utf8")).toBe('{"a":123456}');
    },
  );

  it("still cancels as soon as the byte limit is exceeded", async () => {
    const cancel = vi.fn();
    const request = streamRequest(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
        cancel,
      }),
    );
    expect(await readBodyWithLimit(request, 2)).toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

function streamRequest(body: ReadableStream<Uint8Array>): Request {
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    body,
    duplex: "half",
  };
  return new Request("http://node-services.test/internal/v1/test", init);
}
