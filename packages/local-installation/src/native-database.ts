import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  atomicPrivate,
  privateDirectory,
  readPrivate,
  type Instance,
} from "./instance.js";
import { removeRetrying, renameRetrying } from "./fs-retry.js";
import {
  inspectNativeProcess,
  startNativeProcess,
  stopNativeProcess,
} from "./native-process.js";
import { preLingerSchema, setAsideLegacyData } from "./legacy-database.js";
import { runProcess } from "./process.js";
import { excerptLine, redact } from "./redaction.js";
import { parseEnv } from "node:util";

/** The PostgreSQL program `name` in `bin`, with `.exe` on Windows. */
export function postgresProgram(
  bin: string,
  name: string,
  platform: NodeJS.Platform = process.platform,
) {
  return path.join(bin, platform === "win32" ? `${name}.exe` : name);
}

// postgres.exe refuses to run with an elevated token ("Run as administrator",
// the built-in Administrator, or an administrator account with UAC off), so
// such a token starts it with Administrators disabled, as pg_ctl does.
// Elevated tokens carry the High (or System) mandatory label, which `whoami`
// names by SID in every language.
export async function windowsElevated(
  run: typeof runProcess = runProcess,
): Promise<boolean> {
  const whoami = path.win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "whoami.exe",
  );
  const result = await run(whoami, ["/groups", "/fo", "csv", "/nh"], {
    timeoutMs: 10_000,
  }).catch(() => undefined);
  return (
    result?.code === 0 && /S-1-16-(12288|16384)\b/.test(result.stdout ?? "")
  );
}

// Slow HDDs and Windows antivirus scanning can hold PostgreSQL in initial
// data-directory fsync past 30 seconds while the server process stays alive.
const POSTGRES_READY_TIMEOUT_MS = 120_000;
const POSTGRES_READY_PROGRESS_MS = 15_000;

