import { runProcess } from "./process.js";
vi.mock("./process.js", () => ({ runProcess: vi.fn() }));
import {
  inspectNativeProcess,
  SERVICE_RESTART_POLICY,
  startNativeProcess,
  stopNativeProcess,
} from "./native-process.js";
vi.mock("./native-process.js", async (original) => ({
  ...(await original<typeof import("./native-process.js")>()),
  inspectNativeProcess: vi.fn(async () => ({ running: true })),
  startNativeProcess: vi.fn(async () => {}),
  stopNativeProcess: vi.fn(async () => {}),
}));
import { setAsideLegacyData } from "./legacy-database.js";
vi.mock("./legacy-database.js", async (original) => ({
  ...(await original<typeof import("./legacy-database.js")>()),
  setAsideLegacyData: vi.fn(),
}));
import { removeRetrying, renameRetrying } from "./fs-retry.js";
vi.mock("./fs-retry.js", () => ({
  removeRetrying: vi.fn(async () => {}),
  renameRetrying: vi.fn(async () => {}),
}));
vi.mock("./instance.js", () => ({
  privateDirectory: vi.fn(async () => {}),
  atomicPrivate: vi.fn(async () => {}),
  readPrivate: vi.fn(async () => "LINGER_POSTGRES_PASSWORD=secret\n"),
}));
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  postgresProgram,
  prepareNativeDatabase,
  windowsElevated,
} from "./native-database.js";
import type { Instance } from "./instance.js";

const run = vi.mocked(runProcess);
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const getuid = Object.getOwnPropertyDescriptor(process, "getuid");
const fakeUid = (value: typeof process.getuid) =>
  Object.defineProperty(process, "getuid", { configurable: true, value });
// The root guard refuses initdb, and CI containers often run as root.
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  fakeUid(() => 1000);
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  if (getuid) Object.defineProperty(process, "getuid", getuid);
  else Reflect.deleteProperty(process, "getuid");
  vi.clearAllMocks();
});
// Windows has no process.getuid.
const asWindows = () => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  fakeUid(undefined);
};
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const instance = {
  root: path.join("C:", "Users", "Nora", "Nouveau dossier é", "instance"),
  mode: "source-native",
  source: { ports: { postgres: 15432 } },
} as unknown as Instance;
const options = {
  instance,
  postgresBin: path.join("C:", "pg", "bin"),
  env: {},
  signal: new AbortController().signal,
  onOutput: () => {},
};

describe("postgresProgram", () => {
  it("names the Windows executables", () => {
    expect(postgresProgram("bin", "initdb", "win32")).toBe(
      path.join("bin", "initdb.exe"),
    );
    expect(postgresProgram("bin", "initdb", "linux")).toBe(
      path.join("bin", "initdb"),
    );
  });
});

describe("windowsElevated", () => {
  const groups = (label: string) =>
    `"Everyone","Well-known group","S-1-1-0","Mandatory group"\r\n"Mandatory Label\\${label}","Label","${
      label === "High Mandatory Level" ? "S-1-16-12288" : "S-1-16-8192"
    }",""\r\n`;

  it("detects an elevated token by its integrity label SID", async () => {
    const fake = vi.fn<typeof runProcess>(async () =>
      ok(groups("High Mandatory Level")),
    );
    expect(await windowsElevated(fake)).toBe(true);
    expect(fake.mock.calls[0]![0]).toMatch(/System32[\\/]whoami\.exe$/);
  });

  it("accepts a normal token, and does not block when whoami fails", async () => {
    expect(
      await windowsElevated(async () => ok(groups("Medium Mandatory Level"))),
    ).toBe(false);
    expect(
      await windowsElevated(async () => {
        throw new Error("spawn ENOENT");
      }),
    ).toBe(false);
  });
});

