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
});
