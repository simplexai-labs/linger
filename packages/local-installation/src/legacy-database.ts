import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { unprovisionLocalAccount } from "./account.js";
import { renameRetrying } from "./fs-retry.js";
import { privateDirectory } from "./private-files.js";

// Every Linger release applies TeamHub's schema from this baseline
// (apps/teamhub/migrations/00852_baseline.sql), which refuses a database
// that already holds a TeamHub schema. Only the desktop app from before the
// rename to Linger made such a database without the baseline.
export const TEAMHUB_BASELINE_VERSION = 852;

const PUBLIC_ACCOUNTS_SQL = "to_regclass('public.accounts') IS NOT NULL";
const PUBLIC_GOOSE_VERSION_SQL =
  "to_regclass('public.goose_db_version') IS NOT NULL";
const TEAMHUB_BASELINE_APPLIED_SQL = `EXISTS (SELECT 1 FROM public.goose_db_version WHERE version_id = ${TEAMHUB_BASELINE_VERSION} AND is_applied)`;

// Combined readiness, database-existence, and pre-Linger schema probe for
// an already-initialized cluster. Connecting directly to `simplexai` proves
// server readiness and database existence in one subprocess, while `\gset`
// and `\if` avoid touching `public.goose_db_version` when it does not exist.
export const WARM_DATABASE_PROBE_SQL = [
  `SELECT ${PUBLIC_ACCOUNTS_SQL} AS has_accounts, ${PUBLIC_GOOSE_VERSION_SQL} AS has_versions \\gset`,
  "\\if :has_accounts",
  "\\if :has_versions",
  `SELECT CASE WHEN ${TEAMHUB_BASELINE_APPLIED_SQL} THEN 'linger' ELSE 'legacy' END;`,
  "\\else",
  "SELECT 'legacy';",
  "\\endif",
  "\\else",
  "SELECT 'empty';",
  "\\endif",
  "",
].join("\n");

export type WarmDatabaseProbeResult = "linger" | "empty" | "legacy";

export function parseWarmDatabaseProbe(
  stdout: string,
): WarmDatabaseProbeResult | undefined {
  const state = stdout.trim();
  return state === "linger" || state === "empty" || state === "legacy"
    ? state
    : undefined;
}

// Whether the database holds a TeamHub schema that the baseline never
// created, so no migration can ever apply to it. `query` returns psql's
// unaligned output for one statement.
export async function preLingerSchema(
  query: (sql: string) => Promise<string>,
): Promise<boolean> {
  const [accounts, versions] = (
    await query(`SELECT ${PUBLIC_ACCOUNTS_SQL}, ${PUBLIC_GOOSE_VERSION_SQL}`)
  )
    .trim()
    .split("|");
  if (accounts !== "t") return false;
  if (versions !== "t") return true;
  return (await query(`SELECT ${TEAMHUB_BASELINE_APPLIED_SQL}`)).trim() !== "t";
}

// The instance data that belongs to a database. A database from before
// Linger moves into one timestamped folder with them, and nothing is deleted.
const LEGACY_DATA = [
  ["data/agent", "agent"],
  ["data/artifacts", "artifacts"],
  ["computer-enrollment.token", "computer-enrollment.token"],
] as const;

const BACKUP_PREFIX = "simplex-backup-";

async function exists(file: string): Promise<boolean> {
  return lstat(file).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return false;
    },
  );
}

async function emptyDirectory(directory: string): Promise<boolean> {
  return readdir(directory).then(
    (names) => names.length === 0,
    () => false,
  );
}

// A run that stopped before the database moved left a folder without it;
// the rest goes there too, so the person is shown one folder with all of
// it. Only empty directories that run made again may meet a moved entry.
async function unfinishedBackup(root: string): Promise<string | undefined> {
  const latest = await latestLegacyBackup(root);
  if (!latest || (await exists(path.join(latest, "postgres-data"))))
    return undefined;
  for (const [from, to] of LEGACY_DATA) {
    const source = path.join(root, from);
    if (
      (await exists(source)) &&
      (await exists(path.join(latest, to))) &&
      !(await emptyDirectory(source))
    )
      return undefined;
  }
  return latest;
}

// Moves the database and its data into a folder in the instance and leaves
// empty places for a fresh database; returns the folder.
export async function setAsideLegacyData(
  root: string,
  signal: AbortSignal,
  now = new Date(),
): Promise<string> {
  const backup =
    (await unfinishedBackup(root)) ??
    path.join(
      root,
      `${BACKUP_PREFIX}${now.toISOString().replace(/[:.]/g, "-")}`,
    );
  const move = async (from: string, to: string) => {
    const source = path.join(root, from);
    const target = path.join(backup, to);
    if (!(await exists(source))) return;
    // An empty place an earlier run made again stays for the fresh data.
    if ((await exists(target)) && (await emptyDirectory(source))) return;
    await renameRetrying(source, target, { signal });
  };
  // The fresh database has no owner; the saved credentials create it again.
  await unprovisionLocalAccount(root);
  await privateDirectory(backup);
  for (const [from, to] of LEGACY_DATA) await move(from, to);
  await Promise.all(
    ["data/agent", "data/artifacts"].map((directory) =>
      privateDirectory(path.join(root, directory)),
    ),
  );
  // Last: while the database is in place, a run that stopped partway finds
  // it again and finishes the move.
  await move("native/postgres-data", "postgres-data");
  return backup;
}

// The folder the latest database from before Linger went to, if any. The
// desktop tells the person about it once and enrolls its Computer again.
export async function latestLegacyBackup(
  root: string,
): Promise<string | undefined> {
  const names = await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return [];
  });
  const latest = names
    .filter((name) => name.startsWith(BACKUP_PREFIX))
    .sort()
    .at(-1);
  return latest && path.join(root, latest);
}
