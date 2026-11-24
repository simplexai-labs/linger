import { runProcess } from "./process.js";
vi.mock("./process.js", () => ({ runProcess: vi.fn() }));
import {
  inspectNativeProcess,
  startNativeProcess,
  stopNativeProcess,
} from "./native-process.js";
vi.mock("./native-process.js", () => ({
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
  it("restarts a server an earlier release left running from another archive", async () => {
    run.mockImplementation(async () => ok("1"));
    await prepareNativeDatabase(options);
    expect(vi.mocked(startNativeProcess).mock.calls[0]![0]).toMatchObject({
      name: "postgres",
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
    expect(programs).toEqual([
      "whoami.exe",
      "initdb.exe",
      "pg_isready.exe",
      "psql.exe",
      "createdb.exe",
      "psql.exe",
    ]);
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

  it("builds the data directory aside and moves it in once initdb succeeds", async () => {
    run.mockResolvedValue(ok());
    await prepareNativeDatabase(options);
    expect(pgdata()).toEqual([pending]);
    expect(vi.mocked(removeRetrying).mock.calls).toEqual([[pending], [data]]);
    expect(vi.mocked(renameRetrying)).toHaveBeenCalledWith(pending, data, {
      signal: options.signal,
    });
    const initdb = run.mock.calls.findIndex(
      ([command]) => path.basename(command) === "initdb",
    );
    expect(
      vi.mocked(removeRetrying).mock.invocationCallOrder[1],
    ).toBeGreaterThan(run.mock.invocationCallOrder[initdb]!);
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
});

describe("prepareNativeDatabase with an existing TeamHub schema", () => {
  const backup = path.join(instance.root, "simplex-backup-x");
  const programs = () =>
    run.mock.calls.map(([command]) => path.basename(command));
  // psql answers the schema check from `schema` and the baseline check
  // from `baseline`.
  const answer = (schema: () => string, baseline: string) =>
    run.mockImplementation(async (command, args) =>
      path.basename(command) !== "psql" || !args.includes("simplexai")
        ? ok()
        : ok(
            args.some((arg) => arg.includes("to_regclass"))
              ? schema()
              : args.some((arg) => arg.includes("goose_db_version"))
                ? baseline
                : "1",
          ),
    );

  it("sets a database from before Linger aside and opens a fresh one", async () => {
    let fresh = false;
    answer(() => (fresh ? "f|f\n" : "t|t\n"), "f\n");
    vi.mocked(setAsideLegacyData).mockImplementation(async () => {
      fresh = true;
      return backup;
    });
    expect(await prepareNativeDatabase(options)).toEqual({
      legacyBackup: backup,
    });
    expect(stopNativeProcess).toHaveBeenCalledWith(instance.root, "postgres");
    expect(setAsideLegacyData).toHaveBeenCalledWith(
      instance.root,
      options.signal,
    );
    expect(
      vi.mocked(stopNativeProcess).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(setAsideLegacyData).mock.invocationCallOrder[0]!);
    expect(programs().filter((name) => name === "initdb")).toHaveLength(2);
    expect(startNativeProcess).toHaveBeenCalledTimes(2);
  });

  it("leaves a database that Linger migrated alone", async () => {
    answer(() => "t|t\n", "t\n");
    expect(await prepareNativeDatabase(options)).toEqual({});
    expect(stopNativeProcess).not.toHaveBeenCalled();
    expect(setAsideLegacyData).not.toHaveBeenCalled();
    expect(startNativeProcess).toHaveBeenCalledTimes(1);
  });
});

describe("prepareNativeDatabase readiness wait", () => {
  it("logs progress and succeeds when PostgreSQL becomes ready past 30s", async () => {
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const logs: string[] = [];
    let checks = 0;
    run.mockImplementation(async (command) => {
      if (path.basename(command) === "pg_isready") {
        checks += 1;
        // Advance 20s per check so readiness passes the old 30s cutoff at 40s.
        now += 20_000;
        return checks < 3
          ? {
              code: 1,
              stdout: "",
              stderr: "the database system is starting up",
            }
          : ok();
      }
      return ok("1");
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
  });

  it("reports deadline seconds and pg_isready exit code when readiness times out at 120s", async () => {
    let now = 2_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    run.mockImplementation(async (command) => {
      if (path.basename(command) === "pg_isready") {
        now += 30_000;
        return { code: 2, stdout: "", stderr: "no response" };
      }
      return ok("1");
    });
    try {
      await expect(prepareNativeDatabase(options)).rejects.toThrow(
        "Native PostgreSQL did not become ready within 120s (pg_isready exit 2); inspect its instance log.",
      );
    } finally {
      nowSpy.mockRestore();
    }
  });
});
