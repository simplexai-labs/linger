import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { downloadVerified, type DownloadDiagnosticEvent } from "./download.js";
const roots: string[] = [];
const fast = { attempts: 2, retryDelayMs: 0, idleTimeoutMs: 1_000 };
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
it("verifies streamed bytes before publishing a file and reports byte progress", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const bytes = Buffer.from("trusted fixture");
  const events: number[] = [];
  const output = path.join(root, "kit.tgz");
  await downloadVerified(
    {
      url: "https://registry.npmjs.org/fixture.tgz",
      output,
      digest: createHash("sha256").update(bytes).digest("hex"),
      algorithm: "sha256",
      maxBytes: 100,
      signal: new AbortController().signal,
      onProgress: (n) => events.push(n),
    },
    async () => new Response(bytes),
  );
  expect(await readFile(output)).toEqual(bytes);
  expect(events.at(-1)).toBe(bytes.length);
});
it("a bad checksum never publishes an executable archive", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const output = path.join(root, "kit.tgz");
  await expect(
    downloadVerified(
      {
        url: "https://registry.npmjs.org/fixture.tgz",
        output,
        digest: "0".repeat(64),
        algorithm: "sha256",
        maxBytes: 100,
        signal: new AbortController().signal,
      },
      async () => new Response("wrong"),
    ),
  ).rejects.toThrow(/checksum/i);
  await expect(access(output)).rejects.toThrow();
});
it("rejects HTTP, credential-bearing URLs, and downloads over the size bound", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const options = {
    output: path.join(root, "kit.tgz"),
    digest: "0".repeat(64),
    algorithm: "sha256" as const,
    maxBytes: 2,
    signal: new AbortController().signal,
  };
  for (const url of [
    "http://example.com/kit",
    "https://secret@example.com/kit",
    "https://example.com/kit?token=secret",
  ])
    await expect(downloadVerified({ ...options, url })).rejects.toThrow();
  await expect(
    downloadVerified(
      { ...options, url: "https://example.com/kit" },
      async () => new Response("too big"),
    ),
  ).rejects.toThrow(/size/i);
});

it("reports interrupted streams safely and keeps partial progress without publishing files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const events: number[] = [];
  const broken = () => {
    let pulls = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(Buffer.from("partial"));
        else
          controller.error(
            new TypeError("terminated", {
              cause: new Error("private transport details"),
            }),
          );
      },
    });
  };
  await expect(
    downloadVerified(
      {
        url: "https://example.com/kit",
        output: path.join(root, "kit.tgz"),
        algorithm: "sha256",
        digest: "0".repeat(64),
        maxBytes: 100,
        signal: new AbortController().signal,
        onProgress: (completed) => events.push(completed),
      },
      async () =>
        new Response(broken(), { headers: { "content-length": "100" } }),
      fast,
    ),
  ).rejects.toThrow(
    "Download of kit from example.com failed (interrupted). Check your network and retry.",
  );
  expect(events[0]).toBe(7);
  expect(await readdir(root)).toEqual([]);
});

it("replaces fetch transport details with safe actionable guidance", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const error = await downloadVerified(
    {
      url: "https://example.com/private-kit",
      output: path.join(root, "kit.tgz"),
      algorithm: "sha256",
      digest: "0".repeat(64),
      maxBytes: 100,
      signal: new AbortController().signal,
    },
    async () => {
      throw new TypeError("failed https://example.com/private-kit", {
        cause: new Error("sensitive cause"),
      });
    },
    fast,
  ).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(
    "Download of private-kit from example.com failed (no connection). Check your network and retry.",
  );
  expect((error as Error).cause).toBeUndefined();
  expect(await readdir(root)).toEqual([]);
});

it.each(["fetch", "stream"])(
  "preserves explicit cancellation during %s",
  async (boundary) => {
    const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
    roots.push(root);
    const abort = new AbortController();
    const reason = new Error("Installation cancelled.");
    const fail = () => {
      abort.abort(reason);
      throw new TypeError("terminated");
    };
    await expect(
      downloadVerified(
        {
          url: "https://example.com/kit",
          output: path.join(root, "kit.tgz"),
          algorithm: "sha256",
          digest: "0".repeat(64),
          maxBytes: 100,
          signal: abort.signal,
        },
        async () => {
          if (boundary === "fetch") return fail();
          return new Response(
            new ReadableStream({ pull: fail }, { highWaterMark: 0 }),
          );
        },
      ),
    ).rejects.toBe(reason);
    expect(await readdir(root)).toEqual([]);
  },
);