// Prepares the instance's private PostgreSQL. A database from before Linger
// is set aside with its data for a fresh one, and `legacyBackup` names the
// folder it went to.
export async function prepareNativeDatabase(options: {
  instance: Instance;
  postgresBin: string;
  postgresConfigurationExecutable?: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onOutput: (chunk: string) => void;
}): Promise<{ legacyBackup?: string }> {
  const { instance, postgresBin, signal } = options;
  if (process.getuid?.() === 0)
    throw new Error(
      "Native PostgreSQL must run as a normal user; run Linger without sudo.",
    );
  const withoutAdministrators =
    process.platform === "win32" && (await windowsElevated());
  if (!instance.source || instance.mode !== "source-native")
    throw new Error("Native database needs a native source instance");
  const port = instance.source.ports.postgres;
  const data = path.join(instance.root, "native/postgres-data");
  const passwordFile = path.join(instance.root, "native/postgres-password");
  await privateDirectory(data);
  const password = parseEnv(
    (await readPrivate(path.join(instance.root, "services.env")))!,
  ).LINGER_POSTGRES_PASSWORD!;
  await atomicPrivate(passwordFile, `${password}\n`);
  const env = { ...options.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: "3" };
  const command = async (name: string, args: string[], timeoutMs = 60_000) => {
    const result = await runProcess(postgresProgram(postgresBin, name), args, {
      env,
      signal,
      timeoutMs,
      onOutput: options.onOutput,
    });
    if (result.code !== 0) {
      // The program's own last lines are what the person and the report need:
      // "inspect the log" alone sends them looking for a file in a directory
      // they were never told about. The password never appears here, and the
      // window is five lines because initdb ends with cleanup lines such as
      // "removing data directory" that would otherwise push out its FATAL one.
      const detail = redact(
        result.stderr
          .replaceAll(password, "[redacted]")
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(-5)
          .map((line) => excerptLine(line))
          .join(" "),
      ).replace(/[.;]+$/u, "");
      throw new Error(
        `Native PostgreSQL ${name} failed${detail ? `: ${detail}` : ""}. Inspect the instance log.`,
      );
    }
    return result;
  };
  const open = async () => {
    let initialized = false;
    try {
      const version = path.join(data, "PG_VERSION");
      const info = await lstat(version);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (await readFile(version, "utf8")).trim() !== "17"
      )
        throw new Error(
          "This native instance contains an unsupported PostgreSQL data directory.",
        );
      // Only a started postmaster writes postmaster.opts; initdb does not. A
      // directory without it never served a connection and holds no data, as
      // when an earlier initdb was killed after writing PG_VERSION, so it is
      // made again rather than left to fail every start.
      initialized = await lstat(path.join(data, "postmaster.opts")).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return false;
        },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!initialized) {
      // A forced kill (Windows ends the tree on timeout or cancel) leaves
      // initdb no time to clean up, so it builds aside and its directory
      // becomes the data directory only once it succeeded.
      const pending = `${data}.partial`;
      await removeRetrying(pending);
      await privateDirectory(pending);
      await command(
        "initdb",
        [
          "--pgdata",
          pending,
          "--username",
          "simplexai",
          "--pwfile",
          passwordFile,
          "--auth-host",
          "scram-sha-256",
          "--auth-local",
          "scram-sha-256",
          "--encoding",
          "UTF8",
          "--no-locale",
        ],
        // Antivirus scanning of the new files can make it take minutes.
        10 * 60_000,
      );
      await removeRetrying(data);
      await renameRetrying(pending, data, { signal });
    }
    await startNativeProcess({
      root: instance.root,
      name: "postgres",
      executable: postgresProgram(postgresBin, "postgres"),
      configurationExecutable: options.postgresConfigurationExecutable,
      args: [
        "-D",
        data,
        "-h",
        "127.0.0.1",
        "-p",
        String(port),
        "-k",
        "",
        "-c",
        "max_connections=100",
        "-c",
        "shared_buffers=128MB",
        "-c",
        "jit=off",
      ],
      cwd: instance.root,
      env,
      signal,
      redactions: [password],
      withoutAdministrators,
      // A release that repins the PostgreSQL archive unpacks it into a new
      // component folder, so the server an earlier release left running
      // differs only in its executable path. The new server opens the same
      // data directory: on macOS and Linux the stop is a fast shutdown; on
      // Windows it terminates the server, which recovers from its WAL on
      // start, as after any Windows stop.
      restartOnConfigurationChange: true,
    });
    const connection = [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--username",
      "simplexai",
      "--dbname",
      "postgres",
    ];
    const startedAt = Date.now();
    const deadline = startedAt + POSTGRES_READY_TIMEOUT_MS;
    let nextProgressAt = startedAt + POSTGRES_READY_PROGRESS_MS;
    for (;;) {
      signal.throwIfAborted();
      if (!(await inspectNativeProcess(instance.root, "postgres")).running)
        throw new Error("Native PostgreSQL stopped; inspect its instance log.");
      const ready = await runProcess(
        postgresProgram(postgresBin, "pg_isready"),
        connection,
        { env, signal, timeoutMs: 5_000 },
      );
      if (ready.code === 0) break;
      const now = Date.now();
      if (now >= deadline)
        throw new Error(
          `Native PostgreSQL did not become ready within ${Math.round(POSTGRES_READY_TIMEOUT_MS / 1000)}s (pg_isready exit ${ready.code}); inspect its instance log.`,
        );
      if (now >= nextProgressAt) {
        options.onOutput(
          `Waiting for native PostgreSQL to become ready (${Math.floor((now - startedAt) / 1000)}s elapsed)...\n`,
        );
        nextProgressAt = now + POSTGRES_READY_PROGRESS_MS;
      }
      await delay(200, undefined, { signal });
    }
    const present = await command("psql", [
      ...connection,
      "--tuples-only",
      "--no-align",
      "--command",
      "SELECT 1 FROM pg_database WHERE datname='simplexai'",
    ]);
    if (present.stdout.trim() !== "1")
      await command("createdb", [
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--username",
        "simplexai",
        "simplexai",
      ]);
  };
  await open();
  const query = async (sql: string) =>
    (
      await command("psql", [
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--username",
        "simplexai",
        "--dbname",
        "simplexai",
        "--tuples-only",
        "--no-align",
        "--command",
        sql,
      ])
    ).stdout;
  if (!(await preLingerSchema(query))) return {};
  await stopNativeProcess(instance.root, "postgres");
  const legacyBackup = await setAsideLegacyData(instance.root, signal);
  await privateDirectory(data);
  await open();
  return { legacyBackup };
}
