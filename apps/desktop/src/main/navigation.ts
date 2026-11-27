// Pure navigation and permission policy for the remote SPA window,
// kept free of Electron imports so it is unit tested.

import { isIP } from "node:net";

export const OFFLINE_ORIGIN = "app://offline";
// The local title bar page.
export const SHELL_ORIGIN = "app://shell";

export const sameOrigin = (url: string, serverUrl: string): boolean => {
  try {
    return new URL(url).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
};

export interface ServerSwitch {
  // The same server answers at another origin; its enrollments follow it.
  readonly moved: boolean;
  // The app leaves the server it used for another one, which drops this
  // computer's enrollment.
  readonly changed: boolean;
}

// What pointing the app from `previous` at `serverUrl` means. `movedFrom` is
// the origin the server at `serverUrl` answered at before it moved.
export function serverSwitch(
  previous: string | undefined,
  serverUrl: string,
  movedFrom?: string,
): ServerSwitch {
  const moved = movedFrom !== undefined && movedFrom !== serverUrl;
  return {
    moved,
    changed: serverUrl !== previous && !(moved && previous === movedFrom),
  };
}

export type WindowLoadReason =
  | "boot"
  | "local_ready"
  | "resume_ready"
  | "resume_revived"
  | "server_changed"
  | "port_moved"
  | "retry"
  | "prewarm";

export interface WindowLoadState {
  readonly currentUrl?: string;
  readonly pendingTargetOrigin?: string;
  readonly showingShellPage: "none" | "starting" | "offline" | "start-failed";
  readonly loadFailed: boolean;
}

export interface WindowLoadDecision {
  readonly action: "load" | "noop";
  readonly targetUrl?: string;
  readonly reason: WindowLoadReason;
}

// Decides whether the main window should load `nextOrigin` or treat it as a
// no-op, avoiding duplicate reloads on hot start while recovering from shell
// pages or failed loads.
export function windowLoadDecision(
  state: WindowLoadState,
  currentServerUrl: string | undefined,
  nextOrigin: string,
  options: { movedFrom?: string; reason: WindowLoadReason },
): WindowLoadDecision {
  const targetOrigin = parseServerUrl(nextOrigin);
  const sw = targetOrigin
    ? serverSwitch(currentServerUrl, targetOrigin, options.movedFrom)
    : undefined;
  const { reason } = options;
  if (!targetOrigin) return { action: "noop", reason };

  // Keep the current server when a non-explicit load targets another server,
  // such as a background local resume while the user is on a remote server.
  if (
    currentServerUrl !== undefined &&
    !sameOrigin(currentServerUrl, targetOrigin) &&
    reason !== "server_changed" &&
    reason !== "local_ready" &&
    !(
      sw?.moved &&
      options.movedFrom !== undefined &&
      sameOrigin(currentServerUrl, options.movedFrom)
    )
  ) {
    return { action: "noop", reason };
  }

  if (
    reason !== "retry" &&
    reason !== "resume_revived" &&
    !state.loadFailed &&
    state.showingShellPage === "none" &&
    ((state.currentUrl !== undefined &&
      sameOrigin(state.currentUrl, targetOrigin)) ||
      (state.pendingTargetOrigin !== undefined &&
        sameOrigin(state.pendingTargetOrigin, targetOrigin)))
  ) {
    return { action: "noop", reason };
  }

  return { action: "load", targetUrl: targetOrigin, reason };
}
// The page names the floating voice window it opens with this `window.open`
// target prefix (a suffix keeps a closing window from being reused).
export const VOICE_WINDOW_TARGET = "linger-voice-window";

// Whether a `window.open` is the voice window: an empty page the server's own
// page fills in itself. Anything else the page opens is denied.
export const voiceWindowRequest = (
  details: { url: string; frameName: string },
  serverUrl: string | undefined,
  fromUrl: string,
): boolean =>
  details.url === "about:blank" &&
  details.frameName.startsWith(VOICE_WINDOW_TARGET) &&
  serverUrl !== undefined &&
  sameOrigin(fromUrl, serverUrl);

export type NavigationDecision = "allow" | "external" | "deny";

// App pages are reachable only from app pages: the server's pages must not
// open app://offline/connect, which repoints the app to another server.
export const navigationDecision = (
  url: string,
  serverUrl: string | undefined,
  fromUrl?: string,
): NavigationDecision => {
  if (url.startsWith(`${OFFLINE_ORIGIN}/`))
    return fromUrl?.startsWith(`${OFFLINE_ORIGIN}/`) ? "allow" : "deny";
  if (serverUrl && sameOrigin(url, serverUrl)) return "allow";
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? "external" : "deny";
  } catch {
    return "deny";
  }
};

