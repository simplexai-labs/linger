import { app, ipcMain, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";

import {
  IPC,
  type ComputerStatus,
  type DesktopSettings,
  type DesktopUpdateState,
  type LocalAccountSignIn,
  type WorkspaceGrantView,
} from "../shared/api.js";
import { LANGUAGES } from "../i18n/language.js";
import type { ComputerDaemonModule } from "./computer-daemon.js";
import type { WorkspaceGrant } from "./config.js";
import { ConnectorOAuth } from "./connector-oauth.js";
import type { DiagnosticsModule } from "./diagnostics.js";
import type { DriverUpdaterHost } from "./driver-updater.js";
import type { EnrollmentModule } from "./enrollment.js";
import type { LanguageModule } from "./language.js";
import type { LocalServerModule } from "./local-server.js";
import type { Module, ModuleContext } from "./modules.js";
import { sameOrigin } from "./navigation.js";
import type { PowerGuardModule } from "./power-guard.js";
import {
  runDesktopPermissionStep,
  type DesktopPermissionHost,
} from "./system-permissions.js";
import type { UpdaterModule, UpdateState } from "./updater.js";
import type { WindowManagerModule } from "./window-manager.js";
import type { WorkspaceGrantsModule } from "./workspace-grants.js";

const grantIdInput = z.string().min(1).max(128);
const languageInput = z.enum(LANGUAGES);
// The server address is not settable from the SPA: a page served by one
// server must not be able to repoint the app. It changes on app://offline.
const settingsPatchInput = z
  .object({
    displayName: z.string().min(1).max(120).optional(),
    preventSleep: z.boolean().optional(),
  })
  .strict();

const permissionId = z.enum(["screen_recording", "accessibility"]);
const permissionStepInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("prompt"),
      subject: z.literal("linger"),
      permission: permissionId,
    })
    .strict(),
  z
    .object({
      action: z.literal("open_settings"),
      subject: z.enum(["linger", "computer_use"]),
      permission: permissionId,
    })
    .strict(),
  z
    .object({ action: z.literal("relaunch"), subject: z.literal("linger") })
    .strict(),
]);

const driverInstallRequestInput = z
  .object({
    gpuName: z.string().trim().min(1).max(200).optional(),
    requiredCuda: z
      .string()
      .trim()
      .regex(/^\d+(?:\.\d+){0,2}$/)
      .optional(),
    resumeModelId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/)
      .optional(),
  })
  .strict();

const view = (grant: WorkspaceGrant): WorkspaceGrantView => ({ ...grant });

// The page learns what the tray shows; Install opens a release page itself,
// so its URL stays in the main process.
const updateView = (state: UpdateState): DesktopUpdateState =>
  state.kind === "available"
    ? { kind: state.kind, version: state.version }
    : state;

// The preload API handlers. Every call must come from a frame on
// the configured server origin; inputs are validated with zod.
export class DesktopIpcModule implements Module {
  readonly name = "DesktopIpc";
  readonly dependsOn = [
    "Enrollment",
    "LocalServer",
    "PowerGuard",
    "ComputerDaemon",
    "Diagnostics",
    "WindowManager",
    "WorkspaceGrants",
    "Updater",
    "Language",
  ];
  readonly #defaultDisplayName: string;
  // Set on macOS only.
  readonly #permissions: DesktopPermissionHost | undefined;
  readonly #driverUpdater: DriverUpdaterHost | undefined;
  readonly #unsubscribe: (() => void)[] = [];

