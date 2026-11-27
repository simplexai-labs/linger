import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  chmod,
  lstat,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { x as extract, type ReadEntry } from "tar";
import { orderByRegion } from "@linger/service-kit";
import { downloadVerified } from "./download.js";
import {
  configuredNpmRegistry,
  npmMirrorRegistry,
  npmRegistry,
  npmRegistryEnvironment,
  npmTarballUrl,
} from "./npm-registry.js";
import { downloadInRegion, resolveRegion } from "./region.js";
import { extractZip } from "./zip.js";
import {
  INSTANCE_BUSY,
  privateDirectory,
  withInstanceLock,
  type Instance,
} from "./instance.js";
import { runProcess } from "./process.js";
import { validatePublishedServiceSource } from "./published-source.js";
import type { InstallerEvent } from "./events.js";
import { removeRetrying, renameRetrying } from "./fs-retry.js";
import {
  readSettledStamps,
  runBounded,
  settledStampMatches,
  sha256File,
  writeSettledStamps,
  type SettledStamps,
} from "./verified-stamps.js";

const postgresPrograms = [
  "postgres",
  "initdb",
  "pg_ctl",
  "pg_isready",
  "psql",
  "createdb",
] as const;

export const nativeTargets = [
  "darwin-arm64",
  "linux-x64",
  "win32-x64",
] as const;
export type NativeTarget = (typeof nativeTargets)[number];
export interface NativeDependencySource {
  target: NativeTarget;
  /** Published HTTPS download; a source has either `url` or `file`. */
  url?: string;
  /** Other hosts serving the same archive, tried in order after `url`. */
  mirrors?: string[];
  /**
   * An archive shipped with the app (the Windows desktop bundles PostgreSQL).
   * distribution.json names it relative to itself; once read it is absolute.
   */
  file?: string;
  sha256: string;
  bytes: number;
  postgresVersion: string;
  pgvectorVersion: string;
}
// A bundled `file` is relative to `directory` when given (distribution.json),
// else absolute (LINGER_NATIVE_DEPENDENCIES_JSON, which holds resolved paths).
function validateArchive(
  value: unknown,
  directory: string | undefined,
  what: string,
) {
  const extra = value as NativeDependencySource;
  if (!(extra && typeof extra === "object" && "file" in extra))
    return validatePublishedServiceSource(value);
  const file = extra.file;
  if (
    "url" in extra ||
    "mirrors" in extra ||
    typeof file !== "string" ||
    !(directory === undefined
      ? path.isAbsolute(file)
      : safePath(file) && /\.tar\.gz$/.test(file)) ||
    typeof extra.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(extra.sha256) ||
    !Number.isSafeInteger(extra.bytes) ||
    extra.bytes <= 0 ||
    extra.bytes > 5 * 1024 ** 3
  )
    throw new Error(
      `Bundled native ${what} needs a contained .tar.gz file, its sha256 and its size.`,
    );
  return {
    file: directory === undefined ? file : path.join(directory, file),
    sha256: extra.sha256,
    bytes: extra.bytes,
  };
}
export function validateNativeSource(
  value: unknown,
  directory?: string,
): NativeDependencySource {
  const extra = value as NativeDependencySource;
  const source = validateArchive(value, directory, "PostgreSQL");
  if (
    !(nativeTargets as readonly string[]).includes(extra.target) ||
    !/^17\.\d+$/.test(extra.postgresVersion ?? "") ||
    !/^0\.8\.\d+$/.test(extra.pgvectorVersion ?? "")
  )
    throw new Error(
      "Native PostgreSQL metadata requires a supported target and pinned PostgreSQL 17/pgvector 0.8 versions.",
    );
  return {
    ...source,
    target: extra.target,
    postgresVersion: extra.postgresVersion,
    pgvectorVersion: extra.pgvectorVersion,
  };
}
/**
 * The LiveKit server and ffmpeg/ffprobe Native voice runs, in one archive
 * per target (scripts/prepare-native-voice-tools.mjs), shipped or published
 * like PostgreSQL.
 */
