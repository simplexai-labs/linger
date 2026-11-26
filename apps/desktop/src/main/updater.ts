import { execFile, spawn as spawnProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import type { ComputerDaemonModule } from "./computer-daemon.js";
import type { Module, ModuleContext } from "./modules.js";
import {
  DEFAULT_FEED_URL,
  ManifestError,
  UPDATE_PUBLIC_KEY,
  compareVersions,
  feedUrls,
  packageFor,
  packageUrl,
  releasePageUrl,
  verifyManifest,
  type UpdatePackage,
} from "./update-manifest.js";

export type UpdateState =
  | { readonly kind: "idle" }
  | { readonly kind: "checking" }
  | { readonly kind: "downloading"; readonly version: string }
  | { readonly kind: "ready"; readonly version: string }
  // Restart was chosen while tasks ran; it happens once they finish.
  | { readonly kind: "waiting"; readonly version: string }
  | { readonly kind: "installing"; readonly version: string }
  // A newer release this installation cannot apply itself; `url` is its
  // release page.
  | {
      readonly kind: "available";
      readonly version: string;
      readonly url: string;
    }
  | { readonly kind: "failed"; readonly error: string };

export type AnnouncedUpdate = Extract<
  UpdateState,
  { kind: "ready" | "available" }
>;

// How this installation takes a newer release.
export type UpdateInstall =
  // macOS: the installed Linger.app, swapped for the release's app archive.
  | { readonly kind: "app-bundle"; readonly appBundle: string }
  // Windows, installed by the setup program: the release's setup program
  // runs silently over the installation and starts Linger again.
  | { readonly kind: "windows-setup" }
  // Linux and the portable Windows folder: the person downloads the release.
  | { readonly kind: "download" };

export interface UpdaterOptions {
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  // Without one (development) the updater asks no feed.
  readonly install: UpdateInstall | undefined;
  // Downloads live here until they are installed.
  readonly downloadDirectory: string;
  // Stops modules, including the daemon, and relaunches the app from
  // the app bundle, which by then holds the new version and its daemon.
  readonly restart: () => Promise<void>;
  // Stops modules and quits without relaunching: the setup program, already
  // running, replaces the files and starts the new version.
  readonly quit: () => Promise<void>;
  readonly openExternal: (url: string) => Promise<void>;
  // Tells the person once per version that an update is ready or available.
  readonly announce?: (state: AnnouncedUpdate) => void;
  // Pre-stages update runtime assets (such as localmodelsTool) from an
  // unpacked bundle before announcing the update ready; errors never block ready.
  readonly prepareUpdate?: (
    stagedPath: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly fetch?: typeof fetch;
  readonly extract?: (archive: string, directory: string) => Promise<void>;
  readonly spawn?: SpawnSetup;
  readonly publicKey?: string;
  readonly checkDelayMs?: number;
  readonly checkIntervalMs?: number;
  readonly retryDelayMs?: number;
}

export interface SetupProcess {
  once(event: "spawn", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
}
export type SpawnSetup = (
  file: string,
  args: readonly string[],
  options: { detached: true; stdio: "ignore" },
) => SetupProcess;

// installer.nsi: /update shows only its progress page and the questions about
// a locked file, then closes; /relaunch starts Linger after.
export const SETUP_ARGS = ["/update", "/relaunch"] as const;

const CHECK_DELAY_MS = 60_000;
const CHECK_INTERVAL_MS = 60 * 60_000;
// A dropped connection should not cost a whole check interval.
const RETRY_DELAY_MS = 5 * 60_000;
const STAGED_PREFIX = ".Linger-update-";
const OLD_PREFIX = ".Linger-old-";

const run = promisify(execFile);

// /usr/bin/tar keeps the symlinks and code signatures inside the bundle.
const untar = async (archive: string, directory: string): Promise<void> => {
  await run("/usr/bin/tar", ["-xzf", archive, "-C", directory]);
};

export class UpdateError extends Error {}

// Self-update without Squirrel: a signed manifest in the newest GitHub
// Release (or a feed with the same layout), a sha256-checked package from
// that same release, and an install that waits for running tasks. Sign-in and
// the computer identity live outside the installed app, so they carry over.
export class UpdaterModule implements Module {
  readonly name = "Updater";
  readonly dependsOn = ["Config", "ComputerDaemon"];
  readonly #options: UpdaterOptions;
  #ctx: ModuleContext | undefined;
  #state: UpdateState = { kind: "idle" };
  // The unpacked app bundle (macOS) or the downloaded setup program
  // (Windows), with the package it came from.
  #staged: { path: string; pkg: UpdatePackage } | undefined;
  #timer: NodeJS.Timeout | undefined;
  #checking: Promise<void> | undefined;
  #prepareAbort: AbortController | undefined;
  #generation = 0;
  #consecutiveCheckFailures = 0;
  #lastCheckFailure: string | undefined;
  #suppressedCheckFailures = 0;
  readonly #announced = new Set<string>();
  readonly #unsubscribe: (() => void)[] = [];

  constructor(options: UpdaterOptions) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    const generation = ++this.#generation;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#options.install) return;
    void this.#cleanup();
    const schedule = (delay: number): void => {
      if (this.#generation !== generation) return;
      this.#timer = setTimeout(() => {
        if (this.#generation !== generation) return;
        void this.check().finally(() => {
          if (this.#generation !== generation) return;
          schedule(
            this.#state.kind === "failed"
              ? this.#nextRetryDelayMs()
              : (this.#options.checkIntervalMs ?? CHECK_INTERVAL_MS),
          );
        });
      }, delay);
      this.#timer.unref?.();
    };
    schedule(this.#options.checkDelayMs ?? CHECK_DELAY_MS);
  }

  async stop(): Promise<void> {
    this.#generation += 1;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#prepareAbort?.abort();
    this.#prepareAbort = undefined;
    for (const off of this.#unsubscribe.splice(0)) off();
  }

  state(): UpdateState {
    return this.#state;
  }

  // Fetches and verifies the manifest, then downloads a newer package. Only
  // one check runs at a time; a downloaded update is not checked again.
  check(): Promise<void> {
    if (!this.#options.install) return Promise.resolve();
    const state = this.#state;
    const settled =
      state.kind === "idle" ||
      state.kind === "failed" ||
      state.kind === "available";
    if (!settled) return this.#checking ?? Promise.resolve();
    this.#checking = this.#check().finally(() => (this.#checking = undefined));
    return this.#checking;
  }

  // "Restart to Update" or "Download". With tasks running, the restart
  // waits for them.
  async install(): Promise<void> {
    const state = this.#state;
    if (state.kind === "available") {
      await this.#options.openExternal(state.url);
      return;
    }
    if (state.kind !== "ready" && state.kind !== "waiting") return;
    const runtime = this.#ctx!.get<ComputerDaemonModule>("ComputerDaemon");
    if (runtime.running() > 0) {
      if (state.kind === "waiting") return;
      this.#setState({ kind: "waiting", version: state.version });
      const off = this.#ctx!.bus.on("runtime.activity", (running) => {
        if (running !== 0) return;
        off();
        void this.install();
      });
      this.#unsubscribe.push(off);
      return;
    }
    this.#setState({ kind: "installing", version: state.version });
    this.#ctx!.log.info("update.installing", { version: state.version });
    try {
      if (this.#options.install?.kind === "windows-setup") {
        await this.#runSetup();
        await this.#options.quit();
      } else {
        await this.#swap();
        await this.#options.restart();
      }
    } catch (error) {
      this.#fail("update.install_failed", error);
    }
  }

  async #check(): Promise<void> {
    const generation = this.#generation;
    const ctx = this.#ctx!;
    const install = this.#options.install!;
    const feed = ctx.config.get().updateFeedUrl ?? DEFAULT_FEED_URL;
    this.#setState({ kind: "checking" });
    try {
      if (new URL(feed).protocol !== "https:")
        throw new UpdateError("The update feed must use https");
      const urls = feedUrls(feed);
      const [bytes, signature] = await Promise.all([
        this.#get(urls.manifest),
        this.#get(urls.signature),
      ]);
      // The newest release was published without a manifest: nothing to
      // offer until one is.
      if (!bytes || !signature) {
        this.#clearCheckFailures();
        ctx.log.info("update.no_manifest", { feed });
        this.#setState({ kind: "idle" });
        return;
      }
      const manifest = verifyManifest(
        bytes,
        signature.toString("utf8"),
        this.#options.publicKey ?? UPDATE_PUBLIC_KEY,
      );
      const pkg = packageFor(
        manifest,
        this.#options.platform,
        this.#options.arch,
      );
      if (
        compareVersions(manifest.version, this.#options.version) <= 0 ||
        !pkg
      ) {
        this.#clearCheckFailures();
        this.#setState({ kind: "idle" });
        return;
      }
      const version = manifest.version;
      if (install.kind === "download") {
        this.#clearCheckFailures();
        ctx.log.info("update.available", { version });
        this.#announce({
          kind: "available",
          version,
          url: releasePageUrl(feed, version),
        });
        return;
      }
      this.#setState({ kind: "downloading", version });
      const file = path.join(this.#options.downloadDirectory, pkg.file);
      await this.#download(packageUrl(feed, version, pkg.file), file, pkg);
      this.#staged =
        install.kind === "app-bundle"
          ? { path: await this.#extract(file, version), pkg }
          : { path: file, pkg };
      if (install.kind === "app-bundle") await rm(file, { force: true });
      if (this.#generation !== generation) return;
      if (
        install.kind === "app-bundle" &&
        this.#options.prepareUpdate &&
        this.#staged
      ) {
        this.#prepareAbort?.abort();
        const prepareAbort = new AbortController();
        this.#prepareAbort = prepareAbort;
        try {
          await this.#options.prepareUpdate(
            this.#staged.path,
            prepareAbort.signal,
          );
        } catch (error) {
          if (!prepareAbort.signal.aborted)
            ctx.log.warn("update.prepare_failed", {
              version,
              error: String(error),
            });
        } finally {
          if (this.#prepareAbort === prepareAbort)
            this.#prepareAbort = undefined;
        }
        if (this.#generation !== generation || prepareAbort.signal.aborted)
          return;
      }
      this.#clearCheckFailures();
      ctx.log.info("update.ready", { version });
      this.#announce({ kind: "ready", version });
    } catch (error) {
      this.#failCheck(error);
    }
  }

  // Follows redirects: GitHub sends release files from another host. The
  // signature and the checksums, not the host, decide what is trusted.
  // Undefined when the file does not exist.
  async #get(url: URL): Promise<Buffer | undefined> {
    const response = await (this.#options.fetch ?? fetch)(url);
    if (response.status === 404) return undefined;
    if (!response.ok)
      throw new UpdateError(`${url.pathname} returned ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  // Streams to disk while hashing; a mismatch deletes the file.
  async #download(url: URL, file: string, pkg: UpdatePackage): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const response = await (this.#options.fetch ?? fetch)(url);
    if (!response.ok || !response.body)
      throw new UpdateError(`${url.pathname} returned ${response.status}`);
    try {
      await this.#verify(
        Readable.fromWeb(response.body as never),
        pkg,
        createWriteStream(file, { mode: 0o600 }),
      );
    } catch (error) {
      await rm(file, { force: true });
      throw error;
    }
  }

  async #verify(
    source: Readable,
    pkg: UpdatePackage,
    sink?: NodeJS.WritableStream,
  ): Promise<void> {
    const hash = createHash("sha256");
    let received = 0;
    async function* meter(chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        received += chunk.length;
        if (received > pkg.size)
          throw new UpdateError("Update package is larger than announced");
        hash.update(chunk);
        yield chunk;
      }
    }
    if (sink) await pipeline(source, meter, sink);
    else for await (const _chunk of meter(source));
    if (received !== pkg.size || hash.digest("hex") !== pkg.sha256)
      throw new UpdateError("Update package does not match its checksum");
  }

  // Checks the setup program again, since it waited on disk, then starts it
  // detached so it outlives this app, which it replaces.
  async #runSetup(): Promise<void> {
    const staged = this.#staged;
    if (!staged) throw new UpdateError("No update is ready");
    await this.#verify(createReadStream(staged.path), staged.pkg);
    const child = (this.#options.spawn ?? (spawnProcess as SpawnSetup))(
      staged.path,
      SETUP_ARGS,
      { detached: true, stdio: "ignore" },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    this.#staged = undefined;
  }

  // Unpacks next to the installed bundle so the swap is two renames on one
  // volume.
  async #extract(archive: string, version: string): Promise<string> {
    const appBundle = this.#appBundle();
    const parent = path.dirname(appBundle);
    const staged = path.join(parent, `${STAGED_PREFIX}${version}`);
    await rm(staged, { recursive: true, force: true });
    await mkdir(staged, { recursive: true });
    try {
      await (this.#options.extract ?? untar)(archive, staged);
      const app = path.join(staged, path.basename(appBundle));
      if (!(await stat(app)).isDirectory())
        throw new UpdateError("Update package has no app");
      return app;
    } catch (error) {
      await rm(staged, { recursive: true, force: true });
      throw error instanceof UpdateError
        ? error
        : new UpdateError(`Couldn't unpack the update: ${String(error)}`);
    }
  }

  // The running process keeps its open files, so the bundle can be renamed
  // under it. A failed second rename puts the old bundle back.
  async #swap(): Promise<void> {
    const bundle = this.#appBundle();
    const staged = this.#staged?.path;
    if (!staged) throw new UpdateError("No update is ready");
    const old = path.join(path.dirname(bundle), `${OLD_PREFIX}${Date.now()}`);
    await rename(bundle, old);
    try {
      await rename(staged, bundle);
    } catch (error) {
      await rename(old, bundle);
      throw error;
    }
    this.#staged = undefined;
    await rm(path.dirname(staged), { recursive: true, force: true });
  }

  #appBundle(): string {
    const install = this.#options.install;
    if (install?.kind !== "app-bundle")
      throw new UpdateError("This installation has no app bundle");
    return install.appBundle;
  }

  // Leftovers from an earlier update: downloads, the replaced bundle and
  // unused stages.
  async #cleanup(): Promise<void> {
    const leftovers: string[] = [];
    try {
      for (const name of await readdir(this.#options.downloadDirectory))
        leftovers.push(path.join(this.#options.downloadDirectory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.#ctx?.log.warn("update.cleanup_failed", { error: String(error) });
    }
    try {
      const install = this.#options.install;
      if (install?.kind === "app-bundle") {
        const parent = path.dirname(install.appBundle);
        for (const name of await readdir(parent)) {
          if (name.startsWith(OLD_PREFIX) || name.startsWith(STAGED_PREFIX))
            leftovers.push(path.join(parent, name));
        }
      }
      for (const leftover of leftovers)
        await rm(leftover, { recursive: true, force: true });
    } catch (error) {
      this.#ctx?.log.warn("update.cleanup_failed", { error: String(error) });
    }
  }

  // Sets the state and tells the person once per version.
  #announce(state: AnnouncedUpdate): void {
    this.#setState(state);
    if (this.#announced.has(state.version)) return;
    this.#announced.add(state.version);
    this.#options.announce?.(state);
  }

  #nextRetryDelayMs(): number {
    const base = this.#options.retryDelayMs ?? RETRY_DELAY_MS;
    const cap = Math.max(
      0,
      base,
      this.#options.checkIntervalMs ?? CHECK_INTERVAL_MS,
    );
    if (base <= 0) return 0;
    const exponent = Math.min(
      Math.max(0, this.#consecutiveCheckFailures - 1),
      30,
    );
    return Math.min(base * 2 ** exponent, cap);
  }

  #clearCheckFailures(): void {
    this.#consecutiveCheckFailures = 0;
    this.#lastCheckFailure = undefined;
    this.#suppressedCheckFailures = 0;
  }

  // Deduplicates repeated identical check errors so an offline or blocked
  // environment does not flood desktop logs across backoff retries.
  #failCheck(error: unknown): void {
    const message =
      error instanceof UpdateError || error instanceof ManifestError
        ? error.message
        : String(error);
    this.#consecutiveCheckFailures += 1;
    if (message !== this.#lastCheckFailure) {
      this.#ctx!.log.warn("update.check_failed", {
        error: message,
        retry_ms: this.#nextRetryDelayMs(),
        ...(this.#suppressedCheckFailures > 0
          ? { suppressed_failures: this.#suppressedCheckFailures }
          : {}),
      });
      this.#lastCheckFailure = message;
      this.#suppressedCheckFailures = 0;
    } else {
      this.#suppressedCheckFailures += 1;
    }
    this.#setState({ kind: "failed", error: message });
  }

  #fail(event: string, error: unknown): void {
    const message =
      error instanceof UpdateError || error instanceof ManifestError
        ? error.message
        : String(error);
    this.#ctx!.log.warn(event, { error: message });
    this.#setState({ kind: "failed", error: message });
  }

  #setState(state: UpdateState): void {
    this.#state = state;
    this.#ctx?.bus.emit("update.changed", state.kind);
  }
}

// The bundle that contains this executable on macOS, e.g.
// /Applications/Linger.app for /Applications/Linger.app/Contents/MacOS/Linger.
export function appBundleOf(execPath: string): string | undefined {
  const bundle = path.resolve(execPath, "../../..");
  return bundle.endsWith(".app") ? bundle : undefined;
}

// How a packaged app at execPath takes updates. A Windows installation from
// the setup program has its uninstaller beside Linger.exe (installer.nsi);
// the portable folder has none.
export function updateInstallFor(
  platform: string,
  execPath: string,
  exists: (file: string) => boolean,
): UpdateInstall {
  if (platform === "darwin") {
    const appBundle = appBundleOf(execPath);
    if (appBundle) return { kind: "app-bundle", appBundle };
  }
  if (
    platform === "win32" &&
    exists(
      path.win32.join(path.win32.dirname(execPath), "Uninstall Linger.exe"),
    )
  )
    return { kind: "windows-setup" };
  return { kind: "download" };
}
