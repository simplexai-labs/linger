import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import viteConfig, {
  developmentHealthPlugin,
  resolveAllowedDevHosts,
  resolveDevelopmentProxy,
} from "../../vite.config";

const temporaryRoots: string[] = [];

vi.mock("vite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vite")>()),
  loadEnv: vi.fn(() => ({})),
}));

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("Vite config", () => {
  it("prebundles the document editor dependencies before the first transcript opens", async () => {
    const config = viteConfig({ command: "serve", mode: "development" });
    expect(config.optimizeDeps?.include).toEqual(
      expect.arrayContaining([
        "@blocknote/core",
        "@blocknote/core/comments",
        "@blocknote/core/extensions",
        "@blocknote/core/yjs",
        "@blocknote/mantine",
        "@blocknote/react",
        "@hocuspocus/provider",
        "yjs",
      ]),
    );
  });

  it("revalidates development dependencies without changing production cache headers", async () => {
    const development = viteConfig({
      command: "serve",
      mode: "development",
    });
    const production = viteConfig({
      command: "build",
      mode: "production",
    });
    expect(development.server?.headers).toEqual({
      "Cache-Control": "no-cache",
    });
    expect(production.server?.headers).toBeUndefined();
  });

  it("proxies local services by default", () => {
    const development = viteConfig({ command: "serve", mode: "development" });
    expect(development.server?.proxy).toEqual(
      resolveDevelopmentProxy(
        "http://127.0.0.1:8080",
        "http://127.0.0.1:4321",
        "http://127.0.0.1:4319",
      ),
    );
  });

  it("allows additional debug hosts without duplicating defaults", () => {
    expect(resolveAllowedDevHosts("debug.internal, 127.0.0.1")).toEqual([
      "127.0.0.1",
      "debug.internal",
    ]);
  });

  it("proxies public HTTP, the Agent CLI API, Document collaboration, and the Computer release", () => {
    expect(
      resolveDevelopmentProxy(
        "http://localhost:8080",
        "http://localhost:4320",
        "http://127.0.0.1:4319",
      ),
    ).toEqual({
      "/api/agent/": {
        changeOrigin: true,
        target: "http://localhost:8080",
        xfwd: true,
      },
      "/install/": { changeOrigin: true, target: "http://127.0.0.1:4319" },
      "/document-collaboration": {
        changeOrigin: true,
        target: "http://localhost:4320",
        ws: true,
      },
      "/v0": {
        changeOrigin: true,
        target: "http://localhost:8080",
        ws: true,
        xfwd: true,
      },
    });
  });

  it("answers the exact development health route", () => {
    const middleware = captureDevelopmentHealthMiddleware();
    const response = createResponseFake();
    const next = vi.fn();

    middleware({ method: "GET", url: "/healthz?probe=1" }, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(200);
    expect(response.setHeader).toHaveBeenCalledWith(
      "content-type",
      "application/json; charset=utf-8",
    );
    expect(response.end).toHaveBeenCalledWith(
      JSON.stringify({
        ok: true,
        service: "linger-web-dev",
      }),
    );
  });

  it("passes nested health paths to the remaining Vite middleware", () => {
    const middleware = captureDevelopmentHealthMiddleware();
    const response = createResponseFake();
    const next = vi.fn();

    middleware({ method: "GET", url: "/healthz/missing" }, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(response.end).not.toHaveBeenCalled();
  });

  it("answers /readyz by probing TeamHub /healthz when configured", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false }), { status: 503 }),
      )
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const middleware = captureDevelopmentHealthMiddleware(
      "http://127.0.0.1:8080",
    );

    const healthy = createResponseFake();
    middleware({ method: "GET", url: "/readyz" }, healthy, vi.fn());
    await vi.waitFor(() => expect(healthy.end).toHaveBeenCalledOnce());
    expect(healthy.statusCode).toBe(200);
    expect(healthy.end).toHaveBeenCalledWith(
      JSON.stringify({ ok: true, service: "linger-web-dev" }),
    );

    const degraded = createResponseFake();
    middleware({ method: "HEAD", url: "/readyz" }, degraded, vi.fn());
    await vi.waitFor(() => expect(degraded.end).toHaveBeenCalledOnce());
    expect(degraded.statusCode).toBe(503);
    expect(degraded.end).toHaveBeenCalledWith(undefined);

    const unreachable = createResponseFake();
    middleware({ method: "GET", url: "/readyz" }, unreachable, vi.fn());
    await vi.waitFor(() => expect(unreachable.end).toHaveBeenCalledOnce());
    expect(unreachable.statusCode).toBe(502);
    expect(unreachable.end).toHaveBeenCalledWith(
      JSON.stringify({
        ok: false,
        service: "linger-web-dev",
        upstream: "teamhub",
      }),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("answers 502 without throwing when teamHubBaseUrl is malformed", () => {
    const middleware = captureDevelopmentHealthMiddleware("://not-a-valid-url");
    const response = createResponseFake();
    const next = vi.fn();

    middleware({ method: "GET", url: "/readyz" }, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(502);
    expect(response.end).toHaveBeenCalledWith(
      JSON.stringify({
        ok: false,
        service: "linger-web-dev",
        upstream: "teamhub",
      }),
    );
  });
});

type DevelopmentHealthMiddleware = (
  request: { method?: string; url?: string },
  response: ReturnType<typeof createResponseFake>,
  next: () => void,
) => void;

function captureDevelopmentHealthMiddleware(
  teamHubBaseUrl?: string,
): DevelopmentHealthMiddleware {
  const middlewares: unknown[] = [];
  const configureServer =
    developmentHealthPlugin(teamHubBaseUrl).configureServer;

  if (typeof configureServer !== "function") {
    throw new Error("Expected development health plugin to configure Vite.");
  }

  void configureServer.call(
    {} as never,
    {
      middlewares: {
        use: (middleware: unknown) => {
          middlewares.push(middleware);
        },
      },
    } as never,
  );

  const middleware = middlewares[0];
  if (typeof middleware !== "function") {
    throw new Error("Expected development health middleware to be installed.");
  }

  return middleware as DevelopmentHealthMiddleware;
}

function createResponseFake() {
  return {
    end: vi.fn(),
    setHeader: vi.fn(),
    statusCode: 0,
  };
}