export interface NativeVoiceTools {
  target: NativeTarget;
  url?: string;
  mirrors?: string[];
  file?: string;
  sha256: string;
  bytes: number;
  livekitVersion: string;
  ffmpegVersion: string;
}
export function validateNativeVoiceTools(
  value: unknown,
  directory?: string,
): NativeVoiceTools {
  const extra = value as NativeVoiceTools;
  const source = validateArchive(value, directory, "voice tools");
  if (
    !(nativeTargets as readonly string[]).includes(extra.target) ||
    !/^1\.\d+\.\d+$/.test(extra.livekitVersion ?? "") ||
    !/^\d+\.\d+(?:\.\d+)?$/.test(extra.ffmpegVersion ?? "")
  )
    throw new Error(
      "Native voice tools metadata requires a supported target and pinned LiveKit and ffmpeg versions.",
    );
  return {
    ...source,
    target: extra.target,
    livekitVersion: extra.livekitVersion,
    ffmpegVersion: extra.ffmpegVersion,
  };
}
export async function readPublishedNativeSources(
  file: string,
): Promise<NativeDependencySource[] | undefined> {
  let value;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Invalid native distribution metadata.", { cause: error });
  }
  if (value?.platform !== process.platform || value?.arch !== process.arch)
    throw new Error("Native distribution target does not match this computer.");
  if (value.nativeSources === undefined) return;
  if (!Array.isArray(value.nativeSources))
    throw new Error("Invalid native source metadata.");
  return value.nativeSources.map((source: unknown) =>
    validateNativeSource(source, path.dirname(path.resolve(file))),
  );
}
// The voice tools of distribution.json; undefined when it ships none, so
// Native keeps voice off.
export async function readPublishedVoiceTools(
  file: string,
): Promise<NativeVoiceTools[] | undefined> {
  let value;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Invalid native distribution metadata.", { cause: error });
  }
  if (value?.voiceTools === undefined) return;
  if (!Array.isArray(value.voiceTools))
    throw new Error("Invalid native voice tools metadata.");
  return value.voiceTools.map((source: unknown) =>
    validateNativeVoiceTools(source, path.dirname(path.resolve(file))),
  );
}
export async function readNativeToolVersions(repo: string) {
  const pkg = JSON.parse(
    await readFile(path.join(repo, "package.json"), "utf8"),
  );
  const pnpm = /^pnpm@(11\.7\.0)(?:\+sha(?:224|512)\.[a-f0-9]+)?$/.exec(
    pkg.packageManager ?? "",
  )?.[1];
  if (!pnpm)
    throw new Error(
      "Native source requires the pinned pnpm@11.7.0 package manager.",
    );
  if (pkg.engines?.node !== ">=26.5.0 <27")
    throw new Error(
      "Unsupported checkout Node engine: native source requires >=26.5.0 <27.",
    );
  const mod = await readFile(path.join(repo, "apps/teamhub/go.mod"), "utf8");
  const go =
    /^toolchain go(\d+\.\d+\.\d+)\s*$/m.exec(mod)?.[1] ??
    /^go (\d+\.\d+\.\d+)\s*$/m.exec(mod)?.[1];
  if (!go || !/^1\.26\.\d+$/.test(go))
    throw new Error(
      "Native source requires an exact supported Go 1.26 toolchain in apps/teamhub/go.mod.",
    );
  return { go, pnpm };
}
function safePath(name: string) {
  return (
    !!name &&
    !name.startsWith("/") &&
    !name.includes("\\") &&
    !name.includes(":") &&
    !name
      .split("/")
      .some(
        (p) =>
          !p ||
          p === ".." ||
          p === "." ||
          [...p].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
      )
  );
}
const COMPONENT_HASH_CONCURRENCY = 32;
const componentStampsFile = (directory: string) => `${directory}.verified.json`;

async function collectTreeEntries(
  directory: string,
  prefix = "",
  out: string[] = [],
): Promise<string[]> {
  for (const entry of await readdir(path.join(directory, prefix), {
    withFileTypes: true,
  })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (name === ".simplex-files.json") continue;
    if (entry.isDirectory()) await collectTreeEntries(directory, name, out);
    else if (entry.isFile()) out.push(name);
    else throw new Error("Unsafe native dependency cache entry.");
  }
  return out;
}

export interface StreamedFileHash {
  readonly sha256: string;
  readonly bytes: number;
}

export async function hashTree(
  directory: string,
  precomputedHashes?: ReadonlyMap<string, StreamedFileHash>,
): Promise<{
  hashes: Record<string, string>;
  stamps: SettledStamps;
}> {
  const entries = await collectTreeEntries(directory);
  const rawHashes: Record<string, string> = {};
  const rawStamps: SettledStamps = {};
  await runBounded(entries, COMPONENT_HASH_CONCURRENCY, async (name) => {
    const file = path.join(directory, name);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Unsafe native dependency cache entry.");
    const precomputed = precomputedHashes?.get(name);
    rawHashes[name] =
      precomputed && precomputed.bytes === info.size
        ? precomputed.sha256
        : await sha256File(file);
    rawStamps[name] = [info.size, info.mtimeMs, info.ctimeMs];
  });
  return {
    hashes: Object.fromEntries(entries.map((name) => [name, rawHashes[name]!])),
    stamps: Object.fromEntries(entries.map((name) => [name, rawStamps[name]!])),
  };
}

function createTarFileHashTransform(
  hashes: Map<string, StreamedFileHash>,
): (entry: ReadEntry) => ReadEntry {
  return (entry: ReadEntry) => {
    const relative = entry.path.replace(/\\/g, "/").replace(/^\.\//, "");
    const hash = createHash("sha256");
    let bytes = 0;
    const tx = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
      flush(callback) {
        hashes.set(relative, { sha256: hash.digest("hex"), bytes });
        callback();
      },
    });
    return tx as unknown as ReadEntry;
  };
}

async function digestFile(
  file: string,
  algorithm: "sha256" | "sha512",
  maxBytes: number,
  label: string,
  signal: AbortSignal,
): Promise<string> {
  const hash = createHash(algorithm);
  let total = 0;
  for await (const chunk of createReadStream(file, { signal })) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxBytes)
      throw new Error(`The bundled ${label} archive is larger than pinned.`);
    hash.update(buffer);
  }
  return hash.digest("hex");
}

/**
 * Verifies a local bundled tar.gz archive's size and checksum while streaming
 * it directly into `stage` and computing per-file SHA-256 hashes in memory,
 * eliminating both the temporary archive copy and post-extract file re-reads.
 */
