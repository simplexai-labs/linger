import { describe, expect, it, vi } from "vitest";

import {
  BackgroundModel,
  SetupRuntimes,
  type SetupCommandRunner,
} from "./setup-sources.js";

// One headless installer command the test drives: lines go to the page's
// handler, and it ends when the test (or a stop) says so.
interface Running {
  readonly args: readonly string[];
  readonly options: Parameters<SetupCommandRunner>[1];
  readonly written: string[];
  stopped: boolean;
  line(value: Record<string, unknown>): void;
  end(code?: number): void;
}

const commands = () => {
  const started: Running[] = [];
  const run: SetupCommandRunner = async (args, options) => {
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const running: Running = {
      args,
      options,
      written: [],
      stopped: false,
      line: (value) => options.onLine(value),
      end: (code = 0) => finish(code),
    };
    started.push(running);
    return {
      write: (line) => running.written.push(line),
      stop: () => {
        running.stopped = true;
        finish(143);
      },
      done,
    };
  };
  // The latest command whose first argument is `flag`, once it started.
  const find = async (flag: string): Promise<Running> => {
    await vi.waitFor(() =>
      expect(started.some((item) => item.args[0] === flag)).toBe(true),
    );
    return started.filter((item) => item.args[0] === flag).at(-1)!;
  };
  return { run, started, find };
};

const status = (
  rows: { runtime: string; installed: boolean; signedIn: boolean }[],
) => ({ runtimes: rows });

