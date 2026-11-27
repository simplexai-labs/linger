import { describe, expect, it } from "vitest";

import {
  framableHeaders,
  refusesFraming,
  navigationDecision,
  parseServerUrl,
  permissionAllowed,
  serverSwitch,
  windowLoadDecision,
  voiceWindowRequest,
} from "./navigation.js";

const server = "https://linger.example.com";

describe("serverSwitch", () => {
  const local = "http://localhost:3000";
  const moved = "http://localhost:3001";

  it("follows the same server to its new origin without changing servers", () => {
    expect(serverSwitch(local, moved, local)).toEqual({
      moved: true,
      changed: false,
    });
  });

  it("changes servers when the app pointed at another one", () => {
    expect(serverSwitch(server, moved, local)).toEqual({
      moved: true,
      changed: true,
    });
    expect(serverSwitch(local, server)).toEqual({
      moved: false,
      changed: true,
    });
  });

  it("changes no server when the origin stays", () => {
    expect(serverSwitch(local, local)).toEqual({
      moved: false,
      changed: false,
    });
    expect(serverSwitch(local, local, local)).toEqual({
      moved: false,
      changed: false,
    });
    // A retry after the move already followed it.
    expect(serverSwitch(moved, moved, local)).toEqual({
      moved: true,
      changed: false,
    });
  });
});