async function extractBundledTarVerified(options: {
  file: string;
  stage: string;
  algorithm: "sha256" | "sha512";
  digest: string;
  maxBytes: number;
  label?: string;
  signal: AbortSignal;
  onProgress?: (completed: number, total?: number) => void;
  admit: (relative: string, type: string, size: number) => boolean;
  getArchiveError: () => Error | undefined;
}): Promise<Map<string, StreamedFileHash>> {
  const label = options.label ?? "PostgreSQL";
  const info = await stat(options.file).catch(() => undefined);
  if (!info?.isFile())
    throw new Error(
      `The bundled ${label} archive is missing. Install Linger again.`,
    );
  if (info.size > options.maxBytes)
    throw new Error(`The bundled ${label} archive is larger than pinned.`);

  const archiveHash = createHash(options.algorithm);
  const streamedHashes = new Map<string, StreamedFileHash>();
  let completed = 0;
  let meterFlushed = false;
  let sizeExceeded = false;

  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      completed += chunk.length;
      if (completed > options.maxBytes) {
        sizeExceeded = true;
        callback(
          new Error(`The bundled ${label} archive is larger than pinned.`),
        );
        return;
      }
      archiveHash.update(chunk);
      options.onProgress?.(completed, info.size);
      callback(null, chunk);
    },
    flush(callback) {
      meterFlushed = true;
      callback();
    },
  });

  const unpack = extract({
    cwd: options.stage,
    strict: true,
    preservePaths: false,
    filter: (name, entry) => {
      const type =
        "type" in entry
          ? entry.type
          : entry.isDirectory()
            ? "Directory"
            : entry.isFile()
              ? "File"
              : "Unsupported";
      const relative = name.replace(/^\.\//, "").replace(/\/$/, "");
      if (!relative && type === "Directory") return true;
      return options.admit(relative, type, entry.size);
    },
    transform: createTarFileHashTransform(streamedHashes),
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const source = createReadStream(options.file);
      let settled = false;
      const cleanup = () => {
        options.signal.removeEventListener("abort", onAbort);
      };
      const destroyStreams = (reason?: Error) => {
        if (!source.destroyed) source.destroy();
        if (!meter.destroyed) meter.destroy();
        try {
          if (reason) unpack.abort(reason);
        } catch {
          // Unpack already closed.
        }
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        destroyStreams(
          error instanceof Error ? error : new Error(String(error)),
        );
        reject(error);
      };
      const onAbort = () => {
        fail(
          options.signal.reason ?? new DOMException("Aborted", "AbortError"),
        );
      };
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
      source.on("error", fail);
      meter.on("error", fail);
      unpack.on("error", fail);
      unpack.once("close", () => {
        if (settled) return;
        settled = true;
        cleanup();
        destroyStreams();
        resolve();
      });
      source.pipe(meter).pipe(unpack);
    });
  } catch (error) {
    if (options.signal.aborted || sizeExceeded) throw error;
    const actualDigest = meterFlushed
      ? archiveHash.digest("hex")
      : await digestFile(
          options.file,
          options.algorithm,
          options.maxBytes,
          label,
          options.signal,
        );
    if (actualDigest !== options.digest) {
      throw new Error(
        `The bundled ${label} archive does not match its checksum. Install Linger again.`,
        { cause: error },
      );
    }
    const admittedError = options.getArchiveError();
    if (admittedError) throw admittedError;
    throw error;
  }

  const actualDigest = meterFlushed
    ? archiveHash.digest("hex")
    : await digestFile(
        options.file,
        options.algorithm,
        options.maxBytes,
        label,
        options.signal,
      );
  if (actualDigest !== options.digest) {
    throw new Error(
      `The bundled ${label} archive does not match its checksum. Install Linger again.`,
    );
  }
  const admittedError = options.getArchiveError();
  if (admittedError) throw admittedError;
  return streamedHashes;
}

