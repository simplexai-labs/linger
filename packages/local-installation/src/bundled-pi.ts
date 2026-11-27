import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateDirectory } from "./private-files.js";

export interface BundledPi {
  readonly binDir: string;
  readonly executable: string;
  readonly version: string;
}

export interface ResolveBundledPiOptions {
  readonly scriptPath?: string;
  readonly platform?: NodeJS.Platform;
}

export interface WithBundledPiPathOptions {
  readonly home: string;
  readonly bundledPi: BundledPi;
  readonly platform?: NodeJS.Platform;
  readonly homedir?: string;
}

interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

const SEMVER_PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;
const EMBEDDED_SEMVER_PATTERN =
  /(?<![0-9.])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?![0-9.])/u;
const DIGITS_PATTERN = /^\d+$/u;

function parseSemver(raw: string): ParsedSemver | undefined {
  const match = SEMVER_PATTERN.exec(raw.trim());
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return undefined;
  }
  let prerelease: string[] = [];
  if (match[4] !== undefined) {
    prerelease = match[4].split(".");
    if (prerelease.some((part) => part.length === 0)) return undefined;
  }
  return { major, minor, patch, prerelease };
}

/**
 * Compares two semantic version strings numerically. Returns -1, 0, or 1,
 * and returns 0 when either string cannot be parsed so unparseable entries
 * never outrank a known bundled version.
 */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return 0;
  for (const [x, y] of [
    [left.major, right.major],
    [left.minor, right.minor],
    [left.patch, right.patch],
  ] as const) {
    if (x !== y) return x < y ? -1 : 1;
  }
  const leftHasPre = left.prerelease.length > 0;
  const rightHasPre = right.prerelease.length > 0;
  if (!leftHasPre && !rightHasPre) return 0;
  if (!leftHasPre) return 1;
  if (!rightHasPre) return -1;
  const count = Math.min(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < count; i++) {
    const partA = left.prerelease[i]!;
    const partB = right.prerelease[i]!;
    if (partA === partB) continue;
    const numA = DIGITS_PATTERN.test(partA);
    const numB = DIGITS_PATTERN.test(partB);
    if (numA && numB) {
      const diff = Number(partA) - Number(partB);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    if (numA !== numB) return numA ? -1 : 1;
    return partA < partB ? -1 : 1;
  }
  if (left.prerelease.length !== right.prerelease.length) {
    return left.prerelease.length < right.prerelease.length ? -1 : 1;
  }
  return 0;
}

/**
 * Extracts the first semantic version token from CLI `--version` output
 * (for example `"codex-cli 0.168.0"` -> `"0.168.0"`).
 */
export function extractSemver(raw: string): string | undefined {
  const match = EMBEDDED_SEMVER_PATTERN.exec(raw);
  if (!match?.[1]) return undefined;
  return parseSemver(match[1]) ? match[1] : undefined;
}

/**
 * Reports whether `observed` contains a valid semantic version greater than
 * or equal to a valid `baseline` semantic version. Returns false when either
 * input cannot be parsed.
 */
export function semverAtLeast(
  observed: string | undefined,
  baseline: string,
): boolean {
  if (!observed) return false;
  const extracted = extractSemver(observed);
  if (!extracted || !parseSemver(baseline)) return false;
  return compareSemver(extracted, baseline) >= 0;
}

async function candidateToolsRoots(scriptPath?: string): Promise<string[]> {
  const scriptDirs: string[] = [];
  const addDir = async (file: string) => {
    const resolvedDir = path.dirname(path.resolve(file));
    if (!scriptDirs.includes(resolvedDir)) scriptDirs.push(resolvedDir);
    const realFile = await realpath(file).catch(() => undefined);
    if (realFile) {
      const realDir = path.dirname(realFile);
      if (!scriptDirs.includes(realDir)) scriptDirs.push(realDir);
    }
  };
  if (scriptPath) {
    await addDir(scriptPath);
  } else {
    await addDir(fileURLToPath(import.meta.url));
    const entry = process.argv[1];
    if (entry && path.basename(entry) === "installer.js") {
      await addDir(entry);
    }
  }
  const roots: string[] = [];
  for (const dir of scriptDirs) {
    for (const candidate of [
      path.resolve(dir, "../../../cli/computer-tools"),
      path.resolve(dir, "../computer/cli/computer-tools"),
      path.resolve(dir, "computer-tools"),
      path.resolve(dir, "../cli/computer-tools"),
      path.resolve(dir, "../computer-tools"),
    ]) {
      if (!roots.includes(candidate)) roots.push(candidate);
    }
  }
  return roots;
}

