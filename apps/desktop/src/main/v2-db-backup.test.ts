import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createV2DatabaseBackupHooks,
  redactDatabaseSecrets,
  resolveDatabaseConnection,
  resolvePostgresTool,
  type PostgresExecFn,
} from "./v2-db-backup.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

interface LogEntry {
  level: "info" | "warn" | "error";
  event: string;
  fields: Record<string, unknown>;
}

function makeTestLog() {
  const entries: LogEntry[] = [];
  return {
    entries,
    logger: {
      info: (event: string, fields: Record<string, unknown>) =>
        entries.push({ level: "info", event, fields }),
      warn: (event: string, fields: Record<string, unknown>) =>
        entries.push({ level: "warn", event, fields }),
      error: (event: string, fields: Record<string, unknown>) =>
        entries.push({ level: "error", event, fields }),
    },
  };
}

async function seedLocalInstance(
  home: string,
  options: { port?: number; servicesEnv?: string } = {},
): Promise<void> {
  const instanceDir = path.join(home, "instances", "desktop");
  await mkdir(instanceDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(instanceDir, "instance.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        name: "desktop",
        mode: "source-native",
        root: instanceDir,
        port: 3000,
        source: {
          repo: path.join(home, "source"),
          ports: {
            web: 3000,
            teamhub: 8080,
            nodeServices: 8081,
            document: 8082,
            postgres: options.port ?? 54321,
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(instanceDir, "services.env"),
    options.servicesEnv ??
      "# Generated instance secrets\nLINGER_POSTGRES_PASSWORD='super-secret-pg-pass'\nLINGER_SECRET_SEED=abc\n",
    "utf8",
  );
}

describe("v2-db-backup helpers", () => {
  it("resolves DB config from <home>/instances/desktop/{instance.json,services.env} when TEAMHUB_DATABASE_URL is unset", async () => {
    const home = await makeTempDir("linger-db-conn-");
    await seedLocalInstance(home, {
      port: 55432,
      servicesEnv:
        '# comment line\nLINGER_POSTGRES_PASSWORD="quoted-secret-123"\nOTHER=1\n',
    });

    const conn = await resolveDatabaseConnection({ home, env: {} });
    expect(conn).toEqual({
      source: "local-instance",
      args: [
        "--host",
        "127.0.0.1",
        "--port",
        "55432",
        "--username",
        "simplexai",
        "--dbname",
        "simplexai",
      ],
      password: "quoted-secret-123",
      sslmode: "disable",
    });
    expect(conn?.args.join(" ")).not.toContain("quoted-secret-123");
  });

  it("extracts password from TEAMHUB_DATABASE_URL into PGPASSWORD and strips it from argv", async () => {
    const home = await makeTempDir("linger-db-envurl-");
    const conn = await resolveDatabaseConnection({
      home,
      env: {
        TEAMHUB_DATABASE_URL:
          "postgres://simplexai:my%2Fsecret%40pass@127.0.0.1:54399/simplexai?sslmode=disable",
      },
    });
    expect(conn).toEqual({
      source: "env",
      args: [
        "--dbname",
        "postgres://simplexai@127.0.0.1:54399/simplexai?sslmode=disable",
      ],
      password: "my/secret@pass",
    });
    expect(conn?.args.join(" ")).not.toContain("my/secret@pass");
    expect(conn?.args.join(" ")).not.toContain("my%2Fsecret%40pass");
  });

  it("discovers bundled pg_dump/pg_restore and sets LD_LIBRARY_PATH / DYLD_LIBRARY_PATH / Windows PATH", async () => {
    const home = await makeTempDir("linger-pg-tools-");
    const installerDir = path.join(home, "installer");
    const sha = "a".repeat(64);

    // Linux bundled postgres in tools/native/components/<sha>/
    const linuxPgRoot = path.join(home, "tools", "native", "components", sha);
    await mkdir(path.join(linuxPgRoot, "bin"), { recursive: true });
    await mkdir(path.join(linuxPgRoot, "lib"), { recursive: true });
    await writeFile(path.join(linuxPgRoot, "bin", "pg_dump"), "", "utf8");
    await writeFile(path.join(linuxPgRoot, "bin", "pg_restore"), "", "utf8");
    await mkdir(installerDir, { recursive: true });
    await writeFile(
      path.join(installerDir, "distribution.json"),
      JSON.stringify({
        platform: "linux",
        arch: "x64",
        nativeSources: [{ target: "linux-x64", sha256: sha }],
      }),
      "utf8",
    );

    const linuxDump = resolvePostgresTool("pg_dump", {
      home,
      installerDirectory: installerDir,
      platform: "linux",
      arch: "x64",
      env: { LD_LIBRARY_PATH: "/existing/lib" },
    });
    expect(linuxDump.source).toBe("bundled");
    expect(linuxDump.executable).toBe(path.join(linuxPgRoot, "bin", "pg_dump"));
    expect(linuxDump.env.LD_LIBRARY_PATH).toBe(
      `${path.join(linuxPgRoot, "lib")}:/existing/lib`,
    );

    // macOS bundled postgres via scan with DYLD_LIBRARY_PATH
    const macRestore = resolvePostgresTool("pg_restore", {
      home,
      platform: "darwin",
      arch: "arm64",
      env: { DYLD_LIBRARY_PATH: "/opt/lib" },
    });
    expect(macRestore.source).toBe("bundled");
    expect(macRestore.executable).toBe(
      path.join(linuxPgRoot, "bin", "pg_restore"),
    );
    expect(macRestore.env.DYLD_LIBRARY_PATH).toBe(
      `${path.join(linuxPgRoot, "lib")}:/opt/lib`,
    );

    // Windows bundled postgres prefers <sha>-utf8 and normalizes case-insensitive Path -> PATH
    const winPgRoot = path.join(
      home,
      "tools",
      "native",
      "components",
      `${sha}-utf8`,
    );
    await mkdir(path.join(winPgRoot, "bin"), { recursive: true });
    await mkdir(path.join(winPgRoot, "lib"), { recursive: true });
    await writeFile(path.join(winPgRoot, "bin", "pg_dump.exe"), "", "utf8");
    const winDump = resolvePostgresTool("pg_dump", {
      home,
      platform: "win32",
      arch: "x64",
      env: { Path: "C:\\Windows\\System32" },
    });
    expect(winDump.source).toBe("bundled");
    expect(winDump.executable).toBe(path.join(winPgRoot, "bin", "pg_dump.exe"));
    expect(winDump.env.Path).toBeUndefined();
    expect(winDump.env.PATH).toBe(
      `${path.join(winPgRoot, "bin")};${path.join(winPgRoot, "lib")};C:\\Windows\\System32`,
    );

    // Explicit env override wins over bundled binaries
    const envOverride = resolvePostgresTool("pg_dump", {
      home,
      platform: "linux",
      arch: "x64",
      env: { LINGER_PG_DUMP_BIN: "/custom/bin/pg_dump" },
    });
    expect(envOverride.source).toBe("env");
    expect(envOverride.executable).toBe("/custom/bin/pg_dump");

    // Packaged resourcesPath discovery works when tools/native/components is empty
    const emptyHome = await makeTempDir("linger-pg-empty-home-");
    const resourcesPath = await makeTempDir("linger-pg-resources-");
    await mkdir(path.join(resourcesPath, "postgres", "bin"), {
      recursive: true,
    });
    await mkdir(path.join(resourcesPath, "postgres", "lib"), {
      recursive: true,
    });
    await writeFile(
      path.join(resourcesPath, "postgres", "bin", "pg_restore"),
      "",
      "utf8",
    );
    const resRestore = resolvePostgresTool("pg_restore", {
      home: emptyHome,
      resourcesPath,
      platform: "linux",
      arch: "x64",
      env: {},
    });
    expect(resRestore.source).toBe("bundled");
    expect(resRestore.executable).toBe(
      path.join(resourcesPath, "postgres", "bin", "pg_restore"),
    );
    expect(resRestore.env.LD_LIBRARY_PATH).toBe(
      path.join(resourcesPath, "postgres", "lib"),
    );

    // Falls back to system PATH when nothing is bundled
    const fallback = resolvePostgresTool("pg_dump", {
      home: emptyHome,
      platform: "linux",
      arch: "x64",
      env: {},
    });
    expect(fallback.source).toBe("path");
    expect(fallback.executable).toBe("pg_dump");
  });

  it("creates private 0o700 backups dir and 0o600 dump file, passes PGPASSWORD only via env, and follows custom install home lazily", async () => {
    const defaultHome = await makeTempDir("linger-db-default-home-");
    const customHome = await makeTempDir("linger-db-custom-home-");
    await seedLocalInstance(customHome, { port: 54888 });

    const pgRoot = path.join(
      customHome,
      "tools",
      "native",
      "components",
      "b".repeat(64),
    );
    await mkdir(path.join(pgRoot, "bin"), { recursive: true });
    await mkdir(path.join(pgRoot, "lib"), { recursive: true });
    await writeFile(path.join(pgRoot, "bin", "pg_dump"), "", "utf8");
    await writeFile(path.join(pgRoot, "bin", "pg_restore"), "", "utf8");

    let activeHome = defaultHome;
    const { entries, logger } = makeTestLog();
    const calls: Array<{
      file: string;
      args: readonly string[];
      env: NodeJS.ProcessEnv;
    }> = [];
    const mockExec: PostgresExecFn = async (file, args, opts) => {
      calls.push({ file, args, env: opts.env });
      const fileIdx = args.indexOf("--file");
      if (fileIdx >= 0 && args[fileIdx + 1]) {
        await writeFile(args[fileIdx + 1]!, "PGDMP-TEST-DATA", "utf8");
        if (process.platform !== "win32") {
          // Simulate a looser umask to verify backupDatabase tightens mode back to 0o600.
          await chmod(args[fileIdx + 1]!, 0o644);
        }
      }
      return { stdout: "", stderr: "" };
    };

    const hooks = createV2DatabaseBackupHooks({
      getHome: () => activeHome,
      log: logger,
      platform: process.platform === "win32" ? "win32" : "linux",
      arch: "x64",
      env: {},
      exec: mockExec,
    });

    // Switch to custom install location after hook creation (mirrors Setup choosing custom home).
    activeHome = customHome;
    const relBackup = await hooks.backupDatabase("0.1.11-v2test.3");
    expect(relBackup).toBe(
      "instances/desktop/backups/pre-0.1.11-v2test.3.dump",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe(path.join(pgRoot, "bin", "pg_dump"));
    expect(calls[0]?.args).toEqual([
      "--format=custom",
      "--file",
      path.join(
        customHome,
        "instances/desktop/backups/pre-0.1.11-v2test.3.dump",
      ),
      "--host",
      "127.0.0.1",
      "--port",
      "54888",
      "--username",
      "simplexai",
      "--dbname",
      "simplexai",
    ]);
    expect(calls[0]?.args.join(" ")).not.toContain("super-secret-pg-pass");
    expect(calls[0]?.env.PGPASSWORD).toBe("super-secret-pg-pass");
    expect(calls[0]?.env.PGSSLMODE).toBe("disable");
    if (process.platform !== "win32") {
      expect(calls[0]?.env.LD_LIBRARY_PATH).toBe(path.join(pgRoot, "lib"));
      const dirMode =
        (await stat(path.join(customHome, "instances/desktop/backups"))).mode &
        0o777;
      const fileMode =
        (
          await stat(
            path.join(
              customHome,
              "instances/desktop/backups/pre-0.1.11-v2test.3.dump",
            ),
          )
        ).mode & 0o777;
      expect(dirMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    }

    await hooks.restoreDatabase(relBackup!);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.file).toBe(path.join(pgRoot, "bin", "pg_restore"));
    expect(calls[1]?.args).toEqual([
      "--clean",
      "--if-exists",
      "--no-owner",
      "--host",
      "127.0.0.1",
      "--port",
      "54888",
      "--username",
      "simplexai",
      "--dbname",
      "simplexai",
      path.join(
        customHome,
        "instances/desktop/backups/pre-0.1.11-v2test.3.dump",
      ),
    ]);
    expect(calls[1]?.env.PGPASSWORD).toBe("super-secret-pg-pass");
    expect(
      entries.some((e) => e.event === "release_orchestrator.db_backed_up"),
    ).toBe(true);
    expect(
      entries.some((e) => e.event === "release_orchestrator.db_restored"),
    ).toBe(true);
  });

  it("skips backup and restore cleanly in Thin Client mode (no local instance)", async () => {
    const emptyHome = await makeTempDir("linger-db-thin-");
    const { entries, logger } = makeTestLog();
    let invoked = false;
    const hooks = createV2DatabaseBackupHooks({
      getHome: () => emptyHome,
      log: logger,
      env: {},
      exec: async () => {
        invoked = true;
        return { stdout: "", stderr: "" };
      },
    });

    expect(await hooks.backupDatabase("0.1.11-v2test.3")).toBeUndefined();
    await hooks.restoreDatabase(
      "instances/desktop/backups/pre-0.1.11-v2test.3.dump",
    );
    expect(invoked).toBe(false);
    expect(
      entries.some(
        (e) =>
          e.event ===
          "release_orchestrator.db_backup_skipped_no_local_instance",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (e) =>
          e.event ===
          "release_orchestrator.db_restore_skipped_no_local_instance",
      ),
    ).toBe(true);
  });

  it("handles benign pg_restore exit-1 notices while propagating real failures and redacting secrets", async () => {
    const home = await makeTempDir("linger-db-errors-");
    await seedLocalInstance(home, { port: 54999 });
    const { entries, logger } = makeTestLog();

    // 1. Benign exit 1 with "errors ignored on restore" logs notice and resolves.
    const noticeHooks = createV2DatabaseBackupHooks({
      getHome: () => home,
      log: logger,
      env: {},
      exec: async () => {
        throw Object.assign(new Error("Command failed"), {
          code: 1,
          stderr:
            "pg_restore: error: could not execute query: ERROR: schema public already exists\npg_restore: warning: errors ignored on restore: 1\n",
        });
      },
    });
    await expect(
      noticeHooks.restoreDatabase("instances/desktop/backups/pre-test.dump"),
    ).resolves.toBeUndefined();
    expect(
      entries.some((e) => e.event === "release_orchestrator.pg_restore_notice"),
    ).toBe(true);

    // 2. Genuine ENOENT / connection error rejects with redacted message (never leaking PGPASSWORD).
    const failHooks = createV2DatabaseBackupHooks({
      getHome: () => home,
      log: logger,
      env: {},
      exec: async () => {
        throw Object.assign(
          new Error("spawn pg_restore ENOENT super-secret-pg-pass"),
          {
            code: "ENOENT",
            stderr:
              "fatal: password authentication failed for super-secret-pg-pass postgres://simplexai:super-secret-pg-pass@127.0.0.1:54999/simplexai",
          },
        );
      },
    });
    let thrown = "";
    try {
      await failHooks.restoreDatabase(
        "instances/desktop/backups/pre-test.dump",
      );
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    expect(thrown).toContain("Database restore (pg_restore) failed");
    expect(thrown).not.toContain("super-secret-pg-pass");
    expect(thrown).toContain("[redacted]");

    expect(
      redactDatabaseSecrets(
        "postgres://simplexai:top%20secret@127.0.0.1:5432/simplexai top secret",
        "top secret",
      ),
    ).toBe(
      "postgres://simplexai:[redacted]@127.0.0.1:5432/simplexai [redacted]",
    );
  });
});
