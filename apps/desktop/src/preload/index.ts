import { contextBridge, ipcRenderer } from "electron";

import {
  IPC,
  type ComputerStatus,
  type DesktopDriverInstallState,
  type DesktopSettings,
  type DesktopUpdateState,
  type LingerDesktopApi,
  type PreviewViewState,
} from "../shared/api.js";

// Sandboxed preload: exposes only window.lingerDesktop, never ipcRenderer.
declare const __DESKTOP_VERSION__: string;

const api: LingerDesktopApi = {
  version: __DESKTOP_VERSION__,
  platform: process.platform as LingerDesktopApi["platform"],
  computer: {
    getStatus: () => ipcRenderer.invoke(IPC.computerStatus),
    onStatus: (callback) => {
      const listener = (_event: unknown, status: ComputerStatus): void =>
        callback(status);
      ipcRenderer.on(IPC.computerStatusEvent, listener);
      return () => {
        ipcRenderer.off(IPC.computerStatusEvent, listener);
      };
    },
    enroll: () => ipcRenderer.invoke(IPC.computerEnroll),
    unenroll: () => ipcRenderer.invoke(IPC.computerUnenroll),
  },
  workspace: {
    pick: () => ipcRenderer.invoke(IPC.workspacePick),
    list: () => ipcRenderer.invoke(IPC.workspaceList),
    revoke: (grantId) => ipcRenderer.invoke(IPC.workspaceRevoke, grantId),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
    onChange: (callback) => {
      const listener = (_event: unknown, settings: DesktopSettings): void =>
        callback(settings);
      ipcRenderer.on(IPC.settingsEvent, listener);
      return () => {
        ipcRenderer.off(IPC.settingsEvent, listener);
      };
    },
  },
  localAccount: {
    available: () => ipcRenderer.invoke(IPC.localAccountAvailable),
    signIn: () => ipcRenderer.invoke(IPC.localAccountSignIn),
  },
  localServer: {
    owned: () => ipcRenderer.invoke(IPC.localServerOwned),
  },
  update: {
    getState: () => ipcRenderer.invoke(IPC.updateState),
    onState: (callback) => {
      const listener = (_event: unknown, state: DesktopUpdateState): void =>
        callback(state);
      ipcRenderer.on(IPC.updateStateEvent, listener);
      return () => {
        ipcRenderer.off(IPC.updateStateEvent, listener);
      };
    },
    install: () => ipcRenderer.invoke(IPC.updateInstall),
    check: () => ipcRenderer.invoke(IPC.updateCheck),
  },
  connectorOAuth: {
    prepare: () => ipcRenderer.invoke(IPC.connectorOAuthPrepare),
    onReturn: (callback) => {
      const listener = (_event: unknown, account?: string): void =>
        callback(account);
      ipcRenderer.on(IPC.connectorOAuthReturn, listener);
      return () => ipcRenderer.off(IPC.connectorOAuthReturn, listener);
    },
  },
  preview: {
    onFrameRefused: (callback) => {
      const listener = (_event: unknown, name: string, url: string): void =>
        callback(name, url);
      ipcRenderer.on(IPC.previewFrameRefused, listener);
      return () => ipcRenderer.off(IPC.previewFrameRefused, listener);
    },
    view: {
      open: (id, url) => ipcRenderer.invoke(IPC.previewOpen, id, url),
      place: (id, bounds) => ipcRenderer.invoke(IPC.previewPlace, id, bounds),
      hide: (id) => ipcRenderer.invoke(IPC.previewHide, id),
      command: (id, command) =>
        ipcRenderer.invoke(IPC.previewCommand, id, command),
      close: (id) => ipcRenderer.invoke(IPC.previewClose, id),
      onState: (callback) => {
        const listener = (
          _event: unknown,
          id: string,
          state: PreviewViewState,
        ): void => callback(id, state);
        ipcRenderer.on(IPC.previewState, listener);
        return () => ipcRenderer.off(IPC.previewState, listener);
      },
    },
  },
  voiceWindow: {
    showMainWindow: () => ipcRenderer.invoke(IPC.voiceWindowShowMain),
  },
  language: {
    set: (language) => ipcRenderer.invoke(IPC.languageSet, language),
  },
  diagnostics: {
    save: () => ipcRenderer.invoke(IPC.diagnosticsSave),
  },
  driverUpdate: {
    getCapabilities: () => ipcRenderer.invoke(IPC.driverUpdateCapabilities),
    openNvidiaApp: () => ipcRenderer.invoke(IPC.driverUpdateOpenNvidiaApp),
    openOfficialDownload: () =>
      ipcRenderer.invoke(IPC.driverUpdateOpenDownload),
    openGuide: () => ipcRenderer.invoke(IPC.driverUpdateOpenGuide),
    getInstallState: () => ipcRenderer.invoke(IPC.driverUpdateInstallState),
    onInstallState: (callback) => {
      const listener = (
        _event: unknown,
        state: DesktopDriverInstallState,
      ): void => callback(state);
      ipcRenderer.on(IPC.driverUpdateInstallStateEvent, listener);
      return () => {
        ipcRenderer.off(IPC.driverUpdateInstallStateEvent, listener);
      };
    },
    startInstall: (request) =>
      ipcRenderer.invoke(IPC.driverUpdateStartInstall, request),
    clearInstallState: () => ipcRenderer.invoke(IPC.driverUpdateClearState),
  },
  ...(process.platform === "darwin"
    ? {
        permissions: {
          act: (step) => ipcRenderer.invoke(IPC.permissionAct, step),
        },
      }
    : {}),
};

contextBridge.exposeInMainWorld("lingerDesktop", api);

// On macOS the page runs under the traffic lights with no title bar; pages
// style html[data-desktop-chrome="inset"] to leave room and a drag region.
if (process.platform === "darwin") {
  // The root element may not exist yet when the preload runs.
  const mark = (): void =>
    document.documentElement?.setAttribute("data-desktop-chrome", "inset");
  mark();
  document.addEventListener("DOMContentLoaded", mark, { once: true });
}