describe("prepareNativeDatabase start", () => {
  it("restarts a server an earlier release left running from another archive and supervises exits", async () => {
    run.mockImplementation(async () => ok("1"));
    await prepareNativeDatabase(options);
    expect(vi.mocked(startNativeProcess).mock.calls[0]![0]).toMatchObject({
      name: "postgres",
      restartOnExit: SERVICE_RESTART_POLICY,
      restartOnConfigurationChange: true,
    });
  });
});

describe("prepareNativeDatabase on Windows", () => {
  it("runs the .exe programs from the private PostgreSQL", async () => {
    asWindows();
    run.mockImplementation(async (command) =>
      command.endsWith("whoami.exe")
        ? ok(
            '"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""',
          )
        : ok(),
    );
    await prepareNativeDatabase(options);
    const programs = run.mock.calls.map(([command]) =>
      path.win32.basename(command),
    );
    expect(programs).toEqual(["whoami.exe", "initdb.exe", "psql.exe"]);
    expect(vi.mocked(startNativeProcess).mock.calls[0]![0]).toMatchObject({
      executable: path.join(options.postgresBin, "postgres.exe"),
      withoutAdministrators: false,
    });
    expect(vi.mocked(inspectNativeProcess)).toHaveBeenCalled();
  });

  it("starts postgres with Administrators disabled when Linger runs as administrator", async () => {
    asWindows();
    run.mockImplementation(async (command) =>
      command.endsWith("whoami.exe")
        ? ok(
            '"Mandatory Label\\High Mandatory Level","Label","S-1-16-12288",""',
          )
        : ok(),
    );
    await prepareNativeDatabase(options);
    expect(vi.mocked(startNativeProcess).mock.calls[0]![0]).toMatchObject({
      executable: path.join(options.postgresBin, "postgres.exe"),
      withoutAdministrators: true,
    });
  });
});