it("preserves filesystem failures outside the transport boundary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const bytes = Buffer.from("trusted fixture");
  await expect(
    downloadVerified(
      {
        url: "https://example.com/kit",
        output: path.join(root, "missing", "kit.tgz"),
        algorithm: "sha256",
        digest: createHash("sha256").update(bytes).digest("hex"),
        maxBytes: 100,
        signal: new AbortController().signal,
      },
      async () => new Response(bytes),
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(root)).toEqual([]);
});

it.each([false, true])(
  "cancels a blocked response body without waiting for the idle timeout (resumable: %s)",
  async (resumable) => {
    const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
    roots.push(root);
    const abort = new AbortController();
    const reason = new Error("Installation cancelled.");
    const bytes = Buffer.from("trusted bytes that have not all arrived");
    const prefix = bytes.subarray(0, 7);
    const output = path.join(root, "kit.tgz");
    let calls = 0;
    let cancelled = false;
    let forceEnd: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(
        downloadVerified(
          {
            url: "https://primary.example/kit.tgz",
            mirrors: ["https://mirror.example/kit.tgz"],
            output,
            digest: createHash("sha256").update(bytes).digest("hex"),
            algorithm: "sha256",
            maxBytes: 100,
            signal: abort.signal,
            resumable,
          },
          async () => {
            calls++;
            let pulls = 0;
            return new Response(
              new ReadableStream<Uint8Array>(
                {
                  start(controller) {
                    // Bound the fixture even when cancellation is ignored.
                    forceEnd = setTimeout(() => controller.close(), 1_000);
                  },
                  pull(controller) {
                    if (pulls++ === 0) controller.enqueue(prefix);
                    else {
                      abort.abort(reason);
                      return new Promise(() => {});
                    }
                  },
                  cancel() {
                    cancelled = true;
                  },
                },
                { highWaterMark: 0 },
              ),
            );
          },
          { ...fast, idleTimeoutMs: 60_000 },
        ),
      ).rejects.toBe(reason);
      expect(cancelled).toBe(true);
      expect(calls).toBe(1);
      await expect(access(output)).rejects.toThrow();
      expect(await readdir(root)).toEqual(resumable ? ["kit.tgz.part"] : []);
      if (resumable) expect(await readFile(`${output}.part`)).toEqual(prefix);
    } finally {
      clearTimeout(forceEnd);
    }
  },
);

it("resumes an interrupted transfer with a range request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const bytes = Buffer.from("resumable trusted fixture");
  const ranges: (string | null)[] = [];
  const output = path.join(root, "kit.tgz");
  await downloadVerified(
    {
      url: "https://example.com/kit.tgz",
      output,
      digest: createHash("sha256").update(bytes).digest("hex"),
      algorithm: "sha256",
      maxBytes: 100,
      signal: new AbortController().signal,
    },
    async (_url, init) => {
      const range = new Headers(init?.headers).get("range");
      ranges.push(range);
      if (!range) {
        let pulls = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (pulls++ === 0) controller.enqueue(bytes.subarray(0, 9));
              else controller.error(new TypeError("terminated"));
            },
          }),
        );
      }
      return new Response(bytes.subarray(9), {
        status: 206,
        headers: {
          "content-range": `bytes 9-${bytes.length - 1}/${bytes.length}`,
        },
      });
    },
    fast,
  );
  expect(ranges).toEqual([null, "bytes=9-"]);
  expect(await readFile(output)).toEqual(bytes);
});

it.each([false, true])(
  "restarts with a full response when the server ignores Range (resumable=%s)",
  async (resumable) => {
    const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
    roots.push(root);
    const output = path.join(root, "kit.tgz");
    const bytes = Buffer.from("complete verified archive");
    const ranges: (string | null)[] = [];
    await downloadVerified(
      {
        url: "https://example.com/kit.tgz",
        output,
        digest: createHash("sha256").update(bytes).digest("hex"),
        algorithm: "sha256",
        maxBytes: 100,
        resumable,
        signal: new AbortController().signal,
      },
      async (_url, init) => {
        const range = new Headers(init?.headers).get("range");
        ranges.push(range);
        if (range) return new Response(bytes);
        let pulls = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (pulls++ === 0) controller.enqueue(Buffer.from("stale"));
              else controller.error(new Error("interrupted"));
            },
          }),
        );
      },
      fast,
    );
    expect(ranges).toEqual([null, "bytes=5-"]);
    expect(await readFile(output)).toEqual(bytes);
    expect(await readdir(root)).toEqual(["kit.tgz"]);
  },
);

