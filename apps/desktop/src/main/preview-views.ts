import {
  WebContentsView,
  ipcMain,
  session,
  type BaseWindow,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents,
} from "electron";

import {
  IPC,
  type PreviewCommand,
  type PreviewViewState,
} from "../shared/api.js";
import { sameOrigin } from "./navigation.js";

// Previews keep their sign-ins across restarts, apart from the app's own
// session with the Linger server.
export const PREVIEW_PARTITION = "persist:linger-preview";
// A page asks for at most this many views; each is a renderer process.
const MAX_VIEWS = 8;
// Script popups, such as a sign-in window, one view may have open at once.
const MAX_POPUPS = 2;
// A view whose renderer died reloads once in this window, not in a loop.
const CRASH_RELOAD_MS = 10_000;
const COMMANDS = new Set<PreviewCommand>(["back", "forward", "reload"]);
// Permissions a previewed site gets without asking: none that reach the
// camera, microphone, location or notifications.
const PREVIEW_PERMISSIONS = new Set(["clipboard-sanitized-write"]);

export interface PreviewViewsHost {
  window(): BaseWindow | undefined;
  // The view holding the Linger page.
  content(): WebContentsView | undefined;
  serverUrl(): string | undefined;
  warn(event: string, fields: Record<string, unknown>): void;
}

interface Preview {
  readonly view: WebContentsView;
  readonly popups: Set<BrowserWindow>;
  crashedAt?: number;
}

/** An http or https URL without credentials, as a view may load. */
export function previewUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 8192) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function previewId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    ? value
    : undefined;
}

/**
 * The page's CSS pixel rectangle in the window's coordinates: offset by where
 * the page's view sits and scaled by its zoom.
 */
export function windowBounds(
  value: unknown,
  page: { x: number; y: number },
  zoom: number,
): Electron.Rectangle | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { x, y, width, height } = value as Record<string, unknown>;
  const numbers = [x, y, width, height];
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n)))
    return undefined;
  const [left, top, w, h] = numbers as [number, number, number, number];
  if (w < 0 || h < 0) return undefined;
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return {
    x: Math.round(page.x + left * scale),
    y: Math.round(page.y + top * scale),
    width: Math.round(w * scale),
    height: Math.round(h * scale),
  };
}

let previewSession: Session | undefined;

function ensurePreviewSession(): Session {
  if (previewSession) return previewSession;
  const target = session.fromPartition(PREVIEW_PARTITION);
  target.setPermissionRequestHandler((_contents, permission, done) =>
    done(PREVIEW_PERMISSIONS.has(permission)),
  );
  target.setPermissionCheckHandler((_contents, permission) =>
    PREVIEW_PERMISSIONS.has(permission),
  );
  previewSession = target;
  return target;
}

/** A page, view or popup may load only http and https. */
function keepToWeb(contents: WebContents): void {
  const allowWeb = (event: { preventDefault(): void }, url: string) => {
    if (!previewUrl(url)) event.preventDefault();
  };
  contents.on("will-navigate", (event) => allowWeb(event, event.url));
  contents.on("will-redirect", (event) => allowWeb(event, event.url));
  contents.on("will-attach-webview", (event) => event.preventDefault());
}

/**
 * The link preview panel's native views. The Linger page lays each one over
 * its panel and hides it while a menu or dialog covers the panel. The page
 * learns each view's address and history, never its content.
 */
export class PreviewViews {
  readonly #host: PreviewViewsHost;
  readonly #previews = new Map<string, Preview>();

  constructor(host: PreviewViewsHost) {
    this.#host = host;
  }