async function isRegularNonSymlinkFile(file: string): Promise<boolean> {
  try {
    const info = await lstat(file);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function isExistingFile(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    return info.isFile();
  } catch {
    return false;
  }
}

async function isExistingDirectory(directory: string): Promise<boolean> {
  try {
    const info = await stat(directory);
    return info.isDirectory();
  } catch {
    return false;
  }
}

interface ComputerToolsManifest {
  readonly schema_version?: unknown;
  readonly versions?: { readonly pi?: unknown };
  readonly pi_entry?: unknown;
}

async function validateBundledPiRoot(
  root: string,
  platform: NodeJS.Platform,
): Promise<BundledPi | undefined> {
  const realRoot = await realpath(root).catch(() => undefined);
  if (!realRoot) return undefined;
  let manifest: ComputerToolsManifest;
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(realRoot, "manifest.json"), "utf8"),
    );
    if (!parsed || typeof parsed !== "object") return undefined;
    manifest = parsed;
  } catch {
    return undefined;
  }
  const expectedEntry = platform === "win32" ? "bin/pi.exe" : "bin/pi";
  const version = manifest.versions?.pi;
  if (
    manifest.schema_version !== 1 ||
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+/u.test(version) ||
    manifest.pi_entry !== expectedEntry
  ) {
    return undefined;
  }
  const executable = path.join(realRoot, ...expectedEntry.split("/"));
  if (!(await isRegularNonSymlinkFile(executable))) return undefined;
  if (platform !== "win32") {
    try {
      await access(executable, fsConstants.X_OK);
    } catch {
      return undefined;
    }
  }
  const cliEntry = path.join(
    realRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "bundle",
    "cli.js",
  );
  if (!(await isRegularNonSymlinkFile(cliEntry))) return undefined;
  const nodeName = platform === "win32" ? "node.exe" : "node";
  const nodeCandidates = [
    path.resolve(root, "../../runtime/bin", nodeName),
    path.resolve(realRoot, "../../runtime/bin", nodeName),
    path.resolve(realRoot, "../runtime/bin", nodeName),
  ];
  let hasNode = false;
  for (const candidate of nodeCandidates) {
    if (await isExistingFile(candidate)) {
      hasNode = true;
      break;
    }
  }
  if (!hasNode) return undefined;
  return {
    binDir: path.dirname(executable),
    executable,
    version,
  };
}

/**
 * Resolves the bundled Pi launcher shipped alongside the Desktop installer
 * or standalone Local Computer bundle, or undefined when absent or incomplete.
 */
export async function resolveBundledPi(
  options: ResolveBundledPiOptions = {},
): Promise<BundledPi | undefined> {
  const platform = options.platform ?? process.platform;
  for (const root of await candidateToolsRoots(options.scriptPath)) {
    const resolved = await validateBundledPiRoot(root, platform);
    if (resolved) return resolved;
  }
  return undefined;
}

export interface EnsureStableBundledPiOptions {
  readonly platform?: NodeJS.Platform;
}

/**
 * Maintains a relocation-proof POSIX symlink at `<home>/runtime/bundled-pi/bin/pi`
 * pointing to the current bundled Pi launcher so persisted plans and bindings
 * survive app moves and upgrades. Returns `bundledPi` unchanged on Windows or
 * if the symlink cannot be created.
 */