  constructor(options: {
    defaultDisplayName: string;
    permissions?: DesktopPermissionHost;
    driverUpdater?: DriverUpdaterHost;
  }) {
    this.#defaultDisplayName = options.defaultDisplayName;
    this.#permissions = options.permissions;
    this.#driverUpdater = options.driverUpdater;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const daemon = ctx.get<ComputerDaemonModule>("ComputerDaemon");
    const enrollment = ctx.get<EnrollmentModule>("Enrollment");
    const grants = ctx.get<WorkspaceGrantsModule>("WorkspaceGrants");
    const windows = ctx.get<WindowManagerModule>("WindowManager");
    const power = ctx.get<PowerGuardModule>("PowerGuard");
    const localServer = ctx.get<LocalServerModule>("LocalServer");
    const updater = ctx.get<UpdaterModule>("Updater");
    const language = ctx.get<LanguageModule>("Language");
    const diagnostics = ctx.get<DiagnosticsModule>("Diagnostics");

    const oauth = new ConnectorOAuth();
    ipcMain.handle(IPC.connectorOAuthPrepare, (event: IpcMainInvokeEvent) => {
      const contents = windows.webContents();
      const origin = ctx.config.get().serverUrl;
      if (
        !contents ||
        !origin ||
        event.sender !== contents ||
        event.senderFrame !== contents.mainFrame ||
        !sameOrigin(contents.getURL(), origin)
      ) {
        throw new Error("Not allowed");
      }
      return oauth.prepare((account) => {
        if (
          contents.isDestroyed() ||
          !sameOrigin(contents.getURL(), origin) ||
          contents !== windows.webContents()
        )
          return;
        windows.show();
        if (process.platform === "darwin") app.focus({ steal: true });
        contents.send(IPC.connectorOAuthReturn, account);
      });
    });
    this.#unsubscribe.push(() => {
      ipcMain.removeHandler(IPC.connectorOAuthPrepare);
      oauth.stop();
    });

    const status = (): ComputerStatus => {
      const computerId = ctx.config.get().computerId;
      return {
        bridge: daemon.connection(),
        runtime: daemon.state(),
        ...(computerId ? { computerId } : {}),
        activeOperations: daemon.running(),
        preventSleep: power.active(),
      };
    };
    const settings = (): DesktopSettings => {
      const config = ctx.config.get();
      return {
        serverUrl: config.serverUrl ?? "",
        displayName: config.displayName ?? this.#defaultDisplayName,
        preventSleep: power.alwaysOn(),
      };
    };
    const handle = (
      channel: string,
      handler: (...args: unknown[]) => unknown,
    ): void => {
      ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args) => {
        const serverUrl = ctx.config.get().serverUrl;
        const origin = event.senderFrame?.origin;
        if (!serverUrl || !origin || !sameOrigin(origin, serverUrl)) {
          ctx.log.warn("ipc.rejected_origin", { channel });
          throw new Error("Not allowed");
        }
        return handler(...args);
      });
      this.#unsubscribe.push(() => ipcMain.removeHandler(channel));
    };

    handle(IPC.computerStatus, () => status());
    handle(IPC.computerEnroll, () => enrollment.enroll());
    handle(IPC.computerUnenroll, () => enrollment.unenroll());
    handle(IPC.workspacePick, async () => {
      const grant = await grants.pick();
      return grant ? view(grant) : null;
    });
    handle(IPC.workspaceList, () => grants.list().map(view));
    handle(IPC.workspaceRevoke, (grantId) => {
      grants.revoke(grantIdInput.parse(grantId));
    });
    handle(IPC.settingsGet, () => settings());
    handle(IPC.settingsSet, (patch) => {
      const parsed = settingsPatchInput.parse(patch);
      const before = settings().displayName;
      if (parsed.displayName !== undefined) {
        ctx.config.update({ displayName: parsed.displayName });
        // The daemon announces the name; a new name restarts it when idle.
        if (settings().displayName !== before) ctx.bus.emit("computer.renamed");
      }
      if (parsed.preventSleep !== undefined)
        power.setAlwaysOn(parsed.preventSleep);
      return settings();
    });

    // The handler already checked that the caller is the window's server, so
    // only the window's server needs to be the installed one.
    handle(IPC.localAccountAvailable, () => localServer.servesWindow());
    handle(IPC.localServerOwned, () => localServer.ownsWindow());
    handle(IPC.localAccountSignIn, async (): Promise<LocalAccountSignIn> => {
      try {
        await localServer.signInWithAccount();
        ctx.log.info("local_server.account_signed_in", {});
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.log.warn("local_server.account_sign_in_failed", { error: message });
        return { ok: false, message };
      }
    });

    // The way back from the floating voice window, which stays up while the
    // main window is minimized, hidden to the tray or behind another app.
    // macOS brings a window forward only within the app, so the app comes
    // forward too.
    handle(IPC.voiceWindowShowMain, () => {
      windows.show();
      if (process.platform === "darwin") app.focus({ steal: true });
    });
    // The language picked in the page's Settings, for the shell's own text.
    handle(IPC.languageSet, (tag) => {
      language.choose(languageInput.parse(tag));
    });
    // The same save as the tray's; the page learns only whether it worked.
    handle(IPC.diagnosticsSave, async () => {
      try {
        await diagnostics.save();
      } catch (error) {
        ctx.log.warn("ipc.diagnostics_failed", { error: String(error) });
        throw error;
      }
    });
    handle(IPC.updateState, () => updateView(updater.state()));
    handle(IPC.updateInstall, () => updater.install());
    handle(IPC.updateCheck, () => updater.check());

    const permissions = this.#permissions;
    if (permissions)
      handle(IPC.permissionAct, (step) =>
        runDesktopPermissionStep(permissions, permissionStepInput.parse(step)),
      );

    const driverUpdater = this.#driverUpdater;
    if (driverUpdater) {
      handle(IPC.driverUpdateCapabilities, () => driverUpdater.capabilities());
      handle(IPC.driverUpdateOpenNvidiaApp, () =>
        driverUpdater.openNvidiaApp(),
      );
      handle(IPC.driverUpdateOpenDownload, () =>
        driverUpdater.openOfficialDownload(),
      );
      handle(IPC.driverUpdateOpenGuide, () => driverUpdater.openGuide());
      handle(IPC.driverUpdateInstallState, () => driverUpdater.installState());
      handle(IPC.driverUpdateStartInstall, (request) =>
        driverUpdater.startInstall(driverInstallRequestInput.parse(request)),
      );
      handle(IPC.driverUpdateClearState, () => {
        driverUpdater.clearInstallState();
      });
    }

    const push = (): void => {
      windows.webContents()?.send(IPC.computerStatusEvent, status());
    };
    const pushSettings = (): void => {
      windows.webContents()?.send(IPC.settingsEvent, settings());
    };
    this.#unsubscribe.push(
      ctx.bus.on("computer.connection", push),
      ctx.bus.on("runtime.state", push),
      ctx.bus.on("runtime.activity", push),
      ctx.bus.on("power.changed", () => {
        push();
        pushSettings();
      }),
      ctx.bus.on("computer.renamed", pushSettings),
      ctx.bus.on("computer.changed", push),
      ctx.bus.on("update.changed", () =>
        windows
          .webContents()
          ?.send(IPC.updateStateEvent, updateView(updater.state())),
      ),
      ...(driverUpdater
        ? [
            ctx.bus.on("driver-update.changed", () =>
              windows
                .webContents()
                ?.send(
                  IPC.driverUpdateInstallStateEvent,
                  driverUpdater.installState(),
                ),
            ),
          ]
        : []),
    );
  }

  async stop(): Promise<void> {
    for (const off of this.#unsubscribe.splice(0)) off();
  }
}