  /** Registers the preload API handlers; returns their removal. */
  register(): () => void {
    const handle = (
      channel: string,
      run: (id: string, ...args: unknown[]) => unknown,
    ): void => {
      ipcMain.handle(channel, (event, id: unknown, ...args: unknown[]) => {
        const valid = previewId(id);
        if (!valid || !this.#fromPage(event)) throw new Error("Not allowed");
        return run(valid, ...args);
      });
    };
    handle(IPC.previewOpen, (id, url) => this.#open(id, url));
    handle(IPC.previewPlace, (id, bounds) => this.#place(id, bounds));
    handle(IPC.previewHide, (id) => this.#hide(id));
    handle(IPC.previewCommand, (id, command) => this.#command(id, command));
    handle(IPC.previewClose, (id) => this.#close(id));
    return () => {
      for (const channel of [
        IPC.previewOpen,
        IPC.previewPlace,
        IPC.previewHide,
        IPC.previewCommand,
        IPC.previewClose,
      ])
        ipcMain.removeHandler(channel);
      this.closeAll();
    };
  }

  /** The page that owns the views navigated away or its window closed. */
  closeAll(): void {
    for (const id of [...this.#previews.keys()]) this.#close(id);
  }

  #fromPage(event: IpcMainInvokeEvent): boolean {
    const contents = this.#host.content()?.webContents;
    const server = this.#host.serverUrl();
    return Boolean(
      contents &&
      server &&
      !contents.isDestroyed() &&
      event.sender === contents &&
      event.senderFrame === contents.mainFrame &&
      sameOrigin(contents.getURL(), server),
    );
  }

  #open(id: string, value: unknown): void {
    const url = previewUrl(value);
    if (!url) throw new Error("Invalid preview URL");
    let preview = this.#previews.get(id);
    if (!preview) {
      const window = this.#host.window();
      if (!window || window.isDestroyed()) throw new Error("No window");
      if (this.#previews.size >= MAX_VIEWS)
        throw new Error("Too many previews");
      const view = new WebContentsView({
        webPreferences: {
          session: ensurePreviewSession(),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          safeDialogs: true,
        },
      });
      view.setBackgroundColor("#ffffff");
      view.setVisible(false);
      window.contentView.addChildView(view);
      preview = { view, popups: new Set() };
      this.#previews.set(id, preview);
      this.#guard(id, preview);
    }
    this.#load(preview.view.webContents, url);
  }

  #place(id: string, value: unknown): void {
    const view = this.#previews.get(id)?.view;
    const page = this.#host.content();
    if (!view || !page) return;
    const bounds = windowBounds(
      value,
      page.getBounds(),
      page.webContents.getZoomFactor(),
    );
    if (!bounds) throw new Error("Invalid bounds");
    view.setBounds(bounds);
    view.setVisible(true);
  }

  #hide(id: string): void {
    this.#previews.get(id)?.view.setVisible(false);
  }

  #command(id: string, value: unknown): void {
    const contents = this.#previews.get(id)?.view.webContents;
    if (!contents || !COMMANDS.has(value as PreviewCommand)) return;
    const history = contents.navigationHistory;
    switch (value as PreviewCommand) {
      case "back":
        if (history.canGoBack()) history.goBack();
        break;
      case "forward":
        if (history.canGoForward()) history.goForward();
        break;
      case "reload":
        contents.reload();
        break;
    }
  }

  #close(id: string): void {
    const preview = this.#previews.get(id);
    if (!preview) return;
    this.#previews.delete(id);
    for (const popup of preview.popups) if (!popup.isDestroyed()) popup.close();
    const window = this.#host.window();
    if (window && !window.isDestroyed())
      window.contentView.removeChildView(preview.view);
    if (!preview.view.webContents.isDestroyed())
      preview.view.webContents.close();
  }

  #load(contents: WebContents, url: string): void {
    contents.loadURL(url).catch(() => {
      // did-fail-load reports the failure in the view itself.
    });
  }

  // Links that ask for a new tab load in place. Only script popups, such as
  // a sign-in window, open a window: at most MAX_POPUPS, titled with their
  // site so a page cannot pass one off as Linger, and closed with the view.
  #guard(id: string, preview: Preview): void {
    const contents = preview.view.webContents;
    keepToWeb(contents);
    contents.setWindowOpenHandler((details) => {
      const url = previewUrl(details.url);
      if (!url) return { action: "deny" };
      if (details.disposition !== "new-window") {
        this.#load(contents, url);
        return { action: "deny" };
      }
      const window = this.#host.window();
      if (preview.popups.size >= MAX_POPUPS || !window || window.isDestroyed())
        return { action: "deny" };
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 520,
          height: 720,
          autoHideMenuBar: true,
          parent: window,
          title: new URL(url).host,
        },
      };
    });
    contents.on("did-create-window", (popup) => {
      preview.popups.add(popup);
      popup.on("closed", () => preview.popups.delete(popup));
      keepToWeb(popup.webContents);
      popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const titleWithHost = () => {
        const host = previewUrl(popup.webContents.getURL());
        if (host && !popup.isDestroyed()) popup.setTitle(new URL(host).host);
      };
      popup.on("page-title-updated", (event) => event.preventDefault());
      popup.webContents.on("did-navigate", titleWithHost);
    });
    const report = () => this.#report(id, contents);
    contents.on("did-navigate", report);
    contents.on("did-navigate-in-page", report);
    contents.on("render-process-gone", (_event, details) => {
      this.#host.warn("preview.render_process_gone", {
        reason: details.reason,
      });
      const now = Date.now();
      if (
        details.reason === "clean-exit" ||
        (preview.crashedAt !== undefined &&
          now - preview.crashedAt < CRASH_RELOAD_MS)
      )
        return;
      preview.crashedAt = now;
      if (!contents.isDestroyed()) contents.reload();
    });
  }

  #report(id: string, contents: WebContents): void {
    const page = this.#host.content()?.webContents;
    if (!page || page.isDestroyed() || contents.isDestroyed()) return;
    const state: PreviewViewState = {
      url: contents.getURL(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    };
    page.send(IPC.previewState, id, state);
  }
}