describe("prepareNativeDatabase initdb", () => {
  it("says what the program reported, without the password", async () => {
    run.mockImplementation(async (command) =>
      path.basename(command) === "initdb"
        ? {
            code: 1,
            stdout: "",
            stderr:
              "initdb: error: could not change permissions of directory\nsecret\n",
          }
        : ok(),
    );
    const failure = await prepareNativeDatabase(options).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("could not change permissions");
    expect(message).toContain("Inspect the instance log.");
    expect(message).not.toContain("secret");
  });

  it("keeps the last lines in view and caps a long one", async () => {
    run.mockImplementation(async (command) =>
      path.basename(command) === "initdb"
        ? {
            code: 1,
            stdout: "",
            stderr: `${"x".repeat(5_000)}\nFATAL: data directory is not empty\ncleaning up\n`,
          }
        : ok(),
    );
    const first = await prepareNativeDatabase(options).catch(
      (error: unknown) => error,
    );
    // The FATAL line survives the cleanup lines that follow it.
    expect((first as Error).message).toContain(
      "FATAL: data directory is not empty",
    );

    vi.clearAllMocks();
    run.mockImplementation(async (command) =>
      path.basename(command) === "initdb"
        ? { code: 1, stdout: "", stderr: `${"y".repeat(5_000)}\n` }
        : ok(),
    );
    const second = await prepareNativeDatabase(options).catch(
      (error: unknown) => error,
    );
    // The long line is copied but capped at 240 characters.
    expect((second as Error).message).toContain("y".repeat(239));
    expect((second as Error).message).not.toContain("y".repeat(241));
  });

  it("shows exactly the last five lines, in any language", async () => {
    run.mockImplementation(async (command) =>
      path.basename(command) === "initdb"
        ? {
            code: 1,
            stdout: "",
            stderr:
              "line 1\nline 2\nline 3\nline 4\n\u521d\u59cb\u5316\u5931\u8d25\nline 6\nline 7\n",
          }
        : ok(),
    );
    const failure = await prepareNativeDatabase(options).catch(
      (error: unknown) => error,
    );
    const message = (failure as Error).message;
    expect(message).toContain("line 3");
    expect(message).toContain("line 7");
    expect(message).toContain("\u521d\u59cb\u5316\u5931\u8d25");
    expect(message).not.toContain("line 2");
  });
  const data = path.join(instance.root, "native/postgres-data");
  const pending = `${data}.partial`;
  const pgdata = () =>
    run.mock.calls
      .filter(([command]) => path.basename(command) === "initdb")
      .map(([, args]) => args[args.indexOf("--pgdata") + 1]);

  it("builds the data directory aside with --no-sync and creates simplexai in one psql call", async () => {
    run.mockResolvedValue(ok());
    await prepareNativeDatabase(options);
    expect(pgdata()).toEqual([pending]);
    expect(vi.mocked(removeRetrying).mock.calls).toEqual([[pending], [data]]);
    expect(vi.mocked(renameRetrying)).toHaveBeenCalledWith(pending, data, {
      signal: options.signal,
    });
    const initdbIndex = run.mock.calls.findIndex(
      ([command]) => path.basename(command) === "initdb",
    );
    expect(run.mock.calls[initdbIndex]![1]).toContain("--no-sync");
    expect(
      vi.mocked(removeRetrying).mock.invocationCallOrder[1],
    ).toBeGreaterThan(run.mock.invocationCallOrder[initdbIndex]!);
    expect(run.mock.calls.map(([command]) => path.basename(command))).toEqual([
      "initdb",
      "psql",
    ]);
    const [, psqlArgs, psqlOptions] = run.mock.calls[1]!;
    expect(psqlArgs).toEqual([
      "--host",
      "127.0.0.1",
      "--port",
      "15432",
      "--username",
      "simplexai",
      "--dbname",
      "postgres",
      "--tuples-only",
      "--no-align",
      "--set",
      "ON_ERROR_STOP=1",
      "--no-psqlrc",
    ]);
    expect(psqlOptions?.input).toContain("CREATE DATABASE simplexai");
    expect(psqlOptions?.input).toContain("\\gexec");
    expect(psqlOptions?.timeoutMs).toBe(60_000);
    expect(psqlOptions?.onOutput).toBeUndefined();
  });

  // A killed initdb has already written PG_VERSION; publishing it would make
  // every later attempt skip initdb and fail on an incomplete cluster.
  it("leaves the data directory alone when initdb fails", async () => {
    run.mockImplementation(async (command) =>
      path.basename(command) === "initdb"
        ? { code: 1, stdout: "", stderr: "" }
        : ok(),
    );
    await expect(prepareNativeDatabase(options)).rejects.toThrow(
      /initdb failed/,
    );
    expect(vi.mocked(removeRetrying).mock.calls).toEqual([[pending]]);
    expect(renameRetrying).not.toHaveBeenCalled();
    expect(startNativeProcess).not.toHaveBeenCalled();
  });

  describe("with a PG_VERSION already present", () => {
    let root: string;
    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), "native-database-"));
      await mkdir(path.join(root, "native/postgres-data"), { recursive: true });
      await writeFile(
        path.join(root, "native/postgres-data/PG_VERSION"),
        "17\n",
      );
      run.mockResolvedValue(ok());
    });
    afterEach(() => rm(root, { recursive: true, force: true }));
    const prepare = () =>
      prepareNativeDatabase({ ...options, instance: { ...instance, root } });

    it("keeps a cluster that has served", async () => {
      await writeFile(
        path.join(root, "native/postgres-data/postmaster.opts"),
        "",
      );
      await prepare();
      expect(pgdata()).toEqual([]);
      expect(renameRetrying).not.toHaveBeenCalled();
    });

    // A cluster no postmaster ever started holds no data, and one left by a
    // killed initdb would otherwise fail every start.
    it("makes again one that never started", async () => {
      await prepare();
      expect(pgdata()).toEqual([
        path.join(root, "native/postgres-data.partial"),
      ]);
      expect(renameRetrying).toHaveBeenCalled();
    });
  });

  describe("warm single-subprocess probe on an initialized cluster", () => {
    let root: string;
    const backup = "simplex-backup-warm";
    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), "native-database-warm-"));
      await mkdir(path.join(root, "native/postgres-data"), { recursive: true });
      await writeFile(
        path.join(root, "native/postgres-data/PG_VERSION"),
        "17\n",
      );
      await writeFile(
        path.join(root, "native/postgres-data/postmaster.opts"),
        "",
      );
    });
    afterEach(() => rm(root, { recursive: true, force: true }));
    const prepare = (signal = options.signal) =>
      prepareNativeDatabase({
        ...options,
        signal,
        instance: { ...instance, root },
      });

    it.each(["linger", "empty"] as const)(
      "skips pg_isready, createdb, and preLingerSchema when the single psql probe returns %s",
      async (token) => {
        run.mockResolvedValueOnce(ok(`${token}\n`));
        expect(await prepare()).toEqual({});
        expect(run).toHaveBeenCalledTimes(1);
        const [command, args, callOptions] = run.mock.calls[0]!;
        expect(path.basename(command)).toBe("psql");
        expect(args).toEqual(
          expect.arrayContaining([
            "--dbname",
            "simplexai",
            "--tuples-only",
            "--no-align",
            "--set",
            "ON_ERROR_STOP=1",
            "--no-psqlrc",
          ]),
        );
        expect(callOptions?.input).toContain("\\gset");
        expect(callOptions?.input).toContain("\\if :has_accounts");
        expect(setAsideLegacyData).not.toHaveBeenCalled();
        expect(stopNativeProcess).not.toHaveBeenCalled();
      },
    );

    it("sets aside legacy data directly when the single psql probe returns legacy", async () => {
      vi.mocked(setAsideLegacyData).mockImplementationOnce(async () => {
        await rm(path.join(root, "native/postgres-data"), {
          recursive: true,
          force: true,
        });
        return path.join(root, backup);
      });
      run.mockImplementation(async (command, args) => {
        if (path.basename(command) === "psql" && args.includes("--no-psqlrc"))
          return ok("legacy\n");
        if (
          path.basename(command) === "psql" &&
          args.some((arg) => arg.includes("pg_database"))
        )
          return ok("1\n");
        return ok();
      });
      expect(await prepare()).toEqual({
        legacyBackup: path.join(root, backup),
      });
      expect(stopNativeProcess).toHaveBeenCalledWith(root, "postgres");
      expect(setAsideLegacyData).toHaveBeenCalledWith(root, options.signal);
      expect(startNativeProcess).toHaveBeenCalledTimes(2);
      // The first open() resolved legacy without running pg_isready; the fresh
      // cluster open() after setAsideLegacyData uses initdb --no-sync + psql.
      const programs = run.mock.calls.map(([cmd]) => path.basename(cmd));
      expect(programs).toEqual(["psql", "initdb", "psql"]);
    });

    it("falls back to pg_isready and cold checks when the warm psql probe fails, throws, or prints unexpected output", async () => {
      for (const failure of [
        () => Promise.resolve({ code: 2, stdout: "", stderr: "starting up" }),
        () => Promise.reject(new Error("Command stdin unavailable")),
        () => Promise.resolve(ok("unexpected\n")),
      ]) {
        vi.clearAllMocks();
        run.mockImplementationOnce(failure);
        run.mockImplementation(async (command, args) => {
          if (path.basename(command) === "pg_isready") return ok();
          if (
            path.basename(command) === "psql" &&
            args.some((arg) => arg.includes("pg_database"))
          )
            return ok("1\n");
          if (
            path.basename(command) === "psql" &&
            args.some((arg) => arg.includes("to_regclass"))
          )
            return ok("t|t\n");
          if (
            path.basename(command) === "psql" &&
            args.some((arg) => arg.includes("goose_db_version"))
          )
            return ok("t\n");
          return ok();
        });
        expect(await prepare()).toEqual({});
        const programs = run.mock.calls.map(([cmd]) => path.basename(cmd));
        expect(programs).toEqual([
          "psql",
          "pg_isready",
          "psql",
          "psql",
          "psql",
        ]);
      }
    });

    it("propagates abort instead of falling back when cancelled during the warm probe", async () => {
      const controller = new AbortController();
      run.mockImplementationOnce(async () => {
        controller.abort();
        throw new DOMException("Interrupted", "AbortError");
      });
      await expect(prepare(controller.signal)).rejects.toThrow("Interrupted");
      expect(run).toHaveBeenCalledTimes(1);
    });
  });
});