it("continues a stalled transfer on the mirror before retrying the first host", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const bytes = Buffer.from("resumable trusted fixture");
  const requests: string[] = [];
  const output = path.join(root, "kit.tgz");
  await downloadVerified(
    {
      url: "https://primary.example/kit.tgz",
      mirrors: ["https://mirror.example/kit.tgz"],
      output,
      digest: createHash("sha256").update(bytes).digest("hex"),
      algorithm: "sha256",
      maxBytes: 100,
      signal: new AbortController().signal,
    },
    async (url, init) => {
      const range = new Headers(init?.headers).get("range");
      requests.push(`${new URL(url as URL).host} ${range}`);
      if (new URL(url as URL).host === "primary.example") {
        let pulls = 0;
        // Sends part of the file, then nothing.
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (pulls++ === 0) controller.enqueue(bytes.subarray(0, 9));
              else return new Promise(() => {});
            },
          }),
        );
      }
      return new Response(bytes.subarray(9), {
        status: 206,
        headers: {
          "content-range": `bytes 9-${bytes.length - 1}/${bytes.length}`,
        },
      });
    },
    { ...fast, retryDelayMs: 60_000, idleTimeoutMs: 20 },
  );
  expect(requests).toEqual(["primary.example null", "mirror.example bytes=9-"]);
  expect(await readFile(output)).toEqual(bytes);
});

it("moves to a mirror when the first host cannot serve the file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const bytes = Buffer.from("mirrored fixture");
  const hosts: string[] = [];
  const output = path.join(root, "kit.tgz");
  await downloadVerified(
    {
      url: "https://primary.example/kit.tgz",
      mirrors: ["https://mirror.example/kit.tgz"],
      output,
      digest: createHash("sha256").update(bytes).digest("hex"),
      algorithm: "sha256",
      maxBytes: 100,
      signal: new AbortController().signal,
    },
    async (url) => {
      hosts.push(new URL(url as URL).host);
      return new URL(url as URL).host === "primary.example"
        ? new Response("missing", { status: 404 })
        : new Response(bytes);
    },
    fast,
  );
  expect(hosts).toEqual(["primary.example", "mirror.example"]);
  expect(await readFile(output)).toEqual(bytes);
});

it("restarts an attempt that stops receiving bytes and names every host on failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  let calls = 0;
  await expect(
    downloadVerified(
      {
        url: "https://primary.example/go.tar.gz",
        mirrors: ["https://mirror.example/go.tar.gz"],
        output: path.join(root, "go.tar.gz"),
        digest: "0".repeat(64),
        algorithm: "sha256",
        maxBytes: 100,
        signal: new AbortController().signal,
      },
      async () => {
        calls += 1;
        return new Response(
          new ReadableStream({ pull: () => new Promise(() => {}) }),
        );
      },
      { attempts: 2, retryDelayMs: 0, idleTimeoutMs: 20 },
    ),
  ).rejects.toThrow(
    "Download of go.tar.gz from primary.example and mirror.example failed (stalled). Check your network and retry.",
  );
  expect(calls).toBe(4);
  expect(await readdir(root)).toEqual([]);
});

it("keeps a resumable partial file for the next call", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const bytes = Buffer.from("bundle bytes that arrive in two runs");
  const output = path.join(root, "bundle.tgz");
  const options = {
    url: "https://example.com/bundle.tgz",
    output,
    digest: createHash("sha256").update(bytes).digest("hex"),
    algorithm: "sha256" as const,
    maxBytes: 100,
    resumable: true,
  };
  await expect(
    downloadVerified(
      { ...options, signal: new AbortController().signal },
      async () => {
        let pulls = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (pulls++ === 0) controller.enqueue(bytes.subarray(0, 10));
              else controller.error(new TypeError("terminated"));
            },
          }),
        );
      },
      { ...fast, attempts: 1 },
    ),
  ).rejects.toThrow(/failed \(interrupted\)/);
  expect(await readdir(root)).toEqual(["bundle.tgz.part"]);
  await downloadVerified(
    { ...options, signal: new AbortController().signal },
    async (_url, init) => {
      expect(new Headers(init?.headers).get("range")).toBe("bytes=10-");
      return new Response(bytes.subarray(10), {
        status: 206,
        headers: {
          "content-range": `bytes 10-${bytes.length - 1}/${bytes.length}`,
        },
      });
    },
    fast,
  );
  expect(await readFile(output)).toEqual(bytes);
  expect(await readdir(root)).toEqual(["bundle.tgz"]);
});

