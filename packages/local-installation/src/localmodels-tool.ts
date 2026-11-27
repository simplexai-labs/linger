import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readdir, readFile, rm, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sleep } from "@linger/service-kit";
import { x as extract } from "tar";
import {
  cachedRegion,
  downloadInRegion,
  formatRegionDownloadEvent,
  regionFile,
} from "./region.js";
import {
  atomicPrivate,
  INSTANCE_BUSY,
  privateDirectory,
  readPrivate,
  withInstanceLock,
  type Instance,
} from "./instance.js";
import { freePort, portFree } from "./ports.js";
import { runProcess, type ProcessOptions } from "./process.js";
import {
  validatePublishedServiceSource,
  type PublishedServiceSource,
} from "./published-source.js";
import type { InstallerEvent } from "./events.js";
import { renameRetrying } from "./fs-retry.js";
import {
  ensureStableBundledPi,
  resolveBundledPi,
  withBundledPiPath,
  type BundledPi,
} from "./bundled-pi.js";
import { runBounded, sha256File } from "./verified-stamps.js";
export type LocalmodelsToolSource = PublishedServiceSource & {
  sourceCommit: string;
  manifestSha256: string;
};
interface ToolManifest {
  schemaVersion: number;
  platform: string;
  arch: string;
  sourceCommit: string;
  python: string;
  moduleDir: string;
  assets: Record<string, string>;
}
type Options = ProcessOptions & {
  onEvent?: (event: InstallerEvent) => void;
  bundledPi?: BundledPi | null;
};
export function validateToolSource(value: unknown): LocalmodelsToolSource {
  const source = validatePublishedServiceSource(value);
  const extra = value as LocalmodelsToolSource;
  if (
    !/^[a-f0-9]{40}$/.test(extra.sourceCommit ?? "") ||
    !/^[a-f0-9]{64}$/.test(extra.manifestSha256 ?? "")
  )
    throw new Error(
      "Upstream tool distribution metadata requires a pinned commit and manifest checksum.",
    );
  return {
    ...source,
    sourceCommit: extra.sourceCommit,
    manifestSha256: extra.manifestSha256,
  };
}
function safeRelative(name: string): boolean {
  return (
    !!name &&
    !name.startsWith("/") &&
    !name.includes("\\") &&
    !name.includes(":") &&
    !name
      .split("/")
      .some(
        (p) =>
          p === ".." ||
          p === "." ||
          !p ||
          [...p].some((c) => c.charCodeAt(0) < 32) ||
          /[. ]$/.test(p) ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p),
      )
  );
}
async function verifyDirectory(
  directory: string,
  checkedDirs?: Map<string, Promise<void>>,
) {
  if (!checkedDirs) {
    const s = await lstat(directory);
    if (s.isSymbolicLink())
      throw new Error("Linked upstream tool paths are forbidden.");
    return;
  }
  let pending = checkedDirs.get(directory);
  if (!pending) {
    pending = lstat(directory).then((s) => {
      if (s.isSymbolicLink())
        throw new Error("Linked upstream tool paths are forbidden.");
    });
    checkedDirs.set(directory, pending);
  }
  await pending;
}
async function regular(
  root: string,
  relative: string,
  checkedDirs?: Map<string, Promise<void>>,
) {
  if (!safeRelative(relative)) throw new Error("Unsafe upstream tool path.");
  const parts = relative.split("/");
  let current = root;
  for (let i = 0; i < parts.length - 1; i++) {
    current = path.join(current, parts[i]!);
    await verifyDirectory(current, checkedDirs);
  }
  const file = path.join(current, parts[parts.length - 1]!);
  const info = await lstat(file);
  if (info.isSymbolicLink())
    throw new Error("Linked upstream tool paths are forbidden.");
  if (!info.isFile())
    throw new Error("Upstream tool payload must be a regular file.");
  return { file, info };
}
// Size and modification time of each asset when it last matched its
// checksum. An asset whose stamp still matches is not hashed again: the kit
// has ~4.7k files, and hashing them all made every Windows check of this
// computer take over a minute.
type Stamps = Record<string, [size: number, mtimeMs: number]>;
const stampsFile = (directory: string) => `${directory}.verified.json`;
async function readStamps(
  directory: string,
  source: LocalmodelsToolSource,
): Promise<Stamps | undefined> {
  try {
    const value = JSON.parse(await readFile(stampsFile(directory), "utf8")) as {
      manifestSha256?: unknown;
      stamps?: Stamps;
    };
    return value.manifestSha256 === source.manifestSha256 &&
      value.stamps &&
      typeof value.stamps === "object"
      ? value.stamps
      : undefined;
  } catch {
    return undefined;
  }
}
async function writeStamps(
  directory: string,
  source: LocalmodelsToolSource,
  stamps: Stamps,
) {
  await atomicPrivate(
    stampsFile(directory),
    JSON.stringify({ manifestSha256: source.manifestSha256, stamps }),
  ).catch(() => undefined);
}
/** Marks a stop that could not verify the pinned localmodels kit. */
export const LOCALMODELS_KIT_VERIFICATION_FAILED =
  "LOCALMODELS_KIT_VERIFICATION_FAILED";
