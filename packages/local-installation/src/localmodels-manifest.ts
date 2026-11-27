import { createPublicKey, verify } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { atomicPrivate, privateDirectory } from "./private-files.js";
import {
  validatePublishedServiceSource,
  type PublishedServiceSource,
} from "./published-source.js";

/**
 * Ed25519 SPKI public key matching llm-inference-lab's UPDATE_PUBLIC_KEY.
 * Verification fails closed if overridden with an empty or mismatched key.
 */
export const LOCALMODELS_UPDATE_PUBLIC_KEY = [
  "-----BEGIN PUBLIC KEY-----",
  "MCowBQYDK2VwAyEAF3D5zQZrI3Z+v4QTiYWS6pEne+x1EGjudhSLQjExpq0=",
  "-----END PUBLIC KEY-----",
  "",
].join("\n");

export const SUPPORTED_CLI_CONTRACTS = new Set(["v2"]);
export const SUPPORTED_ARCHIVE_LAYOUT = "npm-package-v1";

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const VERSION_RE = /^[0-9A-Za-z.+_-]{1,64}$/;
const HEX40_RE = /^[a-f0-9]{40}$/;
const HEX64_RE = /^[a-f0-9]{64}$/;
const MAX_SUMMARY_LENGTH = 240;

export interface LocalmodelsToolSource extends PublishedServiceSource {
  sourceCommit: string;
  manifestSha256: string;
  version?: string;
  npmVersion?: string;
}

export interface LocalmodelsUpdateCompatibility {
  readonly cliContract: string;
  readonly archiveLayout: string;
  readonly minLingerVersion?: string;
}

export interface LocalmodelsUpdateManifest {
  readonly schema: 1;
  readonly version: string;
  readonly npmVersion: string;
  readonly sourceCommit: string;
  readonly compatibility: LocalmodelsUpdateCompatibility;
  readonly summary?: string;
  readonly notesUrl?: string;
  readonly kits: Readonly<Record<string, LocalmodelsToolSource>>;
}

export interface VerifiedLocalmodelsManifest {
  readonly manifest: LocalmodelsUpdateManifest;
  readonly raw: string;
  readonly signature: string;
}

export interface ActiveLocalmodelsRecord {
  readonly schema: 1;
  readonly manifestRaw: string;
  readonly signature: string;
  readonly updatedAt: string;
}

export class LocalmodelsManifestError extends Error {}

export function validateToolSourceMetadata(
  value: unknown,
): LocalmodelsToolSource {
  const source = validatePublishedServiceSource(value);
  const extra = value as Partial<LocalmodelsToolSource>;
  if (
    !HEX40_RE.test(extra.sourceCommit ?? "") ||
    !HEX64_RE.test(extra.manifestSha256 ?? "")
  )
    throw new Error(
      "Upstream tool distribution metadata requires a pinned commit and manifest checksum.",
    );
  const version =
    typeof extra.version === "string" && VERSION_RE.test(extra.version)
      ? extra.version
      : undefined;
  if (extra.version !== undefined && !version)
    throw new Error("Upstream tool distribution version is invalid.");
  const npmVersion =
    typeof extra.npmVersion === "string" && SEMVER_RE.test(extra.npmVersion)
      ? extra.npmVersion
      : undefined;
  if (extra.npmVersion !== undefined && !npmVersion)
    throw new Error("Upstream tool distribution npmVersion is invalid.");
  return {
    ...source,
    sourceCommit: extra.sourceCommit!,
    manifestSha256: extra.manifestSha256!,
    ...(version ? { version } : {}),
    ...(npmVersion ? { npmVersion } : {}),
  };
}

/** Map supported PEP 440 localmodels versions (e.g. 0.1.0.dev47) to semver. */
export function toNpmSemver(version: string): string | undefined {
  const mapped = version
    .trim()
    .replace(/^(\d+\.\d+\.\d+)\.dev(\d+)$/, "$1-dev.$2")
    .replace(/^(\d+\.\d+\.\d+)(a|b|rc)(\d+)$/, "$1-$2.$3");
  return SEMVER_RE.test(mapped) ? mapped : undefined;
}

export function isPrereleaseSemver(version: string): boolean {
  return version.includes("-");
}