it("moves to a faster mirror when the first host is slow with substantial work left", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const bytes = Buffer.alloc(64 * 1024, 0x7a);
  const requests: string[] = [];
  const output = path.join(root, "go.tgz");
  const served = await downloadVerified(
    {
      url: "https://primary.example/go.tgz",
      mirrors: ["https://mirror.example/go.tgz"],
      output,
      digest: createHash("sha256").update(bytes).digest("hex"),
      algorithm: "sha256",
      maxBytes: bytes.length,
      signal: new AbortController().signal,
    },
    async (url, init) => {
      const host = new URL(url as URL).host;
      const range = new Headers(init?.headers).get("range");
      requests.push(`${host} ${range}`);
      const start = range ? Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0) : 0;
      const slice = bytes.subarray(start);
      const headers: Record<string, string> = {
        "content-length": String(slice.length),
        ...(start > 0
          ? {
              "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
            }
          : {}),
      };
      if (host === "primary.example") {
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              for (let offset = 0; offset < slice.length; offset += 2048) {
                await new Promise((resolve) => setTimeout(resolve, 40));
                try {
                  controller.enqueue(slice.subarray(offset, offset + 2048));
                } catch {
                  return;
                }
              }
              try {
                controller.close();
              } catch {
                // Cancelled when switching to the mirror.
              }
            },
          }),
          { status: start > 0 ? 206 : 200, headers },
        );
      }
      return new Response(slice, { status: start > 0 ? 206 : 200, headers });
    },
    {
      attempts: 2,
      retryDelayMs: 60_000,
      idleTimeoutMs: 5_000,
      slowCheckAfterMs: 100,
      minBytesPerSecond: 200_000,
      minRemainingMs: 300,
    },
  );
  expect(served).toBe("https://mirror.example/go.tgz");
  expect(requests).toHaveLength(2);
  expect(requests[0]).toBe("primary.example null");
  expect(requests[1]).toMatch(/^mirror\.example bytes=\d+-$/);
  expect(await readFile(output)).toEqual(bytes);
});

it("keeps downloading from a slow primary when the remaining time is short", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const bytes = Buffer.alloc(16 * 1024, 0x79);
  const hosts: string[] = [];
  const output = path.join(root, "small.tgz");
  const served = await downloadVerified(
    {
      url: "https://primary.example/small.tgz",
      mirrors: ["https://mirror.example/small.tgz"],
      output,
      digest: createHash("sha256").update(bytes).digest("hex"),
      algorithm: "sha256",
      maxBytes: bytes.length,
      signal: new AbortController().signal,
    },
    async (url) => {
      hosts.push(new URL(url as URL).host);
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let offset = 0; offset < bytes.length; offset += 4096) {
              await new Promise((resolve) => setTimeout(resolve, 35));
              controller.enqueue(bytes.subarray(offset, offset + 4096));
            }
            controller.close();
          },
        }),
        { headers: { "content-length": String(bytes.length) } },
      );
    },
    {
      attempts: 2,
      retryDelayMs: 0,
      idleTimeoutMs: 5_000,
      slowCheckAfterMs: 80,
      minBytesPerSecond: 500_000,
      minRemainingMs: 5_000,
    },
  );
  expect(served).toBe("https://primary.example/small.tgz");
  expect(hosts).toEqual(["primary.example"]);
  expect(await readFile(output)).toEqual(bytes);
});

/**
 * Advances Vitest's fake clock on each pull so throughput measurements depend
 * only on deterministic simulated intervals, not CPU or disk-write latency.
 */
function fakeClockStream(
  slice: Uint8Array,
  chunkBytes: number,
  intervalMs: number,
  signal?: AbortSignal | null,
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (signal?.aborted) return;
        vi.advanceTimersByTime(intervalMs);
        if (signal?.aborted) return;
        if (offset >= slice.length) {
          controller.close();
          return;
        }
        const end = Math.min(offset + chunkBytes, slice.length);
        controller.enqueue(slice.subarray(offset, end));
        offset = end;
        if (offset >= slice.length) controller.close();
      },
    },
    { highWaterMark: 0 },
  );
}

it("finishes on the primary without error when every host is equally slow", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "performance"],
  });
  try {
    const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
    roots.push(root);
    const bytes = Buffer.alloc(40 * 1024, 0x78);
    const hosts: string[] = [];
    const output = path.join(root, "slow-both.tgz");
    const served = await downloadVerified(
      {
        url: "https://primary.example/slow-both.tgz",
        mirrors: ["https://mirror.example/slow-both.tgz"],
        output,
        digest: createHash("sha256").update(bytes).digest("hex"),
        algorithm: "sha256",
        maxBytes: bytes.length,
        signal: new AbortController().signal,
      },
      async (url, init) => {
        hosts.push(new URL(url as URL).host);
        const range = new Headers(init?.headers).get("range");
        const start = range
          ? Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0)
          : 0;
        const slice = bytes.subarray(start);
        const headers: Record<string, string> = {
          "content-length": String(slice.length),
          ...(start > 0
            ? {
                "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
              }
            : {}),
        };
        return new Response(fakeClockStream(slice, 2048, 25, init?.signal), {
          status: start > 0 ? 206 : 200,
          headers,
        });
      },
      {
        attempts: 2,
        retryDelayMs: 60_000,
        idleTimeoutMs: 5_000,
        slowCheckAfterMs: 80,
        minBytesPerSecond: 300_000,
        minRemainingMs: 150,
      },
    );
    expect(served).toBe("https://primary.example/slow-both.tgz");
    expect(hosts).toEqual([
      "primary.example",
      "mirror.example",
      "primary.example",
    ]);
    expect(await readFile(output)).toEqual(bytes);
  } finally {
    vi.useRealTimers();
  }
});

