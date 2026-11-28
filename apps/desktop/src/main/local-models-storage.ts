import fs from "node:fs/promises";
import path from "node:path";

import type { LocalModelsStorageActionResult } from "../shared/api.js";

const MAX_PATH_LENGTH = 4096;
const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_ABSOLUTE = /^\\\\[^\\/]+[\\/][^\\/]+/;

export interface LocalModelsStorageFs {
  realpath(filePath: string): Promise<string>;
  stat(
    filePath: string,
  ): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
}

export interface LocalModelsStorageHost {
  openFolder(): Promise<LocalModelsStorageActionResult>;
  revealPath(targetPath: string): Promise<LocalModelsStorageActionResult>;
}

export interface LocalModelsStorageOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly resolveBaseDir: () => string | undefined;
  readonly fs?: LocalModelsStorageFs;
  readonly openPath: (directoryPath: string) => Promise<string>;
  readonly openWithXdg?: (directoryPath: string) => Promise<void>;
  readonly showItemInFolder: (filePath: string) => void;
}

/**
 * Strips Windows extended-length prefixes (`\\?\` and `\\?\UNC\`) that
 * `realpath` can return, because Explorer APIs reject extended prefixes.
 */
export function stripWindowsExtendedPrefix(rawPath: string): string {
  if (/^\\\\\?\\unc\\/i.test(rawPath)) {
    return `\\\\${rawPath.slice(8)}`;
  }
  if (rawPath.startsWith("\\\\?\\")) {
    return rawPath.slice(4);
  }
  return rawPath;
}

/**
 * Normalizes a path for the given platform and strips Windows `\\?\` prefixes
 * so shell open/reveal APIs receive clean native separators.
 */
export function normalizePlatformPath(
  rawPath: string,
  platform: NodeJS.Platform,
): string {
  if (platform === "win32") {
    return path.win32.normalize(stripWindowsExtendedPrefix(rawPath));
  }
  return path.posix.normalize(rawPath);
}

/**
 * Reports whether `candidate` is a syntactically valid absolute path on
 * `platform`. On Windows, requires a drive root (`C:\...`) or UNC share
 * (`\\host\share\...`), rejecting drive-relative (`C:foo`) and root-relative
 * (`\foo`) paths.
 */
export function isAbsolutePlatformPath(
  candidate: string,
  platform: NodeJS.Platform,
): boolean {
  if (
    candidate.length === 0 ||
    candidate.length > MAX_PATH_LENGTH ||
    candidate.includes("\0")
  ) {
    return false;
  }
  if (platform === "win32") {
    const stripped = stripWindowsExtendedPrefix(candidate);
    return (
      WINDOWS_DRIVE_ABSOLUTE.test(stripped) ||
      WINDOWS_UNC_ABSOLUTE.test(stripped)
    );
  }
  return path.posix.isAbsolute(candidate);
}

/**
 * The path of canonical `targetReal` relative to canonical `rootReal` ("" for
 * the root itself), or undefined when it lies outside. Blocks `..` traversal,
 * prefix-sibling escapes (`models-evil`), and Windows cross-drive escapes
 * while treating Windows drive letters and names case-insensitively.
 */
function relativeToRoot(
  rootReal: string,
  targetReal: string,
  platform: NodeJS.Platform,
): string | undefined {
  const normalizedRoot = normalizePlatformPath(rootReal, platform);
  const normalizedTarget = normalizePlatformPath(targetReal, platform);
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  const rel =
    platform === "win32"
      ? path.win32.relative(
          normalizedRoot.toLowerCase(),
          normalizedTarget.toLowerCase(),
        )
      : path.posix.relative(normalizedRoot, normalizedTarget);
  const outside =
    rel === ".." ||
    rel.startsWith(`..${platformPath.sep}`) ||
    platformPath.isAbsolute(rel);
  return outside ? undefined : rel;
}

/** Reports whether canonical `targetReal` lies at or beneath canonical `rootReal`. */
export function isPathWithinRoot(
  rootReal: string,
  targetReal: string,
  platform: NodeJS.Platform,
): boolean {
  return relativeToRoot(rootReal, targetReal, platform) !== undefined;
}

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Scoped main-process opener for local model weight storage. All actions are
 * pinned to `<baseDir>/models` (excluding `<baseDir>/engines` and
 * `<baseDir>/deployments`). `openPath` only ever receives the root itself;
 * every file or directory below it is revealed via `showItemInFolder`, so
 * nothing the renderer names is executed or launched.
 */
export class LocalModelsStorage implements LocalModelsStorageHost {
  readonly #platform: NodeJS.Platform;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #resolveBaseDir: () => string | undefined;
  readonly #fs: LocalModelsStorageFs;
  readonly #openPath: (directoryPath: string) => Promise<string>;
  readonly #openWithXdg: ((directoryPath: string) => Promise<void>) | undefined;
  readonly #showItemInFolder: (filePath: string) => void;

  constructor(options: LocalModelsStorageOptions) {
    this.#platform = options.platform ?? process.platform;
    this.#env = options.env ?? process.env;
    this.#resolveBaseDir = options.resolveBaseDir;
    this.#fs = options.fs ?? fs;
    this.#openPath = options.openPath;
    this.#openWithXdg = options.openWithXdg;
    this.#showItemInFolder = options.showItemInFolder;
  }

