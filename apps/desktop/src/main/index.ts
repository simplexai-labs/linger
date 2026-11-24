import { existsSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Notification,
  app,
  desktopCapturer,
  dialog,
  powerMonitor,
  powerSaveBlocker,
  session,
  shell,
  systemPreferences,
} from "electron";

import { lingerHome } from "@linger/local-installation/home";

import { quitRequested } from "./app-window.js";
import { CredentialStore } from "./computer-credential.js";
import {
  ComputerDaemonModule,
  protectWithDaemon,
  spawnDaemon,
} from "./computer-daemon.js";
import { ConfigStore } from "./config.js";
import { DesktopIpcModule } from "./desktop-ipc.js";
import { dialogMessages } from "./dialogs.messages.js";
import { DiagnosticsModule } from "./diagnostics.js";
import { DriverUpdater } from "./driver-updater.js";
import {
  detectWindowsNvidiaGpuName,
  runWindowsDriverInstaller,
  verifyWindowsAuthenticode,
} from "./windows-driver-platform.js";
import { EnrollmentModule } from "./enrollment.js";
import { LanguageModule } from "./language.js";
import {
  LocalServerModule,
  signInWithPassword,
  type SourceArchive,
  type SourceDependencies,
} from "./local-server.js";
import { defaultBridgeStateDirectory } from "./legacy-bridge.js";
import {
  migrateLegacyComputer,
  retireLegacyBridge,
} from "./legacy-migration.js";
import { fileLogger, type Logger } from "./log.js";
import { MacPermissions } from "./mac-permissions.js";
import { EventBus, ModuleHost, type Module } from "./modules.js";
import { parseServerUrl } from "./navigation.js";
import { openWithXdg } from "./open-url.js";
import { PowerGuardModule, type PowerApi } from "./power-guard.js";
import { SetupWindowModule } from "./setup-window.js";
import { loginShellEnvironment, withLoginShell } from "./shell-env.js";
import { markStartMenuShortcut } from "./start-menu-shortcut.js";
import { StatusModule } from "./status.js";
import { SystemPermissions } from "./system-permissions.js";
import { TrayModule } from "./tray.js";
import { updateNotice } from "./tray-menu.js";
import { UpdaterModule, updateInstallFor } from "./updater.js";
import { WindowManagerModule, registerAppScheme } from "./window-manager.js";
import { WorkspaceGrantsModule } from "./workspace-grants.js";

declare const __DESKTOP_VERSION__: string;
declare const __SOURCE_ARCHIVE__: SourceArchive | null;
declare const __SOURCE_DEPENDENCIES__: SourceDependencies | null;
const VERSION = __DESKTOP_VERSION__;
const here = path.dirname(fileURLToPath(import.meta.url));

let userDataMove: UserDataMove | undefined;
// Development overrides; installed builds use the platform defaults.
if (process.env.LINGER_DESKTOP_USER_DATA)
  app.setPath("userData", path.resolve(process.env.LINGER_DESKTOP_USER_DATA));
// The installed app's data folder holds the Computer's credential, identity
// and enrollment. Installs from before the rename move theirs here once.
else if (app.isPackaged) {
  const userData = path.join(app.getPath("appData"), "Linger");
  try {
    userDataMove = moveLegacyUserData(
      path.join(app.getPath("appData"), "Simplex"),
      userData,
    );
  } catch (error) {
    dialog.showErrorBox(
      "Linger could not start",
      `Could not move the app data folder to ${userData}: ${error instanceof Error ? error.message : String(error)}`,
    );
    app.exit(1);
  }
  app.setPath("userData", userData);
}

// Windows shows notifications only for an app id that a Start menu shortcut
// carries. The installer makes the shortcut; the app writes the id into it.
const APP_USER_MODEL_ID = "com.simplexai.linger.desktop.preview";
if (process.platform === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);

// `--quit` (the uninstaller) asks a running Linger to quit, and starts
// nothing when none runs.
if (!app.requestSingleInstanceLock() || quitRequested(process.argv)) {
  app.quit();
} else {
  registerAppScheme();
  void app.whenReady().then(main);
}

