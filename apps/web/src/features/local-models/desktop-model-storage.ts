import { localModelsMessages as m } from "./local-models.messages";

export type DesktopModelStorageErrorCode =
  | "NOT_AVAILABLE"
  | "NOT_FOUND"
  | "OUTSIDE_ROOT"
  | "INVALID_PATH"
  | "OPEN_FAILED";

export type DesktopModelStorageActionResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: DesktopModelStorageErrorCode;
      readonly message?: string;
    };

export interface DesktopModelStorageApi {
  openFolder(): Promise<DesktopModelStorageActionResult>;
  revealPath(targetPath: string): Promise<DesktopModelStorageActionResult>;
}

export type DesktopPlatform = "darwin" | "win32" | "linux";

interface WindowWithDesktopStorage {
  lingerDesktop?: {
    platform?: DesktopPlatform;
    localModelsStorage?: DesktopModelStorageApi;
  };
}

/**
 * The desktop app's scoped local-model storage opener
 * (`window.lingerDesktop.localModelsStorage`), or undefined in a browser or
 * older desktop release.
 */
export function desktopModelStorage(): DesktopModelStorageApi | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window as WindowWithDesktopStorage).lingerDesktop?.localModelsStorage;
}

/** Platform reported by the running Linger Desktop shell, if any. */
export function desktopPlatform(): DesktopPlatform | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window as WindowWithDesktopStorage).lingerDesktop?.platform;
}

/** Message descriptor for opening the top-level model storage folder. */
export function openFolderMessage(platform: DesktopPlatform | undefined) {
  switch (platform) {
    case "darwin":
      return m.storageOpenInFinder;
    case "win32":
      return m.storageOpenInFileExplorer;
    default:
      return m.storageOpenFolder;
  }
}

/** Message descriptor for revealing a specific model file or subfolder. */
export function revealFileMessage(platform: DesktopPlatform | undefined) {
  switch (platform) {
    case "darwin":
      return m.storageShowInFinder;
    case "win32":
      return m.storageShowInFileExplorer;
    default:
      return m.storageShowInFolder;
  }
}
