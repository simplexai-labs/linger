import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";

import { UrlPreviewPanel } from "./url-preview-panel";

afterEach(() => vi.unstubAllEnvs());

describe("URL preview fallback", () => {
  it("does not embed the application origin with script and storage privileges", () => {
    vi.stubEnv("DEV", false);
    render(<UrlPreviewPanel url={window.location.origin + "/settings"} />);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("does not let an iframe message open unsolicited external tabs", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<UrlPreviewPanel url="https://example.com/" />);
    const frame = screen.getByTitle<HTMLIFrameElement>(
      "Preview https://example.com/",
    );
    fireEvent(
      window,
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { type: "linger-preview-navigate", url: "http://10.0.0.1/" },
      }),
    );
    expect(open).not.toHaveBeenCalled();
    expect(document.querySelector("iframe")).toBeNull();
    open.mockRestore();
  });
  it("opens a submitted local URL once and keeps a retry link", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<UrlPreviewPanel url="https://example.com/" />);
    const address = screen.getByRole("textbox", { name: "URL address" });
    fireEvent.change(address, {
      target: { value: "http://10.0.0.5:6001/" },
    });
    fireEvent.submit(address.closest("form")!);
    expect(open).toHaveBeenCalledExactlyOnceWith(
      "http://10.0.0.5:6001/",
      "_blank",
      "noopener,noreferrer",
    );
    expect(document.querySelector("iframe")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Open in new tab" }),
    ).toHaveAttribute("href", "http://10.0.0.5:6001/");
    open.mockRestore();
  });

  it("never embeds a restored local URL and offers a real new-tab link", () => {
    render(<UrlPreviewPanel url="http://10.0.0.5:6001/" />);
    expect(document.querySelector("iframe")).toBeNull();
    expect(
      screen.getAllByRole("link", { name: "Open in new tab" })[0],
    ).toHaveAttribute("href", "http://10.0.0.5:6001/");
  });

  it("provides a manual escape for sites that reject embedding", () => {
    render(<UrlPreviewPanel url="https://example.com/" />);
    expect(
      screen.getByRole("link", { name: "Open in new tab" }),
    ).toHaveAttribute("target", "_blank");
  });

  it("allows site storage only for a direct cross-origin frame", () => {
    vi.stubEnv("DEV", false);
    render(<UrlPreviewPanel url="https://example.com/" />);
    expect(
      screen.getByTitle<HTMLIFrameElement>("Preview https://example.com/"),
    ).toHaveAttribute("sandbox", "allow-forms allow-scripts allow-same-origin");
  });

  it("keeps development proxy frames isolated from application storage", () => {
    vi.stubEnv("DEV", true);
    render(<UrlPreviewPanel url="https://example.com/" />);
    expect(
      screen
        .getByTitle<HTMLIFrameElement>("Preview https://example.com/")
        .getAttribute("sandbox"),
    ).not.toContain("allow-same-origin");
  });

  it("frames sites directly in the desktop app, even on a development server", () => {
    vi.stubEnv("DEV", true);
    vi.stubGlobal("lingerDesktop", {});
    try {
      render(<UrlPreviewPanel url="https://example.com/" />);
      const frame = screen.getByTitle<HTMLIFrameElement>(
        "Preview https://example.com/",
      );
      expect(frame).toHaveAttribute("src", "https://example.com/");
      expect(frame).toHaveAttribute(
        "sandbox",
        "allow-forms allow-scripts allow-same-origin",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("URL preview in the desktop app", () => {
  afterEach(() => {
    delete (window as { lingerDesktop?: unknown }).lingerDesktop;
  });

  it("replaces a frame the site refused with a link to open it in a new tab", () => {
    let report: ((frameName: string, url: string) => void) | undefined;
    (window as { lingerDesktop?: unknown }).lingerDesktop = {
      preview: {
        onFrameRefused: (
          callback: (frameName: string, url: string) => void,
        ) => {
          report = callback;
          return () => (report = undefined);
        },
      },
    };
    render(<UrlPreviewPanel url="https://linear.app/team/issue/A-1" />);
    const frame = document.querySelector("iframe")!;
    expect(frame.name).toMatch(/^linger-url-preview:/);

    act(() => report!("linger-url-preview:another", "https://linear.app/"));
    expect(document.querySelector("iframe")).not.toBeNull();

    act(() => report!(frame.name, "https://linear.app/login"));
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByText("Open this site in a new tab")).toBeInTheDocument();
    expect(
      screen.getByText("linear.app does not allow being shown in the app."),
    ).toBeInTheDocument();
    const links = screen.getAllByRole("link", { name: "Open in new tab" });
    expect(links.at(-1)).toHaveAttribute("href", "https://linear.app/login");
  });
});

describe("URL preview in a browser", () => {
  function renderProbed(answer: () => unknown) {
    vi.stubEnv("DEV", false);
    const runtime = createTestTeamHubRuntime();
    const probe = vi.fn((_request: { query: URLSearchParams }) => answer());
    runtime.server.on("GET", "/v0/url-preview/framing", probe);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <UrlPreviewPanel url="https://github.com/" />
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );
    return probe;
  }

  it("loads the frame out of sight while TeamHub checks, and offers a new tab for a site that refuses frames", async () => {
    const probe = renderProbed(() => ({ framing: "refused" }));
    expect(
      screen.getByRole("status", {
        name: "Checking whether this site can be shown here.",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByTitle("Preview https://github.com/").parentElement,
    ).toHaveClass("invisible");
    expect(
      await screen.findByText(
        "github.com does not allow being shown in the app.",
      ),
    ).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
    // The address opened, not where a cookieless request was redirected.
    expect(
      screen.getAllByRole("link", { name: "Open in new tab" }).at(-1),
    ).toHaveAttribute("href", "https://github.com/");
    const query = probe.mock.calls[0]![0].query;
    expect(query.get("url")).toBe("https://github.com/");
    expect(query.get("page_scheme")).toBe("http");
  });

  it("shows the frame for a site that allows it, or when TeamHub cannot tell", async () => {
    renderProbed(() => ({ framing: "unknown" }));
    await waitFor(() =>
      expect(
        screen.getByTitle("Preview https://github.com/").parentElement,
      ).not.toHaveClass("invisible"),
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("frames the site when TeamHub has no check", async () => {
    renderProbed(() => teamHubErrorResponse(404, "NOT_FOUND", "Not found"));
    expect(
      await screen.findByTitle("Preview https://github.com/"),
    ).toBeInTheDocument();
  });
});

describe("URL preview in a native desktop view", () => {
  const elementFromPoint = document.elementFromPoint;
  function advance(ms: number) {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }

  function setup() {
    let report: ((id: string, state: unknown) => void) | undefined;
    const view = {
      open: vi.fn(async (_id: string, _url: string) => undefined),
      place: vi.fn(async () => undefined),
      hide: vi.fn(async () => undefined),
      command: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      onState: vi.fn((callback: (id: string, state: unknown) => void) => {
        report = callback;
        return () => (report = undefined);
      }),
    };
    vi.stubGlobal("lingerDesktop", {
      preview: { onFrameRefused: () => () => undefined, view },
    });
    return {
      view,
      report: (id: string, state: unknown) => report?.(id, state),
    };
  }

  function renderPlaced() {
    vi.useFakeTimers({
      toFake: [
        "setInterval",
        "clearInterval",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "performance",
      ],
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 600, y: 44, width: 400, height: 600 }),
    );
    render(<UrlPreviewPanel url="https://github.com/" />);
    const surface = document.querySelector("section > div.min-h-0 > div")!;
    // The panel's resize grip overlaps the surface's left edge by 6px.
    const grip = document.createElement("div");
    surface.parentElement!.append(grip);
    let covering: Element | null = null;
    document.elementFromPoint = (x) => covering ?? (x < 606 ? grip : surface);
    return { cover: (element: Element | null) => (covering = element) };
  }

  afterEach(() => {
    vi.useRealTimers();
    document.elementFromPoint = elementFromPoint;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the page in a native view instead of a frame and follows its navigation", async () => {
    const { view, report } = setup();
    const { unmount } = render(<UrlPreviewPanel url="https://github.com/" />);
    expect(document.querySelector("iframe")).toBeNull();
    const id = view.open.mock.calls[0]![0];
    expect(view.open).toHaveBeenCalledExactlyOnceWith(
      id,
      "https://github.com/",
    );

    act(() =>
      report(id, {
        url: "https://github.com/login",
        canGoBack: true,
        canGoForward: false,
      }),
    );
    const address = screen.getByRole("textbox", { name: "URL address" });
    expect(address).toHaveValue("https://github.com/login");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(view.command).toHaveBeenCalledWith(id, "back");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(view.command).toHaveBeenCalledWith(id, "reload");

    fireEvent.change(address, { target: { value: "anthropic.com" } });
    fireEvent.submit(address.closest("form")!);
    expect(view.open).toHaveBeenLastCalledWith(id, "https://anthropic.com/");

    unmount();
    expect(view.close).toHaveBeenCalledWith(id);
  });

  it("frames the site when the app cannot open a view", async () => {
    const { view } = setup();
    view.open.mockRejectedValue(new Error("Too many previews"));
    render(<UrlPreviewPanel url="https://github.com/" />);
    expect(
      await screen.findByTitle("Preview https://github.com/"),
    ).toBeInTheDocument();
  });

  it("places the view over the panel and hides it while the page covers the panel", () => {
    const { view } = setup();
    const { cover } = renderPlaced();
    const id = view.open.mock.calls[0]![0];

    advance(16);
    expect(view.place).toHaveBeenCalledExactlyOnceWith(id, {
      x: 600,
      y: 44,
      width: 400,
      height: 600,
    });
    advance(1000);
    expect(view.place).toHaveBeenCalledTimes(1);

    cover(document.body);
    advance(100);
    expect(view.hide).toHaveBeenCalledWith(id);

    cover(null);
    advance(100);
    expect(view.place).toHaveBeenCalledTimes(2);
  });

  it("checks every frame only for a moment after input", () => {
    setup();
    renderPlaced();
    const frames = vi.spyOn(window, "requestAnimationFrame");
    advance(1000);
    const settled = frames.mock.calls.length;
    advance(1000);
    expect(frames.mock.calls.length).toBe(settled);

    fireEvent.pointerDown(document.body);
    advance(100);
    expect(frames.mock.calls.length).toBeGreaterThan(settled + 3);
  });

  it("hides the view under a layer drawn beside the app, even one that takes no pointer", () => {
    const { view } = setup();
    renderPlaced();
    advance(16);
    expect(view.place).toHaveBeenCalledTimes(1);

    const tooltip = document.createElement("div");
    tooltip.style.pointerEvents = "none";
    document.body.append(tooltip);
    advance(100);
    expect(view.hide).toHaveBeenCalledTimes(1);
    tooltip.remove();
  });
});
