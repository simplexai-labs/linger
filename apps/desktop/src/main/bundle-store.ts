import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createZstdDecompress } from "node:zlib";

import {
  DENYLIST_SCHEMA,
  parseDenylistState,
  parseLocalReleaseDescriptor,
  parseReleasePointer,
  readJsonIfExists,
  resolveSafeHomePath,
  writeJsonAtomic,
  type BundleModuleId,
  type DenylistEntry,
  type DenylistState,
  type LocalReleaseDescriptor,
  type ReleasePointer,
} from "@linger/local-installation/release-descriptor";

import type { Module, ModuleContext } from "./modules.js";
import { compareVersions } from "./update-manifest.js";

const runExec = promisify(execFile);

export interface BundleStoreOptions {
  readonly home: string | (() => string);
  readonly seedDirectory?: string;
  readonly target?: string;
  /**
   * Optional predicate gating cold-start offline seed import (e.g. skip seed
   * import in Thin Client mode when connected to a remote server).
   */
  readonly shouldImportSeed?: () => Promise<boolean> | boolean;
}

export interface GcOptions {
  readonly nowMs?: number;
  readonly minAgeMs?: number;
}

export interface GcResult {
  readonly removedReleases: readonly string[];
  readonly removedModules: readonly string[];
  readonly removedNodeDeps: readonly string[];
}

export interface ArchiveSeedManifest {
  readonly schema: 1;
  readonly mode?: "archive";
  readonly appVersion: string;
  readonly channel: "stable" | "beta" | "canary";
  readonly target: string;
  readonly compat: LocalReleaseDescriptor["compat"];
  readonly infra: LocalReleaseDescriptor["infra"];
  readonly bundles: Readonly<
    Record<
      BundleModuleId | "node-native-deps",
      {
        readonly artifactId: string;
        readonly file: string;
        readonly sha256: string;
        readonly bytes: number;
        readonly inputHash?: string;
      }
    >
  >;
}

export interface ShellBaselineSeedManifest {
  readonly schema: 1;
  readonly mode: "shell-baseline";
  readonly appVersion: string;
  readonly channel: "stable" | "beta" | "canary";
  readonly compat: LocalReleaseDescriptor["compat"];
  readonly infra: {
    readonly node: string;
    readonly postgres?: string;
    readonly voiceTools?: string;
    readonly nodeDeps: string;
  };
  readonly bundles: Readonly<
    Record<
      BundleModuleId | "node-native-deps",
      {
        readonly artifactId: string;
        readonly inputHash: string;
      }
    >
  >;
}

export type SeedManifest = ArchiveSeedManifest | ShellBaselineSeedManifest;

const VERIFIED_MARKER = "verified.json";
const DEFAULT_GC_MIN_AGE_MS = 24 * 60 * 60_000;

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function assertSafeTarEntries(listOutput: string): void {
  const lines = listOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const entry of lines) {
    const normalized = entry.replace(/\\/g, "/");
    if (
      normalized.startsWith("/") ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.split("/").includes("..")
    ) {
      throw new Error(`Unsafe tar archive entry rejected: ${entry}`);
    }
  }
}

async function extractTarZstArchive(
  archivePath: string,
  destinationDir: string,
): Promise<void> {
  const tarTemp = `${destinationDir}.tar`;
  await mkdir(destinationDir, { recursive: true, mode: 0o700 });
  try {
    await pipeline(
      createReadStream(archivePath),
      createZstdDecompress(),
      createWriteStream(tarTemp, { mode: 0o600 }),
    );
    const { stdout: entries } = await runExec("tar", ["-tf", tarTemp]);
    assertSafeTarEntries(entries);
    await runExec("tar", ["-xf", tarTemp, "-C", destinationDir]);
  } finally {
    await rm(tarTemp, { force: true }).catch(() => undefined);
  }
}

