import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  createLocalComputerRouteHandlers,
  LocalComputerHttpError,
  registerLocalComputerModelRoutes,
} from "../../../../src/agent/executor/http/local-computer-http.js";
import {
  LocalComputerCapabilityError,
  LocalComputerNotFoundError,
  LocalComputerOfflineError,
  type LocalComputerManagement,
} from "../../../../src/agent/runner-gateway/local-computer-management.js";
import {
  LocalModelsActionTimeoutError,
  LocalModelsCustomUnsupportedError,
  type LocalModelActionAck,
  type LocalModelActionCommand,
} from "../../../../src/agent/runner-gateway/runner-local-models.js";

const path =
  "/v1/tenants/tenant-1/owners/actor-1/local-computers/computer-1/local-model-actions";
const expiresAt = "2026-11-13T10:00:10.000Z";

const createApp = (
  actOnLocalModels: (
    command: LocalModelActionCommand,
  ) => Promise<LocalModelActionAck>,
) => {
  const handlers = createLocalComputerRouteHandlers({
    localComputerManagement: {
      actOnLocalModels,
    } as unknown as LocalComputerManagement,
    pathId: (context, name) => context.req.param(name) ?? "",
    readJsonBody: (context) => context.req.json(),
  });
  const app = new Hono();
  registerLocalComputerModelRoutes(app, handlers);
  app.onError((error, context) =>
    error instanceof LocalComputerHttpError
      ? context.json({ code: error.errorCode }, error.status)
      : context.json({ code: "internal" }, 500),
  );
  return app;
};

