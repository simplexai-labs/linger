import type {
  IMessageAction,
  IMessageBridgeState,
  IMessagePatch,
  IMessageRuntimeError,
  IMessageRuntimeState,
  IMessageSetResult,
  IMessageStatus,
} from "../shared/api.js";
import { IMessageHandlesError, normalizeIMessageHandles } from "./config.js";
import type { IMessageChecks } from "./imessage-permissions.js";
import { IMsgRuntimeError } from "./imsg-runtime.js";
import { SETTINGS_URL } from "./mac-permissions.js";
import type { ChannelStateReset } from "./imessage-state.js";
import type { Module, ModuleContext } from "./modules.js";

export interface IMessageModuleOptions {
  readonly runtime: {
    installed(): Promise<boolean>;
    ensure(): Promise<string>;
    executable(): string;
  };
  readonly permissions: {
    checks(): Promise<IMessageChecks>;
    requestAutomation(): Promise<void>;
  };
  readonly openExternal: (url: string) => Promise<void>;
  // Builds the bridge for these handles; it reports its state through
  // `onState`.
  readonly createBridge: (input: {
    handles: readonly string[];
    executable: string;
    onState: (state: Exclude<IMessageBridgeState, "stopped">) => void;
  }) => IMessageBridge;
  // The bridge's stored cursors and reply target; changed only while no
  // bridge runs.
  readonly channelState: ChannelStateReset;
}

export interface IMessageBridge {
  start(): void;
  stop(): Promise<void>;
}

const UNCHECKED: IMessageChecks = {
  fullDisk: "unknown",
  messagesAutomation: "unknown",
  iMessageSignedIn: "unknown",
};

// The iMessage channel's settings, the imsg runtime and the macOS checks it
// needs, as one status view for the page.
export class IMessageModule implements Module {
  readonly name = "IMessage";
  readonly dependsOn: readonly string[] = [];
  readonly #options: IMessageModuleOptions;
  #ctx: ModuleContext | undefined;
  #runtime: IMessageRuntimeState = "missing";
  #runtimeError: IMessageRuntimeError | undefined;
  #checks: IMessageChecks = UNCHECKED;
  #probing: Promise<IMessageStatus> | undefined;
  #last = "";
  #bridge: IMessageBridge | undefined;
  #bridgeHandles = "";
  #bridgeState: IMessageBridgeState = "stopped";
  // Starts and stops run one after another.
  #bridgeChange: Promise<void> = Promise.resolve();
  readonly #unsubscribe: (() => void)[] = [];
  #stopped = false;
  // What the next stop must forget: the reply target after new handles, or
  // everything after the switch was turned off.
  #forget: "none" | "target" | "all" = "none";

