import { execFile as nodeExecFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { parseEnv, promisify } from "node:util";

import { resolveSafeHomePath } from "@linger/local-installation/release-descriptor";

import type { Logger } from "./log.js";

const execFileAsync = promisify(nodeExecFile);

export type PostgresToolName = "pg_dump" | "pg_restore";

export interface ResolvedPostgresTool {
  readonly executable: string;
  readonly source: "env" | "bundled" | "path";
  readonly env: NodeJS.ProcessEnv;
}

export interface ResolvePostgresToolOptions {
  readonly home: string;
  readonly installerDirectory?: string;
  readonly resourcesPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly exists?: (filePath: string) => boolean;
  readonly readdir?: (dirPath: string) => string[];
  readonly readFileText?: (filePath: string) => string | undefined;
}

export interface DatabaseConnectionConfig {
  readonly source: "env" | "local-instance";
  readonly args: readonly string[];
  readonly password?: string;
  readonly sslmode?: string;
}

export interface ResolveDatabaseConnectionOptions {
  readonly home: string;
  readonly instanceName?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type PostgresExecFn = (
  file: string,
  args: readonly string[],
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly timeout?: number;
    readonly maxBuffer?: number;
    readonly windowsHide?: boolean;
  },
) => Promise<ExecResult>;

export interface V2DatabaseBackupOptions {
  readonly getHome: () => string;
  readonly installerDirectory?: string;
  readonly resourcesPath?: string;
  readonly log: Logger;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly exec?: PostgresExecFn;
  readonly exists?: (filePath: string) => boolean;
  readonly readdir?: (dirPath: string) => string[];
  readonly readFileText?: (filePath: string) => string | undefined;
}

export interface V2DatabaseBackupHooks {
  readonly backupDatabase: (appVersion: string) => Promise<string | undefined>;
  readonly restoreDatabase: (relFile: string) => Promise<void>;
}

const PG_TOOL_TIMEOUT_MS = 5 * 60_000;
const PG_TOOL_MAX_BUFFER = 16 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;

function safeReaddir(dirPath: string): string[] {
  try {
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}

function safeReadText(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function pinnedPostgresSha256(
  target: string,
  env: NodeJS.ProcessEnv,
  installerDirectory: string | undefined,
  readFileText: (filePath: string) => string | undefined,
): string | undefined {
  const extract = (sources: unknown): string | undefined => {
    if (!Array.isArray(sources)) return undefined;
    for (const item of sources) {
      const source = item as { target?: unknown; sha256?: unknown } | null;
      if (
        source?.target === target &&
        typeof source.sha256 === "string" &&
        SHA256_RE.test(source.sha256)
      ) {
        return source.sha256;
      }
    }
    return undefined;
  };

  const envRaw = env.LINGER_NATIVE_DEPENDENCIES_JSON?.trim();
  if (envRaw) {
    try {
      const found = extract(JSON.parse(envRaw));
      if (found) return found;
    } catch {
      // Ignore malformed env JSON and fall through to distribution metadata.
    }
  }

  if (installerDirectory) {
    const raw = readFileText(
      path.join(installerDirectory, "distribution.json"),
    );
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as {
          platform?: unknown;
          arch?: unknown;
          nativeSources?: unknown;
        };
        if (`${String(parsed.platform)}-${String(parsed.arch)}` === target) {
          const found = extract(parsed.nativeSources);
          if (found) return found;
        }
      } catch {
        // Ignore unreadable distribution metadata and scan component directories.
      }
    }
  }
  return undefined;
}

function withBundledPostgresEnv(
  baseEnv: NodeJS.ProcessEnv,
  binDir: string,
  platform: NodeJS.Platform,
  exists: (filePath: string) => boolean,
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...baseEnv };
  const pgRoot = path.dirname(binDir);
  const libDir = path.join(pgRoot, "lib");
  const hasLib = exists(libDir);
  const delimiter = platform === "win32" ? ";" : ":";

  if (platform === "win32") {
    let existingPath = nextEnv.PATH ?? "";
    for (const key of Object.keys(nextEnv)) {
      if (key !== "PATH" && key.toUpperCase() === "PATH") {
        if (!existingPath && nextEnv[key]) existingPath = nextEnv[key]!;
        delete nextEnv[key];
      }
    }
    const entries = [binDir, ...(hasLib ? [libDir] : [])];
    if (existingPath) entries.push(existingPath);
    nextEnv.PATH = entries.join(delimiter);
  } else if (platform === "darwin") {
    if (hasLib) {
      nextEnv.DYLD_LIBRARY_PATH = nextEnv.DYLD_LIBRARY_PATH
        ? `${libDir}${delimiter}${nextEnv.DYLD_LIBRARY_PATH}`
        : libDir;
    }
  } else if (platform === "linux") {
    if (hasLib) {
      nextEnv.LD_LIBRARY_PATH = nextEnv.LD_LIBRARY_PATH
        ? `${libDir}${delimiter}${nextEnv.LD_LIBRARY_PATH}`
        : libDir;
    }
  }
  return nextEnv;
}