/**
 * Owns `<LINGER_HOME>/{infra,store,releases,state,downloads}` for V2 modular
 * releases: immutable content-addressed storage, crash-safe JSON pointers,
 * cold-start seed import, and reference-counted garbage collection.
 */
export class BundleStoreModule implements Module {
  readonly name = "BundleStore";
  readonly dependsOn = ["Config"];
  readonly #options: BundleStoreOptions;
  #ctx: ModuleContext | undefined;

  constructor(options: BundleStoreOptions) {
    this.#options = options;
  }

  get home(): string {
    const raw =
      typeof this.#options.home === "function"
        ? this.#options.home()
        : this.#options.home;
    return path.resolve(raw);
  }

  get stateDir(): string {
    return path.join(this.home, "state");
  }

  get releasesDir(): string {
    return path.join(this.home, "releases");
  }

  get storeDir(): string {
    return path.join(this.home, "store");
  }

  get infraDir(): string {
    return path.join(this.home, "infra");
  }

  get downloadsDir(): string {
    return path.join(this.home, "downloads");
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await mkdir(this.releasesDir, { recursive: true, mode: 0o700 });
    await mkdir(this.storeDir, { recursive: true, mode: 0o700 });
    await mkdir(this.infraDir, { recursive: true, mode: 0o700 });
    await mkdir(this.downloadsDir, { recursive: true, mode: 0o700 });

    // Crash recovery: if a previous switch died mid-flight leaving a stale or
    // corrupted pending.json while current.json still points to the old release,
    // discard pending.json so startup recovers cleanly.
    try {
      const pending = await this.readPending();
      if (pending) {
        ctx.log.warn("bundle_store.discarded_stale_pending", {
          appVersion: pending.appVersion,
        });
        await rm(this.#pointerPath("pending"), { force: true });
      }
    } catch (error) {
      ctx.log.warn("bundle_store.discarded_corrupt_pending", {
        error: error instanceof Error ? error.message : String(error),
      });
      await rm(this.#pointerPath("pending"), { force: true });
    }

    await this.ensureSeeded();
  }

  /**
   * Idempotently ensures the local V2 store has a baseline release seeded from
   * `seedDirectory/seed-manifest.json` when running in local server mode.
   *
   * Imports when no `state/current.json` exists yet OR when the bundled Shell
   * seed version is strictly newer than the currently active release
   * (Shell upgrade). Never overwrites an equal or newer V2 release.
   */
  async ensureSeeded(): Promise<boolean> {
    const allowSeed = this.#options.shouldImportSeed
      ? await this.#options.shouldImportSeed()
      : true;
    if (!allowSeed || !this.#options.seedDirectory) return false;
    const seedManifestPath = path.join(
      this.#options.seedDirectory,
      "seed-manifest.json",
    );
    if (!existsSync(seedManifestPath)) return false;

    const seed = JSON.parse(
      await readFile(seedManifestPath, "utf8"),
    ) as SeedManifest;
    const current = await this.readCurrent();
    if (current && compareVersions(seed.appVersion, current.appVersion) <= 0) {
      return false;
    }

    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await mkdir(this.releasesDir, { recursive: true, mode: 0o700 });
    await mkdir(this.storeDir, { recursive: true, mode: 0o700 });
    await mkdir(this.infraDir, { recursive: true, mode: 0o700 });
    await mkdir(this.downloadsDir, { recursive: true, mode: 0o700 });

    await this.importSeed(this.#options.seedDirectory);
    return true;
  }

  async stop(): Promise<void> {}

  #pointerPath(kind: "current" | "pending" | "previous"): string {
    return path.join(this.stateDir, `${kind}.json`);
  }

  #denylistPath(): string {
    return path.join(this.stateDir, "denylist.json");
  }

  moduleDir(moduleId: BundleModuleId, artifactId: string): string {
    return path.join(this.storeDir, moduleId, artifactId);
  }

  moduleRelativePath(moduleId: BundleModuleId, artifactId: string): string {
    return `store/${moduleId}/${artifactId}`;
  }

  nodeDepsDir(shortId: string): string {
    return path.join(this.infraDir, "node-deps", shortId);
  }

  nodeDepsRelativePath(shortId: string): string {
    return `infra/node-deps/${shortId}`;
  }

  async hasVerifiedModule(
    moduleId: BundleModuleId,
    artifactId: string,
    expectedSha256: string,
  ): Promise<boolean> {
    const markerPath = path.join(
      this.moduleDir(moduleId, artifactId),
      VERIFIED_MARKER,
    );
    try {
      const raw = JSON.parse(await readFile(markerPath, "utf8")) as {
        artifactId?: string;
        sha256?: string;
      };
      return raw.artifactId === artifactId && raw.sha256 === expectedSha256;
    } catch {
      return false;
    }
  }

  async hasVerifiedNodeDeps(
    shortId: string,
    expectedSha256?: string,
  ): Promise<boolean> {
    const markerPath = path.join(this.nodeDepsDir(shortId), VERIFIED_MARKER);
    try {
      const raw = JSON.parse(await readFile(markerPath, "utf8")) as {
        shortId?: string;
        sha256?: string;
      };
      if (raw.shortId !== shortId) return false;
      return expectedSha256 ? raw.sha256 === expectedSha256 : true;
    } catch {
      return false;
    }
  }

  async stageModuleArchive(
    moduleId: BundleModuleId,
    artifactId: string,
    archivePath: string,
    expectedSha256: string,
  ): Promise<string> {
    if (await this.hasVerifiedModule(moduleId, artifactId, expectedSha256)) {
      return this.moduleDir(moduleId, artifactId);
    }
    const actualSha = await sha256File(archivePath);
    if (actualSha !== expectedSha256) {
      throw new Error(
        `Archive digest mismatch for ${moduleId}/${artifactId}: expected ${expectedSha256}, got ${actualSha}`,
      );
    }
    const finalDir = this.moduleDir(moduleId, artifactId);
    const stagingDir = `${finalDir}.staging-${process.pid}-${Date.now()}`;
    await mkdir(path.dirname(finalDir), { recursive: true, mode: 0o700 });
    await rm(stagingDir, { recursive: true, force: true });
    try {
      await extractTarZstArchive(archivePath, stagingDir);
      await writeJsonAtomic(path.join(stagingDir, VERIFIED_MARKER), {
        artifactId,
        sha256: expectedSha256,
        verifiedAt: new Date().toISOString(),
      });
      await rm(finalDir, { recursive: true, force: true });
      await rename(stagingDir, finalDir);
      return finalDir;
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
      throw error;
    }
  }

  async stageNodeDepsArchive(
    shortId: string,
    archivePath: string,
    expectedSha256: string,
  ): Promise<string> {
    if (await this.hasVerifiedNodeDeps(shortId, expectedSha256)) {
      return this.nodeDepsDir(shortId);
    }
    const actualSha = await sha256File(archivePath);
    if (actualSha !== expectedSha256) {
      throw new Error(
        `node-native-deps digest mismatch for ${shortId}: expected ${expectedSha256}, got ${actualSha}`,
      );
    }
    const finalDir = this.nodeDepsDir(shortId);
    const stagingDir = `${finalDir}.staging-${process.pid}-${Date.now()}`;
    await mkdir(path.dirname(finalDir), { recursive: true, mode: 0o700 });
    await rm(stagingDir, { recursive: true, force: true });
    try {
      await extractTarZstArchive(archivePath, stagingDir);
      await writeJsonAtomic(path.join(stagingDir, VERIFIED_MARKER), {
        shortId,
        sha256: expectedSha256,
        verifiedAt: new Date().toISOString(),
      });
      await rm(finalDir, { recursive: true, force: true });
      await rename(stagingDir, finalDir);
      return finalDir;
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
      throw error;
    }
  }

  /**
   * Imports a bundled Shell seed into `<LINGER_HOME>` so new or Shell-upgraded
   * installations establish a V2 baseline immediately.
   *
   * Supports both zero-bloat `mode: "shell-baseline"` manifests (writes only
   * `release.json` + `state/current.json` with zero archive extraction) and
   * legacy offline archive seeds (`mode !== "shell-baseline"`).
   */
  async importSeed(seedDir: string): Promise<LocalReleaseDescriptor> {
    const manifestPath = path.join(seedDir, "seed-manifest.json");
    const seed = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as SeedManifest;
    const moduleIds: readonly BundleModuleId[] = ["web", "backend"];

    const modules = {} as Record<
      BundleModuleId,
      LocalReleaseDescriptor["modules"][BundleModuleId]
    >;
    let infra: LocalReleaseDescriptor["infra"];

    if (seed.mode === "shell-baseline") {
      infra = {
        node: seed.infra.node,
        postgres: seed.infra.postgres ?? "bundled",
        voiceTools: seed.infra.voiceTools ?? "bundled",
        nodeDeps: seed.infra.nodeDeps,
      };
      for (const mod of moduleIds) {
        const entry = seed.bundles[mod];
        const sentinelSha = createHash("sha256")
          .update(`shell-baseline:${mod}:${entry.inputHash}`)
          .digest("hex");
        modules[mod] = {
          artifactId: entry.artifactId,
          originAppVersion: seed.appVersion,
          sha256: sentinelSha,
          path: `shell/${mod}`,
          inputHash: entry.inputHash,
          source: "shell",
        };
      }
    } else {
      const nodeDepsEntry = seed.bundles["node-native-deps"];
      const nodeDepsShortId = path.basename(seed.infra.nodeDeps);
      await this.stageNodeDepsArchive(
        nodeDepsShortId,
        path.join(seedDir, nodeDepsEntry.file),
        nodeDepsEntry.sha256,
      );
      infra = seed.infra;
      for (const mod of moduleIds) {
        const entry = seed.bundles[mod];
        await this.stageModuleArchive(
          mod,
          entry.artifactId,
          path.join(seedDir, entry.file),
          entry.sha256,
        );
        modules[mod] = {
          artifactId: entry.artifactId,
          originAppVersion: seed.appVersion,
          sha256: entry.sha256,
          path: this.moduleRelativePath(mod, entry.artifactId),
          ...(entry.inputHash ? { inputHash: entry.inputHash } : {}),
          source: "store",
        };
      }
    }

    const descriptor: LocalReleaseDescriptor = {
      schema: 1,
      appVersion: seed.appVersion,
      channel: seed.channel,
      installedAt: new Date().toISOString(),
      source: "shell-seed",
      compat: seed.compat,
      infra,
      modules,
    };
    await this.writeReleaseDescriptor(descriptor);
    const now = new Date().toISOString();
    await writeJsonAtomic(this.#pointerPath("current"), {
      appVersion: seed.appVersion,
      releaseFile: `releases/${seed.appVersion}/release.json`,
      updatedAt: now,
      confirmedAt: now,
    } satisfies ReleasePointer);
    this.#ctx?.log.info("bundle_store.seed_imported", {
      appVersion: seed.appVersion,
      mode: seed.mode ?? "archive",
    });
    return descriptor;
  }

  async writeReleaseDescriptor(
    descriptor: LocalReleaseDescriptor,
  ): Promise<string> {
    const validated = parseLocalReleaseDescriptor(descriptor);
    const relFile = `releases/${validated.appVersion}/release.json`;
    const absFile = resolveSafeHomePath(this.home, relFile);
    await writeJsonAtomic(absFile, validated);
    return relFile;
  }

  async readRelease(
    appVersion: string,
  ): Promise<LocalReleaseDescriptor | undefined> {
    const file = path.join(this.releasesDir, appVersion, "release.json");
    return readJsonIfExists(file, parseLocalReleaseDescriptor);
  }

  async readCurrent(): Promise<ReleasePointer | undefined> {
    return readJsonIfExists(this.#pointerPath("current"), parseReleasePointer);
  }

  async readPending(): Promise<ReleasePointer | undefined> {
    return readJsonIfExists(this.#pointerPath("pending"), parseReleasePointer);
  }

  async readPrevious(): Promise<ReleasePointer | undefined> {
    return readJsonIfExists(this.#pointerPath("previous"), parseReleasePointer);
  }

  async currentRelease(): Promise<LocalReleaseDescriptor | undefined> {
    const ptr = await this.readCurrent();
    if (!ptr) return undefined;
    return readJsonIfExists(
      resolveSafeHomePath(this.home, ptr.releaseFile),
      parseLocalReleaseDescriptor,
    );
  }

  /**
   * Returns the `linger-computer-daemon` executable inside the active V2
   * `backend` bundle when present on disk, or `undefined` to fall back to the
   * Shell-bundled daemon binary.
   */
  async currentDaemonExecutable(
    platform: NodeJS.Platform = process.platform,
  ): Promise<string | undefined> {
    const release = await this.currentRelease().catch(() => undefined);
    if (!release || release.modules.backend.source === "shell") {
      return undefined;
    }
    const binaryName =
      platform === "win32"
        ? "linger-computer-daemon.exe"
        : "linger-computer-daemon";
    try {
      const candidate = resolveSafeHomePath(
        this.home,
        path.join(release.modules.backend.path, "computer-daemon", binaryName),
      );
      return existsSync(candidate) ? candidate : undefined;
    } catch {
      return undefined;
    }
  }

  async beginPending(pointer: ReleasePointer): Promise<void> {
    const validated = parseReleasePointer(pointer);
    await writeJsonAtomic(this.#pointerPath("pending"), validated);
  }

  /**
   * Crash-safe pointer promotion:
   *   1. Save existing `current.json` to `previous.json`
   *   2. Atomically replace `current.json` with `pending.json` (+ confirmedAt)
   *   3. Remove `pending.json`
   */
  async commitPending(): Promise<ReleasePointer> {
    const pending = await this.readPending();
    if (!pending) {
      throw new Error("No pending release to commit");
    }
    const existingCurrent = await this.readCurrent();
    if (existingCurrent && existingCurrent.appVersion !== pending.appVersion) {
      await writeJsonAtomic(this.#pointerPath("previous"), existingCurrent);
    }
    const confirmed: ReleasePointer = {
      ...pending,
      confirmedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(this.#pointerPath("current"), confirmed);
    await rm(this.#pointerPath("pending"), { force: true });
    return confirmed;
  }

  /**
   * Rolls back a failed release and records it in `denylist.json`.
   * - If `failedVersion` failed BEFORE commit (`current.json !== failedVersion`),
   *   `current.json` already points to the last healthy release; only `pending.json`
   *   is discarded so we never double-downgrade to `previous.json`.
   * - If `failedVersion` failed AFTER commit (`current.json === failedVersion`,
   *   e.g. post-commit crash watchdog), restores `previous.json` into `current.json`.
   */
  async rollbackToPrevious(
    failedVersion: string,
    stage: DenylistEntry["stage"],
    reason: string,
  ): Promise<ReleasePointer | undefined> {
    await this.addDenylist({
      appVersion: failedVersion,
      failedAt: new Date().toISOString(),
      stage,
      reason,
    });
    await rm(this.#pointerPath("pending"), { force: true });
    const current = await this.readCurrent();
    if (current && current.appVersion !== failedVersion) {
      return current;
    }
    const previous = await this.readPrevious();
    if (previous) {
      await writeJsonAtomic(this.#pointerPath("current"), {
        ...previous,
        updatedAt: new Date().toISOString(),
      } satisfies ReleasePointer);
    }
    return previous;
  }

  async readDenylist(): Promise<DenylistState> {
    return (
      (await readJsonIfExists(this.#denylistPath(), parseDenylistState)) ?? {
        schema: DENYLIST_SCHEMA,
        entries: [],
      }
    );
  }

  async isDenylisted(appVersion: string): Promise<boolean> {
    const list = await this.readDenylist();
    return list.entries.some((entry) => entry.appVersion === appVersion);
  }

  async addDenylist(entry: DenylistEntry): Promise<void> {
    const existing = await this.readDenylist();
    const filtered = existing.entries.filter(
      (item) => item.appVersion !== entry.appVersion,
    );
    await writeJsonAtomic(this.#denylistPath(), {
      schema: DENYLIST_SCHEMA,
      entries: [...filtered, entry],
    } satisfies DenylistState);
  }

  /**
   * Reference-counted garbage collection: protects `current`, `previous`, and
   * `pending` release descriptors plus their referenced store/infra directories.
   */
  async gc(options: GcOptions = {}): Promise<GcResult> {
    const nowMs = options.nowMs ?? Date.now();
    const minAgeMs = options.minAgeMs ?? DEFAULT_GC_MIN_AGE_MS;

    const pointers = [
      await this.readCurrent(),
      await this.readPrevious(),
      await this.readPending(),
    ].filter((p): p is ReleasePointer => p !== undefined);

    const pinnedReleases = new Set<string>();
    const pinnedModules = new Set<string>();
    const pinnedNodeDeps = new Set<string>();

    for (const ptr of pointers) {
      pinnedReleases.add(ptr.appVersion);
      const desc = await readJsonIfExists(
        resolveSafeHomePath(this.home, ptr.releaseFile),
        parseLocalReleaseDescriptor,
      ).catch(() => undefined);
      if (!desc) continue;
      pinnedNodeDeps.add(path.basename(desc.infra.nodeDeps));
      for (const [modId, mod] of Object.entries(desc.modules)) {
        if (mod.source === "shell") continue;
        pinnedModules.add(`${modId}/${mod.artifactId}`);
      }
    }

    const isOldEnough = async (dirPath: string): Promise<boolean> => {
      try {
        const info = await stat(dirPath);
        return nowMs - info.mtimeMs >= minAgeMs;
      } catch {
        return false;
      }
    };

    const removedReleases: string[] = [];
    for (const version of await readdir(this.releasesDir).catch(() => [])) {
      if (pinnedReleases.has(version)) continue;
      const full = path.join(this.releasesDir, version);
      if (!(await isOldEnough(full))) continue;
      await rm(full, { recursive: true, force: true }).catch(() => undefined);
      removedReleases.push(version);
    }

    const removedModules: string[] = [];
    for (const modId of await readdir(this.storeDir).catch(() => [])) {
      const modRoot = path.join(this.storeDir, modId);
      for (const artifactId of await readdir(modRoot).catch(() => [])) {
        const key = `${modId}/${artifactId}`;
        if (pinnedModules.has(key)) continue;
        const full = path.join(modRoot, artifactId);
        if (!(await isOldEnough(full))) continue;
        await rm(full, { recursive: true, force: true }).catch(() => undefined);
        removedModules.push(key);
      }
    }

    const removedNodeDeps: string[] = [];
    const nodeDepsRoot = path.join(this.infraDir, "node-deps");
    for (const shortId of await readdir(nodeDepsRoot).catch(() => [])) {
      if (pinnedNodeDeps.has(shortId)) continue;
      const full = path.join(nodeDepsRoot, shortId);
      if (!(await isOldEnough(full))) continue;
      await rm(full, { recursive: true, force: true }).catch(() => undefined);
      removedNodeDeps.push(shortId);
    }

    return { removedReleases, removedModules, removedNodeDeps };
  }
}
