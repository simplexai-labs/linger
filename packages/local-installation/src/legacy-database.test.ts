import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLocalLogin } from "./account.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  latestLegacyBackup,
  parseWarmDatabaseProbe,
  preLingerSchema,
  setAsideLegacyData,
  TEAMHUB_BASELINE_VERSION,
  WARM_DATABASE_PROBE_SQL,
} from "./legacy-database.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporary(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "linger-legacy-db-"));
  roots.push(root);
  return root;
}

async function put(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, contents, { mode: 0o600 });
}

// Answers the detection queries as psql would for a database whose tables
// and applied goose versions are given.
function database(tables: string[], versions: number[] = []) {
  const asked: string[] = [];
  const query = async (sql: string) => {
    asked.push(sql);
    if (sql.includes("to_regclass"))
      return `${tables.includes("accounts") ? "t" : "f"}|${
        tables.includes("goose_db_version") ? "t" : "f"
      }\n`;
    return versions.includes(TEAMHUB_BASELINE_VERSION) ? "t\n" : "f\n";
  };
  return { query, asked };
}

describe("preLingerSchema", () => {
  it("leaves a new, empty database to the migrations", async () => {
    const { query, asked } = database([]);
    expect(await preLingerSchema(query)).toBe(false);
    expect(asked).toHaveLength(1);
  });

  it("leaves a database that Linger migrated before", async () => {
    const { query } = database(
      ["accounts", "goose_db_version"],
      [0, TEAMHUB_BASELINE_VERSION, 853],
    );
    expect(await preLingerSchema(query)).toBe(false);
  });

  // A migration killed inside the baseline rolls back with it, leaving
  // only the version table; the next run applies the baseline again.
  it("leaves a database whose baseline has not run yet", async () => {
    const { query } = database(["goose_db_version"], [0]);
    expect(await preLingerSchema(query)).toBe(false);
  });

  it("finds a TeamHub schema that the baseline did not make", async () => {
    expect(
      await preLingerSchema(
        database(["accounts", "goose_db_version"], [0, 851]).query,
      ),
    ).toBe(true);
    expect(await preLingerSchema(database(["accounts"]).query)).toBe(true);
  });

  it("names the version of the baseline migration that guards it", () => {
    const baseline = fileURLToPath(
      new URL(
        `../../../apps/teamhub/migrations/00${TEAMHUB_BASELINE_VERSION}_baseline.sql`,
        import.meta.url,
      ),
    );
    expect(existsSync(baseline)).toBe(true);
  });
});

describe("warm database probe", () => {
  it("parses valid warm probe tokens and rejects empty or unexpected output", () => {
    expect(parseWarmDatabaseProbe("linger\n")).toBe("linger");
    expect(parseWarmDatabaseProbe("  empty \r\n")).toBe("empty");
    expect(parseWarmDatabaseProbe("legacy")).toBe("legacy");
    expect(parseWarmDatabaseProbe("")).toBeUndefined();
    expect(parseWarmDatabaseProbe("   \n")).toBeUndefined();
    expect(parseWarmDatabaseProbe("unexpected\n")).toBeUndefined();
    expect(parseWarmDatabaseProbe("linger\nlegacy\n")).toBeUndefined();
  });

  it("uses the exact same schema and baseline predicates as preLingerSchema", async () => {
    const { query, asked } = database(
      ["accounts", "goose_db_version"],
      [0, TEAMHUB_BASELINE_VERSION],
    );
    expect(await preLingerSchema(query)).toBe(false);
    expect(asked).toHaveLength(2);
    const [tablesQuery, baselineQuery] = asked;
    // Extract the predicate expressions from preLingerSchema's queries so any
    // divergence between preLingerSchema and WARM_DATABASE_PROBE_SQL fails here.
    const tablePredicates = tablesQuery!
      .replace(/^SELECT\s+/u, "")
      .split(",")
      .map((predicate) => predicate.trim());
    const baselinePredicate = baselineQuery!.replace(/^SELECT\s+/u, "").trim();
    for (const predicate of tablePredicates) {
      expect(WARM_DATABASE_PROBE_SQL).toContain(predicate);
    }
    expect(WARM_DATABASE_PROBE_SQL).toContain(baselinePredicate);
    expect(WARM_DATABASE_PROBE_SQL).toContain(
      `version_id = ${TEAMHUB_BASELINE_VERSION}`,
    );
  });
});

