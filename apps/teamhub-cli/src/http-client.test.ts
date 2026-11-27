import { describe, expect, it, vi } from "vitest";
import {
  createTeamHubClient,
  operationHeaders,
  teamHubData,
} from "./http-client.js";
import {
  errorExitCode,
  formatCommandError,
  renderCommandError,
} from "./command-errors.js";
import { CliError } from "./errors.js";
import { displayText } from "./display-text.js";
import { requestBodyText } from "./test-support/fetch-text.js";

const config = {
  url: "https://teamhub.example",
  token: "th_agent_fixture",
  identityKey: "identity",
  scope: { kind: "room" as const, id: "room_one" },
};
describe("direct TeamHub HTTP client", () => {
  it("sends stable identity and business target directly without internal lifecycle fields", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ accepted: true }));
    const client = createTeamHubClient(config, { fetch: fetcher });
    expect(
      await teamHubData(
        client.api.POST("/api/agent/v1/direct-messages", {
          body: { content: "Hello" } as never,
          headers: operationHeaders("reply-1"),
        }),
      ),
    ).toEqual({ accepted: true });
    expect(displayText(fetcher.mock.calls[0]![0])).toBe(
      "https://teamhub.example/api/agent/v1/direct-messages",
    );
    const options = fetcher.mock.calls[0]![1]!;
    const headers = new Headers(options.headers);
    expect(headers.get("authorization")).toBe("Bearer th_agent_fixture");
    expect(headers.get("x-teamhub-context-kind")).toBe("room");
    expect(headers.get("x-teamhub-context-id")).toBe("room_one");
    expect(headers.get("x-teamhub-operation-id")).toBe("reply-1");
    expect(JSON.parse(requestBodyText(options.body))).toEqual({
      content: "Hello",
    });
    expect(options.redirect).toBe("error");
  });
  it("never forwards a credential to absolute or protocol-relative endpoints", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createTeamHubClient(config, { fetch: fetcher });
    for (const endpoint of [
      "https://other.example/api",
      "//other.example/api",
      "/api/../other",
      "/api?redirect=x",
    ]) {
      await expect(
        client.request(endpoint, { method: "POST" }),
      ).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not retry uncertain writes and includes the operation ID in the error", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("response lost"));
    const client = createTeamHubClient(config, { fetch: fetcher });
    await expect(
      client.api.POST("/api/agent/v1/direct-messages", {
        body: {} as never,
        headers: operationHeaders("stable-reply"),
      }),
    ).rejects.toMatchObject({
      code: "outcome_unknown",
      details: { operation_id: "stable-reply" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  describe.each(["api", "request"] as const)("%s writes", (transport) => {
    it.each([
      {
        name: "interrupted body",
        response: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new Error("response body disconnected"));
              },
            }),
            { status: 201 },
          ),
      },
      {
        name: "truncated JSON",
        response: () => new Response('{"accepted":', { status: 201 }),
      },
      {
        name: "unexpected JSON shape",
        response: () => Response.json([], { status: 201 }),
      },
      {
        name: "oversized body",
        response: () =>
          new Response(new Uint8Array(8 * 1024 * 1024 + 1), { status: 201 }),
      },
    ])(
      "retains the write operation ID after a successful status with $name",
      async ({ response }) => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
        const client = createTeamHubClient(config, { fetch: fetcher });
        await expect(
          transport === "api"
            ? client.api.POST("/api/agent/v1/direct-messages", {
                body: {} as never,
                headers: operationHeaders("stable-reply"),
              })
            : client.request("/api/agent/v1/messages/commit", {
                method: "POST",
                headers: operationHeaders("stable-reply"),
                body: new FormData(),
              }),
        ).rejects.toMatchObject({
          code: "outcome_unknown",
          details: { operation_id: "stable-reply" },
        });
        expect(fetcher).toHaveBeenCalledTimes(1);
      },
    );
  });
  it("keeps malformed read responses as invalid responses", async () => {
    const client = createTeamHubClient(config, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("{")),
    });
    await expect(
      client.api.GET("/api/agent/v1/files", {
        params: { query: { after_id: "", limit: 100 } },
      }),
    ).rejects.toMatchObject({ code: "invalid_response", details: {} });
  });
  it("accepts a successful write with no response body", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = createTeamHubClient(config, { fetch: fetcher });
    expect(
      await teamHubData(
        client.api.POST("/api/agent/v1/direct-messages", {
          body: {} as never,
          headers: operationHeaders("stable-reply"),
        }),
      ),
    ).toEqual({});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps direct successful write responses readable with their metadata", async () => {
    const body = '{\n  "accepted": true\n}\n';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, {
        status: 201,
        statusText: "Created",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          "x-request-id": "request-write",
        },
      }),
    );
    const client = createTeamHubClient(config, { fetch: fetcher });
    const response = await client.request("/api/agent/v1/messages/commit", {
      method: "POST",
      headers: operationHeaders("stable-reply"),
      body: new FormData(),
    });
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("x-request-id")).toBe("request-write");
    expect(response.bodyUsed).toBe(false);
    expect(response.headers.get("content-length")).toBe(
      String(Buffer.byteLength(body)),
    );
    expect(await response.text()).toBe(body);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps direct empty successful writes complete", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = createTeamHubClient(config, { fetch: fetcher });
    const response = await client.request("/api/agent/v1/messages/commit", {
      method: "POST",
      headers: operationHeaders("stable-reply"),
    });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not consume or apply the JSON limit to byte reads", async () => {
    const bytes = new Uint8Array(8 * 1024 * 1024 + 1).fill(255);
    const original = new Response(bytes);
    const client = createTeamHubClient(config, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(original),
    });
    const response = await client.request(
      "/api/agent/v1/files/document_one/content",
    );
    expect(original.bodyUsed).toBe(false);
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
  });
  it("preserves structured TeamHub permission and conflict errors", async () => {
    const client = createTeamHubClient(config, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            error: {
              code: "version_conflict",
              message: "Document changed",
              details: { current_version_id: "v2" },
            },
          },
          { status: 409 },
        ),
      ),
    });
    await expect(
      client.api.POST("/api/agent/v1/documents", {
        body: {} as never,
        headers: operationHeaders("stable-document"),
      }),
    ).rejects.toMatchObject({
      code: "version_conflict",
      details: {
        current_version_id: "v2",
        operation_id: "stable-document",
      },
    });
  });
  it("sends configured identity assertions and the Run to the credential authority and keeps shared links anonymous", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ accepted: true }));
    const client = createTeamHubClient(
      {
        ...config,
        identity: { tenantId: "tenant_one", agentId: "agent_one" },
        runId: "run_one",
      },
      { fetch: fetcher },
    );
    await client.api.POST("/api/agent/v1/direct-messages", {
      body: {} as never,
    });
    const authenticated = new Headers(fetcher.mock.calls[0]![1]!.headers);
    expect(authenticated.get("x-teamhub-expected-agent-id")).toBe("agent_one");
    expect(authenticated.get("x-teamhub-expected-tenant-id")).toBe(
      "tenant_one",
    );
    expect(authenticated.get("x-teamhub-run-id")).toBe("run_one");
    await client.request("/v0/shared-documents/content", {
      method: "POST",
      body: JSON.stringify({ token: "doc_link_fixture" }),
    });
    const anonymous = new Headers(fetcher.mock.calls[1]![1]!.headers);
    for (const key of [
      "authorization",
      "x-teamhub-context-id",
      "x-teamhub-expected-agent-id",
      "x-teamhub-run-id",
    ])
      expect(anonymous.has(key)).toBe(false);
  });
  it("retries 503 service_upgrading honoring Retry-After and succeeds once unfenced even with operationId", async () => {
    const sleeps: number[] = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "service_upgrading",
              message: "Service upgrade in progress; please retry shortly",
              retryable: true,
            },
          },
          { status: 503, headers: { "Retry-After": "5" } },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "service_upgrading",
              message: "Service upgrade in progress; please retry shortly",
              retryable: true,
            },
          },
          { status: 503, headers: { "Retry-After": "3" } },
        ),
      )
      .mockResolvedValueOnce(Response.json({ accepted: true }));
    const client = createTeamHubClient(config, {
      fetch: fetcher,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(
      await teamHubData(
        client.api.POST("/api/agent/v1/direct-messages", {
          body: { content: "Retry me" } as never,
          headers: operationHeaders("op-upgrade-1"),
        }),
      ),
    ).toEqual({ accepted: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([5000, 3000]);
  });
  it("throws explicit retryable service_upgrading (never outcome_unknown) after bounded 503 retries exhaust", async () => {
    const sleeps: number[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json(
        {
          error: {
            code: "service_upgrading",
            message: "Service upgrade in progress; please retry shortly",
            retryable: true,
            request_id: "req_upgrade_fence",
          },
        },
        { status: 503, headers: { "Retry-After": "5" } },
      ),
    );
    const client = createTeamHubClient(config, {
      fetch: fetcher,
      maxUpgradeRetries: 2,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    let caught: unknown;
    try {
      await client.api.POST("/api/agent/v1/direct-messages", {
        body: { content: "Still upgrading" } as never,
        headers: operationHeaders("op-upgrade-2"),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    const cliErr = caught as CliError;
    expect(cliErr.code).toBe("service_upgrading");
    expect(cliErr.code).not.toBe("outcome_unknown");
    expect(cliErr.details).toMatchObject({
      http_status: 503,
      retryable: true,
      retry_after_seconds: 5,
      operation_id: "op-upgrade-2",
      request_id: "req_upgrade_fence",
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([5000, 5000]);
    expect(errorExitCode(cliErr)).toBe(1);
    const formatted = formatCommandError(cliErr, { command: "message send" });
    expect(formatted.code).toBe("service_upgrading");
    expect(formatted.details?.retry_after_seconds).toBe(5);
    const rendered = renderCommandError(formatted);
    expect(rendered).toContain("teamhub: service_upgrading:");
    expect(rendered).toContain("Retry after: 5s");
  });
});
