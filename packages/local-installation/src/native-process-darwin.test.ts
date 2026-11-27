import type { ExecFileException } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface PsResult {
  code: number;
  stdout: string;
}

const calls = vi.hoisted(
  () => [] as Array<{ args: string[]; env: NodeJS.ProcessEnv }>,
);
const output = vi.hoisted(() => ({
  identity: "",
  environment: "",
  psHandler: null as ((args: string[]) => PsResult) | null,
}));
vi.mock("node:child_process", () => ({
  execFile: (
    _executable: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv },
    callback: (error: ExecFileException | null, stdout: string) => void,
  ) => {
    calls.push({ args, env: options.env });
    if (output.psHandler) {
      const result = output.psHandler(args);
      const error =
        result.code === 0
          ? null
          : (Object.assign(new Error("ps exited"), {
              code: result.code,
            }) as ExecFileException);
      callback(error, result.stdout);
      return;
    }
    callback(null, args[0] === "eww" ? output.environment : output.identity);
  },
}));
vi.mock("./process.js", async (original) => ({
  ...(await original<typeof import("./process.js")>()),
  runProcess: async (_command: string, args: string[]) => {
    calls.push({ args, env: {} });
    if (output.psHandler) {
      const result = output.psHandler(args);
      return { code: result.code, stdout: result.stdout, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  },
}));
vi.mock("./instance.js", async (original) => ({
  ...(await original<typeof import("./instance.js")>()),
  readPrivate: (file: string) => readFile(file, "utf8").catch(() => undefined),
}));

const { darwinProcessIdentity, nativeProcessIdentity, posixLivePids } =
  await import("./native-process-identity.js");
const { NATIVE_PROCESS_REPLACED, stopNativeProcess } =
  await import("./native-process.js");

const lease = "a".repeat(64);
// What ps prints for lstart on a zh-CN Mac: four fields, not five.
const zhStart = `${String.fromCodePoint(0x4e09)} 11${String.fromCodePoint(0x6708)}/18 06:04:14 2026`;

describe("darwinProcessIdentity", () => {
  it("keeps the C-locale birth every recorded identity uses", () => {
    expect(
      darwinProcessIdentity("Wed Nov 18 06:04:14 2026   501 73285 Ss\n"),
    ).toEqual({
      birth: "darwin:Wed:Nov:18:06:04:14:2026:501:73285",
      uid: 501,
      group: 73285,
      state: "Ss",
    });
  });

  it("reads uid, group and state after a localized start time", () => {
    expect(darwinProcessIdentity(`${zhStart}   501 73285 Ss`)).toMatchObject({
      uid: 501,
      group: 73285,
      state: "Ss",
    });
  });

  it("rejects a line without numeric uid and group", () => {
    expect(darwinProcessIdentity("Wed Nov 18 06:04:14 2026")).toBeUndefined();
  });
});

describe("nativeProcessIdentity on macOS", () => {
  const platform = process.platform;
  const getuid = process.getuid;
  beforeEach(() => {
    calls.length = 0;
    output.psHandler = null;
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.getuid = () => 501;
    process.env.LC_ALL = "zh_CN.UTF-8";
    process.env.LANG = "zh_CN.UTF-8";
    process.env.LINGER_NATIVE_PROCESS_LEASE = lease;
  });
  afterEach(() => {
    output.psHandler = null;
    Object.defineProperty(process, "platform", { value: platform });
    process.getuid = getuid;
    delete process.env.LC_ALL;
    delete process.env.LANG;
    delete process.env.LINGER_NATIVE_PROCESS_LEASE;
  });

  it("runs every ps in the C locale without the lease", async () => {
    output.identity = "Wed Nov 18 06:04:14 2026   501 73285 Ss\n";
    output.environment = `node worker.mjs LINGER_NATIVE_PROCESS_LEASE=${lease}\n`;
    await expect(nativeProcessIdentity(73285, lease)).resolves.toBe(
      "darwin:Wed:Nov:18:06:04:14:2026:501:73285",
    );
    expect(calls).toHaveLength(2);
    for (const { env } of calls) {
      expect(env).toMatchObject({ LC_ALL: "C", LANG: "C" });
      expect(env.LINGER_NATIVE_PROCESS_LEASE).toBeUndefined();
    }
  });

  it("verifies a process whose start time still prints localized", async () => {
    output.identity = `${zhStart}   501 73285 Ss\n`;
    output.environment = `node worker.mjs LINGER_NATIVE_PROCESS_LEASE=${lease}\n`;
    await expect(nativeProcessIdentity(73285, lease)).resolves.toBe(
      `darwin:${zhStart.split(" ").join(":")}:501:73285`,
    );
  });
});

describe("posixLivePids on macOS", () => {
  const platform = process.platform;
  beforeEach(() => {
    calls.length = 0;
    output.psHandler = null;
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env.LINGER_NATIVE_PROCESS_LEASE = lease;
  });
  afterEach(() => {
    output.psHandler = null;
    Object.defineProperty(process, "platform", { value: platform });
    delete process.env.LINGER_NATIVE_PROCESS_LEASE;
  });

  it("checks targeted PIDs in one ps call, excluding zombies and preserving C locale without lease", async () => {
    output.psHandler = () => ({
      code: 0,
      stdout: "  101 Ss\n  102 Z+\n  103 R\n",
    });
    const live = await posixLivePids([101, 102, 103, 101]);
    expect([...live].sort((a, b) => a - b)).toEqual([101, 103]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["-p", "101,102,103", "-o", "pid=,stat="]);
    expect(calls[0]?.env).toMatchObject({ LC_ALL: "C", LANG: "C" });
    expect(calls[0]?.env.LINGER_NATIVE_PROCESS_LEASE).toBeUndefined();
  });

  it("returns an empty set when ps exits 1 because none of the PIDs exist", async () => {
    output.psHandler = () => ({ code: 1, stdout: "" });
    expect(await posixLivePids([99998, 99999])).toEqual(new Set());
  });
});

interface SimulatedDarwinProcess {
  pid: number;
  pgid: number;
  uid: number;
  state: string;
  start: string;
  lease?: string;
}

describe("stopLease on macOS", () => {
  const platform = process.platform;
  const getuid = process.getuid;
  let root = "";
  let table: SimulatedDarwinProcess[] = [];
  let signalled: Array<{ pid: number; signal: string | number | undefined }> =
    [];

  function installDarwinTable(
    onSignal?: (pid: number, signal: string | number | undefined) => void,
  ) {
    output.psHandler = (args: string[]) => {
      if (args[0] === "-axo" && args[1] === "pid=,uid=,stat=") {
        return {
          code: 0,
          stdout: table
            .map((entry) => `${entry.pid} ${entry.uid} ${entry.state}`)
            .join("\n"),
        };
      }
      if (args[0] === "-axo" && args[1] === "pid=,pgid=,stat=") {
        return {
          code: 0,
          stdout: table
            .map((entry) => `${entry.pid} ${entry.pgid} ${entry.state}`)
            .join("\n"),
        };
      }
      if (args[0] === "eww" && args[1] === "-p") {
        const requested = new Set(args[2]!.split(",").map(Number));
        const matched = table.filter((entry) => requested.has(entry.pid));
        if (!matched.length) return { code: 1, stdout: "" };
        const withPid = args[4] === "pid=,command=";
        return {
          code: 0,
          stdout: matched
            .map((entry) => {
              const env = entry.lease
                ? `LINGER_NATIVE_PROCESS_LEASE=${entry.lease}`
                : "";
              return withPid ? `${entry.pid} node ${env}` : `node ${env}`;
            })
            .join("\n"),
        };
      }
      if (args[0] === "-p" && args[3] === "lstart=,uid=,pgid=,stat=") {
        const pid = Number(args[1]);
        const entry = table.find((candidate) => candidate.pid === pid);
        if (!entry) return { code: 1, stdout: "" };
        return {
          code: 0,
          stdout: `${entry.start} ${entry.uid} ${entry.pgid} ${entry.state}\n`,
        };
      }
      if (args[0] === "-p" && args[3] === "pid=,stat=") {
        const requested = new Set(args[1]!.split(",").map(Number));
        const matched = table.filter((entry) => requested.has(entry.pid));
        if (!matched.length) return { code: 1, stdout: "" };
        return {
          code: 0,
          stdout: matched
            .map((entry) => `${entry.pid} ${entry.state}`)
            .join("\n"),
        };
      }
      if (args[0] === "-p" && args[3] === "stat=") {
        const pid = Number(args[1]);
        const entry = table.find((candidate) => candidate.pid === pid);
        if (!entry) return { code: 1, stdout: "" };
        return { code: 0, stdout: `${entry.state}\n` };
      }
      return { code: 1, stdout: "" };
    };
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === 0) {
        if (table.some((entry) => entry.pid === pid)) return true;
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      }
      signalled.push({ pid, signal });
      onSignal?.(pid, signal);
      return true;
    });
  }

  async function writeLeaseRecord(pid: number, start: string) {
    const birth = `darwin:${start.split(" ").join(":")}:501:${pid}`;
    await mkdir(path.join(root, "native", "processes"), { recursive: true });
    await writeFile(
      path.join(root, "native", "processes", "web.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "web",
        pid,
        birth,
        lease,
        configuration: "b".repeat(64),
      }),
    );
  }

  beforeEach(async () => {
    calls.length = 0;
    output.psHandler = null;
    signalled = [];
    table = [];
    root = await mkdtemp(path.join(tmpdir(), "linger-darwin-stop-"));
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.getuid = () => 501;
  });

  afterEach(async () => {
    output.psHandler = null;
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { value: platform });
    process.getuid = getuid;
    await rm(root, { recursive: true, force: true });
  });

  it("polls targeted PIDs while draining and skips the redundant post-break scan", async () => {
    const start = "Wed Nov 18 06:04:14 2026";
    await writeLeaseRecord(200, start);
    table = [
      { pid: 200, pgid: 200, uid: 501, state: "Ss", start, lease },
      { pid: 201, pgid: 200, uid: 501, state: "S", start, lease },
    ];
    let targetedChecks = 0;
    installDarwinTable((pid, signal) => {
      if (pid === 200 && signal === "SIGKILL") {
        table = table.filter((entry) => entry.pid !== 200);
      }
    });
    const baseHandler = output.psHandler!;
    output.psHandler = (args) => {
      if (args[0] === "-p" && args[3] === "pid=,stat=") {
        targetedChecks += 1;
        // Child finishes draining on the third targeted poll (~140ms), without
        // triggering full-system `eww` sweeps on the earlier ticks.
        if (targetedChecks >= 3) {
          table = table.filter((entry) => entry.pid !== 201);
        }
      }
      return baseHandler(args);
    };

    await stopNativeProcess(root, "web", 2_000);

    const fullSystemScans = calls.filter(
      (call) => call.args[0] === "-axo" && call.args[1] === "pid=,uid=,stat=",
    );
    const groupScans = calls.filter(
      (call) => call.args[0] === "-axo" && call.args[1] === "pid=,pgid=,stat=",
    );
    // 1 initial scan + 1 confirmation after child drains + 1 post-supervisor check (no redundant post-break scan).
    expect(targetedChecks).toBe(3);
    expect(fullSystemScans).toHaveLength(3);
    expect(groupScans).toHaveLength(1);
    expect(signalled).toEqual([
      { pid: 201, signal: "SIGINT" },
      { pid: 200, signal: "SIGKILL" },
    ]);
  });

  it("catches a newly spawned descendant during confirmation and treats zombies as exited", async () => {
    const start = "Wed Nov 18 06:04:14 2026";
    await writeLeaseRecord(300, start);
    table = [
      { pid: 300, pgid: 300, uid: 501, state: "Ss", start, lease },
      { pid: 301, pgid: 300, uid: 501, state: "S", start, lease },
    ];
    installDarwinTable((pid, signal) => {
      if (pid === 301 && signal === "SIGINT") {
        // Original child becomes a zombie and spawns a replacement descendant.
        table = [
          { pid: 300, pgid: 300, uid: 501, state: "Ss", start, lease },
          { pid: 301, pgid: 300, uid: 501, state: "Z+", start, lease },
          { pid: 302, pgid: 302, uid: 501, state: "S", start, lease },
        ];
      } else if (pid === 302 && signal === "SIGINT") {
        table = table.filter((entry) => entry.pid !== 302);
      } else if (pid === 300 && signal === "SIGKILL") {
        table = [];
      }
    });

    await stopNativeProcess(root, "web", 2_000);

    expect(signalled).toEqual([
      { pid: 301, signal: "SIGINT" },
      { pid: 302, signal: "SIGINT" },
      { pid: 300, signal: "SIGKILL" },
    ]);
  });

  it("refuses with NATIVE_PROCESS_REPLACED when the recorded PID belongs to another process", async () => {
    const start = "Wed Nov 18 06:04:14 2026";
    await writeLeaseRecord(400, start);
    table = [
      {
        pid: 400,
        pgid: 400,
        uid: 501,
        state: "Ss",
        start: "Thu Nov 19 09:00:00 2026",
      },
    ];
    installDarwinTable();

    await expect(stopNativeProcess(root, "web", 500)).rejects.toMatchObject({
      code: NATIVE_PROCESS_REPLACED,
    });
    expect(signalled).toEqual([]);
  });
});