/**
 * Resolves `pg_dump` or `pg_restore` in priority order:
 *   1. Explicit env override (`LINGER_PG_DUMP_BIN` / `LINGER_PG_RESTORE_BIN`)
 *   2. Bundled PostgreSQL `bin/` under `<home>/tools/native/components/`,
 *      packaged `resourcesPath`, or `<home>/infra/postgres/`, with matching
 *      dynamic library search paths (`LD_LIBRARY_PATH`, `DYLD_LIBRARY_PATH`,
 *      or Windows `PATH`).
 *   3. System `PATH` fallback.
 */
export function resolvePostgresTool(
  tool: PostgresToolName,
  options: ResolvePostgresToolOptions,
): ResolvedPostgresTool {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const listDir = options.readdir ?? safeReaddir;
  const readFileText = options.readFileText ?? safeReadText;

  const envKey =
    tool === "pg_dump" ? "LINGER_PG_DUMP_BIN" : "LINGER_PG_RESTORE_BIN";
  const envOverride = env[envKey]?.trim();
  if (envOverride) {
    return {
      executable: envOverride,
      source: "env",
      env: { ...env },
    };
  }

  const exe = platform === "win32" ? `${tool}.exe` : tool;
  const target = `${platform}-${arch}`;
  const candidateBinDirs: string[] = [];
  const seen = new Set<string>();
  const addBinDir = (dir: string) => {
    if (!seen.has(dir)) {
      seen.add(dir);
      candidateBinDirs.push(dir);
    }
  };

  const componentsRoot = path.join(
    options.home,
    "tools",
    "native",
    "components",
  );
  const pinnedSha = pinnedPostgresSha256(
    target,
    env,
    options.installerDirectory,
    readFileText,
  );
  if (pinnedSha) {
    if (platform === "win32") {
      addBinDir(path.join(componentsRoot, `${pinnedSha}-utf8`, "bin"));
    }
    addBinDir(path.join(componentsRoot, pinnedSha, "bin"));
  }

  if (options.resourcesPath) {
    addBinDir(path.join(options.resourcesPath, "postgres", "bin"));
    addBinDir(
      path.join(
        options.resourcesPath,
        "installer",
        "native",
        "postgres",
        "bin",
      ),
    );
    addBinDir(path.join(options.resourcesPath, "native", "postgres", "bin"));
  }

  const infraPostgresRoot = path.join(options.home, "infra", "postgres");
  addBinDir(path.join(infraPostgresRoot, "current", "bin"));
  const infraEntries = [...listDir(infraPostgresRoot)].sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true }),
  );
  for (const entry of infraEntries) {
    if (entry.startsWith(".") || entry === "current") continue;
    addBinDir(path.join(infraPostgresRoot, entry, "bin"));
  }

  const componentEntries = [...listDir(componentsRoot)]
    .filter(
      (entry) =>
        !entry.startsWith(".") &&
        !entry.startsWith("pending-") &&
        !entry.endsWith(".verified.json"),
    )
    .sort((a, b) => {
      if (platform === "win32") {
        const aUtf8 = a.endsWith("-utf8") ? 0 : 1;
        const bUtf8 = b.endsWith("-utf8") ? 0 : 1;
        if (aUtf8 !== bUtf8) return aUtf8 - bUtf8;
      }
      return b.localeCompare(a);
    });
  for (const entry of componentEntries) {
    addBinDir(path.join(componentsRoot, entry, "bin"));
  }

  for (const binDir of candidateBinDirs) {
    const candidate = path.join(binDir, exe);
    if (exists(candidate)) {
      return {
        executable: candidate,
        source: "bundled",
        env: withBundledPostgresEnv(env, binDir, platform, exists),
      };
    }
  }

  return {
    executable: tool,
    source: "path",
    env: { ...env },
  };
}