describe("prepareNativeDatabase with an existing TeamHub schema", () => {
  let root: string;
  let backup: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "native-database-schema-"));
    backup = path.join(root, "simplex-backup-x");
    await mkdir(path.join(root, "native/postgres-data"), { recursive: true });
    await writeFile(path.join(root, "native/postgres-data/PG_VERSION"), "17\n");
    await writeFile(
      path.join(root, "native/postgres-data/postmaster.opts"),
      "",
    );
  });
  afterEach(() => rm(root, { recursive: true, force: true }));
  const prepare = () =>
    prepareNativeDatabase({ ...options, instance: { ...instance, root } });
  const programs = () =>
    run.mock.calls.map(([command]) => path.basename(command));
  // Warm probe falls back (exit 2), then fallback psql answers pg_database,
  // schema check, and baseline check.
  const answer = (schema: () => string, baseline: string) =>
    run.mockImplementation(async (command, args, callOptions) => {
      if (
        path.basename(command) === "psql" &&
        args.includes("--no-psqlrc") &&
        args.includes("simplexai") &&
        callOptions?.input?.includes("\\gset")
      )
        return { code: 2, stdout: "", stderr: "starting up" };
      if (path.basename(command) !== "psql" || !args.includes("simplexai"))
        return ok();
      return ok(
        args.some((arg) => arg.includes("to_regclass"))
          ? schema()
          : args.some((arg) => arg.includes("goose_db_version"))
            ? baseline
            : "1",
      );
    });

  it("sets a database from before Linger aside and opens a fresh one", async () => {
    let fresh = false;
    answer(() => (fresh ? "f|f\n" : "t|t\n"), "f\n");
    vi.mocked(setAsideLegacyData).mockImplementation(async () => {
      fresh = true;
      await rm(path.join(root, "native/postgres-data"), {
        recursive: true,
        force: true,
      });
      return backup;
    });
    expect(await prepare()).toEqual({
      legacyBackup: backup,
    });
    expect(stopNativeProcess).toHaveBeenCalledWith(root, "postgres");
    expect(setAsideLegacyData).toHaveBeenCalledWith(root, options.signal);
    expect(
      vi.mocked(stopNativeProcess).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(setAsideLegacyData).mock.invocationCallOrder[0]!);
    expect(programs().filter((name) => name === "initdb")).toHaveLength(1);
    expect(startNativeProcess).toHaveBeenCalledTimes(2);
  });

  it("leaves a database that Linger migrated alone", async () => {
    answer(() => "t|t\n", "t\n");
    expect(await prepare()).toEqual({});
    expect(stopNativeProcess).not.toHaveBeenCalled();
    expect(setAsideLegacyData).not.toHaveBeenCalled();
    expect(startNativeProcess).toHaveBeenCalledTimes(1);
  });
});