/** Positive when `a` is newer than `b` by semantic version precedence. */
export function compareSemver(a: string, b: string): number {
  const [coreA, preA] = splitVersion(a);
  const [coreB, preB] = splitVersion(b);
  const pa = coreA.split(".").map(Number);
  const pb = coreB.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (preA === undefined || preB === undefined)
    return preA === preB ? 0 : preA === undefined ? 1 : -1;
  const ia = preA.split(".");
  const ib = preB.split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function splitVersion(version: string): [string, string | undefined] {
  const dash = version.indexOf("-");
  return dash < 0
    ? [version, undefined]
    : [version.slice(0, dash), version.slice(dash + 1)];
}

/**
 * Infer version and semver from explicit metadata or legacy pinned URLs so
 * distributions written before `version` was added keep working.
 */
export function inferToolVersions(source: {
  url: string;
  mirrors?: string[];
  version?: string;
  npmVersion?: string;
}): { version?: string; npmVersion?: string } {
  let version = source.version;
  let npmVersion = source.npmVersion;
  if (!version) {
    const cdnMatch = /\/cli\/localmodels\/([^/]+)\/[^/]+\.tgz$/.exec(
      source.url,
    );
    if (cdnMatch?.[1] && VERSION_RE.test(cdnMatch[1])) version = cdnMatch[1];
  }
  if (!npmVersion) {
    for (const candidate of [source.url, ...(source.mirrors ?? [])]) {
      const npmMatch =
        /\/localmodels-[a-z0-9]+-[a-z0-9]+-([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)\.tgz$/.exec(
          candidate,
        );
      if (npmMatch?.[1] && SEMVER_RE.test(npmMatch[1])) {
        npmVersion = npmMatch[1];
        break;
      }
    }
  }
  if (!npmVersion && version) npmVersion = toNpmSemver(version);
  if (!version && npmVersion) version = npmVersion;
  return {
    ...(version ? { version } : {}),
    ...(npmVersion ? { npmVersion } : {}),
  };
}

function validateNotesUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new LocalmodelsManifestError("Update manifest notesUrl is invalid.");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new LocalmodelsManifestError("Update manifest notesUrl is invalid.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    !parsed.hostname
  )
    throw new LocalmodelsManifestError(
      "Update manifest notesUrl must be a credential-free HTTPS URL.",
    );
  return parsed.toString();
}

function parseManifestObject(raw: unknown): LocalmodelsUpdateManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new LocalmodelsManifestError("Update manifest is invalid.");
  const value = raw as Record<string, unknown>;
  if (value.schema !== 1)
    throw new LocalmodelsManifestError("Unsupported update manifest schema.");
  if (typeof value.version !== "string" || !VERSION_RE.test(value.version))
    throw new LocalmodelsManifestError("Update manifest version is invalid.");
  if (typeof value.npmVersion !== "string" || !SEMVER_RE.test(value.npmVersion))
    throw new LocalmodelsManifestError(
      "Update manifest npmVersion is invalid.",
    );
  if (
    typeof value.sourceCommit !== "string" ||
    !HEX40_RE.test(value.sourceCommit)
  )
    throw new LocalmodelsManifestError(
      "Update manifest sourceCommit is invalid.",
    );
  const compat = value.compatibility as Record<string, unknown> | undefined;
  if (
    !compat ||
    typeof compat !== "object" ||
    Array.isArray(compat) ||
    typeof compat.cliContract !== "string" ||
    !compat.cliContract ||
    typeof compat.archiveLayout !== "string" ||
    !compat.archiveLayout
  )
    throw new LocalmodelsManifestError(
      "Update manifest compatibility metadata is invalid.",
    );
  let minLingerVersion: string | undefined;
  if (compat.minLingerVersion !== undefined) {
    if (
      typeof compat.minLingerVersion !== "string" ||
      !SEMVER_RE.test(compat.minLingerVersion)
    )
      throw new LocalmodelsManifestError(
        "Update manifest minLingerVersion is invalid.",
      );
    minLingerVersion = compat.minLingerVersion;
  }
  let summary: string | undefined;
  if (value.summary !== undefined) {
    if (
      typeof value.summary !== "string" ||
      value.summary.length > MAX_SUMMARY_LENGTH
    )
      throw new LocalmodelsManifestError("Update manifest summary is invalid.");
    const trimmed = value.summary.trim();
    if (trimmed) summary = trimmed;
  }
  const notesUrl = validateNotesUrl(value.notesUrl);
  const rawKits = value.kits as Record<string, unknown> | undefined;
  if (
    !rawKits ||
    typeof rawKits !== "object" ||
    Array.isArray(rawKits) ||
    Object.keys(rawKits).length === 0
  )
    throw new LocalmodelsManifestError("Update manifest has no kits.");
  const kits: Record<string, LocalmodelsToolSource> = {};
  for (const [target, kitValue] of Object.entries(rawKits)) {
    if (!/^[a-z0-9]+-[a-z0-9]+$/.test(target))
      throw new LocalmodelsManifestError("Update manifest target is invalid.");
    let validated: LocalmodelsToolSource;
    try {
      validated = validateToolSourceMetadata(kitValue);
    } catch (error) {
      throw new LocalmodelsManifestError(
        error instanceof Error ? error.message : "Invalid update kit.",
        { cause: error },
      );
    }
    if (validated.sourceCommit !== value.sourceCommit)
      throw new LocalmodelsManifestError(
        "Update manifest kit commit does not match release commit.",
      );
    kits[target] = {
      ...validated,
      version: value.version,
      npmVersion: value.npmVersion,
    };
  }
  return {
    schema: 1,
    version: value.version,
    npmVersion: value.npmVersion,
    sourceCommit: value.sourceCommit,
    compatibility: {
      cliContract: compat.cliContract,
      archiveLayout: compat.archiveLayout,
      ...(minLingerVersion ? { minLingerVersion } : {}),
    },
    ...(summary ? { summary } : {}),
    ...(notesUrl ? { notesUrl } : {}),
    kits,
  };
}

