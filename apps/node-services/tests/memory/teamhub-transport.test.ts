import { expect, it, vi } from "vitest";
import {
  teamHubFetch,
  withTeamHubTrace,
} from "../../src/memory/teamhub-transport.js";
import { readPublishedWiki } from "../../src/memory/teamhub-wiki.js";
import { fetchTeamHubDocumentVersionContent } from "../../src/memory/teamhub-content.js";

it("preserves Request headers and payload when adding transport metadata", async () => {
  const request = new Request("http://teamhub.test/internal/v1/test", {
    method: "POST",
    headers: {
      authorization: "Bearer fixture-credential",
      "content-type": "application/json",
      "x-request-id": "request_a",
    },
    body: '{"version":1}',
  });
  await teamHubFetch(async (input, init) => {
    const forwarded = new Request(input, init);
    expect(forwarded.headers.get("authorization")).toBe(
      "Bearer fixture-credential",
    );
    expect(forwarded.headers.get("content-type")).toBe("application/json");
    expect(forwarded.headers.get("x-request-id")).toBe("request_a");
    expect(forwarded.headers.get("user-agent")).toMatch(/^linger-memory\//u);
    expect(await forwarded.text()).toBe('{"version":1}');
    return new Response();
  })(request);
});

it("retains fetch's explicit header replacement semantics", async () => {
  const request = new Request("http://teamhub.test/internal/v1/test", {
    headers: { authorization: "Bearer old", "x-old-header": "old" },
  });
  await teamHubFetch(async (input, init) => {
    const forwarded = new Request(input, init);
    expect(forwarded.headers.get("authorization")).toBe("Bearer new");
    expect(forwarded.headers.has("x-old-header")).toBe(false);
    return new Response();
  })(request, { headers: { authorization: "Bearer new" } });
});

it("sets memory UA and propagates valid task trace without adding sensitive headers", async () => {
  const trace = "00-11111111111111111111111111111111-2222222222222222-01";
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
    const headers = new Headers(init?.headers);
    expect(headers.get("user-agent")).toMatch(/^linger-memory\//u);
    expect(headers.get("traceparent")).toBe(trace);
    expect(headers.has("baggage")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
    return new Response("content");
  });
  const access = {
    baseUrl: "http://teamhub.test",
    token: "fixture",
    fetch: fetcher,
  };
  await withTeamHubTrace(trace, async () => {
    await fetchTeamHubDocumentVersionContent(access, "tenant_a", "version_a");
    await expect(readPublishedWiki(access, "owner_a")).rejects.toThrow();
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  await withTeamHubTrace("invalid", async () => {
    await teamHubFetch(async (_input, init) => {
      expect(new Headers(init?.headers).has("traceparent")).toBe(false);
      return new Response();
    })("http://teamhub.test");
  });
});