it("moves past a hung primary at slowCheckAfterMs instead of waiting for idleTimeoutMs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const bytes = Buffer.from("served by mirror quickly");
  const hosts: string[] = [];
  const output = path.join(root, "kit.tgz");
  const startedAt = Date.now();
  const served = await downloadVerified(
    {
      url: "https://primary.example/kit.tgz",
      mirrors: ["https://mirror.example/kit.tgz"],
      output,
      digest: createHash("sha256").update(bytes).digest("hex"),
      algorithm: "sha256",
      maxBytes: bytes.length,
      signal: new AbortController().signal,
    },
    async (url, init) => {
      const host = new URL(url as URL).host;
      hosts.push(host);
      if (host === "primary.example") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      return new Response(bytes);
    },
    {
      attempts: 2,
      retryDelayMs: 0,
      idleTimeoutMs: 5_000,
      slowCheckAfterMs: 80,
      minBytesPerSecond: 100_000,
      minRemainingMs: 200,
    },
  );
  expect(served).toBe("https://mirror.example/kit.tgz");
  expect(hosts).toEqual(["primary.example", "mirror.example"]);
  expect(Date.now() - startedAt).toBeLessThan(1_000);
  expect(await readFile(output)).toEqual(bytes);
});

it("promotes the fastest mirror when the first host hangs and the last mirror is slower", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "performance"],
  });
  try {
    const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
    roots.push(root);
    const bytes = Buffer.alloc(64 * 1024, 0x77);
    const hosts: string[] = [];
    const output = path.join(root, "kit.tgz");
    const served = await downloadVerified(
      {
        url: "https://hung.example/kit.tgz",
        mirrors: [
          "https://medium.example/kit.tgz",
          "https://crawl.example/kit.tgz",
        ],
        output,
        digest: createHash("sha256").update(bytes).digest("hex"),
        algorithm: "sha256",
        maxBytes: bytes.length,
        signal: new AbortController().signal,
      },
      async (url, init) => {
        const host = new URL(url as URL).host;
        hosts.push(host);
        if (host === "hung.example") {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
            queueMicrotask(() => vi.advanceTimersByTime(90));
          });
        }
        const range = new Headers(init?.headers).get("range");
        const start = range
          ? Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0)
          : 0;
        const slice = bytes.subarray(start);
        const headers: Record<string, string> = {
          "content-length": String(slice.length),
          ...(start > 0
            ? {
                "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
              }
            : {}),
        };
        const chunkBytes = host === "medium.example" ? 4096 : 1024;
        return new Response(
          fakeClockStream(slice, chunkBytes, 30, init?.signal),
          {
            status: start > 0 ? 206 : 200,
            headers,
          },
        );
      },
      {
        attempts: 2,
        retryDelayMs: 60_000,
        idleTimeoutMs: 5_000,
        slowCheckAfterMs: 90,
        minBytesPerSecond: 300_000,
        minRemainingMs: 200,
      },
    );
    expect(served).toBe("https://medium.example/kit.tgz");
    expect(hosts).toEqual([
      "hung.example",
      "medium.example",
      "crawl.example",
      "medium.example",
    ]);
    expect(await readFile(output)).toEqual(bytes);
  } finally {
    vi.useRealTimers();
  }
});