async function verifyCachedTree(
  directory: string,
  manifestFile: string,
  signal: AbortSignal,
): Promise<void> {
  const manifestInfo = await lstat(manifestFile);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink())
    throw new Error("Unsafe native dependency cache manifest.");
  const manifestText = await readFile(manifestFile, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    throw new Error(
      "Native dependency cache integrity mismatch; remove the damaged component and retry.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(
      "Native dependency cache integrity mismatch; remove the damaged component and retry.",
    );
  const expected = parsed as Record<string, unknown>;
  const expectedKeys = Object.keys(expected);
  const actualEntries = await collectTreeEntries(directory);
  if (
    actualEntries.length !== expectedKeys.length ||
    actualEntries.some((name) => typeof expected[name] !== "string")
  )
    throw new Error(
      "Native dependency cache integrity mismatch; remove the damaged component and retry.",
    );
  const manifestDigest = createHash("sha256")
    .update(manifestText)
    .digest("hex");
  const stampPath = componentStampsFile(directory);
  const known = await readSettledStamps(stampPath, manifestDigest);
  const nowMs = Date.now();
  const nextStamps: SettledStamps = {};
  let hashed = 0;
  await runBounded(actualEntries, COMPONENT_HASH_CONCURRENCY, async (name) => {
    signal.throwIfAborted();
    const file = path.join(directory, name);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Unsafe native dependency cache entry.");
    const seen = known?.[name];
    if (settledStampMatches(seen, info, nowMs)) {
      nextStamps[name] = seen!;
      return;
    }
    hashed += 1;
    if ((await sha256File(file)) !== expected[name])
      throw new Error(
        "Native dependency cache integrity mismatch; remove the damaged component and retry.",
      );
    nextStamps[name] = [info.size, info.mtimeMs, info.ctimeMs];
  });
  if (hashed > 0 || !known)
    await writeSettledStamps(stampPath, manifestDigest, nextStamps);
}
type Artifact = (
  | {
      url: string;
      /** Other hosts serving the same verified bytes. */
      mirrors?: readonly string[];
      file?: undefined;
    }
  | { url?: undefined; mirrors?: undefined; file: string }
) & {
  algorithm: "sha256" | "sha512";
  digest: string;
  maxBytes: number;
  /** Release archives are gzip tarballs unless they say otherwise. */
  format?: "zip";
  /** Install UTF-8 process manifests beside the Windows PostgreSQL tools. */
  windowsPostgres?: boolean;
  /** What a bundled archive holds, for its errors. */
  label?: string;
};
/** Copies a bundled archive while hashing it, so only the verified bytes are extracted. */
async function copyVerified(
  options: Pick<Artifact, "algorithm" | "digest" | "maxBytes" | "label"> & {
    file: string;
    output: string;
    signal: AbortSignal;
    onProgress?: (completed: number, total?: number) => void;
  },
) {
  const label = options.label ?? "PostgreSQL";
  const info = await stat(options.file).catch(() => undefined);
  if (!info?.isFile())
    throw new Error(
      `The bundled ${label} archive is missing. Install Linger again.`,
    );
  if (info.size > options.maxBytes)
    throw new Error(`The bundled ${label} archive is larger than pinned.`);
  const hash = createHash(options.algorithm);
  let completed = 0;
  await pipeline(
    createReadStream(options.file),
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        completed += chunk.length;
        if (completed > options.maxBytes)
          throw new Error(
            `The bundled ${label} archive is larger than pinned.`,
          );
        hash.update(chunk);
        options.onProgress?.(completed, info.size);
        yield chunk;
      }
    },
    createWriteStream(options.output, { mode: 0o600, flags: "wx" }),
    { signal: options.signal },
  );
  if (hash.digest("hex") !== options.digest)
    throw new Error(
      `The bundled ${label} archive does not match its checksum. Install Linger again.`,
    );
}
export interface AcquireArtifactLockOptions {
  lockWaitMs?: number;
  lockPollMs?: number;
}
/**
 * Content-addressed, locked installs: unverified or partial trees never
 * become executable inputs. With `home`, a download tries the sources in its
 * region first (region.ts). Locks per artifact key so concurrent component
 * preparations do not contend, and waits boundedly on INSTANCE_BUSY for an
 * in-progress preparation of the same artifact.
 */
