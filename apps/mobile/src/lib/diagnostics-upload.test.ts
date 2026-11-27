import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";

import {
  DiagnosticsUploadError,
  diagnosticsZip,
  isUploadUrl,
  uploadDiagnostics,
} from "./diagnostics-upload";

describe("uploadDiagnostics", () => {
  it("refuses an answer that came from somewhere else", async () => {
    const fetch = vi.fn(async () => {
      const response = new Response("{}", { status: 201 });
      Object.defineProperty(response, "url", {
        value: "https://elsewhere.example.com/take",
      });
      return response;
    });
    await expect(
      uploadDiagnostics({
        endpoint: "https://ci.example.com/v0/diagnostics/reports",
        zip: diagnosticsZip({ "app.log": "" }),
        client: { version: "0.1.0", platform: "ios-18.2" },
        fetch: fetch,
      }),
    ).rejects.toThrow("somewhere else");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("asks for a ticket as linger-mobile, then puts the zip", async () => {
    const zip = diagnosticsZip({ "app.log": '{"event":"app.started"}\n' });
    expect(strFromU8(unzipSync(zip)["app.log"]!)).toContain("app.started");
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST")
        return new Response(
          JSON.stringify({
            schema: "linger.diagnostics-upload/v1",
            reportId: "LD-7K3Q9XPM",
            upload: {
              method: "PUT",
              url: "https://storage.example.com/r.zip",
              headers: { "content-type": "application/zip", Host: "evil" },
            },
          }),
          { status: 201 },
        );
      return new Response(null, { status: 200 });
    });
    const id = await uploadDiagnostics({
      endpoint: "https://ci.example.com/v0/diagnostics/reports",
      zip,
      client: { version: "0.1.0", platform: "ios-18.2" },
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(id).toBe("LD-7K3Q9XPM");
    const asked = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    expect(asked).toMatchObject({
      schema: "linger.diagnostics-upload/v1",
      size: zip.length,
      client: { name: "linger-mobile", version: "0.1.0", platform: "ios-18.2" },
    });
    expect(asked.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fetch.mock.calls[1]![1]!.headers).toEqual({
      "content-type": "application/zip",
    });
  });

  it("offers Try Again only for rate limits and receiver failures", async () => {
    const answer = (status: number) =>
      uploadDiagnostics({
        endpoint: "https://ci.example.com/r",
        zip: new Uint8Array([1]),
        client: { version: "1", platform: "ios" },
        fetch: async () =>
          new Response(
            JSON.stringify({ error: { code: "X", message: "No." } }),
            { status },
          ),
      }).catch((error: DiagnosticsUploadError) => error);
    expect(await answer(429)).toMatchObject({ retry: true, message: "No." });
    expect(await answer(413)).toMatchObject({ retry: false });
  });

  it("accepts https and loopback http receivers only", () => {
    expect(isUploadUrl("https://ci.heylinger.com/v0/diagnostics/reports")).toBe(
      true,
    );
    expect(isUploadUrl("http://localhost:8080/r")).toBe(true);
    expect(isUploadUrl("http://example.com/r")).toBe(false);
    expect(isUploadUrl("https://user:pw@example.com/r")).toBe(false);
  });
});