it("finishes on a faster alternate mirror when its remaining transfer is within minRemainingMs even with another mirror left", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "performance"],
  });
  try {
    const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
    roots.push(root);
    const bytes = Buffer.alloc(150 * 1024, 0x65);
    const hosts: string[] = [];
    const output = path.join(root, "kit.tgz");
    const served = await downloadVerified(
      {
        url: "https://slow.example/kit.tgz",
        mirrors: [
          "https://fast-mirror.example/kit.tgz",
          "https://third.example/kit.tgz",
        ],
        output,
        digest: createHash("sha256").update(bytes).digest("hex"),
        algorithm: "sha256",
        maxBytes: bytes.length,
        signal: new AbortController().signal,
      },
      async (url, init) => {
        const host = new URL(url as URL).host;
        hosts.push(host);
        const range = new Headers(init?.headers).get("range");
        const start = range
          ? Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0)
          : 0;
        const slice = bytes.subarray(start);
        const headers: Record<string, string> = {
          "content-length": String(slice.length),
          ...(start > 0
            ? {
                "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
              }
            : {}),
        };
        // Scaled 100x from a 15 MiB file with 1 MiB/s floor: primary ~110 KB/s,
        // second mirror ~800 KB/s (< floor, ~12 s remaining <= 25 s threshold).
        const chunkBytes = host === "slow.example" ? 1100 : 8000;
        return new Response(
          fakeClockStream(slice, chunkBytes, 1_000, init?.signal),
          {
            status: start > 0 ? 206 : 200,
            headers,
          },
        );
      },
      {
        attempts: 3,
        retryDelayMs: 60_000,
        idleTimeoutMs: 10_000,
        slowCheckAfterMs: 6_000,
        minBytesPerSecond: 10 * 1024,
        minRemainingMs: 25_000,
      },
    );
    expect(served).toBe("https://fast-mirror.example/kit.tgz");
    expect(hosts).toEqual(["slow.example", "fast-mirror.example"]);
    expect(await readFile(output)).toEqual(bytes);
  } finally {
    vi.useRealTimers();
  }
});

it("still runs slow-mirror fallback on a later round after a transient round 0 retry", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "performance"],
  });
  try {
    const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
    roots.push(root);
    const bytes = Buffer.alloc(64 * 1024, 0x66);
    const hosts: string[] = [];
    const output = path.join(root, "kit.tgz");
    let primaryCalls = 0;
    let mirrorCalls = 0;
    const served = await downloadVerified(
      {
        url: "https://primary.example/kit.tgz",
        mirrors: ["https://mirror.example/kit.tgz"],
        output,
        digest: createHash("sha256").update(bytes).digest("hex"),
        algorithm: "sha256",
        maxBytes: bytes.length,
        signal: new AbortController().signal,
      },
      async (url, init) => {
        const host = new URL(url as URL).host;
        hosts.push(host);
        if (host === "primary.example") {
          primaryCalls += 1;
          if (primaryCalls === 1) return new Response("busy", { status: 503 });
        } else {
          mirrorCalls += 1;
          if (mirrorCalls === 1) return new Response("busy", { status: 503 });
        }
        const range = new Headers(init?.headers).get("range");
        const start = range
          ? Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0)
          : 0;
        const slice = bytes.subarray(start);
        const headers: Record<string, string> = {
          "content-length": String(slice.length),
          ...(start > 0
            ? {
                "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
              }
            : {}),
        };
        if (host === "primary.example") {
          return new Response(fakeClockStream(slice, 1024, 50, init?.signal), {
            status: start > 0 ? 206 : 200,
            headers,
          });
        }
        return new Response(slice, {
          status: start > 0 ? 206 : 200,
          headers,
        });
      },
      {
        attempts: 3,
        retryDelayMs: 0,
        idleTimeoutMs: 5_000,
        slowCheckAfterMs: 100,
        minBytesPerSecond: 200_000,
        minRemainingMs: 300,
      },
    );
    expect(served).toBe("https://mirror.example/kit.tgz");
    expect(hosts).toEqual([
      "primary.example",
      "mirror.example",
      "primary.example",
      "mirror.example",
    ]);
    expect(await readFile(output)).toEqual(bytes);
  } finally {
    vi.useRealTimers();
  }
});