// Assets hashed at once.
const CONCURRENCY = 32;
async function verify(
  directory: string,
  source: LocalmodelsToolSource,
  known: Stamps = {},
) {
  const checkedDirs = new Map<string, Promise<void>>();
  const { file: manifestFile, info: manifestInfo } = await regular(
    directory,
    "tool.json",
    checkedDirs,
  );
  const body = await readFile(manifestFile);
  if (createHash("sha256").update(body).digest("hex") !== source.manifestSha256)
    throw new Error("Upstream tool manifest checksum mismatch.");
  const m = JSON.parse(body.toString()) as ToolManifest;
  if (
    m.schemaVersion !== 1 ||
    m.platform !== process.platform ||
    m.arch !== process.arch ||
    m.sourceCommit !== source.sourceCommit ||
    !m.assets ||
    !m.assets[m.python] ||
    !safeRelative(m.moduleDir)
  )
    throw new Error(
      "Upstream tool distribution target or source does not match.",
    );
  const assets = Object.entries(m.assets);
  const writable: string[] = [];
  if (process.platform === "win32" && manifestInfo.mode & 0o200)
    writable.push(manifestFile);
  const stamps: Stamps = {};
  let hashed = 0;
  // Recovery may move or remove this kit, so wait for all active reads even
  // when one worker has already found a mismatched asset.
  await runBounded(assets, CONCURRENCY, async ([name, expected]) => {
    if (!/^[a-f0-9]{64}$/.test(expected))
      throw new Error("Upstream tool payload checksum mismatch.");
    const { file, info } = await regular(directory, name, checkedDirs);
    if (process.platform === "win32" && info.mode & 0o200) writable.push(file);
    const stamp: [number, number] = [info.size, info.mtimeMs];
    const seen = known[name];
    if (!seen || seen[0] !== stamp[0] || seen[1] !== stamp[1]) {
      hashed += 1;
      if ((await sha256File(file)) !== expected)
        throw new Error("Upstream tool payload checksum mismatch.");
    }
    stamps[name] = stamp;
  });
  return {
    python: path.join(directory, ...m.python.split("/")),
    pythonRel: m.python,
    moduleDir: path.join(directory, m.moduleDir),
    moduleDirRel: m.moduleDir,
    sourceCommit: m.sourceCommit,
    stamps,
    hashed,
    writable,
  };
}
const location = (tool: Awaited<ReturnType<typeof verify>>) => ({
  python: tool.python,
  moduleDir: tool.moduleDir,
  sourceCommit: tool.sourceCommit,
});
async function unpack(archive: string, directory: string) {
  let size = 0;
  // tar calls the filter from a stream event, so an error thrown there would
  // escape as an uncaught exception and leave extract() pending forever.
  // Record the first refusal, skip every later member, and throw afterwards,
  // as native-dependencies.ts does.
  let refused: Error | undefined;
  const refuse = (message: string) => {
    refused ??= new Error(message);
    return false;
  };
  await extract({
    file: archive,
    cwd: directory,
    strict: true,
    preservePaths: false,
    noMtime: true,
    filter: (name, entry) => {
      const type =
        "type" in entry
          ? entry.type
          : entry.isDirectory()
            ? "Directory"
            : entry.isFile()
              ? "File"
              : "Unsupported";
      if (refused) return false;
      const relative = name.replace(/^\.\//, "").replace(/\/$/, "");
      if (!relative) return type === "Directory";
      if (!safeRelative(relative) || !["File", "Directory"].includes(type))
        return refuse("Unsafe upstream tool archive.");
      size += entry.size;
      if (size > 1024 ** 3)
        return refuse(
          "Upstream tool archive exceeds its extracted size limit.",
        );
      return true;
    },
  });
  if (refused) throw refused;
}
/**
 * Verified kits are sealed read-only: upstream children that run the kit's
 * Python without -B would otherwise rewrite verified bytecode, and every later
 * verification would fail.
 */
async function setKitMode(directory: string, sealed: boolean) {
  if (process.platform === "win32") return;
  if (!sealed) await chmod(directory, 0o700);
  const subdirs: string[] = [];
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) subdirs.push(file);
    else if (sealed && entry.isFile()) files.push(file);
  }
  await runBounded(files, CONCURRENCY, async (file) => {
    await chmod(file, (await lstat(file)).mode & 0o500);
  });
  for (const subdir of subdirs) await setKitMode(subdir, sealed);
  await chmod(directory, sealed ? 0o500 : 0o700);
}
/** The Windows read-only attribute prevents CPython from replacing a verified cache file. */
async function sealWindowsFiles(writable: string[]) {
  for (let offset = 0; offset < writable.length; offset += CONCURRENCY)
    await Promise.all(
      writable
        .slice(offset, offset + CONCURRENCY)
        .map((file) => chmod(file, 0o400)),
    );
}
async function installedKit(directory: string, source: LocalmodelsToolSource) {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && info.uid !== process.getuid?.())
  )
    throw new Error("Upstream tool kit must be an owned directory.");
  if (process.platform === "win32") await privateDirectory(directory);
  const tool = await verify(
    directory,
    source,
    await readStamps(directory, source),
  );
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o500)
    await setKitMode(directory, true);
  await sealWindowsFiles(tool.writable);
  if (tool.hashed > 0) await writeStamps(directory, source, tool.stamps);
  return location(tool);
}
/** Filename of an optional pre-bundled kit archive staged beside distribution.json. */
export const BUNDLED_LOCALMODELS_KIT_FILENAME = "bundled-localmodels-kit.tgz";

/**
 * Resolves the optional pre-bundled localmodels kit archive path beside the
 * given distribution.json, or from LINGER_LOCALMODELS_TOOL_ARCHIVE when omitted.
 */
export function bundledToolArchivePath(
  distributionFile?: string,
): string | undefined {
  if (distributionFile !== undefined) {
    return path.join(
      path.dirname(path.resolve(distributionFile)),
      BUNDLED_LOCALMODELS_KIT_FILENAME,
    );
  }
  const configured = process.env.LINGER_LOCALMODELS_TOOL_ARCHIVE?.trim();
  return configured ? path.resolve(configured) : undefined;
}

