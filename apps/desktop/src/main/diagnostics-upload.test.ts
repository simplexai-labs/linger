import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hostedDiagnosticsUploadUrl } from "../../scripts/diagnostics-upload-url.mjs";

import type { SetupDiagnosticsSend } from "../shared/setup.js";
import { ConfigStore } from "./config.js";
import {
  DIAGNOSTICS_UPLOAD_SCHEMA,
  DiagnosticsSender,
  DiagnosticsUploadError,
  HOSTED_DIAGNOSTICS_UPLOAD_URL,
  MAX_DIAGNOSTICS_UPLOAD_BYTES,
  consentText,
  diagnosticsUploadUrl,
  isUploadUrl,
  sendWithPrompts,
  uploadDiagnostics,
  type DiagnosticsPrompts,
  type PreparedDiagnostics,
} from "./diagnostics-upload.js";
import { translator } from "../i18n/language.js";
import { tempDirectory } from "./test-support.js";

describe("isUploadUrl", () => {
  it.each([
    "https://diagnostics.example.com/v1/reports",
    "http://127.0.0.1:8080/v1/reports",
    "http://localhost:8080/v1/reports",
    "http://[::1]:8080/v1/reports",
  ])("accepts %s", (url) => expect(isUploadUrl(url)).toBe(true));

  it.each([
    "http://diagnostics.example.com/v1/reports",
    "https://user:pass@diagnostics.example.com/",
    "ftp://diagnostics.example.com/",
    "not a url",
  ])("refuses %s", (url) => expect(isUploadUrl(url)).toBe(false));
});

describe("diagnosticsUploadUrl in config.json", () => {
  it("keeps a valid receiver and drops an invalid one without the rest", () => {
    const file = path.join(tempDirectory(), "config.json");
    writeFileSync(
      file,
      JSON.stringify({
        computerId: "computer-1",
        diagnosticsUploadUrl: "https://diagnostics.example.com/v1/reports",
      }),
    );
    expect(diagnosticsUploadUrl(new ConfigStore(file).get())).toBe(
      "https://diagnostics.example.com/v1/reports",
    );
    writeFileSync(
      file,
      JSON.stringify({
        computerId: "computer-1",
        diagnosticsUploadUrl: "http://diagnostics.example.com/v1/reports",
      }),
    );
    const config = new ConfigStore(file).get();
    expect(config.computerId).toBe("computer-1");
    expect(config.diagnosticsUploadUrl).toBeUndefined();
    expect(diagnosticsUploadUrl(config)).toBeUndefined();
  });
});

describe("hosted receiver from the build", () => {
  const hosted = "https://diagnostics.example.com/v1/reports";

  it("is none without LINGER_DIAGNOSTICS_UPLOAD_URL", () => {
    expect(hostedDiagnosticsUploadUrl(undefined)).toBeNull();
    expect(hostedDiagnosticsUploadUrl("")).toBeNull();
    expect(hostedDiagnosticsUploadUrl("  ")).toBeNull();
    expect(HOSTED_DIAGNOSTICS_UPLOAD_URL).toBeUndefined();
  });

  it("keeps an https URL", () => {
    expect(hostedDiagnosticsUploadUrl(` ${hosted}\n`)).toBe(hosted);
  });

  it.each([
    "http://diagnostics.example.com/v1/reports",
    "https://user:pass@diagnostics.example.com/v1/reports",
    "not a url",
  ])("fails the build for %s without repeating it", (value) => {
    expect(() => hostedDiagnosticsUploadUrl(value)).toThrow(
      /^LINGER_DIAGNOSTICS_UPLOAD_URL must be an https URL/,
    );
    try {
      hostedDiagnosticsUploadUrl(value);
    } catch (error) {
      expect((error as Error).message).not.toContain(value);
    }
  });

  it("falls back to it after config.json", () => {
    expect(diagnosticsUploadUrl({}, undefined)).toBeUndefined();
    expect(diagnosticsUploadUrl({}, hosted)).toBe(hosted);
    expect(
      diagnosticsUploadUrl(
        { diagnosticsUploadUrl: "https://self.example.com/reports" },
        hosted,
      ),
    ).toBe("https://self.example.com/reports");
  });

  // The same define build.mjs passes, so the bundle carries the value or none.
  it.each([
    [hosted, hosted],
    [undefined, undefined],
  ])(
    "bundles %s as the hosted receiver",
    async (value, expected) => {
      const outfile = path.join(tempDirectory(), "diagnostics-upload.mjs");
      await build({
        entryPoints: [path.join(import.meta.dirname, "diagnostics-upload.ts")],
        outfile,
        bundle: true,
        platform: "node",
        format: "esm",
        logLevel: "silent",
        define: {
          __HOSTED_DIAGNOSTICS_UPLOAD_URL__: JSON.stringify(
            hostedDiagnosticsUploadUrl(value),
          ),
        },
      });
      const bundled = (await import(
        pathToFileURL(outfile).href
      )) as typeof import("./diagnostics-upload.js");
      expect(bundled.HOSTED_DIAGNOSTICS_UPLOAD_URL).toBe(expected);
      expect(bundled.diagnosticsUploadUrl({})).toBe(expected);
    },
    30_000,
  );
});

