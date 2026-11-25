import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";

const fsHooks = vi.hoisted(() => ({
  wrapReadStream: undefined as
    | ((file: string, stream: Readable) => Readable)
    | undefined,
  onCreateWriteStream: undefined as
    | ((
        file: string,
        stream: ReturnType<typeof import("node:fs").createWriteStream>,
      ) => void)
    | undefined,
  onRm: undefined as ((target: string) => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args);
      return fsHooks.wrapReadStream
        ? fsHooks.wrapReadStream(String(args[0]), stream)
        : stream;
    },
    createWriteStream: (
      ...args: Parameters<typeof actual.createWriteStream>
    ) => {
      const stream = actual.createWriteStream(...args);
      fsHooks.onCreateWriteStream?.(String(args[0]), stream);
      return stream;
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: (...args: Parameters<typeof actual.rm>) => {
      fsHooks.onRm?.(String(args[0]));
      return actual.rm(...args);
    },
  };
});

import {
  checkTeamhubBinaries,
  installTeamhubBinaries,
  parseTeamhubBinaries,
  TEAMHUB_BINARY_DIRECTORY,
  TEAMHUB_COMMANDS,
  teamhubBinaryStampsFile,
} from "./teamhub-binaries.js";

const roots: string[] = [];
afterEach(async () => {
  fsHooks.wrapReadStream = undefined;
  fsHooks.onCreateWriteStream = undefined;
  fsHooks.onRm = undefined;
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const sourceArchiveSha256 = "c".repeat(64);
const target = "win32-x64";

// A desktop build's binaries for `target`, as build-teamhub.mjs writes them.
async function bundle() {
  const root = await mkdtemp(path.join(tmpdir(), "teamhub-binaries-"));
  roots.push(root);
  const from = path.join(root, "native/teamhub-win32-x64");
  const repo = path.join(root, "source");
  await mkdir(from, { recursive: true });
  await mkdir(repo);
  const binaries: Record<string, object> = {};
  for (const command of TEAMHUB_COMMANDS) {
    const body = `${command} for windows`;
    await writeFile(path.join(from, `${command}.exe`), body);
    binaries[command] = {
      file: `${command}.exe`,
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: body.length,
    };
  }
  const manifest = {
    target,
    sourceCommit: "d".repeat(40),
    sourceArchiveSha256,
    goVersion: "1.26.5",
    binaries,
  };
  await writeFile(path.join(from, "manifest.json"), JSON.stringify(manifest));
  return { from, repo, manifest };
}

test("copies the binaries of its own source package into the source", async () => {
  const f = await bundle();
  const expected = { target, sourceArchiveSha256 };
  expect(await installTeamhubBinaries(f.from, f.repo, expected)).toBe(
    "installed",
  );
  const directory = path.join(f.repo, TEAMHUB_BINARY_DIRECTORY);
  expect(await readFile(path.join(directory, "teamhub.exe"), "utf8")).toBe(
    "teamhub for windows",
  );
  expect(
    JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")),
  ).toEqual(f.manifest);
  expect(await installTeamhubBinaries(f.from, f.repo, expected)).toBe(
    "current",
  );
  expect(await checkTeamhubBinaries(f.repo, target)).toBe("verified");
  // A build without them leaves Native to compile.
  expect(
    await installTeamhubBinaries(path.join(f.from, "none"), f.repo, expected),
  ).toBe("absent");
});

test.each(["missing", "truncated", "same-sized change"])(
  "repairs a %s installed binary even when its manifest is current",
  async (damage) => {
    const f = await bundle();
    const expected = { target, sourceArchiveSha256 };
    await installTeamhubBinaries(f.from, f.repo, expected);
    const file = path.join(f.repo, TEAMHUB_BINARY_DIRECTORY, "teamhub.exe");
    if (damage === "missing") await rm(file);
    else
      await writeFile(
        file,
        damage === "truncated" ? "teamhub" : "teamhub for windowz",
      );
    expect(await installTeamhubBinaries(f.from, f.repo, expected)).toBe(
      "installed",
    );
    expect(await readFile(file, "utf8")).toBe("teamhub for windows");
    expect(await checkTeamhubBinaries(f.repo, target)).toBe("verified");
    expect(await installTeamhubBinaries(f.from, f.repo, expected)).toBe(
      "current",
    );
  },
);

test("refuses binaries of another target or source package", async () => {
  const f = await bundle();
  await expect(
    installTeamhubBinaries(f.from, f.repo, {
      target: "linux-x64",
      sourceArchiveSha256,
    }),
  ).rejects.toThrow("are for win32-x64, not linux-x64");
  await expect(
    installTeamhubBinaries(f.from, f.repo, {
      target,
      sourceArchiveSha256: "e".repeat(64),
    }),
  ).rejects.toThrow("built from another source package");
  expect(existsSync(path.join(f.repo, TEAMHUB_BINARY_DIRECTORY))).toBe(false);
});

test("a binary that does not match leaves no manifest behind", async () => {
  const f = await bundle();
  await writeFile(path.join(f.from, "account.exe"), "account for windowz");
  await expect(
    installTeamhubBinaries(f.from, f.repo, { target, sourceArchiveSha256 }),
  ).rejects.toThrow("account.exe does not match");
  expect(existsSync(path.join(f.repo, TEAMHUB_BINARY_DIRECTORY))).toBe(false);
  expect(await checkTeamhubBinaries(f.repo, target)).toBe("absent");
});

test("check removes binaries for another computer or that changed", async () => {
  const f = await bundle();
  await installTeamhubBinaries(f.from, f.repo, { target, sourceArchiveSha256 });
  expect(await checkTeamhubBinaries(f.repo, "linux-x64")).toBe("removed");
  expect(existsSync(path.join(f.repo, TEAMHUB_BINARY_DIRECTORY))).toBe(false);
  await installTeamhubBinaries(f.from, f.repo, { target, sourceArchiveSha256 });
  await writeFile(
    path.join(f.repo, TEAMHUB_BINARY_DIRECTORY, "teamhub.exe"),
    "changed",
  );
  expect(await checkTeamhubBinaries(f.repo, target)).toBe("removed");
});

test("a manifest names only plain files", () => {
  const binary = { sha256: "f".repeat(64), bytes: 1 };
  const manifest = (file: string) => ({
    target,
    sourceCommit: "d".repeat(40),
    sourceArchiveSha256,
    goVersion: "1.26.5",
    binaries: Object.fromEntries(
      TEAMHUB_COMMANDS.map((command) => [command, { ...binary, file }]),
    ),
  });
  expect(() => parseTeamhubBinaries(manifest("teamhub.exe"))).not.toThrow();
  for (const file of ["../teamhub.exe", "bin/teamhub", "C:teamhub.exe"])
    expect(() => parseTeamhubBinaries(manifest(file))).toThrow(
      "Invalid TeamHub binary manifest.",
    );
});

test("skips re-hashing settled binaries while detecting same-size backdated tampering via ctime", async () => {
  const f = await bundle();
  const expected = { target, sourceArchiveSha256 };
  const dir = path.join(f.repo, TEAMHUB_BINARY_DIRECTORY);
  expect(await installTeamhubBinaries(f.from, f.repo, expected)).toBe(
    "installed",
  );
  const stampFile = `${dir}.verified.json`;
  expect(existsSync(stampFile)).toBe(true);
  const past = new Date(Date.now() - 10_000);
  const recorded = JSON.parse(await readFile(stampFile, "utf8")) as {
    digest: string;
    stamps: Record<string, [number, number, number]>;
  };
  const baseNow = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(baseNow + 10_000);
  // Warm repeat check stays verified and leaves existing stamps intact without re-hashing.
  expect(await checkTeamhubBinaries(f.repo, target)).toBe("verified");
  expect(JSON.parse(await readFile(stampFile, "utf8"))).toEqual(recorded);

  // Overwrite with identical length and backdate mtime; ctime still invalidates the stamp.
  const file = path.join(dir, "teamhub.exe");
  await writeFile(file, "teamhub for windowz");
  await utimes(file, past, past);
  expect(await checkTeamhubBinaries(f.repo, target)).toBe("removed");
  expect(existsSync(stampFile)).toBe(false);
});

test("installTeamhubBinaries drains sibling streams before removing destination on partial failure and supports AbortSignal", async () => {
  const f = await bundle();
  const dir = path.join(f.repo, TEAMHUB_BINARY_DIRECTORY);
  const stampFile = teamhubBinaryStampsFile(dir);

  const holdMigrateStream = () => {
    const hold = new PassThrough();
    let writeClosed = false;
    let resolveWriteOpened!: () => void;
    const writeOpened = new Promise<void>((resolve) => {
      resolveWriteOpened = resolve;
    });
    fsHooks.wrapReadStream = (file, stream) => {
      if (!file.endsWith("migrate.exe")) return stream;
      stream.destroy();
      return hold;
    };
    fsHooks.onCreateWriteStream = (file, stream) => {
      if (!file.endsWith("migrate.exe")) return;
      resolveWriteOpened();
      stream.once("close", () => {
        writeClosed = true;
      });
    };
    return {
      hold,
      writeOpened,
      isWriteClosed: () => writeClosed,
    };
  };

  // Tamper teamhub bytes keeping identical size so teamhub fails checksum while
  // migrate's write stream is still open.
  await writeFile(path.join(f.from, "teamhub.exe"), "TEAMHUB for windows");
  const migrateBody = await readFile(path.join(f.from, "migrate.exe"));
  const phase1 = holdMigrateStream();
  let teamhubClosed!: () => void;
  const waitTeamhubClosed = new Promise<void>((resolve) => {
    teamhubClosed = resolve;
  });
  const rmOrder: string[] = [];
  let copyStarted = false;
  const baseWriteHook = fsHooks.onCreateWriteStream!;
  fsHooks.onCreateWriteStream = (file, stream) => {
    baseWriteHook(file, stream);
    if (file.endsWith("teamhub.exe")) {
      stream.once("close", () => teamhubClosed());
    } else if (file.endsWith("migrate.exe")) {
      copyStarted = true;
      stream.once("close", () => rmOrder.push("migrate-closed"));
    }
  };
  fsHooks.onRm = (targetPath) => {
    if (copyStarted && targetPath === dir) rmOrder.push("rm-destination");
  };

  const pendingError = installTeamhubBinaries(f.from, f.repo, {
    target,
    sourceArchiveSha256,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  await Promise.all([phase1.writeOpened, waitTeamhubClosed]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(phase1.isWriteClosed()).toBe(false);
  expect(rmOrder).toEqual([]);
  phase1.hold.end(migrateBody);
  const error = await pendingError;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("does not match");
  expect(phase1.isWriteClosed()).toBe(true);
  expect(rmOrder.indexOf("migrate-closed")).toBeGreaterThanOrEqual(0);
  expect(rmOrder.indexOf("migrate-closed")).toBeLessThan(
    rmOrder.indexOf("rm-destination"),
  );
  expect(existsSync(dir)).toBe(false);
  expect(existsSync(stampFile)).toBe(false);

  // Restore valid teamhub bytes and verify AbortSignal cancels open streams and removes destination + stamps.
  await writeFile(path.join(f.from, "teamhub.exe"), "teamhub for windows");
  await writeFile(stampFile, "stale");
  const controller = new AbortController();
  const phase2 = holdMigrateStream();
  fsHooks.onRm = undefined;
  const abortedError = installTeamhubBinaries(f.from, f.repo, {
    target,
    sourceArchiveSha256,
    signal: controller.signal,
  }).then(
    () => undefined,
    (err: unknown) => err,
  );
  await phase2.writeOpened;
  controller.abort();
  expect(await abortedError).toBeDefined();
  expect(phase2.isWriteClosed()).toBe(true);
  expect(existsSync(dir)).toBe(false);
  expect(existsSync(stampFile)).toBe(false);
});