it("emits hostname-only diagnostic events on slow and failure mirror switches", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "performance"],
  });
  try {
    const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
    roots.push(root);
    const bytes = Buffer.alloc(64 * 1024, 0x67);
    const diagnostics: DownloadDiagnosticEvent[] = [];
    const output = path.join(root, "kit.tgz");
    const served = await downloadVerified(
      {
        url: "https://missing.example/private/kit.tgz",
        mirrors: [
          "https://slow.example/private/kit.tgz",
          "https://fast.example/private/kit.tgz",
        ],
        output,
        digest: createHash("sha256").update(bytes).digest("hex"),
        algorithm: "sha256",
        maxBytes: bytes.length,
        signal: new AbortController().signal,
        onDiagnostic: (event) => diagnostics.push(event),
      },
      async (url, init) => {
        const host = new URL(url as URL).host;
        if (host === "missing.example")
          return new Response("missing", { status: 404 });
        const range = new Headers(init?.headers).get("range");
        const start = range
          ? Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0)
          : 0;
        const slice = bytes.subarray(start);
        const headers: Record<string, string> = {
          "content-length": String(slice.length),
          ...(start > 0
            ? {
                "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
              }
            : {}),
        };
        if (host === "slow.example") {
          return new Response(fakeClockStream(slice, 1024, 50, init?.signal), {
            status: start > 0 ? 206 : 200,
            headers,
          });
        }
        return new Response(slice, {
          status: start > 0 ? 206 : 200,
          headers,
        });
      },
      {
        attempts: 2,
        retryDelayMs: 0,
        idleTimeoutMs: 5_000,
        slowCheckAfterMs: 100,
        minBytesPerSecond: 200_000,
        minRemainingMs: 300,
      },
    );
    expect(served).toBe("https://fast.example/private/kit.tgz");
    expect(diagnostics).toEqual([
      {
        kind: "host_switch",
        fromHost: "missing.example",
        toHost: "slow.example",
        reason: "HTTP 404",
        completed: 0,
      },
      expect.objectContaining({
        kind: "slow_switch",
        fromHost: "slow.example",
        toHost: "fast.example",
        total: bytes.length,
      }),
    ]);
    const slowSwitch = diagnostics[1];
    expect(slowSwitch?.kind).toBe("slow_switch");
    if (slowSwitch?.kind === "slow_switch") {
      expect(slowSwitch.bytesPerSecond).toBeGreaterThan(0);
      expect(slowSwitch.bytesPerSecond).toBeLessThan(200_000);
      expect(slowSwitch.completed).toBeGreaterThan(0);
    }
    expect(JSON.stringify(diagnostics)).not.toContain("/private/");
  } finally {
    vi.useRealTimers();
  }
});

it("restarts the slow check window when the response arrives late", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const bytes = Buffer.alloc(128 * 1024, 0x7a);
  const hosts: string[] = [];
  const output = path.join(root, "late.tgz");
  const served = await downloadVerified(
    {
      url: "https://primary.example/late.tgz",
      mirrors: ["https://mirror.example/late.tgz"],
      output,
      digest: createHash("sha256").update(bytes).digest("hex"),
      algorithm: "sha256",
      maxBytes: bytes.length,
      signal: new AbortController().signal,
    },
    async (url) => {
      const host = new URL(url as URL).host;
      hosts.push(host);
      if (host === "primary.example") {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              for (let offset = 0; offset < bytes.length; offset += 16384) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                try {
                  controller.enqueue(bytes.subarray(offset, offset + 16384));
                } catch {
                  return;
                }
              }
              try {
                controller.close();
              } catch {
                // Cancelled when switching to the mirror.
              }
            },
          }),
          { headers: { "content-length": String(bytes.length) } },
        );
      }
      return new Response(bytes, {
        headers: { "content-length": String(bytes.length) },
      });
    },
    {
      attempts: 2,
      retryDelayMs: 0,
      idleTimeoutMs: 5_000,
      slowCheckAfterMs: 1_500,
      minBytesPerSecond: 60_000,
      minRemainingMs: 100,
    },
  );
  expect(served).toBe("https://primary.example/late.tgz");
  expect(hosts).toEqual(["primary.example"]);
  expect(await readFile(output)).toEqual(bytes);
}, 10_000);

it("finishes on a slow mirror below the floor when the primary hangs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const bytes = Buffer.alloc(16 * 1024, 0x79);
  const hosts: string[] = [];
  const output = path.join(root, "slow-mirror.tgz");
  const startedAt = Date.now();
  const served = await downloadVerified(
    {
      url: "https://primary.example/slow-mirror.tgz",
      mirrors: ["https://mirror.example/slow-mirror.tgz"],
      output,
      digest: createHash("sha256").update(bytes).digest("hex"),
      algorithm: "sha256",
      maxBytes: bytes.length,
      signal: new AbortController().signal,
    },
    async (url, init) => {
      const host = new URL(url as URL).host;
      hosts.push(host);
      if (host === "primary.example") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      const range = new Headers(init?.headers).get("range");
      const start = range ? Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0) : 0;
      const slice = bytes.subarray(start);
      const headers: Record<string, string> = {
        "content-length": String(slice.length),
        ...(start > 0
          ? {
              "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
            }
          : {}),
      };
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let offset = 0; offset < slice.length; offset += 1024) {
              await new Promise((resolve) => setTimeout(resolve, 20));
              try {
                controller.enqueue(slice.subarray(offset, offset + 1024));
              } catch {
                return;
              }
            }
            try {
              controller.close();
            } catch {
              // Cancelled during round 0 comparison.
            }
          },
        }),
        { status: start > 0 ? 206 : 200, headers },
      );
    },
    {
      attempts: 2,
      retryDelayMs: 0,
      idleTimeoutMs: 2_000,
      slowCheckAfterMs: 80,
      minBytesPerSecond: 300_000,
      minRemainingMs: 100,
    },
  );
  expect(served).toBe("https://mirror.example/slow-mirror.tgz");
  expect(hosts).toEqual(["primary.example", "mirror.example"]);
  expect(Date.now() - startedAt).toBeLessThan(1_500);
  expect(await readFile(output)).toEqual(bytes);
}, 10_000);