/**
 * Verify an Ed25519 signature over the exact manifest bytes and validate its
 * structure. Fails closed whenever the public key is unset or mismatched.
 */
export function verifyLocalmodelsManifest(
  bytes: Buffer,
  signature: string,
  publicKey: string = LOCALMODELS_UPDATE_PUBLIC_KEY,
): LocalmodelsUpdateManifest {
  if (!publicKey.trim())
    throw new LocalmodelsManifestError(
      "Localmodels update public key is not configured.",
    );
  const trimmed = signature.trim();
  if (!trimmed || !/^[A-Za-z0-9+/]+=*$/.test(trimmed))
    throw new LocalmodelsManifestError("Update signature is malformed.");
  let valid: boolean;
  try {
    valid = verify(
      null,
      bytes,
      createPublicKey(publicKey),
      Buffer.from(trimmed, "base64"),
    );
  } catch (error) {
    throw new LocalmodelsManifestError(
      "Update signature verification failed.",
      {
        cause: error,
      },
    );
  }
  if (!valid)
    throw new LocalmodelsManifestError("Update signature does not match.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new LocalmodelsManifestError("Update manifest is not valid JSON.", {
      cause: error,
    });
  }
  return parseManifestObject(parsed);
}

export type LocalmodelsUpdateEvaluation =
  | { readonly kind: "up_to_date" }
  | { readonly kind: "unsupported_target" }
  | {
      readonly kind: "incompatible";
      readonly reason: "cli_contract" | "archive_layout";
    }
  | {
      readonly kind: "requires_app_update";
      readonly version: string;
      readonly npmVersion: string;
      readonly minLingerVersion: string;
    }
  | {
      readonly kind: "compatible";
      readonly version: string;
      readonly npmVersion: string;
      readonly kit: LocalmodelsToolSource;
    };

export interface EvaluateManifestOptions {
  readonly manifest: LocalmodelsUpdateManifest;
  readonly target: string;
  readonly currentNpmVersion?: string;
  readonly baselineNpmVersion?: string;
  readonly desktopVersion?: string;
}

/**
 * Apply channel policy (stable baselines never accept prereleases), monotonic
 * version precedence, and compatibility gates before offering a manifest.
 */
export function evaluateLocalmodelsManifest({
  manifest,
  target,
  currentNpmVersion,
  baselineNpmVersion,
  desktopVersion,
}: EvaluateManifestOptions): LocalmodelsUpdateEvaluation {
  if (
    baselineNpmVersion &&
    !isPrereleaseSemver(baselineNpmVersion) &&
    isPrereleaseSemver(manifest.npmVersion)
  )
    return { kind: "up_to_date" };
  if (
    currentNpmVersion &&
    compareSemver(manifest.npmVersion, currentNpmVersion) <= 0
  )
    return { kind: "up_to_date" };
  if (manifest.compatibility.archiveLayout !== SUPPORTED_ARCHIVE_LAYOUT)
    return { kind: "incompatible", reason: "archive_layout" };
  if (!SUPPORTED_CLI_CONTRACTS.has(manifest.compatibility.cliContract))
    return { kind: "incompatible", reason: "cli_contract" };
  const minLinger = manifest.compatibility.minLingerVersion;
  if (
    minLinger &&
    desktopVersion &&
    SEMVER_RE.test(desktopVersion) &&
    compareSemver(desktopVersion, minLinger) < 0
  )
    return {
      kind: "requires_app_update",
      version: manifest.version,
      npmVersion: manifest.npmVersion,
      minLingerVersion: minLinger,
    };
  const kit = manifest.kits[target];
  if (!kit) return { kind: "unsupported_target" };
  return {
    kind: "compatible",
    version: manifest.version,
    npmVersion: manifest.npmVersion,
    kit,
  };
}