const post = (app: Hono, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("Agent Management local-models action route", () => {
  it("forwards the action and returns the Computer's answer under the request ID", async () => {
    const act = vi.fn(
      async (
        _command: LocalModelActionCommand,
      ): Promise<LocalModelActionAck> => ({ outcome: "accepted" }),
    );
    const response = await post(createApp(act), {
      request_id: "request-1",
      action: "load",
      model_id: "qwen3-4b:Q4_K_M",
      unload_first: ["gemma-3:Q4"],
      expires_at: expiresAt,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      request_id: "request-1",
      outcome: "accepted",
    });
    expect(act).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        ownerActorId: "actor-1",
        computerId: "computer-1",
        action: "load",
        modelId: "qwen3-4b:Q4_K_M",
        unloadFirst: ["gemma-3:Q4"],
        expiresAt,
      }),
    );

    const refused = vi.fn(
      async (): Promise<LocalModelActionAck> => ({
        outcome: "refused",
        refusal: { code: "LOAD_NO_ROOM", pool: "gpu:0", need_bytes: 9 },
      }),
    );
    const refusal = await post(createApp(refused), {
      request_id: "request-2",
      action: "refresh",
      expires_at: expiresAt,
    });
    expect(refusal.status).toBe(200);
    expect(await refusal.json()).toEqual({
      request_id: "request-2",
      outcome: "refused",
      refusal: { code: "LOAD_NO_ROOM", pool: "gpu:0", need_bytes: 9 },
    });
  });

  it("rejects malformed actions before reaching the Computer", async () => {
    const act = vi.fn();
    const app = createApp(act);
    for (const body of [
      { request_id: "r", action: "download", expires_at: expiresAt },
      {
        request_id: "r",
        action: "refresh",
        model_id: "m:1",
        expires_at: expiresAt,
      },
      {
        request_id: "r",
        action: "unload",
        model_id: "m:1",
        unload_first: ["a:1"],
        expires_at: expiresAt,
      },
      {
        request_id: "r",
        action: "load",
        model_id: "m:1",
        unload_first: ["a:1", "a:1"],
        expires_at: expiresAt,
      },
      {
        request_id: "r",
        action: "load",
        model_id: "../m",
        expires_at: expiresAt,
      },
      {
        request_id: "r",
        action: "pause",
        model_id: "m:1",
        expires_at: expiresAt,
      },
      { request_id: "r", action: "unload", model_id: "m:1" },
      {
        request_id: "r",
        action: "unload",
        model_id: "m:1",
        expires_at: expiresAt,
        extra: true,
      },
    ]) {
      const response = await post(app, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({
        code: "INVALID_LOCAL_MODEL_ACTION",
      });
    }
    expect(act).not.toHaveBeenCalled();
  });

  it("maps Gateway failures to the codes TeamHub reads", async () => {
    for (const [error, status, code] of [
      [new LocalComputerNotFoundError(), 404, "LOCAL_COMPUTER_NOT_FOUND"],
      [new LocalComputerOfflineError(), 503, "LOCAL_COMPUTER_OFFLINE"],
      [
        new LocalComputerCapabilityError("no library"),
        409,
        "LOCAL_MODELS_UNSUPPORTED",
      ],
      [new LocalModelsActionTimeoutError(), 503, "LOCAL_MODELS_ACTION_TIMEOUT"],
    ] as const) {
      const response = await post(
        createApp(async () => {
          throw error;
        }),
        {
          request_id: "r",
          action: "unload",
          model_id: "m:1",
          expires_at: expiresAt,
        },
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ code });
    }
  });

  it("allows only POST", async () => {
    const response = await createApp(vi.fn()).request(path);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("accepts smoke_test and load force/context_tokens and maps custom unsupported to 409", async () => {
    const act = vi.fn(
      async (): Promise<LocalModelActionAck> => ({ outcome: "accepted" }),
    );
    const app = createApp(act);
    const smokeRes = await post(app, {
      request_id: "req-smoke",
      action: "smoke_test",
      model_id: "custom.hf.bartowski--qwen:Q4_K_M",
      context_tokens: 2048,
      expires_at: expiresAt,
    });
    expect(smokeRes.status).toBe(200);
    expect(act).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "smoke_test",
        modelId: "custom.hf.bartowski--qwen:Q4_K_M",
        contextTokens: 2048,
      }),
    );

    const loadRes = await post(app, {
      request_id: "req-load",
      action: "load",
      model_id: "custom.hf.bartowski--qwen:Q4_K_M",
      force: true,
      context_tokens: 2048,
      expires_at: expiresAt,
    });
    expect(loadRes.status).toBe(200);
    expect(act).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "load",
        force: true,
        contextTokens: 2048,
      }),
    );

    const unsupportedRes = await post(
      createApp(async () => {
        throw new LocalModelsCustomUnsupportedError();
      }),
      {
        request_id: "req-old",
        action: "smoke_test",
        model_id: "custom.hf.bartowski--qwen:Q4_K_M",
        context_tokens: 4096,
        expires_at: expiresAt,
      },
    );
    expect(unsupportedRes.status).toBe(409);
    expect(await unsupportedRes.json()).toEqual({
      code: "LOCAL_MODELS_CUSTOM_UNSUPPORTED",
    });
  });

  it("handles custom search, probe, and download routes without echoing tokens on 400", async () => {
    const searchCustomLocalModels = vi.fn(async () => ({
      query: "qwen",
      hub: "huggingface" as const,
      format: "compatible" as const,
      platform: "darwin" as const,
      arch: "arm64" as const,
      supported_formats: ["gguf" as const],
      results: [],
      warnings: [],
    }));
    const probeCustomLocalModel = vi.fn(async () => ({
      outcome: "gated" as const,
      hub_http_status: 401,
      token_provided: false,
    }));
    const downloadCustomLocalModel = vi.fn(
      async (): Promise<LocalModelActionAck> => ({
        outcome: "accepted",
        modelId: "custom.hf.bartowski--qwen:Q4_K_M",
      }),
    );
    const handlers = createLocalComputerRouteHandlers({
      localComputerManagement: {
        actOnLocalModels: vi.fn(),
        searchCustomLocalModels,
        probeCustomLocalModel,
        downloadCustomLocalModel,
      } as unknown as LocalComputerManagement,
      pathId: (context, name) => context.req.param(name) ?? "",
      readJsonBody: (context) => context.req.json(),
    });
    const app = new Hono();
    registerLocalComputerModelRoutes(app, handlers);
    app.onError((error, context) =>
      error instanceof LocalComputerHttpError
        ? context.json(
            { code: error.errorCode, message: error.message },
            error.status,
          )
        : context.json({ code: "internal" }, 500),
    );

    const base =
      "/v1/tenants/tenant-1/owners/actor-1/local-computers/computer-1/local-models/custom";
    const searchRes = await app.request(`${base}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hub: "huggingface", query: "qwen" }),
    });
    expect(searchRes.status).toBe(200);

    const probeRes = await app.request(`${base}/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "meta-llama/Llama-3.1-8B-GGUF" }),
    });
    expect(probeRes.status).toBe(200);
    expect(await probeRes.json()).toMatchObject({
      outcome: "gated",
      hub_http_status: 401,
    });

    const dlRes = await app.request(`${base}/download`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "req-dl-1",
        expires_at: expiresAt,
        custom_download: {
          hub: "huggingface",
          repo_id: "bartowski/Qwen",
          variant_id: "Q4_K_M",
        },
      }),
    });
    expect(dlRes.status).toBe(200);
    expect(await dlRes.json()).toEqual({
      request_id: "req-dl-1",
      outcome: "accepted",
      model_id: "custom.hf.bartowski--qwen:Q4_K_M",
    });

    // Validation error must never echo the supplied secret token.
    const secret = "hf_MustNeverBeEchoedIn400Errors12345";
    const badRes = await app.request(`${base}/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "", token: secret }),
    });
    expect(badRes.status).toBe(400);
    const badText = await badRes.text();
    expect(badText).not.toContain(secret);
  });
});