async function verifyBundledToolArchive(
  archivePath: string,
  source: LocalmodelsToolSource,
): Promise<boolean> {
  let info;
  try {
    info = await lstat(archivePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(
      "Bundled localmodels kit archive must be a regular non-symlink file.",
    );
  }
  if (info.size !== source.bytes) {
    throw new Error(
      `Bundled localmodels kit archive size mismatch: expected ${source.bytes} bytes, got ${info.size}.`,
    );
  }
  const actualSha256 = await sha256File(archivePath);
  if (actualSha256 !== source.sha256) {
    throw new Error(
      `Bundled localmodels kit archive checksum mismatch: expected ${source.sha256}, got ${actualSha256}.`,
    );
  }
  return true;
}

export interface ToolPrepareDependencies {
  source?: LocalmodelsToolSource;
  bundledArchivePath?: string | null;
  fetcher?: typeof fetch;
  lockPollMs?: number;
  lockWaitMs?: number;
}
const KIT_LOCK_POLL_MS = 250;
const KIT_LOCK_WAIT_MS = 10 * 60_000;
async function prepareLocalmodelsTool(
  home: string,
  options: Options = {},
  dependencies: ToolPrepareDependencies = {},
) {
  const pinned = dependencies.source ?? pinnedToolSource();
  if (!pinned)
    throw new Error(
      "Upstream tool distribution metadata is unavailable. Download the current Linger installer.",
    );
  const source = validateToolSource(pinned);
  const directory = kitDirectory(home, source);
  const base = path.dirname(directory);
  await privateDirectory(base);
  // Published kits are immutable and renamed into place only after validation.
  // Readers must not compete for the cross-process installation lock.
  try {
    const tool = await installedKit(directory, source);
    if (tool) return tool;
  } catch {
    // An altered kit is replaced below, under the publication lock.
  }
  const signal = options.signal ?? new AbortController().signal;
  const lock = path.join(base, "lock");
  await privateDirectory(lock);
  const lockPollMs = dependencies.lockPollMs ?? KIT_LOCK_POLL_MS;
  const lockWaitMs = dependencies.lockWaitMs ?? KIT_LOCK_WAIT_MS;
  const lockDeadline = Date.now() + lockWaitMs;
  let waited = false;
  for (;;) {
    signal.throwIfAborted();
    try {
      const tool = await installedKit(directory, source);
      if (tool) return tool;
    } catch {
      // An altered kit is replaced below, under the publication lock.
    }
    let acquired = false;
    try {
      return await withInstanceLock({ root: lock } as Instance, async () => {
        acquired = true;
        let damaged = false;
        try {
          const tool = await installedKit(directory, source);
          if (tool) return tool;
        } catch (error) {
          if (/owned directory/.test((error as Error).message)) throw error;
          damaged = true;
        }
        signal.throwIfAborted();
        if (damaged) {
          // Re-fetch the same pinned kit; the altered copy is moved aside first so
          // the published path only ever holds a verified kit.
          const invalid = path.join(base, `invalid-${randomUUID()}`);
          // macOS also requires the source directory to be writable when moving
          // a sealed directory. Ownership was checked above; reopen only its root
          // before quarantine, then reopen descendants at the quarantined path.
          if (process.platform !== "win32") await chmod(directory, 0o700);
          await renameRetrying(directory, invalid, { signal });
          await setKitMode(invalid, false);
          await rm(invalid, { recursive: true, force: true });
        }
        const stage = path.join(base, `pending-${randomUUID()}`);
        await privateDirectory(stage);
        const downloadedArchive = path.join(base, `${randomUUID()}.tgz`);
        let usedBundledArchive = false;
        let archive = downloadedArchive;
        try {
          options.onEvent?.({
            kind: "stage",
            stage: "preflight",
            state: "running",
            message: damaged
              ? "Repairing the model and Harness installation tool…"
              : "Preparing the model and Harness installation tool…",
          });
          const downloadStartedAt = Date.now();
          const bundledArchive =
            dependencies.bundledArchivePath !== undefined
              ? (dependencies.bundledArchivePath ?? undefined)
              : dependencies.source === undefined
                ? bundledToolArchivePath()
                : undefined;
          if (
            bundledArchive &&
            (await verifyBundledToolArchive(bundledArchive, source))
          ) {
            usedBundledArchive = true;
            archive = bundledArchive;
            options.onEvent?.({
              kind: "stage",
              stage: "preflight",
              state: "running",
              message:
                "Using verified bundled model and Harness installation tool…",
            });
            options.onEvent?.({
              kind: "log",
              stage: "preflight",
              message:
                "Using verified bundled localmodels kit archive; skipping network download.\n",
            });
          } else {
            await downloadInRegion(
              home,
              {
                url: source.url,
                mirrors: source.mirrors,
                output: downloadedArchive,
                algorithm: "sha256",
                digest: source.sha256,
                maxBytes: source.bytes,
                signal,
                onEvent: (event) =>
                  options.onEvent?.({
                    kind: "log",
                    stage: "preflight",
                    message: `${formatRegionDownloadEvent(event)}\n`,
                  }),
                onProgress: (completed, total) =>
                  options.onEvent?.({
                    kind: "stage",
                    stage: "preflight",
                    state: "running",
                    message:
                      "Downloading the model and Harness installation tool…",
                    progress: { completed, total, unit: "bytes" },
                  }),
              },
              dependencies.fetcher,
            );
          }
          signal.throwIfAborted();
          const unpackStartedAt = Date.now();
          await unpack(archive, stage);
          // The kit is an npm tarball: its files sit under package/.
          const kit = path.join(stage, "package");
          const verifyStartedAt = Date.now();
          const tool = await verify(kit, source);
          const verifiedAt = Date.now();
          if (process.platform !== "win32") await chmod(tool.python, 0o700);
          // The kit manifest is private state; publisher bytes stay unchanged for digest checks.
          const manifest = path.join(kit, "tool.json");
          const body = await readFile(manifest, "utf8");
          // A read-only archive manifest cannot be replaced on Windows until
          // it is writable. Seal the replacement as well as the verified assets.
          if (
            process.platform === "win32" &&
            !tool.writable.includes(manifest)
          ) {
            await chmod(manifest, 0o600);
            tool.writable.push(manifest);
          }
          await atomicPrivate(manifest, body);
          await sealWindowsFiles(tool.writable);
          signal.throwIfAborted();
          await renameRetrying(kit, directory, { signal });
          // Every file and stamp was just verified inside the locked private stage
          // before this atomic rename, so only confirm the published entry path.
          const { file: publishedPython } = await regular(
            directory,
            tool.pythonRel,
          );
          await setKitMode(directory, true);
          await writeStamps(directory, source, tool.stamps);
          const seconds = (ms: number) => (ms / 1000).toFixed(1);
          options.onEvent?.({
            kind: "log",
            stage: "preflight",
            message: usedBundledArchive
              ? `localmodels kit prepared from bundled archive (s): verify-archive ${seconds(unpackStartedAt - downloadStartedAt)}, unpack ${seconds(verifyStartedAt - unpackStartedAt)}, verify ${seconds(verifiedAt - verifyStartedAt)}.\n`
              : `localmodels kit prepared (s): download ${seconds(unpackStartedAt - downloadStartedAt)}, unpack ${seconds(verifyStartedAt - unpackStartedAt)}, verify ${seconds(verifiedAt - verifyStartedAt)}.\n`,
          });
          return {
            python: publishedPython,
            moduleDir: path.join(directory, tool.moduleDirRel),
            sourceCommit: tool.sourceCommit,
          };
        } finally {
          await rm(stage, { recursive: true, force: true });
          if (!usedBundledArchive) {
            await rm(downloadedArchive, { force: true });
          }
        }
      });
    } catch (error) {
      if (
        acquired ||
        (error as { code?: unknown } | null)?.code !== INSTANCE_BUSY
      )
        throw error;
      if (Date.now() >= lockDeadline) throw error;
      if (!waited) {
        waited = true;
        options.onEvent?.({
          kind: "stage",
          stage: "preflight",
          state: "running",
          message:
            "Waiting for the model and Harness installation tool download already in progress…",
        });
        options.onEvent?.({
          kind: "log",
          stage: "preflight",
          message:
            "Waiting for another process preparing the localmodels kit…\n",
        });
      }
      await delay(
        Math.min(lockPollMs, Math.max(1, lockDeadline - Date.now())),
        undefined,
        { signal },
      );
    }
  }
}
export interface LocalmodelsToolLocation {
  python: string;
  moduleDir: string;
  sourceCommit: string;
}
type ToolLocation = LocalmodelsToolLocation;
const preparing = new Map<string, Promise<ToolLocation>>();
const verifiedToolSession = new AsyncLocalStorage<Map<string, ToolLocation>>();

/**
 * Reuses already-verified localmodels tool locations across sequential calls in
 * one installation or resume run so the kit's assets are not re-statted for
 * each CLI invocation.
 */
export function withLocalmodelsToolCache<T>(run: () => Promise<T>): Promise<T> {
  const existing = verifiedToolSession.getStore();
  if (existing) return run();
  return verifiedToolSession.run(new Map(), run);
}

/**
 * Reads the optional development localmodels checkout override from env.
 * Rejects partial or relative values so installer and Desktop fail fast
 * with the same contract.
 */
export function configuredDevTool(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platformPath: typeof path = path,
): LocalmodelsToolLocation | undefined {
  const python = env.LINGER_LOCALMODELS_DEV_PYTHON?.trim();
  const moduleDir = env.LINGER_LOCALMODELS_DEV_MODULE_DIR?.trim();
  if (!python && !moduleDir) return undefined;
  if (!python || !moduleDir)
    throw new Error(
      "LINGER_LOCALMODELS_DEV_PYTHON and LINGER_LOCALMODELS_DEV_MODULE_DIR must be set together.",
    );
  if (!platformPath.isAbsolute(python) || !platformPath.isAbsolute(moduleDir))
    throw new Error(
      "LINGER_LOCALMODELS_DEV_PYTHON and LINGER_LOCALMODELS_DEV_MODULE_DIR must be absolute paths.",
    );
  return { python, moduleDir, sourceCommit: "0".repeat(40) };
}
export async function ensureLocalmodelsTool(
  home: string,
  options: Options = {},
  dependencies: ToolPrepareDependencies = {},
): Promise<ToolLocation> {
  options.signal?.throwIfAborted();
  const devTool = configuredDevTool();
  if (
    devTool &&
    (!dependencies.source ||
      dependencies.source.url.startsWith("https://dev.invalid/"))
  )
    return devTool;
  const key = `${path.resolve(home)}:${JSON.stringify(dependencies.source ?? pinnedToolSource())}`;
  const sessionCache = verifiedToolSession.getStore();
  const cached = sessionCache?.get(key);
  if (cached && existsSync(cached.python)) return cached;
  const running = preparing.get(key);
  if (running) {
    const result = await running;
    options.signal?.throwIfAborted();
    sessionCache?.set(key, result);
    return result;
  }
  const task = prepareLocalmodelsTool(home, options, dependencies);
  preparing.set(key, task);
  try {
    const result = await task;
    sessionCache?.set(key, result);
    return result;
  } finally {
    preparing.delete(key);
  }
}
const DEFAULT_BIFROST_HOST = "127.0.0.1";
const DEFAULT_BIFROST_PORT = 18480;
const DEFAULT_BIFROST_ADDR = `${DEFAULT_BIFROST_HOST}:${DEFAULT_BIFROST_PORT}`;
const MAX_OWNED_MANIFEST_BYTES = 1024 * 1024;

interface LoopbackBifrostAddress {
  addr: string;
  port: number;
}

interface BifrostAddressDependencies {
  portFree?: (port: number) => Promise<boolean>;
  freePort?: (
    reserved: Set<number>,
    options?: { preferred?: number },
  ) => Promise<number>;
}

interface RunCommandControl extends BifrostAddressDependencies {
  allocateBifrostAddr?: boolean;
  resolveBundledPi?: typeof resolveBundledPi;
}

const STRIPPED_LOCALMODELS_ENVIRONMENT = new Set([
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONINSPECT",
  "PYTHONPATH",
  "PYTHONUTF8",
  "PYTHONIOENCODING",
  "LOCALMODELS_STATE",
  "LOCALMODELS_TOOLS_DIR",
  "LOCALMODELS_BIFROST_DIR",
  "LOCALMODELS_BIFROST_ADDR",
  "SIMPLEX_REGION",
  "SIMPLEX_REGION_FILE",
]);

const resolvingBifrostAddr = new Map<string, Promise<string>>();

/** LOCALMODELS_STATE of every call for this home. */
export function localmodelsStateDirectory(
  home: string,
  platformPath: typeof path = path,
): string {
  return platformPath.join(
    platformPath.resolve(home),
    "runtime",
    "localmodels",
    "state",
  );
}
/** Where this home's models live: every call's --base-dir. */
export function localmodelsBaseDirectory(
  home: string,
  platformPath: typeof path = path,
): string {
  return platformPath.join(
    platformPath.resolve(home),
    "runtime",
    "localmodels",
    "models",
  );
}
/** LOCALMODELS_TOOLS_DIR of every call for this home. */
export function localmodelsToolsDirectory(home: string): string {
  return path.join(path.resolve(home), "runtime", "localmodels", "tools");
}
/** LOCALMODELS_BIFROST_DIR of every call for this home. */
export function localmodelsBifrostDirectory(home: string): string {
  return path.join(path.resolve(home), "runtime", "localmodels", "bifrost");
}
/** Persisted loopback Bifrost address file for this home. */
export function localmodelsBifrostAddrFile(home: string): string {
  return path.join(
    path.resolve(home),
    "runtime",
    "localmodels",
    "bifrost-addr",
  );
}
function parseLoopbackBifrostAddress(
  raw: unknown,
): LoopbackBifrostAddress | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  const match = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(trimmed);
  if (!match) return undefined;
  const port = Number(match[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return undefined;
  return { addr: `${DEFAULT_BIFROST_HOST}:${port}`, port };
}
/**
 * The approved stack plan Quick Install saved for this home. The path is
 * fixed by the installer, not by localmodels.
 */
export function localmodelsPlanFile(home: string): string {
  return path.join(path.resolve(home), "runtime", "localmodels", "plan.json");
}
/**
 * Records library model IDs that were active before a quit or upgrade stop so
 * the next launch reloads them even after `stopLocalmodels` resets them to
 * `idle` (or an empty array when the stop ran with downloaded models all idle).
 */
export function localmodelsResumeModelsFile(home: string): string {
  return path.join(
    path.resolve(home),
    "runtime",
    "localmodels",
    "resume-models.json",
  );
}
const RESUME_MODELS_SCHEMA = "linger.localmodels-resume/v1";
const LIBRARY_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*:[A-Za-z0-9._-]+$/;

/** Reports whether `id` is a valid localmodels library model identifier. */
export function isLibraryModelId(id: unknown): id is string {
  return typeof id === "string" && LIBRARY_MODEL_ID_PATTERN.test(id);
}

/** Filters valid library model IDs and deduplicates them in order. */
export function uniqueLibraryModelIds(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!isLibraryModelId(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/**
 * Reads the persisted model list saved before a quit or upgrade stop, or
 * undefined when no valid record exists.
 */
export async function readResumeLocalModels(
  home: string,
): Promise<string[] | undefined> {
  try {
    const raw = await readPrivate(localmodelsResumeModelsFile(home));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { schema?: unknown; models?: unknown };
    if (
      parsed?.schema !== RESUME_MODELS_SCHEMA ||
      !Array.isArray(parsed.models)
    )
      return undefined;
    return uniqueLibraryModelIds(parsed.models);
  } catch {
    return undefined;
  }
}

/**
 * Atomically persists the library model IDs to restore on the next launch.
 */
export async function writeResumeLocalModels(
  home: string,
  models: readonly string[],
): Promise<void> {
  const file = localmodelsResumeModelsFile(home);
  await privateDirectory(path.dirname(file));
  await atomicPrivate(
    file,
    JSON.stringify({
      schema: RESUME_MODELS_SCHEMA,
      models: uniqueLibraryModelIds(models),
    }),
  );
}

/** Removes any persisted post-stop local model resume record. */
export async function clearResumeLocalModels(home: string): Promise<void> {
  await rm(localmodelsResumeModelsFile(home), { force: true });
}

/**
 * Reads localmodels' own per-model records under `<state>/library/models/*.json`
 * and returns IDs whose on-disk state is `loaded`. Used to recover models that
 * were active before a reboot or crash (when `stopLocalmodels` never ran)
 * without spawning Python on homes with no loaded models.
 */
export async function readOnDiskLoadedLibraryModels(
  home: string,
): Promise<string[]> {
  const modelsDir = path.join(
    localmodelsStateDirectory(home),
    "library",
    "models",
  );
  let entries;
  try {
    entries = await readdir(modelsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries
    .filter((entry) => !entry.isDirectory() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const loaded: string[] = [];
  for (const name of names) {
    const record = await readOwnedJson(path.join(modelsDir, name));
    if (!record) continue;
    const state = field(record, "state");
    const id = field(record, "id");
    if (state === "loaded" && isLibraryModelId(id)) loaded.push(id);
  }
  return uniqueLibraryModelIds(loaded);
}
/**
 * Records the shared tools directory a home kept from before per-home
 * isolation; holds that directory's absolute path.
 */
export function localmodelsLegacyToolsMarkerFile(home: string): string {
  return path.join(path.resolve(home), "runtime", "localmodels", "tools-dir");
}
/**
 * localmodels' own default tools directory (its TOOLS_DIR,
 * ~/.local/share/localmodels/tools on every platform), which every home
 * shared before Linger gave each home its own.
 */
export function legacyLocalmodelsToolsDirectory(): string {
  return path.join(os.homedir(), ".local", "share", "localmodels", "tools");
}
// owned.json and plan.json are written by localmodels with the process umask
// rather than 0600, so this checks for a regular owned file of bounded size.
async function readOwnedJson(file: string): Promise<object | undefined> {
  try {
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > MAX_OWNED_MANIFEST_BYTES ||
      (process.platform !== "win32" && info.uid !== process.getuid?.())
    )
      return undefined;
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}
function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
interface OwnedBifrostRecord {
  address?: LoopbackBifrostAddress;
  appDir?: string;
}
async function readOwnedBifrost(toolsDir: string): Promise<OwnedBifrostRecord> {
  const owned = await readOwnedJson(path.join(toolsDir, "owned.json"));
  const bifrost = field(field(owned, "gateway"), "bifrost");
  const appDir = field(bifrost, "app_dir");
  return {
    address: parseLoopbackBifrostAddress(field(bifrost, "addr")),
    appDir:
      typeof appDir === "string" && path.isAbsolute(appDir)
        ? path.normalize(appDir)
        : undefined,
  };
}
async function readOwnedBifrostAddress(
  toolsDir: string,
): Promise<LoopbackBifrostAddress | undefined> {
  return (await readOwnedBifrost(toolsDir)).address;
}
// Deployment names of every service a stack plan deploys, as localmodels'
// stack_verify.parts lists them.
function planDeploymentNames(plan: unknown): string[] {
  const parts = [
    field(plan, "llm"),
    field(plan, "llm_fast"),
    field(plan, "decision"),
    field(plan, "decision_front"),
    ...(Array.isArray(field(plan, "aux"))
      ? (field(plan, "aux") as unknown[])
      : []),
  ];
  return parts
    .map((part) => field(part, "name"))
    .filter((name): name is string => typeof name === "string" && !!name);
}
/**
 * The shared tools directory this home still runs from, or undefined when it
 * uses its own. A home whose plan was applied before per-home isolation keeps
 * its deployments' ownership, Pi profile and Bifrost in localmodels' default
 * tools directory; running it against an empty per-home directory reads as
 * "deployments removed" and the plan as changed, so the home stays where its
 * plan was applied. Only a deployment the shared owned.json places under this
 * home's models counts, since names repeat across homes. The choice is
 * recorded once.
 */
export async function legacyLocalmodelsTools(
  home: string,
): Promise<string | undefined> {
  const marker = localmodelsLegacyToolsMarkerFile(home);
  const recorded = (await readPrivate(marker).catch(() => undefined))?.trim();
  if (recorded && path.isAbsolute(recorded)) return path.normalize(recorded);
  if (
    await readOwnedJson(
      path.join(localmodelsToolsDirectory(home), "owned.json"),
    )
  )
    return undefined;
  const names = planDeploymentNames(
    await readOwnedJson(localmodelsPlanFile(home)),
  );
  if (!names.length) return undefined;
  const legacy = legacyLocalmodelsToolsDirectory();
  const deployments = field(
    await readOwnedJson(path.join(legacy, "owned.json")),
    "deployments",
  );
  if (!deployments || typeof deployments !== "object") return undefined;
  // Deployment names are only <model>-<port>, so another home may own the
  // same name; only a deployment living under this home's models counts.
  const base = localmodelsBaseDirectory(home);
  const ownsHere = (name: string) => {
    const entry = field(deployments, name);
    const deployDir = field(entry, "deploy_dir");
    if (field(entry, "removed") === true || typeof deployDir !== "string")
      return false;
    const relative = path.relative(base, deployDir);
    return (
      !!relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    );
  };
  if (!names.some(ownsHere)) return undefined;
  await privateDirectory(path.dirname(marker));
  await atomicPrivate(marker, `${legacy}\n`);
  return legacy;
}
async function readSavedBifrostAddress(
  addrFile: string,
): Promise<LoopbackBifrostAddress | undefined> {
  try {
    const raw = await readPrivate(addrFile);
    return raw ? parseLoopbackBifrostAddress(raw) : undefined;
  } catch {
    return undefined;
  }
}
function isReadOnlyOrStopCommand(args: readonly string[]): boolean {
  const [group, verb] = args;
  if (group === "harness" || group === "debug") return true;
  if (group === "stack") return verb === "down" || verb === "remove";
  if (group === "library")
    return (
      verb === "status" ||
      verb === "unload" ||
      verb === "remove" ||
      verb === "cancel"
    );
  if (group === "foundations") return verb === "stop";
  if (group === "gateway") return verb === "stop";
  if (group === "source")
    return verb === "status" || verb === "check" || verb === "models";
  if (group === "setup")
    return verb === "inspect" || verb === "review" || verb === "binding";
  return false;
}
function stripInheritedEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!STRIPPED_LOCALMODELS_ENVIRONMENT.has(key.toUpperCase()))
      cleaned[key] = value;
  }
  return cleaned;
}
/**
 * Resolves the per-home loopback Bifrost address: prefers this home's owned
 * gateway record, then its persisted bifrost-addr file, and on allocating
 * calls picks 127.0.0.1:18480 when free or persists an ephemeral free port
 * when another process holds 18480. Read-only and stop calls never probe or
 * persist a port.
 */
export async function resolveLocalmodelsBifrostAddr(
  home: string,
  options: { allocate?: boolean } = {},
  dependencies: BifrostAddressDependencies = {},
): Promise<string> {
  const allocate = options.allocate ?? true;
  const toolsDir = localmodelsToolsDirectory(home);
  const addrFile = localmodelsBifrostAddrFile(home);
  const checkFree =
    dependencies.portFree ??
    ((port: number) => portFree(port, "tcp", { allInterfaces: true }));
  const pickFree =
    dependencies.freePort ??
    ((reserved: Set<number>, opts?: { preferred?: number }) =>
      freePort(reserved, { ...opts, allInterfaces: true }));
  const resolveOnce = async (): Promise<string> => {
    const owned = await readOwnedBifrostAddress(toolsDir);
    if (owned) return owned.addr;
    const saved = await readSavedBifrostAddress(addrFile);
    if (saved && (!allocate || (await checkFree(saved.port))))
      return saved.addr;
    if (!allocate) return DEFAULT_BIFROST_ADDR;
    const port = await pickFree(new Set(), { preferred: DEFAULT_BIFROST_PORT });
    const addr = `${DEFAULT_BIFROST_HOST}:${port}`;
    await privateDirectory(path.dirname(addrFile));
    await atomicPrivate(addrFile, `${addr}\n`);
    return addr;
  };
  if (!allocate || dependencies.portFree || dependencies.freePort)
    return resolveOnce();
  const key = path.resolve(home);
  const pending = resolvingBifrostAddr.get(key);
  if (pending) return pending;
  const task = resolveOnce();
  resolvingBifrostAddr.set(key, task);
  try {
    return await task;
  } finally {
    resolvingBifrostAddr.delete(key);
  }
}
function formatDownloadedBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
export async function runLocalmodels(
  home: string,
  args: string[],
  options: Options = {},
  dependencies: {
    run?: typeof runProcess;
    resolveBundledPi?: typeof resolveBundledPi;
  } & BifrostAddressDependencies = {},
) {
  return runLocalmodelsCommand(
    home,
    args,
    options,
    () => ensureLocalmodelsTool(home, options),
    dependencies.run,
    {
      allocateBifrostAddr: !isReadOnlyOrStopCommand(args),
      portFree: dependencies.portFree,
      freePort: dependencies.freePort,
      resolveBundledPi: dependencies.resolveBundledPi,
    },
  );
}
// Hosts come from the kit's mirror list; anything else is not shown.
function displayHost(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= 253 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)
    ? value
    : undefined;
}
function downloadStageMessage(
  value: Record<string, unknown>,
  label: string,
  harnessApply: boolean,
): string | undefined {
  if (value.state === "connecting") {
    const host = displayHost(value.host);
    return host ? `${label}: connecting to ${host}…` : `${label}: connecting…`;
  }
  if (value.state === "switching") {
    const host = displayHost(value.to);
    return host ? `${label}: switching to ${host}…` : `${label}: switching…`;
  }
  if (value.state === "retrying")
    return harnessApply
      ? "Retrying the Harness download…"
      : `${label}: retrying…`;
  return undefined;
}

// LOCALMODELS_* paths and Bifrost address for one call. A legacy home gets
// its shared tools directory and only the Bifrost directory and address that
// directory's owned.json records, so localmodels falls back to its own
// defaults for the rest exactly as it did when the plan was applied.
async function localmodelsIsolation(
  home: string,
  args: readonly string[],
  control: RunCommandControl,
): Promise<NodeJS.ProcessEnv> {
  const legacy = await legacyLocalmodelsTools(home);
  if (legacy) {
    const owned = await readOwnedBifrost(legacy);
    return {
      LOCALMODELS_TOOLS_DIR: legacy,
      ...(owned.appDir ? { LOCALMODELS_BIFROST_DIR: owned.appDir } : {}),
      ...(owned.address
        ? { LOCALMODELS_BIFROST_ADDR: owned.address.addr }
        : {}),
    };
  }
  const tools = localmodelsToolsDirectory(home);
  const bifrost = localmodelsBifrostDirectory(home);
  await privateDirectory(tools);
  await privateDirectory(bifrost);
  return {
    LOCALMODELS_TOOLS_DIR: tools,
    LOCALMODELS_BIFROST_DIR: bifrost,
    LOCALMODELS_BIFROST_ADDR: await resolveLocalmodelsBifrostAddr(
      home,
      {
        allocate: control.allocateBifrostAddr ?? !isReadOnlyOrStopCommand(args),
      },
      control,
    ),
  };
}

export interface BifrostPrefetchResult {
  ok: boolean;
  cached?: boolean;
  unsupported?: boolean;
  version?: string;
  name?: string;
  bytes?: number;
  message?: string;
}

const PREFETCH_BIFROST_PYTHON = `
import json, os, platform, sys
from pathlib import Path
from localmodels import gateway_bifrost, harness, hosts

tools_dir = Path(os.path.expanduser(hosts.tools_dir()))
lock = harness.load_lock()
if "bifrost" not in lock:
    print(json.dumps({"ok": False, "unsupported": True, "message": "the tool lock has no Bifrost"}))
    sys.exit(0)
machine = platform.machine().lower()
arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64"}.get(machine, machine)
try:
    build = harness.tool_build(lock["bifrost"]["builds"], sys.platform, arch, "Bifrost")
except harness.HarnessError as exc:
    print(json.dumps({"ok": False, "unsupported": True, "message": str(exc)}))
    sys.exit(0)
artifact = harness.tool_artifact(build)
version = lock["bifrost"]["version"]
actions, _ = gateway_bifrost.plan_tools({}, sys.platform, arch, False, str(tools_dir), lock)
bifrost_action = next((a for a in actions if a["tool"] == "bifrost"), None)
if bifrost_action is None:
    raise harness.HarnessError("Bifrost plan did not return a bifrost action")
archive = Path(harness.archive_files(tools_dir, artifact)[0])
already_cached = (
    bifrost_action["action"] == "reuse"
    or (archive.is_file() and harness.digest(str(archive)) == artifact["sha256"])
)
if not already_cached:
    harness._fetch(tools_dir, artifact, lambda _line: None)
print(json.dumps({
    "ok": True,
    "cached": already_cached,
    "version": version,
    "name": artifact["name"],
    "bytes": artifact["size_bytes"],
}))
`.trim();

/**
 * Downloads the pinned Bifrost archive into localmodels' per-home archive
 * cache using the kit's own locked fetch helper, without writing owned.json,
 * allocating a port, or starting the gateway.
 */
export async function prefetchLocalmodelsBifrost(
  home: string,
  options: Options = {},
  dependencies: {
    run?: typeof runProcess;
    ensureTool?: typeof ensureLocalmodelsTool;
  } = {},
): Promise<BifrostPrefetchResult> {
  options.signal?.throwIfAborted();
  const tool = await (dependencies.ensureTool ?? ensureLocalmodelsTool)(
    home,
    options,
  );
  options.signal?.throwIfAborted();
  const env = await localmodelsEnvironment(
    home,
    tool,
    ["source", "status"],
    options,
    { allocateBifrostAddr: false },
  );
  options.signal?.throwIfAborted();
  const run = dependencies.run ?? runProcess;
  let result: Awaited<ReturnType<typeof runProcess>>;
  try {
    result = await run(
      tool.python,
      ["-P", "-s", "-c", PREFETCH_BIFROST_PYTHON],
      {
        ...options,
        cwd: tool.moduleDir,
        env,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 10 * 60_000,
      },
    );
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  options.signal?.throwIfAborted();
  if (result.code !== 0) {
    return {
      ok: false,
      message: result.stderr.trim().slice(-500) || `exit ${result.code}`,
    };
  }
  const lastLine = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!lastLine) {
    return { ok: false, message: "Bifrost prefetch returned no output." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    return { ok: false, message: "Bifrost prefetch returned invalid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      message: "Bifrost prefetch returned an unexpected payload.",
    };
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.ok !== "boolean") {
    return { ok: false, message: "Bifrost prefetch payload is missing ok." };
  }
  return {
    ok: record.ok,
    ...(typeof record.cached === "boolean" ? { cached: record.cached } : {}),
    ...(typeof record.unsupported === "boolean"
      ? { unsupported: record.unsupported }
      : {}),
    ...(typeof record.version === "string" ? { version: record.version } : {}),
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.bytes === "number" && Number.isFinite(record.bytes)
      ? { bytes: record.bytes }
      : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
  };
}

async function localmodelsEnvironment(
  home: string,
  tool: ToolLocation,
  args: readonly string[],
  options: Options,
  control: RunCommandControl,
): Promise<NodeJS.ProcessEnv> {
  const state = localmodelsStateDirectory(home);
  await privateDirectory(state);
  const isolation = await localmodelsIsolation(home, args, control);
  const resolvedRegion = await cachedRegion(home, { signal: options.signal });
  const env: NodeJS.ProcessEnv = {
    ...stripInheritedEnvironment({ ...process.env, ...options.env }),
    // Reuse a forced or cached region without blocking offline startup on a
    // network probe; localmodels probes lazily and shares region.json via
    // SIMPLEX_REGION_FILE when it actually downloads.
    SIMPLEX_REGION: resolvedRegion ?? "auto",
    SIMPLEX_REGION_FILE: regionFile(home),
    PYTHONPATH: tool.moduleDir,
    LOCALMODELS_STATE: state,
    ...isolation,
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    // Force UTF-8 mode so Python reads and writes UTF-8 state files and stdio
    // instead of falling back to a legacy Windows ANSI code page.
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
  delete env.PYTHONHOME;
  delete env.PYTHONSTARTUP;
  delete env.PYTHONINSPECT;
  return env;
}

async function runLocalmodelsCommand(
  home: string,
  args: string[],
  options: Options,
  loadTool: () => Promise<ToolLocation | undefined>,
  run: typeof runProcess = runProcess,
  control: RunCommandControl = {},
) {
  const startedAt = Date.now();
  const tool = await loadTool();
  if (!tool) throw new Error("The installed localmodels tool kit is missing.");
  const checkedAt = Date.now();
  const env = await localmodelsEnvironment(home, tool, args, options, control);
  const isSetupInspect = args[0] === "setup" && args[1] === "inspect";
  const resolvedBundledPi =
    options.bundledPi !== undefined
      ? (options.bundledPi ?? undefined)
      : isSetupInspect
        ? undefined
        : await (control.resolveBundledPi ?? resolveBundledPi)();
  const bundledPi = resolvedBundledPi
    ? await ensureStableBundledPi(home, resolvedBundledPi)
    : undefined;
  const effectiveEnv = bundledPi
    ? await withBundledPiPath(env, { home, bundledPi })
    : env;
  const harnessApply = args[0] === "harness" && args[1] === "apply";
  const sourceApply = args[0] === "source" && args[1] === "apply";
  const label =
    args[0] === "gateway"
      ? "Downloading the application model gateway"
      : sourceApply
        ? "Downloading the model gateway"
        : "Downloading the selected Harness";
  type LocalmodelsPhase = "download" | "extract" | "verify" | "install";
  const phaseMs: Partial<Record<LocalmodelsPhase, number>> = {};
  let activePhase: LocalmodelsPhase | undefined;
  let phaseStartedAt: number | undefined;
  let lastDownloadAt: number | undefined;
  let downloadRetries = 0;
  let downloadSwitches = 0;
  const closePhase = (at: number) => {
    if (!activePhase || phaseStartedAt === undefined) return;
    phaseMs[activePhase] =
      (phaseMs[activePhase] ?? 0) + Math.max(0, at - phaseStartedAt);
    activePhase = undefined;
    phaseStartedAt = undefined;
  };
  const enterPhase = (phase: LocalmodelsPhase, at: number) => {
    if (activePhase === phase) return;
    closePhase(at);
    activePhase = phase;
    phaseStartedAt = at;
    phaseMs[phase] ??= 0;
  };
  let pending = "";
  const onOutput = (chunk: string) => {
    options.onOutput?.(chunk);
    pending += chunk;
    if (pending.length > 65536) pending = pending.slice(-65536);
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (value?.kind === "stage" && value.stage === "download") {
        const now = Date.now();
        if (value.state === "retrying") downloadRetries += 1;
        else if (value.state === "switching") downloadSwitches += 1;
        enterPhase("download", now);
        lastDownloadAt = now;
        const message = downloadStageMessage(value, label, harnessApply);
        if (message)
          options.onEvent?.({
            kind: "stage",
            stage: "runtime",
            state: "running",
            message,
          });
        continue;
      }
      if (harnessApply && value?.kind === "stage") {
        const now = Date.now();
        const key = `${String(value.stage)}:${String(value.state)}`;
        if (key === "extract:running") enterPhase("extract", now);
        else if (key === "verify:running") enterPhase("verify", now);
        else if (key === "install:running") enterPhase("install", now);
        else if (key === "install:succeeded" || key === "reuse:succeeded")
          closePhase(now);
        const messages: Record<string, string> = {
          "extract:running":
            "Extracting Harness files and applying private permissions…",
          "verify:running": "Verifying the installed Harness executable…",
          "install:running": "Installing the selected Harness…",
          "install:succeeded":
            "Harness files installed; checking runtime status…",
          "reuse:succeeded":
            "Reusing the existing Harness; checking runtime status…",
        };
        const message = messages[key];
        if (message)
          options.onEvent?.({
            kind: "stage",
            stage: "runtime",
            state: "running",
            message,
          });
        continue;
      }
      if (
        !value ||
        value.kind !== "progress" ||
        value.unit !== "bytes" ||
        typeof value.completed !== "number" ||
        !Number.isSafeInteger(value.completed) ||
        value.completed < 0
      )
        continue;
      const hasTotal = value.total !== null && value.total !== undefined;
      if (
        hasTotal &&
        (typeof value.total !== "number" ||
          !Number.isSafeInteger(value.total) ||
          value.total <= 0 ||
          value.completed > value.total)
      )
        continue;
      const now = Date.now();
      enterPhase("download", now);
      lastDownloadAt = now;
      options.onEvent?.({
        kind: "stage",
        stage: "runtime",
        state: "running",
        message: hasTotal
          ? `${label}…`
          : `${label} (${formatDownloadedBytes(value.completed)})…`,
        progress: hasTotal
          ? {
              completed: value.completed,
              total: value.total as number,
              unit: "bytes",
            }
          : { completed: value.completed, unit: "bytes" },
      });
    }
  };
  const result = await run(
    tool.python,
    ["-P", "-s", "-m", "localmodels", ...args],
    {
      ...options,
      cwd: tool.moduleDir,
      env: effectiveEnv,
      onOutput,
    },
  );
  const endedAt = Date.now();
  let postDownloadMs: number | undefined;
  if (
    sourceApply &&
    activePhase === "download" &&
    lastDownloadAt !== undefined
  ) {
    closePhase(lastDownloadAt);
    postDownloadMs = Math.max(0, endedAt - lastDownloadAt);
  } else {
    closePhase(endedAt);
  }
  const seconds = (ms: number) => (ms / 1000).toFixed(1);
  const parts: string[] = [];
  if (phaseMs.download !== undefined)
    parts.push(`download ${seconds(phaseMs.download)}s`);
  if (downloadRetries > 0) parts.push(`retries ${downloadRetries}`);
  if (downloadSwitches > 0) parts.push(`switches ${downloadSwitches}`);
  if (phaseMs.extract !== undefined)
    parts.push(`extract ${seconds(phaseMs.extract)}s`);
  if (phaseMs.verify !== undefined)
    parts.push(`verify ${seconds(phaseMs.verify)}s`);
  if (phaseMs.install !== undefined)
    parts.push(`install ${seconds(phaseMs.install)}s`);
  if (postDownloadMs !== undefined)
    parts.push(`post-download ${seconds(postDownloadMs)}s`);
  if (parts.length > 0) {
    options.onEvent?.({
      kind: "log",
      stage: "runtime",
      message: `localmodels ${args.slice(0, 2).join(" ")} phases: ${parts.join(", ")}.\n`,
    });
  }
  options.onEvent?.({
    kind: "log",
    message: `localmodels ${args.slice(0, 2).join(" ")}: tool checked in ${seconds(checkedAt - startedAt)}s, ran in ${seconds(endedAt - checkedAt)}s.\n`,
  });
  return result;
}
// How often and how long a quit-time stop reads the library after
// cancelling loads, until none is loading.
const CANCEL_POLL_MS = 500;
const CANCEL_WAIT_MS = 10_000;
/**
 * Stops what the pinned kit runs for a home, through that kit: first every
 * load the model library is running (`library cancel`), reading the library
 * every 500 ms for up to 10 s until none is loading, then every model the
 * last read shows loaded (`library unload`), whose engines `stack down`
 * leaves running, so a load that finished before its cancel is unloaded. A
 * model still loading after the wait is a stop failure. Then, unless `keepController`, the model controller
 * under <home>/runtime/model-services, and last the stack's processes and
 * the gateway the tool started (`stack down`), the library's Bifrost
 * included. An uninstall or an install over this release stops all of it; a
 * quit keeps the controller, which belongs to the services that keep
 * running. Nothing is downloaded. An absent pinned kit is skipped; a pinned
 * kit that is present but fails verification is reported as a stop failure.
 * Every stop command runs even when an earlier command fails; the error
 * names each that did not stop.
 */
export async function stopLocalmodels(
  home: string,
  options: {
    signal: AbortSignal;
    log?: (message: string) => void;
    keepController?: boolean;
  },
  dependencies: {
    run?: typeof runLocalmodels;
    runProcess?: typeof runProcess;
    installed?: (home: string) => Promise<boolean>;
    cancelPollMs?: number;
    cancelWaitMs?: number;
  } = {},
): Promise<void> {
  let installed: boolean;
  try {
    installed = await (dependencies.installed ?? hasPinnedTool)(home);
  } catch (error) {
    throw Object.assign(
      new Error(error instanceof Error ? error.message : String(error), {
        cause: error,
      }),
      {
        code: LOCALMODELS_KIT_VERIFICATION_FAILED,
      },
    );
  }
  if (!installed) return;
  const run =
    dependencies.run ??
    ((home, args, options = {}) =>
      runLocalmodelsCommand(
        home,
        args,
        options,
        () => installedPinnedTool(home),
        dependencies.runProcess,
        { allocateBifrostAddr: false },
      ));
  const base = localmodelsBaseDirectory(home);
  const failed: string[] = [];
  const step = async (
    args: string[],
    name = args.slice(0, 2).join(" "),
    report = true,
  ) => {
    options.signal.throwIfAborted();
    options.log?.(`Stopping the local models (localmodels ${name}).`);
    const startedAt = Date.now();
    const result = await run(home, args, {
      signal: options.signal,
      timeoutMs: 30_000,
    }).catch((error: unknown) => {
      options.signal.throwIfAborted();
      return {
        code: 1,
        stdout: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
        stderr: "",
      };
    });
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    options.log?.(
      result.code === 0
        ? `Stopped localmodels ${name} in ${elapsed}s.`
        : `localmodels ${name} failed in ${elapsed}s.`,
    );
    if (report && result.code !== 0)
      failed.push(`localmodels ${name}: ${stopFailure(result)}`);
    return result;
  };
  const status = await step([
    "library",
    "status",
    "--base-dir",
    base,
    "--json",
  ]);
  const unloadAll = async (models: string[]) => {
    for (const model of models)
      await step(
        ["library", "unload", model, "--base-dir", base, "--json"],
        `library unload ${model}`,
      );
  };
  if (status.code === 0) {
    let last = status.stdout;
    const allModels = libraryModels(last, () => true);
    const loading = libraryModelsIn(last, "loading");
    const resumable = resumableLibraryModels(last);
    if (!unloadableLibraryModels(last) || !loading || !resumable)
      failed.push("localmodels library status: no model list");
    // Record active models before cancelling or unloading so the next launch
    // restores them across quit, reboot, or upgrade stops regardless of active
    // model source mode. Never wipe an already-pending non-empty list when a
    // chained stop (such as Windows setup `--stop` after a quit) finds models
    // already idle.
    if (resumable) {
      try {
        const existing = await readResumeLocalModels(home);
        if (resumable.length > 0) {
          await writeResumeLocalModels(home, [
            ...resumable,
            ...(existing ?? []),
          ]);
        } else if (allModels && allModels.length > 0 && !existing?.length) {
          await writeResumeLocalModels(home, []);
        }
      } catch (error) {
        options.log?.(
          `Could not record local models for next launch: ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
    }
    // A load left running would make its model resident after the app is
    // gone. A cancel that fails because the load just finished is not a
    // failure: that model is unloaded below.
    const cancelFailures = new Map<string, string>();
    for (const model of loading ?? []) {
      const name = `library cancel ${model}`;
      const result = await step(
        ["library", "cancel", model, "--base-dir", base, "--json"],
        name,
        false,
      );
      if (result.code !== 0)
        cancelFailures.set(
          model,
          `localmodels ${name}: ${stopFailure(result)}`,
        );
    }
    if (loading?.length) {
      // A cancelled load leaves loading only once its engine stopped.
      const deadline =
        Date.now() + (dependencies.cancelWaitMs ?? CANCEL_WAIT_MS);
      for (;;) {
        const again = await step(
          ["library", "status", "--base-dir", base, "--json"],
          "library status",
          false,
        );
        if (again.code === 0 && libraryModelsIn(again.stdout, "loading"))
          last = again.stdout;
        if (!libraryModelsIn(last, "loading")?.length || Date.now() >= deadline)
          break;
        await sleep(
          dependencies.cancelPollMs ?? CANCEL_POLL_MS,
          options.signal,
        );
      }
      for (const model of libraryModelsIn(last, "loading") ?? [])
        failed.push(
          cancelFailures.get(model) ??
            `localmodels library cancel ${model}: still loading`,
        );
    }
    await unloadAll(unloadableLibraryModels(last) ?? []);
  }
  if (!options.keepController)
    await step([
      "foundations",
      "stop",
      "--root",
      modelServicesRoot(home),
      "--json",
    ]);
  await step(["stack", "down", "--json"]);
  if (failed.length) throw new Error(failed.join("; "));
}
const STOPPED_DOWNLOAD_ERROR_CODES = new Set([
  "DOWNLOAD_FAILED",
  "NETWORK_UNAVAILABLE",
  "DISK_INSUFFICIENT",
]);

/**
 * Reports whether a failed library model row represents a stopped download
 * rather than a downloaded model whose server or load failed.
 */
export function isStoppedDownloadErrorCode(code: unknown): boolean {
  return typeof code === "string" && STOPPED_DOWNLOAD_ERROR_CODES.has(code);
}

// Parses `library status` JSON output and returns valid model IDs matching
// include, or undefined when stdout is not a status report.
function libraryModels(
  stdout: string,
  include: (model: { id: string; state?: unknown; error?: unknown }) => boolean,
): string[] | undefined {
  try {
    const models = (JSON.parse(stdout) as { models?: unknown }).models;
    if (!Array.isArray(models)) return undefined;
    return models.flatMap(
      (model: { id?: unknown; state?: unknown; error?: unknown }) => {
        if (!isLibraryModelId(model?.id)) return [];
        return include({ id: model.id, state: model.state, error: model.error })
          ? [model.id]
          : [];
      },
    );
  } catch {
    return undefined;
  }
}
// The ids of the models `library status` reports in state, or undefined
// when its output is not a status report.
function libraryModelsIn(
  stdout: string,
  state: "loaded" | "loading",
): string[] | undefined {
  return libraryModels(stdout, (model) => model.state === state);
}
function isRecoverableFailedLibraryModel(error: unknown): boolean {
  const errorCode =
    error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
  return !isStoppedDownloadErrorCode(errorCode);
}
// The ids of the models `library status` reports as loaded or failed after a
// server/load failure (excluding stopped downloads, which hold no library
// record to unload), or undefined when its output is not a status report.
function unloadableLibraryModels(stdout: string): string[] | undefined {
  return libraryModels(stdout, (model) => {
    if (model.state === "loaded") return true;
    if (model.state !== "failed") return false;
    return isRecoverableFailedLibraryModel(model.error);
  });
}
// The ids of models active before stop that should be restored on next launch:
// loaded, currently loading, or failed after a server/load failure (excluding
// stopped downloads).
function resumableLibraryModels(stdout: string): string[] | undefined {
  const ids = libraryModels(stdout, (model) => {
    if (model.state === "loaded" || model.state === "loading") return true;
    if (model.state !== "failed") return false;
    return isRecoverableFailedLibraryModel(model.error);
  });
  return ids ? uniqueLibraryModelIds(ids) : undefined;
}
// A failed step's structured cause: the library's error code, the tool's
// error, or its exit status.
function stopFailure(result: { code: number; stdout: string }): string {
  try {
    const report = JSON.parse(result.stdout) as {
      code?: unknown;
      error?: unknown;
    };
    if (
      typeof report.code === "string" &&
      /^[A-Z][A-Z_]{0,63}$/.test(report.code)
    )
      return report.code;
    if (typeof report.error === "string" && report.error) return report.error;
  } catch {
    // No report: the exit status is all there is.
  }
  return `exit ${result.code}`;
}
async function hasPinnedTool(home: string): Promise<boolean> {
  return (await installedPinnedTool(home)) !== undefined;
}
async function installedPinnedTool(
  home: string,
): Promise<ToolLocation | undefined> {
  const devTool = configuredDevTool();
  if (devTool) return devTool;
  const source = pinnedToolSource();
  if (!source) return;
  return installedKit(kitDirectory(home, source), source).catch(
    (cause: unknown) => {
      throw new Error(
        "Cannot stop local models: the installed tool kit could not be verified. Start Linger to repair the kit, then try again.",
        { cause },
      );
    },
  );
}
/**
 * The kit this release pins, from the installer's published metadata
 * (LINGER_LOCALMODELS_TOOL_JSON), or undefined when it ships none. The one
 * reader of that variable.
 */
export function pinnedToolSource(): LocalmodelsToolSource | undefined {
  if (configuredDevTool()) {
    return {
      url: "https://dev.invalid/localmodels.tgz",
      sha256: "0".repeat(64),
      bytes: 1,
      sourceCommit: "0".repeat(40),
      manifestSha256: "0".repeat(64),
    };
  }
  const raw = process.env.LINGER_LOCALMODELS_TOOL_JSON;
  return raw ? validateToolSource(JSON.parse(raw)) : undefined;
}
function kitDirectory(home: string, source: LocalmodelsToolSource): string {
  return path.join(path.resolve(home), "tools", "localmodels", source.sha256);
}
/** Where the foundations controller of a home keeps its state. */
export function modelServicesRoot(home: string): string {
  return path.join(path.resolve(home), "runtime", "model-services");
}
export async function readPublishedTool(
  file: string,
): Promise<LocalmodelsToolSource | undefined> {
  let value: { platform?: unknown; arch?: unknown; localmodelsTool?: unknown };
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw error;
  }
  if (value.localmodelsTool === undefined) return;
  if (value.platform !== process.platform || value.arch !== process.arch)
    throw new Error(
      "Upstream tool distribution target does not match this computer.",
    );
  return validateToolSource(value.localmodelsTool);
}
