import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  readSettledStamps,
  settledStampMatches,
  sha256File,
  writeSettledStamps,
  type SettledStamp,
  type SettledStamps,
} from "./verified-stamps.js";

// The TeamHub commands Native runs. A desktop build compiles them from the
// source package it ships (apps/desktop/scripts/build-teamhub.mjs), so Native
// there needs no Go toolchain, module download or compile.
export const TEAMHUB_COMMANDS = ["teamhub", "migrate", "account"] as const;
export type TeamhubCommand = (typeof TEAMHUB_COMMANDS)[number];
// Where a checkout keeps them; scripts/source-native.mjs runs them from here
// and compiles the commands itself when the folder is missing.
export const TEAMHUB_BINARY_DIRECTORY = ".simplexai-runtime/prebuilt";
export const TEAMHUB_BINARY_MANIFEST = "manifest.json";

export interface TeamhubBinary {
  file: string;
  sha256: string;
  bytes: number;
}
export interface TeamhubBinaries {
  target: string;
  sourceCommit: string;
  sourceArchiveSha256: string;
  goVersion: string;
  binaries: Record<TeamhubCommand, TeamhubBinary>;
}

export function parseTeamhubBinaries(value: unknown): TeamhubBinaries {
  const manifest = value as TeamhubBinaries;
  const valid =
    !!manifest &&
    typeof manifest === "object" &&
    typeof manifest.target === "string" &&
    /^[0-9a-f]{40}$/.test(manifest.sourceCommit ?? "") &&
    /^[0-9a-f]{64}$/.test(manifest.sourceArchiveSha256 ?? "") &&
    typeof manifest.goVersion === "string" &&
    !!manifest.binaries &&
    TEAMHUB_COMMANDS.every((command) => {
      const binary = manifest.binaries[command];
      return (
        !!binary &&
        typeof binary.file === "string" &&
        /^[\w-]+(?:\.exe)?$/.test(binary.file) &&
        /^[0-9a-f]{64}$/.test(binary.sha256 ?? "") &&
        Number.isSafeInteger(binary.bytes) &&
        binary.bytes > 0
      );
    });
  if (!valid) throw new Error("Invalid TeamHub binary manifest.");
  return {
    target: manifest.target,
    sourceCommit: manifest.sourceCommit,
    sourceArchiveSha256: manifest.sourceArchiveSha256,
    goVersion: manifest.goVersion,
    binaries: Object.fromEntries(
      TEAMHUB_COMMANDS.map((command) => {
        const { file, sha256, bytes } = manifest.binaries[command];
        return [command, { file, sha256, bytes }];
      }),
    ) as Record<TeamhubCommand, TeamhubBinary>,
  };
}

