import type { ComputerDaemonModule } from "./computer-daemon.js";
import type { Module, ModuleContext } from "./modules.js";

// Electron's powerSaveBlocker and powerMonitor, injected for tests.
export interface PowerApi {
  block(): number;
  unblock(id: number): void;
  onPowerEvent(listener: (kind: "suspend" | "resume") => void): () => void;
}

// Keeps the system awake briefly after a background model call finishes so
// chained steps (such as multi-batch Wiki refreshes or Wiki -> Daily ->
// dreaming) do not sleep between calls.
export const MODEL_ACTIVITY_TAIL_MS = 3 * 60_000;

// Keeps the system awake while operations, background model invocations, or
// installations run, or in always-on mode. The daemon reconnects by itself
// after a resume.
export class PowerGuardModule implements Module {
  readonly name = "PowerGuard";
  readonly dependsOn = ["ComputerDaemon"];
  readonly #power: PowerApi;
  #ctx: ModuleContext | undefined;
  #running = 0;
  #modelInvokes = 0;
  #modelTail: NodeJS.Timeout | undefined;
  #installing = false;
  #updatingDriver = false;
  #blocker: number | undefined;
  #lastEmitted:
    | { readonly active: boolean; readonly alwaysOn: boolean }
    | undefined;
  readonly #unsubscribe: (() => void)[] = [];

  constructor(power: PowerApi) {
    this.#power = power;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    const daemon = ctx.get<ComputerDaemonModule>("ComputerDaemon");
    this.#running = daemon.running();
    this.#modelInvokes = daemon.modelInvokes();
    this.#unsubscribe.push(
      ctx.bus.on("runtime.activity", (running) => {
        this.#running = running;
        this.#apply();
      }),
      ctx.bus.on("runtime.model_activity", (modelInvokes) => {
        const previous = this.#modelInvokes;
        this.#modelInvokes = modelInvokes;
        if (modelInvokes > 0) this.#clearModelTail();
        else if (previous > 0) this.#armModelTail();
        this.#apply();
      }),
      ctx.bus.on("local-server.busy", (busy) => {
        this.#installing = busy;
        this.#apply();
      }),
      ctx.bus.on("driver-update.busy", (busy) => {
        this.#updatingDriver = busy;
        this.#apply();
      }),
      this.#power.onPowerEvent((kind) => {
        ctx.log.info("power.event", { kind });
      }),
    );
    this.#apply();
  }

  async stop(): Promise<void> {
    for (const off of this.#unsubscribe.splice(0)) off();
    this.#clearModelTail();
    this.#release();
  }

  alwaysOn(): boolean {
    return this.#ctx!.config.get().preventSleep;
  }

  setAlwaysOn(on: boolean): void {
    this.#ctx!.config.update({ preventSleep: on });
    this.#apply();
  }

  active(): boolean {
    return this.#blocker !== undefined;
  }

  #armModelTail(): void {
    this.#clearModelTail();
    this.#modelTail = setTimeout(() => {
      this.#modelTail = undefined;
      this.#apply();
    }, MODEL_ACTIVITY_TAIL_MS);
    this.#modelTail.unref?.();
  }

  #clearModelTail(): void {
    if (!this.#modelTail) return;
    clearTimeout(this.#modelTail);
    this.#modelTail = undefined;
  }

  #apply(): void {
    const alwaysOn = this.alwaysOn();
    const want =
      alwaysOn ||
      this.#running > 0 ||
      this.#modelInvokes > 0 ||
      this.#modelTail !== undefined ||
      this.#installing ||
      this.#updatingDriver;
    if (want && this.#blocker === undefined) {
      this.#blocker = this.#power.block();
      this.#ctx!.log.info("power.blocking", {
        running: this.#running,
        model_invokes: this.#modelInvokes,
        installing: this.#installing,
        updating_driver: this.#updatingDriver,
      });
    } else if (!want) {
      this.#release();
    }
    const active = this.active();
    if (
      this.#lastEmitted?.active === active &&
      this.#lastEmitted.alwaysOn === alwaysOn
    )
      return;
    this.#lastEmitted = { active, alwaysOn };
    this.#ctx!.bus.emit("power.changed");
  }

  #release(): void {
    if (this.#blocker === undefined) return;
    this.#power.unblock(this.#blocker);
    this.#blocker = undefined;
    this.#ctx?.log.info("power.released");
  }
}