export async function acquireNativeArtifact(
  base: string,
  artifact: Artifact,
  signal: AbortSignal,
  onProgress?: (completed: number, total?: number) => void,
  fetcher: typeof fetch = fetch,
  home?: string,
  lockOptions: AcquireArtifactLockOptions = {},
) {
  const digestLength =
    artifact.algorithm === "sha256"
      ? 64
      : artifact.algorithm === "sha512"
        ? 128
        : 0;
  if (
    !digestLength ||
    !new RegExp(`^[a-f0-9]{${digestLength}}$`).test(artifact.digest)
  )
    throw new Error("Invalid trusted checksum.");
  if (
    artifact.file !== undefined &&
    (!path.isAbsolute(artifact.file) ||
      !Number.isSafeInteger(artifact.maxBytes) ||
      artifact.maxBytes <= 0 ||
      artifact.maxBytes > 5 * 1024 ** 3)
  )
    throw new Error(
      "Bundled native dependencies require a bounded local file.",
    );
  let sourceUrl: URL | undefined;
  if (artifact.file === undefined)
    try {
      sourceUrl = new URL(artifact.url);
    } catch {
      throw new Error("Invalid native dependency download URL.");
    }
  if (
    sourceUrl &&
    (sourceUrl.protocol !== "https:" ||
      sourceUrl.username ||
      sourceUrl.password ||
      sourceUrl.search ||
      sourceUrl.hash ||
      !Number.isSafeInteger(artifact.maxBytes) ||
      artifact.maxBytes <= 0 ||
      artifact.maxBytes > 5 * 1024 ** 3)
  )
    throw new Error(
      "Native dependencies require bounded credential-free HTTPS downloads.",
    );
  signal.throwIfAborted();
  await privateDirectory(base);
  // Older installers verify the unmodified archive under its bare digest.
  const key = artifact.windowsPostgres
    ? `${artifact.digest}-utf8`
    : artifact.digest;
  const locksBase = path.join(base, ".locks");
  const lockDir = path.join(locksBase, key);
  await privateDirectory(locksBase);
  await privateDirectory(lockDir);
  const lockWaitMs = lockOptions.lockWaitMs ?? 120_000;
  const lockPollMs = lockOptions.lockPollMs ?? 200;
  const lockDeadline = Date.now() + lockWaitMs;
  for (;;) {
    signal.throwIfAborted();
    let acquired = false;
    try {
      return await withInstanceLock({ root: lockDir } as Instance, async () => {
        acquired = true;
        const directory = path.join(base, key);
        const exists = await lstat(directory).catch((error) => {
          if (error.code === "ENOENT") return;
          throw error;
        });
        if (exists) {
          await privateDirectory(directory);
          const manifestFile = path.join(directory, ".simplex-files.json");
          await verifyCachedTree(directory, manifestFile, signal);
          return directory;
        }
        const stage = path.join(base, `pending-${randomUUID()}`),
          archive = path.join(
            base,
            `${randomUUID()}.${artifact.format === "zip" ? "zip" : "tgz"}`,
          );
        await privateDirectory(stage);
        let succeeded = false;
        try {
          let expanded = 0;
          let archiveError: Error | undefined;
          const admit = (relative: string, type: string, size: number) => {
            if (
              !safePath(relative) ||
              !["File", "Directory"].includes(type) ||
              relative === ".simplex-files.json"
            ) {
              archiveError = new Error("Unsafe native dependency archive.");
              return false;
            }
            expanded += size;
            if (expanded > 2 * 1024 ** 3) {
              archiveError = new Error(
                "Native dependency archive exceeds extraction limit.",
              );
              return false;
            }
            return !archiveError;
          };
          let streamedHashes: Map<string, StreamedFileHash> | undefined;
          if (artifact.file !== undefined && artifact.format !== "zip") {
            streamedHashes = await extractBundledTarVerified({
              file: artifact.file,
              stage,
              algorithm: artifact.algorithm,
              digest: artifact.digest,
              maxBytes: artifact.maxBytes,
              label: artifact.label,
              signal,
              onProgress,
              admit,
              getArchiveError: () => archiveError,
            });
          } else {
            if (artifact.file !== undefined)
              await copyVerified({
                ...artifact,
                file: artifact.file,
                output: archive,
                signal,
                onProgress,
              });
            else if (home)
              await downloadInRegion(
                home,
                { ...artifact, output: archive, signal, onProgress },
                fetcher,
              );
            else
              await downloadVerified(
                { ...artifact, output: archive, signal, onProgress },
                fetcher,
              );
            if (artifact.format === "zip")
              await extractZip(archive, stage, (entry) =>
                admit(
                  entry.name,
                  entry.directory ? "Directory" : "File",
                  entry.size,
                ),
              );
            else {
              await extract({
                file: archive,
                cwd: stage,
                strict: true,
                preservePaths: false,
                filter: (name, entry) => {
                  const type =
                    "type" in entry
                      ? entry.type
                      : entry.isDirectory()
                        ? "Directory"
                        : entry.isFile()
                          ? "File"
                          : "Unsupported";
                  const relative = name.replace(/^\.\//, "").replace(/\/$/, "");
                  if (!relative && type === "Directory") return true;
                  return admit(relative, type, entry.size);
                },
              });
            }
            if (archiveError) throw archiveError;
          }
          if (artifact.windowsPostgres) {
            // initdb relaunches itself and starts postgres through narrow Win32 APIs.
            for (const program of postgresPrograms) {
              const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity name="Linger.PostgreSQL.${program}" version="1.0.0.0" type="win32"/>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage>
    </windowsSettings>
  </application>
</assembly>
`;
              const xmlBytes = Buffer.from(xml, "utf8");
              await writeFile(
                path.join(stage, "bin", `${program}.exe.manifest`),
                xmlBytes,
                { flag: "wx" },
              );
              streamedHashes?.set(`bin/${program}.exe.manifest`, {
                sha256: createHash("sha256").update(xmlBytes).digest("hex"),
                bytes: xmlBytes.length,
              });
            }
          }
          const { hashes, stamps } = await hashTree(stage, streamedHashes);
          const manifestBody = JSON.stringify(hashes);
          await writeFile(
            path.join(stage, ".simplex-files.json"),
            manifestBody,
            { mode: 0o600, flag: "wx" },
          );
          signal.throwIfAborted();
          await renameRetrying(stage, directory, { signal });
          const manifestDigest = createHash("sha256")
            .update(manifestBody)
            .digest("hex");
          await writeSettledStamps(
            componentStampsFile(directory),
            manifestDigest,
            stamps,
          );
          succeeded = true;
          return directory;
        } finally {
          const cleanup = async () => {
            await removeRetrying(archive);
            await removeRetrying(stage);
          };
          if (succeeded) await cleanup();
          else await cleanup().catch(() => undefined);
        }
      });
    } catch (error) {
      if (
        acquired ||
        (error as { code?: unknown } | null)?.code !== INSTANCE_BUSY
      )
        throw error;
      if (Date.now() >= lockDeadline) throw error;
      await delay(
        Math.min(lockPollMs, Math.max(1, lockDeadline - Date.now())),
        undefined,
        { signal },
      );
    }
  }
}
const npmSources = {
  pnpm: {
    version: "11.7.0",
    integrity:
      "GcyFLBIMcSV2DyRD7mvgyltA+fUFmN4aCaHxd1A+AQ5Xwjx3ZG4B52HeWb+HT7IqM5jDOrlpH8E+uUa28PTWIA==",
  },
  npm: {
    version: "11.7.0",
    integrity:
      "wiCZpv/41bIobCoJ31NStIWKfAxxYyD1iYnWCtiyns8s5v3+l8y0HCP/sScuH6B5+GhIfda4HQKiqeGZwJWhFw==",
  },
} as const;
function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
// Release lock: sourced from https://go.dev/dl/?mode=json&include=all on 2026-10-29.
// The Aliyun mirror serves the same archives; the download region orders them.
// Runtime preparation never resolves mutable toolchain metadata or upgrades this pin.
const pinnedGoSources: Readonly<Record<string, Artifact>> = {
  "1.26.5-darwin-arm64": {
    url: "https://dl.google.com/go/go1.26.5.darwin-arm64.tar.gz",
    mirrors: ["https://mirrors.aliyun.com/golang/go1.26.5.darwin-arm64.tar.gz"],
    algorithm: "sha256",
    digest: "efb87ff28af9a188d0536ef5d42e63dd52ba8263cd7344a993cc48dd11dedb6a",
    maxBytes: 64738542,
  },
  "1.26.5-linux-x64": {
    url: "https://dl.google.com/go/go1.26.5.linux-amd64.tar.gz",
    mirrors: ["https://mirrors.aliyun.com/golang/go1.26.5.linux-amd64.tar.gz"],
    algorithm: "sha256",
    digest: "5c2c3b16caefa1d968a94c1daca04a7ca301a496d9b086e17ad77bb81393f053",
    maxBytes: 66879095,
  },
  "1.26.5-win32-x64": {
    url: "https://dl.google.com/go/go1.26.5.windows-amd64.zip",
    mirrors: ["https://mirrors.aliyun.com/golang/go1.26.5.windows-amd64.zip"],
    algorithm: "sha256",
    digest: "97e6b2a833b6d89f9ff17d25419ac0a7e3b482a044e9ab18cdef834bd834fd38",
    maxBytes: 74927386,
    format: "zip",
  },
};
export async function prepareNativeDependencies(options: {
  repo: string;
  home: string;
  signal: AbortSignal;
  onEvent?: (event: InstallerEvent) => void;
  fetcher?: typeof fetch;
  /** False when the checkout has its TeamHub binaries and compiles no Go. */
  go?: boolean;
  /**
   * False when the checkout has its built services (native-runtime.ts) and
   * installs no packages: no pnpm, npm or registry.
   */
  packages?: boolean;
}): Promise<{
  env: NodeJS.ProcessEnv;
  postgresBin: string;
  postgresConfigurationExecutable?: string;
  toolchainRoot: string;
  /** Package registries to install from, in order of preference. */
  registries: string[];
}> {
  const target = `${process.platform}-${process.arch}`;
  if (!(nativeTargets as readonly string[]).includes(target))
    throw new Error(
      "Native source currently requires macOS arm64, Linux x64 or Windows x64.",
    );
  const windows = process.platform === "win32";
  const exe = windows ? ".exe" : "";
  const versions = await readNativeToolVersions(options.repo);
  const withGo = options.go ?? true;
  const withPackages = options.packages ?? true;
  const goSource = pinnedGoSources[`${versions.go}-${target}`];
  if (withGo && !goSource)
    throw new Error(
      "The checkout Go version has no verified Linger release pin. Use Go 1.26.5 or update the Linger distribution.",
    );
  const node = process.versions.node.split(".").map(Number);
  if (node[0] !== 26 || (node[1] ?? 0) < 5)
    throw new Error(
      "Use the Linger bundled Node 26.5+ runtime for native source.",
    );
  const raw = process.env.LINGER_NATIVE_DEPENDENCIES_JSON;
  if (!raw)
    throw new Error(
      "Native PostgreSQL distribution metadata is unavailable. Use a Linger distribution published with --native-source.",
    );
  let sources: NativeDependencySource[];
  try {
    const decoded = JSON.parse(raw);
    if (!Array.isArray(decoded)) throw new Error();
    sources = decoded.map((source) => validateNativeSource(source));
  } catch {
    throw new Error("Native PostgreSQL distribution metadata is invalid.");
  }
  const postgres = sources.find((s) => s.target === target);
  if (!postgres)
    throw new Error(
      "The Linger distribution does not include PostgreSQL for this host.",
    );
  await privateDirectory(path.resolve(options.home));
  await privateDirectory(path.join(path.resolve(options.home), "tools"));
  const nativeRoot = path.join(path.resolve(options.home), "tools/native");
  await privateDirectory(nativeRoot);
  const toolchainRoot = path.join(
    nativeRoot,
    `${target}-node${process.versions.node}-go${versions.go}-pnpm${versions.pnpm}-pg${postgres.sha256}`,
  );
  await privateDirectory(toolchainRoot);
  const configuredRegistry = configuredNpmRegistry();
  const component = async (name: string, artifact: Artifact) => {
    const startedAt = Date.now();
    const directory = await acquire(name, artifact);
    options.onEvent?.({
      kind: "log",
      stage: "release",
      message: `Prepared private ${name} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.\n`,
    });
    return directory;
  };
  const acquire = async (name: string, artifact: Artifact) =>
    acquireNativeArtifact(
      path.join(nativeRoot, "components"),
      artifact,
      options.signal,
      (completed, total) =>
        options.onEvent?.({
          kind: "stage",
          stage: "release",
          state: "running",
          message:
            completed === total
              ? `Verifying and extracting private ${name}`
              : artifact.file !== undefined
                ? `Copying bundled ${name}`
                : `Downloading private ${name}`,
          progress: { completed, total, unit: "bytes" },
        }),
      options.fetcher,
      options.home,
    );
  const go = withGo
    ? await component(`Go ${versions.go}`, goSource!)
    : undefined;
  const packages = {} as Record<"pnpm" | "npm", string>;
  for (const name of withPackages ? (["pnpm", "npm"] as const) : []) {
    const source = npmSources[name];
    // The pinned tools come from the public hosts even when installs use
    // a configured registry.
    const [url, ...mirrors] = [npmRegistry, npmMirrorRegistry].map((registry) =>
      npmTarballUrl(registry, name, source.version),
    );
    packages[name] = await component(`${name} ${source.version}`, {
      url: url!,
      mirrors,
      algorithm: "sha512",
      digest: Buffer.from(source.integrity, "base64").toString("hex"),
      maxBytes: 32 * 1024 ** 2,
    });
  }
  // Only downloads resolve the region: a checkout that brings its services
  // and TeamHub binaries prepares offline. Reading after toolchain downloads
  // picks up any fallback recorded during them.
  const region =
    withGo || withPackages
      ? await resolveRegion(options.home, {
          signal: options.signal,
          fetcher: options.fetcher,
        })
      : undefined;
  const registries = !withPackages
    ? []
    : configuredRegistry
      ? [configuredRegistry]
      : orderByRegion(region!, [npmRegistry, npmMirrorRegistry]);
  if (registries[0])
    options.onEvent?.({
      kind: "log",
      stage: "release",
      message: `Using package registry ${new URL(registries[0]).host}.\n`,
    });
  const pg = await component(
    `PostgreSQL ${postgres.postgresVersion} / pgvector ${postgres.pgvectorVersion}`,
    {
      ...(postgres.file !== undefined
        ? { file: postgres.file }
        : { url: postgres.url!, mirrors: postgres.mirrors }),
      algorithm: "sha256",
      digest: postgres.sha256,
      windowsPostgres: windows,
      maxBytes: postgres.bytes,
    },
  );
  const bin = path.join(toolchainRoot, "bin");
  await privateDirectory(bin);
  const launchers: Record<string, string[]> = {
    node: [process.execPath],
    ...(go && {
      go: [path.join(go, `go/bin/go${exe}`)],
      gofmt: [path.join(go, `go/bin/gofmt${exe}`)],
    }),
    ...(withPackages && {
      pnpm: [
        process.execPath,
        path.join(packages.pnpm, "package/bin/pnpm.cjs"),
      ],
      npm: [
        process.execPath,
        path.join(packages.npm, "package/bin/npm-cli.js"),
      ],
      npx: [
        process.execPath,
        path.join(packages.npm, "package/bin/npx-cli.js"),
      ],
    }),
  };
  for (const [name, args] of Object.entries(launchers)) {
    const file = path.join(bin, windows ? `${name}.cmd` : name),
      temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      windows
        ? `@echo off\r\n${args.map((arg) => `"${arg}"`).join(" ")} %*\r\n`
        : `#!/bin/sh\nexec ${args.map(shellQuote).join(" ")} "$@"\n`,
      { mode: 0o700, flag: "wx" },
    );
    await rename(temporary, file);
    await chmod(file, 0o700);
  }
  for (const executable of postgresPrograms) {
    const info = await lstat(path.join(pg, "bin", `${executable}${exe}`));
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (!windows && !(info.mode & 0o111))
    )
      throw new Error("Native PostgreSQL archive is missing an executable.");
  }
  const inherited = { ...process.env };
  // Windows keeps one case-insensitive Path; a second spelling would shadow ours.
  for (const key of Object.keys(inherited))
    if (key !== "PATH" && key.toUpperCase() === "PATH") delete inherited[key];
  const env = {
    ...inherited,
    PATH: [bin, path.join(pg, "bin"), process.env.PATH ?? ""].join(
      path.delimiter,
    ),
    ...(go && {
      GOROOT: path.join(go, "go"),
      GOTOOLCHAIN: "local",
      GOPATH: path.join(toolchainRoot, "gopath"),
      GOCACHE: path.join(toolchainRoot, "go-build"),
      GOMODCACHE: path.join(toolchainRoot, "gopath/pkg/mod"),
      GOBIN: bin,
      // Module downloads fall through to the other region's proxy on any
      // error, including a timeout; go.sum and the checksum database
      // (reached through the proxy) still verify every module.
      GOPROXY:
        process.env.GOPROXY ||
        [
          ...orderByRegion(region!, [
            "https://proxy.golang.org",
            "https://goproxy.cn",
          ]),
          "direct",
        ].join("|"),
    }),
    // No service needs cgo. Without it Go never calls a C compiler, which
    // on a Mac without Xcode Command Line Tools opens Apple's installer.
    CGO_ENABLED: "0",
    npm_config_update_notifier: "false",
    ...(withPackages && {
      PNPM_HOME: bin,
      ...npmRegistryEnvironment(registries[0]!),
    }),
  };
  // Node cannot spawn a .cmd without a shell, so check the real executables.
  const goPlatform = windows ? "windows" : process.platform;
  const checks: [string, string[], string][] = [
    ...(go
      ? [
          [
            windows ? launchers.go![0]! : path.join(bin, "go"),
            ["version"],
            `go version go${versions.go} ${goPlatform}/${process.arch === "x64" ? "amd64" : process.arch}`,
          ] as [string, string[], string],
        ]
      : []),
    ...(withPackages
      ? ([
          windows
            ? [
                process.execPath,
                launchers.pnpm!.slice(1).concat("--version"),
                versions.pnpm,
              ]
            : [path.join(bin, "pnpm"), ["--version"], versions.pnpm],
          windows
            ? [
                process.execPath,
                launchers.npm!.slice(1).concat("--version"),
                npmSources.npm.version,
              ]
            : [path.join(bin, "npm"), ["--version"], npmSources.npm.version],
        ] as [string, string[], string][])
      : []),
    [
      path.join(pg, `bin/postgres${exe}`),
      ["--version"],
      `postgres (PostgreSQL) ${postgres.postgresVersion}`,
    ],
  ];
  await Promise.all(
    checks.map(async ([command, args, expected]) => {
      const result = await runProcess(command, args, {
        env,
        signal: options.signal,
        timeoutMs: 30000,
      });
      if (result.code !== 0 || result.stdout.trim() !== expected)
        throw new Error(
          "A verified private native tool could not execute the required version on this host.",
        );
    }),
  );
  return {
    env,
    postgresBin: path.join(pg, "bin"),
    // Keep the service identity of a running server from this exact archive.
    ...(windows && {
      postgresConfigurationExecutable: path.join(
        nativeRoot,
        "components",
        postgres.sha256,
        "bin",
        "postgres.exe",
      ),
    }),
    toolchainRoot,
    registries,
  };
}
function parseNativeVoiceToolsForHost(): NativeVoiceTools | undefined {
  const target = `${process.platform}-${process.arch}`;
  const raw = process.env.LINGER_NATIVE_VOICE_TOOLS_JSON;
  if (!raw) return undefined;
  let sources: NativeVoiceTools[];
  try {
    const decoded = JSON.parse(raw);
    if (!Array.isArray(decoded)) throw new Error();
    sources = decoded.map((source) => validateNativeVoiceTools(source));
  } catch {
    throw new Error("Native voice tools distribution metadata is invalid.");
  }
  return sources.find((source) => source.target === target);
}
export interface NativeVoiceToolsPlan {
  bin: string;
  livekit: string;
  prepared: boolean;
  damaged: boolean;
}
/**
 * Deterministic voice tools locations for this computer without extracting
 * the archive; `prepared` is true when the component manifest and executables
 * already exist as regular files, and `damaged` is true when the component
 * directory exists on disk without all required files.
 */
export async function resolveNativeVoiceToolsPlan(
  home: string,
): Promise<NativeVoiceToolsPlan | undefined> {
  const tools = parseNativeVoiceToolsForHost();
  if (!tools) return undefined;
  const directory = path.join(
    path.resolve(home),
    "tools",
    "native",
    "components",
    tools.sha256,
  );
  const bin = path.join(directory, "bin");
  const exe = process.platform === "win32" ? ".exe" : "";
  const livekit = path.join(bin, `livekit-server${exe}`);
  const dirExists = await lstat(directory).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  const required = [
    path.join(directory, ".simplex-files.json"),
    livekit,
    path.join(bin, `ffmpeg${exe}`),
    path.join(bin, `ffprobe${exe}`),
  ];
  const exists = await Promise.all(
    required.map((file) =>
      stat(file).then(
        (info) => info.isFile(),
        () => false,
      ),
    ),
  );
  const prepared = exists.every(Boolean);
  if (!prepared && tools.file !== undefined) {
    const archiveInfo = await stat(tools.file).catch(() => undefined);
    if (!archiveInfo?.isFile()) {
      throw new Error("Bundled native voice tools archive is missing.");
    }
  }
  return { bin, livekit, prepared, damaged: dirExists && !prepared };
}
/**
 * The verified LiveKit server and ffmpeg for this computer, from
 * LINGER_NATIVE_VOICE_TOOLS_JSON; undefined when the distribution has none
 * for it, and Native voice stays off.
 */
export async function prepareNativeVoiceTools(options: {
  home: string;
  signal: AbortSignal;
  onEvent?: (event: InstallerEvent) => void;
  fetcher?: typeof fetch;
}): Promise<{ bin: string; livekit: string } | undefined> {
  const tools = parseNativeVoiceToolsForHost();
  if (!tools) return undefined;
  const nativeRoot = path.join(path.resolve(options.home), "tools/native");
  await privateDirectory(path.resolve(options.home));
  await privateDirectory(path.join(path.resolve(options.home), "tools"));
  await privateDirectory(nativeRoot);
  const name = `LiveKit ${tools.livekitVersion} / ffmpeg ${tools.ffmpegVersion}`;
  const startedAt = Date.now();
  const directory = await acquireNativeArtifact(
    path.join(nativeRoot, "components"),
    {
      ...(tools.file !== undefined
        ? { file: tools.file }
        : { url: tools.url!, mirrors: tools.mirrors }),
      algorithm: "sha256",
      digest: tools.sha256,
      maxBytes: tools.bytes,
      label: "voice tools",
    },
    options.signal,
    (completed, total) =>
      options.onEvent?.({
        kind: "stage",
        stage: "release",
        state: "running",
        message:
          completed === total
            ? `Verifying and extracting private ${name}`
            : tools.file !== undefined
              ? `Copying bundled ${name}`
              : `Downloading private ${name}`,
        progress: { completed, total, unit: "bytes" },
      }),
    options.fetcher,
    options.home,
  );
  options.onEvent?.({
    kind: "log",
    stage: "release",
    message: `Prepared private ${name} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.\n`,
  });
  const bin = path.join(directory, "bin");
  const exe = process.platform === "win32" ? ".exe" : "";
  const checks: [string, string][] = [
    ["livekit-server", `livekit-server version ${tools.livekitVersion}\n`],
    ["ffmpeg", `ffmpeg version ${tools.ffmpegVersion} `],
    ["ffprobe", `ffprobe version ${tools.ffmpegVersion} `],
  ];
  await Promise.all(
    checks.map(async ([program, expected]) => {
      const result = await runProcess(
        path.join(bin, `${program}${exe}`),
        [program === "livekit-server" ? "--version" : "-version"],
        { signal: options.signal, timeoutMs: 30000 },
      );
      if (
        result.code !== 0 ||
        !`${result.stdout.trim()}\n`.startsWith(expected)
      )
        throw new Error(
          "A verified private voice tool could not execute the required version on this host.",
        );
    }),
  );
  return { bin, livekit: path.join(bin, `livekit-server${exe}`) };
}
