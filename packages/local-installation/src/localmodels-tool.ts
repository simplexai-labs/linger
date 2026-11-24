import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, rm, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sleep } from "@linger/service-kit";
import { x as extract } from "tar";
import { downloadInRegion, resolveRegion } from "./region.js";
import {
  atomicPrivate,
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
type Options = ProcessOptions & { onEvent?: (event: InstallerEvent) => void };
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
async function digest(file: string) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest("hex");
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
  let next = 0;
  const worker = async () => {
    while (next < assets.length) {
      const [name, expected] = assets[next++]!;
      if (!/^[a-f0-9]{64}$/.test(expected))
        throw new Error("Upstream tool payload checksum mismatch.");
      const { file, info } = await regular(directory, name, checkedDirs);
      if (process.platform === "win32" && info.mode & 0o200)
        writable.push(file);
      const stamp: [number, number] = [info.size, info.mtimeMs];
      const seen = known[name];
      if (!seen || seen[0] !== stamp[0] || seen[1] !== stamp[1]) {
        hashed += 1;
        if ((await digest(file)) !== expected)
          throw new Error("Upstream tool payload checksum mismatch.");
      }
      stamps[name] = stamp;
    }
  };
  // Recovery may move or remove this kit, so wait for all active reads even
  // when one worker has already found a mismatched asset.
  let failure: { reason: unknown } | undefined;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, assets.length) }, () =>
      worker().catch((error: unknown) => {
        next = assets.length;
        failure ??= { reason: error };
      }),
    ),
  );
  if (failure) throw failure.reason;
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
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await setKitMode(file, sealed);
    else if (sealed && entry.isFile())
      await chmod(file, (await lstat(file)).mode & 0o500);
  }
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
async function prepareLocalmodelsTool(
  home: string,
  options: Options = {},
  dependencies: { source?: LocalmodelsToolSource; fetcher?: typeof fetch } = {},
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
  const lock = path.join(base, "lock");
  await privateDirectory(lock);
  return withInstanceLock({ root: lock } as Instance, async () => {
    let damaged = false;
    try {
      const tool = await installedKit(directory, source);
      if (tool) return tool;
    } catch (error) {
      if (/owned directory/.test((error as Error).message)) throw error;
      damaged = true;
    }
    const signal = options.signal ?? new AbortController().signal;
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
    const archive = path.join(base, `${randomUUID()}.tgz`);
    try {
      options.onEvent?.({
        kind: "stage",
        stage: "preflight",
        state: "running",
        message: damaged
          ? "Repairing the model and Harness installation tool…"
          : "Preparing the model and Harness installation tool…",
      });
      await downloadInRegion(
        home,
        {
          url: source.url,
          mirrors: source.mirrors,
          output: archive,
          algorithm: "sha256",
          digest: source.sha256,
          maxBytes: source.bytes,
          signal,
          onProgress: (completed, total) =>
            options.onEvent?.({
              kind: "stage",
              stage: "preflight",
              state: "running",
              message: "Downloading the model and Harness installation tool…",
              progress: { completed, total, unit: "bytes" },
            }),
        },
        dependencies.fetcher,
      );
      await unpack(archive, stage);
      // The kit is an npm tarball: its files sit under package/.
      const kit = path.join(stage, "package");
      const tool = await verify(kit, source);
      if (process.platform !== "win32") await chmod(tool.python, 0o700);
      // The kit manifest is private state; publisher bytes stay unchanged for digest checks.
      const manifest = path.join(kit, "tool.json");
      const body = await readFile(manifest, "utf8");
      // A read-only archive manifest cannot be replaced on Windows until
      // it is writable. Seal the replacement as well as the verified assets.
      if (process.platform === "win32" && !tool.writable.includes(manifest)) {
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
      return {
        python: publishedPython,
        moduleDir: path.join(directory, tool.moduleDirRel),
        sourceCommit: tool.sourceCommit,
      };
    } finally {
      await rm(stage, { recursive: true, force: true });
      await rm(archive, { force: true });
    }
  });
}
type ToolLocation = Awaited<ReturnType<typeof prepareLocalmodelsTool>>;
const preparing = new Map<string, Promise<ToolLocation>>();
function configuredDevTool(): ToolLocation | undefined {
  const python = process.env.LINGER_LOCALMODELS_DEV_PYTHON?.trim();
  const moduleDir = process.env.LINGER_LOCALMODELS_DEV_MODULE_DIR?.trim();
  if (!python || !moduleDir) return undefined;
  if (!path.isAbsolute(python) || !path.isAbsolute(moduleDir))
    throw new Error(
      "LINGER_LOCALMODELS_DEV_PYTHON and LINGER_LOCALMODELS_DEV_MODULE_DIR must be absolute paths.",
    );
  return { python, moduleDir, sourceCommit: "0".repeat(40) };
}
export async function ensureLocalmodelsTool(
  home: string,
  options: Options = {},
  dependencies: { source?: LocalmodelsToolSource; fetcher?: typeof fetch } = {},
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
  const running = preparing.get(key);
  if (running) {
    const result = await running;
    options.signal?.throwIfAborted();
    return result;
  }
  const task = prepareLocalmodelsTool(home, options, dependencies);
  preparing.set(key, task);
  try {
    return await task;
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
]);

const resolvingBifrostAddr = new Map<string, Promise<string>>();

/** LOCALMODELS_STATE of every call for this home. */
export function localmodelsStateDirectory(home: string): string {
  return path.join(path.resolve(home), "runtime", "localmodels", "state");
}
/** Where this home's models live: every call's --base-dir. */
export function localmodelsBaseDirectory(home: string): string {
  return path.join(path.resolve(home), "runtime", "localmodels", "models");
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
  dependencies: { run?: typeof runProcess } & BifrostAddressDependencies = {},
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
  const state = localmodelsStateDirectory(home);
  await privateDirectory(state);
  const isolation = await localmodelsIsolation(home, args, control);
  const env: NodeJS.ProcessEnv = {
    ...stripInheritedEnvironment({ ...process.env, ...options.env }),
    // localmodels downloads from the same region and does not probe again.
    SIMPLEX_REGION: await resolveRegion(home, { signal: options.signal }),
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
  const harnessApply = args[0] === "harness" && args[1] === "apply";
  const label =
    args[0] === "gateway"
      ? "Downloading the application model gateway"
      : args[0] === "source" && args[1] === "apply"
        ? "Downloading the model gateway"
        : "Downloading the selected Harness";
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
        const message =
          messages[`${String(value.stage)}:${String(value.state)}`];
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
      env,
      onOutput,
    },
  );
  const seconds = (ms: number) => (ms / 1000).toFixed(1);
  options.onEvent?.({
    kind: "log",
    message: `localmodels ${args.slice(0, 2).join(" ")}: tool checked in ${seconds(checkedAt - startedAt)}s, ran in ${seconds(Date.now() - checkedAt)}s.\n`,
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
    const loading = libraryModelsIn(last, "loading");
    if (!unloadableLibraryModels(last) || !loading)
      failed.push("localmodels library status: no model list");
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
        if (
          typeof model?.id !== "string" ||
          !/^[a-z0-9][a-z0-9._-]*:[A-Za-z0-9._-]+$/.test(model.id)
        )
          return [];
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
// The ids of the models `library status` reports as loaded or failed after a
// server/load failure (excluding stopped downloads, which hold no library
// record to unload), or undefined when its output is not a status report.
function unloadableLibraryModels(stdout: string): string[] | undefined {
  return libraryModels(stdout, (model) => {
    if (model.state === "loaded") return true;
    if (model.state !== "failed") return false;
    const errorCode =
      model.error && typeof model.error === "object"
        ? (model.error as { code?: unknown }).code
        : undefined;
    return !isStoppedDownloadErrorCode(errorCode);
  });
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (value.localmodelsTool === undefined) return;
  if (value.platform !== process.platform || value.arch !== process.arch)
    throw new Error(
      "Upstream tool distribution target does not match this computer.",
    );
  return validateToolSource(value.localmodelsTool);
}