export async function ensureStableBundledPi(
  home: string,
  bundledPi: BundledPi,
  options: EnsureStableBundledPiOptions = {},
): Promise<BundledPi> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" || !home.trim()) return bundledPi;
  const target = path.resolve(bundledPi.executable);
  const bundledRoot = path.join(path.resolve(home), "runtime", "bundled-pi");
  const binDir = path.join(bundledRoot, "bin");
  const linkPath = path.join(binDir, "pi");
  if (target === linkPath) return bundledPi;
  try {
    try {
      const currentTarget = await readlink(linkPath);
      if (currentTarget === target) {
        return {
          binDir,
          executable: linkPath,
          version: bundledPi.version,
        };
      }
    } catch {
      // Missing, not a symlink, or unreadable; recreate atomically below.
    }
    await privateDirectory(bundledRoot);
    await privateDirectory(binDir);
    const tempLink = path.join(binDir, `.pi.${randomUUID()}.tmp`);
    try {
      await symlink(target, tempLink);
      await rename(tempLink, linkPath);
    } finally {
      await rm(tempLink, { force: true }).catch(() => undefined);
    }
    return {
      binDir,
      executable: linkPath,
      version: bundledPi.version,
    };
  } catch {
    return bundledPi;
  }
}

function lookupEnvValue(
  env: NodeJS.ProcessEnv,
  name: string,
  caseInsensitive: boolean,
): string | undefined {
  if (env[name] !== undefined) return env[name];
  if (!caseInsensitive) return undefined;
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper) return value;
  }
  return undefined;
}

function pathKeyForComparison(entry: string, isWin: boolean): string {
  const trimmed = entry.trim();
  const normalized = isWin
    ? path.win32
        .normalize(trimmed)
        .replace(/\\+$/u, (match, offset) => (offset <= 2 ? match : ""))
    : path.posix
        .normalize(trimmed)
        .replace(/\/+$/u, (match, offset) => (offset === 0 ? match : ""));
  return isWin ? normalized.toLowerCase() : normalized;
}

async function newerHarnessPiDirs(
  home: string,
  bundledVersion: string,
  platform: NodeJS.Platform,
): Promise<string[]> {
  const piToolsRoot = path.join(
    path.resolve(home),
    "runtime",
    "harness",
    "tools",
    "pi",
  );
  let entries;
  try {
    entries = await readdir(piToolsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const binaryName = platform === "win32" ? "pi.exe" : "pi";
  const matched: Array<{ readonly version: string; readonly dir: string }> = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (compareSemver(entry.name, bundledVersion) <= 0) continue;
    const versionDir = path.join(piToolsRoot, entry.name);
    if (!(await isExistingDirectory(versionDir))) continue;
    const binary = path.join(versionDir, binaryName);
    try {
      const info = await stat(binary);
      if (!info.isFile()) continue;
      if (
        platform !== "win32" &&
        process.platform !== "win32" &&
        (info.mode & 0o111) === 0
      ) {
        continue;
      }
    } catch {
      continue;
    }
    matched.push({ version: entry.name, dir: versionDir });
  }
  matched.sort((left, right) => compareSemver(right.version, left.version));
  return matched.map((item) => item.dir);
}

const WINDOWS_PI_EXECUTABLES = [
  "pi.exe",
  "pi.cmd",
  "pi.bat",
  "pi.com",
] as const;

async function collectUserSearchDirs(
  env: NodeJS.ProcessEnv,
  options: Pick<WithBundledPiPathOptions, "homedir">,
  platform: NodeJS.Platform,
): Promise<{
  pathKey: string;
  nextEnv: NodeJS.ProcessEnv;
  directories: string[];
}> {
  const isWin = platform === "win32";
  const delimiter = isWin ? ";" : ":";

  const nextEnv: NodeJS.ProcessEnv = {};
  let pathKey = "PATH";
  let foundPathKey = false;
  const existingEntries: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    const isPathKey = isWin ? key.toUpperCase() === "PATH" : key === "PATH";
    if (isPathKey) {
      if (!foundPathKey) {
        pathKey = key;
        foundPathKey = true;
      }
      if (value) {
        for (const segment of value.split(delimiter)) {
          if (segment.trim()) existingEntries.push(segment);
        }
      }
      continue;
    }
    nextEnv[key] = value;
  }

  const directories = [...existingEntries];
  const userHome =
    lookupEnvValue(env, "HOME", isWin) ||
    lookupEnvValue(env, "USERPROFILE", isWin) ||
    options.homedir ||
    os.homedir();
  if (userHome) {
    const localBin = path.join(userHome, ".local", "bin");
    if (await isExistingDirectory(localBin)) {
      directories.push(localBin);
    }
  }
  if (isWin) {
    const appData = lookupEnvValue(env, "APPDATA", true);
    if (appData) {
      const npmBin = path.join(appData, "npm");
      if (await isExistingDirectory(npmBin)) {
        directories.push(npmBin);
      }
    }
  }
  return { pathKey, nextEnv, directories };
}