describe("prepareNativeDatabase readiness wait", () => {
  it("retries cold psql exit 2, logs progress past 30s, and succeeds without leaking stderr", async () => {
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const logs: string[] = [];
    let checks = 0;
    run.mockImplementation(async (command) => {
      if (path.basename(command) === "psql") {
        checks += 1;
        // Advance 20s per check so readiness passes the old 30s cutoff at 40s.
        now += 20_000;
        return checks < 3
          ? {
              code: 2,
              stdout: "",
              stderr: "psql: error: the database system is starting up",
            }
          : ok();
      }
      return ok();
    });
    try {
      await prepareNativeDatabase({
        ...options,
        onOutput: (chunk) => logs.push(chunk),
      });
    } finally {
      nowSpy.mockRestore();
    }
    expect(checks).toBe(3);
    expect(
      logs.some((line) =>
        /Waiting for native PostgreSQL to become ready/.test(line),
      ),
    ).toBe(true);
    expect(logs.some((line) => line.includes("starting up"))).toBe(false);
  });

  it("reports deadline seconds and psql exit code when cold readiness times out at 120s", async () => {
    let now = 2_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    run.mockImplementation(async (command) => {
      if (path.basename(command) === "psql") {
        now += 30_000;
        return { code: 2, stdout: "", stderr: "connection refused" };
      }
      return ok();
    });
    try {
      await expect(prepareNativeDatabase(options)).rejects.toThrow(
        "Native PostgreSQL did not become ready within 120s (psql exit 2); inspect its instance log.",
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("fails immediately on non-2 cold psql errors and redacts the password", async () => {
    let psqlCalls = 0;
    run.mockImplementation(async (command) => {
      if (path.basename(command) === "psql") {
        psqlCalls += 1;
        return {
          code: 3,
          stdout: "",
          stderr: "ERROR: permission denied for secret\n",
        };
      }
      return ok();
    });
    const failure = await prepareNativeDatabase(options).catch(
      (error: unknown) => error,
    );
    expect(psqlCalls).toBe(1);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("Native PostgreSQL psql failed:");
    expect(message).toContain("permission denied");
    expect(message).toContain("[redacted]");
    expect(message).not.toContain("secret");
  });

  it("fails immediately when native PostgreSQL stops during cold readiness wait", async () => {
    vi.mocked(inspectNativeProcess).mockResolvedValueOnce({
      running: false,
    });
    run.mockResolvedValue(ok());
    await expect(prepareNativeDatabase(options)).rejects.toThrow(
      "Native PostgreSQL stopped; inspect its instance log.",
    );
    expect(
      run.mock.calls.filter(([cmd]) => path.basename(cmd) === "psql"),
    ).toHaveLength(0);
  });

  it("propagates abort immediately when cancelled during cold psql readiness wait", async () => {
    const controller = new AbortController();
    run.mockImplementation(async (command) => {
      if (path.basename(command) === "psql") {
        controller.abort();
        throw new DOMException("Cancelled", "AbortError");
      }
      return ok();
    });
    await expect(
      prepareNativeDatabase({ ...options, signal: controller.signal }),
    ).rejects.toThrow("Cancelled");
  });

  it("retries cold psql on COMMAND_STDIN_UNAVAILABLE and COMMAND_TIMEOUT and caps per-attempt timeout by remaining deadline", async () => {
    let now = 3_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const timeouts: (number | undefined)[] = [];
    let psqlAttempt = 0;
    run.mockImplementation(async (command, _args, callOptions) => {
      if (path.basename(command) === "psql") {
        psqlAttempt += 1;
        timeouts.push(callOptions?.timeoutMs);
        if (psqlAttempt === 1) {
          now += 80_000;
          throw Object.assign(new Error("Command stdin unavailable"), {
            code: "COMMAND_STDIN_UNAVAILABLE",
          });
        }
        if (psqlAttempt === 2) {
          now += 38_000;
          throw Object.assign(new Error("Command timed out"), {
            code: "COMMAND_TIMEOUT",
          });
        }
        return ok();
      }
      return ok();
    });
    try {
      await expect(prepareNativeDatabase(options)).resolves.toEqual({});
    } finally {
      nowSpy.mockRestore();
    }
    expect(psqlAttempt).toBe(3);
    // Attempt 1: 120s left -> 60s cap; Attempt 2: 40s left -> 40s; Attempt 3: 2s left -> 5s floor.
    expect(timeouts).toEqual([60_000, 40_000, 5_000]);
  });

  it("fails immediately when postgres stops during a COMMAND_STDIN_UNAVAILABLE or COMMAND_TIMEOUT cold retry", async () => {
    for (const code of [
      "COMMAND_STDIN_UNAVAILABLE",
      "COMMAND_TIMEOUT",
    ] as const) {
      vi.clearAllMocks();
      vi.mocked(inspectNativeProcess)
        .mockResolvedValueOnce({ running: true })
        .mockResolvedValueOnce({ running: false });
      let psqlCalls = 0;
      run.mockImplementation(async (command) => {
        if (path.basename(command) === "psql") {
          psqlCalls += 1;
          throw Object.assign(new Error("transient"), { code });
        }
        return ok();
      });
      await expect(prepareNativeDatabase(options)).rejects.toThrow(
        "Native PostgreSQL stopped; inspect its instance log.",
      );
      expect(psqlCalls).toBe(1);
    }
  });

  it.each([
    ["COMMAND_STDIN_UNAVAILABLE", "psql stdin unavailable"],
    ["COMMAND_TIMEOUT", "psql timed out"],
  ] as const)(
    "reports %s cleanly when cold readiness hits the 120s deadline",
    async (code, expectedDetail) => {
      let now = 4_000_000;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
      run.mockImplementation(async (command) => {
        if (path.basename(command) === "psql") {
          now += 65_000;
          throw Object.assign(new Error("transient"), { code });
        }
        return ok();
      });
      try {
        await expect(prepareNativeDatabase(options)).rejects.toThrow(
          `Native PostgreSQL did not become ready within 120s (${expectedDetail}); inspect its instance log.`,
        );
      } finally {
        nowSpy.mockRestore();
      }
    },
  );

  it("fails immediately without retrying on COMMAND_EXECUTABLE_UNAVAILABLE", async () => {
    let psqlCalls = 0;
    run.mockImplementation(async (command) => {
      if (path.basename(command) === "psql") {
        psqlCalls += 1;
        throw Object.assign(new Error("Command executable unavailable"), {
          code: "COMMAND_EXECUTABLE_UNAVAILABLE",
        });
      }
      return ok();
    });
    await expect(prepareNativeDatabase(options)).rejects.toMatchObject({
      code: "COMMAND_EXECUTABLE_UNAVAILABLE",
    });
    expect(psqlCalls).toBe(1);
  });

  it("keeps warm fallback pg_isready progress and 120s timeout reporting", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "native-database-warm-wait-"),
    );
    try {
      await mkdir(path.join(root, "native/postgres-data"), { recursive: true });
      await writeFile(
        path.join(root, "native/postgres-data/PG_VERSION"),
        "17\n",
      );
      await writeFile(
        path.join(root, "native/postgres-data/postmaster.opts"),
        "",
      );
      let now = 2_000_000;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
      const logs: string[] = [];
      run.mockImplementation(async (command, args) => {
        if (path.basename(command) === "psql" && args.includes("--no-psqlrc"))
          return { code: 2, stdout: "", stderr: "starting up" };
        if (path.basename(command) === "pg_isready") {
          now += 30_000;
          return { code: 2, stdout: "", stderr: "no response" };
        }
        return ok("1");
      });
      try {
        await expect(
          prepareNativeDatabase({
            ...options,
            instance: { ...instance, root },
            onOutput: (chunk) => logs.push(chunk),
          }),
        ).rejects.toThrow(
          "Native PostgreSQL did not become ready within 120s (pg_isready exit 2); inspect its instance log.",
        );
      } finally {
        nowSpy.mockRestore();
      }
      expect(
        logs.some((line) =>
          /Waiting for native PostgreSQL to become ready/.test(line),
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