interface Received {
  ticket?: Record<string, unknown>;
  put?: { headers: http.IncomingHttpHeaders; body: Buffer };
}

// A receiver on this computer: POST hands out a ticket for PUT /blob.
const receiver = async (
  answer?: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => boolean,
) => {
  const received: Received = {};
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      if (answer?.(request, response)) return;
      if (request.method === "POST") {
        received.ticket = JSON.parse(body.toString("utf8")) as Record<
          string,
          unknown
        >;
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            schema: DIAGNOSTICS_UPLOAD_SCHEMA,
            reportId: "LD-7K3Q9XPM",
            upload: {
              method: "PUT",
              url: `http://127.0.0.1:${port()}/blob?signature=abc`,
              headers: {
                "content-type": "application/zip",
                "Content-Length": "1",
              },
            },
          }),
        );
        return;
      }
      received.put = { headers: request.headers, body };
      response.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const port = () => (server.address() as AddressInfo).port;
  servers.push(server);
  return { url: `http://127.0.0.1:${port()}/v1/reports`, received };
};

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

const zipFile = (bytes = 200_000): { file: string; data: Buffer } => {
  const file = path.join(tempDirectory(), "linger-diagnostics.zip");
  const data = Buffer.alloc(bytes, 7);
  writeFileSync(file, data);
  return { file, data };
};

const client = { version: "1.2.3", platform: "linux-x64" };