describe("window policy", () => {
  it("keeps navigation on the server origin", () => {
    expect(navigationDecision(`${server}/rooms/1`, server)).toBe("allow");
    expect(
      navigationDecision(
        "app://offline/connect?server=x",
        server,
        "app://offline/",
      ),
    ).toBe("allow");
    expect(navigationDecision("https://evil.example.com/", server)).toBe(
      "external",
    );
    expect(navigationDecision("https://linger.example.com:8443/", server)).toBe(
      "external",
    );
    expect(navigationDecision("file:///etc/passwd", server)).toBe("deny");
    expect(navigationDecision(`${server}/`, undefined)).toBe("external");
  });

  it("keeps the server's pages away from the app pages", () => {
    const evil = "app://offline/connect?server=https://evil.example.com";
    expect(navigationDecision(evil, server, `${server}/rooms/1`)).toBe("deny");
    expect(navigationDecision(evil, server)).toBe("deny");
  });

  it("grants only notifications and audio to the server origin", () => {
    const from = { requestingUrl: `${server}/rooms` };
    expect(permissionAllowed("notifications", from, server)).toBe(true);
    expect(
      permissionAllowed("media", { ...from, mediaTypes: ["audio"] }, server),
    ).toBe(true);
    expect(
      permissionAllowed(
        "media",
        { ...from, mediaTypes: ["audio", "video"] },
        server,
      ),
    ).toBe(false);
    expect(permissionAllowed("geolocation", from, server)).toBe(false);
    expect(
      permissionAllowed(
        "notifications",
        { requestingUrl: "https://evil.example.com/" },
        server,
      ),
    ).toBe(false);
  });

  it("accepts only plain http(s) server addresses", () => {
    expect(parseServerUrl(" https://linger.example.com/path ")).toBe(server);
    expect(parseServerUrl("javascript:alert(1)")).toBeUndefined();
    expect(
      parseServerUrl("https://user:pw@linger.example.com"),
    ).toBeUndefined();
  });

  it("accepts plain http only on loopback and private networks", () => {
    expect(parseServerUrl("http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000",
    );
    expect(parseServerUrl("http://192.168.1.20:3000")).toBe(
      "http://192.168.1.20:3000",
    );
    expect(parseServerUrl("http://linger.example.com")).toBeUndefined();
  });
});

describe("framableHeaders", () => {
  it("drops the rules that refuse frames and keeps the rest", () => {
    expect(
      framableHeaders({
        "X-Frame-Options": ["SAMEORIGIN"],
        "Content-Security-Policy": [
          "default-src 'self'; frame-ancestors 'self'; img-src *",
          "frame-ancestors 'none'",
        ],
        "Content-Type": ["text/html"],
      }),
    ).toEqual({
      "Content-Security-Policy": ["default-src 'self'; img-src *"],
      "Content-Type": ["text/html"],
    });
  });
});

describe("refusesFraming", () => {
  it("reads X-Frame-Options and lets CSP frame-ancestors override it", () => {
    const refuses = (headers: Record<string, string[]>) =>
      refusesFraming(headers, "https:");
    expect(refuses({ "X-Frame-Options": ["SAMEORIGIN"] })).toBe(true);
    expect(refuses({ "x-frame-options": ["deny"] })).toBe(true);
    expect(refuses({ "X-Frame-Options": ["ALLOWALL"] })).toBe(false);
    expect(
      refuses({
        "Content-Security-Policy": [
          "default-src 'self'; frame-ancestors 'self'",
        ],
      }),
    ).toBe(true);
    expect(
      refuses({
        "X-Frame-Options": ["DENY"],
        "Content-Security-Policy": ["frame-ancestors *"],
      }),
    ).toBe(false);
    expect(
      refuses({
        "Content-Security-Policy": [
          "frame-ancestors *",
          "frame-ancestors 'none'",
        ],
      }),
    ).toBe(true);
    expect(
      refuses({
        "Content-Security-Policy": ["default-src 'self'"],
        "Content-Type": ["text/html"],
      }),
    ).toBe(false);
  });

  it("lets a scheme source allow an app served over that scheme", () => {
    const policy = (sources: string) => ({
      "Content-Security-Policy": [`frame-ancestors ${sources}`],
    });
    expect(refusesFraming(policy("https:"), "https:")).toBe(false);
    expect(refusesFraming(policy("http:"), "https:")).toBe(false);
    expect(refusesFraming(policy("http:"), "http:")).toBe(false);
    expect(refusesFraming(policy("https:"), "http:")).toBe(true);
    expect(refusesFraming(policy("https://example.com"), "https:")).toBe(true);
  });
});

describe("windowLoadDecision", () => {
  const local = "http://localhost:3000";
  const moved = "http://localhost:3001";

  it("loads on initial boot and skips duplicate hot-start loads", () => {
    expect(
      windowLoadDecision(
        { showingShellPage: "none", loadFailed: false },
        local,
        local,
        { reason: "boot" },
      ),
    ).toEqual({ action: "load", targetUrl: local, reason: "boot" });

    expect(
      windowLoadDecision(
        {
          pendingTargetOrigin: local,
          showingShellPage: "none",
          loadFailed: false,
        },
        local,
        local,
        { reason: "local_ready" },
      ),
    ).toEqual({ action: "noop", reason: "local_ready" });

    expect(
      windowLoadDecision(
        {
          currentUrl: `${local}/rooms/1`,
          showingShellPage: "none",
          loadFailed: false,
        },
        local,
        local,
        { reason: "resume_ready" },
      ),
    ).toEqual({ action: "noop", reason: "resume_ready" });
  });

  it("reloads when recovering from a shell page, failure, or explicit retry", () => {
    expect(
      windowLoadDecision(
        {
          currentUrl: "app://offline/?starting=1",
          showingShellPage: "starting",
          loadFailed: false,
        },
        local,
        local,
        { reason: "resume_ready" },
      ),
    ).toEqual({ action: "load", targetUrl: local, reason: "resume_ready" });

    expect(
      windowLoadDecision(
        {
          currentUrl: `${local}/`,
          showingShellPage: "none",
          loadFailed: true,
        },
        local,
        local,
        { reason: "resume_ready" },
      ),
    ).toEqual({ action: "load", targetUrl: local, reason: "resume_ready" });

    expect(
      windowLoadDecision(
        {
          currentUrl: `${local}/`,
          showingShellPage: "none",
          loadFailed: false,
        },
        local,
        local,
        { reason: "retry" },
      ),
    ).toEqual({ action: "load", targetUrl: local, reason: "retry" });

    expect(
      windowLoadDecision(
        {
          currentUrl: `${local}/rooms/1`,
          showingShellPage: "none",
          loadFailed: false,
        },
        local,
        local,
        { reason: "resume_revived" },
      ),
    ).toEqual({ action: "load", targetUrl: local, reason: "resume_revived" });
  });

  it("reloads on port move and keeps a user-selected remote server", () => {
    expect(
      windowLoadDecision(
        {
          currentUrl: `${local}/`,
          showingShellPage: "none",
          loadFailed: false,
        },
        local,
        moved,
        { movedFrom: local, reason: "port_moved" },
      ),
    ).toEqual({ action: "load", targetUrl: moved, reason: "port_moved" });

    expect(
      windowLoadDecision(
        {
          currentUrl: `${server}/`,
          showingShellPage: "none",
          loadFailed: false,
        },
        server,
        moved,
        { movedFrom: local, reason: "resume_ready" },
      ),
    ).toEqual({ action: "noop", reason: "resume_ready" });

    expect(
      windowLoadDecision(
        {
          currentUrl: `${server}/`,
          showingShellPage: "none",
          loadFailed: false,
        },
        server,
        local,
        { reason: "resume_revived" },
      ),
    ).toEqual({ action: "noop", reason: "resume_revived" });

    expect(
      windowLoadDecision(
        {
          currentUrl: `${local}/`,
          showingShellPage: "none",
          loadFailed: false,
        },
        local,
        server,
        { reason: "server_changed" },
      ),
    ).toEqual({ action: "load", targetUrl: server, reason: "server_changed" });
  });

  it("rejects invalid origins as noop", () => {
    expect(
      windowLoadDecision(
        { showingShellPage: "none", loadFailed: false },
        local,
        "javascript:alert(1)",
        { reason: "server_changed" },
      ),
    ).toEqual({ action: "noop", reason: "server_changed" });
  });
});

describe("voiceWindowRequest", () => {
  const page = `${server}/t/1/rooms/2/chat`;
  const open = { url: "about:blank", frameName: "linger-voice-window-3" };

  it("allows the server's page to open its empty voice window", () => {
    expect(voiceWindowRequest(open, server, page)).toBe(true);
  });

  it("denies any other window the page opens", () => {
    expect(
      voiceWindowRequest({ ...open, frameName: "popup" }, server, page),
    ).toBe(false);
    expect(
      voiceWindowRequest(
        { url: "https://evil.example.com/", frameName: open.frameName },
        server,
        page,
      ),
    ).toBe(false);
  });

  it("denies a page that is not the server's", () => {
    expect(voiceWindowRequest(open, server, "app://offline/")).toBe(false);
    expect(voiceWindowRequest(open, server, "https://evil.example.com/")).toBe(
      false,
    );
    expect(voiceWindowRequest(open, undefined, page)).toBe(false);
  });
});