describe("SetupRuntimes", () => {
  it("reads each runtime's install and sign-in; Codex leads the signed-in ones", async () => {
    const { run, find } = commands();
    const changed = vi.fn();
    const runtimes = new SetupRuntimes({ run, changed });
    expect(runtimes.rows()).toBeUndefined();
    const checked = runtimes.check();
    // Rows show as checking until the status answers.
    expect(runtimes.rows()?.map((row) => row.state)).toEqual([
      "checking",
      "checking",
      "checking",
    ]);
    const command = await find("--runtime-status");
    expect(command.options.inspect).toBe(true);
    command.line(
      status([
        { runtime: "claude", installed: true, signedIn: true },
        { runtime: "codex", installed: true, signedIn: true },
        // Pi has no sign-in of its own, whatever a report says.
        { runtime: "pi", installed: true, signedIn: true },
      ]),
    );
    command.end();
    await checked;
    expect(runtimes.rows()).toEqual([
      { runtime: "claude", installed: true, signedIn: true, state: "idle" },
      { runtime: "codex", installed: true, signedIn: true, state: "idle" },
      { runtime: "pi", installed: true, signedIn: false, state: "idle" },
    ]);
    expect(runtimes.signedIn()).toEqual(["codex", "claude"]);
    expect(changed).toHaveBeenCalled();
  });

  it("enables Install only with Claude Code or Codex signed in", async () => {
    const { run, find } = commands();
    const runtimes = new SetupRuntimes({ run, changed: () => undefined });
    const checked = runtimes.check();
    const command = await find("--runtime-status");
    command.line(
      status([
        { runtime: "claude", installed: true, signedIn: false },
        { runtime: "codex", installed: false, signedIn: false },
        { runtime: "pi", installed: true, signedIn: false },
      ]),
    );
    command.end();
    await checked;
    // Pi installed and Claude Code installed but signed out enable nothing.
    expect(runtimes.signedIn()).toEqual([]);
  });

  it("installs a runtime on the pinned Node.js with its bytes, then reads its sign-in", async () => {
    const { run, find } = commands();
    const runtimes = new SetupRuntimes({ run, changed: () => undefined });
    const installing = runtimes.install("claude");
    // A second Install while one runs starts nothing.
    void runtimes.install("claude");
    const command = await find("--prepare-runtime");
    expect(command.args).toEqual(["--prepare-runtime", "claude"]);
    expect(command.options.pinnedNode).toBe(true);
    expect(runtimes.busy()).toBe(true);
    command.line({ event: "progress", completed: 40, total: 100 });
    expect(runtimes.rows()?.[0]).toMatchObject({
      runtime: "claude",
      state: "installing",
      install: { completed: 40, total: 100 },
    });
    command.line({ outcome: { installed: true, signedIn: false } });
    command.end();
    await installing;
    expect(runtimes.rows()?.[0]).toEqual({
      runtime: "claude",
      installed: true,
      signedIn: false,
      state: "idle",
    });
    expect(runtimes.busy()).toBe(false);
  });

  it("keeps a failed install's words on its row, and a cancelled one quiet", async () => {
    const { run, find, started } = commands();
    const runtimes = new SetupRuntimes({ run, changed: () => undefined });
    const failing = runtimes.install("codex");
    const command = await find("--prepare-runtime");
    command.line({
      outcome: {
        installed: false,
        signedIn: false,
        message: "Not enough disk space",
      },
    });
    command.end(1);
    await failing;
    expect(runtimes.rows()?.[1]).toMatchObject({
      runtime: "codex",
      state: "idle",
      installed: false,
      failed: "install",
      message: "Not enough disk space",
    });

    // Install again clears the failure; Cancel puts the row back as before.
    const again = runtimes.install("codex");
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(runtimes.rows()?.[1]).not.toHaveProperty("failed");
    runtimes.cancel("codex");
    await again;
    expect(started[1]!.stopped).toBe(true);
    expect(runtimes.rows()?.[1]).toEqual({
      runtime: "codex",
      installed: false,
      signedIn: false,
      state: "idle",
    });
  });

  it("signs Claude Code in with the code its page shows", async () => {
    const { run, find } = commands();
    const openExternal = vi.fn(async () => undefined);
    const runtimes = new SetupRuntimes({
      run,
      changed: () => undefined,
      openExternal,
      platform: "darwin",
    });
    const signing = runtimes.signIn("claude");
    const command = await find("--runtime-login");
    expect(command.args).toEqual(["--runtime-login", "claude"]);
    command.line({
      state: "waiting_user",
      url: "https://claude.ai/oauth/authorize?code=true",
      acceptsCode: true,
    });
    expect(runtimes.rows()?.[0]).toMatchObject({
      state: "signing_in",
      signIn: {
        url: "https://claude.ai/oauth/authorize?code=true",
        acceptsCode: true,
      },
    });
    // The CLI opens its own page on macOS.
    expect(openExternal).not.toHaveBeenCalled();
    runtimes.code("claude", "  pasted-code#state ");
    expect(command.written).toEqual(["pasted-code#state"]);
    expect(runtimes.signInLink("claude", "url")).toBe(
      "https://claude.ai/oauth/authorize?code=true",
    );
    command.line({ state: "ready" });
    command.line({ ended: true });
    command.end();
    await signing;
    expect(runtimes.rows()?.[0]).toEqual({
      runtime: "claude",
      installed: true,
      signedIn: true,
      state: "idle",
    });
    expect(runtimes.signedIn()).toEqual(["claude"]);
  });

  it("opens a Codex device login's page itself and reports a failed sign-in", async () => {
    const { run, find } = commands();
    const openExternal = vi.fn(async () => undefined);
    const runtimes = new SetupRuntimes({
      run,
      changed: () => undefined,
      openExternal,
      platform: "darwin",
    });
    const signing = runtimes.signIn("codex", true);
    const command = await find("--runtime-login");
    expect(command.args).toEqual([
      "--runtime-login",
      "codex",
      "--device-login",
    ]);
    command.line({
      state: "waiting_user",
      url: "https://auth.openai.com/codex/device",
      deviceCode: "ABCD-1234",
    });
    await vi.waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith(
        "https://auth.openai.com/codex/device",
      ),
    );
    // Opened once per page, however many snapshots repeat it.
    command.line({
      state: "waiting_user",
      url: "https://auth.openai.com/codex/device",
      deviceCode: "ABCD-1234",
    });
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(runtimes.signInLink("codex", "code")).toBe("ABCD-1234");
    command.line({
      state: "failed",
      reason: "timed_out",
      message: "Timed out",
    });
    command.end(1);
    await signing;
    expect(runtimes.rows()?.[1]).toMatchObject({
      runtime: "codex",
      state: "idle",
      signedIn: false,
      failed: "signin",
      reason: "timed_out",
      message: "Timed out",
    });
  });

  it("passes --browser-login for Codex browser sign-in on Linux and opens the URL", async () => {
    const { run, find } = commands();
    const openExternal = vi.fn(async () => undefined);
    const runtimes = new SetupRuntimes({
      run,
      changed: () => undefined,
      openExternal,
      platform: "linux",
    });
    const signing = runtimes.signIn("codex");
    const command = await find("--runtime-login");
    expect(command.args).toEqual([
      "--runtime-login",
      "codex",
      "--browser-login",
    ]);
    command.line({
      state: "waiting_user",
      url: "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
    });
    await vi.waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith(
        "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
      ),
    );
    command.line({ state: "ready" });
    command.end();
    await signing;
    expect(runtimes.rows()?.[1]).toMatchObject({
      runtime: "codex",
      signedIn: true,
      state: "idle",
    });
  });

  it("switches a live Codex sign-in to device code without letting the replaced process clobber state", async () => {
    const { run, started } = commands();
    const openExternal = vi.fn(async () => undefined);
    const runtimes = new SetupRuntimes({
      run,
      changed: () => undefined,
      openExternal,
      platform: "linux",
    });
    const first = runtimes.signIn("codex", false);
    await vi.waitFor(() => expect(started).toHaveLength(1));
    const browserCmd = started[0]!;
    expect(browserCmd.args).toEqual([
      "--runtime-login",
      "codex",
      "--browser-login",
    ]);
    browserCmd.line({
      state: "waiting_user",
      url: "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
    });
    // Switch to device code while browser sign-in is active.
    const second = runtimes.signIn("codex", true);
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(browserCmd.stopped).toBe(true);
    // Repeated click in the same mode is still ignored.
    void runtimes.signIn("codex", true);
    expect(started).toHaveLength(2);
    // Late output from the replaced process cannot overwrite the active device sign-in.
    browserCmd.line({
      state: "failed",
      reason: "ended",
      message: "old process ended",
    });
    await first;
    expect(runtimes.rows()?.[1]).toMatchObject({
      runtime: "codex",
      state: "signing_in",
      signIn: {},
    });
    expect(runtimes.rows()?.[1]).not.toHaveProperty("failed");
    const deviceCmd = started[1]!;
    expect(deviceCmd.args).toEqual([
      "--runtime-login",
      "codex",
      "--device-login",
    ]);
    deviceCmd.line({
      state: "waiting_user",
      url: "https://auth.openai.com/codex/device",
      deviceCode: "ABCD-5678",
    });
    await vi.waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith(
        "https://auth.openai.com/codex/device",
      ),
    );
    expect(runtimes.rows()?.[1]).toMatchObject({
      state: "signing_in",
      signIn: {
        url: "https://auth.openai.com/codex/device",
        deviceCode: "ABCD-5678",
      },
    });
    deviceCmd.line({ state: "ready" });
    deviceCmd.end();
    await second;
    expect(runtimes.rows()?.[1]).toEqual({
      runtime: "codex",
      installed: true,
      signedIn: true,
      state: "idle",
    });
  });

  it("stops a sign-in on Cancel without calling it failed", async () => {
    const { run, find } = commands();
    const runtimes = new SetupRuntimes({ run, changed: () => undefined });
    const signing = runtimes.signIn("claude");
    const command = await find("--runtime-login");
    runtimes.cancel("claude");
    await signing;
    expect(command.stopped).toBe(true);
    expect(runtimes.rows()?.[0]).toEqual({
      runtime: "claude",
      installed: true,
      signedIn: false,
      state: "idle",
    });
  });

  it("stops everything it runs when the app quits", async () => {
    const { run, find } = commands();
    const runtimes = new SetupRuntimes({ run, changed: () => undefined });
    const installing = runtimes.install("pi");
    const signing = runtimes.signIn("codex");
    const install = await find("--prepare-runtime");
    const login = await find("--runtime-login");
    runtimes.stopAll();
    await Promise.all([installing, signing]);
    expect(install.stopped && login.stopped).toBe(true);
    expect(runtimes.busy()).toBe(false);
  });
});