describe("setAsideLegacyData", () => {
  it("moves the database and its data into one backup and keeps the account", async () => {
    const root = await temporary();
    await put(path.join(root, "native/postgres-data/PG_VERSION"), "17\n");
    await put(path.join(root, "native/postgres-password"), "secret\n");
    await put(path.join(root, "data/agent/agent_1/state.json"), "{}");
    await put(path.join(root, "computer-enrollment.token"), "token\n");
    const account = {
      email: "owner@linger.local",
      password: "a-private-password",
      provisioned: true,
    };
    await put(path.join(root, "local-account.json"), JSON.stringify(account));

    const backup = await setAsideLegacyData(
      root,
      new AbortController().signal,
      new Date("2026-11-17T03:04:05.678Z"),
    );

    expect(backup).toBe(
      path.join(root, "simplex-backup-2026-11-17T03-04-05-678Z"),
    );
    expect(
      await readFile(path.join(backup, "postgres-data/PG_VERSION"), "utf8"),
    ).toBe("17\n");
    expect(existsSync(path.join(backup, "agent/agent_1/state.json"))).toBe(
      true,
    );
    expect(existsSync(path.join(backup, "computer-enrollment.token"))).toBe(
      true,
    );
    // Absent before, so nothing to move.
    expect(existsSync(path.join(backup, "artifacts"))).toBe(false);
    expect(existsSync(path.join(root, "native/postgres-data"))).toBe(false);
    expect(existsSync(path.join(root, "computer-enrollment.token"))).toBe(
      false,
    );
    expect(existsSync(path.join(root, "native/postgres-password"))).toBe(true);
    expect(existsSync(path.join(root, "data/agent/agent_1"))).toBe(false);
    expect(existsSync(path.join(root, "data/artifacts"))).toBe(true);
    // The fresh database gets the same owner again.
    expect(
      JSON.parse(await readFile(path.join(root, "local-account.json"), "utf8")),
    ).toEqual({ ...account, provisioned: false });
    await expect(readLocalLogin({ root })).rejects.toThrow(
      "The local account file is invalid or the account has not been created.",
    );
    expect(await latestLegacyBackup(root)).toBe(backup);
  });

  it("keeps the database in place until the end, so a rerun finishes a stopped move in the same folder", async () => {
    const root = await temporary();
    await put(path.join(root, "native/postgres-data/PG_VERSION"), "17\n");
    await put(path.join(root, "data/agent/agent_1/state.json"), "{}");
    await put(path.join(root, "data/artifacts/a.txt"), "a");
    const account = {
      email: "owner@linger.local",
      password: "a-private-password",
      provisioned: true,
    };
    await put(path.join(root, "local-account.json"), JSON.stringify(account));
    const first = path.join(root, "simplex-backup-2026-11-17T03-04-05-678Z");
    // A non-empty directory where the artifacts go makes their move fail,
    // as a locked file or a cancelled install would.
    await put(path.join(first, "artifacts/x"), "");

    await expect(
      setAsideLegacyData(
        root,
        new AbortController().signal,
        new Date("2026-11-17T03:04:05.678Z"),
      ),
    ).rejects.toThrow();
    expect(existsSync(path.join(root, "native/postgres-data/PG_VERSION"))).toBe(
      true,
    );
    expect(existsSync(path.join(first, "agent/agent_1/state.json"))).toBe(true);
    expect(
      JSON.parse(await readFile(path.join(root, "local-account.json"), "utf8")),
    ).toEqual({ ...account, provisioned: false });

    // The lock is gone on the next run.
    await rm(path.join(first, "artifacts"), { recursive: true });
    const backup = await setAsideLegacyData(
      root,
      new AbortController().signal,
      new Date("2026-11-17T03:05:00.000Z"),
    );
    expect(backup).toBe(first);
    expect(existsSync(path.join(backup, "postgres-data/PG_VERSION"))).toBe(
      true,
    );
    expect(existsSync(path.join(backup, "artifacts/a.txt"))).toBe(true);
    expect(existsSync(path.join(root, "native/postgres-data"))).toBe(false);
    expect(existsSync(path.join(root, "data/agent"))).toBe(true);
  });

  it("finishes in the same folder after only the database failed to move", async () => {
    const root = await temporary();
    const first = path.join(root, "simplex-backup-2026-11-17T03-04-05-678Z");
    // The earlier run moved everything else and made empty places again.
    await put(path.join(first, "agent/agent_1/state.json"), "{}");
    await mkdir(path.join(root, "data/agent"), { recursive: true });
    await put(path.join(root, "native/postgres-data/PG_VERSION"), "17\n");

    expect(await setAsideLegacyData(root, new AbortController().signal)).toBe(
      first,
    );
    expect(existsSync(path.join(first, "postgres-data/PG_VERSION"))).toBe(true);
    expect(existsSync(path.join(first, "agent/agent_1/state.json"))).toBe(true);
    expect(existsSync(path.join(root, "data/agent"))).toBe(true);
  });

  it("starts a new folder after a finished backup or when entries would meet", async () => {
    const root = await temporary();
    await mkdir(
      path.join(root, "simplex-backup-2026-11-17T03-04-05-678Z/postgres-data"),
      { recursive: true },
    );
    await put(path.join(root, "native/postgres-data/PG_VERSION"), "17\n");
    const later = await setAsideLegacyData(
      root,
      new AbortController().signal,
      new Date("2026-11-18T00:00:00.000Z"),
    );
    expect(later).toBe(
      path.join(root, "simplex-backup-2026-11-18T00-00-00-000Z"),
    );

    await rm(path.join(later, "postgres-data"), { recursive: true });
    await put(path.join(later, "agent/old.json"), "{}");
    await put(path.join(root, "data/agent/new.json"), "{}");
    await put(path.join(root, "native/postgres-data/PG_VERSION"), "17\n");
    const newest = await setAsideLegacyData(
      root,
      new AbortController().signal,
      new Date("2026-11-19T00:00:00.000Z"),
    );
    expect(newest).toBe(
      path.join(root, "simplex-backup-2026-11-19T00-00-00-000Z"),
    );
    expect(existsSync(path.join(newest, "agent/new.json"))).toBe(true);
  });
});

describe("latestLegacyBackup", () => {
  it("names the newest backup, and none without one", async () => {
    const root = await temporary();
    expect(await latestLegacyBackup(root)).toBeUndefined();
    expect(
      await latestLegacyBackup(path.join(root, "missing")),
    ).toBeUndefined();
    for (const name of [
      "simplex-backup-2026-11-17T03-04-05-678Z",
      "simplex-backup-2026-12-01T00-00-00-000Z",
      "native",
    ])
      await mkdir(path.join(root, name));
    expect(await latestLegacyBackup(root)).toBe(
      path.join(root, "simplex-backup-2026-12-01T00-00-00-000Z"),
    );
  });
});
