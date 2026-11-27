import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type {
  BundleModuleId,
  LocalReleaseDescriptor,
  ReleaseInfraPaths,
} from "@linger/local-installation/release-descriptor";

import type { BundleStoreModule } from "./bundle-store.js";
import type { Module, ModuleContext } from "./modules.js";
import {
  DEFAULT_FEED_URL,
  ManifestError,
  UPDATE_CHANNELS,
  UPDATE_PUBLIC_KEY,
  channelFeedUrls,
  compareVersions,
  evaluateShellCompatibility,
  isInRolloutBucket,
  resolveArtifactUrl,
  verifyAppManifestV3,
  type AppManifestV3,
  type ArtifactRef,
  type BundleId,
  type UpdateChannel,
} from "./update-manifest.js";

export type BundleUpdaterState =
  | { readonly kind: "idle" }
  | { readonly kind: "checking" }
  | {
      readonly kind: "downloading";
      readonly version: string;
      readonly changedModules: readonly BundleId[];
      readonly bytesDownloaded: number;
      readonly bytesTotal: number;
    }
  | {
      readonly kind: "staged";
      readonly version: string;
      readonly changedModules: readonly BundleId[];
    }
  | {
      readonly kind: "shell-required";
      readonly version: string;
      readonly minShellVersion: string;
    }
  | { readonly kind: "failed"; readonly error: string };

export interface BundleUpdaterOptions {
  readonly shellVersion: string;
  readonly target: string;
  readonly enabled?: boolean;
  /**
   * Optional predicate indicating whether the local server stack is active on
   * this computer. When false (Thin Client connected to a remote server),
   * bundle checks stay idle and never download local backend/web bundles.
   */
  readonly isLocalMode?: () => Promise<boolean> | boolean;
  readonly defaultInfra?: ReleaseInfraPaths;
  readonly fetch?: typeof fetch;
  readonly publicKey?: string;
  readonly checkDelayMs?: number;
  readonly checkIntervalMs?: number;
  readonly retryDelayMs?: number;
}

const CHECK_DELAY_MS = 60_000;
const CHECK_INTERVAL_MS = 60 * 60_000;
const RETRY_DELAY_MS = 5 * 60_000;

const MODULE_IDS: readonly BundleModuleId[] = ["web", "backend"];

function shortNodeDepsId(hash: string): string {
  const hex = hash.replace(/^sha256:/, "");
  return `nd-${hex.slice(0, 16)}`;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isAllowedFeedUrl(url: URL): boolean {
  if (url.protocol === "https:") return true;
  if (
    url.protocol === "http:" &&
    process.env.LINGER_ALLOW_LOOPBACK_TEST_FEED === "1" &&
    LOOPBACK_HOSTS.has(url.hostname)
  ) {
    return true;
  }
  return false;
}

function parseEnvChannel(raw: string | undefined): UpdateChannel | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return (UPDATE_CHANNELS as readonly string[]).includes(trimmed)
    ? (trimmed as UpdateChannel)
    : undefined;
}

/**
 * Fetches signed Schema 3 `app-manifest.json` feeds, enforces rollout bucketing,
 * anti-downgrade, denylist, and `minShellVersion` / `compatIndex` gates, then
 * downloads ONLY modules whose SHA-256 differs from local `BundleStore`.
 */
export class BundleUpdaterModule implements Module {
  readonly name = "BundleUpdater";
  readonly dependsOn = ["Config", "BundleStore"];
  readonly #options: BundleUpdaterOptions;
  #ctx: ModuleContext | undefined;
  #state: BundleUpdaterState = { kind: "idle" };
  #staged: Extract<BundleUpdaterState, { kind: "staged" }> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #checking: Promise<void> | undefined;
  #generation = 0;
  #started = false;
  #consecutiveFailures = 0;
  #lastCheckSucceeded = false;
  readonly #unsubscribe: (() => void)[] = [];

  constructor(options: BundleUpdaterOptions) {
    this.#options = options;
  }

  state(): BundleUpdaterState {
    return this.#state;
  }