async function findPiInDirectory(
  directory: string,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  const names =
    platform === "win32" ? WINDOWS_PI_EXECUTABLES : (["pi"] as const);
  for (const name of names) {
    const candidate = path.join(directory, name);
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      if (platform !== "win32" && process.platform !== "win32") {
        await access(candidate, fsConstants.X_OK);
      }
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Returns the first Pi executable or explicit override that outranks the
 * bundled Pi under the shared precedence rules, or undefined when bundled Pi
 * unambiguously wins.
 */
export async function findHigherPrecedencePi(
  env: NodeJS.ProcessEnv,
  options: WithBundledPiPathOptions,
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const isWin = platform === "win32";

  const simplexPiPath = lookupEnvValue(env, "SIMPLEX_PI_PATH", isWin)?.trim();
  if (simplexPiPath) return simplexPiPath;

  const ignoredDirs = new Set<string>([
    pathKeyForComparison(options.bundledPi.binDir, isWin),
  ]);
  if (options.home.trim()) {
    ignoredDirs.add(
      pathKeyForComparison(
        path.join(path.resolve(options.home), "runtime", "bundled-pi", "bin"),
        isWin,
      ),
    );
  }

  const lingerPiPath = lookupEnvValue(env, "LINGER_PI_PATH", isWin)?.trim();
  if (lingerPiPath) {
    const parentDir = isWin
      ? path.win32.dirname(lingerPiPath)
      : path.posix.dirname(lingerPiPath);
    if (!ignoredDirs.has(pathKeyForComparison(parentDir, isWin))) {
      return lingerPiPath;
    }
  }

  const { directories } = await collectUserSearchDirs(env, options, platform);
  const seen = new Set<string>();
  for (const entry of directories) {
    if (!entry.trim()) continue;
    const key = pathKeyForComparison(entry, isWin);
    if (seen.has(key) || ignoredDirs.has(key)) continue;
    seen.add(key);
    const found = await findPiInDirectory(entry, platform);
    if (found) return found;
  }

  const newerDirs = await newerHarnessPiDirs(
    options.home,
    options.bundledPi.version,
    platform,
  );
  if (newerDirs.length > 0) {
    return path.join(newerDirs[0]!, isWin ? "pi.exe" : "pi");
  }
  return undefined;
}

/**
 * Appends fallback Pi lookup directories to PATH so user PATH, ~/.local/bin,
 * Windows %APPDATA%\npm, and strictly newer harness-managed Pi installs take
 * precedence over the bundled Pi, while bundled Pi supersedes older or equal
 * harness copies without touching SIMPLEX_PI_PATH.
 */
export async function withBundledPiPath(
  env: NodeJS.ProcessEnv,
  options: WithBundledPiPathOptions,
): Promise<NodeJS.ProcessEnv> {
  const platform = options.platform ?? process.platform;
  const isWin = platform === "win32";
  const delimiter = isWin ? ";" : ":";

  const { pathKey, nextEnv, directories } = await collectUserSearchDirs(
    env,
    options,
    platform,
  );
  const candidates = [
    ...directories,
    ...(await newerHarnessPiDirs(
      options.home,
      options.bundledPi.version,
      platform,
    )),
    options.bundledPi.binDir,
  ];

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const entry of candidates) {
    if (!entry.trim()) continue;
    const key = pathKeyForComparison(entry, isWin);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  nextEnv[pathKey] = deduped.join(delimiter);
  return nextEnv;
}
