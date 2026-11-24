import {
  BrowserWindow,
  Notification,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  session,
  shell,
  type IpcMainInvokeEvent,
  type Session,
} from "electron";
import os from "node:os";
import path from "node:path";

import iconPng from "../../resources/icon.png";
// The Linger logo with its wordmark, for the page header.
import logoPng from "../../resources/logo-horizontal.png";
// The installer's welcome scene, so setup looks like the installer.
import scenePng from "../../../linger-installer/public/onboarding/welcome-scene.png";
// The SPA's typeface, so the setup page reads like the app it opens.
import geistWoff2 from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2";
import { localizePage } from "../i18n/page.js";
import messagesHtml from "../shell/messages.html";
import { offlineMessages } from "../shell/offline.messages.js";
import setupHtml from "../shell/setup.html";
import { setupMessages } from "../shell/setup.messages.js";
import {
  NVIDIA_DRIVER_DOWNLOAD_URL,
  NVIDIA_DRIVER_GUIDE_URL,
  SETUP_IPC,
  type SetupCommand,
  type SetupLocalAccount,
  type SetupState,
} from "../shared/setup.js";
import { appWindow } from "./app-window.js";
import { dialogMessages } from "./dialogs.messages.js";
import type { DiagnosticsModule } from "./diagnostics.js";
import type { DriverUpdaterHost } from "./driver-updater.js";
import type { EnrollmentModule } from "./enrollment.js";
import type { LanguageModule } from "./language.js";
import type { LocalServerModule } from "./local-server.js";
import {
  SETTINGS_URL,
  type MacPermissions,
  type PermissionStatuses,
} from "./mac-permissions.js";
import type { Module, ModuleContext } from "./modules.js";
import type { PowerGuardModule } from "./power-guard.js";
import { SetupAccount } from "./setup-account.js";
import { parseSetupCommand } from "./setup-command.js";
import type { WindowManagerModule } from "./window-manager.js";
import type { WorkspaceGrantsModule } from "./workspace-grants.js";

export interface SetupWindowOptions {
  readonly preload: string;
  readonly version: string;
  readonly defaultDisplayName: string;
  // Open on start; set when this computer is not connected yet.
  readonly show: boolean;
  readonly loginItem: {
    get(): boolean;
    set(on: boolean): void;
  };
  // macOS only.
  readonly permissions?: MacPermissions;
  readonly driverUpdater?: DriverUpdaterHost;
}

const SETUP_URL = "app://setup/";
// Its own session: the setup page never sees the server's cookies.
const PARTITION = "linger-setup";

// The first-run window (setup, sign-in, connect, permissions). The main
// window stays hidden until setup finishes or the user asks for it.
export class SetupWindowModule implements Module {
  readonly name = "SetupWindow";
  readonly dependsOn = [
    "Diagnostics",
    "Enrollment",
    "Language",
    "LocalServer",
    "PowerGuard",
    "WindowManager",
    "WorkspaceGrants",
  ];
  readonly #options: SetupWindowOptions;
  #ctx: ModuleContext | undefined;
  #window: BrowserWindow | undefined;
  #signedIn = false;
  // The runtime's sign-in was waiting on the browser.
  #runtimeSigningIn = false;
  // Re-check local models when returning from NVIDIA App or a driver download.
  #driverUpdatePendingRecheck = false;
  #lastDriverAutoRecheckAt = 0;
  #permissions: PermissionStatuses | undefined;
  #diagnostics: SetupState["diagnostics"];
  #account: SetupAccount | undefined;
  readonly #unsubscribe: (() => void)[] = [];