/**
 * Resolves PostgreSQL connection parameters without putting credentials in
 * process argv.
 *
 * Honors `TEAMHUB_DATABASE_URL` when explicitly set (moving its password to
 * `PGPASSWORD`), otherwise reads `<home>/instances/desktop/{instance.json,services.env}`.
 * Returns `undefined` when no local desktop instance exists (e.g. Thin Client).
 */
export async function resolveDatabaseConnection(
  options: ResolveDatabaseConnectionOptions,
): Promise<DatabaseConnectionConfig | undefined> {
  const env = options.env ?? process.env;
  const rawUrl = env.TEAMHUB_DATABASE_URL?.trim();
  if (rawUrl) {
    const parsed = new URL(rawUrl);
    const password = parsed.password
      ? decodeURIComponent(parsed.password)
      : undefined;
    const sanitized = new URL(rawUrl);
    sanitized.password = "";
    return {
      source: "env",
      args: ["--dbname", sanitized.toString()],
      ...(password ? { password } : {}),
    };
  }

  const instanceName = options.instanceName ?? "desktop";
  const instanceRoot = path.join(options.home, "instances", instanceName);

  let instanceRaw: string;
  try {
    instanceRaw = await readFile(
      path.join(instanceRoot, "instance.json"),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  let instanceJson: { source?: { ports?: { postgres?: unknown } } };
  try {
    instanceJson = JSON.parse(instanceRaw) as {
      source?: { ports?: { postgres?: unknown } };
    };
  } catch {
    return undefined;
  }
  const postgresPort = instanceJson?.source?.ports?.postgres;
  if (
    typeof postgresPort !== "number" ||
    !Number.isSafeInteger(postgresPort) ||
    postgresPort < 1024 ||
    postgresPort > 65535
  ) {
    return undefined;
  }

  let servicesEnvRaw: string;
  try {
    servicesEnvRaw = await readFile(
      path.join(instanceRoot, "services.env"),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const parsedEnv = parseEnv(servicesEnvRaw);
  const password = parsedEnv.LINGER_POSTGRES_PASSWORD?.trim();
  if (!password) {
    throw new Error(
      "Local instance services.env is missing LINGER_POSTGRES_PASSWORD",
    );
  }

  return {
    source: "local-instance",
    args: [
      "--host",
      "127.0.0.1",
      "--port",
      String(postgresPort),
      "--username",
      "simplexai",
      "--dbname",
      "simplexai",
    ],
    password,
    sslmode: "disable",
  };
}

export function redactDatabaseSecrets(text: string, password?: string): string {
  let result = text.replace(
    /(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s/]+@/gi,
    "$1[redacted]@",
  );
  if (password) {
    result = result.replaceAll(password, "[redacted]");
    const encoded = encodeURIComponent(password);
    if (encoded !== password) {
      result = result.replaceAll(encoded, "[redacted]");
    }
  }
  return result;
}

function extractErrorDetails(
  error: unknown,
  password?: string,
): {
  readonly code: string | number | undefined;
  readonly stderr: string;
  readonly summary: string;
} {
  const err = error as {
    code?: string | number;
    stderr?: string | Buffer;
    message?: string;
  };
  const rawStderr =
    typeof err?.stderr === "string"
      ? err.stderr
      : Buffer.isBuffer(err?.stderr)
        ? err.stderr.toString("utf8")
        : "";
  const stderr = redactDatabaseSecrets(rawStderr, password);
  const message = redactDatabaseSecrets(
    error instanceof Error ? error.message : String(error),
    password,
  );
  const lastLines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" ");
  return {
    code: err?.code,
    stderr,
    summary: lastLines || message,
  };
}

const defaultExec: PostgresExecFn = async (file, args, options) => {
  const result = await execFileAsync(file, [...args], {
    env: options.env,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    windowsHide: options.windowsHide ?? true,
    encoding: "utf8",
  });
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
};

/**
 * Creates dynamic `backupDatabase` and `restoreDatabase` hooks for
 * `ReleaseOrchestratorModule`. Evaluates `getHome()` and local instance config
 * lazily at invocation time so packaged Desktop builds never depend on
 * `process.env.TEAMHUB_DATABASE_URL` or system `PATH`.
 */
export function createV2DatabaseBackupHooks(
  options: V2DatabaseBackupOptions,
): V2DatabaseBackupHooks {
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? defaultExec;

  const buildSpawnEnv = (
    toolEnv: NodeJS.ProcessEnv,
    conn: DatabaseConnectionConfig,
  ): NodeJS.ProcessEnv => ({
    ...toolEnv,
    ...(conn.password ? { PGPASSWORD: conn.password } : {}),
    ...(conn.sslmode ? { PGSSLMODE: conn.sslmode } : {}),
    PGCONNECT_TIMEOUT: "10",
  });

  return {
    backupDatabase: async (appVersion: string): Promise<string | undefined> => {
      const home = options.getHome();
      const env = options.env ?? process.env;
      const conn = await resolveDatabaseConnection({ home, env });
      if (!conn) {
        options.log.info(
          "release_orchestrator.db_backup_skipped_no_local_instance",
          { appVersion },
        );
        return undefined;
      }

      const tool = resolvePostgresTool("pg_dump", {
        home,
        installerDirectory: options.installerDirectory,
        resourcesPath: options.resourcesPath,
        platform,
        arch: options.arch,
        env,
        exists: options.exists,
        readdir: options.readdir,
        readFileText: options.readFileText,
      });

      const safeVersion = appVersion.replace(/[^A-Za-z0-9._-]/g, "_");
      const relFile = path.posix.join(
        "instances",
        "desktop",
        "backups",
        `pre-${safeVersion}.dump`,
      );
      const absFile = resolveSafeHomePath(home, relFile);
      const backupsDir = path.dirname(absFile);
      await mkdir(backupsDir, { recursive: true, mode: 0o700 });
      if (platform !== "win32") {
        await chmod(backupsDir, 0o700);
        // Pre-create with 0o600 so dump contents are never world-readable while written.
        const handle = await open(absFile, "w", 0o600);
        await handle.close();
      }

      let backupErrorSummary: string | undefined;
      try {
        await exec(
          tool.executable,
          ["--format=custom", "--file", absFile, ...conn.args],
          {
            env: buildSpawnEnv(tool.env, conn),
            timeout: PG_TOOL_TIMEOUT_MS,
            maxBuffer: PG_TOOL_MAX_BUFFER,
            windowsHide: true,
          },
        );
      } catch (error) {
        await rm(absFile, { force: true }).catch(() => undefined);
        backupErrorSummary = extractErrorDetails(error, conn.password).summary;
      }
      if (backupErrorSummary !== undefined) {
        throw new Error(
          `Database backup (pg_dump) failed: ${backupErrorSummary}`,
        );
      }

      if (platform !== "win32") {
        await chmod(absFile, 0o600);
      }
      options.log.info("release_orchestrator.db_backed_up", {
        appVersion,
        file: relFile,
        toolSource: tool.source,
        connectionSource: conn.source,
      });
      return relFile;
    },

    restoreDatabase: async (relFile: string): Promise<void> => {
      const home = options.getHome();
      const env = options.env ?? process.env;
      const conn = await resolveDatabaseConnection({ home, env });
      if (!conn) {
        options.log.info(
          "release_orchestrator.db_restore_skipped_no_local_instance",
          { file: relFile },
        );
        return;
      }

      const tool = resolvePostgresTool("pg_restore", {
        home,
        installerDirectory: options.installerDirectory,
        resourcesPath: options.resourcesPath,
        platform,
        arch: options.arch,
        env,
        exists: options.exists,
        readdir: options.readdir,
        readFileText: options.readFileText,
      });

      const absFile = resolveSafeHomePath(home, relFile);
      let restoreErrorSummary: string | undefined;
      try {
        await exec(
          tool.executable,
          ["--clean", "--if-exists", "--no-owner", ...conn.args, absFile],
          {
            env: buildSpawnEnv(tool.env, conn),
            timeout: PG_TOOL_TIMEOUT_MS,
            maxBuffer: PG_TOOL_MAX_BUFFER,
            windowsHide: true,
          },
        );
      } catch (error) {
        const { code, stderr, summary } = extractErrorDetails(
          error,
          conn.password,
        );
        // pg_restore exits 1 when non-fatal schema notices (such as pre-existing
        // extensions or the public schema) are ignored; genuine spawn, connection,
        // or auth failures must surface clearly without leaking credentials.
        if (code === 1 && /errors ignored on restore/i.test(stderr)) {
          options.log.warn("release_orchestrator.pg_restore_notice", {
            file: relFile,
            detail: summary,
          });
          return;
        }
        restoreErrorSummary = summary;
      }
      if (restoreErrorSummary !== undefined) {
        throw new Error(
          `Database restore (pg_restore) failed: ${restoreErrorSummary}`,
        );
      }

      options.log.info("release_orchestrator.db_restored", {
        file: relFile,
        toolSource: tool.source,
        connectionSource: conn.source,
      });
    },
  };
}