  async openFolder(): Promise<LocalModelsStorageActionResult> {
    const resolved = await this.#resolveCanonicalModelsRoot();
    if (!resolved.ok) return resolved.result;
    return this.#openVerifiedDirectory(resolved.cleanRoot);
  }

  async revealPath(
    targetPath: string,
  ): Promise<LocalModelsStorageActionResult> {
    if (
      typeof targetPath !== "string" ||
      !isAbsolutePlatformPath(targetPath, this.#platform)
    ) {
      return { ok: false, code: "INVALID_PATH" };
    }
    const resolved = await this.#resolveCanonicalModelsRoot();
    if (!resolved.ok) return resolved.result;

    let targetReal: string;
    try {
      targetReal = await this.#fs.realpath(targetPath);
    } catch (error) {
      if (isMissingPathError(error)) {
        return { ok: false, code: "NOT_FOUND" };
      }
      return { ok: false, code: "OPEN_FAILED", message: errorMessage(error) };
    }

    const rel = relativeToRoot(resolved.rootReal, targetReal, this.#platform);
    if (rel === undefined) {
      return { ok: false, code: "OUTSIDE_ROOT" };
    }

    let targetStat: { isDirectory(): boolean; isFile(): boolean };
    try {
      targetStat = await this.#fs.stat(targetReal);
    } catch (error) {
      if (isMissingPathError(error)) {
        return { ok: false, code: "NOT_FOUND" };
      }
      return { ok: false, code: "OPEN_FAILED", message: errorMessage(error) };
    }

    const cleanTarget = normalizePlatformPath(targetReal, this.#platform);
    // Only the root itself is opened; anything below it, including a
    // directory such as a macOS .app bundle that openPath would launch, is
    // revealed in its parent folder instead.
    if (targetStat.isDirectory() && rel === "") {
      return this.#openVerifiedDirectory(resolved.cleanRoot);
    }
    if (targetStat.isFile() || targetStat.isDirectory()) {
      return this.#revealInFolder(cleanTarget);
    }
    return { ok: false, code: "INVALID_PATH" };
  }

  async #resolveCanonicalModelsRoot(): Promise<
    | {
        readonly ok: true;
        readonly rootReal: string;
        readonly cleanRoot: string;
      }
    | { readonly ok: false; readonly result: LocalModelsStorageActionResult }
  > {
    const baseDir = this.#resolveBaseDir();
    if (!baseDir || !isAbsolutePlatformPath(baseDir, this.#platform)) {
      return { ok: false, result: { ok: false, code: "NOT_AVAILABLE" } };
    }
    const platformPath = this.#platform === "win32" ? path.win32 : path.posix;
    const modelsRoot = platformPath.join(baseDir, "models");
    let rootReal: string;
    try {
      rootReal = await this.#fs.realpath(modelsRoot);
    } catch (error) {
      if (isMissingPathError(error)) {
        return { ok: false, result: { ok: false, code: "NOT_FOUND" } };
      }
      return {
        ok: false,
        result: {
          ok: false,
          code: "OPEN_FAILED",
          message: errorMessage(error),
        },
      };
    }
    try {
      const rootStat = await this.#fs.stat(rootReal);
      if (!rootStat.isDirectory()) {
        return { ok: false, result: { ok: false, code: "NOT_FOUND" } };
      }
    } catch (error) {
      if (isMissingPathError(error)) {
        return { ok: false, result: { ok: false, code: "NOT_FOUND" } };
      }
      return {
        ok: false,
        result: {
          ok: false,
          code: "OPEN_FAILED",
          message: errorMessage(error),
        },
      };
    }
    return {
      ok: true,
      rootReal,
      cleanRoot: normalizePlatformPath(rootReal, this.#platform),
    };
  }

  #hasLinuxDisplay(): boolean {
    return Boolean(this.#env.DISPLAY || this.#env.WAYLAND_DISPLAY);
  }

  async #openVerifiedDirectory(
    cleanDirectory: string,
  ): Promise<LocalModelsStorageActionResult> {
    if (this.#platform === "linux") {
      if (!this.#hasLinuxDisplay()) {
        return {
          ok: false,
          code: "OPEN_FAILED",
          message: "No graphical desktop session is available.",
        };
      }
      if (this.#openWithXdg) {
        try {
          await this.#openWithXdg(cleanDirectory);
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            code: "OPEN_FAILED",
            message: errorMessage(error),
          };
        }
      }
    }
    try {
      const failure = await this.#openPath(cleanDirectory);
      if (failure) {
        return { ok: false, code: "OPEN_FAILED", message: failure };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, code: "OPEN_FAILED", message: errorMessage(error) };
    }
  }

  #revealInFolder(cleanTarget: string): LocalModelsStorageActionResult {
    if (this.#platform === "linux" && !this.#hasLinuxDisplay()) {
      return {
        ok: false,
        code: "OPEN_FAILED",
        message: "No graphical desktop session is available.",
      };
    }
    try {
      this.#showItemInFolder(cleanTarget);
      return { ok: true };
    } catch (error) {
      return { ok: false, code: "OPEN_FAILED", message: errorMessage(error) };
    }
  }
}