describe("uploadDiagnostics", () => {
  it("asks for a ticket, then PUTs the zip where it says", async () => {
    const { url, received } = await receiver();
    const { file, data } = zipFile();
    const progress: number[] = [];
    const reportId = await uploadDiagnostics({
      endpoint: url,
      file,
      bytes: data.length,
      client,
      onProgress: (sent) => progress.push(sent),
    });
    expect(reportId).toBe("LD-7K3Q9XPM");
    expect(received.ticket).toEqual({
      schema: DIAGNOSTICS_UPLOAD_SCHEMA,
      size: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
      client: { name: "linger-desktop", ...client },
    });
    expect(received.put!.body.equals(data)).toBe(true);
    expect(received.put!.headers["content-type"]).toBe("application/zip");
    // The receiver cannot set the length the client sends.
    expect(received.put!.headers["content-length"]).toBe(String(data.length));
    expect(progress.at(-1)).toBe(data.length);
  });

  it("refuses a bundle over the limit without a request", async () => {
    const { url, received } = await receiver();
    const { file } = zipFile(10);
    await expect(
      uploadDiagnostics({
        endpoint: url,
        file,
        bytes: MAX_DIAGNOSTICS_UPLOAD_BYTES + 1,
        client,
      }),
    ).rejects.toMatchObject({ retryable: false });
    expect(received.ticket).toBeUndefined();
  });

  it("says when to try again after a rate limit", async () => {
    const { url } = await receiver((request, response) => {
      response
        .writeHead(429, {
          "content-type": "application/json",
          "retry-after": "600",
        })
        .end(
          JSON.stringify({
            error: { code: "RATE_LIMITED", message: "Slow down" },
          }),
        );
      return true;
    });
    const { file, data } = zipFile(10);
    const error = await uploadDiagnostics({
      endpoint: url,
      file,
      bytes: data.length,
      client,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DiagnosticsUploadError);
    expect(error).toMatchObject({
      retryable: true,
      message: "Too many reports were sent. Try again in 10 min.",
    });
  });

  it("does not retry a bundle the server finds too large", async () => {
    const { url } = await receiver((request, response) => {
      response.writeHead(413).end();
      return true;
    });
    const { file, data } = zipFile(10);
    await expect(
      uploadDiagnostics({ endpoint: url, file, bytes: data.length, client }),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("refuses a ticket that would upload over plain http", async () => {
    const { url, received } = await receiver((request, response) => {
      if (request.method !== "POST") return false;
      response.writeHead(201, { "content-type": "application/json" }).end(
        JSON.stringify({
          schema: DIAGNOSTICS_UPLOAD_SCHEMA,
          reportId: "LD-1",
          upload: { method: "PUT", url: "http://storage.example.com/x" },
        }),
      );
      return true;
    });
    const { file, data } = zipFile(10);
    await expect(
      uploadDiagnostics({ endpoint: url, file, bytes: data.length, client }),
    ).rejects.toThrow("doesn't understand");
    expect(received.put).toBeUndefined();
  });

  it("reports a refused PUT", async () => {
    const { url } = await receiver((request, response) => {
      if (request.method !== "PUT") return false;
      response.writeHead(403).end();
      return true;
    });
    const { file, data } = zipFile(10);
    await expect(
      uploadDiagnostics({ endpoint: url, file, bytes: data.length, client }),
    ).rejects.toThrow("The upload was refused (HTTP 403)");
  });
});

const bundle = (): PreparedDiagnostics => {
  const { file, data } = zipFile(10);
  return {
    file,
    entries: ["summary.json", "desktop/logs/main.log"],
    bytes: data.length,
  };
};

const sender = (
  upload: (bundle: PreparedDiagnostics) => Promise<string>,
  options: {
    endpoint?: string | undefined;
    prepare?: () => Promise<PreparedDiagnostics>;
  } = {},
) => {
  const states: SetupDiagnosticsSend["phase"][] = [];
  const prepared: PreparedDiagnostics[] = [];
  const instance = new DiagnosticsSender({
    endpoint: () =>
      "endpoint" in options
        ? options.endpoint
        : "https://diagnostics.example.com/v1/reports",
    prepare:
      options.prepare ??
      (async () => {
        const next = bundle();
        prepared.push(next);
        return next;
      }),
    upload: (_endpoint, next, onProgress) => {
      onProgress(next.bytes);
      return upload(next);
    },
    discard: async (file) => writeFileSync(`${file}.discarded`, ""),
    onChange: (state) => states.push(state.phase),
  });
  return { instance, states, prepared };
};

const discarded = (item: PreparedDiagnostics) =>
  existsSync(`${item.file}.discarded`);

describe("DiagnosticsSender", () => {
  it("shows what will be sent and uploads nothing before consent", async () => {
    const upload = vi.fn(async () => "LD-1");
    const { instance, prepared } = sender(upload);
    await instance.start();
    expect(instance.state()).toEqual({
      phase: "confirm",
      host: "diagnostics.example.com",
      files: ["summary.json", "desktop/logs/main.log"],
      bytes: 10,
    });
    expect(upload).not.toHaveBeenCalled();
    await instance.cancel();
    expect(instance.state()).toEqual({ phase: "idle" });
    expect(discarded(prepared[0]!)).toBe(true);
    expect(upload).not.toHaveBeenCalled();
  });

  it("uploads after consent and shows the report id", async () => {
    const { instance, states, prepared } = sender(async () => "LD-7K3Q9XPM");
    await instance.start();
    await instance.confirm();
    expect(instance.state()).toEqual({
      phase: "sent",
      host: "diagnostics.example.com",
      reportId: "LD-7K3Q9XPM",
    });
    expect(states).toEqual([
      "preparing",
      "confirm",
      "sending",
      "sending",
      "sent",
    ]);
    expect(discarded(prepared[0]!)).toBe(true);
  });

  it("tries the same bundle again after a retryable failure", async () => {
    const upload = vi
      .fn<(bundle: PreparedDiagnostics) => Promise<string>>()
      .mockRejectedValueOnce(new DiagnosticsUploadError("offline", true))
      .mockResolvedValueOnce("LD-2");
    const { instance, prepared } = sender(upload);
    await instance.start();
    await instance.confirm();
    expect(instance.state()).toEqual({
      phase: "failed",
      error: "offline",
      retry: true,
    });
    expect(discarded(prepared[0]!)).toBe(false);
    await instance.retry();
    expect(instance.state()).toMatchObject({ phase: "sent", reportId: "LD-2" });
    expect(upload.mock.calls.map(([item]) => item)).toEqual([
      prepared[0],
      prepared[0],
    ]);
    expect(prepared).toHaveLength(1);
  });

  it("drops the bundle when trying again cannot help", async () => {
    const { instance, prepared } = sender(async () => {
      throw new DiagnosticsUploadError("too large", false);
    });
    await instance.start();
    await instance.confirm();
    expect(instance.state()).toEqual({
      phase: "failed",
      error: "too large",
      retry: false,
    });
    expect(discarded(prepared[0]!)).toBe(true);
    await instance.retry();
    expect(instance.state().phase).toBe("failed");
  });

  it("collects again when collecting failed", async () => {
    const prepare = vi
      .fn<() => Promise<PreparedDiagnostics>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockImplementationOnce(async () => bundle());
    const { instance } = sender(async () => "LD-3", { prepare });
    await instance.start();
    expect(instance.state()).toEqual({
      phase: "failed",
      error: "Couldn't collect the diagnostics: disk full",
      retry: true,
    });
    await instance.retry();
    expect(instance.state().phase).toBe("confirm");
  });

  it("fails without a receiver", async () => {
    const { instance } = sender(async () => "LD-4", { endpoint: undefined });
    await instance.start();
    expect(instance.state()).toMatchObject({ phase: "failed", retry: false });
  });
});

const prompts = (answers: { consent: boolean; retry?: boolean }) => {
  const asked: string[] = [];
  const value: DiagnosticsPrompts = {
    consent: async () => {
      asked.push("consent");
      return answers.consent;
    },
    sent: async (state) => {
      asked.push(`sent ${state.reportId}`);
    },
    failed: async (state) => {
      asked.push(`failed ${state.error}`);
      return answers.retry ?? false;
    },
    busy: async () => {
      asked.push("busy");
    },
  };
  return { value, asked };
};

describe("sendWithPrompts", () => {
  it("sends nothing when consent is declined", async () => {
    const upload = vi.fn(async () => "LD-1");
    const { instance } = sender(upload);
    const { value, asked } = prompts({ consent: false });
    await sendWithPrompts(instance, value);
    expect(asked).toEqual(["consent"]);
    expect(upload).not.toHaveBeenCalled();
    expect(instance.state().phase).toBe("idle");
  });

  it("offers Try Again, then shows the report id", async () => {
    const upload = vi
      .fn<(bundle: PreparedDiagnostics) => Promise<string>>()
      .mockRejectedValueOnce(new DiagnosticsUploadError("offline", true))
      .mockResolvedValueOnce("LD-5");
    const { instance } = sender(upload);
    const { value, asked } = prompts({ consent: true, retry: true });
    await sendWithPrompts(instance, value);
    expect(asked).toEqual(["consent", "failed offline", "sent LD-5"]);
    expect(instance.state().phase).toBe("idle");
  });

  it("asks about a report left waiting for consent", async () => {
    const upload = vi.fn(async () => "LD-6");
    const { instance } = sender(upload);
    await instance.start();
    const { value, asked } = prompts({ consent: true });
    await sendWithPrompts(instance, value);
    expect(asked).toEqual(["consent", "sent LD-6"]);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("says so while another send runs", async () => {
    let finish = (_id: string) => {};
    const { instance } = sender(
      () => new Promise<string>((resolve) => (finish = resolve)),
    );
    await instance.start();
    const sending = instance.confirm();
    const { value, asked } = prompts({ consent: true });
    await sendWithPrompts(instance, value);
    expect(asked).toEqual(["busy"]);
    finish("LD-7");
    await sending;
  });
});

describe("consentText", () => {
  it("names the receiver, the size and the files", () => {
    const text = consentText(
      {
        phase: "confirm",
        host: "diagnostics.example.com",
        files: ["a", "b", "c"],
        bytes: 3 * 1024 * 1024,
      },
      translator("en"),
      2,
    );
    expect(text.message).toBe("Send diagnostics to diagnostics.example.com?");
    expect(text.detail).toContain("3 files, 3.0 MB");
    expect(text.detail).toContain("  a\n  b\n  and 1 more");
  });
});
