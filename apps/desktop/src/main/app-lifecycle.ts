import type { Logger } from "./log.js";
import type { StopReason } from "./modules.js";

export interface ShutdownControllerOptions {
  readonly prepareQuit: () => void;
  // Synchronously starts detached local-models teardown during OS session end
  // (Windows WM_ENDSESSION) before the OS can terminate the process.
  readonly stopLocalModelsNow: () => void;
  readonly stopHost: (reason: StopReason) => Promise<void>;
  readonly destroySessionWindow?: () => void;
  readonly relaunch: () => void;
  readonly exit: (code: number) => void;
  readonly log: Logger;
}

// Coordinates Electron quit, update/relaunch handoffs, and OS session-end /
// logoff shutdowns so local models stop cleanly on user quit and OS logoff
// while staying warm across updates and relaunches.
export class DesktopShutdownController {
  readonly #options: ShutdownControllerOptions;
  #quitting = false;
  #relaunch = false;
  #updating = false;
  #replacing = false;

  constructor(options: ShutdownControllerOptions) {
    this.#options = options;
  }

  markRelaunch(): void {
    this.#relaunch = true;
  }

  markUpdating(): void {
    this.#updating = true;
  }

  markReplacing(): void {
    this.#replacing = true;
  }

  onBeforeQuit(event: { preventDefault(): void }): void {
    this.#options.prepareQuit();
    // Always hold Electron's quit until our active teardown calls exit(0),
    // even if a second before-quit arrives while shutdown is already running.
    event.preventDefault();
    if (this.#quitting) return;
    this.#quitting = true;
    // Setup and the uninstaller stop the services and the local models
    // themselves right after --quit; a stop from here would race theirs.
    const reason: StopReason =
      this.#relaunch || this.#updating || this.#replacing ? "update" : "quit";
    void this.#options.stopHost(reason).finally(() => {
      this.#options.destroySessionWindow?.();
      if (this.#relaunch) this.#options.relaunch();
      this.#options.exit(0);
    });
  }

  // Handles Windows session-end (WM_ENDSESSION), where Electron never emits
  // before-quit. Spawns detached local-models teardown synchronously before
  // awaiting module teardown so Windows cannot terminate the app before the
  // stop helper launches.
  onSessionEnd(reasons?: readonly string[]): void {
    this.#options.prepareQuit();
    if (this.#quitting) return;
    this.#quitting = true;
    this.#options.log.info("desktop.session_end", {
      ...(reasons && reasons.length > 0 ? { reasons: [...reasons] } : {}),
    });
    this.#options.stopLocalModelsNow();
    void this.#options.stopHost("logout").finally(() => {
      this.#options.destroySessionWindow?.();
      this.#options.exit(0);
    });
  }
}
