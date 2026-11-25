import { usesBrowserOAuth } from "@linger/local-installation/runtime-login-mode";
import { stripVTControlCharacters } from "node:util";
import { spawn, type ChildProcess } from "node:child_process";
import {
  inspectRuntime,
  type NativeRuntime,
} from "@linger/local-installation/managed-runtimes";
import { managedRuntimeEnvironment } from "@linger/local-installation/managed-codex";
import type { components } from "@linger/wire-contracts/linger-installer/types";
type Snapshot = components["schemas"]["RuntimeLogin"];
/** Codex's two logins: the one that calls back to this computer, or a device code. */
export type LoginMethod = "browser" | "device";
interface Input {
  instance: string;
  home: string;
  root: string;
  runtime: NativeRuntime;
}
interface Session {
  runtime: NativeRuntime;
  method: LoginMethod | undefined;
  snapshot: Snapshot;
  child: ChildProcess;
  timer: ReturnType<typeof setTimeout>;
}
function allowedCodexUrl(url: URL, nativeBrowser: boolean) {
  if (url.hostname !== "auth.openai.com") return false;
  if (!nativeBrowser) return url.pathname === "/codex/device";
  if (url.pathname !== "/oauth/authorize") return false;
  try {
    const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
    return (
      ["http://localhost:1455", "http://127.0.0.1:1455"].includes(
        callback.origin,
      ) &&
      callback.pathname === "/auth/callback" &&
      !callback.username &&
      !callback.password &&
      !callback.search &&
      !callback.hash
    );
  } catch {
    return false;
  }
}
/** Native output is private and ephemeral. Never attach it to persisted jobs or logs. */
export class RuntimeLoginManager {
  private sessions = new Map<string, Session>();
  private starting = new Map<string, AbortController>();
  private closed = false;
  constructor(
    private inspect: typeof inspectRuntime = inspectRuntime,
    private platform: NodeJS.Platform = process.platform,
    private timeoutMs = 15 * 60_000,
  ) {}
  private async probe(input: Input, signal?: AbortSignal) {
    const env = {
      ...process.env,
      ...(await managedRuntimeEnvironment(input.home, input.root)),
    };
    signal?.throwIfAborted();
    const state = await this.inspect(input.runtime, {
      home: input.home,
      env,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
    return { env, state };
  }
  async status(input: Input): Promise<Snapshot> {
    const { state } = await this.probe(input);
    if (state.ready) {
      // The native CLI may write credentials before serving its final browser
      // callback. Let it exit naturally; killing it here races that response.
      return { state: "ready" };
    }
    const session = this.sessions.get(input.instance);
    return structuredClone(
      session?.runtime === input.runtime ? session.snapshot : { state: "idle" },
    );
  }
  /**
   * Starts the runtime's own login, or hands it a code. method picks Codex's
   * login. Asked for browser on Linux, the caller opens the link itself, so
   * the CLI is told not to through BROWSER, which it reads only there; on
   * other platforms the CLI still opens its own page.
   */
  async start(
    input: Input,
    code?: string,
    method?: LoginMethod,
  ): Promise<Snapshot> {
    if (code !== undefined) {
      const session = this.sessions.get(input.instance);
      const stdin = session?.child.stdin;
      if (
        session?.runtime !== input.runtime ||
        !session.snapshot.acceptsCode ||
        !stdin?.writable ||
        !/^[A-Za-z0-9._~+/#=-]{1,4096}$/.test(code)
      )
        throw new Error("Invalid authorization code or inactive login");
      await new Promise<void>((resolve, reject) => {
        stdin.write(code + "\n", (error) => {
          if (error)
            reject(
              new Error(
                "Native sign-in could not accept the authorization code. Retry or sign in later.",
              ),
            );
          else resolve();
        });
      });
      return structuredClone(session.snapshot);
    }
    if (this.closed) return { state: "idle" };
    this.starting.get(input.instance)?.abort();
    const controller = new AbortController();
    this.starting.set(input.instance, controller);
    let result;
    try {
      result = await this.probe(input, controller.signal);
    } catch (error) {
      if (this.starting.get(input.instance) === controller)
        this.starting.delete(input.instance);
      if (controller.signal.aborted) return { state: "idle" };
      throw error;
    }
    if (this.starting.get(input.instance) !== controller)
      return { state: "idle" };
    this.starting.delete(input.instance);
    const { env, state } = result;
    const login: LoginMethod | undefined =
      input.runtime === "codex"
        ? (method ?? (usesBrowserOAuth(this.platform) ? "browser" : "device"))
        : undefined;
    const existing = this.sessions.get(input.instance);
    if (
      existing &&
      (existing.runtime !== input.runtime || existing.method !== login)
    )
      this.stop(input.instance);
    if (state.ready) return { state: "ready" };
    if (
      existing &&
      existing.runtime === input.runtime &&
      existing.method === login &&
      ["starting", "waiting_user"].includes(existing.snapshot.state)
    )
      return structuredClone(existing.snapshot);
    this.stop(input.instance);
    if (!state.installed || input.runtime === "pi")
      return {
        state: "failed",
        reason: "unavailable",
        message:
          "Native browser sign-in is unavailable for this runtime. You can sign in later.",
      };
    const descriptor =
      login === "device"
        ? state.descriptor.deviceLoginCommand
        : state.descriptor.loginCommand;
    if (!descriptor)
      return {
        state: "failed",
        reason: "unavailable",
        message:
          "The upstream Runtime does not offer browser sign-in. You can sign in later.",
      };
    const child = spawn(descriptor.executable, descriptor.args, {
      env: {
        ...env,
        ...descriptor.env,
        ...(login === "browser" && method && this.platform === "linux"
          ? { BROWSER: "true" }
          : {}),
      },
      shell: false,
      detached: process.platform !== "win32",
      // Its output is read here; the browser opens on its own unless the
      // caller asked to open it.
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const session: Session = {
      runtime: input.runtime,
      method: login,
      child,
      snapshot: { state: "starting" },
      timer: setTimeout(() => {
        this.stop(input.instance);
        session.snapshot = {
          state: "failed",
          reason: "timed_out",
          message: "Sign-in timed out. Retry or sign in later.",
        };
        this.sessions.set(input.instance, session);
      }, this.timeoutMs),
    };
    session.timer.unref();
    this.sessions.set(input.instance, session);
    let output = "";
    const receive = (chunk: Buffer) => {
      if (session.snapshot.state === "failed") return;
      output = stripVTControlCharacters(output + chunk.toString()).slice(
        -16384,
      );
      for (const match of output.matchAll(/https:\/\/[^\s<>"']+/g)) {
        try {
          const url = new URL(match[0]);
          const allowed =
            input.runtime === "codex"
              ? allowedCodexUrl(url, login === "browser")
              : (url.hostname === "claude.com" &&
                  url.pathname === "/cai/oauth/authorize") ||
                ([
                  "claude.ai",
                  "platform.claude.com",
                  "console.anthropic.com",
                ].includes(url.hostname) &&
                  url.pathname.startsWith("/oauth/"));
          if (!allowed || url.username || url.password || url.port) continue;
          session.snapshot = {
            ...session.snapshot,
            state: "waiting_user",
            url: url.href,
            acceptsCode: input.runtime === "claude",
          };
        } catch {
          /* Ignore non-vendor output; never return raw process text. */
        }
      }
      const deviceCode =
        login === "device"
          ? output.match(/^\s*([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\s*$/m)?.[1]
          : undefined;
      if (deviceCode) session.snapshot.deviceCode = deviceCode;
    };
    child.stdout?.on("data", receive);
    child.stderr?.on("data", receive);
    // A timed-out login was stopped here; it keeps saying so.
    const timedOut = () => session.snapshot.reason === "timed_out";
    const failed = () => {
      if (timedOut()) return;
      session.snapshot = {
        state: "failed",
        reason: "ended",
        message: "Native sign-in ended. Retry or sign in later.",
      };
    };
    child.once("error", failed);
    child.stdin?.on("error", failed);
    child.once("close", () => {
      clearTimeout(session.timer);
      output = "";
      void this.probe(input)
        .then(({ state }) => {
          if (state.ready) session.snapshot = { state: "ready" };
          else if (!timedOut())
            session.snapshot = {
              state: "failed",
              reason: "ended",
              message: "Sign-in was not completed. Retry or sign in later.",
            };
        })
        .catch(failed);
    });
    return structuredClone(session.snapshot);
  }
  /** Stops a login this manager started, such as when the person cancels it. */
  cancel(instance: string): Snapshot {
    this.starting.get(instance)?.abort();
    this.starting.delete(instance);
    this.stop(instance);
    return { state: "idle" };
  }
  private stop(instance: string) {
    const session = this.sessions.get(instance);
    if (!session) return;
    clearTimeout(session.timer);
    if (session.child.exitCode === null && session.child.pid) {
      try {
        process.kill(
          process.platform === "win32" ? session.child.pid : -session.child.pid,
          "SIGTERM",
        );
      } catch {
        /* Owned login already exited. */
      }
    }
    this.sessions.delete(instance);
  }
  close() {
    this.closed = true;
    for (const controller of this.starting.values()) controller.abort();
    this.starting.clear();
    for (const name of this.sessions.keys()) this.stop(name);
  }
}
