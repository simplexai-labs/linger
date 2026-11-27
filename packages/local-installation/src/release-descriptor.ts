import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export type UpdateChannel = "stable" | "beta" | "canary";

export type BundleModuleId = "web" | "backend";

export const RELEASE_DESCRIPTOR_SCHEMA = 1;
export const DENYLIST_SCHEMA = 1;

export interface ReleaseCompat {
  readonly minShellVersion: string;
  readonly maxShellVersion?: string;
  readonly minNativeDepsHash: string;
  readonly runnerGatewayProtocol: number;
  readonly dbSchemaEpoch: number;
  readonly rollbackSafe: boolean;
}

export interface ReleaseInfraPaths {
  readonly node: string;
  readonly postgres: string;
  readonly voiceTools: string;
  readonly nodeDeps: string;
}

export type ReleaseModuleSource = "store" | "shell";

export interface ReleaseModuleEntry {
  readonly artifactId: string;
  readonly originAppVersion: string;
  readonly sha256: string;
  readonly path: string;
  readonly inputHash?: string;
  readonly source?: ReleaseModuleSource;
}

export interface LocalReleaseDescriptor {
  readonly schema: 1;
  readonly appVersion: string;
  readonly channel: UpdateChannel;
  readonly installedAt: string;
  readonly source: "shell-seed" | "incremental-update";
  readonly compat: ReleaseCompat;
  readonly infra: ReleaseInfraPaths;
  readonly modules: Readonly<Record<BundleModuleId, ReleaseModuleEntry>>;
}

export interface ReleasePointer {
  readonly appVersion: string;
  readonly releaseFile: string;
  readonly updatedAt: string;
  readonly confirmedAt?: string;
  readonly dbBackupFile?: string;
}

export interface DenylistEntry {
  readonly appVersion: string;
  readonly failedAt: string;
  readonly stage: "migrate" | "healthcheck" | "crash-watchdog";
  readonly reason: string;
}

export interface DenylistState {
  readonly schema: 1;
  readonly entries: readonly DenylistEntry[];
}

const CHANNELS = new Set<UpdateChannel>(["stable", "beta", "canary"]);
const MODULE_IDS: readonly BundleModuleId[] = ["web", "backend"];
const SHA256_RE = /^[0-9a-f]{64}$/;
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export function isSafeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !path.posix.isAbsolute(value) &&
    !/^[A-Za-z]:/.test(value) &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export function resolveSafeHomePath(
  home: string,
  relativePath: string,
): string {
  if (!isSafeRelativePath(relativePath)) {
    throw new Error(
      `Unsafe relative path in release descriptor: ${relativePath}`,
    );
  }
  const root = path.resolve(home);
  const resolved = path.resolve(root, ...relativePath.split("/"));
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Resolved path escapes home directory: ${relativePath}`);
  }
  return resolved;
}

export function parseLocalReleaseDescriptor(
  value: unknown,
): LocalReleaseDescriptor {
  const raw = value as Partial<LocalReleaseDescriptor> | null | undefined;
  if (
    !raw ||
    typeof raw !== "object" ||
    raw.schema !== RELEASE_DESCRIPTOR_SCHEMA ||
    typeof raw.appVersion !== "string" ||
    raw.appVersion.length === 0 ||
    !CHANNELS.has(raw.channel as UpdateChannel) ||
    typeof raw.installedAt !== "string" ||
    (raw.source !== "shell-seed" && raw.source !== "incremental-update") ||
    !raw.compat ||
    typeof raw.compat.minShellVersion !== "string" ||
    typeof raw.compat.minNativeDepsHash !== "string" ||
    !Number.isInteger(raw.compat.runnerGatewayProtocol) ||
    !Number.isInteger(raw.compat.dbSchemaEpoch) ||
    typeof raw.compat.rollbackSafe !== "boolean" ||
    !raw.infra ||
    !isSafeRelativePath(raw.infra.node ?? "") ||
    !isSafeRelativePath(raw.infra.postgres ?? "") ||
    !isSafeRelativePath(raw.infra.voiceTools ?? "") ||
    !isSafeRelativePath(raw.infra.nodeDeps ?? "") ||
    !raw.modules
  ) {
    throw new Error("Invalid V2 LocalReleaseDescriptor");
  }

  for (const mod of MODULE_IDS) {
    const entry = raw.modules[mod];
    if (
      !entry ||
      typeof entry.artifactId !== "string" ||
      entry.artifactId.length === 0 ||
      typeof entry.originAppVersion !== "string" ||
      !SHA256_RE.test(entry.sha256 ?? "") ||
      !isSafeRelativePath(entry.path ?? "") ||
      (entry.inputHash !== undefined &&
        (typeof entry.inputHash !== "string" ||
          entry.inputHash.length === 0)) ||
      (entry.source !== undefined &&
        entry.source !== "store" &&
        entry.source !== "shell")
    ) {
      throw new Error(
        `Invalid module entry '${mod}' in LocalReleaseDescriptor`,
      );
    }
  }

  return raw as LocalReleaseDescriptor;
}

export function parseReleasePointer(value: unknown): ReleasePointer {
  const raw = value as Partial<ReleasePointer> | null | undefined;
  if (
    !raw ||
    typeof raw !== "object" ||
    typeof raw.appVersion !== "string" ||
    raw.appVersion.length === 0 ||
    !isSafeRelativePath(raw.releaseFile ?? "") ||
    typeof raw.updatedAt !== "string" ||
    (raw.dbBackupFile !== undefined && !isSafeRelativePath(raw.dbBackupFile))
  ) {
    throw new Error("Invalid ReleasePointer");
  }
  return raw as ReleasePointer;
}

export function parseDenylistState(value: unknown): DenylistState {
  const raw = value as Partial<DenylistState> | null | undefined;
  if (
    !raw ||
    typeof raw !== "object" ||
    raw.schema !== DENYLIST_SCHEMA ||
    !Array.isArray(raw.entries)
  ) {
    throw new Error("Invalid DenylistState");
  }
  for (const entry of raw.entries) {
    if (
      !entry ||
      typeof entry.appVersion !== "string" ||
      typeof entry.failedAt !== "string" ||
      !["migrate", "healthcheck", "crash-watchdog"].includes(entry.stage) ||
      typeof entry.reason !== "string"
    ) {
      throw new Error("Invalid DenylistEntry");
    }
  }
  return raw as DenylistState;
}

/**
 * Writes JSON crash-safely via temporary file + fsync + cross-platform retrying rename.
 */
export async function writeJsonAtomic(
  targetPath: string,
  value: unknown,
  {
    mode = 0o600,
    maxAttempts = 8,
  }: { mode?: number; maxAttempts?: number } = {},
): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const tempPath = `${targetPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  let handle;
  try {
    handle = await open(tempPath, "w", mode);
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();

  let delayMs = 25;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rename(tempPath, targetPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt === maxAttempts || !RETRYABLE_RENAME_CODES.has(code)) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 400);
    }
  }
}

export async function readJsonIfExists<T>(
  filePath: string,
  parser: (value: unknown) => T,
): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parser(JSON.parse(raw));
}