  constructor(options: SetupWindowOptions) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    const local = ctx.get<LocalServerModule>("LocalServer");
    this.#account = new SetupAccount({
      read: () => local.account(),
      clipboard,
      showFile: (file) => shell.showItemInFolder(file),
    });
    const pages = this.#session();
    pages.protocol.handle("app", (request) => this.#serve(request));
    const fromSetup = (event: IpcMainInvokeEvent): void => {
      if (
        event.sender !== this.#window?.webContents ||
        !event.senderFrame?.url.startsWith(SETUP_URL)
      )
        throw new Error("Not allowed");
    };
    ipcMain.handle(SETUP_IPC.state, async (event) => {
      fromSetup(event);
      await Promise.all([
        this.#refreshSignedIn(),
        this.#refreshPermissions(),
        this.#refreshAccount(),
      ]);
      return this.#state();
    });
    ipcMain.handle(SETUP_IPC.run, async (event, command: unknown) => {
      fromSetup(event);
      await this.#run(parseSetupCommand(command));
      return this.#state();
    });
    const push = (): void => this.#push();
    // Signing in happens in the main window; its cookies tell us when.
    const onCookie = (): void => void this.#refreshSignedIn().then(push);
    // The account file exists once the installation is ready.
    const onLocal = (): void => {
      // Back from signing in to the runtime in the browser: setup comes to
      // the front again and goes on by itself.
      const signIn = local.status().signIn?.state;
      if (signIn === "signed_in" && this.#runtimeSigningIn && this.visible())
        this.show();
      this.#runtimeSigningIn =
        signIn === "starting" || signIn === "waiting_user";
      push();
      if (local.status().phase === "ready")
        void this.#refreshAccount().then(push);
    };
    session.defaultSession.cookies.on("changed", onCookie);
    this.#unsubscribe.push(
      () => ipcMain.removeHandler(SETUP_IPC.state),
      () => ipcMain.removeHandler(SETUP_IPC.run),
      () => session.defaultSession.cookies.off("changed", onCookie),
      () => pages.protocol.unhandle("app"),
      ctx.bus.on("computer.changed", push),
      ctx.bus.on("diagnostics.changed", push),
      ctx.bus.on("driver-update.changed", () => {
        push();
        if (this.#options.driverUpdater?.installState().phase === "completed") {
          ctx.get<LocalServerModule>("LocalServer").recheck();
        }
      }),
      ctx.bus.on("power.changed", push),
      ctx.bus.on("grants.changed", push),
      ctx.bus.on("local-server.changed", onLocal),
      ctx.bus.on("server.changed", onCookie),
      ctx.bus.on("server.moved", onCookie),
      ctx.bus.on("setup.open", () => this.show()),
    );
    if (this.#options.show) this.show();
  }

  async stop(): Promise<void> {
    for (const off of this.#unsubscribe.splice(0)) off();
    this.#window?.destroy();
    this.#window = undefined;
  }

  visible(): boolean {
    return !!this.#window && !this.#window.isDestroyed();
  }

  // Opens Linger again: setup until this computer is connected, the main
  // window after.
  showApp(): void {
    const enrolled = !!this.#ctx?.config.get().computerId;
    if (appWindow({ enrolled, setupOpen: this.visible() }) === "setup")
      this.show();
    else this.#ctx?.get<WindowManagerModule>("WindowManager").show();
  }

  show(): void {
    if (this.#window && !this.#window.isDestroyed()) {
      this.#window.show();
      this.#window.focus();
      return;
    }
    const window = new BrowserWindow({
      width: 760,
      height: 660,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      title: this.#t(dialogMessages.setupTitle),
      backgroundColor: "#ffffff",
      icon: nativeImage.createFromBuffer(Buffer.from(iconPng)),
      ...(process.platform === "darwin"
        ? {
            titleBarStyle: "hiddenInset" as const,
            trafficLightPosition: { x: 16, y: 16 },
          }
        : { autoHideMenuBar: true }),
      webPreferences: {
        preload: this.#options.preload,
        session: this.#session(),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    const contents = window.webContents;
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", (event) => event.preventDefault());
    window.once("ready-to-show", () => window.show());
    // Back from System Settings or a driver updater: show what changed there.
    window.on("focus", () => {
      void this.#refreshPermissions().then(() => this.#push());
      this.#maybeRecheckDriverOnFocus();
    });
    window.on("closed", () => {
      if (this.#window === window) this.#window = undefined;
      this.#account?.hide();
      // A report waiting on this page's consent would block other sends.
      const sender = this.#ctx?.get<DiagnosticsModule>("Diagnostics").sender;
      if (sender?.state().phase === "confirm") void sender.cancel();
    });
    this.#window = window;
    void window.loadURL(SETUP_URL).catch(() => undefined);
    // Whether this computer can serve a local model, found out while the
    // page is read; the option appears once it can.
    this.#ctx?.get<LocalServerModule>("LocalServer").inspect();
  }

  get #t() {
    return this.#ctx!.get<LanguageModule>("Language").t;
  }

  async #run(command: SetupCommand): Promise<void> {
    const ctx = this.#ctx!;
    const windows = ctx.get<WindowManagerModule>("WindowManager");
    switch (command.op) {
      case "server.set":
        if (!windows.setServer(command.serverUrl))
          throw new Error(this.#t(offlineMessages.invalidServer));
        await this.#refreshSignedIn();
        return;
      case "external.open":
        if (
          command.url === NVIDIA_DRIVER_DOWNLOAD_URL ||
          command.url === NVIDIA_DRIVER_GUIDE_URL
        ) {
          this.#driverUpdatePendingRecheck = true;
        }
        await shell.openExternal(command.url);
        return;
      case "driver.open-nvidia-app": {
        this.#driverUpdatePendingRecheck = true;
        const result = await this.#options.driverUpdater?.openNvidiaApp();
        if (!result?.ok) {
          await shell.openExternal(NVIDIA_DRIVER_DOWNLOAD_URL);
        }
        return;
      }
      case "driver.start-install": {
        this.#driverUpdatePendingRecheck = true;
        const local = ctx.get<LocalServerModule>("LocalServer");
        const models = local.status().localModels;
        const gpuName = models.state === "checked" ? models.gpu : undefined;
        await this.#options.driverUpdater?.startInstall({
          ...(gpuName ? { gpuName } : {}),
          ...(command.requiredCuda
            ? { requiredCuda: command.requiredCuda }
            : {}),
        });
        return;
      }
      case "driver.clear-state":
        this.#options.driverUpdater?.clearInstallState();
        return;
      case "local.start": {
        const local = ctx.get<LocalServerModule>("LocalServer");
        const plan = {
          runtime: command.byok
            ? command.byok.runtime
            : (command.runtime ?? "recommended"),
          ...(command.byok ? { byok: command.byok } : {}),
          ...(command.keys ? { keys: command.keys } : {}),
        } as const;
        // The page follows progress through state; a failure shows there too.
        void local.begin(plan).catch(() => undefined);
        return;
      }
      case "local.byok.check":
        await ctx.get<LocalServerModule>("LocalServer").checkByok(command.byok);
        return;
      case "local.byok.models":
        await ctx
          .get<LocalServerModule>("LocalServer")
          .listByokModels(command.byok);
        return;
      case "local.recheck":
        ctx.get<LocalServerModule>("LocalServer").recheck();
        return;
      case "local.location.pick": {
        const picked = await dialog.showOpenDialog(this.#window!, {
          title: this.#t(dialogMessages.chooseInstallFolder),
          buttonLabel: this.#t(dialogMessages.choose),
          properties: ["openDirectory", "createDirectory"],
        });
        if (picked.canceled || !picked.filePaths[0]) return;
        await ctx
          .get<LocalServerModule>("LocalServer")
          .chooseLocation(picked.filePaths[0]);
        return;
      }
      case "local.location.reset":
        await ctx.get<LocalServerModule>("LocalServer").chooseLocation(null);
        return;
      case "local.signin.start":
        await ctx
          .get<LocalServerModule>("LocalServer")
          .startSignIn(command.code, command.device);
        return;
      case "local.signin.copy": {
        // Copied from what the step shows, never from the page.
        const signIn = ctx
          .get<LocalServerModule>("LocalServer")
          .status().signIn;
        const text = command.what === "code" ? signIn?.deviceCode : signIn?.url;
        if (!text) throw new Error("Nothing to copy");
        clipboard.writeText(text);
        return;
      }
      case "local.signin.open":
        await ctx.get<LocalServerModule>("LocalServer").openSignInPage();
        return;
      case "local.signin.cancel":
        await ctx.get<LocalServerModule>("LocalServer").cancelSignIn();
        return;
      case "local.signin.switch":
        ctx
          .get<LocalServerModule>("LocalServer")
          .switchRuntime(command.runtime);
        return;
      case "local.signin.byok":
        ctx.get<LocalServerModule>("LocalServer").switchToByok(command.byok);
        return;
      case "local.account.show":
        await this.#account?.show(command.on);
        return;
      case "local.account.copy":
        await this.#account?.copy();
        return;
      case "local.account.reveal":
        this.#account?.reveal();
        return;
      case "signin.open":
        windows.show();
        return;
      case "computer.connect":
        await ctx.get<EnrollmentModule>("Enrollment").enroll();
        // Bring setup back over the main window used for signing in.
        this.show();
        return;
      case "notifications.test":
        if (Notification.isSupported())
          new Notification({
            title: this.#t(dialogMessages.notificationsOnTitle),
            body: this.#t(dialogMessages.notificationsOn),
          }).show();
        return;
      case "prevent-sleep.set":
        ctx.get<PowerGuardModule>("PowerGuard").setAlwaysOn(command.on);
        return;
      case "open-at-login.set":
        this.#options.loginItem.set(command.on);
        return;
      case "folder.add":
        await ctx.get<WorkspaceGrantsModule>("WorkspaceGrants").pick();
        return;
      case "permission.request":
        await this.#options.permissions?.request(command.id);
        await this.#refreshPermissions();
        return;
      case "permission.settings":
        await shell.openExternal(SETTINGS_URL[command.id]);
        return;
      case "logs.open":
        await ctx.get<DiagnosticsModule>("Diagnostics").openLogs();
        return;
      case "diagnostics.save":
        try {
          this.#diagnostics = {
            file: await ctx.get<DiagnosticsModule>("Diagnostics").save(),
          };
        } catch (error) {
          ctx.log.warn("setup.diagnostics_failed", { error: String(error) });
          this.#diagnostics = {
            error: error instanceof Error ? error.message : String(error),
          };
        }
        return;
      case "diagnostics.send": {
        const sender = ctx.get<DiagnosticsModule>("Diagnostics").sender;
        const state = sender.state();
        // Collecting and uploading report through diagnostics.changed, so
        // the page stays usable meanwhile.
        if (command.action === "start") void sender.start();
        else if (command.action === "confirm") void sender.confirm();
        else if (command.action === "retry") void sender.retry();
        else if (command.action === "cancel") await sender.cancel();
        else if (state.phase === "sent") clipboard.writeText(state.reportId);
        return;
      }
      case "finish":
        this.#window?.close();
        windows.markOpenFromSetup();
        windows.show();
        return;
    }
  }

  #state(): SetupState {
    const ctx = this.#ctx!;
    const config = ctx.config.get();
    const diagnostics = ctx.get<DiagnosticsModule>("Diagnostics");
    return {
      platform: process.platform as SetupState["platform"],
      version: this.#options.version,
      serverUrl: config.serverUrl ?? "",
      signedIn: this.#signedIn,
      enrolled: !!config.computerId,
      displayName: config.displayName ?? this.#options.defaultDisplayName,
      preventSleep: ctx.get<PowerGuardModule>("PowerGuard").alwaysOn(),
      openAtLogin: this.#options.loginItem.get(),
      folders: config.workspaceGrants.map(({ grantId, label, path }) => ({
        grantId,
        label,
        path,
      })),
      localServer: localServerState(
        ctx.get<LocalServerModule>("LocalServer"),
        this.#account?.view(),
      ),
      ...(this.#diagnostics ? { diagnostics: this.#diagnostics } : {}),
      ...(this.#options.driverUpdater
        ? {
            driverUpdate: {
              nvidiaApp: this.#options.driverUpdater.capabilities().nvidiaApp,
              directInstallSupported:
                this.#options.driverUpdater.capabilities()
                  .directInstallSupported,
              installState: this.#options.driverUpdater.installState(),
            },
          }
        : {}),
      ...(diagnostics.uploadUrl()
        ? { diagnosticsSend: diagnostics.sender.state() }
        : {}),
      ...(this.#permissions ? { permissions: this.#permissions } : {}),
    };
  }

  async #refreshSignedIn(): Promise<void> {
    const enrollment = this.#ctx!.get<EnrollmentModule>("Enrollment");
    const signedIn = await enrollment.signedIn();
    // Signing in is the cue to bring setup back to the front.
    if (signedIn && !this.#signedIn && this.visible()) this.show();
    this.#signedIn = signedIn;
  }

  async #refreshAccount(): Promise<void> {
    const local = this.#ctx!.get<LocalServerModule>("LocalServer");
    if (local.status().phase === "ready") await this.#account?.refresh();
  }

  async #refreshPermissions(): Promise<void> {
    const permissions = this.#options.permissions;
    if (!permissions) return;
    try {
      this.#permissions = await permissions.statuses();
    } catch (error) {
      this.#ctx?.log.warn("setup.permissions_failed", { error: String(error) });
    }
  }

  #maybeRecheckDriverOnFocus(): void {
    if (!this.#driverUpdatePendingRecheck) return;
    const local = this.#ctx?.get<LocalServerModule>("LocalServer");
    if (!local) return;
    const models = local.status().localModels;
    const driverBlocked =
      models.state === "checked" &&
      Boolean(models.blockedNow) &&
      Boolean(
        models.reasons?.some(
          (reason) =>
            reason.code === "cuda-driver-update-required" ||
            reason.code === "cuda-driver-version-unknown",
        ),
      );
    if (!driverBlocked) {
      this.#driverUpdatePendingRecheck = false;
      return;
    }
    const now = Date.now();
    if (now - this.#lastDriverAutoRecheckAt < 3000) return;
    this.#lastDriverAutoRecheckAt = now;
    local.recheck();
  }

  #push(): void {
    const contents = this.#window?.webContents;
    if (contents && !contents.isDestroyed())
      contents.send(SETUP_IPC.stateEvent, this.#state());
  }

  #session(): Session {
    return session.fromPartition(PARTITION);
  }

  #serve(request: Request): Response {
    const url = new URL(request.url);
    if (url.host !== "setup") return new Response(null, { status: 404 });
    if (url.pathname === "/welcome-scene.png")
      return new Response(Buffer.from(scenePng), {
        headers: { "content-type": "image/png" },
      });
    if (url.pathname === "/logo.png")
      return new Response(Buffer.from(logoPng), {
        headers: { "content-type": "image/png" },
      });
    if (url.pathname === "/geist.woff2")
      return new Response(Buffer.from(geistWoff2), {
        headers: { "content-type": "font/woff2" },
      });
    // In the language of the moment it opens; the Web client, where the
    // language is chosen, is not on screen while setup is.
    const page = localizePage(
      setupHtml,
      messagesHtml,
      setupMessages,
      this.#ctx!.get<LanguageModule>("Language").current(),
    );
    return new Response(page, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
}