  constructor(options: IMessageModuleOptions) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    const restartOnServerChange = (): void => {
      if (!this.#bridgeHandles) return;
      this.#bridgeHandles = "";
      this.#syncBridge();
    };
    this.#unsubscribe.push(
      // A server change or local port move drops the old connection and
      // reconnects against the active server and signed-in account.
      ctx.bus.on("server.changed", restartOnServerChange),
      ctx.bus.on("server.moved", restartOnServerChange),
    );
    this.#runtime = (await this.#options.runtime.installed())
      ? "ready"
      : "missing";
    this.#publish();
    // An app update can pin a newer imsg, so an enabled channel installs it.
    if (ctx.config.get().imessage.enabled) this.#install();
    this.refresh().catch((error: unknown) =>
      ctx.log.warn("imessage.check_failed", { error: String(error) }),
    );
  }

  async stop(): Promise<void> {
    for (const off of this.#unsubscribe.splice(0)) off();
    this.#stopped = true;
    this.#bridgeChange = this.#bridgeChange.then(() => this.#stopBridge());
    await this.#bridgeChange;
  }

  status(): IMessageStatus {
    const { enabled, handles } = this.#ctx!.config.get().imessage;
    const checks = this.#checks;
    return {
      enabled,
      handles,
      runtime: this.#runtime,
      ...(this.#runtimeError ? { runtimeError: this.#runtimeError } : {}),
      ...checks,
      ready: this.#ready(),
      bridge: this.#bridgeState,
    };
  }

  #ready(): boolean {
    const { enabled, handles } = this.#ctx!.config.get().imessage;
    const checks = this.#checks;
    return (
      enabled &&
      this.#runtime === "ready" &&
      checks.fullDisk === "granted" &&
      checks.messagesAutomation === "granted" &&
      checks.iMessageSignedIn === "yes" &&
      handles.length > 0
    );
  }

  // Starting needs every check passed; only a clear negative stops a
  // running bridge, so a check that could not answer this time (`unknown`,
  // e.g. an osascript timeout) keeps the previous decision.
  #shouldRun(): boolean {
    const { enabled, handles } = this.#ctx!.config.get().imessage;
    const checks = this.#checks;
    if (
      !enabled ||
      handles.length === 0 ||
      this.#runtime !== "ready" ||
      checks.fullDisk === "denied" ||
      checks.fullDisk === "messagesNotSetUp" ||
      checks.messagesAutomation === "denied" ||
      checks.iMessageSignedIn === "no"
    )
      return false;
    return this.#ready() || this.#bridgeHandles !== "";
  }

  // Runs the bridge while the channel should run, with the current
  // handles.
  #syncBridge(): void {
    const create = this.#options.createBridge;
    if (this.#stopped) return;
    const want = this.#shouldRun()
      ? JSON.stringify(this.#ctx!.config.get().imessage.handles)
      : "";
    if (want === this.#bridgeHandles) return;
    this.#bridgeHandles = want;
    this.#bridgeChange = this.#bridgeChange.then(async () => {
      await this.#stopBridge();
      this.#resetChannelState();
      if (!want || want !== this.#bridgeHandles) return;
      const ctx = this.#ctx!;
      const bridge = create({
        handles: ctx.config.get().imessage.handles,
        executable: this.#options.runtime.executable(),
        onState: (state) => {
          if (this.#bridge !== bridge) return;
          this.#bridgeState = state;
          this.#publish();
        },
      });
      this.#bridge = bridge;
      ctx.log.info("imessage.bridge_started", {});
      bridge.start();
    });
  }

  // Runs only between a stop and the next start.
  #resetChannelState(): void {
    const reset = this.#options.channelState;
    const { enabled } = this.#ctx!.config.get().imessage;
    try {
      if (!enabled && this.#forget !== "none") {
        // Off and on again starts at the current ends: no backlog either way.
        reset.clear();
        this.#ctx!.log.info("imessage.channel_state_cleared", {});
      } else if (this.#forget === "target") reset.resetTarget();
      this.#forget = "none";
    } catch (error) {
      this.#ctx!.log.warn("imessage.channel_state_reset_failed", {
        error: (error as NodeJS.ErrnoException).code ?? String(error),
      });
    }
  }

  async #stopBridge(): Promise<void> {
    const bridge = this.#bridge;
    if (!bridge) return;
    this.#bridge = undefined;
    try {
      await bridge.stop();
    } catch (error) {
      this.#ctx?.log.warn("imessage.bridge_stop_failed", {
        error: String(error),
      });
    }
    this.#ctx?.log.info("imessage.bridge_stopped", {});
    this.#bridgeState = "stopped";
    this.#publish();
  }

  // Checks again; a call while a check runs shares it.
  refresh(): Promise<IMessageStatus> {
    this.#probing ??= this.#options.permissions
      .checks()
      .then((checks) => {
        this.#checks = checks;
        this.#publish();
        return this.status();
      })
      .finally(() => {
        this.#probing = undefined;
      });
    return this.#probing;
  }

  set(patch: IMessagePatch): IMessageSetResult {
    const ctx = this.#ctx!;
    const current = ctx.config.get().imessage;
    let handles = current.handles;
    if (patch.handles) {
      try {
        handles = normalizeIMessageHandles(patch.handles);
      } catch (error) {
        if (!(error instanceof IMessageHandlesError)) throw error;
        return { ok: false, code: error.code, message: error.message };
      }
    }
    const enabled = patch.enabled ?? current.enabled;
    ctx.config.update({ imessage: { ...current, enabled, handles } });
    if (enabled !== current.enabled)
      ctx.log.info("imessage.enabled_changed", { enabled });
    if (JSON.stringify(handles) !== JSON.stringify(current.handles))
      ctx.log.info("imessage.handles_changed", { count: handles.length });
    if (enabled && !current.enabled) this.#install();
    if (!enabled && current.enabled) this.#forget = "all";
    else if (
      JSON.stringify(handles) !== JSON.stringify(current.handles) &&
      this.#forget === "none"
    )
      this.#forget = "target";
    this.#publish();
    // Turning off with no bridge running clears at once; a running one is
    // cleared after it stopped.
    this.#bridgeChange = this.#bridgeChange.then(() => {
      if (!this.#bridge) this.#resetChannelState();
    });
    return { ok: true, status: this.status() };
  }

  async act(action: IMessageAction): Promise<IMessageStatus> {
    switch (action) {
      case "request_automation":
        await this.#options.permissions.requestAutomation();
        return this.refresh();
      case "open_full_disk_settings":
        await this.#options.openExternal(SETTINGS_URL["full-disk"]);
        return this.status();
      case "open_automation_settings":
        await this.#options.openExternal(SETTINGS_URL.automation);
        return this.status();
      case "retry_install":
        this.#install();
        return this.status();
    }
  }

  #install(): void {
    const ctx = this.#ctx!;
    if (this.#runtime === "installing") return;
    this.#runtime = "installing";
    this.#runtimeError = undefined;
    this.#publish();
    this.#options.runtime.ensure().then(
      () => {
        this.#runtime = "ready";
        ctx.log.info("imessage.runtime_ready", {});
        this.#publish();
      },
      (error: unknown) => {
        this.#runtime = "failed";
        this.#runtimeError =
          error instanceof IMsgRuntimeError ? error.code : "download_failed";
        ctx.log.warn("imessage.runtime_failed", {
          code: this.#runtimeError,
          error: error instanceof Error ? error.message : String(error),
        });
        this.#publish();
      },
    );
  }

  // Emits only when the view changed.
  #publish(): void {
    this.#syncBridge();
    const status = this.status();
    const key = JSON.stringify(status);
    if (key === this.#last) return;
    this.#last = key;
    this.#ctx!.bus.emit("imessage.changed", status);
  }
}