it("promotes the only measured mirror when the primary hangs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const bytes = Buffer.alloc(16 * 1024, 0x78);
  const hosts: string[] = [];
  const output = path.join(root, "lone-mirror.tgz");
  const startedAt = Date.now();
  const served = await downloadVerified(
    {
      url: "https://primary.example/lone-mirror.tgz",
      mirrors: [
        "https://mirror.example/lone-mirror.tgz",
        "https://slow.example/lone-mirror.tgz",
      ],
      output,
      digest: createHash("sha256").update(bytes).digest("hex"),
      algorithm: "sha256",
      maxBytes: bytes.length,
      signal: new AbortController().signal,
    },
    async (url, init) => {
      const host = new URL(url as URL).host;
      hosts.push(host);
      if (host !== "mirror.example") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      const range = new Headers(init?.headers).get("range");
      const start = range ? Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0) : 0;
      const slice = bytes.subarray(start);
      const headers: Record<string, string> = {
        "content-length": String(slice.length),
        ...(start > 0
          ? {
              "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
            }
          : {}),
      };
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let offset = 0; offset < slice.length; offset += 1024) {
              await new Promise((resolve) => setTimeout(resolve, 20));
              try {
                controller.enqueue(slice.subarray(offset, offset + 1024));
              } catch {
                return;
              }
            }
            try {
              controller.close();
            } catch {
              // Cancelled during round 0 comparison.
            }
          },
        }),
        { status: start > 0 ? 206 : 200, headers },
      );
    },
    {
      attempts: 2,
      retryDelayMs: 0,
      idleTimeoutMs: 2_000,
      slowCheckAfterMs: 80,
      minBytesPerSecond: 300_000,
      minRemainingMs: 100,
    },
  );
  expect(served).toBe("https://mirror.example/lone-mirror.tgz");
  expect(hosts).toEqual([
    "primary.example",
    "mirror.example",
    "slow.example",
    "mirror.example",
  ]);
  expect(Date.now() - startedAt).toBeLessThan(1_500);
  expect(await readFile(output)).toEqual(bytes);
}, 10_000);

it("promotes the fastest mirror when the primary hangs and two mirrors run at similar speeds", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "linger-download-"));
  roots.push(root);
  const bytes = Buffer.alloc(16 * 1024, 0x76);
  const hosts: string[] = [];
  const output = path.join(root, "two-mirrors.tgz");
  const startedAt = Date.now();
  const served = await downloadVerified(
    {
      url: "https://primary.example/two-mirrors.tgz",
      mirrors: [
        "https://m1.example/two-mirrors.tgz",
        "https://m2.example/two-mirrors.tgz",
      ],
      output,
      digest: createHash("sha256").update(bytes).digest("hex"),
      algorithm: "sha256",
      maxBytes: bytes.length,
      signal: new AbortController().signal,
    },
    async (url, init) => {
      const host = new URL(url as URL).host;
      hosts.push(host);
      if (host === "primary.example") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      const range = new Headers(init?.headers).get("range");
      const start = range ? Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0) : 0;
      const slice = bytes.subarray(start);
      const headers: Record<string, string> = {
        "content-length": String(slice.length),
        ...(start > 0
          ? {
              "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
            }
          : {}),
      };
      // m1 is faster than m2 by less than the switch ratio; the fastest
      // measured mirror must still displace the unmeasured primary.
      const intervalMs = host === "m1.example" ? 10 : 14;
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let offset = 0; offset < slice.length; offset += 1024) {
              await new Promise((resolve) =>
                setTimeout(resolve, intervalMs),
              );
              try {
                controller.enqueue(slice.subarray(offset, offset + 1024));
              } catch {
                return;
              }
            }
            try {
              controller.close();
            } catch {
              // Cancelled during round 0 comparison.
            }
          },
        }),
        { status: start > 0 ? 206 : 200, headers },
      );
    },
    {
      attempts: 2,
      retryDelayMs: 0,
      idleTimeoutMs: 2_000,
      slowCheckAfterMs: 80,
      minBytesPerSecond: 300_000,
      minRemainingMs: 100,
    },
  );
  expect(served).toBe("https://m1.example/two-mirrors.tgz");
  expect(hosts).toEqual([
    "primary.example",
    "m1.example",
    "m2.example",
    "m1.example",
  ]);
  expect(Date.now() - startedAt).toBeLessThan(1_500);
  expect(await readFile(output)).toEqual(bytes);
}, 10_000);
