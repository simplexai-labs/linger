import type {
  DesktopDriverActionResult,
  DesktopDriverCapabilities,
  DesktopDriverInstallRequest,
  DesktopDriverInstallState,
} from "@linger/service-kit/nvidia-driver";
import { useEffect, useState } from "react";

export interface DesktopDriverUpdateApi {
  getCapabilities(): Promise<DesktopDriverCapabilities>;
  openNvidiaApp(): Promise<DesktopDriverActionResult>;
  openOfficialDownload(): Promise<DesktopDriverActionResult>;
  openGuide(): Promise<DesktopDriverActionResult>;
  getInstallState(): Promise<DesktopDriverInstallState>;
  onInstallState(
    callback: (state: DesktopDriverInstallState) => void,
  ): () => void;
  startInstall(
    request: DesktopDriverInstallRequest,
  ): Promise<DesktopDriverActionResult>;
  clearInstallState?(): Promise<void>;
}

/**
 * The desktop app's native NVIDIA driver update bridge
 * (`window.lingerDesktop.driverUpdate`), or undefined in a browser or older
 * desktop release.
 */
export function desktopDriverUpdate(): DesktopDriverUpdateApi | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window as { lingerDesktop?: { driverUpdate?: DesktopDriverUpdateApi } })
        .lingerDesktop?.driverUpdate;
}

export interface DesktopDriverBridge {
  readonly api: DesktopDriverUpdateApi;
  readonly capabilities: DesktopDriverCapabilities | undefined;
  readonly installState: DesktopDriverInstallState;
}

const IDLE_STATE: DesktopDriverInstallState = { phase: "idle" };

/**
 * Reads native driver-update capabilities and subscribes to live install state
 * when the current view is running inside Linger Desktop for this Computer.
 */
export function useDesktopDriverUpdate(
  enabled: boolean,
): DesktopDriverBridge | undefined {
  const api = enabled ? desktopDriverUpdate() : undefined;
  const [capabilities, setCapabilities] = useState<DesktopDriverCapabilities>();
  const [installState, setInstallState] =
    useState<DesktopDriverInstallState>(IDLE_STATE);

  useEffect(() => {
    if (!api) return;
    let active = true;
    void api
      .getCapabilities()
      .then((next) => {
        if (active) setCapabilities(next);
      })
      .catch(() => undefined);
    void api
      .getInstallState()
      .then((next) => {
        if (active) setInstallState(next);
      })
      .catch(() => undefined);
    const unsubscribe = api.onInstallState((next) => {
      if (active) setInstallState(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

  return api ? { api, capabilities, installState } : undefined;
}
