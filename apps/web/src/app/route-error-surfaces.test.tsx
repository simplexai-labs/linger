import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TeamHubError,
  TeamHubTransportError,
} from "@/features/teamhub/teamhub-client";

const navigateMock = vi.fn();
let currentNavigate = navigateMock;
let currentRouteError: unknown;

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    NavLink: ({ children }: { children?: unknown }) => <>{children}</>,
    useLocation: () => ({ pathname: "/t/tenant-1/rooms" }),
    useNavigate: () => currentNavigate,
    useParams: () => ({ tenantId: "tenant-1" }),
    useRouteError: () => currentRouteError,
  };
});

import { FullPageRouteErrorSurface } from "./route-error-surfaces";

function makeTeamHubError(status: number) {
  return new TeamHubError({
    code: `HTTP_${status}`,
    message: `status ${status}`,
    status,
  });
}

function makeRouteErrorResponse(status: number) {
  return {
    data: null,
    internal: false,
    status,
    statusText: `HTTP ${status}`,
  };
}

describe("FullPageRouteErrorSurface auto-recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    navigateMock.mockReset();
    currentNavigate = navigateMock;
    currentRouteError = undefined;
    window.sessionStorage.clear();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ["TeamHubError 502", () => makeTeamHubError(502)],
    ["TeamHubError 503", () => makeTeamHubError(503)],
    ["TeamHubTransportError", () => new TeamHubTransportError()],
    ["RouteErrorResponse 503", () => makeRouteErrorResponse(503)],
  ])(
    "polls /readyz with backoff for %s and reloads once /readyz answers 200",
    async (_label, buildError) => {
      currentRouteError = buildError();
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      render(<FullPageRouteErrorSurface />);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(fetchSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenLastCalledWith(
        "/readyz",
        expect.objectContaining({ method: "HEAD", cache: "no-store" }),
      );
      expect(navigateMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_999);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(navigateMock).toHaveBeenCalledTimes(1);
      expect(navigateMock).toHaveBeenCalledWith(0);

      await vi.advanceTimersByTimeAsync(20_000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    },
  );

  it.each([200, 401])(
    "falls back to /v0/me when /readyz returns 404 and reloads on %i",
    async (meStatus) => {
      currentRouteError = makeTeamHubError(502);
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(new Response(null, { status: meStatus }));

      render(<FullPageRouteErrorSurface />);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        "/readyz",
        expect.objectContaining({ method: "HEAD", cache: "no-store" }),
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        "/v0/me",
        expect.objectContaining({ method: "GET", cache: "no-store" }),
      );
      expect(navigateMock).toHaveBeenCalledTimes(1);
      expect(navigateMock).toHaveBeenCalledWith(0);
    },
  );

  it.each([
    ["TeamHubError 403", () => makeTeamHubError(403)],
    ["TeamHubError 404", () => makeTeamHubError(404)],
    ["TeamHubError 500", () => makeTeamHubError(500)],
    ["generic Error", () => new Error("render boom")],
  ])("does not auto-probe for %s", async (_label, buildError) => {
    currentRouteError = buildError();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    render(<FullPageRouteErrorSurface />);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("defers probing while the tab is hidden and resumes on visibilitychange", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    currentRouteError = new TeamHubTransportError();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    render(<FullPageRouteErrorSurface />);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSpy).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith(0);
  });

  it("cancels pending timers and aborts in-flight probes on unmount", async () => {
    currentRouteError = makeTeamHubError(503);
    let capturedSignal: AbortSignal | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          capturedSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );

    const pendingMount = render(<FullPageRouteErrorSurface />);
    pendingMount.unmount();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSpy).not.toHaveBeenCalled();

    const inFlightMount = render(<FullPageRouteErrorSurface />);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(capturedSignal?.aborted).toBe(false);

    inFlightMount.unmount();
    expect(capturedSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("stops auto-reloading after exhausting the per-path reload budget", async () => {
    currentRouteError = makeTeamHubError(502);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    const first = render(<FullPageRouteErrorSurface />);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(navigateMock).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = render(<FullPageRouteErrorSurface />);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(navigateMock).toHaveBeenCalledTimes(2);
    second.unmount();

    const third = render(<FullPageRouteErrorSurface />);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(navigateMock).toHaveBeenCalledTimes(2);
    third.unmount();
  });

  it("does not reset the backoff timer when rerendered with a new navigate reference", async () => {
    currentRouteError = makeTeamHubError(503);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const view = render(<FullPageRouteErrorSurface />);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_500);
    const replacementNavigate = vi.fn();
    currentNavigate = replacementNavigate;
    view.rerender(<FullPageRouteErrorSurface />);

    await vi.advanceTimersByTimeAsync(1_499);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(replacementNavigate).toHaveBeenCalledWith(0);
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