  lastCheckSucceeded(): boolean {
    return this.#lastCheckSucceeded;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    for (const off of this.#unsubscribe.splice(0)) off();
    const generation = ++this.#generation;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#options.enabled === false) {
      this.#started = false;
      return;
    }
    this.#unsubscribe.push(
      ctx.bus.on("release.committed", (appVersion) => {
        if (this.#staged?.version === appVersion) {
          this.#staged = undefined;
        }
        if (
          this.#state.kind === "staged" &&
          this.#state.version === appVersion
        ) {
          this.#setState({ kind: "idle" });
        }
      }),
      ctx.bus.on("release.rolled_back", (fromVersion) => {
        if (this.#staged?.version === fromVersion) {
          this.#staged = undefined;
        }
        if (
          this.#state.kind === "staged" &&
          this.#state.version === fromVersion
        ) {
          this.#setState({ kind: "idle" });
        }
      }),
    );
    this.#started = true;
    this.#schedule(generation, this.#options.checkDelayMs ?? CHECK_DELAY_MS);
  }

  async stop(): Promise<void> {
    this.#started = false;
    this.#generation += 1;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const off of this.#unsubscribe.splice(0)) off();
  }

  #schedule(generation: number, delay: number): void {
    if (this.#generation !== generation || !this.#started) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      if (this.#generation !== generation || !this.#started) return;
      this.#timer = undefined;
      void this.check();
    }, delay);
    this.#timer.unref?.();
  }

  check(): Promise<void> {
    if (this.#options.enabled === false) return Promise.resolve();
    if (this.#checking) return this.#checking;
    const generation = this.#generation;
    this.#checking = this.#check().finally(() => {
      this.#checking = undefined;
      if (this.#started && this.#generation === generation) {
        this.#schedule(
          generation,
          this.#state.kind === "failed"
            ? this.#nextRetryDelayMs()
            : (this.#options.checkIntervalMs ?? CHECK_INTERVAL_MS),
        );
      }
    });
    return this.#checking;
  }

  async #check(): Promise<void> {
    const ctx = this.#ctx!;
    if (this.#options.isLocalMode && !(await this.#options.isLocalMode())) {
      this.#staged = undefined;
      this.#setState({ kind: "idle" });
      return;
    }
    const store = ctx.get<BundleStoreModule>("BundleStore");
    // Ensure a brand-new local instance (created by Setup Wizard after
    // BundleStore.start) or a Shell upgrade seeds state/current.json before
    // comparing against the remote manifest.
    await store.ensureSeeded().catch((error) => {
      ctx.log.warn("bundle_updater.seed_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const cfg = ctx.config.get();
    const feed =
      process.env.LINGER_UPDATE_FEED_URL?.trim() ||
      cfg.updateFeedUrl ||
      DEFAULT_FEED_URL;
    const channel: UpdateChannel =
      parseEnvChannel(process.env.LINGER_UPDATE_CHANNEL) ??
      cfg.updateChannel ??
      "stable";
    const installId = cfg.installId ?? "default-install";
    const publicKey = this.#options.publicKey ?? UPDATE_PUBLIC_KEY;

    const previousState = this.#state;
    this.#setState({ kind: "checking" });
    try {
      const urls = channelFeedUrls(feed, channel);
      const manifest = await this.#fetchSignedManifest(
        urls.manifest,
        urls.signature,
        publicKey,
      );
      if (!manifest) {
        this.#consecutiveFailures = 0;
        this.#lastCheckSucceeded = true;
        this.#staged = undefined;
        this.#setState({ kind: "idle" });
        return;
      }

      const resolved = await this.#resolveCompatibleManifest(
        manifest,
        publicKey,
      );
      if (!resolved) {
        this.#consecutiveFailures = 0;
        this.#lastCheckSucceeded = true;
        this.#staged = undefined;
        return;
      }

      const currentPtr = await store.readCurrent();
      const currentDesc = await store.currentRelease();
      if (
        currentPtr &&
        compareVersions(resolved.appVersion, currentPtr.appVersion) <= 0
      ) {
        this.#consecutiveFailures = 0;
        this.#lastCheckSucceeded = true;
        this.#staged = undefined;
        this.#setState({ kind: "idle" });
        return;
      }

      if (await store.isDenylisted(resolved.appVersion)) {
        ctx.log.warn("bundle_updater.version_denylisted", {
          appVersion: resolved.appVersion,
        });
        this.#consecutiveFailures = 0;
        this.#lastCheckSucceeded = true;
        this.#staged = undefined;
        this.#setState({ kind: "idle" });
        return;
      }

      if (
        !isInRolloutBucket(
          installId,
          resolved.rollout.percent,
          resolved.rollout.urgent,
        )
      ) {
        ctx.log.info("bundle_updater.rollout_deferred", {
          appVersion: resolved.appVersion,
          percent: resolved.rollout.percent,
        });
        this.#consecutiveFailures = 0;
        this.#lastCheckSucceeded = true;
        this.#staged = undefined;
        this.#setState({ kind: "idle" });
        return;
      }

      if (
        previousState.kind === "staged" &&
        previousState.version === resolved.appVersion &&
        this.#staged?.version === resolved.appVersion &&
        (await store.readRelease(resolved.appVersion)) !== undefined
      ) {
        this.#consecutiveFailures = 0;
        this.#lastCheckSucceeded = true;
        this.#setState(previousState);
        return;
      }

      const changedModules = await this.#downloadAndStageDiff(
        resolved,
        feed,
        store,
        currentDesc,
      );
      const stagedState: Extract<BundleUpdaterState, { kind: "staged" }> = {
        kind: "staged",
        version: resolved.appVersion,
        changedModules,
      };
      this.#consecutiveFailures = 0;
      this.#lastCheckSucceeded = true;
      this.#staged = stagedState;
      this.#setState(stagedState);
      ctx.log.info("bundle_updater.staged", {
        appVersion: resolved.appVersion,
        changedModules,
      });
      ctx.bus.emit("bundle.staged", resolved.appVersion, changedModules);
    } catch (error) {
      this.#consecutiveFailures += 1;
      this.#lastCheckSucceeded = false;
      const message =
        error instanceof ManifestError || error instanceof Error
          ? error.message
          : String(error);
      ctx.log.warn("bundle_updater.check_failed", { error: message });
      this.#setState({ kind: "failed", error: message });
    }
  }

  async #fetchSignedManifest(
    manifestUrl: URL,
    signatureUrl: URL,
    publicKey: string,
  ): Promise<AppManifestV3 | undefined> {
    const [bytes, sig] = await Promise.all([
      this.#getBytes(manifestUrl),
      this.#getBytes(signatureUrl),
    ]);
    if (!bytes || !sig) return undefined;
    return verifyAppManifestV3(bytes, sig.toString("utf8"), publicKey);
  }

  async #resolveCompatibleManifest(
    manifest: AppManifestV3,
    publicKey: string,
  ): Promise<AppManifestV3 | undefined> {
    const compat = evaluateShellCompatibility(
      manifest,
      this.#options.shellVersion,
    );
    if (compat.status === "compatible") return manifest;

    this.#ctx?.bus.emit("shell.update_required", compat.minShellVersion);
    if (compat.status === "shell-upgrade-required") {
      this.#setState({
        kind: "shell-required",
        version: manifest.appVersion,
        minShellVersion: compat.minShellVersion,
      });
      return undefined;
    }

    // 1-hop bounded fallback to the highest compatible release for this shell.
    const fallback = await this.#fetchSignedManifest(
      new URL(compat.fallback.manifestUrl),
      new URL(compat.fallback.signatureUrl),
      publicKey,
    );
    if (!fallback) {
      this.#setState({
        kind: "shell-required",
        version: manifest.appVersion,
        minShellVersion: compat.minShellVersion,
      });
      return undefined;
    }
    const recheck = evaluateShellCompatibility(
      fallback,
      this.#options.shellVersion,
    );
    if (recheck.status !== "compatible") {
      this.#setState({
        kind: "shell-required",
        version: manifest.appVersion,
        minShellVersion: compat.minShellVersion,
      });
      return undefined;
    }
    return fallback;
  }

  async #downloadAndStageDiff(
    manifest: AppManifestV3,
    feed: string,
    store: BundleStoreModule,
    currentDesc: LocalReleaseDescriptor | undefined,
  ): Promise<BundleId[]> {
    const target = this.#options.target;
    const tasks: Array<{
      readonly id: BundleId;
      readonly artifact: ArtifactRef;
      readonly nodeDepsShortId?: string;
    }> = [];

    const nodeDepsHash = manifest.compat.minNativeDepsHash;
    const nodeDepsShortId = shortNodeDepsId(nodeDepsHash);
    const nodeDepsArtifact =
      manifest.bundles["node-native-deps"].targets[target];
    if (!nodeDepsArtifact) {
      throw new Error(`Manifest missing node-native-deps for ${target}`);
    }
    const nodeDepsMatchesCurrent =
      currentDesc !== undefined &&
      path.basename(currentDesc.infra.nodeDeps) === nodeDepsShortId;

    const modules = {} as Record<
      BundleModuleId,
      LocalReleaseDescriptor["modules"][BundleModuleId]
    >;

    for (const modId of MODULE_IDS) {
      const entry = manifest.bundles[modId];
      const artifact =
        entry.arch === "noarch" ? entry.artifact : entry.targets[target];
      if (!artifact) {
        throw new Error(`Manifest missing module '${modId}' for ${target}`);
      }
      const currentMod = currentDesc?.modules[modId];
      const canInheritShell =
        currentMod?.source === "shell" &&
        currentMod.inputHash !== undefined &&
        currentMod.inputHash === entry.inputHash &&
        (modId !== "backend" || nodeDepsMatchesCurrent);
      if (canInheritShell) {
        modules[modId] = { ...currentMod };
        continue;
      }
      modules[modId] = {
        artifactId: artifact.artifactId,
        originAppVersion: entry.originAppVersion,
        sha256: artifact.sha256,
        path: store.moduleRelativePath(modId, artifact.artifactId),
        inputHash: entry.inputHash,
        source: "store",
      };
      const alreadyCached = await store.hasVerifiedModule(
        modId,
        artifact.artifactId,
        artifact.sha256,
      );
      if (!alreadyCached) {
        tasks.push({ id: modId, artifact });
      }
    }

    // When backend remains on the Shell baseline with matching native deps
    // (e.g. first pure-Web update), skip downloading node-native-deps too (0B).
    const backendUsesStore = modules.backend.source !== "shell";
    if (
      (backendUsesStore || !nodeDepsMatchesCurrent) &&
      !(await store.hasVerifiedNodeDeps(
        nodeDepsShortId,
        nodeDepsArtifact.sha256,
      ))
    ) {
      tasks.unshift({
        id: "node-native-deps",
        artifact: nodeDepsArtifact,
        nodeDepsShortId,
      });
    }

    const changedModules = tasks.map((t) => t.id);
    const bytesTotal = tasks.reduce((sum, t) => sum + t.artifact.size, 0);
    let bytesDownloaded = 0;

    if (tasks.length > 0) {
      this.#setState({
        kind: "downloading",
        version: manifest.appVersion,
        changedModules,
        bytesDownloaded: 0,
        bytesTotal,
      });
    }

    for (const task of tasks) {
      const destFile = path.join(
        store.downloadsDir,
        `${task.artifact.artifactId}.tar.zst`,
      );
      await this.#downloadWithMirrors(
        feed,
        task.artifact,
        destFile,
        (chunkBytes) => {
          bytesDownloaded += chunkBytes;
          this.#setState({
            kind: "downloading",
            version: manifest.appVersion,
            changedModules,
            bytesDownloaded,
            bytesTotal,
          });
        },
      );
      try {
        if (task.id === "node-native-deps" && task.nodeDepsShortId) {
          await store.stageNodeDepsArchive(
            task.nodeDepsShortId,
            destFile,
            task.artifact.sha256,
          );
        } else if (task.id !== "node-native-deps") {
          await store.stageModuleArchive(
            task.id,
            task.artifact.artifactId,
            destFile,
            task.artifact.sha256,
          );
        }
      } finally {
        await rm(destFile, { force: true }).catch(() => undefined);
      }
    }

    const baseInfra: ReleaseInfraPaths = currentDesc?.infra ??
      this.#options.defaultInfra ?? {
        node: "infra/node/current",
        postgres: "infra/postgres/current",
        voiceTools: "infra/voice-tools/current",
        nodeDeps: store.nodeDepsRelativePath(nodeDepsShortId),
      };

    const descriptor: LocalReleaseDescriptor = {
      schema: 1,
      appVersion: manifest.appVersion,
      channel: manifest.channel,
      installedAt: new Date().toISOString(),
      source: "incremental-update",
      compat: manifest.compat,
      infra: {
        ...baseInfra,
        nodeDeps: store.nodeDepsRelativePath(nodeDepsShortId),
      },
      modules,
    };
    await store.writeReleaseDescriptor(descriptor);
    return changedModules;
  }

  async #getBytes(url: URL): Promise<Buffer | undefined> {
    if (!isAllowedFeedUrl(url)) {
      throw new ManifestError("Update feed URL must use https");
    }
    const response = await (this.#options.fetch ?? fetch)(url);
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`${url.pathname} returned HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async #downloadWithMirrors(
    feed: string,
    artifact: ArtifactRef,
    destPath: string,
    onProgress: (deltaBytes: number) => void,
  ): Promise<void> {
    const candidates = [artifact.url, ...(artifact.mirrors ?? [])];
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        await this.#downloadSingle(
          resolveArtifactUrl(feed, candidate),
          artifact,
          destPath,
          onProgress,
        );
        return;
      } catch (error) {
        lastError = error;
        await rm(destPath, { force: true }).catch(() => undefined);
      }
    }
    throw lastError ?? new Error(`Failed to download ${artifact.artifactId}`);
  }

  async #downloadSingle(
    url: URL,
    artifact: ArtifactRef,
    destPath: string,
    onProgress: (deltaBytes: number) => void,
  ): Promise<void> {
    if (!isAllowedFeedUrl(url)) {
      throw new Error(`Refusing non-HTTPS artifact URL: ${url.toString()}`);
    }
    await mkdir(path.dirname(destPath), { recursive: true, mode: 0o700 });
    const response = await (this.#options.fetch ?? fetch)(url);
    if (!response.ok || !response.body) {
      throw new Error(
        `HTTP ${response.status} downloading ${artifact.artifactId}`,
      );
    }
    const hash = createHash("sha256");
    let received = 0;
    async function* meter(chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        received += chunk.length;
        if (received > artifact.size) {
          throw new Error(
            `Artifact ${artifact.artifactId} exceeded announced size`,
          );
        }
        hash.update(chunk);
        onProgress(chunk.length);
        yield chunk;
      }
    }
    await pipeline(
      Readable.fromWeb(response.body as never),
      meter,
      createWriteStream(destPath, { mode: 0o600 }),
    );
    if (received !== artifact.size || hash.digest("hex") !== artifact.sha256) {
      throw new Error(`Checksum mismatch for ${artifact.artifactId}`);
    }
  }

  #nextRetryDelayMs(): number {
    const base = this.#options.retryDelayMs ?? RETRY_DELAY_MS;
    const cap = Math.max(
      base,
      this.#options.checkIntervalMs ?? CHECK_INTERVAL_MS,
    );
    const exp = Math.min(Math.max(0, this.#consecutiveFailures - 1), 10);
    return Math.min(base * 2 ** exp, cap);
  }

  #setState(state: BundleUpdaterState): void {
    this.#state = state;
    this.#ctx?.bus.emit("bundle.update_changed", state.kind);
  }
}
