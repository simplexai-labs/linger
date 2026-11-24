import { minNvidiaDriverForCuda } from "@linger/service-kit/nvidia-driver";
import { contextBridge, ipcRenderer } from "electron";

import {
  INKLING_2_MINI_ANNOUNCEMENT_URL,
  NVIDIA_DRIVER_DOWNLOAD_URL,
  NVIDIA_DRIVER_GUIDE_URL,
  SETUP_IPC,
  type SetupState,
  type LingerSetupApi,
} from "../shared/setup.js";

// Sandboxed preload for the local setup page only.
const api: LingerSetupApi = {
  featuredAnnouncementUrl: INKLING_2_MINI_ANNOUNCEMENT_URL,
  nvidiaDriverDownloadUrl: NVIDIA_DRIVER_DOWNLOAD_URL,
  nvidiaDriverGuideUrl: NVIDIA_DRIVER_GUIDE_URL,
  minDriverForCuda: (requiredCuda) => minNvidiaDriverForCuda(requiredCuda),
  getState: () => ipcRenderer.invoke(SETUP_IPC.state),
  onState: (callback) => {
    const listener = (_event: unknown, state: SetupState): void =>
      callback(state);
    ipcRenderer.on(SETUP_IPC.stateEvent, listener);
    return () => ipcRenderer.off(SETUP_IPC.stateEvent, listener);
  },
  run: (command) => ipcRenderer.invoke(SETUP_IPC.run, command),
};

contextBridge.exposeInMainWorld("lingerSetup", api);