const localServerState = (
  local: LocalServerModule,
  account: SetupLocalAccount | undefined,
): SetupState["localServer"] => {
  const {
    available,
    phase,
    message,
    preparing,
    steps,
    step,
    progress,
    transfer,
    waiting,
    attempt,
    localModels,
    location,
    keys,
    signIn,
    byokCheck,
    byokModels,
    legacyBackup,
    refusal,
    failure,
  } = local.status();
  const home = os.homedir();
  const shown = (folder: string) =>
    folder === home || folder.startsWith(home + path.sep)
      ? "~" + folder.slice(home.length)
      : folder;
  return {
    available,
    phase,
    message,
    ...(preparing ? { preparing } : {}),
    steps,
    step,
    progress,
    ...(transfer ? { transfer } : {}),
    ...(waiting ? { waiting } : {}),
    attempt,
    localModels,
    location: {
      ...location,
      path: shown(location.path),
    },
    keys,
    ...(signIn ? { signIn } : {}),
    ...(byokCheck ? { byokCheck } : {}),
    ...(byokModels ? { byokModels } : {}),
    ...(legacyBackup ? { legacyBackup: shown(legacyBackup) } : {}),
    ...(refusal ? { refusal } : {}),
    ...(failure ? { failure } : {}),
    ...(account ? { account } : {}),
  };
};