/** Where a home stores its verified active localmodels override pointer. */
export function activeToolRecordPath(home: string): string {
  return path.join(path.resolve(home), "tools", "localmodels", "active.json");
}

export interface VerifiedActiveTool {
  readonly source: LocalmodelsToolSource;
  readonly manifest: LocalmodelsUpdateManifest;
  readonly updatedAt: string;
}

export interface ReadActiveToolOptions {
  readonly target?: string;
  readonly desktopVersion?: string;
  readonly publicKey?: string;
  readonly cleanupStale?: boolean;
  readonly requireInstalled?: boolean;
}

/**
 * Load and re-verify the active localmodels override for `home`. Returns
 * undefined (falling back to the bundled baseline) whenever the record is
 * absent, tampered, incompatible, superseded by a newer baseline, or missing
 * its sealed kit directory.
 */
export async function readVerifiedActiveTool(
  home: string,
  baseline: LocalmodelsToolSource | undefined,
  options: ReadActiveToolOptions = {},
): Promise<VerifiedActiveTool | undefined> {
  const file = activeToolRecordPath(home);
  let record: Partial<ActiveLocalmodelsRecord>;
  try {
    record = JSON.parse(
      await readFile(file, "utf8"),
    ) as Partial<ActiveLocalmodelsRecord>;
  } catch {
    return undefined;
  }
  if (
    record.schema !== 1 ||
    typeof record.manifestRaw !== "string" ||
    typeof record.signature !== "string" ||
    typeof record.updatedAt !== "string"
  )
    return undefined;
  let manifest: LocalmodelsUpdateManifest;
  try {
    manifest = verifyLocalmodelsManifest(
      Buffer.from(record.manifestRaw, "utf8"),
      record.signature,
      options.publicKey ?? LOCALMODELS_UPDATE_PUBLIC_KEY,
    );
  } catch {
    return undefined;
  }
  const target = options.target ?? `${process.platform}-${process.arch}`;
  const baselineVersions = baseline ? inferToolVersions(baseline) : undefined;
  const baselineNpm = baselineVersions?.npmVersion;
  if (
    baselineNpm &&
    ((!isPrereleaseSemver(baselineNpm) &&
      isPrereleaseSemver(manifest.npmVersion)) ||
      compareSemver(manifest.npmVersion, baselineNpm) <= 0)
  ) {
    if (options.cleanupStale !== false)
      await rm(file, { force: true }).catch(() => undefined);
    return undefined;
  }
  const evaluated = evaluateLocalmodelsManifest({
    manifest,
    target,
    ...(baselineNpm ? { baselineNpmVersion: baselineNpm } : {}),
    ...(options.desktopVersion
      ? { desktopVersion: options.desktopVersion }
      : {}),
  });
  if (evaluated.kind !== "compatible") return undefined;
  if (options.requireInstalled !== false) {
    const toolManifest = path.join(
      path.resolve(home),
      "tools",
      "localmodels",
      evaluated.kit.sha256,
      "tool.json",
    );
    try {
      const info = await lstat(toolManifest);
      if (!info.isFile() || info.isSymbolicLink()) return undefined;
    } catch {
      return undefined;
    }
  }
  return {
    source: evaluated.kit,
    manifest,
    updatedAt: record.updatedAt,
  };
}

/** Atomically persist the signed manifest as the home's active override. */
export async function writeActiveToolRecord(
  home: string,
  verified: VerifiedLocalmodelsManifest,
  updatedAt: string = new Date().toISOString(),
): Promise<void> {
  const file = activeToolRecordPath(home);
  await privateDirectory(path.dirname(file));
  const record: ActiveLocalmodelsRecord = {
    schema: 1,
    manifestRaw: verified.raw,
    signature: verified.signature,
    updatedAt,
  };
  await atomicPrivate(file, `${JSON.stringify(record, null, 2)}\n`);
}

/** Remove the active localmodels override so callers fall back to baseline. */
export async function clearActiveToolRecord(home: string): Promise<void> {
  await rm(activeToolRecordPath(home), { force: true });
}