describe("BackgroundModel", () => {
  it("downloads the planned model with its bytes until done", async () => {
    const { run, find } = commands();
    const model = new BackgroundModel({ run, changed: () => undefined });
    expect(model.state()).toBeUndefined();
    const downloading = model.start("qwen3-8b:Q4_K_M");
    const command = await find("--download-local-model");
    expect(command.args).toEqual(["--download-local-model", "qwen3-8b:Q4_K_M"]);
    command.line({
      event: "progress",
      phase: "download",
      completed: 30,
      total: 100,
      bytesPerSecond: 5,
    });
    expect(model.state()).toEqual({
      model: "qwen3-8b:Q4_K_M",
      state: "downloading",
      phase: "download",
      completed: 30,
      total: 100,
      bytesPerSecond: 5,
    });
    command.line({ outcome: { state: "done" } });
    command.end();
    await downloading;
    expect(model.state()).toEqual({
      model: "qwen3-8b:Q4_K_M",
      state: "done",
      completed: 100,
      total: 100,
    });
    // A finished model is not downloaded again.
    await model.start("qwen3-8b:Q4_K_M");
  });

  it("reports a failed download, starts again from its bytes, and stops for good on quit", async () => {
    const { run, find, started } = commands();
    const model = new BackgroundModel({ run, changed: () => undefined });
    const first = model.start("qwen3-8b:Q4_K_M");
    const command = await find("--download-local-model");
    command.line({ event: "progress", completed: 10, total: 100 });
    command.line({
      outcome: {
        state: "failed",
        code: "disk_full",
        message: "Not enough disk space",
      },
    });
    command.end(1);
    await first;
    expect(model.state()).toEqual({
      model: "qwen3-8b:Q4_K_M",
      state: "failed",
      completed: 10,
      total: 100,
      code: "disk_full",
      message: "Not enough disk space",
    });
    const second = model.start("qwen3-8b:Q4_K_M");
    expect(model.state()).toMatchObject({
      state: "downloading",
      completed: 10,
      total: 100,
    });
    await vi.waitFor(() => expect(started).toHaveLength(2));
    model.stop();
    await second;
    expect(started[1]!.stopped).toBe(true);
    await model.start("qwen3-8b:Q4_K_M");
    expect(started).toHaveLength(2);
  });
});