export const permissionAllowed = (
  permission: string,
  details: { mediaTypes?: readonly string[]; requestingUrl?: string },
  serverUrl: string | undefined,
): boolean => {
  if (!serverUrl || !details.requestingUrl) return false;
  if (!sameOrigin(details.requestingUrl, serverUrl)) return false;
  if (permission === "notifications") return true;
  if (permission === "media") {
    const types = details.mediaTypes ?? [];
    return types.length > 0 && types.every((t) => t === "audio");
  }
  return false;
};

// Hosts where plain HTTP is tolerated: loopback and private networks.
export const isLocalNetworkHost = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (isIP(host) === 6) {
    return (
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe80")
    );
  }
  return false;
};

// Only https servers, or http on loopback and private networks: enrollment sends the session cookie and receives the
// computer credential from this address. It comes from the user on
// app://offline.
export const parseServerUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLocalNetworkHost(url.hostname))
    )
      return undefined;
    if (url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
};

// The Web link preview panel names its frame with this prefix. For such a
// frame the window keeps the site's framing rules and, when they refuse the
// frame, tells the page so it can offer the system browser instead; a site
// that refuses frames usually needs a sign-in the frame does not have.
// Frames without the name, from Web builds before it, keep framableHeaders.
export const PREVIEW_FRAME_PREFIX = "linger-url-preview:";

const frameAncestorSources = (policy: string): string[] | undefined => {
  for (const directive of policy.split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name?.toLowerCase() === "frame-ancestors") return sources;
  }
  return undefined;
};

// Whether a response refuses to be framed by the app's page at
// ancestorProtocol. CSP frame-ancestors, when present, overrides
// X-Frame-Options, as in Chromium. Only * or a scheme source matching the
// app's scheme (http: also matches https:) allows the frame; a host source
// never names the Linger server.
export const refusesFraming = (
  headers: Record<string, string[]>,
  ancestorProtocol: string,
): boolean => {
  const values = (wanted: string): string[] =>
    Object.entries(headers).flatMap(([name, value]) =>
      name.toLowerCase() === wanted ? value : [],
    );
  const allowing = new Set([
    "*",
    ancestorProtocol,
    ...(ancestorProtocol === "https:" ? ["http:"] : []),
  ]);
  const ancestors = values("content-security-policy").flatMap((policy) => {
    const sources = frameAncestorSources(policy);
    return sources ? [sources] : [];
  });
  if (ancestors.length)
    return ancestors.some(
      (sources) =>
        !sources.some((source) => allowing.has(source.toLowerCase())),
    );
  return values("x-frame-options").some((value) =>
    value
      .split(",")
      .some((option) =>
        ["deny", "sameorigin"].includes(option.trim().toLowerCase()),
      ),
  );
};

// Frames of the app without the PREVIEW_FRAME_PREFIX name, such as a preview
// panel from an older Web build or a frame nested in a previewed page, would
// stay blank where a site refuses every frame (X-Frame-Options, CSP
// frame-ancestors), so the window drops those two rules for them. The
// panel's frame is sandboxed and cannot navigate or script the app.
export const framableHeaders = (
  headers: Record<string, string[]>,
): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(headers).flatMap(([name, values]) => {
      const lower = name.toLowerCase();
      if (lower === "x-frame-options") return [];
      if (lower !== "content-security-policy") return [[name, values]];
      const policies = values
        .map((value) =>
          value
            .split(";")
            .filter(
              (directive) =>
                directive.trim().split(/\s+/)[0]?.toLowerCase() !==
                "frame-ancestors",
            )
            .join(";")
            .trim(),
        )
        .filter((value) => value.replace(/;/g, "").trim());
      return policies.length ? [[name, policies]] : [];
    }),
  );