async function main(): Promise<void> {
  const readyAt = Math.round(process.uptime() * 1000);
  const userData = app.getPath("userData");
  const log = fileLogger(path.join(userData, "logs"), {
    stderr: !app.isPackaged,
  });
  if (userDataMove?.outcome === "kept")
    log.warn("desktop.legacy_user_data_kept", {
      legacy: userDataMove.legacy,
      user_data: userDataMove.userData,
    });
  else if (userDataMove)
    log.info("desktop.legacy_user_data_moved", {
      legacy: userDataMove.legacy,
      user_data: userDataMove.userData,
      ...(userDataMove.setAside ? { set_aside: userDataMove.setAside } : {}),
    });
  if (process.platform === "win32" && app.isPackaged)
    markStartMenuShortcut({
      appData: app.getPath("appData"),
      execPath: process.execPath,
      appUserModelId: APP_USER_MODEL_ID,
      env: process.env,
      readShortcutLink: (shortcut) => shell.readShortcutLink(shortcut),
      writeShortcutLink: (shortcut, operation, options) =>
        shell.writeShortcutLink(shortcut, operation, options),
      onWriteError: (error) =>
        log.warn("desktop.start_menu_shortcut_failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
    });
  const background = process.argv.includes("--background");
  const envServer = parseServerUrl(process.env.LINGER_SERVER_URL ?? "");
  const config = new ConfigStore(
    path.join(userData, "config.json"),
    envServer ? { serverUrl: envServer } : {},
  );
  const defaultDisplayName = os.hostname();
  const daemonDirectory = path.join(userData, "computer");
  const credentials = new CredentialStore(
    path.join(daemonDirectory, "credential.json"),
  );
  // Earlier versions ran agents through the bridge and runtime-host.
  await retireLegacyBridge(defaultBridgeStateDirectory(), VERSION, log);
  migrateLegacyComputer(
    {
      bridgeStateDirectory: defaultBridgeStateDirectory(),
      runtimeDirectory: path.join(userData, "runtime"),
      daemonStateDirectory: path.join(daemonDirectory, "state"),
    },
    config,
    credentials,
    log,
  );

  // The default LINGER_HOME of the installer.
  const home = lingerHome();
  // The cookie header of the window's session for a server.
  const webSessionCookie = async (
    serverUrl: string,
  ): Promise<string | undefined> => {
    const cookies = await session.defaultSession.cookies.get({
      url: serverUrl,
    });
    return cookies.length > 0
      ? cookies.map((c) => `${c.name}=${c.value}`).join("; ")
      : undefined;
  };
  const localServer = new LocalServerModule({
    home,
    daemonDirectory,
    version: VERSION,
    macosVersion: () => process.getSystemVersion(),
    installerDirectory: path.join(here, "../installer"),
    ...(__SOURCE_ARCHIVE__ ? { sourceArchive: __SOURCE_ARCHIVE__ } : {}),
    ...(__SOURCE_DEPENDENCIES__
      ? { sourceDependencies: __SOURCE_DEPENDENCIES__ }
      : {}),
    // Developers install their own linger checkout instead.
    ...(process.env.LINGER_CHECKOUT
      ? { checkout: process.env.LINGER_CHECKOUT }
      : {}),
    // The window's session is the default one, which enrollment reads too.
    signIn: (server, email, password) =>
      signInWithPassword(server, email, password, (cookie) =>
        session.defaultSession.cookies.set({ url: server.origin, ...cookie }),
      ),
    sessionCookie: webSessionCookie,
    // On Linux the sign-in needs to know when no browser opened.
    openExternal: (url) =>
      process.platform === "linux" ? openWithXdg(url) : shell.openExternal(url),
    // The system proxy (fixed or PAC) the voice services reach Soniox with.
    resolveProxy: (url) => session.defaultSession.resolveProxy(url),
  });
  // Until this computer is connected, the setup window comes first.
  const needsSetup = !config.get().computerId;
  const windows = new WindowManagerModule({
    preload: path.join(here, "../preload/index.cjs"),
    shellPreload: path.join(here, "../preload/shell.cjs"),
    background: background || needsSetup,
    localServerResumable: (url) => localServer.isStarting(url),
  });
  const openExternal = (url: string): Promise<void> =>
    process.platform === "linux" ? openWithXdg(url) : shell.openExternal(url);
  const bus = new EventBus();
  const driverUpdater = new DriverUpdater({
    platform: process.platform as "darwin" | "win32" | "linux",
    arch: process.arch,
    existsSync,
    env: process.env,
    launchExecutable: async (executablePath) => {
      const error = await shell.openPath(executablePath);
      if (error) throw new Error(error);
    },
    openExternal,
    onStateChange: () => bus.emit("driver-update.changed"),
    onBusyChange: (busy) => bus.emit("driver-update.busy", busy),
    ...(process.platform === "win32" && process.arch === "x64"
      ? {
          directInstall: {
            downloadDirectory: path.join(userData, "driver-updates"),
            detectGpuName: detectWindowsNvidiaGpuName,
            verifyAuthenticode: verifyWindowsAuthenticode,
            runInstaller: runWindowsDriverInstaller,
            readPendingUpdate: () => config.get().pendingDriverUpdate,
            writePendingUpdate: (record) => {
              config.update({ pendingDriverUpdate: record });
            },
            systemUptimeSeconds: () => os.uptime(),
          },
        }
      : {}),
  });
  const setup = new SetupWindowModule({
    preload: path.join(here, "../preload/setup.cjs"),
    version: VERSION,
    defaultDisplayName,
    show: !background && needsSetup,
    loginItem: {
      get: () => app.getLoginItemSettings().openAtLogin,
      set: (on) =>
        app.setLoginItemSettings({ openAtLogin: on, args: ["--background"] }),
    },
    driverUpdater,
    ...(process.platform === "darwin"
      ? {
          permissions: new MacPermissions({
            home: app.getPath("home"),
            asked: () => config.get().permissionsAsked,
            markAsked: (id) => {
              const asked = config.get().permissionsAsked;
              if (!asked.includes(id))
                config.update({ permissionsAsked: [...asked, id] });
            },
          }),
        }
      : {}),
  });
  const language = new LanguageModule({
    systemLanguages: () => app.getPreferredSystemLanguages(),
  });
  const status = new StatusModule();
  // Set once the bundle was swapped, so quitting relaunches the new version.
  let relaunch = false;
  // Set once the setup program of an update runs; it starts the new version.
  let updating = false;
  const updater = new UpdaterModule({
    version: VERSION,
    platform: process.platform,
    arch: process.arch,
    install: app.isPackaged
      ? updateInstallFor(process.platform, process.execPath, existsSync)
      : undefined,
    downloadDirectory: path.join(userData, "updates"),
    announce: (state) => {
      if (!Notification.isSupported()) return;
      const notice = new Notification(updateNotice(state, language.t));
      notice.on("click", () => void updater.install());
      notice.show();
    },
    restart: async () => {
      relaunch = true;
      app.quit();
    },
    quit: async () => {
      updating = true;
      app.quit();
    },
    openExternal: (url) => shell.openExternal(url),
  });
  // The app's own macOS permissions, which the daemon asks about over stdio
  // and the page acts on over IPC.
  const desktopPermissions =
    process.platform === "darwin"
      ? {
          permissions: new SystemPermissions({
            screenAccessStatus: () =>
              systemPreferences.getMediaAccessStatus("screen"),
            isTrustedAccessibilityClient: (prompt) =>
              systemPreferences.isTrustedAccessibilityClient(prompt),
            captureScreens: () =>
              desktopCapturer.getSources({
                types: ["screen"],
                thumbnailSize: { width: 0, height: 0 },
              }),
            openExternal: (url) => shell.openExternal(url),
          }),
          openExternal: (url: string) => shell.openExternal(url),
          // The same quit and relaunch path an installed update takes.
          relaunch: () => {
            relaunch = true;
            app.quit();
          },
        }
      : undefined;
  const modules: Module[] = [
    {
      name: "Config",
      dependsOn: [],
      start: async () => {},
      stop: async () => {},
    },
    language,
    new EnrollmentModule({
      defaultDisplayName,
      credentials,
      daemonIdentityFile: path.join(
        daemonDirectory,
        "state",
        "daemon-identity.json",
      ),
      sessionCookie: webSessionCookie,
    }),
    new WorkspaceGrantsModule({
      pickDirectory: async () => {
        const result = await dialog.showOpenDialog({
          properties: ["openDirectory", "createDirectory"],
        });
        return result.canceled ? undefined : result.filePaths[0];
      },
      defaultDirectory: path.join(app.getPath("home"), "Linger"),
    }),
    new ComputerDaemonModule({
      spawn: spawnDaemon(
        daemonExecutable(),
        path.join(userData, "logs", "computer-daemon.log"),
      ),
      credentials,
      directory: daemonDirectory,
      // The bundled teamhub CLI, run by the app's own Node, so runtimes reply
      // with a matching version and the computer needs no Node.
      teamhubCliDirectory: path.join(here, "../teamhub-cli"),
      defaultDisplayName,
      env: daemonEnv(log),
      ...(process.platform === "win32"
        ? { protect: protectWithDaemon(daemonExecutable()) }
        : {}),
      ...desktopPermissions,
    }),
    status,
    new PowerGuardModule(electronPower()),
    windows,
    localServer,
    new DiagnosticsModule({
      userData,
      logs: path.join(userData, "logs"),
      home,
      version: VERSION,
      output: () => app.getPath("downloads"),
      openFolder: (folder) => shell.openPath(folder),
      showFile: (file) => shell.showItemInFolder(file),
      outbox: path.join(userData, "diagnostics-outbox"),
    }),
    setup,
    updater,
    new TrayModule({ quit: () => void quit() }),
    new DesktopIpcModule({
      defaultDisplayName,
      ...(desktopPermissions ? { permissions: desktopPermissions } : {}),
      driverUpdater,
    }),
  ];
  const host = new ModuleHost(modules, { config, log, bus });

  const showApp = (): void => setup.showApp();
  // The uninstaller, or setup replacing this release, asked to quit.
  let replacing = false;
  app.on("second-instance", (_event, argv) => {
    // Without asking: the uninstaller is removing the app.
    if (quitRequested(argv)) {
      replacing = true;
      app.quit();
    } else showApp();
  });
  app.on("activate", showApp);
  // Closing the window only hides it; the tray keeps the app running.
  app.on("window-all-closed", () => {});
  let quitting = false;
  app.on("before-quit", (event) => {
    windows.prepareQuit();
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    // Setup and the uninstaller stop the services and the local models
    // themselves right after --quit; a stop from here would race theirs.
    void host
      .stop(relaunch || updating || replacing ? "update" : "quit")
      .finally(() => {
        if (relaunch) app.relaunch();
        app.exit(0);
      });
  });

  // Tasks run in the app, so quitting takes the computer offline; ask first
  // only when that cancels running tasks.
  const quit = async (): Promise<void> => {
    if (status.current().tone === "busy") {
      const { response } = await dialog.showMessageBox({
        type: "warning",
        buttons: [
          language.t(dialogMessages.quitAndStop),
          language.t(dialogMessages.cancel),
        ],
        defaultId: 1,
        cancelId: 1,
        message: language.t(dialogMessages.quitConfirm),
        detail: language.t(dialogMessages.quitConfirmDetail),
      });
      if (response !== 0) return;
    }
    app.quit();
  };

  try {
    await host.start();
    // Uptime since process start, to see where launch time goes.
    log.info("desktop.started", {
      version: VERSION,
      background,
      readyMs: readyAt,
      startedMs: Math.round(process.uptime() * 1000),
    });
  } catch (error) {
    log.error("desktop.start_failed", { error: String(error) });
    dialog.showErrorBox(
      "Linger",
      language.t(dialogMessages.startFailed, { error: String(error) }),
    );
    app.exit(1);
  }
}

// LINGER_COMPUTER_DAEMON overrides the daemon for development. Packaged
// builds ship it under resources/computer; development builds it into
// dist/computer/<platform>-<arch>.
function daemonExecutable(): string {
  const name =
    process.platform === "win32"
      ? "linger-computer-daemon.exe"
      : "linger-computer-daemon";
  if (process.env.LINGER_COMPUTER_DAEMON)
    return path.resolve(process.env.LINGER_COMPUTER_DAEMON);
  return app.isPackaged
    ? path.join(process.resourcesPath, "computer", name)
    : path.join(
        here,
        "../computer",
        `${process.platform}-${process.arch}`,
        name,
      );
}

function electronPower(): PowerApi {
  return {
    block: () => powerSaveBlocker.start("prevent-app-suspension"),
    unblock: (id) => powerSaveBlocker.stop(id),
    onPowerEvent: (listener) => {
      const suspend = (): void => listener("suspend");
      const resume = (): void => listener("resume");
      powerMonitor.on("suspend", suspend);
      powerMonitor.on("resume", resume);
      return () => {
        powerMonitor.off("suspend", suspend);
        powerMonitor.off("resume", resume);
      };
    },
  };
}

// The user's terminal environment, which runtimes inherit, without the app's
// own control variables. The runtime paths stay for the daemon config; the
// daemon keeps LINGER_* from runtimes.
async function daemonEnv(log: Logger): Promise<Record<string, string>> {
  const started = Date.now();
  const login = await loginShellEnvironment();
  log.info("computer_daemon.login_shell", {
    resolved: login !== undefined,
    duration_ms: Date.now() - started,
  });
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(
    withLoginShell(process.env as Record<string, string>, login),
  )) {
    if (value === undefined || /^(ELECTRON_|LINGER_)/i.test(name)) continue;
    env[name] = value;
  }
  for (const name of [
    "LINGER_CODEX_PATH",
    "LINGER_CLAUDE_PATH",
    "LINGER_PI_PATH",
  ]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

interface UserDataMove {
  readonly outcome: "moved" | "kept";
  readonly legacy: string;
  readonly userData: string;
  /** Where a Linger folder without a Computer credential was set aside. */
  readonly setAside?: string;
}

// The data folder of the app as it was named before the rename moves once to
// its Linger name. A Linger folder that already holds a Computer credential
// wins and the old one stays; one without a credential is set aside, so the
// Computer keeps its identity instead of enrolling again under a new id.
function moveLegacyUserData(
  legacy: string,
  userData: string,
): UserDataMove | undefined {
  if (!existsSync(legacy)) return undefined;
  if (existsSync(path.join(userData, "computer", "credential.json")))
    return { outcome: "kept", legacy, userData };
  let setAside: string | undefined;
  if (existsSync(userData)) {
    setAside = `${userData}.before-move-${Date.now()}`;
    renameSync(userData, setAside);
  }
  renameSync(legacy, userData);
  return {
    outcome: "moved",
    legacy,
    userData,
    ...(setAside ? { setAside } : {}),
  };
}
