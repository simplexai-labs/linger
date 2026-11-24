import {
  BaseWindow,
  WebContentsView,
  ipcMain,
  nativeImage,
  net,
  protocol,
  screen,
  session,
  shell,
  type BaseWindowConstructorOptions,
  type IpcMainEvent,
  type WebContents,
} from "electron";

import iconPng from "../../resources/icon.png";
import { localizePage } from "../i18n/page.js";
import messagesHtml from "../shell/messages.html";
import offlineHtml from "../shell/offline.html";
import { offlineMessages } from "../shell/offline.messages.js";
import titlebarHtml from "../shell/titlebar.html";
import { titlebarMessages } from "../shell/titlebar.messages.js";
import {
  SHELL_IPC,
  type ShellCommand,
  type ShellPlatform,
  type TitlebarState,
} from "../shared/shell.js";
import { IPC } from "../shared/api.js";
import type { DiagnosticsModule } from "./diagnostics.js";
import { diagnosticsDialogs } from "./diagnostics-dialogs.js";
import { sendWithPrompts } from "./diagnostics-upload.js";
import type { LanguageModule } from "./language.js";
import type { Module, ModuleContext } from "./modules.js";
import { PreviewViews } from "./preview-views.js";
import {
  OFFLINE_ORIGIN,
  PREVIEW_FRAME_PREFIX,
  SHELL_ORIGIN,
  type WindowLoadReason,
  type WindowLoadState,
  framableHeaders,
  navigationDecision,
  parseServerUrl,
  permissionAllowed,
  refusesFraming,
  sameOrigin,
  serverSwitch,
  windowLoadDecision,
  voiceWindowRequest,
} from "./navigation.js";
import {
  VOICE_WINDOW_MIN,
  acceptVoiceWindow,
  voiceWindowPosition,
} from "./voice-window.js";

// Must run before app "ready".
export const registerAppScheme = (): void => {
  protocol.registerSchemesAsPrivileged([
    { scheme: "app", privileges: { standard: true, secure: true } },
  ]);
};

export interface WindowManagerOptions {
  readonly preload: string;
  readonly shellPreload: string;
  readonly background: boolean;
  readonly localServerResumable?: (serverUrl: string) => Promise<boolean>;
}

const TITLEBAR_HEIGHT = 40;
const REVEAL_FALLBACK_MS = 1_500;
const CANVAS = "#f6f6f6";
const COMMANDS = new Set<ShellCommand>([
  "back",
  "forward",
  "reload",
  "minimize",
  "maximize",
  "close",
]);

const chrome = (platform: NodeJS.Platform): BaseWindowConstructorOptions => {
  if (platform === "darwin")
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 13 },
    };
  if (platform === "win32")
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: CANVAS,
        symbolColor: "#404040",
        height: TITLEBAR_HEIGHT - 1,
      },
    };
  return { frame: false };
};

// The offline page's code for an address it shows its own message for.
const INVALID_SERVER = "invalid-server";

const html = (body: string): Response =>
  new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

// macOS keeps the native traffic lights over a full-height SPA, which leaves
// room for them (see the preload); elsewhere a desktop-owned title bar sits on
// top of the SPA.
const drawsTitlebar = (platform: NodeJS.Platform): boolean =>
  platform !== "darwin";

// Strip query and hash so tokens or room fragments never reach logs.
const sanitizeTargetUrl = (rawUrl: string): string => {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
};

