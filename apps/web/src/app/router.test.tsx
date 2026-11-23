import { QueryClient } from "@tanstack/react-query";
import {
  matchRoutes,
  RouterContextProvider,
  type LoaderFunction,
  type RouteObject,
} from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";
import {
  teamHubIdentityQueryKey,
  teamHubSessionQueryKey,
  teamHubTenantQueryKey,
} from "@/features/rooms/room-queries";

import { createAppRoutes } from "./router";

afterEach(() => vi.useRealTimers());

describe("Web app route contract", () => {
  it("bounds an unresponsive landing loader without letting its late failure clear a new Session", async () => {
    vi.useFakeTimers();
    const runtime = createTestTeamHubRuntime();
    runtime.server.on("GET", "/v0/session", () => ({ id: "current" }));
    let respondLate!: (response: Response) => void;
    runtime.server.on(
      "GET",
      "/v0/tenants",
      () =>
        new Promise((resolve) => {
          respondLate = resolve;
        }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const loader = createAppRoutes(queryClient, runtime).find(
      (route) => route.path === "/",
    )!.loader as LoaderFunction;
    const result = Promise.resolve(
      loader({
        request: new Request("http://localhost/"),
        url: new URL("http://localhost/"),
        pattern: "/",
        params: {},
        context: new RouterContextProvider(),
      }),
    );
    const assertion = expect(result).rejects.toMatchObject({
      code: "AUTHENTICATION_TIMEOUT",
      status: 408,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    queryClient.setQueryData(teamHubSessionQueryKey, { id: "new-session" });
    respondLate(teamHubErrorResponse(401, "UNAUTHENTICATED", "old request"));
    await vi.advanceTimersByTimeAsync(0);
    expect(queryClient.getQueryData(teamHubSessionQueryKey)).toEqual({
      id: "new-session",
    });
    queryClient.clear();
  });

  it("mounts the Room-first Product Client surfaces", () => {
    const paths = routePaths();

    expect(paths).toEqual(
      expect.arrayContaining([
        "/",
        "/login",
        "/oauth/composio-complete",
        "/t/:tenantId",
        "rooms",
        "rooms/:roomId",
        "chat",
        "profile",
        "dashboard/:workItemId",
        "documents/:documentId",
        "settings",
        "account",
        "security",
        "wiki/:collection?",
        "meetings",
      ]),
    );
  });

  it("keeps Work Item links and Room chat reachable", () => {
    const routes = createAppRoutes(
      new QueryClient(),
      createTestTeamHubRuntime(),
    );
    expect(
      matchRoutes(routes, "/t/tenant-a/dashboard")?.at(-1)?.route.path,
    ).toBe("*");
    expect(
      matchRoutes(routes, "/t/tenant-a/dashboard/work-item-a")?.at(-1)?.route
        .path,
    ).toBe("dashboard/:workItemId");
    expect(
      matchRoutes(routes, "/t/tenant-a/rooms/room-a/chat")?.at(-1)?.route.path,
    ).toBe("chat");
  });

  it("mounts My Documents, Shared with me, and Wiki below Library", () => {
    const tenantRoute = createAppRoutes(
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      createTestTeamHubRuntime(),
    ).find((route) => route.path === "/t/:tenantId");

    // Library sits in the pathless Workspace layout beside opened Documents.
    const workspace = tenantRoute?.children?.find((route) =>
      route.children?.some((child) => child.path === "documents/:documentId"),
    );
    const library = workspace?.children?.find(
      (route) => route.path === "library",
    );
    expect(library?.children?.map((route) => route.path)).toEqual(
      expect.arrayContaining([
        "my-documents",
        "shared-with-me",
        "wiki/:collection?",
        "meetings",
      ]),
    );
    expect(routePaths().some((path) => path.includes("artifact"))).toBe(false);
  });

  it("opens every unified Document through one stable identity route", () => {
    expect(routePaths()).toContain("documents/:documentId");
  });

  it("redirects legacy settings/local-models URLs to settings/models with query params", async () => {
    const routes = createAppRoutes(
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      createTestTeamHubRuntime(),
    );
    const matched = matchRoutes(routes, "/t/tenant-a/settings/local-models");
    const route = matched?.at(-1)?.route;
    expect(route?.path).toBe("local-models");
    const loader = route?.loader as LoaderFunction;
    let thrown: unknown;
    try {
      await loader({
        context: new RouterContextProvider(),
        params: { tenantId: "tenant-a" },
        pattern: "/t/:tenantId/settings/local-models",
        request: new Request(
          "http://localhost/t/tenant-a/settings/local-models?computer=comp-1",
        ),
        url: new URL(
          "http://localhost/t/tenant-a/settings/local-models?computer=comp-1",
        ),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get("Location")).toBe(
      "/t/tenant-a/settings/models?computer=comp-1",
    );
  });

  it("starts /v0/session and /v0/tenants concurrently and backfills identity + tenant caches", async () => {
    const runtime = createTestTeamHubRuntime();
    let sessionInFlight = false;
    let tenantsInFlight = false;
    let bothInFlight = false;
    let releaseSession!: () => void;
    let releaseTenants!: () => void;
    const sessionGate = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    const tenantsGate = new Promise<void>((resolve) => {
      releaseTenants = resolve;
    });
    runtime.server.on("GET", "/v0/session", async () => {
      sessionInFlight = true;
      if (tenantsInFlight) bothInFlight = true;
      await sessionGate;
      return {
        account_id: runtime.seed.identity.account.id,
        created_at: "2026-10-15T00:00:00Z",
        expires_at: "2026-10-16T00:00:00Z",
        id: "session-test",
        identity: runtime.seed.identity,
      };
    });
    runtime.server.on("GET", "/v0/tenants", async () => {
      tenantsInFlight = true;
      if (sessionInFlight) bothInFlight = true;
      await tenantsGate;
      return { items: [runtime.seed.tenant] };
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const routes = createAppRoutes(queryClient, runtime);
    const indexLoader = routes.find((route) => route.path === "/")!
      .loader as LoaderFunction;
    const pendingRedirect = Promise.resolve(
      indexLoader({
        request: new Request("http://localhost/"),
        url: new URL("http://localhost/"),
        pattern: "/",
        params: {},
        context: new RouterContextProvider(),
      }),
    ).catch((thrown) => thrown);

    await vi.waitFor(() => expect(bothInFlight).toBe(true));
    releaseSession();
    releaseTenants();

    const thrown = await pendingRedirect;
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get("Location")).toBe(
      `/t/${runtime.seed.tenant.id}/rooms/room-another-me/chat`,
    );
    expect(queryClient.getQueryData(teamHubIdentityQueryKey)).toEqual(
      runtime.seed.identity,
    );
    expect(
      queryClient.getQueryData(teamHubTenantQueryKey(runtime.seed.tenant.id)),
    ).toEqual(runtime.seed.tenant);

    // Entering /t/:tenantId uses the backfilled caches with 0 /v0/me or /v0/tenants/:id calls.
    const tenantLoader = routes.find((route) => route.path === "/t/:tenantId")!
      .loader as LoaderFunction;
    await tenantLoader({
      request: new Request(`http://localhost/t/${runtime.seed.tenant.id}`),
      url: new URL(`http://localhost/t/${runtime.seed.tenant.id}`),
      pattern: "/t/:tenantId",
      params: { tenantId: runtime.seed.tenant.id },
      context: new RouterContextProvider(),
    });
    expect(runtime.server.requestsTo("GET", "/v0/me")).toHaveLength(0);
    expect(
      runtime.server.requestsTo("GET", "/v0/tenants/{tenantId}"),
    ).toHaveLength(0);
    queryClient.clear();
  });

  it("redirects to /login when session returns 401 even if tenants rejected first with 500", async () => {
    const runtime = createTestTeamHubRuntime();
    let releaseSession!: () => void;
    const sessionGate = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    runtime.server.on("GET", "/v0/tenants", () =>
      teamHubErrorResponse(500, "INTERNAL_ERROR", "Tenants failed"),
    );
    runtime.server.on("GET", "/v0/session", async () => {
      await sessionGate;
      return teamHubErrorResponse(401, "UNAUTHENTICATED", "Sign in required");
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const indexLoader = createAppRoutes(queryClient, runtime).find(
      (route) => route.path === "/",
    )!.loader as LoaderFunction;
    const resultPromise = Promise.resolve(
      indexLoader({
        request: new Request("http://localhost/"),
        url: new URL("http://localhost/"),
        pattern: "/",
        params: {},
        context: new RouterContextProvider(),
      }),
    ).catch((thrown) => thrown);

    await vi.waitFor(() =>
      expect(runtime.server.requestsTo("GET", "/v0/tenants")).toHaveLength(1),
    );
    releaseSession();

    const thrown = await resultPromise;
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get("Location")).toBe("/login");
    queryClient.clear();
  });

  it("preserves 0-Space error and 1-Space + 0-Room redirect branches", async () => {
    const emptySpaceRuntime = createTestTeamHubRuntime();
    emptySpaceRuntime.server.on("GET", "/v0/tenants", () => ({ items: [] }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const emptySpaceLoader = createAppRoutes(
      queryClient,
      emptySpaceRuntime,
    ).find((route) => route.path === "/")!.loader as LoaderFunction;

    await expect(
      emptySpaceLoader({
        request: new Request("http://localhost/"),
        url: new URL("http://localhost/"),
        pattern: "/",
        params: {},
        context: new RouterContextProvider(),
      }),
    ).rejects.toThrow("This Account has no Space.");

    const emptyRoomRuntime = createTestTeamHubRuntime();
    emptyRoomRuntime.server.on("GET", "/v0/tenants/{tenantId}/rooms", () => ({
      items: [],
      page: { has_more: false },
    }));
    const emptyRoomQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const emptyRoomLoader = createAppRoutes(
      emptyRoomQueryClient,
      emptyRoomRuntime,
    ).find((route) => route.path === "/")!.loader as LoaderFunction;
    let thrown: unknown;
    try {
      await emptyRoomLoader({
        request: new Request("http://localhost/"),
        url: new URL("http://localhost/"),
        pattern: "/",
        params: {},
        context: new RouterContextProvider(),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get("Location")).toBe(
      `/t/${emptyRoomRuntime.seed.tenant.id}/rooms`,
    );
    emptyRoomQueryClient.clear();
    queryClient.clear();
  });
});

function routePaths() {
  const routes = createAppRoutes(
    new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    createTestTeamHubRuntime(),
  );

  return flattenRoutes(routes)
    .map((route) => route.path)
    .filter((path): path is string => typeof path === "string");
}

function flattenRoutes(routes: RouteObject[]): RouteObject[] {
  return routes.flatMap((route) => [
    route,
    ...(route.children ? flattenRoutes(route.children) : []),
  ]);
}