// The manifest in `directory`, or undefined when there is none.
export async function readTeamhubBinaries(
  directory: string,
): Promise<TeamhubBinaries | undefined> {
  let text;
  try {
    text = await readFile(
      path.join(directory, TEAMHUB_BINARY_MANIFEST),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  return parseTeamhubBinaries(JSON.parse(text));
}

export function teamhubBinaryStampsFile(directory: string): string {
  return `${directory}.verified.json`;
}

async function removeBinaries(destination: string): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  await rm(teamhubBinaryStampsFile(destination), { force: true });
}

function manifestDigest(manifest: TeamhubBinaries): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

// Throws unless every binary in `directory` has its manifest's size and sha256.
export async function verifyTeamhubBinaries(
  directory: string,
  manifest: TeamhubBinaries,
): Promise<void> {
  const digest = manifestDigest(manifest);
  const stampPath = teamhubBinaryStampsFile(directory);
  const known = await readSettledStamps(stampPath, digest);
  const nowMs = Date.now();
  const nextStamps: SettledStamps = {};
  let hashed = 0;
  // Settle every verification before rejecting so sibling read handles close
  // before callers remove the directory.
  const results = await Promise.allSettled(
    TEAMHUB_COMMANDS.map(async (command) => {
      const binary = manifest.binaries[command];
      const file = path.join(directory, binary.file);
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile() || info.size !== binary.bytes)
        throw new Error(
          `${binary.file} does not match its TeamHub binary manifest.`,
        );
      const seen = known?.[binary.file];
      if (settledStampMatches(seen, info, nowMs)) {
        nextStamps[binary.file] = seen!;
        return;
      }
      hashed += 1;
      if ((await sha256File(file)) !== binary.sha256)
        throw new Error(
          `${binary.file} does not match its TeamHub binary manifest.`,
        );
      nextStamps[binary.file] = [info.size, info.mtimeMs, info.ctimeMs];
    }),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  if (hashed > 0 || !known)
    await writeSettledStamps(stampPath, digest, nextStamps);
}

async function copyVerifiedBinary(
  source: string,
  destination: string,
  binary: TeamhubBinary,
  signal?: AbortSignal,
): Promise<SettledStamp> {
  signal?.throwIfAborted();
  const info = await stat(source).catch(() => undefined);
  if (!info?.isFile() || info.size !== binary.bytes)
    throw new Error(
      `${binary.file} does not match its TeamHub binary manifest.`,
    );
  const hash = createHash("sha256");
  let written = 0;
  const mode = info.mode & 0o777;
  const sourceStream = createReadStream(source);
  const hashStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const destinationStream = createWriteStream(destination, {
    mode: mode || 0o755,
  });
  if (signal)
    await pipeline(sourceStream, hashStream, destinationStream, { signal });
  else await pipeline(sourceStream, hashStream, destinationStream);
  signal?.throwIfAborted();
  await chmod(destination, mode || 0o755);
  if (written !== binary.bytes || hash.digest("hex") !== binary.sha256)
    throw new Error(
      `${binary.file} does not match its TeamHub binary manifest.`,
    );
  const copied = await stat(destination);
  return [copied.size, copied.mtimeMs, copied.ctimeMs];
}

// Copies the binaries a desktop build ships in `from` into the checkout it
// unpacked from the same source package. The manifest goes last, so a copy
// cut short leaves none and Native compiles instead.
export async function installTeamhubBinaries(
  from: string,
  repo: string,
  expected: {
    target: string;
    sourceArchiveSha256: string;
    signal?: AbortSignal;
  },
): Promise<"absent" | "current" | "installed"> {
  expected.signal?.throwIfAborted();
  const manifest = await readTeamhubBinaries(from);
  if (!manifest) return "absent";
  if (manifest.target !== expected.target)
    throw new Error(
      `The bundled TeamHub binaries are for ${manifest.target}, not ${expected.target}.`,
    );
  if (manifest.sourceArchiveSha256 !== expected.sourceArchiveSha256)
    throw new Error(
      "The bundled TeamHub binaries were built from another source package.",
    );
  const destination = path.join(repo, TEAMHUB_BINARY_DIRECTORY);
  const current = await readTeamhubBinaries(destination).catch(() => undefined);
  if (JSON.stringify(current) === JSON.stringify(manifest)) {
    try {
      await verifyTeamhubBinaries(destination, manifest);
      return "current";
    } catch {
      // A matching manifest can outlive a missing or damaged binary. Restore
      // the bundled copy before Native has to fall back to compiling it.
    }
  }
  expected.signal?.throwIfAborted();
  await removeBinaries(destination);
  await mkdir(destination, { recursive: true });
  try {
    const stamps: SettledStamps = {};
    // Settle every stream before cleanup so sibling write handles close before rm runs.
    const results = await Promise.allSettled(
      TEAMHUB_COMMANDS.map(async (command) => {
        const binary = manifest.binaries[command];
        const stamp = await copyVerifiedBinary(
          path.join(from, binary.file),
          path.join(destination, binary.file),
          binary,
          expected.signal,
        );
        return [binary.file, stamp] as const;
      }),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    for (const result of results) {
      if (result.status === "fulfilled") {
        const [file, stamp] = result.value;
        stamps[file] = stamp;
      }
    }
    expected.signal?.throwIfAborted();
    const temporary = path.join(
      destination,
      `${TEAMHUB_BINARY_MANIFEST}.${randomUUID()}.tmp`,
    );
    await writeFile(temporary, JSON.stringify(manifest, null, 2));
    await rename(temporary, path.join(destination, TEAMHUB_BINARY_MANIFEST));
    await writeSettledStamps(
      teamhubBinaryStampsFile(destination),
      manifestDigest(manifest),
      stamps,
    );
  } catch (error) {
    await removeBinaries(destination);
    throw error;
  }
  return "installed";
}

// Whether the checkout has TeamHub binaries for this computer that verify.
// Ones that do not are removed, so the commands compile from source instead.
export async function checkTeamhubBinaries(
  repo: string,
  target = `${process.platform}-${process.arch}`,
): Promise<"absent" | "verified" | "removed"> {
  const directory = path.join(repo, TEAMHUB_BINARY_DIRECTORY);
  try {
    const manifest = await readTeamhubBinaries(directory);
    if (!manifest) return "absent";
    if (manifest.target !== target) throw new Error("another target");
    await verifyTeamhubBinaries(directory, manifest);
    return "verified";
  } catch {
    await removeBinaries(directory);
    return "removed";
  }
}