const ASSET_SCRIPT_RE = /<script\b[^>]*\bsrc=["'](\/assets\/[^"']+)["']/gi;
const ASSET_LINK_RE = /<link\b[^>]*>/gi;
const LINK_REL_RE = /\brel=["'](?:modulepreload|stylesheet)["']/i;
const LINK_HREF_RE = /\bhref=["'](\/assets\/[^"']+)["']/i;

const extractAssetPaths = (documentHtml: string): string[] => {
  const paths = new Set<string>();
  for (const match of documentHtml.matchAll(ASSET_SCRIPT_RE)) {
    if (match[1]) paths.add(match[1]);
  }
  for (const match of documentHtml.matchAll(ASSET_LINK_RE)) {
    const tag = match[0];
    if (!LINK_REL_RE.test(tag)) continue;
    const href = LINK_HREF_RE.exec(tag)?.[1];
    if (href) paths.add(href);
  }
  return [...paths];
};

// The main window. Native window controls stay native (macOS
// traffic lights, the Windows caption overlay); Linux gets drawn controls.
// Closing hides the window; the tray keeps the app running.
export class WindowManagerModule implements Module {
  readonly name = "WindowManager";
  readonly dependsOn = ["Config", "Language"];
  readonly #options: WindowManagerOptions;
  #ctx: ModuleContext | undefined;
  #window: BaseWindow | undefined;
  #titlebar: WebContentsView | undefined;
  #content: WebContentsView | undefined;
  #quitting = false;
  #openFromSetupAt: number | undefined;
  #pendingTargetOrigin: string | undefined;
  #showingShellPage: WindowLoadState["showingShellPage"] = "none";
  #loadFailed = false;
  #loadFailureSeq = 0;
  #loadStartedAt: number | undefined;
  #lastLoadReason: WindowLoadReason | undefined;
  #pendingShow = false;
  #revealTimer: NodeJS.Timeout | undefined;
  // Closes the floating voice window, when there is one.
  #closeVoiceWindow: (() => void) | undefined;
  readonly #previews = new PreviewViews({
    window: () => this.#window,
    content: () => this.#content,
    serverUrl: () => this.#serverUrl(),
    warn: (event, fields) => this.#ctx?.log.warn(event, fields),
  });
  readonly #unsubscribe: (() => void)[] = [];

  constructor(options: WindowManagerOptions) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    this.#secureSession();
    protocol.handle("app", (request) => this.#serveApp(request));
    const onState = (event: IpcMainEvent | Electron.IpcMainInvokeEvent) =>
      this.#fromTitlebar(event);
    ipcMain.handle(SHELL_IPC.state, (event) => {
      if (!onState(event)) throw new Error("Not allowed");
      return this.#titlebarState();
    });
    ipcMain.on(SHELL_IPC.command, (event, name: unknown) => {
      if (!onState(event) || !COMMANDS.has(name as ShellCommand)) return;
      this.#command(name as ShellCommand);
    });
    this.#unsubscribe.push(
      this.#previews.register(),
      () => ipcMain.removeHandler(SHELL_IPC.state),
      () => ipcMain.removeAllListeners(SHELL_IPC.command),
      // The title bar's button labels are filled in when it loads.
      ctx.bus.on("language.changed", () =>
        this.#titlebar?.webContents.reload(),
      ),
    );
    if (!this.#options.background) this.show();
  }

  async stop(): Promise<void> {
    this.#quitting = true;
    this.#clearRevealTimer();
    for (const off of this.#unsubscribe.splice(0)) off();
    protocol.unhandle("app");
    this.#window?.destroy();
    this.#window = undefined;
  }

  // Lets the next close really close the window.
  prepareQuit(): void {
    this.#quitting = true;
  }

  window(): BaseWindow | undefined {
    return this.#window;
  }

  webContents(): WebContents | undefined {
    return this.#content?.webContents;
  }

  markOpenFromSetup(): void {
    const contents = this.#content?.webContents;
    const target = this.#serverUrl();
    if (
      target &&
      contents &&
      !contents.isDestroyed() &&
      !contents.isLoading() &&
      sameOrigin(contents.getURL(), target)
    ) {
      this.#openFromSetupAt = undefined;
      this.#ctx?.log.info("local_server.timing", {
        step: "open_linger_to_load",
        ms: 0,
      });
      return;
    }
    this.#openFromSetupAt = Date.now();
  }

  show(): void {
    if (this.#window) {
      this.#pendingShow = false;
      this.#clearRevealTimer();
      if (this.#window.isMinimized()) this.#window.restore();
      this.#window.show();
      this.#window.focus();
      return;
    }
    this.#pendingShow = true;
    this.#ensureWindow();
    this.#scheduleRevealFallback();
    this.#loadConfiguredServer("boot");
    this.#content?.webContents.focus();
  }

  // Warms the default session HTTP cache with `/` HTML and `/assets/*` bundles
  // without mutating cookies or mounting a DOM.
  async prewarmAssets(origin: string): Promise<void> {
    const base = parseServerUrl(origin);
    if (!base) return;
    try {
      const response = await net.fetch(`${base}/`, {
        credentials: "omit",
      });
      if (!response.ok) return;
      const assets = extractAssetPaths(await response.text());
      await Promise.allSettled(
        assets.map(async (assetPath) => {
          const assetResponse = await net.fetch(
            new URL(assetPath, base).toString(),
            {
              credentials: "omit",
            },
          );
          await assetResponse.arrayBuffer();
        }),
      );
    } catch {
      // Best-effort cache warming; failures do not affect window loading.
    }
  }

  // Creates the hidden window and loads the enrolled server in the background
  // so opening the main window reveals an already-rendered SPA immediately.
  preloadAuthenticated(origin: string): void {
    const serverUrl = this.#serverUrl();
    if (
      !serverUrl ||
      !sameOrigin(serverUrl, origin) ||
      !this.#ctx?.config.get().computerId
    )
      return;
    if (!this.#window) {
      this.#pendingShow = false;
      this.#ensureWindow();
    }
    this.#navigateToServer(origin, { reason: "prewarm" });
  }

  #ensureWindow(): void {
    if (this.#window) return;
    const bounds = this.#ctx!.config.get().window;
    const window = new BaseWindow({
      ...(bounds ?? { width: 1280, height: 820 }),
      minWidth: 800,
      minHeight: 560,
      show: false,
      title: "Linger",
      backgroundColor: CANVAS,
      icon: nativeImage.createFromBuffer(Buffer.from(iconPng)),
      ...chrome(process.platform),
    });
    const titlebar = drawsTitlebar(process.platform)
      ? new WebContentsView({
          webPreferences: {
            preload: this.#options.shellPreload,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            spellcheck: false,
          },
        })
      : undefined;
    titlebar?.setBackgroundColor(CANVAS);
    const content = new WebContentsView({
      webPreferences: {
        preload: this.#options.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    });
    content.setBackgroundColor("#ffffff");
    if (titlebar) window.contentView.addChildView(titlebar);
    window.contentView.addChildView(content);
    this.#window = window;
    this.#titlebar = titlebar;
    this.#content = content;

    const layout = (): void => {
      const { width, height } = window.getContentBounds();
      const top = titlebar ? TITLEBAR_HEIGHT : 0;
      titlebar?.setBounds({ x: 0, y: 0, width, height: top });
      content.setBounds({ x: 0, y: top, width, height: height - top });
    };
    layout();
    window.on("resize", layout);
    for (const event of [
      "maximize",
      "unmaximize",
      "enter-full-screen",
      "leave-full-screen",
      "focus",
      "blur",
    ] as const)
      window.on(event as "focus", () => this.#pushState());

    if (titlebar) this.#guardTitlebar(titlebar.webContents);
    this.#guardContent(content.webContents);
    window.on("close", (event) => {
      this.#pendingShow = false;
      this.#clearRevealTimer();
      const { x, y, width, height } = window.getNormalBounds();
      this.#ctx!.config.update({ window: { x, y, width, height } });
      if (this.#quitting) return;
      event.preventDefault();
      window.hide();
    });
    window.on("closed", () => {
      this.#closeVoiceWindow?.();
      this.#previews.closeAll();
      titlebar?.webContents.close();
      content.webContents.close();
      if (this.#window === window) {
        this.#clearRevealTimer();
        this.#window = undefined;
        this.#titlebar = undefined;
        this.#content = undefined;
        this.#pendingTargetOrigin = undefined;
        this.#showingShellPage = "none";
        this.#loadFailed = false;
        this.#pendingShow = false;
      }
    });

    void titlebar?.webContents
      .loadURL(`${SHELL_ORIGIN}/titlebar`)
      .catch(() => undefined);
  }

  #scheduleRevealFallback(): void {
    this.#clearRevealTimer();
    const timer = setTimeout(() => {
      this.#revealTimer = undefined;
      this.#revealIfPending();
    }, REVEAL_FALLBACK_MS);
    timer.unref?.();
    this.#revealTimer = timer;
  }

  #clearRevealTimer(): void {
    if (!this.#revealTimer) return;
    clearTimeout(this.#revealTimer);
    this.#revealTimer = undefined;
  }

  #revealIfPending(): void {
    this.#clearRevealTimer();
    if (!this.#pendingShow || !this.#window || this.#window.isDestroyed())
      return;
    this.#pendingShow = false;
    if (this.#window.isMinimized()) this.#window.restore();
    this.#window.show();
    this.#window.focus();
  }

  // Points the app at another server; false when the address is invalid.
  // `movedFrom` names the origin the same server answered at before (the
  // installer moved this computer's server off a taken port): the window
  // follows it as `server.moved`, which keeps this computer's enrollment,
  // instead of `server.changed`, which drops it.
  setServer(
    value: string,
    movedFrom?: string,
    options?: { reason?: WindowLoadReason },
  ): boolean {
    const serverUrl = parseServerUrl(value);
    if (!serverUrl) return false;
    const ctx = this.#ctx!;
    const previous = ctx.config.get().serverUrl;
    const { moved, changed } = serverSwitch(previous, serverUrl, movedFrom);
    const reason: WindowLoadReason =
      options?.reason ?? (moved ? "port_moved" : "server_changed");
    const decision = windowLoadDecision(
      this.#loadState(),
      previous,
      serverUrl,
      { ...(movedFrom !== undefined ? { movedFrom } : {}), reason },
    );
    if (
      decision.action === "noop" &&
      previous !== undefined &&
      !sameOrigin(previous, serverUrl)
    ) {
      return true;
    }
    if (serverUrl !== previous) {
      ctx.config.update({ serverUrl });
      this.#pushState();
    }
    if (moved) ctx.bus.emit("server.moved", movedFrom!, serverUrl);
    if (changed) ctx.bus.emit("server.changed", serverUrl);
    setImmediate(() => {
      this.#navigateToServer(serverUrl, {
        ...(movedFrom !== undefined ? { movedFrom } : {}),
        reason,
      });
      this.#pushState();
    });
    return true;
  }

  loadServer(reason: WindowLoadReason = "retry"): void {
    this.#loadConfiguredServer(reason);
  }

  #loadConfiguredServer(reason: WindowLoadReason): void {
    const serverUrl = this.#serverUrl();
    if (!serverUrl) {
      this.#loadOffline();
      return;
    }
    this.#navigateToServer(serverUrl, { reason });
  }

  #loadState(): WindowLoadState {
    const contents = this.#content?.webContents;
    const currentUrl =
      contents && !contents.isDestroyed()
        ? contents.getURL() || undefined
        : undefined;
    return {
      ...(currentUrl ? { currentUrl } : {}),
      ...(this.#pendingTargetOrigin
        ? { pendingTargetOrigin: this.#pendingTargetOrigin }
        : {}),
      showingShellPage: this.#showingShellPage,
      loadFailed: this.#loadFailed,
    };
  }

  #navigateToServer(
    targetOrigin: string,
    options: { movedFrom?: string; reason: WindowLoadReason },
  ): void {
    const contents = this.#content?.webContents;
    if (!contents || contents.isDestroyed()) return;
    const decision = windowLoadDecision(
      this.#loadState(),
      this.#serverUrl(),
      targetOrigin,
      options,
    );
    if (decision.action === "noop" || !decision.targetUrl) return;
    this.#loadFailureSeq += 1;
    this.#pendingTargetOrigin = new URL(decision.targetUrl).origin;
    this.#showingShellPage = "none";
    this.#loadFailed = false;
    this.#loadStartedAt = Date.now();
    this.#lastLoadReason = decision.reason;
    void contents.loadURL(decision.targetUrl).catch(() => undefined);
  }

  // While the services on this computer restart on a new version; the
  // server's own pages would fail until they are back.
  showUpdating(): void {
    this.#loadLocal("updating", "1");
  }

  // While the services on this computer start again after the app or the
  // computer restarted.
  showStarting(): void {
    this.#loadLocal("starting", "1");
  }

  // The services on this computer did not start; Try Again starts them again.
  showStartFailed(reason: string): void {
    this.#loadLocal("failed", reason);
  }

  #loadLocal(mode: "updating" | "starting" | "failed", value: string): void {
    this.#loadFailureSeq += 1;
    this.#pendingTargetOrigin = undefined;
    this.#showingShellPage = mode === "failed" ? "start-failed" : "starting";
    this.#loadFailed = mode === "failed";
    const url = new URL(`${OFFLINE_ORIGIN}/`);
    url.searchParams.set(mode, value);
    // Send Diagnostics shows only while a diagnostics server is set up.
    if (
      mode === "failed" &&
      this.#ctx!.get<DiagnosticsModule>("Diagnostics").uploadUrl()
    )
      url.searchParams.set("send", "1");
    void this.#content?.webContents
      .loadURL(url.toString())
      .catch(() => undefined);
  }

  #serverUrl(): string | undefined {
    return this.#ctx!.config.get().serverUrl;
  }

  #loadOffline(error?: string): void {
    this.#loadFailureSeq += 1;
    this.#pendingTargetOrigin = undefined;
    this.#showingShellPage = "offline";
    this.#loadFailed = Boolean(error);
    const url = new URL(`${OFFLINE_ORIGIN}/`);
    const serverUrl = this.#serverUrl();
    if (serverUrl) url.searchParams.set("server", serverUrl);
    if (error) url.searchParams.set("error", error);
    void this.#content?.webContents
      .loadURL(url.toString())
      .catch(() => undefined);
  }

  #titlebarState(): TitlebarState {
    const window = this.#window;
    const contents = this.#content?.webContents;
    const serverUrl = this.#serverUrl();
    return {
      platform: process.platform as ShellPlatform,
      title: serverUrl ? new URL(serverUrl).host : "",
      canGoBack: contents?.navigationHistory.canGoBack() ?? false,
      canGoForward: contents?.navigationHistory.canGoForward() ?? false,
      loading: contents?.isLoading() ?? false,
      maximized: window?.isMaximized() ?? false,
      focused: window?.isFocused() ?? false,
    };
  }

  #pushState(): void {
    const contents = this.#titlebar?.webContents;
    if (contents && !contents.isDestroyed())
      contents.send(SHELL_IPC.stateEvent, this.#titlebarState());
  }

  #fromTitlebar(event: { sender: WebContents }): boolean {
    return (
      event.sender === this.#titlebar?.webContents &&
      event.sender.getURL().startsWith(`${SHELL_ORIGIN}/`)
    );
  }

  #command(name: ShellCommand): void {
    const window = this.#window;
    const history = this.#content?.webContents.navigationHistory;
    if (!window) return;
    switch (name) {
      case "back":
        if (history?.canGoBack()) history.goBack();
        break;
      case "forward":
        if (history?.canGoForward()) history.goForward();
        break;
      case "reload":
        if (this.#content?.webContents.getURL().startsWith(OFFLINE_ORIGIN))
          this.loadServer("retry");
        else this.#content?.webContents.reload();
        break;
      case "minimize":
        window.minimize();
        break;
      case "maximize":
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
        break;
      case "close":
        window.close();
        break;
    }
  }

  // The title bar is a fixed local page: it never navigates or opens windows.
  #guardTitlebar(contents: WebContents): void {
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("did-finish-load", () => this.#pushState());
  }

  #guardContent(contents: WebContents): void {
    contents.on("will-navigate", (event, url) =>
      this.#guard(event, url, contents.getURL()),
    );
    // Redirects inside frames, such as a site in the link preview panel, stay
    // in their frame.
    contents.on("will-redirect", (event) => {
      if (event.isMainFrame) this.#guard(event, event.url, contents.getURL());
    });
    // The one window the page may open: the floating voice window, which it
    // fills itself so the call stays in this page.
    contents.setWindowOpenHandler((details) => {
      if (voiceWindowRequest(details, this.#serverUrl(), contents.getURL()))
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            title: "Linger",
            // The page asks for the size of its content, as in a browser.
            useContentSize: true,
            minWidth: VOICE_WINDOW_MIN.width,
            minHeight: VOICE_WINDOW_MIN.height,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            autoHideMenuBar: true,
            backgroundColor: CANVAS,
          },
        };
      if (navigationDecision(details.url, this.#serverUrl()) !== "deny")
        this.#openExternal(details.url);
      return { action: "deny" };
    });
    contents.on("did-create-window", (child) => {
      const close = acceptVoiceWindow(
        child,
        contents,
        this.#closeVoiceWindow,
        process.platform,
      );
      if (!close) return;
      this.#closeVoiceWindow = close;
      const main = this.#window;
      if (main && !main.isDestroyed()) {
        const { workArea } = screen.getDisplayMatching(main.getBounds());
        const { x, y } = voiceWindowPosition(child.getBounds(), workArea);
        child.setPosition(x, y);
      }
      child.on("closed", () => {
        if (this.#closeVoiceWindow === close)
          this.#closeVoiceWindow = undefined;
      });
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("did-fail-load", (_event, code, description, url, isMain) => {
      // -3 is an aborted load, usually a navigation replacing another.
      if (!isMain || code === -3 || url.startsWith(OFFLINE_ORIGIN)) return;
      const serverUrl = this.#serverUrl();
      // Ignore late failures from an older origin after the server moved or
      // changed, so they never clobber the active navigation with Starting.
      if (serverUrl && !sameOrigin(url, serverUrl)) return;
      this.#revealIfPending();
      this.#loadFailed = true;
      this.#pendingTargetOrigin = undefined;
      this.#ctx!.log.warn("window.load_failed", {
        code,
        description,
        ...(this.#lastLoadReason ? { reason: this.#lastLoadReason } : {}),
      });
      const seq = ++this.#loadFailureSeq;
      const check =
        serverUrl && this.#options.localServerResumable
          ? this.#options.localServerResumable(serverUrl).catch(() => false)
          : Promise.resolve(false);
      void check.then((resumable) => {
        if (
          seq !== this.#loadFailureSeq ||
          this.#showingShellPage !== "none" ||
          !this.#loadFailed ||
          this.#serverUrl() !== serverUrl
        )
          return;
        if (resumable) this.showStarting();
        else {
          this.#loadOffline(description);
          // A local server that stopped is started again from there.
          this.#ctx!.bus.emit("local-server.unreachable");
        }
      });
    });
    contents.on("did-finish-load", () => {
      this.#revealIfPending();
      const loadedUrl = contents.getURL();
      const isOffline = loadedUrl.startsWith(OFFLINE_ORIGIN);
      if (!isOffline) {
        this.#pendingTargetOrigin = undefined;
        this.#showingShellPage = "none";
        this.#loadFailed = false;
        if (this.#lastLoadReason !== undefined) {
          const durationMs =
            this.#loadStartedAt !== undefined
              ? Date.now() - this.#loadStartedAt
              : 0;
          const reason = this.#lastLoadReason;
          this.#loadStartedAt = undefined;
          this.#lastLoadReason = undefined;
          this.#ctx?.log.info("window.did_finish_load", {
            reason,
            duration_ms: durationMs,
            target: sanitizeTargetUrl(loadedUrl),
          });
        }
      }
      if (this.#openFromSetupAt === undefined) return;
      const target = this.#serverUrl();
      if (!target || !sameOrigin(loadedUrl, target)) return;
      const startedAt = this.#openFromSetupAt;
      this.#openFromSetupAt = undefined;
      this.#ctx?.log.info("local_server.timing", {
        step: "open_linger_to_load",
        ms: Date.now() - startedAt,
      });
    });
    for (const event of [
      "did-navigate",
      "did-navigate-in-page",
      "did-start-loading",
      "did-stop-loading",
    ] as const)
      contents.on(event as "did-start-loading", () => this.#pushState());
    // A new page in the window no longer knows the previews of the last one.
    contents.on("did-navigate", () => this.#previews.closeAll());
    contents.on("render-process-gone", () => this.#previews.closeAll());
  }

  #guard(
    event: { preventDefault(): void },
    url: string,
    fromUrl: string,
  ): void {
    const decision = navigationDecision(url, this.#serverUrl(), fromUrl);
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "external") this.#openExternal(url);
  }

  // A link the system browser cannot take otherwise fails silently, so the
  // failure is logged with the link's origin.
  #openExternal(url: string): void {
    shell.openExternal(url).catch((error: unknown) => {
      this.#ctx?.log.warn("window.open_external_failed", {
        origin: new URL(url).origin,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  #secureSession(): void {
    const target = session.defaultSession;
    target.setPermissionRequestHandler((_contents, permission, done, details) =>
      done(
        permissionAllowed(
          permission,
          {
            requestingUrl: details.requestingUrl,
            ...("mediaTypes" in details
              ? { mediaTypes: details.mediaTypes ?? [] }
              : {}),
          },
          this.#serverUrl(),
        ),
      ),
    );
    target.setPermissionCheckHandler((_contents, permission, origin, details) =>
      permissionAllowed(
        permission,
        {
          requestingUrl: origin,
          ...(details.mediaType ? { mediaTypes: [details.mediaType] } : {}),
        },
        this.#serverUrl(),
      ),
    );
    // Frames in the app's own page, such as the link preview panel.
    target.webRequest.onHeadersReceived((details, done) => {
      const contents = this.#content?.webContents;
      const server = this.#serverUrl();
      if (
        details.resourceType !== "subFrame" ||
        !details.responseHeaders ||
        !contents ||
        contents.isDestroyed() ||
        details.webContentsId !== contents.id ||
        !server ||
        !sameOrigin(contents.getURL(), server)
      ) {
        done({});
        return;
      }
      const name = details.frame?.name ?? "";
      if (!name.startsWith(PREVIEW_FRAME_PREFIX)) {
        done({ responseHeaders: framableHeaders(details.responseHeaders) });
        return;
      }
      // Chromium applies framing rules to the final response only.
      const redirect = details.statusCode >= 300 && details.statusCode < 400;
      if (
        !redirect &&
        refusesFraming(details.responseHeaders, new URL(server).protocol)
      )
        contents.send(IPC.previewFrameRefused, name, details.url);
      done({});
    });
  }

  #serveApp(request: Request): Response {
    const url = new URL(request.url);
    if (url.host === "shell" && url.pathname === "/titlebar")
      return html(this.#localize(titlebarHtml, titlebarMessages));
    if (url.host !== "offline") return new Response(null, { status: 404 });
    if (url.pathname === "/logo.png")
      return new Response(Buffer.from(iconPng), {
        headers: { "content-type": "image/png" },
      });
    // The start failure page's Show Logs and Save Diagnostics.
    if (url.pathname === "/logs" || url.pathname === "/diagnostics") {
      const diagnostics = this.#ctx!.get<DiagnosticsModule>("Diagnostics");
      void (
        url.pathname === "/logs" ? diagnostics.openLogs() : diagnostics.save()
      ).catch((error: unknown) =>
        this.#ctx?.log.warn("window.diagnostics_failed", {
          error: String(error),
        }),
      );
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/send") {
      void sendWithPrompts(
        this.#ctx!.get<DiagnosticsModule>("Diagnostics").sender,
        diagnosticsDialogs(() => this.#window, this.#language().t),
      );
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/restart") {
      this.#ctx!.bus.emit("local-server.retry");
      return new Response(null, { status: 204 });
    }
    // Back to setup from the server address form, or, from the start failure
    // page, setting this computer up again.
    if (url.pathname === "/setup" || url.pathname === "/reset") {
      this.#window?.hide();
      if (url.pathname === "/reset") this.#ctx!.bus.emit("local-server.reset");
      else this.#ctx!.bus.emit("setup.open");
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/connect") {
      if (!this.setServer(url.searchParams.get("server") ?? ""))
        this.#loadOffline(INVALID_SERVER);
      return new Response(null, { status: 204 });
    }
    return html(this.#localize(offlineHtml, offlineMessages));
  }

  #language(): LanguageModule {
    return this.#ctx!.get<LanguageModule>("Language");
  }

  #localize(page: string, messages: Parameters<typeof localizePage>[2]) {
    return localizePage(
      page,
      messagesHtml,
      messages,
      this.#language().current(),
    );
  }
}
